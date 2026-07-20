//! Repo scripts modal — the GTK port of `RepoScriptsModal.tsx` (258 lines).
//!
//! Replaces the `sidebar/mod.rs` stub that said "separate M2 workstream" while
//! the Run-tab guidance (`terminal/stack.rs:139`) actively told users to open
//! it. Three script editors (setup / run / archive), a default-base-branch
//! picker and a Claude-account picker, saved through four wire methods that
//! ALL already existed on the protocol (`setRepoScripts`, `setRepoAccount`,
//! `setRepoDefaultBranch`, plus `getRepoScripts` / `listRepoBranches` /
//! `listAccounts` to load) — nothing here invents a shape.
//!
//! Presentation follows the existing GTK dialog conventions in `dialogs.rs`
//! rather than a new modal style: an undecorated modal transient `gtk::Window`
//! carrying `.orch-dialog` (gradient + border + layered shadow + the
//! `dialog-pop` entry animation), registered in the same `dialogs::OPEN` stack
//! so the remote-control harness can screenshot and Esc it.
//!
//! ARCHITECTURE: this opens no event pump. It reaches the backend only through
//! `Ctx::call`/`call_typed` (the App owns the single `events()` consumer), per
//! the MPMC work-stealing constraint.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use orchestra_rpc::types::{Account, RepoEntry, RepoScripts};
use serde_json::json;

use crate::ctx::Ctx;
use crate::dialogs;

/// Placeholder text, ported verbatim from RepoScriptsModal.tsx:12-26 so the
/// three editors teach the same env vars and the same idioms as Electron.
const SETUP_PLACEHOLDER: &str = "\
# Runs once after the worktree is created.
# Available env: $ORCHESTRA_PORT, $ORCHESTRA_ROOT_PATH, $ORCHESTRA_WORKSPACE_PATH, $ORCHESTRA_BRANCH

pnpm install
ln -sf \"$ORCHESTRA_ROOT_PATH/.env\" .env";

const RUN_PLACEHOLDER: &str = "\
# Long-running script bound to the workspace's \"Run\" tab.
# Use $ORCHESTRA_PORT so multiple workspaces don't collide.

pnpm dev --port \"$ORCHESTRA_PORT\"";

const ARCHIVE_PLACEHOLDER: &str = "\
# Best-effort cleanup before the worktree is deleted.
# Used to free per-workspace external resources (DB, caches, …).

# dropdb \"myapp_$ORCHESTRA_BRANCH\" 2>/dev/null || true";

/// What the modal loaded, so `save` can tell a CHANGED default branch from an
/// untouched one (Electron tracks the same `initialDefaultBranch` at
/// RepoScriptsModal.tsx:36 and only calls setRepoDefaultBranch on a change —
/// the method is not idempotent-free, it re-points every future worktree).
struct Loaded {
    branches: Vec<String>,
    accounts: Vec<Account>,
    initial_default_branch: String,
}

/// The widgets `save` reads, plus the option→value maps the two DropDowns
/// index into (a GTK DropDown yields a position, not a value).
struct Editors {
    setup: gtk::TextView,
    run: gtk::TextView,
    archive: gtk::TextView,
    branch: gtk::DropDown,
    /// Branch value per DropDown row — parallel to the visible labels, which
    /// may differ ("master (missing locally)").
    branch_values: Vec<String>,
    account: gtk::DropDown,
    /// Account id per DropDown row; index 0 is None ("Default login").
    account_ids: Vec<Option<String>>,
    initial_branch: String,
}

