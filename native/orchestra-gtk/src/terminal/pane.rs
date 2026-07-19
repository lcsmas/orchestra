//! One feed-mode VTE terminal pane bound to a single PTY id (plan §5.2).
//!
//! The pane renders backend `ptyData` via `feed()`, turns keystrokes into
//! [`PaneIntent::Write`], and reports grid resizes as [`PaneIntent::Resize`]
//! (dropping no-op resizes). It NEVER spawns a child — the backend owns the
//! PTY. Intents flow out through a caller-supplied sink so the App (sole owner
//! of the backend) performs the actual RPC.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use vte4::prelude::*;

use super::boot_pill::{self, BootPill, PillKind, Trigger};
use super::{term_bg, term_fg, term_palette, terminal_font};

/// What a pane asks the App (backend owner) to do. Keeps the backend
/// single-owned: the pane never holds a backend handle.
#[derive(Debug, Clone)]
pub enum PaneIntent {
    /// First visible fit — spawn/attach the PTY at this grid size.
    Start { id: String, cols: u16, rows: u16 },
    /// Keystroke/paste bytes to forward as `ptyWrite`.
    Write { id: String, bytes: Vec<u8> },
    /// Grid changed — `ptyResize` (already de-duped against the last size).
    Resize { id: String, cols: u16, rows: u16 },
    /// Tab shown again — `ptyRepaint` to heal any child diff-model desync.
    Repaint { id: String, cols: u16, rows: u16 },
    /// A clipboard image (PNG bytes) to spill to a temp file via
    /// `saveClipboardImage`, then bracketed-paste the returned path.
    PasteImage {
        id: String,
        mime: String,
        bytes: Vec<u8>,
    },
    /// A URL was activated in the terminal — open it.
    OpenUri { uri: String },
}

/// Lifecycle of the underlying PTY as the pane understands it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Life {
    /// Not yet `ptyStart`ed (waiting for the first visible fit).
    Unstarted,
    /// PTY is live and feeding.
    Running,
    /// PTY exited/stopped — the next keystroke relaunches it (not forwarded).
    Dead,
}

pub struct TerminalPane {
    id: String,
    /// Root widget mounted into the GtkStack: overlay = [VTE | boot pill].
    root: gtk::Overlay,
    term: vte4::Terminal,
    pill: gtk::Label,
    boot: Rc<RefCell<BootPill>>,
    life: Rc<Cell<Life>>,
    /// Last (cols, rows) reported to the backend — resize no-op guard.
    last_size: Rc<Cell<(u16, u16)>>,
    /// True once the pane has had a non-zero allocation (so lazy start fires
    /// exactly once, on the first real fit).
    started: Rc<Cell<bool>>,
    sink: Rc<dyn Fn(PaneIntent)>,
}

impl TerminalPane {
    /// Build a pane for `id`. `sink` receives every [`PaneIntent`].
    pub fn new(id: &str, sink: Rc<dyn Fn(PaneIntent)>) -> Self {
        let term = vte4::Terminal::new();
        term.set_font(Some(&terminal_font()));
        let palette = term_palette();
        let palette_refs: Vec<&gtk::gdk::RGBA> = palette.iter().collect();
        term.set_colors(Some(&term_fg()), Some(&term_bg()), &palette_refs);
        term.set_scrollback_lines(10_000);
        term.set_scroll_on_output(false);
        term.set_scroll_on_keystroke(true);
        term.set_hexpand(true);
        term.set_vexpand(true);
        term.set_widget_name(&format!("term-{id}"));

        // A styled overlay scrollbar approximates the renderer's floating look
        // without pixel-cloning it (plan §5.2).
        let scrolled = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .child(&term)
            .build();
        scrolled.add_css_class("term-scroll");

        let pill = gtk::Label::new(Some(PillKind::Starting.label()));
        pill.add_css_class("boot-pill");
        pill.set_halign(gtk::Align::Center);
        pill.set_valign(gtk::Align::Center);
        pill.set_visible(false);
        pill.set_widget_name(&format!("boot-pill-{id}"));

        let root = gtk::Overlay::new();
        root.set_child(Some(&scrolled));
        root.add_overlay(&pill);
        root.set_widget_name(&format!("term-pane-{id}"));

        let pane = TerminalPane {
            id: id.to_string(),
            root,
            term,
            pill,
            boot: Rc::new(RefCell::new(BootPill::new())),
            life: Rc::new(Cell::new(Life::Unstarted)),
            last_size: Rc::new(Cell::new((0, 0))),
            started: Rc::new(Cell::new(false)),
            sink,
        };
        pane.wire();
        pane
    }

