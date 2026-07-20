//! Linear API-key modal — the GTK port of `LinearSettings.tsx` (153 lines).
//!
//! The Linear BADGE was already ported, but with no way to set the key the
//! whole feature was dead in GTK (parity inventory row 130). All four wire
//! methods already existed on the protocol — `getLinearKeySource`,
//! `checkLinearKey`, `saveLinearKey`, `clearLinearKey` (client.rs:861-875) —
//! so nothing here invents a shape.
//!
//! Presentation follows `dialogs.rs` (`.orch-dialog` gradient/border/shadow +
//! `dialog-pop`) and registers in the same `dialogs::OPEN` stack so the
//! remote-control harness can screenshot and Esc it.
//!
//! ARCHITECTURE: no event pump here — backend access is `Ctx::call` only.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use orchestra_rpc::types::{LinearKeyCheck, LinearKeySource};
use serde_json::json;

use crate::ctx::Ctx;
use crate::dialogs;

/// Status line for the configured source. Wording ported verbatim from
/// LinearSettings.tsx:70-77.
fn status_label(source: LinearKeySource) -> &'static str {
    match source {
        LinearKeySource::Stored => "A key is saved in Orchestra.",
        LinearKeySource::Env => "Using the LINEAR_API_KEY environment variable.",
        LinearKeySource::None => "No key configured — Linear badges are off.",
    }
}

fn source_css_class(source: LinearKeySource) -> &'static str {
    match source {
        LinearKeySource::Stored => "stored",
        LinearKeySource::Env => "env",
        LinearKeySource::None => "none",
    }
}

/// Electron refuses to persist a key Linear positively REJECTED, but still
/// allows saving when Linear was merely unreachable — the key itself may be
/// fine (LinearSettings.tsx:41-44). That exact string is the discriminator.
const INVALID_KEY: &str = "Invalid API key.";

fn blocks_save(check: &LinearKeyCheck) -> bool {
    !check.ok && check.error.as_deref() == Some(INVALID_KEY)
}

