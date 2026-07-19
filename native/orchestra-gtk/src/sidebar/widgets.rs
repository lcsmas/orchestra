//! Widget construction for the sidebar row list: one [`Row`] spec → one
//! `gtk::ListBoxRow`. Pure build functions — all interaction routes through
//! the component's `Sender<Msg>`; no state lives in the widgets themselves,
//! so the list can be rebuilt from specs at any time.
//!
//! Iconography is deliberately glyph-based (no SVG assets): behavioral parity
//! is the gate (plan §0), and text glyphs render identically under headless
//! CI. Every actionable widget carries a `widget_name` for the
//! remote-control harness.

use gtk::gdk;
use gtk::glib;
use gtk::pango;
use gtk::prelude::*;
use relm4::Sender;

use orchestra_rpc::types::{PrState, RepoSyncState, SetupStatus, WorkspaceStatus};

use super::pills::{format_bytes, format_tokens, size_title};
use super::rows::{
    ArchivedBarSpec, ArchivedRowSpec, HostHeaderSpec, RepoHeaderSpec, Row, SectionKind,
    TreeVariant, WsRowSpec,
};
use super::Msg;

fn status_css(status: WorkspaceStatus) -> &'static str {
    match status {
        WorkspaceStatus::Idle => "idle",
        WorkspaceStatus::Running => "running",
        WorkspaceStatus::Waiting => "waiting",
        WorkspaceStatus::Error => "error",
        WorkspaceStatus::Stopped => "stopped",
    }
}

fn label(text: &str, classes: &[&str]) -> gtk::Label {
    let l = gtk::Label::new(Some(text));
    l.set_xalign(0.0);
    for c in classes {
        l.add_css_class(c);
    }
    l
}

fn ellipsized(text: &str, classes: &[&str]) -> gtk::Label {
    let l = label(text, classes);
    l.set_ellipsize(pango::EllipsizeMode::End);
    l
}

/// Small glyph action button (the `.ws-icon-btn` strip).
fn icon_button(
    glyph: &str,
    name: &str,
    tooltip: &str,
    classes: &[&str],
    sender: &Sender<Msg>,
    msg: impl Fn() -> Msg + 'static,
) -> gtk::Button {
    let b = gtk::Button::with_label(glyph);
    b.set_widget_name(name);
    b.add_css_class("ws-icon-btn");
    for c in classes {
        b.add_css_class(c);
    }
    b.set_tooltip_text(Some(tooltip));
    b.set_valign(gtk::Align::Center);
    let sender = sender.clone();
    b.connect_clicked(move |_| sender.emit(msg()));
    b
}

fn pill(text: &str, name_class: &str, tooltip: &str) -> gtk::Label {
    let p = label(text, &["pill", name_class]);
    p.set_tooltip_text(Some(tooltip));
    p.set_valign(gtk::Align::Center);
    p
}

/// Clickable pill (PR / Linear badges, setup-failed focus).
fn pill_button(
    text: &str,
    classes: &[&str],
    tooltip: &str,
    sender: &Sender<Msg>,
    msg: impl Fn() -> Msg + 'static,
) -> gtk::Button {
    let b = gtk::Button::with_label(text);
    b.add_css_class("pill");
    b.add_css_class("pill-btn");
    for c in classes {
        b.add_css_class(c);
    }
    b.set_tooltip_text(Some(tooltip));
    b.set_valign(gtk::Align::Center);
    let sender = sender.clone();
    b.connect_clicked(move |_| sender.emit(msg()));
    b
}

fn non_selectable(row: &gtk::ListBoxRow) {
    row.set_selectable(false);
    row.set_activatable(false);
}

/// Attach a workspace-drag source ("ws:<id>") or repo-drag source
/// ("repo:<path>") plus the row-level drop target that computes before/after
/// from pointer y and reports the drop.
fn wire_dnd(
    row: &gtk::ListBoxRow,
    payload: String,
    accepts: &'static str,
    sender: &Sender<Msg>,
    on_drop: impl Fn(String, bool) -> Msg + 'static,
) {
    let source = gtk::DragSource::new();
    source.set_actions(gdk::DragAction::MOVE);
    {
        let payload = payload.clone();
        source.connect_prepare(move |_, _, _| {
            Some(gdk::ContentProvider::for_value(&payload.to_value()))
        });
    }
    {
        let row = row.clone();
        source.connect_drag_begin(move |_, _| row.add_css_class("dragging"));
    }
    {
        let row = row.clone();
        source.connect_drag_end(move |_, _, _| row.remove_css_class("dragging"));
    }
    row.add_controller(source);

    let target = gtk::DropTarget::new(glib::types::Type::STRING, gdk::DragAction::MOVE);
    {
        let row = row.clone();
        let self_payload = payload.clone();
        target.connect_motion(move |t, _x, y| {
            let Some(value) = t.value_as::<String>() else {
                return gdk::DragAction::empty();
            };
            if !value.starts_with(accepts) || value == self_payload {
                return gdk::DragAction::empty();
            }
            let before = y < row.height() as f64 / 2.0;
            row.remove_css_class(if before { "drop-after" } else { "drop-before" });
            row.add_css_class(if before { "drop-before" } else { "drop-after" });
            gdk::DragAction::MOVE
        });
    }
    {
        let row = row.clone();
        target.connect_leave(move |_| {
            row.remove_css_class("drop-before");
            row.remove_css_class("drop-after");
        });
    }
    {
        let row = row.clone();
        let sender = sender.clone();
        target.connect_drop(move |_, value, _x, y| {
            row.remove_css_class("drop-before");
            row.remove_css_class("drop-after");
            let Ok(dragged) = value.get::<String>() else {
                return false;
            };
            if !dragged.starts_with(accepts) {
                return false;
            }
            let dragged = dragged[accepts.len()..].to_string();
            let before = y < row.height() as f64 / 2.0;
            sender.emit(on_drop(dragged, before));
            true
        });
    }
    row.add_controller(target);
}

