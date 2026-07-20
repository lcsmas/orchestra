//! Promise-shaped dialog system (plan §5.3): alert / confirm / error /
//! success / prompt as async fns over modal, transient, undecorated
//! GtkWindows — mirroring the Electron renderer's Dialog.tsx contract
//! (tone styling, Enter confirms, Esc cancels).
//!
//! Callers run on the GTK main context (`glib::spawn_future_local`); the
//! result travels over a capacity-1 channel that the button/key handlers
//! fill exactly once (`try_send` — later sends on an already-resolved dialog
//! are no-ops, which also makes the close-path idempotent).
//!
//! Open dialogs register in a thread-local stack so the remote-control
//! harness can route `{"op":"key","name":"Escape"}` to the topmost one —
//! under headless sway no real key event ever reaches the app (no seat
//! keyboard), so tests need this GTK-side path.

use gtk::glib;
use gtk::prelude::*;
use std::cell::RefCell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Info,
    Error,
    Success,
}

impl Tone {
    fn css_class(self) -> &'static str {
        match self {
            Tone::Info => "tone-info",
            Tone::Error => "tone-error",
            Tone::Success => "tone-success",
        }
    }

    /// Glyph for the circular tone chip above the title — the GTK stand-in for
    /// Electron's inline `ToneIcon` SVGs (Dialog.tsx:174-200). Same three
    /// shapes: danger/error = (!) in a circle, success = a check, info = (i).
    fn icon_glyph(self) -> &'static str {
        match self {
            Tone::Info => "\u{24d8}",    // ⓘ
            Tone::Error => "\u{26a0}",   // ⚠
            Tone::Success => "\u{2713}", // ✓
        }
    }
}

thread_local! {
    /// Open dialog windows, bottom → top.
    static OPEN: RefCell<Vec<gtk::Window>> = const { RefCell::new(Vec::new()) };
}

/// The topmost open dialog window, if any. The remote-control harness uses
/// this as the default screenshot target: dialogs are separate toplevels, so
/// a main-window capture can never show a modal.
pub fn topmost() -> Option<gtk::Window> {
    OPEN.with_borrow(|open| open.last().cloned())
}

/// Register a modal built OUTSIDE this module (the repo-scripts and Linear
/// settings modals in `crate::modals`) into the same stack.
///
/// Those two are full form modals rather than the alert/confirm/prompt shapes
/// [`run`] serves, so they build their own window — but they must still be
/// reachable by `topmost()`, or the remote-control harness screenshots the
/// main window and its Escape routing skips them entirely.
pub fn register(win: &gtk::Window) {
    OPEN.with_borrow_mut(|open| open.push(win.clone()));
}

/// Counterpart to [`register`], called from the modal's `close-request`.
pub fn unregister(win: &gtk::Window) {
    OPEN.with_borrow_mut(|open| open.retain(|w| w != win));
}

/// Cancel (Esc) the topmost open dialog. Returns false when none is open.
pub fn cancel_topmost() -> bool {
    activate_on_topmost("dlg.cancel")
}

/// Confirm (Enter) the topmost open dialog. Returns false when none is open.
pub fn confirm_topmost() -> bool {
    activate_on_topmost("dlg.confirm")
}

fn activate_on_topmost(action: &str) -> bool {
    match topmost() {
        Some(win) => win.activate_action(action, None).is_ok(),
        None => false,
    }
}

struct Spec<'a> {
    tone: Tone,
    title: &'a str,
    body: &'a str,
    confirm_label: &'a str,
    cancel_label: Option<&'a str>,
    /// Some(placeholder) turns the dialog into a prompt with a text entry.
    entry_placeholder: Option<&'a str>,
    /// Styles the confirm button as the DESTRUCTIVE action (filled red), the
    /// way Electron does for `tone: 'danger'` confirms (Dialog.tsx:109 →
    /// `button.danger-primary`). Purely visual: the button's label, its
    /// position and what it resolves to are unchanged.
    destructive: bool,
}

