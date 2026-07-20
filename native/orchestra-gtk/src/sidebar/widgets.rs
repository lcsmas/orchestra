//! Widget construction for the sidebar row list: one [`Row`] spec → one
//! `gtk::ListBoxRow`. Pure build functions — all interaction routes through
//! the component's `Sender<Msg>`; no state lives in the widgets themselves,
//! so the list can be rebuilt from specs at any time.
//!
//! Iconography comes from [`crate::icons`] — real symbolic SVG assets embedded
//! in the binary, matching the inline SVGs Electron draws. This replaced an
//! earlier glyph-based approach ("no SVG assets", justified by headless-CI
//! stability); the glyphs were the visible defect the user reported, because a
//! `⚙`/`↗`/`✕`/`+` resolves through whatever fallback font carries it and so
//! lands at an inconsistent weight and size next to real chrome.
//!
//! Text that Electron ALSO renders as text is still text and must stay that
//! way — diff +/- counts, commit-ahead arrows, tree connectors, collapse
//! carets. Converting those would be a regression dressed up as parity.
//!
//! Every actionable widget carries a `widget_name` for the remote-control
//! harness.

use gtk::gdk;
use gtk::glib;
use gtk::pango;
use gtk::prelude::*;
use relm4::Sender;

use orchestra_rpc::types::{PrState, RepoSyncState, SetupStatus, WorkspaceKind, WorkspaceStatus};

use crate::accounts::logic::login_color_hex;

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

// NOTE (measured, do not "fix" this into max_width_chars(0)):
// `set_max_width_chars(0)` on these labels collapses every workspace row to a
// bare "…" — the ellipsis eats the whole name. It was tried here while chasing
// the sidebar-width defect, on the theory that the labels' natural width set a
// layout floor. Measurement disproved the premise: the sidebar's MINIMUM is
// 338px, far below the 518px it was allocating, so the labels were never the
// constraint. The real cause was a stale persisted `sidebarWidth` leaking into
// the captures (see capture-gtk.sh's ORCHESTRA_HOME comment).
fn ellipsized(text: &str, classes: &[&str]) -> gtk::Label {
    let l = label(text, classes);
    l.set_ellipsize(pango::EllipsizeMode::End);
    l
}