pub fn build_row(spec: &Row, sender: &Sender<Msg>) -> gtk::ListBoxRow {
    match spec {
        Row::EmptyHint => build_empty_hint(),
        Row::SectionHeader { kind, count } => build_section_header(kind, *count, sender),
        Row::RepoHeader(s) => build_repo_header(s, sender),
        Row::RepoSync(s) => build_repo_sync(s, sender),
        Row::HostHeader(s) => build_host_header(s, sender),
        Row::Workspace(s) => build_ws_row(s, sender),
        Row::ArchivedToggle { count, open } => build_archived_toggle(*count, *open, sender),
        Row::ArchivedBar(s) => build_archived_bar(s, sender),
        Row::Archived(s) => build_archived_row(s, sender),
    }
}

fn build_empty_hint() -> gtk::ListBoxRow {
    let l = label(
        "No agents running. Click ⚡ Scratch for a quick throwaway session, or + Repo to map a git repo.",
        &["ws-empty-hint"],
    );
    l.set_wrap(true);
    let row = gtk::ListBoxRow::new();
    row.set_widget_name("ws-empty-hint");
    row.set_child(Some(&l));
    non_selectable(&row);
    row
}

fn build_section_header(kind: &SectionKind, count: usize, sender: &Sender<Msg>) -> gtk::ListBoxRow {
    let (glyph, title, add_name, add_tip, msg): (_, _, _, _, fn() -> Msg) = match kind {
        SectionKind::Orchestrators => (
            "🌿",
            "Orchestrators",
            "section-add-orchestrator",
            "New orchestrator",
            || Msg::NewOrchestrator,
        ),
        SectionKind::Scratch => (
            "⚡",
            "Scratch",
            "section-add-scratch",
            "New scratch session",
            || Msg::NewScratch,
        ),
    };
    let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    hbox.add_css_class("repo-header");
    hbox.append(&label(glyph, &["scratch-glyph"]));
    let name = label(title, &["repo-name"]);
    name.set_hexpand(true);
    hbox.append(&name);
    // Section count badge = ROOT count, not row count (ledger).
    hbox.append(&pill(&count.to_string(), "repo-count", "Sessions"));
    let add = icon_button("+", add_name, add_tip, &["repo-add"], sender, msg);
    hbox.append(&add);

    let row = gtk::ListBoxRow::new();
    row.set_widget_name(&format!("section-{}", title.to_lowercase()));
    row.set_child(Some(&hbox));
    non_selectable(&row);
    row.add_css_class("section-header-row");
    row
}