/// Load everything the modal needs. Branch listing is BEST-EFFORT, matching
/// RepoScriptsModal.tsx:50: an unreadable repo still lets the user edit
/// scripts, the picker just falls back to the stored value.
fn load(
    ctx: &Ctx,
    repo_path: &str,
) -> Result<(RepoScripts, Loaded, Option<String>, String), String> {
    let scripts: RepoScripts = ctx.call_typed("getRepoScripts", vec![json!(repo_path)])?;
    let accounts: Vec<Account> = ctx.call_typed("listAccounts", vec![])?;
    let branches: Vec<String> = ctx
        .call_typed("listRepoBranches", vec![json!(repo_path)])
        .unwrap_or_default();
    // Current assignment comes from the repo list, exactly as Electron reads it
    // from the already-loaded store (RepoScriptsModal.tsx:60) instead of adding
    // another round trip.
    let repos: Vec<RepoEntry> = ctx.call_typed("listRepos", vec![])?;
    let repo = repos
        .into_iter()
        .find(|r| r.path == repo_path)
        .ok_or_else(|| format!("no repo {repo_path}"))?;
    Ok((
        scripts,
        Loaded {
            branches,
            accounts,
            initial_default_branch: repo.default_branch.clone(),
        },
        repo.account_id,
        repo.default_branch,
    ))
}

/// A labelled editor: uppercase label + hint above a monospace TextView.
/// Mirrors RepoScriptsModal.tsx's `Field` (:234-257).
fn build_field(
    label: &str,
    hint: &str,
    value: &str,
    placeholder: &str,
) -> (gtk::Box, gtk::TextView) {
    // styles.css:2489 `.field { gap: 5px }` — but the head owns its own 5px
    // bottom margin (:2748), so the outer box stacks with the 12px the
    // `.field { margin-bottom: 12px }` rule (:2489) gives between fields.
    let field = gtk::Box::new(gtk::Orientation::Vertical, 0);
    field.add_css_class("field");

    // styles.css:2744-2749 `.field-head { flex-direction: column; gap: 2px; margin-bottom: 5px }`
    let head = gtk::Box::new(gtk::Orientation::Vertical, 2);
    head.add_css_class("field-head");

    // styles.css:2750-2756 `.field-label`: 11px / 600 / uppercase / .6px tracking.
    // GTK4 has no `text-transform`, so the label is uppercased HERE in Rust and
    // the CSS carries only what GTK actually applies (size/weight/tracking).
    let label_w = gtk::Label::new(Some(&label.to_uppercase()));
    label_w.set_xalign(0.0);
    label_w.add_css_class("field-label");
    head.append(&label_w);

    // styles.css:2757-2763 `.field-hint`: 11.5px, dim, normal weight, wrapping.
    let hint_w = gtk::Label::new(Some(hint));
    hint_w.set_xalign(0.0);
    hint_w.set_wrap(true);
    hint_w.add_css_class("field-hint");
    head.append(&hint_w);
    field.append(&head);

    // styles.css:2764-2776 `.field-textarea`: monospace 12.5px, inset dark fill,
    // 1px border, --radius, 8px/10px padding, min-height 80px, line-height 1.5.
    // A TextView in a ScrolledWindow is the GTK equivalent of <textarea rows=5>.
    let view = gtk::TextView::new();
    view.set_monospace(true);
    view.add_css_class("field-textarea");
    view.set_wrap_mode(gtk::WrapMode::None);
    view.buffer().set_text(value);
    // GTK has no placeholder on TextView; show the hint text greyed when empty
    // by seeding the buffer only when the user has nothing — Electron shows a
    // real placeholder, so we keep the value empty and put the sample in the
    // tooltip instead of faking text the save path would then persist.
    view.set_tooltip_text(Some(placeholder));

    let scroller = gtk::ScrolledWindow::new();
    scroller.set_policy(gtk::PolicyType::Automatic, gtk::PolicyType::Automatic);
    scroller.set_min_content_height(80);
    scroller.set_child(Some(&view));
    scroller.add_css_class("field-textarea-scroll");
    field.append(&scroller);

    (field, view)
}

fn text_of(view: &gtk::TextView) -> String {
    let b = view.buffer();
    b.text(&b.start_iter(), &b.end_iter(), false).to_string()
}