    /// The widget to mount in the GtkStack.
    pub fn widget(&self) -> &gtk::Widget {
        self.root.upcast_ref()
    }

    #[allow(dead_code)] // used by the run-terminal / nvim routing (next task)
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Feed backend `ptyData` bytes into the emulator. A dead PTY that starts
    /// producing output again (relaunch) flips back to Running.
    pub fn feed(&self, bytes: &[u8]) {
        if self.life.get() == Life::Dead {
            self.life.set(Life::Running);
        }
        self.term.feed(bytes);
        if self.boot.borrow_mut().apply(Trigger::Output(bytes.len())) {
            self.start_fade();
        }
    }

    /// Replay scrollback (base64-decoded backend bytes) before live feed.
    pub fn feed_scrollback(&self, bytes: &[u8]) {
        if !bytes.is_empty() {
            self.term.feed(bytes);
        }
    }

    /// Show the boot pill for a (re)start.
    pub fn show_pill(&self, resuming: bool) {
        let kind = if resuming {
            PillKind::Resuming
        } else {
            PillKind::Starting
        };
        self.boot.borrow_mut().show(kind);
        self.pill.set_text(kind.label());
        self.pill.set_opacity(1.0);
        self.pill.set_visible(true);
        // 250 ms fade-IN on appear.
        self.pill.remove_css_class("faded");
        // Fallback 20 s dismiss.
        let boot = self.boot.clone();
        let pill = self.pill.clone();
        let life = self.life.clone();
        glib::timeout_add_local_once(
            std::time::Duration::from_millis(boot_pill::CLEAR_TIMEOUT_MS),
            move || {
                if boot.borrow_mut().apply(Trigger::Timeout) {
                    Self::fade_out(&pill, &boot, &life);
                }
            },
        );
    }

    /// The PTY exited or was stopped: show the relaunch notice; next keystroke
    /// on a Dead pane triggers `ptyStart` instead of being forwarded.
    pub fn on_exit(&self, stopped: bool) {
        self.life.set(Life::Dead);
        let notice = if stopped {
            "\r\n\x1b[38;5;244m[agent stopped — press any key to relaunch]\x1b[0m\r\n"
        } else {
            "\r\n\x1b[38;5;244m[agent exited — press any key to relaunch]\x1b[0m\r\n"
        };
        self.term.feed(notice.as_bytes());
        if self.boot.borrow_mut().apply(Trigger::Exit) {
            self.start_fade();
        }
    }

    /// A `pty:restart` (branch switch): clear the screen and re-arm the pill;
    /// the backend re-emits ptyData for the new session.
    pub fn on_restart(&self) {
        self.term.reset(true, true);
        self.life.set(Life::Running);
        self.show_pill(false);
    }

    /// Tab shown again — repaint bounce so the child re-converges its diff model
    /// (VTE itself keeps its grid; the desync is child-side).
    pub fn on_shown(&self) {
        if self.life.get() != Life::Running {
            return;
        }
        let (cols, rows) = self.last_size.get();
        if cols > 0 && rows > 0 {
            (self.sink)(PaneIntent::Repaint {
                id: self.id.clone(),
                cols,
                rows,
            });
        }
    }

