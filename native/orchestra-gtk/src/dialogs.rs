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
}

thread_local! {
    /// Open dialog windows, bottom → top.
    static OPEN: RefCell<Vec<gtk::Window>> = const { RefCell::new(Vec::new()) };
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
    let top = OPEN.with_borrow(|open| open.last().cloned());
    match top {
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

    let content = gtk::Box::new(gtk::Orientation::Vertical, 8);
    content.add_css_class("dlg-box");

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
    confirm.add_css_class("suggested");
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
        },
    )
    .await
}