/// Open the modal. Resolves when it closes; `true` when the stored key changed
/// (saved or removed), so the caller can refresh the sidebar's setup notice —
/// the GTK equivalent of Electron's `onChanged` (LinearSettings.tsx:7).
pub async fn open(ctx: Rc<Ctx>) -> bool {
    let (tx, rx) = async_channel::bounded::<bool>(1);

    let win = gtk::Window::builder()
        .modal(true)
        .transient_for(&ctx.window)
        .resizable(false)
        .decorated(false)
        // styles.css:501 `.linear-settings { width: 460px }`.
        .default_width(460)
        .build();
    win.set_widget_name("linear-settings");
    win.add_css_class("orch-dialog");
    win.add_css_class("linear-settings");

    // styles.css:2488 `.modal { padding: 22px }` — this modal keeps the base
    // pad (unlike repo-scripts, which zeroes it for edge-to-edge dividers).
    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    root.add_css_class("dlg-box");

    // styles.css:2489 `.modal h2 { margin: 0 0 16px; font-size: 16px }`, minus
    // the bottom margin: `.sound-settings h2` (:494) overrides it to 4px and
    // the hint below owns the 14px gap (:497).
    let title = gtk::Label::new(Some("Linear API key"));
    title.set_xalign(0.0);
    title.add_css_class("modal-title");
    title.add_css_class("linear-title");
    title.set_widget_name("linear-title");
    root.append(&title);

    // styles.css:495-499 `.sound-hint`: 12px dim, 14px bottom margin, 1.5 lh.
    // LinearSettings.tsx:88 reuses that exact class for this paragraph.
    let hint = gtk::Label::new(Some(
        "Orchestra verifies branch issue keys against Linear and shows a badge only for \
         issues that exist. Paste a Linear personal API key (separate from the Linear MCP \
         login). It's stored encrypted on this machine.",
    ));
    hint.set_xalign(0.0);
    hint.set_wrap(true);
    hint.add_css_class("sound-hint");
    root.append(&hint);

    // styles.css:846-857 `.env-notice-link` — the inline link to Linear's
    // security settings (LinearSettings.tsx:91-98). GTK cannot put a button
    // mid-paragraph, so it becomes its own link row directly beneath.
    let key_link = gtk::Button::with_label("Open Linear API key settings…");
    key_link.set_widget_name("linear-key-link");
    key_link.add_css_class("env-notice-link");
    key_link.set_halign(gtk::Align::Start);
    {
        let ctx = ctx.clone();
        key_link.connect_clicked(move |_| {
            ctx.open_external("https://linear.app/settings/account/security");
        });
    }
    root.append(&key_link);

    // styles.css:502-509 `.linear-key-source`: 11.5px, 7px/10px pad, 6px
    // radius, --bg-3 fill, dim text; `.stored` (:510) lifts it to full --text.
    let source_label = gtk::Label::new(None);
    source_label.set_xalign(0.0);
    source_label.set_wrap(true);
    source_label.add_css_class("linear-key-source");
    source_label.set_widget_name("linear-key-source");
    source_label.set_visible(false);
    root.append(&source_label);

    // styles.css:511-524 `.linear-key-input`: full width, 8px/10px pad, 6px
    // radius, --border, --bg-2, monospace 12.5px.
    let entry = gtk::PasswordEntry::new();
    entry.set_show_peek_icon(true);
    entry.set_placeholder_text(Some("lin_api_…"));
    entry.add_css_class("linear-key-input");
    entry.set_widget_name("linear-key-input");
    root.append(&entry);

    // styles.css:525-532 `.linear-key-status`: 11.5px, 8px top margin,
    // 16px min-height (so the row never collapses and shifts the buttons),
    // with .ok #5fd08a / .err --red / .muted --text-dim.
    let status = gtk::Label::new(None);
    status.set_xalign(0.0);
    status.set_wrap(true);
    status.add_css_class("linear-key-status");
    status.set_widget_name("linear-key-status");
    root.append(&status);

    // styles.css:2493 `.modal-actions { justify-content:flex-end; gap:8px;
    // margin-top:12px }` + :533-534 `.linear-key-actions { align-items:center }`
    // and its `.spacer { flex: 1 }`.
    let actions = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    actions.add_css_class("modal-actions");
    actions.add_css_class("linear-key-actions");

    // "Remove saved key" shows ONLY for a stored key (LinearSettings.tsx:136).
    // An env key is not Orchestra's to clear, and there is nothing to remove
    // when none is configured.
    let remove = gtk::Button::with_label("Remove saved key");
    remove.set_widget_name("linear-key-remove");
    remove.add_css_class("ghost");
    remove.add_css_class("danger");
    remove.set_visible(false);
    actions.append(&remove);

    let spacer = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    spacer.set_hexpand(true);
    spacer.add_css_class("spacer");
    actions.append(&spacer);

    let test = gtk::Button::with_label("Test");
    test.set_widget_name("linear-key-test");
    test.add_css_class("ghost");
    test.set_sensitive(false);
    actions.append(&test);

    let save = gtk::Button::with_label("Save");
    save.set_widget_name("linear-key-save");
    save.add_css_class("primary");
    save.set_sensitive(false);
    actions.append(&save);
    root.append(&actions);

    win.set_child(Some(&root));

    // ---- shared state ------------------------------------------------------
    let changed = Rc::new(RefCell::new(false));
    let busy = Rc::new(RefCell::new(false));

    // Render the source line from the backend's answer. Called at open and
    // after every save/clear, so the line always reflects stored truth rather
    // than what we just asked for.
    let refresh_source = {
        let ctx = ctx.clone();
        let source_label = source_label.clone();
        let remove = remove.clone();
        move || {
            match ctx.call_typed::<LinearKeySource>("getLinearKeySource", vec![]) {
                Ok(src) => {
                    source_label.set_text(status_label(src));
                    for c in ["stored", "env", "none"] {
                        source_label.remove_css_class(c);
                    }
                    source_label.add_css_class(source_css_class(src));
                    source_label.set_visible(true);
                    remove.set_visible(src == LinearKeySource::Stored);
                }
                Err(_) => {
                    // Electron swallows this too (LinearSettings.tsx:19) — the
                    // modal is still usable, it just cannot state the source.
                    source_label.set_visible(false);
                    remove.set_visible(false);
                }
            }
        }
    };
    refresh_source();

    let set_status = {
        let status = status.clone();
        move |text: &str, class: &str| {
            status.set_text(text);
            for c in ["ok", "err", "muted"] {
                status.remove_css_class(c);
            }
            if !class.is_empty() {
                status.add_css_class(class);
            }
        }
    };

    // Typing invalidates the last probe result, exactly as Electron clears
    // `check`/`saved` on change (LinearSettings.tsx:114-118).
    {
        let test = test.clone();
        let save = save.clone();
        let set_status = set_status.clone();
        let busy = busy.clone();
        entry.connect_changed(move |e| {
            let has = !e.text().trim().is_empty();
            if !*busy.borrow() {
                test.set_sensitive(has);
                save.set_sensitive(has);
            }
            set_status("", "");
        });
    }

    // ---- Test --------------------------------------------------------------
    {
        let ctx = ctx.clone();
        let entry = entry.clone();
        let set_status = set_status.clone();
        let busy = busy.clone();
        let (test_b, save_b) = (test.clone(), save.clone());
        test.connect_clicked(move |_| {
            let key = entry.text().to_string();
            if key.trim().is_empty() || *busy.borrow() {
                return;
            }
            *busy.borrow_mut() = true;
            test_b.set_sensitive(false);
            save_b.set_sensitive(false);
            set_status("Checking with Linear…", "muted");

            let check = ctx
                .call_typed::<LinearKeyCheck>("checkLinearKey", vec![json!(key)])
                .unwrap_or(LinearKeyCheck {
                    ok: false,
                    name: None,
                    // LinearSettings.tsx:28 — a thrown call is reported as a
                    // failure to TEST, not as an invalid key.
                    error: Some("Could not test the key.".into()),
                });

            *busy.borrow_mut() = false;
            test_b.set_sensitive(true);
            save_b.set_sensitive(true);
            if check.ok {
                let name = check.name.as_deref().unwrap_or("Linear");
                set_status(&format!("\u{2713} Connected as {name}"), "ok");
            } else {
                let err = check.error.as_deref().unwrap_or("Could not test the key.");
                set_status(&format!("\u{2717} {err}"), "err");
            }
        });
    }

    // ---- Save --------------------------------------------------------------
    {
        let ctx = ctx.clone();
        let entry = entry.clone();
        let set_status = set_status.clone();
        let refresh_source = refresh_source.clone();
        let changed = changed.clone();
        let busy = busy.clone();
        let (test_b, save_b) = (test.clone(), save.clone());
        save.connect_clicked(move |_| {
            let key = entry.text().to_string();
            if key.trim().is_empty() || *busy.borrow() {
                return;
            }
            *busy.borrow_mut() = true;
            test_b.set_sensitive(false);
            save_b.set_sensitive(false);
            set_status("Checking with Linear…", "muted");

            // Verify BEFORE persisting, so a key Linear positively rejects is
            // never stored — but a mere network failure still allows the save
            // (LinearSettings.tsx:41-44).
            let check = ctx
                .call_typed::<LinearKeyCheck>("checkLinearKey", vec![json!(key)])
                .unwrap_or(LinearKeyCheck {
                    ok: false,
                    name: None,
                    error: Some("Could not save the key.".into()),
                });

            let finish_ui = |busy: &RefCell<bool>, t: &gtk::Button, s: &gtk::Button| {
                *busy.borrow_mut() = false;
                t.set_sensitive(true);
                s.set_sensitive(true);
            };

            if blocks_save(&check) {
                finish_ui(&busy, &test_b, &save_b);
                let err = check.error.as_deref().unwrap_or(INVALID_KEY);
                set_status(&format!("\u{2717} {err}"), "err");
                return;
            }

            match ctx.call("saveLinearKey", vec![json!(key)]) {
                Ok(_) => {
                    entry.set_text("");
                    *changed.borrow_mut() = true;
                    refresh_source();
                    finish_ui(&busy, &test_b, &save_b);
                    // A save that went through while Linear was unreachable
                    // still reports the probe's warning, not a bare "Saved."
                    if check.ok {
                        set_status("\u{2713} Saved.", "ok");
                    } else {
                        let err = check.error.as_deref().unwrap_or("");
                        set_status(&format!("\u{2713} Saved (unverified: {err})"), "muted");
                    }
                    // The entry is now empty, so nothing is left to test/save.
                    test_b.set_sensitive(false);
                    save_b.set_sensitive(false);
                }
                Err(e) => {
                    finish_ui(&busy, &test_b, &save_b);
                    set_status(&format!("\u{2717} {e}"), "err");
                }
            }
        });
    }

    // ---- Remove ------------------------------------------------------------
    {
        let ctx = ctx.clone();
        let entry = entry.clone();
        let set_status = set_status.clone();
        let refresh_source = refresh_source.clone();
        let changed = changed.clone();
        let busy = busy.clone();
        remove.connect_clicked(move |_| {
            if *busy.borrow() {
                return;
            }
            *busy.borrow_mut() = true;
            match ctx.call("clearLinearKey", vec![]) {
                Ok(_) => {
                    entry.set_text("");
                    *changed.borrow_mut() = true;
                    set_status("", "");
                    refresh_source();
                }
                Err(e) => set_status(&format!("\u{2717} {e}"), "err"),
            }
            *busy.borrow_mut() = false;
        });
    }

    // Enter saves when there is something to save (LinearSettings.tsx:120).
    {
        let save = save.clone();
        entry.connect_activate(move |e| {
            if !e.text().trim().is_empty() {
                save.emit_clicked();
            }
        });
    }

    let finish = {
        let tx = tx.clone();
        let win = win.clone();
        let changed = changed.clone();
        move || {
            let _ = tx.try_send(*changed.borrow());
            win.close();
        }
    };

    let keys = gtk::EventControllerKey::new();
    {
        let finish = finish.clone();
        keys.connect_key_pressed(move |_, key, _, _| match key {
            gtk::gdk::Key::Escape => {
                finish();
                glib::Propagation::Stop
            }
            _ => glib::Propagation::Proceed,
        });
    }
    win.add_controller(keys);

    // Same `dlg.cancel` route the harness uses (dialogs.rs:193-206).
    let action_group = gtk::gio::SimpleActionGroup::new();
    let cancel_action = gtk::gio::SimpleAction::new("cancel", None);
    {
        let finish = finish.clone();
        cancel_action.connect_activate(move |_, _| finish());
    }
    action_group.add_action(&cancel_action);
    win.insert_action_group("dlg", Some(&action_group));

    {
        let tx = tx.clone();
        let changed = changed.clone();
        win.connect_close_request(move |w| {
            let _ = tx.try_send(*changed.borrow());
            dialogs::unregister(w);
            glib::Propagation::Proceed
        });
    }

    dialogs::register(&win);
    win.present();
    entry.grab_focus();

    rx.recv().await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_positively_invalid_key_blocks_the_save() {
        // Linear said the key is bad → refuse to persist it.
        assert!(blocks_save(&LinearKeyCheck {
            ok: false,
            name: None,
            error: Some(INVALID_KEY.into()),
        }));
        // Linear was merely unreachable → the key may be fine, allow the save.
        assert!(!blocks_save(&LinearKeyCheck {
            ok: false,
            name: None,
            error: Some("Network error".into()),
        }));
        assert!(!blocks_save(&LinearKeyCheck {
            ok: true,
            name: Some("acme".into()),
            error: None,
        }));
    }

    #[test]
    fn source_wording_matches_electron() {
        assert_eq!(
            status_label(LinearKeySource::Stored),
            "A key is saved in Orchestra."
        );
        assert_eq!(
            status_label(LinearKeySource::Env),
            "Using the LINEAR_API_KEY environment variable."
        );
        assert_eq!(
            status_label(LinearKeySource::None),
            "No key configured — Linear badges are off."
        );
    }

    #[test]
    fn key_source_deserializes_from_the_wire_lowercase() {
        // `#[serde(rename_all = "lowercase")]` — the wire sends bare strings.
        let s: LinearKeySource = serde_json::from_value(json!("stored")).unwrap();
        assert_eq!(s, LinearKeySource::Stored);
        let s: LinearKeySource = serde_json::from_value(json!("env")).unwrap();
        assert_eq!(s, LinearKeySource::Env);
        let s: LinearKeySource = serde_json::from_value(json!("none")).unwrap();
        assert_eq!(s, LinearKeySource::None);
    }

    #[test]
    fn check_deserializes_both_wire_arms() {
        let ok: LinearKeyCheck =
            serde_json::from_value(json!({"ok": true, "name": "acme"})).unwrap();
        assert!(ok.ok);
        assert_eq!(ok.name.as_deref(), Some("acme"));
        let err: LinearKeyCheck =
            serde_json::from_value(json!({"ok": false, "error": INVALID_KEY})).unwrap();
        assert!(!err.ok);
        assert_eq!(err.error.as_deref(), Some(INVALID_KEY));
    }
}