    fn wire(&self) {
        // Keystrokes → ptyWrite. A Dead pane relaunches instead of forwarding.
        {
            let id = self.id.clone();
            let sink = self.sink.clone();
            let boot = self.boot.clone();
            let pill = self.pill.clone();
            let life = self.life.clone();
            let last_size = self.last_size.clone();
            self.term.connect_commit(move |_term, text, size| {
                // VTE emits commit for both UTF-8 text (size = byte length) and
                // single-byte control input; forward the raw bytes either way.
                if life.get() == Life::Dead {
                    // Relaunch on any key; swallow this keystroke.
                    life.set(Life::Running);
                    let (cols, rows) = last_size.get();
                    (sink)(PaneIntent::Start {
                        id: id.clone(),
                        cols: cols.max(1),
                        rows: rows.max(1),
                    });
                    return;
                }
                let bytes = text.as_bytes()[..size as usize].to_vec();
                (sink)(PaneIntent::Write {
                    id: id.clone(),
                    bytes,
                });
                if boot.borrow_mut().apply(Trigger::Keystroke) {
                    Self::fade_out(&pill, &boot, &life);
                }
            });
        }

        // Grid resize → ptyResize (drop no-ops) + lazy first-fit ptyStart.
        //
        // GtkWidget has no generic "was resized" signal and VTE isn't a
        // DrawingArea, so we sample the grid on the frame clock while mapped
        // (cheap — the closure returns immediately unless (cols,rows) actually
        // changed, which is rare). `char_width/height` are the cell metrics;
        // VTE has already re-flowed `column_count/row_count` to the allocation.
        {
            let id = self.id.clone();
            let sink = self.sink.clone();
            let last_size = self.last_size.clone();
            let started = self.started.clone();
            let life = self.life.clone();
            self.term.add_tick_callback(move |term, _clock| {
                let cols = term.column_count().clamp(1, u16::MAX as i64) as u16;
                let rows = term.row_count().clamp(1, u16::MAX as i64) as u16;
                // Ignore the pre-map default grid (no real allocation yet):
                // column/row-count are only meaningful once mapped.
                if !term.is_mapped() || (cols, rows) == last_size.get() {
                    return glib::ControlFlow::Continue;
                }
                last_size.set((cols, rows));
                if !started.replace(true) {
                    life.set(Life::Running);
                    (sink)(PaneIntent::Start {
                        id: id.clone(),
                        cols,
                        rows,
                    });
                } else {
                    (sink)(PaneIntent::Resize {
                        id: id.clone(),
                        cols,
                        rows,
                    });
                }
                glib::ControlFlow::Continue
            });
        }

        self.wire_keyboard();
        self.wire_links();
    }

    /// Keyboard parity with the renderer's `Terminal.tsx`:
    /// - Ctrl+C copies the selection (VTE clipboard) and is NEVER forwarded —
    ///   the agent must not receive SIGINT.
    /// - Ctrl+V pastes: a clipboard image wins (spilled to a temp file, its path
    ///   bracketed-pasted), else the clipboard text.
    /// - Shift+Enter sends ESC+CR (what `/terminal-setup` configures) so the
    ///   TUI can distinguish it from a plain submit.
    ///
    /// The controller sits in the CAPTURE phase so it intercepts before VTE's
    /// own key handling.
    fn wire_keyboard(&self) {
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let id = self.id.clone();
        let sink = self.sink.clone();
        let term = self.term.clone();
        let boot = self.boot.clone();
        let pill = self.pill.clone();
        let life = self.life.clone();
        keys.connect_key_pressed(move |_ctrl, key, _code, modifiers| {
            let ctrl = modifiers.contains(gtk::gdk::ModifierType::CONTROL_MASK);
            let shift = modifiers.contains(gtk::gdk::ModifierType::SHIFT_MASK);
            let alt = modifiers.contains(gtk::gdk::ModifierType::ALT_MASK);

            // Shift+Enter → ESC+CR (no other modifiers).
            if key == gtk::gdk::Key::Return && shift && !ctrl && !alt {
                (sink)(PaneIntent::Write {
                    id: id.clone(),
                    bytes: b"\x1b\r".to_vec(),
                });
                return glib::Propagation::Stop;
            }
            if !ctrl {
                return glib::Propagation::Proceed;
            }
            match key {
                gtk::gdk::Key::c | gtk::gdk::Key::C => {
                    // Copy-or-nothing; never forward ^C.
                    if term.has_selection() {
                        term.copy_clipboard_format(vte4::Format::Text);
                    }
                    // Dismissing the pill on a keystroke still applies.
                    if boot.borrow_mut().apply(Trigger::Keystroke) {
                        Self::fade_out(&pill, &boot, &life);
                    }
                    glib::Propagation::Stop
                }
                gtk::gdk::Key::v | gtk::gdk::Key::V => {
                    Self::paste_clipboard(&term, &id, &sink);
                    glib::Propagation::Stop
                }
                _ => glib::Propagation::Proceed,
            }
        });
        self.term.add_controller(keys);
    }

