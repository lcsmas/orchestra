//! The Claude-accounts settings window (`AccountsSettings.tsx` port).
//!
//! CRUD over the account list: label + config-dir template (with a live
//! `~`/`${VAR}` expansion preview under the field), a radio-like scratch-default
//! checkbox, and inheritance checkboxes populated from `listGlobalInheritables`.
//! Save persists via `setAccounts`; a per-row Login button persists first (main
//! needs the account to exist) then opens the login terminal modal for that
//! account through the controller.
//!
//! Unlike the React component this is imperative GTK, so each row keeps its
//! widgets in a [`Row`] struct and we read the live values straight off them at
//! save time — no separate model/patch cycle.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gtk::prelude::*;
use serde_json::{json, Value};

use orchestra_rpc::types::{Account, AccountInherit, GlobalInheritables};

use super::logic::{default_dir_for, expand_config_dir};
use super::AccountsController;

/// One editable account card's widgets. Values are read live at save time.
struct Row {
    id: String,
    root: gtk::Box,
    label: gtk::Entry,
    config_dir: gtk::Entry,
    preview: gtk::Label,
    scratch_default: gtk::CheckButton,
    inherit_settings: gtk::CheckButton,
    inherit_statusline: gtk::CheckButton,
    /// (skill name → checkbox) and (mcp server → checkbox).
    skills: Vec<(String, gtk::CheckButton)>,
    mcp: Vec<(String, gtk::CheckButton)>,
    /// True while the config-dir still tracks the label's auto-suggestion, so
    /// editing the label keeps the suggested dir in sync (TS `update` logic).
    dir_is_auto: Rc<RefCell<bool>>,
}

/// The window's mutable model: the live rows plus what the global config offers.
struct Model {
    rows: RefCell<Vec<Rc<Row>>>,
    inheritables: GlobalInheritables,
    /// Home dir + env for the live config-dir preview.
    home: String,
    env: HashMap<String, String>,
    rows_box: gtk::Box,
    error: gtk::Label,
}

/// Open the accounts settings window for `ctrl`.
pub fn open(ctrl: &Rc<AccountsController>) {
    let window = gtk::Window::builder()
        .modal(true)
        .transient_for(ctrl.main_window())
        .title("Claude accounts")
        .default_width(620)
        .default_height(680)
        .build();
    window.set_widget_name("accounts-settings");
    window.add_css_class("accounts-settings");

    let outer = gtk::Box::new(gtk::Orientation::Vertical, 0);

    // Header.
    let header = gtk::Box::new(gtk::Orientation::Vertical, 2);
    header.add_css_class("modal-header");
    let h = gtk::Label::new(Some("Claude accounts"));
    h.add_css_class("modal-title");
    h.set_xalign(0.0);
    let sub = gtk::Label::new(Some("Usage badges per workspace"));
    sub.add_css_class("modal-sub");
    sub.set_xalign(0.0);
    header.append(&h);
    header.append(&sub);
    outer.append(&header);

    // Scrolling body.
    let body = gtk::Box::new(gtk::Orientation::Vertical, 10);
    body.add_css_class("modal-body");
    let hint = gtk::Label::new(Some(
        "Each account is a separate Claude Code config directory (CLAUDE_CONFIG_DIR) with its \
         own login. Assign an account to a repo; that repo's agents run as that account and the \
         workspace badge shows its rolling 5h / 7d usage. Use Login to authenticate an account's \
         dir (runs `claude /login` there) — the usage endpoint needs the user:profile scope.",
    ));
    hint.add_css_class("modal-hint");
    hint.set_xalign(0.0);
    hint.set_wrap(true);
    body.append(&hint);

    let rows_box = gtk::Box::new(gtk::Orientation::Vertical, 10);
    rows_box.set_widget_name("accounts-rows");
    body.append(&rows_box);

    let add_button = gtk::Button::with_label("+ Add account");
    add_button.set_widget_name("accounts-add");
    add_button.add_css_class("flat");
    add_button.set_halign(gtk::Align::Start);
    body.append(&add_button);

    let error = gtk::Label::new(None);
    error.add_css_class("modal-error");
    error.set_xalign(0.0);
    error.set_wrap(true);
    error.set_visible(false);
    body.append(&error);

    let scroll = gtk::ScrolledWindow::new();
    scroll.set_vexpand(true);
    scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
    scroll.set_child(Some(&body));
    outer.append(&scroll);

    // Footer: Cancel / Save.
    let footer = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    footer.add_css_class("modal-footer");
    footer.set_halign(gtk::Align::End);
    let cancel = gtk::Button::with_label("Cancel");
    cancel.set_widget_name("accounts-cancel");
    let save = gtk::Button::with_label("Save");
    save.set_widget_name("accounts-save");
    save.add_css_class("primary");
    save.add_css_class("suggested");
    footer.append(&cancel);
    footer.append(&save);
    outer.append(&footer);

    window.set_child(Some(&outer));

    // Hydrate: listAccounts + listGlobalInheritables (best-effort).
    let accounts: Vec<Account> = ctrl.call_typed("listAccounts", vec![]).unwrap_or_default();
    let inheritables: GlobalInheritables = ctrl
        .call_typed("listGlobalInheritables", vec![])
        .unwrap_or_default();

    let model = Rc::new(Model {
        rows: RefCell::new(Vec::new()),
        inheritables,
        home: home_dir(),
        env: std::env::vars().collect(),
        rows_box: rows_box.clone(),
        error: error.clone(),
    });

    for a in &accounts {
        let row = build_row(ctrl, &model, Some(a));
        model.rows_box.append(&row.root);
        model.rows.borrow_mut().push(row);
    }

    // Add account: new rows default to inheriting settings + statusline.
    {
        let ctrl = ctrl.clone();
        let model = model.clone();
        add_button.connect_clicked(move |_| {
            let row = build_row(&ctrl, &model, None);
            model.rows_box.append(&row.root);
            model.rows.borrow_mut().push(row);
        });
    }

    {
        let window = window.clone();
        cancel.connect_clicked(move |_| window.close());
    }

    // Save: collect rows, persist, close on success.
    {
        let ctrl = ctrl.clone();
        let model = model.clone();
        let window = window.clone();
        save.connect_clicked(move |_| {
            model.error.set_visible(false);
            match persist(&ctrl, &model) {
                Ok(()) => window.close(),
                Err(e) => {
                    model.error.set_label(&e);
                    model.error.set_visible(true);
                }
            }
        });
    }

    window.present();
}