/// Small glyph action button (the `.ws-icon-btn` strip).
/// An icon button carrying a real icon from [`crate::icons`].
///
/// Every sidebar action used to be built by a glyph-taking sibling that
/// rendered a *character* as a label (`⚙`, `↗`, `✕`, a bare `+`), which is why
/// they came out at whatever weight and size the fallback font supplied. That
/// helper is gone — nothing constructs an action button from a glyph any more.
/// Text that is genuinely text (counts, arrows, carets) uses [`label`].
fn icon_button_named(
    icon: &str,
    px: i32,
    name: &str,
    tooltip: &str,
    classes: &[&str],
    sender: &Sender<Msg>,
    msg: impl Fn() -> Msg + 'static,
) -> gtk::Button {
    let b = gtk::Button::new();
    b.set_child(Some(&crate::icons::image_sized(icon, px)));
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

/// A pill button whose leading mark is a real icon rather than a character in
/// the label.
///
/// [`pill_button`] takes text only, so an icon could only be smuggled in as a
/// glyph inside the label string — which is exactly the substitution this work
/// removes. This gives the icon its own child widget, so it inherits the
/// pill's CSS `color` (symbolic recolouring) and sizes independently of the
/// font.
fn pill_icon_button(
    icon: &str,
    text: &str,
    classes: &[&str],
    tooltip: &str,
    sender: &Sender<Msg>,
    msg: impl Fn() -> Msg + 'static,
) -> gtk::Button {
    let b = gtk::Button::new();
    b.add_css_class("pill");
    b.add_css_class("pill-btn");
    for c in classes {
        b.add_css_class(c);
    }
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    let img = crate::icons::image_sized(icon, 11);
    img.add_css_class("pill-icon");
    row.append(&img);
    row.append(&gtk::Label::new(Some(text)));
    b.set_child(Some(&row));
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

/// Where a drop landed within a row: the outer thirds reorder (before/after),
/// the middle band re-parents ONTO the row. The middle band only exists on
/// rows that accept children — see [`wire_dnd`]'s `adopts` flag — so on every
/// other row the split stays the original half/half before-or-after.
enum DropZone {
    Before,
    Onto,
    After,
}

fn drop_zone(y: f64, height: f64, adopts: bool) -> DropZone {
    if !adopts {
        return if y < height / 2.0 {
            DropZone::Before
        } else {
            DropZone::After
        };
    }
    if y < height / 3.0 {
        DropZone::Before
    } else if y < height * 2.0 / 3.0 {
        DropZone::Onto
    } else {
        DropZone::After
    }
}

/// Attach a workspace-drag source ("ws:<id>") or repo-drag source
/// ("repo:<path>") plus the row-level drop target that computes before/after
/// from pointer y and reports the drop.
///
/// `adopts` marks a row that may become a PARENT (only a workspace whose
/// `can_orchestrate()` is true): it opens the middle re-parent band and routes
/// those drops through `on_adopt`. A normal row passes false and can never be
/// a re-parent target.
#[allow(clippy::too_many_arguments)]
fn wire_dnd_inner(
    row: &gtk::ListBoxRow,
    payload: String,
    accepts: &'static str,
    sender: &Sender<Msg>,
    on_drop: impl Fn(String, bool) -> Msg + 'static,
    adopts: bool,
    on_adopt: Option<Box<dyn Fn(String) -> Msg + 'static>>,
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
            row.remove_css_class("drop-before");
            row.remove_css_class("drop-after");
            row.remove_css_class("drop-onto");
            match drop_zone(y, row.height() as f64, adopts) {
                DropZone::Before => row.add_css_class("drop-before"),
                DropZone::Onto => row.add_css_class("drop-onto"),
                DropZone::After => row.add_css_class("drop-after"),
            }
            gdk::DragAction::MOVE
        });
    }
    {
        let row = row.clone();
        target.connect_leave(move |_| {
            row.remove_css_class("drop-before");
            row.remove_css_class("drop-after");
            row.remove_css_class("drop-onto");
        });
    }
    {
        let row = row.clone();
        let sender = sender.clone();
        target.connect_drop(move |_, value, _x, y| {
            row.remove_css_class("drop-before");
            row.remove_css_class("drop-after");
            row.remove_css_class("drop-onto");
            let Ok(dragged) = value.get::<String>() else {
                return false;
            };
            if !dragged.starts_with(accepts) {
                return false;
            }
            let dragged = dragged[accepts.len()..].to_string();
            match drop_zone(y, row.height() as f64, adopts) {
                DropZone::Onto => match on_adopt.as_ref() {
                    Some(adopt) => sender.emit(adopt(dragged)),
                    // `adopts` is only set together with `on_adopt`; fall back
                    // to a reorder rather than swallowing the drop.
                    None => sender.emit(on_drop(dragged, false)),
                },
                DropZone::Before => sender.emit(on_drop(dragged, true)),
                DropZone::After => sender.emit(on_drop(dragged, false)),
            }
            true
        });
    }
    row.add_controller(target);
}