fn build_repo_header(s: &RepoHeaderSpec, sender: &Sender<Msg>) -> gtk::ListBoxRow {
    let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    hbox.add_css_class("repo-header");
    hbox.set_tooltip_text(Some(&s.repo_path));

    // Collapse toggle: caret + repo name (one button, like the Electron DOM).
    let collapse = gtk::Button::new();
    collapse.set_widget_name(&format!("repo-collapse-{}", s.label));
    collapse.add_css_class("repo-collapse");
    let cbox = gtk::Box::new(gtk::Orientation::Horizontal, 5);
    cbox.append(&label(if s.collapsed { "▸" } else { "▾" }, &["caret"]));
    cbox.append(&ellipsized(&s.label, &["repo-name"]));
    if let Some(account) = &s.account_id {
        cbox.append(&label("·", &["ws-context-sep"]));
        let acc = label(account, &["ws-login-badge"]);
        acc.set_tooltip_text(Some("Account this repo's agents log in as"));
        cbox.append(&acc);
    }
    collapse.set_child(Some(&cbox));
    {
        let sender = sender.clone();
        let path = s.repo_path.clone();
        collapse.connect_clicked(move |_| sender.emit(Msg::ToggleRepoCollapsed(path.clone())));
    }
    collapse.set_hexpand(true);
    collapse.set_halign(gtk::Align::Start);
    hbox.append(&collapse);

    let actions = gtk::Box::new(gtk::Orientation::Horizontal, 2);
    actions.add_css_class("repo-header-actions");
    actions.append(&pill(
        &s.count.to_string(),
        "repo-count",
        "Active workspaces (incl. spawned children)",
    ));
    if let Some(url) = &s.remote_url {
        let url = url.clone();
        actions.append(&icon_button(
            "↗",
            &format!("repo-github-{}", s.label),
            &format!("Open {} on GitHub", s.label),
            &["repo-scripts-btn"],
            sender,
            move || Msg::OpenExternal(url.clone()),
        ));
    }
    {
        let path = s.repo_path.clone();
        actions.append(&icon_button(
            "⚙",
            &format!("repo-scripts-{}", s.label),
            &format!("Configure setup / run / archive scripts for {}", s.label),
            &["repo-scripts-btn"],
            sender,
            move || Msg::OpenRepoScripts(path.clone()),
        ));
    }
    if s.can_remove {
        let path = s.repo_path.clone();
        actions.append(&icon_button(
            "✕",
            &format!("repo-remove-{}", s.label),
            &format!(
                "Remove {} from Orchestra (your git repo is left untouched)",
                s.label
            ),
            &["repo-scripts-btn", "danger"],
            sender,
            move || Msg::RemoveRepo(path.clone()),
        ));
    }
    // "+" new workspace: left-click default base; right-click → base-branch
    // popover fed by listRepoBranches.
    let add = gtk::Button::with_label("+");
    add.set_widget_name(&format!("repo-add-{}", s.label));
    add.add_css_class("repo-add");
    add.set_tooltip_text(Some(&format!(
        "New workspace in {} — right-click to pick the base branch",
        s.label
    )));
    {
        let sender = sender.clone();
        let path = s.repo_path.clone();
        add.connect_clicked(move |_| {
            sender.emit(Msg::AddToRepo {
                repo_path: path.clone(),
                base_branch: None,
            })
        });
    }
    {
        let right = gtk::GestureClick::new();
        right.set_button(3);
        let sender = sender.clone();
        let path = s.repo_path.clone();
        let label_ = s.label.clone();
        let add_ = add.clone();
        right.connect_pressed(move |_, _, _, _| {
            sender.emit(Msg::OpenBasePicker {
                repo_path: path.clone(),
                repo_name: label_.clone(),
                anchor: add_.clone().upcast(),
            });
        });
        add.add_controller(right);
    }
    actions.append(&add);
    hbox.append(&actions);

    let row = gtk::ListBoxRow::new();
    row.set_widget_name(&format!("repo-row-{}", s.label));
    row.set_child(Some(&hbox));
    non_selectable(&row);
    row.add_css_class("repo-header-row");
    // Only registered repos reorder (orphan sections trail, not draggable).
    if s.registered {
        let path = s.repo_path.clone();
        wire_dnd(
            &row,
            format!("repo:{}", s.repo_path),
            "repo:",
            sender,
            move |dragged, before| Msg::DropRepo {
                dragged,
                target: path.clone(),
                before,
            },
        );
    }
    row
}

fn build_repo_sync(s: &RepoSyncState, sender: &Sender<Msg>) -> gtk::ListBoxRow {
    let b = gtk::Button::new();
    b.set_widget_name(&format!("repo-sync-{}", s.repo_path));
    b.add_css_class("repo-sync");
    if s.syncing {
        b.add_css_class("syncing");
    }
    if s.error.is_some() {
        b.add_css_class("error");
    }
    b.set_tooltip_text(Some(&match (&s.error, s.synced_at) {
        (Some(e), _) => format!("Last fetch failed: {e}"),
        (None, 0) => "Not yet synced".to_string(),
        (None, t) => {
            let secs_ago = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(t)
                - t)
                / 1000;
            format!("Last synced {}m ago — click to fetch", secs_ago.max(0) / 60)
        }
    }));
    let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    hbox.append(&label(&s.base_branch, &["repo-sync-base"]));
    if !s.has_upstream {
        hbox.append(&label("no upstream", &["repo-sync-status", "muted"]));
    } else if s.behind == 0 && s.ahead == 0 {
        hbox.append(&label("up to date", &["repo-sync-status", "muted"]));
    } else {
        let st = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        st.add_css_class("repo-sync-status");
        if s.behind > 0 {
            st.append(&label(&format!("↓{}", s.behind), &["behind"]));
        }
        if s.ahead > 0 {
            st.append(&label(&format!("↑{}", s.ahead), &["ahead"]));
        }
        hbox.append(&st);
    }
    if s.syncing {
        let spin = gtk::Spinner::new();
        spin.start();
        hbox.append(&spin);
    }
    b.set_child(Some(&hbox));
    {
        let sender = sender.clone();
        let path = s.repo_path.clone();
        let syncing = s.syncing;
        b.connect_clicked(move |_| {
            if !syncing {
                sender.emit(Msg::SyncRepoBase(path.clone()));
            }
        });
    }
    let row = gtk::ListBoxRow::new();
    row.set_widget_name(&format!("repo-sync-row-{}", s.repo_path));
    row.set_child(Some(&b));
    non_selectable(&row);
    row.add_css_class("repo-sync-row");
    row
}