/// None = cancelled/dismissed; Some(text) = confirmed (text is "" for
/// non-prompt dialogs).
async fn run(parent: &gtk::Window, spec: Spec<'_>) -> Option<String> {
    let (tx, rx) = async_channel::bounded::<Option<String>>(1);

    let win = gtk::Window::builder()
        .modal(true)
        .transient_for(parent)
        .resizable(false)
        .decorated(false)
        .default_width(380)
        .build();
    win.set_widget_name("orch-dialog");
    win.add_css_class("orch-dialog");
    win.add_css_class(spec.tone.css_class());

    // Spacing 0, NOT 8. Electron's `.dialog` declares no gap; the icon/title/
    // detail/input separations are all child margins, and theme.css already ports
    // `.dlg-title{margin-bottom:6px}` (:955) and `.dlg-buttons{margin-top:18px}`
    // (:967). GTK adds box spacing ON TOP of those margins, so title->body
    // rendered 14px instead of 6 and body->buttons 26px instead of 18.
    let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
    content.add_css_class("dlg-box");

    // Tone chip (Electron `.dialog-icon`, styles.css:2497-2524): a circular
    // tinted glyph above the title. ADDITIVE widget — nothing existing is
    // renamed; the name is new so E2E drives that assert on the old names are
    // unaffected.
    let icon = gtk::Label::new(Some(spec.tone.icon_glyph()));
    icon.set_widget_name("dialog-icon");
    icon.add_css_class("dlg-icon");
    icon.set_halign(gtk::Align::Start);
    content.append(&icon);

    let title = gtk::Label::new(Some(spec.title));
    title.set_xalign(0.0);
    title.add_css_class("dlg-title");
    title.set_widget_name("dialog-title");
    content.append(&title);

    if !spec.body.is_empty() {
        let body = gtk::Label::new(Some(spec.body));
        body.set_xalign(0.0);
        body.set_wrap(true);
        body.add_css_class("dlg-body");
        body.set_widget_name("dialog-body");
        content.append(&body);
    }

    let entry = spec.entry_placeholder.map(|placeholder| {
        let entry = gtk::Entry::new();
        entry.set_placeholder_text(Some(placeholder));
        entry.set_widget_name("dialog-entry");
        content.append(&entry);
        entry
    });

    let buttons = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    buttons.set_halign(gtk::Align::End);
    buttons.add_css_class("dlg-buttons");

    // Resolution: gather the entry text (prompt) or "" and close. The
    // capacity-1 channel makes double-resolution (e.g. confirm then the
    // close-request cancel) harmless.
    let finish = {
        let tx = tx.clone();
        let win = win.clone();
        let entry = entry.clone();
        move |confirmed: bool| {
            let result = confirmed.then(|| {
                entry
                    .as_ref()
                    .map(|e| e.text().to_string())
                    .unwrap_or_default()
            });
            let _ = tx.try_send(result);
            win.close();
        }
    };

    if let Some(label) = spec.cancel_label {
        let cancel = gtk::Button::with_label(label);
        cancel.set_widget_name("dialog-cancel");
        let finish = finish.clone();
        cancel.connect_clicked(move |_| finish(false));
        buttons.append(&cancel);
    }

    let confirm = gtk::Button::with_label(spec.confirm_label);
    confirm.set_widget_name("dialog-confirm");
    confirm.add_css_class(if spec.destructive {
        "destructive"
    } else {
        "suggested"
    });
    {
        let finish = finish.clone();
        confirm.connect_clicked(move |_| finish(true));
    }
    buttons.append(&confirm);
    content.append(&buttons);
    win.set_child(Some(&content));

    // dlg.confirm / dlg.cancel actions: one target for the key controller,
    // the remote-control `key` op, and anything else that needs to resolve
    // the dialog without locating its buttons.
    let actions = gtk::gio::SimpleActionGroup::new();
    let confirm_action = gtk::gio::SimpleAction::new("confirm", None);
    {
        let finish = finish.clone();
        confirm_action.connect_activate(move |_, _| finish(true));
    }
    let cancel_action = gtk::gio::SimpleAction::new("cancel", None);
    {
        let finish = finish.clone();
        cancel_action.connect_activate(move |_, _| finish(false));
    }
    actions.add_action(&confirm_action);
    actions.add_action(&cancel_action);
    win.insert_action_group("dlg", Some(&actions));

    let keys = gtk::EventControllerKey::new();
    {
        let finish = finish.clone();
        keys.connect_key_pressed(move |_, key, _, _| match key {
            gtk::gdk::Key::Escape => {
                finish(false);
                glib::Propagation::Stop
            }
            gtk::gdk::Key::Return | gtk::gdk::Key::KP_Enter => {
                finish(true);
                glib::Propagation::Stop
            }
            _ => glib::Propagation::Proceed,
        });
    }
    win.add_controller(keys);

    if let Some(entry) = &entry {
        let finish = finish.clone();
        entry.connect_activate(move |_| finish(true));
    }

    // Window-manager close (or win.close() from a finish path): resolve as
    // cancelled if nothing resolved yet, and unregister from the stack.
    {
        let tx = tx.clone();
        let win_for_stack = win.clone();
        win.connect_close_request(move |_| {
            let _ = tx.try_send(None);
            OPEN.with_borrow_mut(|open| open.retain(|w| w != &win_for_stack));
            glib::Propagation::Proceed
        });
    }

    OPEN.with_borrow_mut(|open| open.push(win.clone()));
    win.present();
    if let Some(entry) = &entry {
        entry.grab_focus();
    }

    rx.recv().await.ok().flatten()
}