/// Build one account card (existing `Account` or a fresh row) and wire its
/// live behaviors (dir preview, label→dir sync, scratch-default radio, login).
fn build_row(
    ctrl: &Rc<AccountsController>,
    model: &Rc<Model>,
    account: Option<&Account>,
) -> Rc<Row> {
    let id = account
        .map(|a| a.id.clone())
        .unwrap_or_else(|| format!("acc-{}", AccountsController::now_ms()));

    let root = gtk::Box::new(gtk::Orientation::Vertical, 6);
    root.add_css_class("account-card");
    root.set_widget_name(&format!("account-card-{id}"));

    // Row 1: label + Login + remove.
    let top = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let label = gtk::Entry::new();
    label.set_widget_name("accounts-input-label");
    label.set_placeholder_text(Some("e.g. work"));
    label.set_hexpand(true);
    if let Some(a) = account {
        label.set_text(&a.label);
    }
    let login = gtk::Button::with_label("Login");
    login.set_widget_name("accounts-login");
    login.add_css_class("flat");
    let remove = gtk::Button::with_label("\u{00d7}");
    remove.set_widget_name("accounts-remove");
    remove.add_css_class("flat");
    remove.set_tooltip_text(Some("Remove account"));
    top.append(&label);
    top.append(&login);
    top.append(&remove);
    root.append(&top);

    // Row 2: config dir + preview.
    let dir_label = gtk::Label::new(Some("Config directory"));
    dir_label.add_css_class("account-field-label");
    dir_label.set_xalign(0.0);
    root.append(&dir_label);
    let config_dir = gtk::Entry::new();
    config_dir.set_widget_name("accounts-input-dir");
    config_dir.set_placeholder_text(Some("~/.claude-work"));
    if let Some(a) = account {
        config_dir.set_text(&a.config_dir);
    }
    root.append(&config_dir);
    let preview = gtk::Label::new(None);
    preview.set_widget_name("accounts-dir-preview");
    preview.add_css_class("account-dir-preview");
    preview.set_xalign(0.0);
    preview.set_ellipsize(gtk::pango::EllipsizeMode::Middle);
    root.append(&preview);

    // Scratch-default (radio-like).
    let scratch_default = gtk::CheckButton::with_label("Default for scratch sessions");
    scratch_default.set_widget_name("account-scratch-default");
    scratch_default.set_active(account.and_then(|a| a.scratch_default).unwrap_or(false));
    root.append(&scratch_default);

    // Inherit group.
    let inherit_label = gtk::Label::new(Some("Inherit from global ~/.claude"));
    inherit_label.add_css_class("account-field-label");
    inherit_label.set_xalign(0.0);
    root.append(&inherit_label);
    let inherit = account.and_then(|a| a.inherit.as_ref());
    let inherit_settings = gtk::CheckButton::with_label("settings.json");
    inherit_settings.set_widget_name("account-inherit-settings");
    inherit_settings.set_active(inherit.map_or(account.is_none(), |i| i.settings.unwrap_or(false)));
    let inherit_statusline = gtk::CheckButton::with_label("statusline-command.sh");
    inherit_statusline.set_widget_name("account-inherit-statusline");
    inherit_statusline
        .set_active(inherit.map_or(account.is_none(), |i| i.statusline.unwrap_or(false)));
    root.append(&inherit_settings);
    root.append(&inherit_statusline);

    let inherited_skills: &[String] = inherit.and_then(|i| i.skills.as_deref()).unwrap_or(&[]);
    let inherited_mcp: &[String] = inherit
        .and_then(|i| i.mcp_servers.as_deref())
        .unwrap_or(&[]);

    let skills = build_chip_group(
        &root,
        "Skills",
        "None in ~/.claude/skills",
        &model.inheritables.skills,
        inherited_skills,
    );
    let mcp = build_chip_group(
        &root,
        "MCP servers",
        "None in ~/.claude.json",
        &model.inheritables.mcp_servers,
        inherited_mcp,
    );

    let row = Rc::new(Row {
        id,
        root,
        label,
        config_dir,
        preview,
        scratch_default,
        inherit_settings,
        inherit_statusline,
        skills,
        mcp,
        // A fresh row's empty dir counts as auto (label edits fill it);
        // an existing dir that equals its label's suggestion is still auto.
        dir_is_auto: Rc::new(RefCell::new(match account {
            None => true,
            Some(a) => a.config_dir.is_empty() || a.config_dir == default_dir_for(&a.label),
        })),
    });

    // Live config-dir preview + label→dir sync.
    let update_preview = {
        let model = model.clone();
        let row = row.clone();
        move || {
            let expanded = expand_config_dir(&row.config_dir.text(), &model.home, &model.env);
            if expanded.is_empty() {
                row.preview.set_label("");
            } else {
                row.preview.set_label(&format!("\u{2192} {expanded}"));
            }
        }
    };
    update_preview();

    {
        // Any change to the dir refreshes the preview and, when the text
        // diverges from the label's current suggestion, marks it hand-edited
        // so label edits stop overwriting it (TS: dir stays auto only while it
        // equals defaultDirFor(label) or is empty). Programmatic sync below
        // sets text to exactly that suggestion, so it stays auto.
        let update_preview = update_preview.clone();
        let row = row.clone();
        let config_dir = row.config_dir.clone();
        config_dir.connect_changed(move |entry| {
            let text = entry.text().to_string();
            let is_auto = text.is_empty() || text == default_dir_for(&row.label.text());
            *row.dir_is_auto.borrow_mut() = is_auto;
            update_preview();
        });
    }
    {
        let row = row.clone();
        let label_entry = row.label.clone();
        label_entry.connect_changed(move |entry| {
            if *row.dir_is_auto.borrow() {
                // Setting the text re-enters the dir handler, which re-marks
                // it auto (the new text equals the new suggestion).
                row.config_dir.set_text(&default_dir_for(&entry.text()));
            }
        });
    }

    // Scratch-default is radio-like: checking one row unchecks the others.
    {
        let model = model.clone();
        let this_id = row.id.clone();
        row.scratch_default.connect_toggled(move |btn| {
            if btn.is_active() {
                for other in model.rows.borrow().iter() {
                    if other.id != this_id {
                        other.scratch_default.set_active(false);
                    }
                }
            }
        });
    }

    // Remove.
    {
        let model = model.clone();
        let this_id = row.id.clone();
        remove.connect_clicked(move |_| {
            let mut rows = model.rows.borrow_mut();
            if let Some(pos) = rows.iter().position(|r| r.id == this_id) {
                model.rows_box.remove(&rows[pos].root);
                rows.remove(pos);
            }
        });
    }

    // Login: persist first (so the account exists), then open the terminal.
    {
        let ctrl = ctrl.clone();
        let model = model.clone();
        let row = row.clone();
        login.connect_clicked(move |_| {
            let label_text = row.label.text().trim().to_string();
            if label_text.is_empty() {
                model
                    .error
                    .set_label("Give the account a label before logging in.");
                model.error.set_visible(true);
                return;
            }
            model.error.set_visible(false);
            if let Err(e) = persist(&ctrl, &model) {
                model.error.set_label(&e);
                model.error.set_visible(true);
                return;
            }
            ctrl.clone().open_login_modal(&row.id, &label_text);
        });
    }

    row
}