fn build_host_header(s: &HostHeaderSpec, sender: &Sender<Msg>) -> gtk::ListBoxRow {
    let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    hbox.add_css_class("host-group-header");
    let collapse = gtk::Button::new();
    collapse.set_widget_name(&format!("host-collapse-{}", s.host_id));
    collapse.add_css_class("host-collapse");
    let cbox = gtk::Box::new(gtk::Orientation::Horizontal, 5);
    cbox.append(&label(if s.collapsed { "▸" } else { "▾" }, &["caret"]));
    let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    dot.add_css_class("host-dot");
    dot.add_css_class(if s.remote { "remote" } else { "local" });
    dot.set_valign(gtk::Align::Center);
    cbox.append(&dot);
    let name = ellipsized(&s.label, &["host-name"]);
    name.set_tooltip_text(Some(if s.remote {
        &s.label
    } else {
        "Runs on this computer"
    }));
    cbox.append(&name);
    collapse.set_child(Some(&cbox));
    {
        let sender = sender.clone();
        let id = s.host_id.clone();
        collapse.connect_clicked(move |_| sender.emit(Msg::ToggleHostCollapsed(id.clone())));
    }
    collapse.set_hexpand(true);
    collapse.set_halign(gtk::Align::Start);
    hbox.append(&collapse);
    hbox.append(&pill(
        &s.count.to_string(),
        "host-count",
        "Workspaces on this node",
    ));

    let row = gtk::ListBoxRow::new();
    row.set_widget_name(&format!("host-row-{}", s.host_id));
    row.set_child(Some(&hbox));
    non_selectable(&row);
    row.add_css_class("host-header-row");
    row
}

fn dot_tooltip(s: &WsRowSpec) -> String {
    if s.ws.marked_unread == Some(true) {
        return "Tagged unread — come back to this workspace".into();
    }
    match s.ws.status {
        WorkspaceStatus::Running => match &s.tool {
            // Live tool label (`agent:tool`) rides the dot tooltip.
            Some(tool) => format!("Agent is working… ({tool})"),
            None => "Agent is working…".into(),
        },
        WorkspaceStatus::Idle => "Agent is idle".into(),
        WorkspaceStatus::Waiting => "waiting".into(),
        WorkspaceStatus::Error => "error".into(),
        WorkspaceStatus::Stopped => "stopped".into(),
    }
}

fn append_pills(strip: &gtk::Box, s: &WsRowSpec, sender: &Sender<Msg>) {
    let p = &s.pills;
    if p.cross_repo_child {
        strip.append(&pill(
            &s.repo_label,
            "repo-tag-pill",
            &format!(
                "Spawned into {} (different repo than its orchestrator)",
                s.repo_label
            ),
        ));
    }
    if p.merged {
        strip.append(&pill(
            "merged",
            "merged-pill",
            &format!("Merged into {}", s.ws.base_branch),
        ));
    }
    if let Some(versions) = &p.released {
        if versions.is_empty() {
            strip.append(&pill(
                "released",
                "released-pill",
                "Shipped in a published release",
            ));
        } else {
            for v in versions {
                strip.append(&pill(
                    v,
                    "released-pill",
                    &format!("Shipped in release {v}"),
                ));
            }
        }
    }
    if let Some(n) = p.unpushed {
        strip.append(&pill(
            &format!("↑{n}"),
            "unpushed-pill",
            &format!(
                "{n} commit{} not yet on origin — ready to push",
                if n == 1 { "" } else { "s" }
            ),
        ));
    }
    if let Some(d) = &p.diff {
        let di = gtk::Box::new(gtk::Orientation::Horizontal, 3);
        di.add_css_class("pill");
        di.add_css_class("diff-indicator");
        di.set_tooltip_text(Some(&format!(
            "{} file{} changed",
            d.files,
            if d.files == 1 { "" } else { "s" }
        )));
        if d.additions > 0 {
            di.append(&label(&format!("+{}", d.additions), &["add"]));
        }
        if d.deletions > 0 {
            di.append(&label(&format!("−{}", d.deletions), &["del"]));
        }
        di.set_valign(gtk::Align::Center);
        strip.append(&di);
    }
    match p.setup {
        Some(SetupStatus::Failed) => {
            let id = s.ws.id.clone();
            strip.append(&pill_button(
                "setup",
                &["setup-pill", "failed"],
                &format!(
                    "Setup script failed: {}",
                    s.ws.setup_error.as_deref().unwrap_or("see log")
                ),
                sender,
                move || Msg::Select(id.clone()),
            ));
        }
        Some(SetupStatus::Running) => {
            strip.append(&pill("setup…", "setup-pill", "Setup script running"));
        }
        _ => {}
    }
    if let Some(issue) = &p.linear {
        let url = issue.url.clone();
        strip.append(&pill_button(
            &format!("◈ {}", issue.identifier),
            &["pr-badge", "linear"],
            &format!(
                "Linear {}: {} — open in Linear",
                issue.identifier, issue.title
            ),
            sender,
            move || Msg::OpenExternal(url.clone()),
        ));
    }
    for pr in &p.prs_visible {
        let (glyph, cls) = match pr.state {
            PrState::Open => ("⎇", "open"),
            PrState::Merged => ("⌥", "merged"),
            PrState::Closed => ("✕", "closed"),
        };
        let url = pr.url.clone();
        strip.append(&pill_button(
            &format!("{glyph} #{}", pr.number),
            &["pr-badge", cls],
            &format!(
                "PR #{} · {} · {}",
                pr.number,
                format!("{:?}", pr.state).to_lowercase(),
                pr.title
            ),
            sender,
            move || Msg::OpenExternal(url.clone()),
        ));
    }
    if p.prs_hidden > 0 {
        strip.append(&pill(
            &format!("+{}", p.prs_hidden),
            "pr-badge",
            &format!(
                "{} more PR{} from this branch",
                p.prs_hidden,
                if p.prs_hidden == 1 { "" } else { "s" }
            ),
        ));
    }
    if let (Some(bytes), true) = (p.size, p.size_in_strip) {
        strip.append(&pill(
            &format_bytes(bytes),
            "ws-size",
            size_title(s.sizes_exclusive),
        ));
    }
}