    /// Read the widget's clipboard: an image (any `image/*`) becomes PNG bytes
    /// routed as [`PaneIntent::PasteImage`] (App spills + bracketed-pastes the
    /// path); otherwise the text is written verbatim. Async because GTK's
    /// clipboard reads are.
    fn paste_clipboard(term: &vte4::Terminal, id: &str, sink: &Rc<dyn Fn(PaneIntent)>) {
        let clipboard = term.clipboard();
        let id_img = id.to_string();
        let sink_img = sink.clone();
        let clipboard_txt = clipboard.clone();
        let id_txt = id.to_string();
        let sink_txt = sink.clone();
        clipboard.read_texture_async(gtk::gio::Cancellable::NONE, move |res| {
            match res {
                Ok(Some(texture)) => {
                    let bytes = texture.save_to_png_bytes();
                    (sink_img)(PaneIntent::PasteImage {
                        id: id_img,
                        mime: "image/png".into(),
                        bytes: bytes.to_vec(),
                    });
                }
                _ => {
                    // No image → fall back to text paste.
                    clipboard_txt.read_text_async(gtk::gio::Cancellable::NONE, move |res| {
                        if let Ok(Some(text)) = res {
                            if !text.is_empty() {
                                (sink_txt)(PaneIntent::Write {
                                    id: id_txt,
                                    bytes: text.as_bytes().to_vec(),
                                });
                            }
                        }
                    });
                }
            }
        });
    }

    /// URL affordance: allow OSC-8 hyperlinks and register the URL regex so VTE
    /// underlines matches; a click resolves the OSC-8 target (what Claude Code
    /// emits) and opens it via the App (`gtk::show_uri`).
    fn wire_links(&self) {
        self.term.set_allow_hyperlink(true);
        // Best-effort: a bad regex just means no underline affordance. VTE's
        // regex is PCRE2; PCRE2_MULTILINE (0x0400) makes ^/$ line-relative and
        // `(?i)` inline handles case. A build without PCRE2 just skips this.
        const PCRE2_MULTILINE: u32 = 0x0000_0400;
        let url_re = "(?i)\\b(?:https?|ftp|file)://[^\\s\\x00-\\x1f<>\"]+";
        if let Ok(regex) = vte4::Regex::for_match(url_re, PCRE2_MULTILINE) {
            self.term.match_add_regex(&regex, 0);
        }
        let click = gtk::GestureClick::new();
        let term = self.term.clone();
        let sink = self.sink.clone();
        click.connect_released(move |_g, _n, x, y| {
            if let Some(uri) = term.check_hyperlink_at(x, y) {
                (sink)(PaneIntent::OpenUri {
                    uri: uri.to_string(),
                });
            }
        });
        self.term.add_controller(click);
    }

    /// Begin the pill fade (called from a Visible→Fading transition).
    fn start_fade(&self) {
        Self::fade_out(&self.pill, &self.boot, &self.life);
    }

    /// Shared fade-out: 250 ms opacity ramp, then hide + settle the state.
    fn fade_out(pill: &gtk::Label, boot: &Rc<RefCell<BootPill>>, _life: &Rc<Cell<Life>>) {
        pill.add_css_class("faded");
        pill.set_opacity(0.0);
        let pill = pill.clone();
        let boot = boot.clone();
        glib::timeout_add_local_once(
            std::time::Duration::from_millis(boot_pill::FADE_MS),
            move || {
                pill.set_visible(false);
                boot.borrow_mut().finish_fade();
            },
        );
    }
}
