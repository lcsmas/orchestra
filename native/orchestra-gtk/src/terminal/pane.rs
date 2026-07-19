//! One feed-mode VTE terminal pane bound to a single PTY id (plan §5.2).
//!
//! The pane renders backend `ptyData` via `feed()`, forwards keystrokes as
//! `ptyWrite`, and reports grid resizes as `ptyResize` (dropping no-ops). It
//! NEVER spawns a child — the backend owns the PTY. Every backend touch goes
//! through [`Ctx`] and resolves `ctx.backend()` PER-CALL, so a reconnect (which
//! swaps the stored backend Rc) is always picked up live — a cached handle
//! would silently write to a dead connection after any reconnect.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use vte4::prelude::*;

use super::boot_pill::{self, BootPill, PillKind, Trigger};
use super::{term_bg, term_fg, term_palette, terminal_font};
use crate::ctx::Ctx;

/// Which kind of PTY a pane fronts — governs Ctrl+C policy, auto-start, and
/// which RPC method starts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneKind {
    /// The agent PTY (`<ws>`): auto-starts on first fit; Ctrl+C NEVER forwards
    /// (the agent must not get SIGINT) — copy-or-nothing.
    Agent,
    /// The run-script PTY (`<ws>:run`): B3's toolbar owns start/stop, so this
    /// pane only feeds + resizes; Ctrl+C forwards when there's no selection.
    Run,
    /// The nvim PTY (`<ws>:nvim`): auto-starts on first fit; Ctrl+C forwards
    /// when there's no selection (nvim owns the key).
    Nvim,
}

impl PaneKind {
    /// Whether Ctrl+C with no selection is forwarded to the PTY.
    fn forwards_ctrl_c(self) -> bool {
        !matches!(self, PaneKind::Agent)
    }
    /// Whether the pane starts its own PTY on first fit. The Run pane does not —
    /// B3's toolbar Run button drives `runScriptStart`.
    fn auto_starts(self) -> bool {
        !matches!(self, PaneKind::Run)
    }
    /// The `ptyStart`-family method for this kind, keyed for the given pty id.
    /// Run has none (toolbar-driven). Nvim/run RPCs want the BARE ws id.
    fn start(self, ctx: &Ctx, id: &str, cols: u16, rows: u16) {
        let Some(b) = ctx.backend() else { return };
        let bare = strip_pty_suffix(id);
        let res = match self {
            PaneKind::Agent => b.pty_start(id, cols, rows),
            PaneKind::Nvim => b.nvim_start(bare, cols, rows),
            PaneKind::Run => return,
        };
        if let Err(e) = res {
            eprintln!("[terminal] start {id}: {e}");
        }
    }
}

/// PTY ids are `<ws>`, `<ws>:run`, `<ws>:nvim`. The run/nvim RPCs key off the
/// bare workspace id.
fn strip_pty_suffix(id: &str) -> &str {
    id.split_once(':').map_or(id, |(ws, _)| ws)
}

/// Lifecycle of the underlying PTY as the pane understands it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Life {
    /// Not yet started (waiting for the first visible fit / toolbar start).
    Unstarted,
    /// PTY is live and feeding.
    Running,
    /// PTY exited/stopped — the next keystroke relaunches it (not forwarded).
    Dead,
}

pub struct TerminalPane {
    id: String,
    kind: PaneKind,
    ctx: Rc<Ctx>,
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
}