fn build_ws_row(s: &WsRowSpec, sender: &Sender<Msg>) -> gtk::ListBoxRow {
    let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    hbox.add_css_class("ws-item");

    // Tree indentation + connector for spawned children.
    if s.depth > 0 {
        let indent = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        indent.set_width_request((s.depth as i32 - 1) * 16);
        hbox.append(&indent);
        hbox.append(&label("╰─", &["ws-tree-connector"]));
    }

    // Subtree collapse caret (pinned tree sections only).
    if s.tree.is_some() {
        if s.collapsible {
            let caret = gtk::Button::with_label(if s.collapsed { "▸" } else { "▾" });
            caret.set_widget_name(&format!("ws-collapse-{}", s.ws.id));
            caret.add_css_class("ws-collapse");
            caret.set_tooltip_text(Some(&if s.collapsed {
                format!(
                    "Show {} spawned agent{}",
                    s.hidden_count,
                    if s.hidden_count == 1 { "" } else { "s" }
                )
            } else {
                "Hide spawned agents".to_string()
            }));
            let sender_ = sender.clone();
            let id = s.ws.id.clone();
            caret.connect_clicked(move |_| sender_.emit(Msg::ToggleSubtreeCollapsed(id.clone())));
            hbox.append(&caret);
        } else {
            let spacer = gtk::Box::new(gtk::Orientation::Horizontal, 0);
            spacer.add_css_class("ws-collapse-spacer");
            hbox.append(&spacer);
        }
    }

    // Status dot: status color + glow, accent-blue unread override, live tool
    // label + the rest of the status vocabulary in the tooltip.
    let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    dot.add_css_class("ws-dot");
    dot.add_css_class(status_css(s.ws.status));
    if s.ws.marked_unread == Some(true) {
        dot.add_css_class("unread");
    }
    dot.set_valign(gtk::Align::Center);
    dot.set_tooltip_text(Some(&dot_tooltip(s)));
    hbox.append(&dot);

    // Body: name row (+ optional pill strip on repo rows).
    let body = gtk::Box::new(gtk::Orientation::Vertical, 2);
    body.add_css_class("ws-body");
    body.set_hexpand(true);
    let name_row = gtk::Box::new(gtk::Orientation::Horizontal, 5);
    name_row.add_css_class("ws-name-row");

    if s.renaming {
        // Inline branch rename (with `branchManuallySet` pinning backend-side).
        let entry = gtk::Entry::new();
        entry.set_text(&s.ws.branch);
        entry.set_widget_name("ws-rename-entry");
        entry.add_css_class("ws-name-input");
        entry.set_hexpand(true);
        {
            let sender = sender.clone();
            let id = s.ws.id.clone();
            entry.connect_activate(move |e| {
                sender.emit(Msg::CommitRename {
                    id: id.clone(),
                    branch: e.text().to_string(),
                });
            });
        }
        {
            let sender = sender.clone();
            let key = gtk::EventControllerKey::new();
            key.connect_key_pressed(move |_, k, _, _| {
                if k == gdk::Key::Escape {
                    sender.emit(Msg::CancelRename);
                    glib::Propagation::Stop
                } else {
                    glib::Propagation::Proceed
                }
            });
            entry.add_controller(key);
        }
        {
            // Blur commits, like the Electron input.
            let sender = sender.clone();
            let id = s.ws.id.clone();
            let focus = gtk::EventControllerFocus::new();
            let entry_ = entry.clone();
            focus.connect_leave(move |_| {
                sender.emit(Msg::CommitRename {
                    id: id.clone(),
                    branch: entry_.text().to_string(),
                });
            });
            entry.add_controller(focus);
        }
        name_row.append(&entry);
    } else {
        let name = ellipsized(&s.ws.branch, &["ws-name"]);
        if s.ws.marked_unread == Some(true) {
            name.add_css_class("unread");
        }
        name.set_hexpand(false);
        let title = match (s.tree, s.depth) {
            (Some(TreeVariant::Orchestrator), 0) => {
                format!("{} — orchestrator · double-click to rename", s.ws.branch)
            }
            (Some(TreeVariant::Scratch), 0) => format!(
                "{} — scratch session (not tracked by git) · double-click to rename",
                s.ws.branch
            ),
            (Some(v), _) => format!(
                "{} — spawned by this {} · double-click to rename",
                s.ws.branch,
                v.root_noun()
            ),
            (None, _) => {
                if s.ws.branch_manually_set == Some(true) {
                    format!("{} (locked)", s.ws.branch)
                } else {
                    format!("{} — double-click to rename", s.ws.branch)
                }
            }
        };
        name.set_tooltip_text(Some(&title));
        let dbl = gtk::GestureClick::new();
        {
            let sender = sender.clone();
            let id = s.ws.id.clone();
            dbl.connect_pressed(move |g, n, _, _| {
                if n == 2 {
                    g.set_state(gtk::EventSequenceState::Claimed);
                    sender.emit(Msg::StartRename(id.clone()));
                }
            });
        }
        name.add_controller(dbl);
        name_row.append(&name);
    }

    // Hidden-descendant count pill, tinted by most-urgent hidden status.
    if s.collapsed && s.hidden_count > 0 {
        let classes: Vec<&str> = match s.hidden_urgency {
            Some(u) => vec!["ws-hidden-count", u.css_class()],
            None => vec!["ws-hidden-count"],
        };
        let hidden = label(&s.hidden_count.to_string(), &classes);
        hidden.set_tooltip_text(Some(&format!(
            "{} hidden agent{}: {}",
            s.hidden_count,
            if s.hidden_count == 1 { "" } else { "s" },
            s.hidden_names
        )));
        hidden.set_valign(gtk::Align::Center);
        name_row.append(&hidden);
    }

    // Context badge (`agent:context`; 0-sentinel resets upstream).
    if let Some(tokens) = s.context_tokens {
        let ctx = label(&format!("· {}", format_tokens(tokens)), &["ws-context"]);
        ctx.set_tooltip_text(Some(&format!("Context size: {tokens} tokens")));
        ctx.set_valign(gtk::Align::Center);
        name_row.append(&ctx);
    }

    // Account badge → migrate menu (content §5.4; the affordance is ours).
    let account = gtk::Button::with_label(s.ws.account_id.as_deref().unwrap_or("default"));
    account.set_widget_name(&format!("ws-account-{}", s.ws.id));
    account.add_css_class("ws-login-badge");
    account.set_tooltip_text(Some("Claude login this agent uses — click to migrate"));
    account.set_valign(gtk::Align::Center);
    {
        let sender_ = sender.clone();
        let id = s.ws.id.clone();
        let account_id = s.ws.account_id.clone();
        account.connect_clicked(move |b| {
            sender_.emit(Msg::OpenAccountMenu {
                ws_id: id.clone(),
                current: account_id.clone(),
                anchor: b.clone().upcast(),
            });
        });
    }
    name_row.append(&account);

    // Inline size badge (no pills to ride along with).
    if let (Some(bytes), false) = (s.pills.size, s.pills.size_in_strip) {
        name_row.append(&pill(
            &format_bytes(bytes),
            "ws-size",
            size_title(s.sizes_exclusive),
        ));
    }

    body.append(&name_row);

    // Pill strip: repo rows get the full zoo; tree git children get the repo
    // tag + PR/Linear mini strip (matching the Electron layouts).
    let is_tree = s.tree.is_some();
    if !is_tree && s.pills.any() {
        let strip = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        strip.add_css_class("ws-pills");
        append_pills(&strip, s, sender);
        body.append(&strip);
    } else if is_tree && s.child_is_git {
        let strip = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        strip.add_css_class("ws-pills");
        strip.add_css_class("mini");
        strip.append(&pill(
            &s.repo_label,
            "repo-tag-pill",
            &format!("Spawned into {}", s.repo_label),
        ));
        // PR / Linear badges only in the mini strip.
        let mini = WsRowSpec {
            pills: super::pills::RowPills {
                merged: false,
                released: None,
                unpushed: None,
                diff: None,
                setup: None,
                size: None,
                size_in_strip: false,
                cross_repo_child: false,
                ..s.pills.clone()
            },
            ..s.clone()
        };
        append_pills(&strip, &mini, sender);
        body.append(&strip);
    }
    hbox.append(&body);

    // Action strip (hover-revealed via CSS).
    if s.deleting {
        let spin = gtk::Spinner::new();
        spin.start();
        spin.set_tooltip_text(Some("Removing…"));
        hbox.append(&spin);
    } else {
        let unread_on = s.ws.marked_unread == Some(true);
        let id = s.ws.id.clone();
        let toggle = icon_button(
            if unread_on { "⚑" } else { "⚐" },
            &format!("ws-unread-{}", s.ws.id),
            if unread_on {
                "Clear the unread tag"
            } else {
                "Tag as unread — leave a come-back-to-this-later marker"
            },
            if unread_on { &["unread-on"] } else { &[] },
            sender,
            move || Msg::ToggleUnread(id.clone()),
        );
        hbox.append(&toggle);

        let scratch_like = s.ws.is_scratch_like();
        if !is_tree {
            // Repo rows: sandbox import/eject by ws.host, then archive.
            if s.ws.host.is_none() {
                let id = s.ws.id.clone();
                let name = s.ws.name.clone();
                hbox.append(&icon_button(
                    "☁↑",
                    &format!("ws-sandbox-import-{}", s.ws.id),
                    "Import to sandbox — move this workspace into an always-on sandbox container",
                    &[],
                    sender,
                    move || Msg::ImportToSandbox {
                        id: id.clone(),
                        name: name.clone(),
                    },
                ));
            } else {
                let id = s.ws.id.clone();
                let name = s.ws.name.clone();
                hbox.append(&icon_button(
                    "☁↓",
                    &format!("ws-sandbox-eject-{}", s.ws.id),
                    "Return to this machine — restore the workspace from its sandbox to a local worktree",
                    &[],
                    sender,
                    move || Msg::EjectFromSandbox {
                        id: id.clone(),
                        name: name.clone(),
                    },
                ));
            }
        }
        if !scratch_like {
            let id = s.ws.id.clone();
            let name = s.ws.name.clone();
            hbox.append(&icon_button(
                "🗄",
                &format!("ws-archive-{}", s.ws.id),
                "Archive workspace",
                &[],
                sender,
                move || Msg::Archive {
                    id: id.clone(),
                    name: name.clone(),
                },
            ));
        } else {
            let id = s.ws.id.clone();
            let branch = s.ws.branch.clone();
            let noun = s
                .tree
                .map(TreeVariant::root_noun)
                .unwrap_or("scratch session");
            let is_root = s.depth == 0;
            hbox.append(&icon_button(
                "✕",
                &format!("ws-delete-{}", s.ws.id),
                if is_root {
                    match noun {
                        "orchestrator" => "Delete orchestrator",
                        _ => "Delete scratch session",
                    }
                } else {
                    "Delete session"
                },
                &["danger"],
                sender,
                move || Msg::DeleteScratch {
                    id: id.clone(),
                    label: branch.clone(),
                },
            ));
        }
    }

    let row = gtk::ListBoxRow::new();
    row.set_widget_name(&format!("ws-row-{}", s.ws.id));
    row.set_child(Some(&hbox));
    row.add_css_class("ws-row");
    if s.active {
        row.add_css_class("active");
    }
    if s.ws.marked_unread == Some(true) {
        row.add_css_class("unread");
    }
    if s.deleting {
        row.add_css_class("deleting");
    }
    if s.depth > 0 {
        row.add_css_class("ws-child");
    }
    if s.pills.merged {
        row.add_css_class("merged");
    }
    if s.draggable {
        let id = s.ws.id.clone();
        wire_dnd(
            &row,
            format!("ws:{}", s.ws.id),
            "ws:",
            sender,
            move |dragged, before| Msg::DropWs {
                dragged,
                target: id.clone(),
                before,
            },
        );
    }
    row
}