/// A titled group of inheritance chip-checkboxes (skills / MCP servers).
fn build_chip_group(
    parent: &gtk::Box,
    title: &str,
    empty_note: &str,
    available: &[String],
    checked: &[String],
) -> Vec<(String, gtk::CheckButton)> {
    let group = gtk::Box::new(gtk::Orientation::Vertical, 3);
    group.add_css_class("account-inherit-group");
    let label = gtk::Label::new(Some(title));
    label.add_css_class("account-inherit-group-label");
    label.set_xalign(0.0);
    group.append(&label);

    if available.is_empty() {
        let empty = gtk::Label::new(Some(empty_note));
        empty.add_css_class("account-inherit-empty");
        empty.set_xalign(0.0);
        group.append(&empty);
        parent.append(&group);
        return Vec::new();
    }

    let chips = gtk::FlowBox::new();
    chips.set_selection_mode(gtk::SelectionMode::None);
    chips.set_max_children_per_line(4);
    chips.add_css_class("account-inherit-chips");
    let mut out = Vec::with_capacity(available.len());
    for name in available {
        let check = gtk::CheckButton::with_label(name);
        check.add_css_class("account-inherit-chip");
        check.set_active(checked.iter().any(|c| c == name));
        chips.insert(&check, -1);
        out.push((name.clone(), check));
    }
    group.append(&chips);
    parent.append(&group);
    out
}