/// Trim, and map "" → None. `RepoScripts` fields are `Option<String>` and
/// Electron sends `undefined` for a blank editor (RepoScriptsModal.tsx:89-91),
/// which CLEARS the script rather than storing an empty string.
fn script_or_none(view: &gtk::TextView) -> Option<String> {
    let t = text_of(view).trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// Open the modal. Resolves when it closes; `true` when a save landed.
pub async fn open(ctx: Rc<Ctx>, repo_path: String, repo_name: String) -> bool {
    let (tx, rx) = async_channel::bounded::<bool>(1);

    let win = gtk::Window::builder()
        .modal(true)
        .transient_for(&ctx.window)
        .resizable(false)
        .decorated(false)
        // styles.css:2689 `.repo-scripts-modal { width: 640px }`.
        .default_width(640)
        .build();
    win.set_widget_name("repo-scripts-modal");
    win.add_css_class("orch-dialog");
    win.add_css_class("repo-scripts-modal");

    // styles.css:2692-2696: the modal is a column and zeroes `.modal`'s 22px
    // pad so the header/footer 1px dividers reach the modal edges.
    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    root.add_css_class("modal-root");

    // ---- header (styles.css:2698-2704) -----------------------------------
    // `display:flex; justify-content:space-between; align-items:flex-start;
    //  padding:18px 22px 12px; border-bottom:1px solid rgba(255,255,255,.06)`
    let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    header.add_css_class("modal-header");
    let titles = gtk::Box::new(gtk::Orientation::Vertical, 0);
    titles.set_hexpand(true);
    // styles.css:2705 `.modal-header h2 { margin:0; font-size:15px }`.
    let title = gtk::Label::new(Some("Workspace scripts"));
    title.set_xalign(0.0);
    title.add_css_class("modal-title");
    title.set_widget_name("repo-scripts-title");
    titles.append(&title);
    // styles.css:2706-2715 `.modal-sub`: 12px dim monospace, ellipsized.
    let sub = gtk::Label::new(Some(&repo_name));
    sub.set_xalign(0.0);
    sub.set_ellipsize(gtk::pango::EllipsizeMode::End);
    sub.set_tooltip_text(Some(&repo_path));
    sub.add_css_class("modal-sub");
    titles.append(&sub);
    header.append(&titles);
    // styles.css:2716-2724 `.modal-close`: transparent, dim, 20px glyph.
    let close = gtk::Button::with_label("\u{00d7}");
    close.set_widget_name("repo-scripts-close");
    close.add_css_class("modal-close");
    close.set_valign(gtk::Align::Start);
    close.set_tooltip_text(Some("Close"));
    header.append(&close);
    root.append(&header);

    // ---- body (styles.css:2726-2730 `padding:16px 22px; overflow:auto`) ---
    // Spacing 0, NOT 12. Electron's `.modal-body` (styles.css:2877) declares no
    // gap at all — inter-field separation comes entirely from
    // `.field { margin-bottom: 12px }` (styles.css:2489), and theme.css already
    // ports that same margin. GTK ADDS box spacing to child margins, so a 12
    // here rendered every gap at 24px instead of 12. Double-counted, and
    // invisible to a CSS-to-CSS diff because the value lives in Rust.
    let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
    body.add_css_class("modal-body");

    // styles.css:2731-2736 `.modal-hint`: 12px dim, 14px bottom margin, 1.5 lh.
    let hint = gtk::Label::new(Some(
        "Runs bash -lc in each new worktree of this repo. $ORCHESTRA_PORT is \
         auto-allocated per workspace so dev servers don't collide.",
    ));
    hint.set_xalign(0.0);
    hint.set_wrap(true);
    hint.add_css_class("modal-hint");
    body.append(&hint);

    let loaded = load(&ctx, &repo_path);
    let error_label = gtk::Label::new(None);
    error_label.set_xalign(0.0);
    error_label.set_wrap(true);
    // styles.css:2781-2789 `.modal-error`: red-tinted fill + border, #ffb4b4.
    error_label.add_css_class("modal-error");
    error_label.set_widget_name("repo-scripts-error");
    error_label.set_visible(false);

    // The three editors + the two pickers only exist on the success path; a
    // load failure shows the error and leaves Save insensitive, mirroring
    // Electron's `loaded` gate (RepoScriptsModal.tsx:224 `disabled={!loaded}`).
    let editors: Option<Editors> = match &loaded {
        Err(e) => {
            error_label.set_text(e);
            error_label.set_visible(true);
            None
        }
        Ok((scripts, meta, account_id, default_branch)) => {
            let (setup_f, setup_v) = build_field(
                "Setup",
                "Runs once after the worktree is created. Failure is non-blocking — \
                     workspace stays put, retry from the workspace toolbar.",
                scripts.setup.as_deref().unwrap_or(""),
                SETUP_PLACEHOLDER,
            );
            setup_v.set_widget_name("repo-scripts-setup");
            body.append(&setup_f);

            let (run_f, run_v) = build_field(
                "Run",
                "Spawned by the workspace's Run tab. Use $ORCHESTRA_PORT for the dev server port.",
                scripts.run.as_deref().unwrap_or(""),
                RUN_PLACEHOLDER,
            );
            run_v.set_widget_name("repo-scripts-run");
            body.append(&run_f);

            let (arch_f, arch_v) = build_field(
                "Archive",
                "Best-effort cleanup before the worktree is deleted.",
                scripts.archive.as_deref().unwrap_or(""),
                ARCHIVE_PLACEHOLDER,
            );
            arch_v.set_widget_name("repo-scripts-archive");
            body.append(&arch_f);

            // ---- default base branch --------------------------------
            // Keep the stored value selectable even when it no longer
            // exists locally or the listing failed (RepoScriptsModal.tsx:185).
            let mut branch_values = meta.branches.clone();
            let mut branch_labels = meta.branches.clone();
            if !default_branch.is_empty() && !branch_values.contains(default_branch) {
                branch_values.insert(0, default_branch.clone());
                branch_labels.insert(0, format!("{default_branch} (missing locally)"));
            }
            let branch_dd = build_select(&branch_labels);
            branch_dd.set_widget_name("repo-scripts-branch");
            if let Some(i) = branch_values.iter().position(|b| b == default_branch) {
                branch_dd.set_selected(i as u32);
            }
            body.append(&labelled_select(
                "Default base branch",
                "The branch new workspaces of this repo are cut from, and the branch the \
                     sidebar sync pill tracks. Right-click a repo's + button to base a single \
                     workspace on a different branch.",
                &branch_dd,
            ));

            // ---- Claude account -------------------------------------
            // Index 0 is "Default login" ⇒ accountId null, matching the
            // empty-string option Electron uses (RepoScriptsModal.tsx:209)
            // and the `Option<&str>` the wire takes.
            let mut acct_labels = vec!["Default login".to_string()];
            let mut acct_ids: Vec<Option<String>> = vec![None];
            for a in &meta.accounts {
                acct_labels.push(a.label.clone());
                acct_ids.push(Some(a.id.clone()));
            }
            let acct_dd = build_select(&acct_labels);
            acct_dd.set_widget_name("repo-scripts-account");
            if let Some(i) = acct_ids
                .iter()
                .position(|id| id.as_deref() == account_id.as_deref())
            {
                acct_dd.set_selected(i as u32);
            }
            body.append(&labelled_select(
                "Claude account",
                "Which Claude account this repo's agents log in as. Orchestra injects the \
                     account's CLAUDE_CONFIG_DIR so the agent runs under that login, and the \
                     workspace badge shows its usage. Manage accounts from the Accounts button.",
                &acct_dd,
            ));

            Some(Editors {
                setup: setup_v,
                run: run_v,
                archive: arch_v,
                branch: branch_dd,
                branch_values,
                account: acct_dd,
                account_ids: acct_ids,
                initial_branch: meta.initial_default_branch.clone(),
            })
        }
    };

    body.append(&error_label);

    let body_scroll = gtk::ScrolledWindow::new();
    body_scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    // styles.css:2693 `max-height: 88vh` — cap so tall content scrolls instead
    // of growing the window past the screen.
    body_scroll.set_propagate_natural_height(true);
    body_scroll.set_max_content_height(760);
    body_scroll.set_vexpand(true);
    body_scroll.set_child(Some(&body));
    root.append(&body_scroll);

    // ---- footer (styles.css:2790-2796) ------------------------------------
    // `justify-content:flex-end; gap:8px; padding:12px 22px 18px;
    //  border-top:1px solid rgba(255,255,255,.06)`
    let footer = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    footer.add_css_class("modal-footer");
    footer.set_halign(gtk::Align::End);
    let cancel = gtk::Button::with_label("Cancel");
    cancel.set_widget_name("repo-scripts-cancel");
    footer.append(&cancel);
    let save = gtk::Button::with_label("Save");
    save.set_widget_name("repo-scripts-save");
    save.add_css_class("primary");
    save.set_sensitive(editors.is_some());
    footer.append(&save);
    root.append(&footer);

    win.set_child(Some(&root));

    // Resolution is idempotent: the capacity-1 channel makes a second send a
    // no-op, exactly like dialogs.rs's `finish` (dialogs.rs:151-165).
    let finish = {
        let tx = tx.clone();
        let win = win.clone();
        move |saved: bool| {
            let _ = tx.try_send(saved);
            win.close();
        }
    };

    {
        let finish = finish.clone();
        cancel.connect_clicked(move |_| finish(false));
    }
    {
        let finish = finish.clone();
        close.connect_clicked(move |_| finish(false));
    }

    if let Some(ed) = editors {
        let Editors {
            setup: setup_v,
            run: run_v,
            archive: arch_v,
            branch: branch_dd,
            branch_values,
            account: acct_dd,
            account_ids: acct_ids,
            initial_branch,
        } = ed;

        // E2E write path. The remote-control `type` op needs a GtkEditable and
        // a TextView is not one (and a headless seat has no keyboard anyway),
        // so the harness sets editor text through this action instead — the
        // same escape hatch `sidebar.drop-ws` uses for pointer-only drag.
        // Param is "<field>|<text>", field ∈ setup|run|archive.
        {
            let scripts_actions = gtk::gio::SimpleActionGroup::new();
            let set = gtk::gio::SimpleAction::new("set", Some(&String::static_variant_type()));
            let (s, r, a) = (setup_v.clone(), run_v.clone(), arch_v.clone());
            set.connect_activate(move |_, param| {
                let Some(raw) = param.and_then(|p| p.str().map(str::to_owned)) else {
                    return;
                };
                let Some((field, text)) = raw.split_once('|') else {
                    return;
                };
                let view = match field {
                    "setup" => &s,
                    "run" => &r,
                    "archive" => &a,
                    _ => return,
                };
                view.buffer().set_text(text);
            });
            scripts_actions.add_action(&set);
            win.insert_action_group("scripts", Some(&scripts_actions));
        }

        let ctx = ctx.clone();
        let repo_path = repo_path.clone();
        let finish = finish.clone();
        let error_label = error_label.clone();
        let save_btn = save.clone();
        let saving = Rc::new(RefCell::new(false));
        save.connect_clicked(move |_| {
            // Re-entrancy guard: the wire calls are synchronous here, but a
            // second click queued behind the first would double-save.
            if *saving.borrow() {
                return;
            }
            *saving.borrow_mut() = true;
            save_btn.set_sensitive(false);
            save_btn.set_label("Saving…");

            let scripts = RepoScripts {
                setup: script_or_none(&setup_v),
                run: script_or_none(&run_v),
                archive: script_or_none(&arch_v),
            };
            let account_id = acct_ids.get(acct_dd.selected() as usize).cloned().flatten();
            let branch = branch_values
                .get(branch_dd.selected() as usize)
                .cloned()
                .unwrap_or_default();

            // Same call ORDER as Electron (RepoScriptsModal.tsx:88-96):
            // scripts, then account, then the base branch only when CHANGED.
            let result = (|| -> Result<(), String> {
                ctx.call(
                    "setRepoScripts",
                    vec![
                        json!(repo_path),
                        serde_json::to_value(&scripts).map_err(|e| e.to_string())?,
                    ],
                )?;
                ctx.call("setRepoAccount", vec![json!(repo_path), json!(account_id)])?;
                if !branch.is_empty() && branch != initial_branch {
                    ctx.call(
                        "setRepoDefaultBranch",
                        vec![json!(repo_path), json!(branch)],
                    )?;
                }
                Ok(())
            })();

            *saving.borrow_mut() = false;
            save_btn.set_sensitive(true);
            save_btn.set_label("Save");

            match result {
                Ok(()) => finish(true),
                Err(e) => {
                    error_label.set_text(&e);
                    error_label.set_visible(true);
                }
            }
        });
    }

    // Esc closes, matching RepoScriptsModal.tsx:78 and the dialogs.rs key
    // controller. Enter deliberately does NOT save: the body is full of
    // multi-line editors where Enter is a newline.
    let keys = gtk::EventControllerKey::new();
    {
        let finish = finish.clone();
        keys.connect_key_pressed(move |_, key, _, _| match key {
            gtk::gdk::Key::Escape => {
                finish(false);
                glib::Propagation::Stop
            }
            _ => glib::Propagation::Proceed,
        });
    }
    win.add_controller(keys);

    // `dlg.cancel` so the remote-control harness's `{"op":"key","name":"Escape"}`
    // path reaches this window too (dialogs.rs:193-206) — under headless sway no
    // real key event ever arrives.
    let actions = gtk::gio::SimpleActionGroup::new();
    let cancel_action = gtk::gio::SimpleAction::new("cancel", None);
    {
        let finish = finish.clone();
        cancel_action.connect_activate(move |_, _| finish(false));
    }
    actions.add_action(&cancel_action);
    win.insert_action_group("dlg", Some(&actions));

    {
        let tx = tx.clone();
        win.connect_close_request(move |w| {
            let _ = tx.try_send(false);
            dialogs::unregister(w);
            glib::Propagation::Proceed
        });
    }

    dialogs::register(&win);
    win.present();

    rx.recv().await.unwrap_or(false)
}

/// A `.field-select`-styled DropDown (styles.css:3468-3491): the GTK stand-in
/// for the custom-chevron `<select>`. GTK draws its own arrow, so the CSS ports
/// the fill/border/radius/padding/size and leaves the chevron to the widget.
fn build_select(labels: &[String]) -> gtk::DropDown {
    let strs: Vec<&str> = labels.iter().map(String::as_str).collect();
    let dd = gtk::DropDown::from_strings(&strs);
    dd.add_css_class("field-select");
    dd
}

/// `.field` wrapper carrying the same head (label + hint) as `build_field`,
/// for the two pickers (RepoScriptsModal.tsx:169-194 / 195-216).
fn labelled_select(label: &str, hint: &str, dd: &gtk::DropDown) -> gtk::Box {
    let field = gtk::Box::new(gtk::Orientation::Vertical, 0);
    field.add_css_class("field");
    let head = gtk::Box::new(gtk::Orientation::Vertical, 2);
    head.add_css_class("field-head");
    let l = gtk::Label::new(Some(&label.to_uppercase()));
    l.set_xalign(0.0);
    l.add_css_class("field-label");
    head.append(&l);
    let h = gtk::Label::new(Some(hint));
    h.set_xalign(0.0);
    h.set_wrap(true);
    h.add_css_class("field-hint");
    head.append(&h);
    field.append(&head);
    field.append(dd);
    field
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_editors_clear_scripts_rather_than_storing_empty_strings() {
        // The wire type skips None, so a cleared editor must send no key at
        // all — an empty string would persist as a script that runs `bash -lc ""`.
        let scripts = RepoScripts {
            setup: Some("pnpm install".into()),
            run: None,
            archive: None,
        };
        let v = serde_json::to_value(&scripts).unwrap();
        assert_eq!(v, json!({ "setup": "pnpm install" }));
        assert!(v.get("run").is_none(), "None must not serialize a key");
    }

    #[test]
    fn scripts_roundtrip_through_the_wire_shape() {
        let v = json!({ "setup": "a", "run": "b", "archive": "c" });
        let s: RepoScripts = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(s.setup.as_deref(), Some("a"));
        assert_eq!(s.run.as_deref(), Some("b"));
        assert_eq!(s.archive.as_deref(), Some("c"));
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }
}