fn build_archived_toggle(count: usize, open: bool, sender: &Sender<Msg>) -> gtk::ListBoxRow {
    let b = gtk::Button::new();
    b.set_widget_name("archived-toggle");
    b.add_css_class("archived-toggle");
    let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    hbox.append(&label(if open { "▾" } else { "▸" }, &["caret"]));
    let l = label("Archived", &[]);
    l.set_hexpand(true);
    hbox.append(&l);
    hbox.append(&pill(
        &count.to_string(),
        "repo-count",
        "Archived workspaces",
    ));
    b.set_child(Some(&hbox));
    {
        let sender = sender.clone();
        b.connect_clicked(move |_| sender.emit(Msg::ToggleArchivedOpen));
    }
    let row = gtk::ListBoxRow::new();
    row.set_widget_name("archived-toggle-row");
    row.set_child(Some(&b));
    non_selectable(&row);
    row.add_css_class("archived-toggle-row");
    row
}

fn build_archived_bar(s: &ArchivedBarSpec, sender: &Sender<Msg>) -> gtk::ListBoxRow {
    let row = gtk::ListBoxRow::new();
    row.set_widget_name("archived-bar");
    non_selectable(&row);
    row.add_css_class("archived-bar-row");
    if let Some((done, total)) = s.bulk_delete {
        // Determinate "Deleting N of M" driven by onWorkspacesDeleteProgress.
        let vbox = gtk::Box::new(gtk::Orientation::Vertical, 4);
        vbox.add_css_class("archived-bar");
        let lbl = label(
            &format!("Deleting {done} of {total}…"),
            &["archived-progress-label"],
        );
        lbl.set_widget_name("archived-progress-label");
        vbox.append(&lbl);
        let bar = gtk::ProgressBar::new();
        bar.set_widget_name("archived-progress");
        bar.set_fraction(if total > 0 {
            done as f64 / total as f64
        } else {
            0.0
        });
        vbox.append(&bar);
        row.set_child(Some(&vbox));
        return row;
    }
    let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    hbox.add_css_class("archived-bar");
    let check = gtk::CheckButton::new();
    check.set_widget_name("archived-select-all");
    check.set_active(s.all_selected);
    // GtkCheckButton's inconsistent state = the HTML indeterminate look.
    check.set_inconsistent(s.some_selected);
    check.set_tooltip_text(Some(if s.all_selected {
        "Deselect all"
    } else {
        "Select all archived"
    }));
    {
        let sender = sender.clone();
        check.connect_toggled(move |_| sender.emit(Msg::ToggleSelectAllArchived));
    }
    hbox.append(&check);
    let count = label(
        &if s.selected > 0 {
            format!("{} selected", s.selected)
        } else {
            "Select all".into()
        },
        &["archived-bar-count"],
    );
    count.set_hexpand(true);
    hbox.append(&count);
    if s.selected > 0 {
        let del = gtk::Button::with_label(&format!("Delete {}", s.selected));
        del.set_widget_name("archived-bar-delete");
        del.add_css_class("archived-bar-delete");
        let sender = sender.clone();
        del.connect_clicked(move |_| sender.emit(Msg::DeleteSelectedArchived));
        hbox.append(&del);
    }
    row.set_child(Some(&hbox));
    row
}