/// Collect the live rows into `Account`s (dropping label-less rows), then
/// `setAccounts`. Mirrors `AccountsSettings.persist`.
fn persist(ctrl: &Rc<AccountsController>, model: &Rc<Model>) -> Result<(), String> {
    let accounts: Vec<Value> = model
        .rows
        .borrow()
        .iter()
        .filter_map(|r| account_json(r))
        .collect();
    // setAccounts returns the saved list; we don't re-hydrate rows here (the
    // window closes on Save), but a Login persist keeps them as-is.
    ctrl.call_unit("setAccounts", vec![Value::Array(accounts)])
}

/// Build the wire JSON for one row, or None if it has no label (filtered out,
/// like the TS `.filter((r) => r.label)`).
fn account_json(row: &Row) -> Option<Value> {
    let label = row.label.text().trim().to_string();
    if label.is_empty() {
        return None;
    }
    let config_dir = row.config_dir.text().trim().to_string();
    let inherit = inherit_from_row(row);
    let mut obj = json!({
        "id": row.id,
        "label": label,
        "configDir": config_dir,
    });
    let map = obj.as_object_mut().unwrap();
    if row.scratch_default.is_active() {
        map.insert("scratchDefault".into(), Value::Bool(true));
    }
    if let Some(inherit) = inherit {
        map.insert(
            "inherit".into(),
            serde_json::to_value(inherit).expect("AccountInherit serializes"),
        );
    }
    Some(obj)
}

/// Assemble the (possibly-`None`) inherit spec from a row's checkboxes.
fn inherit_from_row(row: &Row) -> Option<AccountInherit> {
    let skills: Vec<String> = row
        .skills
        .iter()
        .filter(|(_, c)| c.is_active())
        .map(|(n, _)| n.clone())
        .collect();
    let mcp: Vec<String> = row
        .mcp
        .iter()
        .filter(|(_, c)| c.is_active())
        .map(|(n, _)| n.clone())
        .collect();
    let settings = row.inherit_settings.is_active();
    let statusline = row.inherit_statusline.is_active();
    if !settings && !statusline && skills.is_empty() && mcp.is_empty() {
        return None;
    }
    Some(AccountInherit {
        settings: settings.then_some(true),
        statusline: statusline.then_some(true),
        skills: (!skills.is_empty()).then_some(skills),
        mcp_servers: (!mcp.is_empty()).then_some(mcp),
    })
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}