pub async fn alert(parent: &gtk::Window, title: &str, body: &str) {
    run(
        parent,
        Spec {
            tone: Tone::Info,
            title,
            body,
            confirm_label: "OK",
            cancel_label: None,
            entry_placeholder: None,
            destructive: false,
        },
    )
    .await;
}

pub async fn error(parent: &gtk::Window, title: &str, body: &str) {
    run(
        parent,
        Spec {
            tone: Tone::Error,
            title,
            body,
            confirm_label: "OK",
            cancel_label: None,
            entry_placeholder: None,
            destructive: false,
        },
    )
    .await;
}

pub async fn success(parent: &gtk::Window, title: &str, body: &str) {
    run(
        parent,
        Spec {
            tone: Tone::Success,
            title,
            body,
            confirm_label: "OK",
            cancel_label: None,
            entry_placeholder: None,
            destructive: false,
        },
    )
    .await;
}

pub async fn confirm(parent: &gtk::Window, title: &str, body: &str) -> bool {
    run(
        parent,
        Spec {
            tone: Tone::Info,
            title,
            body,
            confirm_label: "Confirm",
            cancel_label: Some("Cancel"),
            entry_placeholder: None,
            destructive: false,
        },
    )
    .await
    .is_some()
}

/// Two-button confirm with CALLER-CHOSEN labels and tone — for dialogs that
/// must mirror the Electron app's wording (e.g. the missing-dependency warning's
/// "Continue Anyway" / "Quit"). Returns true when the confirm button was used;
/// dismissing (Escape / cancel) returns false.
pub async fn confirm_labeled(
    parent: &gtk::Window,
    tone: Tone,
    title: &str,
    body: &str,
    confirm_label: &str,
    cancel_label: &str,
) -> bool {
    run(
        parent,
        Spec {
            tone,
            title,
            body,
            confirm_label,
            cancel_label: Some(cancel_label),
            entry_placeholder: None,
            destructive: false,
        },
    )
    .await
    .is_some()
}

/// Two-button DESTRUCTIVE confirm: caller-chosen confirm label, error tone,
/// and a filled-red confirm button — the GTK equivalent of the Electron
/// dialog's `tone: 'danger'` + `confirmLabel` pair (Sidebar.tsx:893-894).
///
/// Behaviourally identical to [`confirm`]: returns true only when the confirm
/// button (or Enter) resolved it; Escape/Cancel/dismiss return false. The
/// difference is presentation plus the caller-supplied label.
pub async fn confirm_destructive(
    parent: &gtk::Window,
    title: &str,
    body: &str,
    confirm_label: &str,
) -> bool {
    run(
        parent,
        Spec {
            tone: Tone::Error,
            title,
            body,
            confirm_label,
            cancel_label: Some("Cancel"),
            entry_placeholder: None,
            destructive: true,
        },
    )
    .await
    .is_some()
}

pub async fn prompt(
    parent: &gtk::Window,
    title: &str,
    body: &str,
    placeholder: &str,
) -> Option<String> {
    run(
        parent,
        Spec {
            tone: Tone::Info,
            title,
            body,
            confirm_label: "OK",
            cancel_label: Some("Cancel"),
            entry_placeholder: Some(placeholder),
            destructive: false,
        },
    )
    .await
}