impl TerminalPane {
    /// Build a pane of a specific [`PaneKind`]. All backend calls route through
    /// `ctx` and resolve the live backend per-call.
    pub fn with_kind(id: &str, kind: PaneKind, ctx: Rc<Ctx>) -> Self {
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
            kind,
            ctx,
            root,
            term,
            pill,
            boot: Rc::new(RefCell::new(BootPill::new())),
            life: Rc::new(Cell::new(Life::Unstarted)),
            last_size: Rc::new(Cell::new((0, 0))),
            started: Rc::new(Cell::new(false)),
        };
        pane.wire();
        pane
    }

    /// The widget to mount in the GtkStack.
    pub fn widget(&self) -> &gtk::Widget {
        self.root.upcast_ref()
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

    /// Replay scrollback (backend bytes) before live feed.
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
        self.pill.remove_css_class("faded");
        // Fallback 20 s dismiss.
        let boot = self.boot.clone();
        let pill = self.pill.clone();
        glib::timeout_add_local_once(
            std::time::Duration::from_millis(boot_pill::CLEAR_TIMEOUT_MS),
            move || {
                if boot.borrow_mut().apply(Trigger::Timeout) {
                    Self::fade_out(&pill, &boot);
                }
            },
        );
    }

    /// The PTY exited or was stopped: show the relaunch notice; next keystroke
    /// on a Dead pane triggers a restart instead of being forwarded.
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
    /// (VTE keeps its grid; the desync is child-side).
    pub fn on_shown(&self) {
        if self.life.get() != Life::Running {
            return;
        }
        let (cols, rows) = self.last_size.get();
        if cols > 0 && rows > 0 {
            if let Some(b) = self.ctx.backend() {
                let _ = b.pty_repaint(&self.id, cols, rows);
            }
        }
    }

    fn wire(&self) {
        // Keystrokes → ptyWrite. A Dead agent/nvim pane relaunches on any key;
        // a Dead Run pane waits for B3's toolbar Run button.
        {
            let id = self.id.clone();
            let kind = self.kind;
            let ctx = self.ctx.clone();
            let boot = self.boot.clone();
            let pill = self.pill.clone();
            let life = self.life.clone();
            let last_size = self.last_size.clone();
            self.term.connect_commit(move |_term, text, size| {
                if life.get() == Life::Dead {
                    if kind == PaneKind::Run {
                        return; // Run relaunches only via the toolbar.
                    }
                    life.set(Life::Running);
                    let (cols, rows) = last_size.get();
                    kind.start(&ctx, &id, cols.max(1), rows.max(1));
                    return;
                }
                let bytes = &text.as_bytes()[..size as usize];
                ctx.pty_write(&id, bytes);
                if boot.borrow_mut().apply(Trigger::Keystroke) {
                    Self::fade_out(&pill, &boot);
                }
            });
        }

        // Grid resize → ptyResize (drop no-ops) + lazy first-fit start.
        //
        // GtkWidget has no generic "was resized" signal and VTE isn't a
        // DrawingArea, so we sample the grid on the frame clock while mapped
        // (cheap — returns immediately unless (cols,rows) changed). VTE has
        // already re-flowed column_count/row_count to the allocation.
        {
            let id = self.id.clone();
            let kind = self.kind;
            let ctx = self.ctx.clone();
            let last_size = self.last_size.clone();
            let started = self.started.clone();
            let life = self.life.clone();
            self.term.add_tick_callback(move |term, _clock| {
                let cols = term.column_count().clamp(1, u16::MAX as i64) as u16;
                let rows = term.row_count().clamp(1, u16::MAX as i64) as u16;
                if !term.is_mapped() || (cols, rows) == last_size.get() {
                    return glib::ControlFlow::Continue;
                }
                let first_fit = !started.replace(true);
                last_size.set((cols, rows));
                if first_fit && kind.auto_starts() {
                    life.set(Life::Running);
                    kind.start(&ctx, &id, cols, rows);
                } else if life.get() == Life::Running {
                    // Resize a live PTY (also handles the Run pane once B3's
                    // toolbar has started it — the run PTY resizes idempotently).
                    if let Some(b) = ctx.backend() {
                        let _ = b.pty_resize(&id, cols, rows);
                    }
                }
                glib::ControlFlow::Continue
            });
        }

        self.wire_keyboard();
        self.wire_links();
    }

    /// Keyboard parity with the renderer's `Terminal.tsx`/`RunTerminal.tsx`:
    /// - Ctrl+C copies the selection; whether it then forwards `^C` depends on
    ///   the pane kind — the agent NEVER forwards (no SIGINT), run/nvim forward
    ///   when there's no selection.
    /// - Ctrl+V pastes: a clipboard image wins (spilled + bracketed-pasted),
    ///   else the clipboard text.
    /// - Shift+Enter sends ESC+CR (what `/terminal-setup` configures).
    ///
    /// Capture phase so it intercepts before VTE's own key handling.
    fn wire_keyboard(&self) {
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let id = self.id.clone();
        let kind = self.kind;
        let ctx = self.ctx.clone();
        let term = self.term.clone();
        let boot = self.boot.clone();
        let pill = self.pill.clone();
        keys.connect_key_pressed(move |_ctrl, key, _code, modifiers| {
            let ctrl = modifiers.contains(gtk::gdk::ModifierType::CONTROL_MASK);
            let shift = modifiers.contains(gtk::gdk::ModifierType::SHIFT_MASK);
            let alt = modifiers.contains(gtk::gdk::ModifierType::ALT_MASK);

            // Shift+Enter → ESC+CR (no other modifiers).
            if key == gtk::gdk::Key::Return && shift && !ctrl && !alt {
                ctx.pty_write(&id, b"\x1b\r");
                return glib::Propagation::Stop;
            }
            if !ctrl {
                return glib::Propagation::Proceed;
            }
            match key {
                gtk::gdk::Key::c | gtk::gdk::Key::C => {
                    if term.has_selection() {
                        term.copy_clipboard_format(vte4::Format::Text);
                        glib::Propagation::Stop
                    } else if kind.forwards_ctrl_c() {
                        ctx.pty_write(&id, &[0x03]); // forward ^C
                        glib::Propagation::Stop
                    } else {
                        // Agent: swallow (no SIGINT). Still dismiss the pill.
                        if boot.borrow_mut().apply(Trigger::Keystroke) {
                            Self::fade_out(&pill, &boot);
                        }
                        glib::Propagation::Stop
                    }
                }
                gtk::gdk::Key::v | gtk::gdk::Key::V => {
                    Self::paste_clipboard(&term, &id, &ctx);
                    glib::Propagation::Stop
                }
                _ => glib::Propagation::Proceed,
            }
        });
        self.term.add_controller(keys);
    }

    /// Read the widget's clipboard: an image becomes PNG bytes → the backend's
    /// `saveClipboardImage` → the temp path is bracketed-pasted; otherwise the
    /// text is written verbatim. Async because GTK's clipboard reads are.
    fn paste_clipboard(term: &vte4::Terminal, id: &str, ctx: &Rc<Ctx>) {
        let clipboard = term.clipboard();
        let ctx_img = ctx.clone();
        let id_img = id.to_string();
        let clipboard_txt = clipboard.clone();
        let ctx_txt = ctx.clone();
        let id_txt = id.to_string();
        clipboard.read_texture_async(gtk::gio::Cancellable::NONE, move |res| match res {
            Ok(Some(texture)) => {
                let png = texture.save_to_png_bytes();
                if let Some(b) = ctx_img.backend() {
                    if let Ok(Some(path)) = b.save_clipboard_image("image/png", &png) {
                        let paste = format!("\x1b[200~{path} \x1b[201~");
                        ctx_img.pty_write(&id_img, paste.as_bytes());
                    }
                }
            }
            _ => {
                clipboard_txt.read_text_async(gtk::gio::Cancellable::NONE, move |res| {
                    if let Ok(Some(text)) = res {
                        if !text.is_empty() {
                            ctx_txt.pty_write(&id_txt, text.as_bytes());
                        }
                    }
                });
            }
        });
    }

    /// URL affordance: allow OSC-8 hyperlinks + a URL match-regex for the
    /// underline cue; a click resolves the OSC-8 target and opens it via Ctx.
    fn wire_links(&self) {
        self.term.set_allow_hyperlink(true);
        const PCRE2_MULTILINE: u32 = 0x0000_0400;
        let url_re = "(?i)\\b(?:https?|ftp|file)://[^\\s\\x00-\\x1f<>\"]+";
        if let Ok(regex) = vte4::Regex::for_match(url_re, PCRE2_MULTILINE) {
            self.term.match_add_regex(&regex, 0);
        }
        let click = gtk::GestureClick::new();
        let term = self.term.clone();
        let ctx = self.ctx.clone();
        click.connect_released(move |_g, _n, x, y| {
            if let Some(uri) = term.check_hyperlink_at(x, y) {
                ctx.open_external(&uri);
            }
        });
        self.term.add_controller(click);
    }

    /// Begin the pill fade (Visible→Fading transition).
    fn start_fade(&self) {
        Self::fade_out(&self.pill, &self.boot);
    }

    /// Shared fade-out: 250 ms opacity ramp, then hide + settle the state.
    fn fade_out(pill: &gtk::Label, boot: &Rc<RefCell<BootPill>>) {
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