/// Reorder-only DnD (repo rows, and workspace rows that cannot adopt).
fn wire_dnd(
    row: &gtk::ListBoxRow,
    payload: String,
    accepts: &'static str,
    sender: &Sender<Msg>,
    on_drop: impl Fn(String, bool) -> Msg + 'static,
) {
    wire_dnd_inner(row, payload, accepts, sender, on_drop, false, None);
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
    // Verbatim from Sidebar.tsx:1421, INCLUDING the emphasis:
    //   No agents running. Click <strong>Scratch</strong> for a quick throwaway
    //   session, or <strong>Repo</strong> to map a git repo.
    //
    // The port had rendered this as "Click ⚡ Scratch … or + Repo …", inventing
    // a lightning bolt and a "+" that Electron does not draw here. Those were
    // the glyphs the user saw in the empty sidebar.
    //
    // Note the fix is BOLD TEXT, not an icon: Electron marks these up with
    // <strong>, so lifting the glyphs into icon widgets would have moved this
    // AWAY from the reference while looking like the same class of fix as the
    // rest of this work. Checked at the source before porting.
    //
    // Pango markup rather than CSS: this is emphasis on a SPAN of a label, and
    // GTK CSS styles whole widgets — there is no selector for "these two words".
    let l = gtk::Label::new(None);
    l.set_markup(
        "No agents running. Click <b>Scratch</b> for a quick throwaway session, \
         or <b>Repo</b> to map a git repo.",
    );
    l.add_css_class("ws-empty-hint");
    l.set_xalign(0.0);
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
            // Was the 🌿 emoji. Electron uses `OrchestratorIcon` (a network
            // node branching to two children) — Sidebar.tsx.
            crate::icons::ORCHESTRATOR,
            "Orchestrators",
            "section-add-orchestrator",
            "New orchestrator",
            || Msg::NewOrchestrator,
        ),
        SectionKind::Scratch => (
            // Was the ⚡ emoji; Electron uses `ZapIcon` (Sidebar.tsx).
            crate::icons::ZAP,
            "Scratch",
            "section-add-scratch",
            "New scratch session",
            || Msg::NewScratch,
        ),
    };
    let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    hbox.add_css_class("repo-header");
    let glyph_icon = crate::icons::image_sized(glyph, 13);
    glyph_icon.add_css_class("scratch-glyph");
    hbox.append(&glyph_icon);
    let name = label(title, &["repo-name"]);
    name.set_hexpand(true);
    hbox.append(&name);
    // Section count badge = ROOT count, not row count (ledger).
    hbox.append(&pill(&count.to_string(), "repo-count", "Sessions"));
    // Was a bare "+" character rendered as a label.
    let add = icon_button_named(
        crate::icons::PLUS,
        13,
        add_name,
        add_tip,
        &["repo-add"],
        sender,
        msg,
    );
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
    cbox.set_hexpand(true);
    cbox.append(&label(if s.collapsed { "▸" } else { "▾" }, &["caret"]));
    let repo_name = ellipsized(&s.label, &["repo-name"]);
    repo_name.set_hexpand(true);
    cbox.append(&repo_name);
    // Login badge — Electron's `<RepoAccountBadge>` (Sidebar.tsx:1607). Renders
    // unconditionally: a repo pinning no account still shows the default-login
    // badge, tinted by the global poller (`AccountBadge.tsx:302`).
    {
        let (acc_label, severity, tooltip) = &s.account;
        cbox.append(&label("·", &["ws-context-sep"]));
        let acc = gtk::Label::new(None);
        acc.set_markup(&format!(
            "<span foreground=\"{}\">{}</span>",
            login_color_hex(acc_label),
            glib::markup_escape_text(acc_label),
        ));
        acc.add_css_class("ws-login-badge");
        acc.set_widget_name(&format!("repo-account-label-{}", s.label));
        match severity {
            Some(sev) => acc.add_css_class(&format!("sev-{}", sev.css())),
            // No reading yet (first poll in flight, or a hard usage error):
            // the tooltip says which, and the badge stays untinted.
            None => acc.add_css_class("pending"),
        }
        acc.set_tooltip_text(Some(tooltip));
        cbox.append(&acc);
    }
    collapse.set_child(Some(&cbox));
    {
        let sender = sender.clone();
        let path = s.repo_path.clone();
        collapse.connect_clicked(move |_| sender.emit(Msg::ToggleRepoCollapsed(path.clone())));
    }
    // hexpand goes on the ELLIPSIZING NAME LABEL inside the button, not on the
    // button itself. A Button will not shrink below its child's natural width,
    // so an hexpanding button claimed the whole row and pushed the GitHub/gear
    // /remove actions off the right edge — they were constructed and present in
    // the widget tree (verified via the remote-control harness) but had no
    // space to lay out in, so the repo header rendered as a truncated
    // "ORCHEST…" with only the count and "+" visible.
    //
    // This is why the gear and GitHub icons read as "missing" in a capture
    // while the code that builds them is plainly there: a layout defect, not a
    // missing asset. `build_section_header` above already does it this way.
    collapse.set_halign(gtk::Align::Fill);
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
        // Was the ↗ arrow standing in for a GitHub mark; Electron draws
        // `GitHubIcon` here (Sidebar.tsx:1567).
        actions.append(&icon_button_named(
            crate::icons::GITHUB,
            13,
            &format!("repo-github-{}", s.label),
            &format!("Open {} on GitHub", s.label),
            &["repo-scripts-btn"],
            sender,
            move || Msg::OpenExternal(url.clone()),
        ));
    }
    {
        let path = s.repo_path.clone();
        // Was the ⚙ glyph; Electron draws `GearIcon` (Sidebar.tsx:1580).
        actions.append(&icon_button_named(
            crate::icons::GEAR,
            13,
            &format!("repo-scripts-{}", s.label),
            &format!("Configure setup / run / archive scripts for {}", s.label),
            &["repo-scripts-btn"],
            sender,
            move || Msg::OpenRepoScripts(path.clone()),
        ));
    }
    if s.can_remove {
        let path = s.repo_path.clone();
        actions.append(&icon_button_named(
            crate::icons::CLOSE,
            12,
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
        // Electron renders `LinearIcon` here (Sidebar.tsx) — an SVG tilted
        // square, not a character. The `◈` this replaces is U+25C8 WHITE
        // DIAMOND CONTAINING BLACK SMALL DIAMOND, which is a different shape
        // and resolves through whatever font carries it.
        strip.append(&pill_icon_button(
            crate::icons::LINEAR,
            &issue.identifier,
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
        // Electron draws three DISTINCT marks here (Sidebar.tsx `PROpenIcon` /
        // `PRMergedIcon` / `PRClosedIcon`), so the STATE is carried by shape,
        // not only by the `.pr-badge` colour — which is what keeps it readable
        // in greyscale or to a colour-blind reader. The glyphs these replace
        // were `⎇`/`⌥`/`✕`, and `⌥` (OPTION KEY) is not a merge symbol in any
        // iconography; it merely looked arrow-ish in whatever font resolved it.
        let (icon, cls) = match pr.state {
            PrState::Open => (crate::icons::PR_OPEN, "open"),
            PrState::Merged => (crate::icons::PR_MERGED, "merged"),
            PrState::Closed => (crate::icons::PR_CLOSED, "closed"),
        };
        let url = pr.url.clone();
        strip.append(&pill_icon_button(
            icon,
            &format!("#{}", pr.number),
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
    // Top-aligned, not centred: Electron's `.ws-item { align-items: flex-start }`
    // (styles.css:1133) pairs with the dot's `margin-top: 4px` (styles.css:1226)
    // so the dot tracks the row's FIRST text line. Centring makes it drift to
    // the middle on rows that wrap to a pill line.
    dot.set_valign(gtk::Align::Start);
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

    // Coordinator indicator. The orchestrator-KIND root already reads as one
    // from its section, but a PROMOTED WORKTREE keeps `kind: 'worktree'` and
    // lives among ordinary repo rows, so without this the role is invisible.
    // Reuses the existing `.pill` language rather than a new class.
    if s.ws.can_orchestrate() {
        let coord = pill(
            "⌘",
            "repo-tag-pill",
            if s.ws.is_scratch_like() {
                "Orchestrator — delegates work to agents it spawns"
            } else {
                "Coordinator — a git worktree promoted to spawn and adopt child agents"
            },
        );
        coord.set_widget_name(&format!("ws-coordinator-{}", s.ws.id));
        name_row.append(&coord);
    }

    // Context badge (`agent:context`; 0-sentinel resets upstream).
    if let Some(tokens) = s.context_tokens {
        let ctx = label(&format!("· {}", format_tokens(tokens)), &["ws-context"]);
        ctx.set_tooltip_text(Some(&format!("Context size: {tokens} tokens")));
        ctx.set_valign(gtk::Align::Center);
        name_row.append(&ctx);
    }

    // Account badge → migrate menu (content §5.4; the affordance is ours).
    // Shows the login's LABEL tinted by its stable login color, with the
    // hotter rolling window's severity as a CSS class — the `AccountBadge.tsx`
    // contract. Never the raw account id.
    let account = gtk::Button::new();
    let account_label = gtk::Label::new(None);
    account_label.set_markup(&format!(
        "<span foreground=\"{}\">{}</span>",
        login_color_hex(&s.account_label),
        glib::markup_escape_text(&s.account_label),
    ));
    // Named so the login text stays inspectable: a Button with a custom child
    // has no `label` property, so the harness reads this Label instead.
    account_label.set_widget_name(&format!("ws-account-label-{}", s.ws.id));
    account.set_child(Some(&account_label));
    account.set_widget_name(&format!("ws-account-{}", s.ws.id));
    account.add_css_class("ws-login-badge");
    match s.account_severity {
        Some(sev) => account.add_css_class(&format!("sev-{}", sev.css())),
        // No reading yet (first poll in flight, or a hard usage error): the
        // tooltip says which, and the badge stays untinted.
        None => account.add_css_class("pending"),
    }
    account.set_tooltip_text(Some(&s.account_tooltip));
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
        // 5px = `.ws-pills { gap: 5px }` (styles.css:1392). Each Electron pill
        // also carries `margin-left: 6px`, but `.ws-pills > * { margin-left: 0 }`
        // (styles.css:1397) zeroes it inside the strip, so the gap is the whole
        // spacing — the mini strip below keeps 4px per `.ws-pills.mini`.
        let strip = gtk::Box::new(gtk::Orientation::Horizontal, 5);
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
        // Electron draws `BookmarkIcon`, filled when unread (Sidebar.tsx:144).
        let toggle = icon_button_named(
            if unread_on {
                crate::icons::BOOKMARK
            } else {
                crate::icons::BOOKMARK_OUTLINE
            },
            13,
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

        // Re-parenting strip: promote/demote the coordinator role, then the
        // "Attach to…" picker. Demote is offered ONLY for a promoted worktree
        // — the backend refuses to demote an orchestrator-KIND session (it is
        // repo-less by nature), so showing it there would be a dead button.
        if s.ws.can_orchestrate() {
            if s.ws.kind != Some(WorkspaceKind::Orchestrator) {
                let id = s.ws.id.clone();
                hbox.append(&icon_button_named(
                    crate::icons::CHEVRON_DOWN,
                    13,
                    &format!("ws-demote-{}", s.ws.id),
                    "Demote — stop this worktree coordinating (its children detach to top level)",
                    &[],
                    sender,
                    move || Msg::Demote(id.clone()),
                ));
            }
        } else {
            let id = s.ws.id.clone();
            hbox.append(&icon_button_named(
                crate::icons::CHEVRON_UP,
                13,
                &format!("ws-promote-{}", s.ws.id),
                "Promote to coordinator — let this workspace spawn and adopt child agents",
                &[],
                sender,
                move || Msg::Promote(id.clone()),
            ));
        }

        {
            // Anchored on the button itself so the popover points at the row.
            let id = s.ws.id.clone();
            let attach = gtk::Button::with_label("⇥");
            attach.set_widget_name(&format!("ws-attach-{}", s.ws.id));
            attach.add_css_class("ws-icon-btn");
            attach.set_tooltip_text(Some(
                "Attach to a coordinator — re-parent this workspace, or detach it to top level",
            ));
            attach.set_valign(gtk::Align::Center);
            let sender_ = sender.clone();
            attach.connect_clicked(move |b| {
                sender_.emit(Msg::OpenAttachMenu {
                    ws_id: id.clone(),
                    anchor: b.clone().upcast::<gtk::Widget>(),
                });
            });
            hbox.append(&attach);
        }

        if !is_tree {
            // Repo rows: sandbox import/eject by ws.host, then archive.
            if s.ws.host.is_none() {
                let id = s.ws.id.clone();
                let name = s.ws.name.clone();
                // Electron: `SandboxUploadIcon` (Sidebar.tsx:1972).
                hbox.append(&icon_button_named(
                    crate::icons::SANDBOX_UP,
                    13,
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
                // Electron: `SandboxDownloadIcon` (Sidebar.tsx:1981).
                hbox.append(&icon_button_named(
                    crate::icons::SANDBOX_DOWN,
                    13,
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
            // Was the 🗄 emoji; Electron draws `ArchiveIcon` (Sidebar.tsx:1334).
            hbox.append(&icon_button_named(
                crate::icons::ARCHIVE,
                13,
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
            // Electron draws `TrashIcon` for delete (Sidebar.tsx:1343).
            hbox.append(&icon_button_named(
                crate::icons::TRASH,
                13,
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
    // A coordinator row must accept a re-parent drop even when it is not
    // itself draggable (tree rows never reorder), so the controller is wired
    // whenever EITHER applies. Only `can_orchestrate()` rows open the middle
    // adopt band — a normal row is never a re-parent target.
    let adopts = s.ws.can_orchestrate();
    if s.draggable || adopts {
        let id = s.ws.id.clone();
        let parent_id = s.ws.id.clone();
        wire_dnd_inner(
            &row,
            format!("ws:{}", s.ws.id),
            "ws:",
            sender,
            move |dragged, before| Msg::DropWs {
                dragged,
                target: id.clone(),
                before,
            },
            adopts,
            adopts.then(|| {
                Box::new(move |dragged: String| Msg::DropOnto {
                    dragged,
                    parent: parent_id.clone(),
                }) as Box<dyn Fn(String) -> Msg>
            }),
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
    // Top-aligned to match build_ws_row / styles.css:1133 (`.ws-item` is
    // flex-start on both row kinds).
    dot.set_valign(gtk::Align::Start);
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
            // Electron: `RestoreIcon`.
            hbox.append(&icon_button_named(
                crate::icons::RESTORE,
                13,
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
            // Electron draws `TrashIcon` for delete (Sidebar.tsx:1343).
            hbox.append(&icon_button_named(
                crate::icons::TRASH,
                13,
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

#[cfg(test)]
mod tests {
    use super::{drop_zone, DropZone};

    /// A row that cannot adopt keeps the original half/half split — the middle
    /// band must not exist there, or an ordinary row would silently become a
    /// re-parent target.
    #[test]
    fn non_adopting_row_has_no_onto_band() {
        for y in [0.0, 9.0, 10.0, 15.0, 19.0] {
            assert!(
                !matches!(drop_zone(y, 20.0, false), DropZone::Onto),
                "y={y} must never land in the adopt band on a normal row"
            );
        }
        assert!(matches!(drop_zone(4.0, 20.0, false), DropZone::Before));
        assert!(matches!(drop_zone(16.0, 20.0, false), DropZone::After));
    }

    /// An adopting row splits into thirds: reorder above and below, re-parent
    /// through the middle.
    #[test]
    fn adopting_row_splits_into_thirds() {
        assert!(matches!(drop_zone(2.0, 30.0, true), DropZone::Before));
        assert!(matches!(drop_zone(15.0, 30.0, true), DropZone::Onto));
        assert!(matches!(drop_zone(28.0, 30.0, true), DropZone::After));
    }
}