fn build_archived_row(s: &ArchivedRowSpec, sender: &Sender<Msg>) -> gtk::ListBoxRow {
    let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    hbox.add_css_class("ws-item");
    hbox.add_css_class("archived");
    hbox.set_tooltip_text(Some(&s.ws.name));

    let check = gtk::CheckButton::new();
    check.set_widget_name(&format!("ws-check-{}", s.ws.id));
    check.set_active(s.selected);
    check.set_sensitive(!s.deleting);
    {
        let sender = sender.clone();
        let id = s.ws.id.clone();
        check.connect_toggled(move |_| sender.emit(Msg::ToggleArchivedSelection(id.clone())));
    }
    hbox.append(&check);

    let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    dot.add_css_class("ws-dot");
    dot.add_css_class(status_css(s.ws.status));
    dot.set_valign(gtk::Align::Center);
    hbox.append(&dot);

    let meta = gtk::Box::new(gtk::Orientation::Vertical, 1);
    meta.add_css_class("ws-meta");
    meta.set_hexpand(true);
    meta.append(&ellipsized(&s.ws.branch, &["ws-name"]));
    meta.append(&ellipsized(
        &format!("{} · claude", s.repo_label),
        &["ws-sub"],
    ));
    hbox.append(&meta);

    // The archived list always shows sizes — it's the delete-candidates view.
    if let Some(bytes) = s.size {
        hbox.append(&pill(
            &format_bytes(bytes),
            "ws-size",
            size_title(s.sizes_exclusive),
        ));
    }

    if s.deleting {
        let spin = gtk::Spinner::new();
        spin.start();
        spin.set_tooltip_text(Some("Deleting worktree from disk…"));
        hbox.append(&spin);
    } else {
        {
            let id = s.ws.id.clone();
            hbox.append(&icon_button(
                "↺",
                &format!("ws-restore-{}", s.ws.id),
                "Restore workspace",
                &[],
                sender,
                move || Msg::Unarchive(id.clone()),
            ));
        }
        {
            let id = s.ws.id.clone();
            let name = s.ws.name.clone();
            hbox.append(&icon_button(
                "✕",
                &format!("ws-delete-{}", s.ws.id),
                "Delete workspace permanently",
                &["danger"],
                sender,
                move || Msg::Delete {
                    id: id.clone(),
                    name: name.clone(),
                },
            ));
        }
    }

    let row = gtk::ListBoxRow::new();
    row.set_widget_name(&format!("ws-row-{}", s.ws.id));
    row.set_child(Some(&hbox));
    non_selectable(&row);
    row.add_css_class("ws-row");
    row.add_css_class("archived-row");
    row
}
