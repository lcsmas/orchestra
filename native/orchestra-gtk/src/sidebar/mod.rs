//! Sidebar (plan §5.1) — the M2-B1 workstream. Pure logic lives in the
//! submodules (`forest`, `hosts`, `pills`, `rows`) so behavior unit-tests
//! without a display; this file is the relm4 [`Component`] that turns that
//! logic into widgets, pumps backend events, and wires every row/repo action
//! to a [`Backend`] call and (where the Electron sidebar confirms) a dialog.
//!
//! `src/renderer/components/Sidebar.tsx` is the behavioral source of truth.
//! The row list is derived purely by [`rows::compute_rows`]; this component
//! only diffs the derived `Vec<Row>` against the widgets on screen (reusing a
//! `gtk::ListBoxRow` when its spec is unchanged) and routes messages.

pub mod forest;
pub mod hosts;
pub mod pills;
pub mod rows;
mod widgets;

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gtk::gio;
use gtk::glib;
use gtk::prelude::*;
use relm4::prelude::*;

use orchestra_rpc::events::{Event, UiEvent};
use orchestra_rpc::types::{
    AccountUsageStatus, CreateWorkspaceInput, EnvStatusItem, MigrateAccountResult, RepoSyncState,
    UsageSnapshot, Workspace, WorkspaceStatus,
};
use serde_json::{json, Value};

use crate::accounts::logic::{login_color_hex, DEFAULT_LOGIN_LABEL};
use crate::backend::{Backend, BackendEvent};
use crate::dialogs;
use crate::state::UiState;

use rows::{compute_rows, env_notices, Row, SidebarData, SidebarUi};

/// The sidebar owns a shared [`Backend`] (the app shell hands it an `Rc` so a
/// later terminal/diff workstream can share the same connection) plus the
/// persisted [`UiState`] handle (shared with the app shell's debounced saver).
pub struct SidebarInit {
    pub backend: Option<Rc<dyn Backend>>,
    pub state: Rc<RefCell<UiState>>,
    pub state_path: PathBuf,
}

/// Every user action and backend push the sidebar reacts to. The widget layer
/// (`widgets.rs`) emits the interaction variants; the component's event pump
/// emits [`Msg::Backend`].
#[derive(Debug)]
pub enum Msg {
    // ---- selection & collapse -------------------------------------------
    Select(String),
    ToggleRepoCollapsed(String),
    ToggleHostCollapsed(String),
    ToggleSubtreeCollapsed(String),
    ToggleArchivedOpen,
    ToggleArchivedSelection(String),
    ToggleSelectAllArchived,
    // ---- creation --------------------------------------------------------
    NewOrchestrator,
    NewScratch,
    AddToRepo {
        repo_path: String,
        base_branch: Option<String>,
    },
    OpenBasePicker {
        repo_path: String,
        repo_name: String,
        anchor: gtk::Widget,
    },
    // ---- repo actions ----------------------------------------------------
    OpenExternal(String),
    OpenRepoScripts(String),
    /// Linear API-key modal (`LinearSettings.tsx`). Reached from the Linear
    /// env-notice's "Set API key…" link and the footer's Linear button —
    /// the same two entry points Electron has (Sidebar.tsx:2230 / :2296).
    OpenLinearSettings,
    /// Re-read `getEnvStatus` and repaint the notice tray. Emitted after the
    /// Linear modal changes the stored key, so the "Linear not configured"
    /// notice clears without waiting for a full refresh.
    RefreshEnvStatus,
    RemoveRepo(String),
    SyncRepoBase(String),
    AddRepo,
    /// Second half of AddRepo: the folder picker resolved to this path.
    DoAddRepo(String),
    RevealLogs,
    /// A header button whose behaviour App owns — forwarded straight out as
    /// [`SidebarOutput::HeaderAction`].
    Header(HeaderAction),
    DismissNotice(String),
    // ---- rename ----------------------------------------------------------
    StartRename(String),
    CommitRename {
        id: String,
        branch: String,
    },
    CancelRename,
    // ---- row actions -----------------------------------------------------
    ToggleUnread(String),
    Archive {
        id: String,
        name: String,
    },
    Unarchive(String),
    Delete {
        id: String,
        name: String,
    },
    DeleteScratch {
        id: String,
        label: String,
    },
    DeleteSelectedArchived,
    ImportToSandbox {
        id: String,
        name: String,
    },
    EjectFromSandbox {
        id: String,
        name: String,
    },
    OpenAccountMenu {
        ws_id: String,
        current: Option<String>,
        anchor: gtk::Widget,
    },
    MigrateAccount {
        ws_id: String,
        account_id: Option<String>,
        /// Display label of the target login ("default" for None) — the confirm
        /// dialog names the account the way the user picked it, never its id.
        target_label: String,
    },
    // ---- re-parenting (promote / demote / attach / detach) ---------------
    /// Grant the orchestrate capability. A scratch session swaps its KIND; a
    /// git worktree keeps `kind: 'worktree'` and gains `canOrchestrate`, so it
    /// retains diff/merge/PR handling.
    Promote(String),
    /// Revoke the capability. Only offered on a promoted WORKTREE — the
    /// backend refuses to demote an orchestrator-KIND session.
    Demote(String),
    /// Open the "Attach to…" picker listing every workspace that can
    /// orchestrate (minus this row and its own descendants).
    OpenAttachMenu {
        ws_id: String,
        anchor: gtk::Widget,
    },
    /// Re-parent `ws_id` under `parent_id`, or detach it when None.
    SetParent {
        ws_id: String,
        parent_id: Option<String>,
    },
    // ---- drag & drop -----------------------------------------------------
    DropWs {
        dragged: String,
        target: String,
        before: bool,
    },
    /// DnD re-parent: a row was dropped ONTO an orchestrator row (as opposed
    /// to between rows, which reorders).
    DropOnto {
        dragged: String,
        parent: String,
    },
    DropRepo {
        dragged: String,
        target: String,
        before: bool,
    },
    // ---- deleting-spinner bookkeeping (mirrors markDeleting) -------------
    MarkDeleting {
        id: String,
        on: bool,
    },
    // ---- backend push ----------------------------------------------------
    Backend(BackendEvent),
    /// Re-attach after the app shell discovers a live socket.
    Attach(Rc<dyn Backend>),
    /// Coalesced structural rebuild request.
    Rebuild,
}

/// Output the app shell forwards to the main pane. The sidebar owns which
/// workspace is active (`Sidebar.tsx` writes `last_active_workspace`); it
/// announces a *change* so the main pane (§5.3, B3) can `set_active`. Emitted
/// only when the active id actually changes — not on re-selecting the current
/// row — so a store-poll (fragile) isn't needed downstream.
#[derive(Debug)]
pub enum SidebarOutput {
    /// The active workspace changed to this id via a user row-select.
    WorkspaceActivated(String),
    /// A header action button whose target App owns. The overlay triggers and
    /// the sound picker live in the sidebar header for Electron parity
    /// (`Sidebar.tsx:1359–1385`), but App holds the `Overlays` controller and
    /// the `SoundPlayer`, so the click routes back out to it.
    HeaderAction(HeaderAction),
}

/// The sidebar-header buttons whose behaviour lives in App.
#[derive(Debug, Clone, Copy)]
pub enum HeaderAction {
    OpenResources,
    OpenInsights,
    OpenSoundPicker,
    OpenAccounts,
    OpenHelp,
}

/// Widget cache entry: the last spec we built a row from (for PartialEq-based
/// reuse) and the live `ListBoxRow`.
struct RowWidget {
    spec: Row,
    widget: gtk::ListBoxRow,
}

pub struct Sidebar {
    backend: Option<Rc<dyn Backend>>,
    data: SidebarData,
    /// Persisted UI state (shared with the app shell's debounced saver).
    state: Rc<RefCell<UiState>>,
    state_path: PathBuf,
    save_generation: Rc<Cell<u64>>,
    // Transient (non-persisted) UI state.
    active_id: Option<String>,
    selected_archived: HashSet<String>,
    archived_open: bool,
    deleting_ids: HashSet<String>,
    bulk_delete: Option<(u64, u64)>,
    renaming_id: Option<String>,
    /// Guards the programmatic `select_row` during a rebuild from bouncing
    /// back through `connect_row_selected` as a fresh Select.
    selecting: Rc<Cell<bool>>,
    // Widgets.
    list: gtk::ListBox,
    /// The row list's vertical scroll adjustment, held so `rebuild` can put the
    /// scroll offset back after re-applying the selection — GtkListBox scrolls
    /// the selected row into view, which moves the viewport out from under the
    /// user. Electron never scrolls this list programmatically, so the offset
    /// must survive a rebuild unchanged (bar a clamp when the list gets
    /// shorter). See the restore in `rebuild`.
    vadj: gtk::Adjustment,
    /// The offset the USER last scrolled to, which is not the same as the
    /// adjustment's current value: collapsing a section shortens the list and
    /// GTK clamps the value down, so reading `vadj` at the next rebuild would
    /// treat the clamped position as the intent and never scroll back when the
    /// section expands again. Updated only from real scroll activity, so a
    /// clamp cannot overwrite it.
    scroll_intent: Rc<Cell<f64>>,
    notices_box: gtk::Box,
    row_cache: HashMap<String, RowWidget>,
    window: gtk::Window,
    /// A cloneable input handle so widget-construction callbacks (built outside
    /// `init`'s `sender` scope) can emit messages.
    sender_handle: relm4::Sender<Msg>,
}

impl std::fmt::Debug for Sidebar {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sidebar")
            .field("workspaces", &self.data.workspaces.len())
            .field("active_id", &self.active_id)
            .finish()
    }
}

impl Sidebar {
    /// The current UI-state snapshot the pure row derivation reads.
    fn ui(&self) -> SidebarUi {
        let st = self.state.borrow();
        SidebarUi {
            active_id: self.active_id.clone(),
            collapsed_repos: st.collapsed_repos.iter().cloned().collect(),
            collapsed_hosts: st.collapsed_hosts.iter().cloned().collect(),
            collapsed_subtrees: st.collapsed_subtrees.iter().cloned().collect(),
            archived_open: self.archived_open,
            selected_archived: self.selected_archived.clone(),
            deleting_ids: self.deleting_ids.clone(),
            bulk_delete: self.bulk_delete,
            renaming_id: self.renaming_id.clone(),
        }
    }

    fn workspace(&self, id: &str) -> Option<&Workspace> {
        self.data.workspaces.iter().find(|w| w.id == id)
    }

    /// Toggle a value in one of the persisted collapse vectors (kept as `Vec`
    /// for stable JSON — `Sidebar.tsx`'s `Array.from(Set)` parity).
    fn toggle_persisted(vec: &mut Vec<String>, key: &str) {
        if let Some(pos) = vec.iter().position(|k| k == key) {
            vec.remove(pos);
        } else {
            vec.push(key.to_string());
        }
    }

    fn schedule_save(&self, sender: &ComponentSender<Self>) {
        let generation = self.save_generation.get() + 1;
        self.save_generation.set(generation);
        let latest = self.save_generation.clone();
        let sender = sender.clone();
        glib::timeout_add_local_once(Duration::from_millis(400), move || {
            if latest.get() == generation {
                sender.input(Msg::Rebuild); // Rebuild also flushes state below.
            }
        });
    }

    fn persist(&self) {
        if let Err(e) = self.state.borrow().save(&self.state_path) {
            eprintln!("[sidebar] state save failed: {e}");
        }
    }

    /// Rebuild the list from the derived rows, reusing unchanged widgets by
    /// key. While a rename is in flight AND its Entry is already on screen we
    /// skip the structural rebuild so the focused `Entry` survives — an
    /// external event's rebuild would otherwise blow away the in-progress edit.
    /// The rebuild that first OPENS the rename (entry not yet built) must run.
    fn rebuild(&mut self) {
        if self.renaming_id.is_some() && find_named_entry(&self.list, "ws-rename-entry").is_some() {
            return;
        }
        // Stamp "now" for the age-dependent row content (the account badge's
        // "as of Xm ago" tooltip); rows.rs stays clock-free and testable.
        self.data.now_ms = glib::real_time() / 1000;
        let ui = self.ui();
        let rows = compute_rows(&self.data, &ui);

        // Where the user last scrolled to — NOT `vadj.value()`, which may have
        // been clamped down by an earlier collapse. Using the clamped value
        // would make the position stick at the shorter list's bottom and never
        // come back when the section expands again.
        let scroll_to = self.scroll_intent.get();

        // Detach every current child (we re-append in order below; reused
        // widgets are re-parented, fresh ones built).
        while let Some(row) = self.list.row_at_index(0) {
            self.list.remove(&row);
        }

        let mut next: HashMap<String, RowWidget> = HashMap::new();
        let mut selected_row: Option<gtk::ListBoxRow> = None;
        for spec in rows {
            let key = spec.key();
            let widget = match self.row_cache.remove(&key) {
                // Same spec → reuse the widget untouched.
                Some(rw) if rw.spec == spec => rw.widget,
                // Key matches but spec changed (or brand new) → rebuild.
                _ => widgets::build_row(&spec, &self.sender_handle),
            };
            self.list.append(&widget);
            if let Row::Workspace(s) = &spec {
                if s.active {
                    selected_row = Some(widget.clone());
                }
            }
            next.insert(key, RowWidget { spec, widget });
        }
        self.row_cache = next;

        // Restore the visible selection without re-entering Select.
        //
        // `select_row` makes GtkListBox scroll the selected row into view. The
        // Electron sidebar never scrolls the list programmatically — there is
        // no `scrollIntoView`/`scrollTop` anywhere in `src/renderer` outside
        // BranchPicker's dropdown keyboard nav — so the viewport must stay put
        // whatever the selection does. Skipping the call when the selection is
        // unchanged removes the gratuitous case; the offset restore below
        // covers the rest, including a deliberate click on an off-screen row.
        self.selecting.set(true);
        let current = self.list.selected_row();
        match &selected_row {
            Some(row) => {
                if current.as_ref() != Some(row) {
                    self.list.select_row(Some(row));
                }
            }
            None => {
                if current.is_some() {
                    self.list.unselect_all();
                }
            }
        }
        self.selecting.set(false);

        // Put the scroll offset back, because `select_row` above just moved it:
        // GtkListBox scrolls the selected row into view, so a rebuild while the
        // selected row is off-screen yanks the viewport to it. That is the
        // "list jumps to the beginning" the user reported — measured at
        // 335px -> 0 on selecting the first row, with the adjustment's upper
        // bound UNCHANGED, which is what distinguishes it from a legitimate
        // clamp. Rebuilds are frequent (status events, snapshot refreshes), so
        // this was not specific to collapsing.
        //
        // Emptying and refilling the ListBox does NOT by itself lose the offset
        // — that hypothesis was tested and disproved: with this restore
        // disabled, a collapse moves 335 -> 179 purely as GTK clamping to the
        // now-shorter list, and never reaches 0.
        //
        // Deferred to the frame clock because layout has not run yet: the
        // adjustment's upper bound is still the pre-rebuild one, so setting the
        // value now would be clamped against stale bounds. `set_value` clamps to
        // [lower, upper - page_size] itself, so a genuinely shorter list still
        // lands at its new bottom rather than out of range.
        //
        // HELD for several frames rather than restored once: GtkListBox's
        // scroll-into-view is itself queued and lands AFTER the first tick, so a
        // single restore wins the frame and loses the war (measured — the
        // one-shot version still ended at 0). Re-asserting the offset each
        // frame outlasts it. A handful of frames is imperceptible and the list
        // is not user-scrollable mid-rebuild.
        //
        // Skipped when nothing was scrolled — avoids arming a tick callback on
        // every rebuild in the common short-list case.
        if scroll_to > 0.0 {
            let vadj = self.vadj.clone();
            // Bounded so this can never become a permanent frame callback, and
            // so a user scroll immediately after a rebuild is not fought for
            // longer than the rebuild itself.
            let ticks_left = Cell::new(6u8);
            self.list.add_tick_callback(move |_, _| {
                ticks_left.set(ticks_left.get().saturating_sub(1));
                if vadj.upper() > vadj.page_size() && vadj.value() != scroll_to {
                    vadj.set_value(scroll_to);
                }
                if ticks_left.get() == 0 {
                    glib::ControlFlow::Break
                } else {
                    glib::ControlFlow::Continue
                }
            });
        }

        self.rebuild_notices();
    }

    fn rebuild_notices(&self) {
        while let Some(child) = self.notices_box.first_child() {
            self.notices_box.remove(&child);
        }
        let dismissed: HashSet<String> = self
            .state
            .borrow()
            .dismissed_env_notices
            .iter()
            .cloned()
            .collect();
        let notices = env_notices(&self.data.env_status, &dismissed);
        self.notices_box.set_visible(!notices.is_empty());
        // GTK4 CSS has no adjacent-sibling combinator, so Electron's
        // `.env-notice + .env-notice { border-top }` (styles.css:823) becomes
        // an explicit class on every notice after the first.
        for (i, item) in notices.iter().enumerate() {
            let notice = self.build_notice(item);
            if i > 0 {
                notice.add_css_class("not-first");
            }
            self.notices_box.append(&notice);
        }
    }

    /// Mirrors the Electron notice DOM (`Sidebar.tsx:2007-2047`): an icon, a
    /// body holding a bold title line (`{label} not configured`) and a dim
    /// detail line, then the dismiss button. The previous single concatenated
    /// `{label}: {detail}` label flattened that hierarchy into one dim line.
    /// Widget names are unchanged — the E2E drives assert on them.
    fn build_notice(&self, item: &EnvStatusItem) -> gtk::Box {
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        row.add_css_class("env-notice");
        row.set_widget_name(&format!("env-notice-{}", item.id));

        // styles.css:826 `.env-notice-icon` — yellow, top-aligned to the title.
        //
        // Was the ⚙ literal (U+2699), which was also the WRONG SYMBOL, not just
        // the wrong rendering: the renderer draws Lucide `info` here
        // (components/Sidebar.tsx `SetupIcon`), deliberately "a calm heads-up,
        // not an alarm" per its own comment. A gear reads as settings.
        let icon = crate::icons::image_sized(crate::icons::INFO, 15);
        icon.add_css_class("env-notice-icon");
        icon.set_valign(gtk::Align::Start);
        row.append(&icon);

        let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
        body.add_css_class("env-notice-body");
        body.set_hexpand(true);

        let title = gtk::Label::new(Some(&format!("{} not configured", item.label)));
        title.add_css_class("env-notice-title");
        title.set_xalign(0.0);
        title.set_wrap(true);
        body.append(&title);

        let detail = gtk::Label::new(Some(&item.detail));
        detail.add_css_class("env-notice-detail");
        detail.set_xalign(0.0);
        detail.set_wrap(true);
        body.append(&detail);

        // The Linear notice carries a "Set API key…" link instead of a docs
        // link (Sidebar.tsx:2225-2233): the fix is in-app, so send the user to
        // the modal rather than out to a browser.
        if item.id == "linear" {
            let set_key = gtk::Button::with_label("Set API key…");
            set_key.set_widget_name("env-notice-linear-set-key");
            set_key.add_css_class("env-notice-link");
            set_key.set_halign(gtk::Align::Start);
            let sender = self.sender_handle.clone();
            set_key.connect_clicked(move |_| sender.emit(Msg::OpenLinearSettings));
            body.append(&set_key);
        }

        row.append(&body);

        let dismiss = gtk::Button::with_label("×");
        dismiss.set_widget_name(&format!("env-notice-dismiss-{}", item.id));
        dismiss.add_css_class("env-notice-dismiss");
        dismiss.set_tooltip_text(Some("Dismiss"));
        {
            let sender = self.sender_handle.clone();
            let id = item.id.clone();
            dismiss.connect_clicked(move |_| sender.emit(Msg::DismissNotice(id.clone())));
        }
        row.append(&dismiss);
        row
    }

    /// Reload the backend snapshot (workspaces, repos, sync states, env). Live
    /// per-row overlays (tools, context, PR/size/diff/linear caches) are event
    /// or lazy-fetch driven and survive across refreshes.
    fn refresh_snapshot(&mut self) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        if let Ok(ws) = backend.list_workspaces() {
            self.data.workspaces = ws;
        }
        if let Ok(repos) = backend.list_repos() {
            self.data.repos = repos;
        }
        // Repo sync states + env status ride the generic call surface.
        if let Ok(v) = backend.call("listRepoSyncStates", vec![]) {
            if let Ok(list) = serde_json::from_value::<Vec<RepoSyncState>>(v) {
                self.data.repo_sync = list.into_iter().map(|s| (s.repo_path.clone(), s)).collect();
            }
        }
        if let Ok(v) = backend.call("getEnvStatus", vec![]) {
            if let Ok(list) = serde_json::from_value::<Vec<EnvStatusItem>>(v) {
                self.data.env_status = list;
            }
        }
        if let Ok(v) = backend.call("getWorktreeSizes", vec![]) {
            if let Ok(sizes) = serde_json::from_value::<WorktreeSizesReply>(v) {
                self.data.sizes = sizes.sizes;
                self.data.sizes_exclusive = sizes.exclusive;
            }
        }
        self.refresh_accounts_snapshot();
    }

    /// Accounts + usage for the row badges (label to show, utilization to tint
    /// by). Split out so the usage/account event handlers can refresh just this
    /// slice without a full snapshot reload.
    fn refresh_accounts_snapshot(&mut self) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        if let Ok(v) = backend.call("listAccounts", vec![]) {
            if let Ok(list) = serde_json::from_value::<Vec<AccountBrief>>(v) {
                self.data.account_labels = list.into_iter().map(|a| (a.id, a.label)).collect();
            }
        }
        if let Ok(v) = backend.call("getAllAccountUsage", vec![]) {
            if let Ok(map) = serde_json::from_value::<HashMap<String, AccountUsageStatus>>(v) {
                self.data.account_usage = map;
            }
        }
        if let Ok(v) = backend.call("getUsage", vec![]) {
            if let Ok(snap) = serde_json::from_value::<Option<UsageSnapshot>>(v) {
                self.data.global_usage = snap;
            }
        }
    }

    /// Fold one decoded backend event into `data`/transient state. Returns true
    /// when a structural rebuild is needed (most events; the high-frequency
    /// tool/context ones only re-render the affected row, but for M2 parity we
    /// keep the single rebuild path — it reuses unchanged widgets).
    fn apply_event(&mut self, ev: UiEvent) -> bool {
        match ev {
            UiEvent::WorkspaceUpdate(ws) => {
                let ws = *ws;
                match self.data.workspaces.iter_mut().find(|w| w.id == ws.id) {
                    Some(existing) => *existing = ws,
                    None => self.data.workspaces.push(ws),
                }
                true
            }
            UiEvent::WorkspaceRemoved { id } => {
                self.data.workspaces.retain(|w| w.id != id);
                self.deleting_ids.remove(&id);
                self.selected_archived.remove(&id);
                true
            }
            UiEvent::WorkspacesRemoved { ids } => {
                let set: HashSet<&String> = ids.iter().collect();
                self.data.workspaces.retain(|w| !set.contains(&w.id));
                for id in &ids {
                    self.deleting_ids.remove(id);
                    self.selected_archived.remove(id);
                }
                true
            }
            UiEvent::WorkspacesDeleteProgress { done, total } => {
                self.bulk_delete = Some((done, total));
                true
            }
            UiEvent::AgentTool { id, tool } => {
                match tool {
                    Some(t) => {
                        self.data.tools.insert(id, t);
                    }
                    None => {
                        self.data.tools.remove(&id);
                    }
                }
                true
            }
            UiEvent::AgentContext { id, tokens } => {
                // 0 is the sentinel that clears the live override (a compacted
                // or never-run session falls back to the stored figure).
                if tokens == 0 {
                    self.data.context_tokens.remove(&id);
                } else {
                    self.data.context_tokens.insert(id, tokens);
                }
                true
            }
            UiEvent::RepoSyncState(s) => {
                self.data.repo_sync.insert(s.repo_path.clone(), *s);
                true
            }
            UiEvent::ReposUpdate(repos) => {
                self.data.repos = repos;
                true
            }
            // The row account badge renders the login's label + usage tint, so
            // these two keep it live (the usage-bars strip owns the same frames
            // independently — App fans one frame out to both).
            UiEvent::AccountUsageUpdate(map) => {
                self.data.account_usage = map;
                true
            }
            UiEvent::UsageUpdate(snap) => {
                self.data.global_usage = Some(*snap);
                true
            }
            // A migrate re-pins the workspace: the labels may also have changed
            // (setAccounts broadcasts this too), so re-pull the account slice.
            UiEvent::WorkspaceAccountsUpdate(_) => {
                self.refresh_accounts_snapshot();
                true
            }
            // Channels the sidebar doesn't render (login pty, self-tune) are
            // owned by sibling workstreams.
            _ => false,
        }
    }
}

/// Shape of `getWorktreeSizes` (`{ sizes: {id: bytes}, exclusive: bool }`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeSizesReply {
    #[serde(default)]
    sizes: HashMap<String, u64>,
    #[serde(default)]
    exclusive: bool,
}

/// Icon-only header button — Electron's `.header-icon-btn` (Sidebar.tsx:1363),
/// a 28x28 square used for help / bell / accounts / the overlay triggers.
///
/// Split from [`header_repo_button`] because Electron genuinely has two header
/// button shapes, and collapsing them is what produced the defect this
/// replaces: the create buttons rendered as bare icon squares with their
/// labels missing, which the user read as broken chrome.
fn header_icon_button(
    icon: &str,
    name: &str,
    tooltip: &str,
    sender: &relm4::Sender<Msg>,
    msg: impl Fn() -> Msg + 'static,
) -> gtk::Button {
    let b = gtk::Button::new();
    b.set_child(Some(&crate::icons::image_sized(icon, 15)));
    b.set_widget_name(name);
    b.add_css_class("header-icon-btn");
    b.set_tooltip_text(Some(tooltip));
    let sender = sender.clone();
    b.connect_clicked(move |_| sender.emit(msg()));
    b
}

/// One entry of the "+ New" popover — Electron's `.new-menu-item`
/// (Sidebar.tsx:1413), an accent-tinted icon beside a two-line body: a bold
/// title and a dim one-line description of what the session kind is for.
fn new_menu_item(
    icon: &str,
    icon_class: &str,
    title: &str,
    subtitle: &str,
    name: &str,
    popover: &gtk::Popover,
    sender: &relm4::Sender<Msg>,
    msg: impl Fn() -> Msg + 'static,
) -> gtk::Button {
    let b = gtk::Button::new();
    // gap: 9px, align-items: flex-start — styles.css:588.
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 9);
    row.set_valign(gtk::Align::Start);

    // `.new-menu-item-icon` carries the per-kind colour (styles.css:609-611):
    // accent for a repo workspace, and the scratch / orchestrator hues for the
    // other two — the same tokens their sidebar glyphs use.
    let icon_img = crate::icons::image_sized(icon, 15);
    icon_img.add_css_class("new-menu-item-icon");
    icon_img.add_css_class(icon_class);
    icon_img.set_valign(gtk::Align::Start);
    row.append(&icon_img);

    // gap: 1px — styles.css:612.
    let body = gtk::Box::new(gtk::Orientation::Vertical, 1);
    let title_l = gtk::Label::new(Some(title));
    title_l.set_xalign(0.0);
    title_l.add_css_class("new-menu-item-title");
    let sub_l = gtk::Label::new(Some(subtitle));
    sub_l.set_xalign(0.0);
    sub_l.add_css_class("new-menu-item-sub");
    body.append(&title_l);
    body.append(&sub_l);
    row.append(&body);

    b.set_child(Some(&row));
    b.set_widget_name(name);
    b.add_css_class("new-menu-item");
    let sender = sender.clone();
    let popover = popover.clone();
    b.connect_clicked(move |_| {
        // Electron closes the menu before running the action
        // (`setNewMenuOpen(false)` precedes each handler, Sidebar.tsx:1417).
        popover.popdown();
        sender.emit(msg());
    });
    b
}

impl Component for Sidebar {
    type Init = SidebarInit;
    type Input = Msg;
    type Output = SidebarOutput;
    type CommandOutput = ();
    type Root = gtk::Box;
    type Widgets = ();

    fn init_root() -> Self::Root {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.add_css_class("sidebar");
        root.set_widget_name("sidebar");
        root.set_width_request(200);
        root
    }

    fn init(
        init: Self::Init,
        root: Self::Root,
        sender: ComponentSender<Self>,
    ) -> ComponentParts<Self> {
        let input = sender.input_sender().clone();

        // ---- header strip: title + action buttons -----------------------
        //
        // HORIZONTAL, matching Electron's `.sidebar-header` (styles.css:522):
        // `display: flex; justify-content: space-between; align-items: center;
        // gap: 8px` — the wordmark and the actions share ONE row. `flex-wrap`
        // is a narrow-window fallback there, not the normal layout.
        //
        // This was VERTICAL, on a rationale that no longer holds and never
        // quite did: it claimed Electron wraps onto three lines ending in
        // "Scratch / Orchestrator / Repo" buttons styled by `.header-repo-btn`
        // at Sidebar.tsx:1387. No such rule and no such buttons exist —
        // `header-repo-btn` occurs zero times in both Sidebar.tsx and
        // styles.css. Those three create buttons were this port's own
        // invention; at 449px they could not share a row with the wordmark, so
        // the port stacked them and grew the header past Electron's.
        //
        // Replacing them with Electron's single "+ New" menu drops the actions
        // to 138px natural (measured over the remote-control harness), so the
        // icon triggers and the menu button fit one line inside the 308px
        // header with room to spare — 220px against 308.
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        header.add_css_class("sidebar-header");
        header.set_widget_name("sidebar-header");
        // Electron's wordmark (Sidebar.tsx:1360 `<h1>Orchestra</h1>`), not the
        // "WORKSPACES" section label the port had — this is the app's title,
        // not a heading for the list below it.
        let title = gtk::Label::new(Some("Orchestra"));
        title.set_xalign(0.0);
        title.add_css_class("sidebar-title");
        title.set_widget_name("sidebar-title");
        title.set_hexpand(true);
        header.append(&title);

        // Actions, in Electron's order (Sidebar.tsx:1361-1463): the icon-only
        // triggers, then the single "+ New" menu button that ends the row.
        //
        // Every trigger was an emoji or bare character before: 📊 💡 🔔 ? — an
        // emoji in a Button label is not an icon, so they rendered as blank
        // dark squares.
        //
        // ONE row — `.sidebar-header-actions` is `display: flex;
        // justify-content: flex-end; gap: 6px` (styles.css:533). The icon
        // triggers and the "+ New" button are siblings on that row.
        let actions = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        actions.add_css_class("sidebar-header-actions");
        actions.set_widget_name("sidebar-header-actions");
        actions.set_halign(gtk::Align::End);
        actions.set_valign(gtk::Align::Center); // align-items: center

        // Both aliases point at the single actions row now, so the append
        // order below still reads as "triggers first, then create".
        let icon_row = actions.clone();
        let create_row = actions.clone();

        icon_row.append(&header_icon_button(
            crate::icons::HELP,
            "open-help",
            "Help — what Orchestra can do",
            &input,
            || Msg::Header(HeaderAction::OpenHelp),
        ));
        icon_row.append(&header_icon_button(
            crate::icons::BELL,
            "open-sound",
            "Notification sound settings",
            &input,
            || Msg::Header(HeaderAction::OpenSoundPicker),
        ));
        // Accounts — Electron's third header icon (Sidebar.tsx:1415, UsersIcon).
        // The port had NO header entry for it (only the footer usage-bar button
        // opened the accounts window), so a user comparing headers saw Electron's
        // accounts icon missing here. Placed right after Bell to match Electron's
        // Help/Bell/Accounts order. Resources+Insights follow, kept per the note
        // below, so GTK carries 4 header icons to Electron's 3 by design.
        icon_row.append(&header_icon_button(
            crate::icons::USERS,
            "open-accounts",
            "Claude accounts — usage badges per workspace",
            &input,
            || Msg::Header(HeaderAction::OpenAccounts),
        ));
        // Resources and Insights have no Electron header counterpart (they are
        // reached from the footer / their own sections there). They are kept
        // here because this port currently has no other entry point for them —
        // flagged rather than silently dropped.
        icon_row.append(&header_icon_button(
            crate::icons::RESOURCES,
            "open-resources",
            "Resources — CPU, memory, disk and token usage",
            &input,
            || Msg::Header(HeaderAction::OpenResources),
        ));
        icon_row.append(&header_icon_button(
            crate::icons::INSIGHTS,
            "open-insights",
            "Insights — monthly self-tune runs",
            &input,
            || Msg::Header(HeaderAction::OpenInsights),
        ));

        // The single "+ New" menu — Electron's `.new-menu` (Sidebar.tsx:1399).
        // One entry point for all three session kinds, replacing the three
        // separate Scratch / Orchestrator / Repo buttons this port had.
        //
        // GtkPopover already does what Electron wires by hand: it closes on
        // Escape and on an outside click (Sidebar.tsx:646-661 installs a
        // `keydown` + document `mousedown` listener for exactly that), and it
        // takes keyboard focus so Tab/arrows walk the items.
        let new_btn = gtk::MenuButton::new();
        new_btn.set_widget_name("header-new-menu");
        new_btn.add_css_class("new-menu-btn");
        new_btn.set_tooltip_text(Some("New session — workspace, scratch, or orchestrator"));
        // gap: 5px — styles.css:550. The "+" is a text span in Electron
        // (`.new-menu-plus`, styles.css:568), not an icon.
        let new_box = gtk::Box::new(gtk::Orientation::Horizontal, 5);
        let plus = gtk::Label::new(Some("+"));
        plus.add_css_class("new-menu-plus");
        new_box.append(&plus);
        new_box.append(&gtk::Label::new(Some("New")));
        new_btn.set_child(Some(&new_box));
        // Electron's trigger is a plain <button> with just "+" and "New"; a
        // GtkMenuButton adds its own dropdown indicator, rendering "+ New ▾".
        // Suppress it at the widget rather than relying on CSS alone — the
        // arrow is an internal child, so styling it is version-dependent while
        // this property is the documented control.
        new_btn.set_always_show_arrow(false);

        let new_popover = gtk::Popover::new();
        new_popover.set_widget_name("new-menu-popover");
        new_popover.add_css_class("new-menu-popover");
        // `top: calc(100% + 6px); right: 0` — below the button, right-aligned
        // (styles.css:573-576).
        new_popover.set_position(gtk::PositionType::Bottom);
        new_popover.set_halign(gtk::Align::End);
        // gap: 2px, width: 246px — styles.css:578-581.
        let new_list = gtk::Box::new(gtk::Orientation::Vertical, 2);
        new_list.set_size_request(246, -1);

        // Order matches Electron exactly (Sidebar.tsx:1413-1460).
        new_list.append(&new_menu_item(
            crate::icons::FOLDER_PLUS,
            "repo",
            "Workspace",
            "agent on its own branch of a git repo",
            "new-menu-workspace",
            &new_popover,
            &input,
            || Msg::AddRepo,
        ));
        new_list.append(&new_menu_item(
            crate::icons::ZAP,
            "scratch",
            "Scratch session",
            "throwaway, no git repo needed",
            "new-menu-scratch",
            &new_popover,
            &input,
            || Msg::NewScratch,
        ));
        new_list.append(&new_menu_item(
            crate::icons::ORCHESTRATOR,
            "orchestrator",
            "Orchestrator",
            "delegates work to agents it spawns",
            "new-menu-orchestrator",
            &new_popover,
            &input,
            || Msg::NewOrchestrator,
        ));
        new_popover.set_child(Some(&new_list));
        new_btn.set_popover(Some(&new_popover));
        create_row.append(&new_btn);
        header.append(&actions);
        root.append(&header);

        // ---- scrolling row list -----------------------------------------
        let scroll = gtk::ScrolledWindow::new();
        scroll.set_vexpand(true);
        scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        let list = gtk::ListBox::new();
        list.set_widget_name("sidebar-list");
        list.set_selection_mode(gtk::SelectionMode::Single);
        scroll.set_child(Some(&list));
        let vadj = scroll.vadjustment();
        // Remember where the user scrolled to, so a clamp cannot overwrite it.
        //
        // Signal ORDER cannot be used to tell the two apart: when a collapse
        // shortens the list, the clamping `value-changed` arrives BEFORE the
        // `changed` that reports the new bounds, so a flag armed on `changed`
        // is always set one event too late (measured — the clamp to 179 was
        // recorded as intent and overwrote the user's 335).
        //
        // What does distinguish them is the value's relationship to the
        // bounds: a clamp lands exactly on the maximum, and it only ever moves
        // the value DOWN. So a decrease that lands on the current maximum is
        // treated as a clamp and leaves the intent alone; anything else is the
        // user. Scrolling deliberately to the bottom therefore does not update
        // the intent — which costs nothing, because the restore clamps to the
        // bottom anyway when the list is that short.
        let scroll_intent = Rc::new(Cell::new(0.0f64));
        {
            let intent = scroll_intent.clone();
            vadj.connect_value_changed(move |a| {
                let v = a.value();
                let max = (a.upper() - a.page_size()).max(0.0);
                let landed_on_max = (v - max).abs() < 0.5;
                if landed_on_max && v < intent.get() {
                    return; // GTK clamping to a shorter list, not the user.
                }
                // Never remember a position past the current bottom. Early in
                // startup the page size is still growing, so a transient
                // "bottom" can exceed the settled one (measured: 406 recorded
                // against a page size of 337 that became 408). set_value would
                // clamp it on the way out, but storing it makes the intent a
                // number nobody can reason about.
                intent.set(v.min(max));
            });
        }
        root.append(&scroll);

        // ---- env-notice tray + insights/usage slots + footer ------------
        let notices_box = gtk::Box::new(gtk::Orientation::Vertical, 4);
        notices_box.add_css_class("env-notices");
        notices_box.set_widget_name("env-notices");
        notices_box.set_visible(false);
        root.append(&notices_box);

        // Placeholder mount point the sibling Insights workstream attaches into
        // (kept from day one so the layout is stable).
        let insights_slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
        insights_slot.set_widget_name("insights-slot");
        root.append(&insights_slot);
        // NOTE: the matching "usage-bars-slot" Box was removed — it was created,
        // named and appended but never mounted into (the usage bars live in the
        // app.rs sidebar footer instead), so it only added an empty Box to the
        // sidebar's vertical stack.

        root.append(&build_footer(&input));

        // Reentrancy-guarded selection.
        let selecting = Rc::new(Cell::new(false));
        {
            let input = input.clone();
            let selecting = selecting.clone();
            list.connect_row_selected(move |_, row| {
                if selecting.get() {
                    return;
                }
                if let Some(row) = row {
                    // The widget name is "ws-row-<id>"; recover the id.
                    if let Some(id) = row.widget_name().strip_prefix("ws-row-") {
                        input.emit(Msg::Select(id.to_string()));
                    }
                }
            });
        }

        // Sidebar action group: headless sway advertises no pointer, so the GTK
        // drag controllers and double-click rename gesture can't be exercised
        // in E2E. These parameterized actions emit the SAME messages those
        // handlers do — the remote-control harness invokes them to drive
        // reorder and rename deterministically:
        //   sidebar.drop-ws / drop-repo  "<dragged>|<target>|before|after"
        //   sidebar.start-rename         "<ws-id>"
        //   sidebar.commit-rename        "<ws-id>"  (reads the live entry text)
        install_sidebar_actions(&root, &input, &list);

        let window = root
            .root()
            .and_then(|r| r.downcast::<gtk::Window>().ok())
            .unwrap_or_else(gtk::Window::new);

        let mut model = Sidebar {
            backend: init.backend.clone(),
            data: SidebarData::default(),
            state: init.state,
            state_path: init.state_path,
            save_generation: Rc::new(Cell::new(0)),
            active_id: None,
            selected_archived: HashSet::new(),
            archived_open: false,
            deleting_ids: HashSet::new(),
            bulk_delete: None,
            renaming_id: None,
            selecting,
            list,
            vadj,
            scroll_intent,
            notices_box,
            row_cache: HashMap::new(),
            window,
            sender_handle: input.clone(),
        };
        model.active_id = model.state.borrow().last_active_workspace.clone();

        // App owns the single backend.events() consumer and forwards frames
        // here as Msg::Backend (see app.rs spawn_backend_streams). The sidebar
        // must NOT open its own pump — two async_channel receivers on one
        // channel are competing consumers and would each miss half the events.
        if model.backend.is_some() {
            model.refresh_snapshot();
        }
        model.rebuild();

        ComponentParts { model, widgets: () }
    }

    fn update(&mut self, msg: Self::Input, sender: ComponentSender<Self>, _root: &Self::Root) {
        // The window handle is resolved lazily — at init the root isn't in a
        // toplevel yet, so grab it on first use for the dialog parent.
        if let Some(win) = self
            .list
            .root()
            .and_then(|r| r.downcast::<gtk::Window>().ok())
        {
            self.window = win;
        }
        let mut rebuild = true;
        match msg {
            Msg::Select(id) => {
                if self.active_id.as_deref() != Some(id.as_str()) {
                    self.active_id = Some(id.clone());
                    self.state.borrow_mut().last_active_workspace = Some(id.clone());
                    self.schedule_save(&sender);
                    // Announce the change so the app shell can drive the main
                    // pane's set_active (§5.3). Only fires on an actual change.
                    let _ = sender.output(SidebarOutput::WorkspaceActivated(id));
                    // Rebuild so the `active` highlight moves — only the two
                    // affected rows' specs change, so widget reuse keeps this
                    // cheap (the rest are reused untouched).
                } else {
                    rebuild = false;
                }
            }
            Msg::ToggleRepoCollapsed(path) => {
                Self::toggle_persisted(&mut self.state.borrow_mut().collapsed_repos, &path);
                self.persist();
            }
            Msg::ToggleHostCollapsed(id) => {
                Self::toggle_persisted(&mut self.state.borrow_mut().collapsed_hosts, &id);
                self.persist();
            }
            Msg::ToggleSubtreeCollapsed(id) => {
                Self::toggle_persisted(&mut self.state.borrow_mut().collapsed_subtrees, &id);
                self.persist();
            }
            Msg::ToggleArchivedOpen => self.archived_open = !self.archived_open,
            Msg::ToggleArchivedSelection(id) => {
                if !self.selected_archived.remove(&id) {
                    self.selected_archived.insert(id);
                }
            }
            Msg::ToggleSelectAllArchived => {
                let archived: Vec<String> = self
                    .data
                    .workspaces
                    .iter()
                    .filter(|w| w.archived == Some(true))
                    .map(|w| w.id.clone())
                    .collect();
                let all = !archived.is_empty()
                    && archived
                        .iter()
                        .all(|id| self.selected_archived.contains(id));
                if all {
                    self.selected_archived.clear();
                } else {
                    self.selected_archived = archived.into_iter().collect();
                }
            }
            Msg::DismissNotice(id) => {
                {
                    let mut st = self.state.borrow_mut();
                    if !st.dismissed_env_notices.contains(&id) {
                        st.dismissed_env_notices.push(id);
                    }
                }
                self.persist();
                self.rebuild_notices();
                rebuild = false;
            }
            Msg::NewScratch => self.create_scratch_like(&sender, "createScratchWorkspace"),
            Msg::NewOrchestrator => {
                self.create_scratch_like(&sender, "createOrchestratorWorkspace")
            }
            Msg::AddToRepo {
                repo_path,
                base_branch,
            } => {
                self.create_workspace(&sender, repo_path, base_branch);
                rebuild = false;
            }
            Msg::OpenBasePicker {
                repo_path,
                repo_name,
                anchor,
            } => {
                self.open_base_picker(&sender, repo_path, repo_name, anchor);
                rebuild = false;
            }
            Msg::AddRepo => {
                self.add_repo(&sender);
                rebuild = false;
            }
            Msg::DoAddRepo(path) => {
                self.fire_and_forget("addRepo", vec![json!(path)]);
                rebuild = false;
            }
            Msg::OpenExternal(url) => {
                self.fire_and_forget("openExternal", vec![json!(url)]);
                rebuild = false;
            }
            Msg::RevealLogs => {
                self.fire_and_forget("revealLogs", vec![]);
                rebuild = false;
            }
            Msg::Header(action) => {
                // Nothing sidebar-side changes; App opens the overlay/picker.
                let _ = sender.output(SidebarOutput::HeaderAction(action));
                rebuild = false;
            }
            Msg::OpenRepoScripts(path) => {
                self.open_repo_scripts(path);
                rebuild = false;
            }
            Msg::OpenLinearSettings => {
                self.open_linear_settings(&sender);
                rebuild = false;
            }
            Msg::RefreshEnvStatus => {
                if let Some(backend) = self.backend.clone() {
                    if let Ok(v) = backend.call("getEnvStatus", vec![]) {
                        if let Ok(list) = serde_json::from_value::<Vec<EnvStatusItem>>(v) {
                            self.data.env_status = list;
                        }
                    }
                }
                // Falls through to the rebuild so the notice tray repaints.
            }
            Msg::RemoveRepo(path) => {
                self.remove_repo(&sender, path);
                rebuild = false;
            }
            Msg::SyncRepoBase(path) => {
                self.fire_and_forget("syncRepoBase", vec![json!(path)]);
                rebuild = false;
            }
            Msg::StartRename(id) => self.renaming_id = Some(id),
            Msg::CommitRename { id, branch } => {
                self.renaming_id = None;
                let branch = branch.trim().to_string();
                if !branch.is_empty() {
                    if let Some(ws) = self.workspace(&id) {
                        if ws.branch != branch {
                            self.fire_and_forget("renameBranch", vec![json!(id), json!(branch)]);
                        }
                    }
                }
            }
            Msg::CancelRename => self.renaming_id = None,
            Msg::ToggleUnread(id) => {
                let next = self
                    .workspace(&id)
                    .map(|w| w.marked_unread != Some(true))
                    .unwrap_or(true);
                self.fire_and_forget("setUnread", vec![json!(id), json!(next)]);
                rebuild = false;
            }
            Msg::Archive { id, .. } => {
                self.fire_and_forget("archiveWorkspace", vec![json!(id)]);
                rebuild = false;
            }
            Msg::Unarchive(id) => {
                self.fire_and_forget("unarchiveWorkspace", vec![json!(id)]);
                rebuild = false;
            }
            Msg::Delete { id, name } => {
                self.confirm_delete(&sender, id, name, DeleteKind::Workspace);
                rebuild = false;
            }
            Msg::DeleteScratch { id, label } => {
                self.confirm_delete(&sender, id, label, DeleteKind::Scratch);
                rebuild = false;
            }
            Msg::DeleteSelectedArchived => {
                self.delete_selected_archived(&sender);
                rebuild = false;
            }
            Msg::ImportToSandbox { id, name } => {
                self.import_to_sandbox(&sender, id, name);
                rebuild = false;
            }
            Msg::EjectFromSandbox { id, name } => {
                self.eject_from_sandbox(&sender, id, name);
                rebuild = false;
            }
            Msg::OpenAccountMenu {
                ws_id,
                current,
                anchor,
            } => {
                self.open_account_menu(&sender, ws_id, current, anchor);
                rebuild = false;
            }
            Msg::MigrateAccount {
                ws_id,
                account_id,
                target_label,
            } => {
                // Whether the agent was running BEFORE the move decides if a
                // `resumed:false` reply is worth reporting (a stopped agent is
                // expected not to resume).
                let was_running = self
                    .data
                    .workspaces
                    .iter()
                    .find(|w| w.id == ws_id)
                    .map(|w| w.status == WorkspaceStatus::Running)
                    .unwrap_or(false);
                self.migrate_account(ws_id, account_id, target_label, was_running);
                rebuild = false;
            }
            Msg::Promote(id) => {
                self.fire_and_forget("promoteWorkspace", vec![json!(id)]);
                rebuild = false;
            }
            Msg::Demote(id) => {
                self.fire_and_forget("demoteWorkspace", vec![json!(id)]);
                rebuild = false;
            }
            Msg::OpenAttachMenu { ws_id, anchor } => {
                self.open_attach_menu(&sender, ws_id, anchor);
                rebuild = false;
            }
            Msg::SetParent { ws_id, parent_id } => {
                // `null` is a first-class value here (detach), so the param is
                // always sent — json!(None::<String>) serializes to null.
                self.fire_and_forget("setWorkspaceParent", vec![json!(ws_id), json!(parent_id)]);
                rebuild = false;
            }
            Msg::DropWs {
                dragged,
                target,
                before,
            } => {
                self.commit_ws_drop(dragged, target, before);
                rebuild = false;
            }
            Msg::DropOnto { dragged, parent } => {
                // Guard here as well as at the drop target: only a coordinator
                // may take children, and a row may not adopt itself.
                let ok = dragged != parent
                    && self
                        .workspace(&parent)
                        .map(|w| w.can_orchestrate())
                        .unwrap_or(false);
                if ok {
                    self.fire_and_forget(
                        "setWorkspaceParent",
                        vec![json!(dragged), json!(Some(parent))],
                    );
                }
                rebuild = false;
            }
            Msg::DropRepo {
                dragged,
                target,
                before,
            } => {
                self.commit_repo_drop(dragged, target, before);
                rebuild = false;
            }
            Msg::MarkDeleting { id, on } => {
                if on {
                    self.deleting_ids.insert(id);
                } else {
                    self.deleting_ids.remove(&id);
                }
            }
            Msg::Backend(BackendEvent::Event { channel, args }) => {
                let ev = Event { channel, args };
                match ev.decode() {
                    Ok(decoded) => rebuild = self.apply_event(decoded),
                    Err(e) => {
                        eprintln!("[sidebar] undecodable event: {e}");
                        rebuild = false;
                    }
                }
            }
            Msg::Attach(backend) => {
                // App owns the single backend.events() consumer and forwards
                // each frame here as Msg::Backend, so the sidebar must NOT open
                // its own pump — a second async_channel receiver would steal
                // half the events (competing consumers). Re-emittable on
                // reconnect: it just re-hydrates the snapshot.
                self.backend = Some(backend);
                self.refresh_snapshot();
            }
            Msg::Rebuild => self.persist(),
        }
        if rebuild {
            self.rebuild();
        }
    }
}

/// Parse a reorder action param "<dragged>|<target>|<before|after>".
fn parse_reorder_param(s: &str) -> Option<(String, String, bool)> {
    let mut parts = s.splitn(3, '|');
    let dragged = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let before = match parts.next()? {
        "before" => true,
        "after" => false,
        _ => return None,
    };
    Some((dragged, target, before))
}

/// Parse a set-parent action param: "<ws>|<parent>" attaches, a bare "<ws>"
/// (or a trailing empty field) detaches. Detach must stay expressible, so an
/// absent parent is `None` rather than a parse failure.
fn parse_parent_param(s: &str) -> (String, Option<String>) {
    match s.split_once('|') {
        Some((ws, parent)) => {
            let parent = parent.trim();
            (
                ws.to_string(),
                (!parent.is_empty()).then(|| parent.to_string()),
            )
        }
        None => (s.to_string(), None),
    }
}

/// Install the `sidebar` action group (E2E driving — see the call site).
fn install_sidebar_actions(root: &gtk::Box, input: &relm4::Sender<Msg>, list: &gtk::ListBox) {
    let group = gio::SimpleActionGroup::new();
    let str_ty = Some(glib::VariantTy::STRING);

    let drop_ws = gio::SimpleAction::new("drop-ws", str_ty);
    {
        let input = input.clone();
        drop_ws.connect_activate(move |_, param| {
            if let Some((dragged, target, before)) =
                param.and_then(|p| p.str()).and_then(parse_reorder_param)
            {
                input.emit(Msg::DropWs {
                    dragged,
                    target,
                    before,
                });
            }
        });
    }
    group.add_action(&drop_ws);

    let drop_repo = gio::SimpleAction::new("drop-repo", str_ty);
    {
        let input = input.clone();
        drop_repo.connect_activate(move |_, param| {
            if let Some((dragged, target, before)) =
                param.and_then(|p| p.str()).and_then(parse_reorder_param)
            {
                input.emit(Msg::DropRepo {
                    dragged,
                    target,
                    before,
                });
            }
        });
    }
    group.add_action(&drop_repo);

    let start_rename = gio::SimpleAction::new("start-rename", str_ty);
    {
        let input = input.clone();
        start_rename.connect_activate(move |_, param| {
            if let Some(id) = param.and_then(|p| p.str()) {
                input.emit(Msg::StartRename(id.to_string()));
            }
        });
    }
    group.add_action(&start_rename);

    let commit_rename = gio::SimpleAction::new("commit-rename", str_ty);
    {
        let input = input.clone();
        let list = list.clone();
        commit_rename.connect_activate(move |_, param| {
            let Some(id) = param.and_then(|p| p.str()) else {
                return;
            };
            // Read the live rename Entry's text (the same value the
            // activate/blur handlers would commit) and drive CommitRename.
            let branch = find_named_entry(&list, "ws-rename-entry")
                .map(|e| e.text().to_string())
                .unwrap_or_default();
            input.emit(Msg::CommitRename {
                id: id.to_string(),
                branch,
            });
        });
    }
    group.add_action(&commit_rename);

    // Re-parenting actions. The promote/demote BUTTONS are named widgets the
    // harness can click directly; these exist so an E2E can also drive the
    // paths that have no plain button — attaching (whose target is chosen in a
    // popover) and DnD-onto (which needs a pointer to synthesize a drag).
    let promote = gio::SimpleAction::new("promote", str_ty);
    {
        let input = input.clone();
        promote.connect_activate(move |_, param| {
            if let Some(id) = param.and_then(|p| p.str()) {
                input.emit(Msg::Promote(id.to_string()));
            }
        });
    }
    group.add_action(&promote);

    let demote = gio::SimpleAction::new("demote", str_ty);
    {
        let input = input.clone();
        demote.connect_activate(move |_, param| {
            if let Some(id) = param.and_then(|p| p.str()) {
                input.emit(Msg::Demote(id.to_string()));
            }
        });
    }
    group.add_action(&demote);

    // "<ws>|<parent>" attaches; "<ws>" alone (or "<ws>|") detaches.
    let set_parent = gio::SimpleAction::new("set-parent", str_ty);
    {
        let input = input.clone();
        set_parent.connect_activate(move |_, param| {
            if let Some((ws_id, parent_id)) = param.and_then(|p| p.str()).map(parse_parent_param) {
                input.emit(Msg::SetParent { ws_id, parent_id });
            }
        });
    }
    group.add_action(&set_parent);

    root.insert_action_group("sidebar", Some(&group));
}

/// Depth-first search for a named [`gtk::Entry`] under a widget (the single
/// open rename entry — there is at most one at a time).
fn find_named_entry(root: &impl IsA<gtk::Widget>, name: &str) -> Option<gtk::Entry> {
    let mut child = root.as_ref().first_child();
    while let Some(c) = child {
        if c.widget_name() == name {
            if let Ok(e) = c.clone().downcast::<gtk::Entry>() {
                return Some(e);
            }
        }
        if let Some(found) = find_named_entry(&c, name) {
            return Some(found);
        }
        child = c.next_sibling();
    }
    None
}

fn build_footer(input: &relm4::Sender<Msg>) -> gtk::Box {
    // 2, not 8. `.sidebar-footer` computes to gap:2px in the running renderer
    // (oracle: getComputedStyle, styles.css:1012) — these are tight icon buttons,
    // and 8 was 4x the reference.
    let footer = gtk::Box::new(gtk::Orientation::Horizontal, 2);
    footer.add_css_class("sidebar-footer");
    footer.set_widget_name("sidebar-footer");
    let link = |glyph: &str, name: &str, tip: &str, url: &'static str| {
        let b = gtk::Button::with_label(glyph);
        b.set_widget_name(name);
        b.add_css_class("footer-link");
        b.set_tooltip_text(Some(tip));
        let input = input.clone();
        b.connect_clicked(move |_| input.emit(Msg::OpenExternal(url.to_string())));
        b
    };
    footer.append(&link(
        "GitHub",
        "footer-github",
        "Orchestra on GitHub",
        "https://github.com/lcsmas/orchestra",
    ));
    let logs = gtk::Button::with_label("Logs");
    logs.set_widget_name("footer-logs");
    logs.add_css_class("footer-link");
    logs.set_tooltip_text(Some("Reveal Orchestra's log directory"));
    {
        let input = input.clone();
        logs.connect_clicked(move |_| input.emit(Msg::RevealLogs));
    }
    footer.append(&logs);
    // Linear API key — the footer entry point Electron has at Sidebar.tsx:2294
    // (inventory row 77 lists it as missing from the GTK footer).
    let linear = gtk::Button::with_label("Linear");
    linear.set_widget_name("footer-linear");
    linear.add_css_class("footer-link");
    linear.set_tooltip_text(Some(
        "Linear API key — verify branch issue keys against Linear",
    ));
    {
        let input = input.clone();
        linear.connect_clicked(move |_| input.emit(Msg::OpenLinearSettings));
    }
    footer.append(&linear);
    footer
}

/// Which confirm copy a single-workspace delete uses.
enum DeleteKind {
    Workspace,
    Scratch,
}

impl Sidebar {
    /// Call a backend method, ignoring the reply. Errors surface as an async
    /// error dialog (parity with the Electron `dialog.error(...)` catches). The
    /// event pump drives the resulting UI change.
    /// Migrate a workspace to another login — the port of
    /// `AccountBadge.tsx:210` (`WorkspaceAccountMenu.migrate`).
    ///
    /// This is a DESTRUCTIVE action: the main process auto-stops the agent,
    /// relocates its Claude conversation into the target account's config dir,
    /// re-pins it, and resumes if it was running. So it is CONFIRMED first,
    /// exactly like Electron — a stray click must never restart a running
    /// agent.
    ///
    /// Failure needs no handling of its own: `migrateWorkspaceAccount` throws
    /// on `!ok` (`api-handlers.ts:357`), so it arrives as a method error and
    /// the shared error dialog covers it. What the raw call DID discard is the
    /// success payload — a migration that could not resume the agent looks
    /// identical to a clean one — so the result is read and a non-resumed
    /// migrate is reported. The badge repaints itself when the resulting
    /// `workspaceAccounts` / `workspaceUpdate` broadcast lands.
    fn migrate_account(
        &self,
        ws_id: String,
        account_id: Option<String>,
        target_label: String,
        was_running: bool,
    ) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let win = self.window.clone();
        glib::spawn_future_local(async move {
            let ok = dialogs::confirm(
                &win,
                "Migrate account",
                &format!(
                    "Migrate this workspace to \u{201c}{target_label}\u{201d}?\n\n\
                     Its Claude conversation moves into that account and the agent restarts \
                     (resuming where it left off if it was running)."
                ),
            )
            .await;
            if !ok {
                return;
            }
            match backend.call(
                "migrateWorkspaceAccount",
                vec![json!(ws_id), json!(account_id)],
            ) {
                Err(e) => {
                    dialogs::error(&win, "Could not migrate account", &e.to_string()).await;
                }
                Ok(v) => {
                    // The agent was running but could not be resumed — say so
                    // rather than letting it read as a clean migration. A
                    // stopped agent not resuming is expected, not news.
                    if let Ok(r) = serde_json::from_value::<MigrateAccountResult>(v) {
                        if was_running && r.resumed == Some(false) {
                            dialogs::alert(
                                &win,
                                "Migrated",
                                &format!(
                                    "This workspace now runs as \u{201c}{target_label}\u{201d}. \
                                     Its agent was not resumed — start it when you're ready."
                                ),
                            )
                            .await;
                        }
                    }
                }
            }
        });
    }

    fn fire_and_forget(&self, method: &'static str, params: Vec<Value>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        if let Err(e) = backend.call(method, params) {
            let win = self.window.clone();
            glib::spawn_future_local(async move {
                dialogs::error(&win, "Something went wrong", &e.to_string()).await;
            });
        }
    }

    /// A `Ctx` over this component's backend + toplevel, for the form modals
    /// in `crate::modals`. Built per-open rather than held: the sidebar's
    /// backend is swapped on attach, so a cached Ctx could serve a stale one.
    ///
    /// This hands the modals a CALL handle only — they never touch
    /// `events()`/`pty_data()`, which the App owns as the single consumer.
    fn modal_ctx(&self) -> Option<Rc<crate::ctx::Ctx>> {
        let backend = self.backend.clone()?;
        let ctx = crate::ctx::Ctx::new(self.window.clone());
        ctx.set_backend(Some(backend));
        Some(ctx)
    }

    /// Repo scripts modal (`RepoScriptsModal.tsx`) — replaces the stub the Run
    /// tab's guidance text points users at.
    fn open_repo_scripts(&self, repo_path: String) {
        let Some(ctx) = self.modal_ctx() else {
            return;
        };
        let repo_name = self
            .data
            .repos
            .iter()
            .find(|r| r.path == repo_path)
            .map(|r| r.name.clone())
            .unwrap_or_else(|| repo_path.clone());
        glib::spawn_future_local(async move {
            crate::modals::repo_scripts::open(ctx, repo_path, repo_name).await;
        });
    }

    /// Linear API-key modal (`LinearSettings.tsx`). A save or clear changes
    /// the configured source, so refresh the env-status notices — that is what
    /// Electron's `onChanged` does (LinearSettings.tsx:48).
    fn open_linear_settings(&self, sender: &ComponentSender<Self>) {
        let Some(ctx) = self.modal_ctx() else {
            return;
        };
        let sender = sender.input_sender().clone();
        glib::spawn_future_local(async move {
            if crate::modals::linear::open(ctx).await {
                sender.emit(Msg::RefreshEnvStatus);
            }
        });
    }

    #[allow(dead_code)]
    fn stub_modal(&self, _sender: &ComponentSender<Self>, title: &str, body: &str) {
        let win = self.window.clone();
        let title = title.to_string();
        let body = body.to_string();
        glib::spawn_future_local(async move {
            dialogs::alert(&win, &title, &body).await;
        });
    }

    fn create_scratch_like(&self, _sender: &ComponentSender<Self>, method: &'static str) {
        self.fire_and_forget(method, vec![]);
    }

    fn create_workspace(
        &self,
        _sender: &ComponentSender<Self>,
        repo_path: String,
        base_branch: Option<String>,
    ) {
        let input = CreateWorkspaceInput {
            repo_path,
            base_branch,
            task: None,
            agent: None,
            parent_id: None,
            host: None,
        };
        let value = serde_json::to_value(input).expect("CreateWorkspaceInput serializes");
        self.fire_and_forget("createWorkspace", vec![value]);
    }

    /// Right-click "+" → base-branch popover fed by `listRepoBranches`. Each
    /// entry creates a workspace off that base.
    fn open_base_picker(
        &self,
        sender: &ComponentSender<Self>,
        repo_path: String,
        repo_name: String,
        anchor: gtk::Widget,
    ) {
        let branches: Vec<String> = self
            .backend
            .as_ref()
            .and_then(|b| b.call("listRepoBranches", vec![json!(repo_path)]).ok())
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();

        let popover = gtk::Popover::new();
        popover.set_widget_name("base-picker");
        popover.set_parent(&anchor);
        let list = gtk::Box::new(gtk::Orientation::Vertical, 0);
        list.add_css_class("base-picker-list");
        let header = gtk::Label::new(Some(&format!("New workspace in {repo_name} — base:")));
        header.set_xalign(0.0);
        header.add_css_class("base-picker-header");
        list.append(&header);
        for branch in branches {
            let row = gtk::Button::with_label(&branch);
            row.set_widget_name(&format!("base-pick-{branch}"));
            row.add_css_class("base-picker-item");
            let sender = sender.clone();
            let repo_path = repo_path.clone();
            let popover = popover.clone();
            let branch_ = branch.clone();
            row.connect_clicked(move |_| {
                popover.popdown();
                sender.input(Msg::AddToRepo {
                    repo_path: repo_path.clone(),
                    base_branch: Some(branch_.clone()),
                });
            });
            list.append(&row);
        }
        popover.set_child(Some(&list));
        popover.popup();
    }

    /// "Attach to…" picker: every workspace that can orchestrate, minus this
    /// row, its current parent (already there) and its own descendants — a
    /// cycle the backend would reject anyway, so it is never offered. Plus a
    /// "Detach" entry when the row currently has a parent.
    fn open_attach_menu(&self, sender: &ComponentSender<Self>, ws_id: String, anchor: gtk::Widget) {
        let current_parent = self.workspace(&ws_id).and_then(|w| w.parent_id.clone());
        let descendants = self.descendants_of(&ws_id);
        let candidates: Vec<(String, String)> = self
            .data
            .workspaces
            .iter()
            .filter(|w| w.can_orchestrate())
            .filter(|w| w.archived != Some(true))
            .filter(|w| w.id != ws_id && !descendants.contains(&w.id))
            .filter(|w| Some(w.id.as_str()) != current_parent.as_deref())
            .map(|w| (w.id.clone(), w.branch.clone()))
            .collect();

        let popover = gtk::Popover::new();
        popover.set_widget_name("attach-picker");
        popover.set_parent(&anchor);
        let list = gtk::Box::new(gtk::Orientation::Vertical, 0);
        list.add_css_class("base-picker-list");
        let header = gtk::Label::new(Some(if candidates.is_empty() && current_parent.is_none() {
            "No coordinator to attach to"
        } else {
            "Attach under coordinator:"
        }));
        header.set_xalign(0.0);
        header.add_css_class("base-picker-header");
        list.append(&header);

        for (id, branch) in candidates {
            let row = gtk::Button::with_label(&branch);
            row.set_widget_name(&format!("attach-pick-{id}"));
            row.add_css_class("base-picker-item");
            let sender = sender.clone();
            let popover_ = popover.clone();
            let ws_id_ = ws_id.clone();
            let id_ = id.clone();
            row.connect_clicked(move |_| {
                popover_.popdown();
                sender.input(Msg::SetParent {
                    ws_id: ws_id_.clone(),
                    parent_id: Some(id_.clone()),
                });
            });
            list.append(&row);
        }

        if current_parent.is_some() {
            let row = gtk::Button::with_label("Detach — move to top level");
            row.set_widget_name(&format!("attach-detach-{ws_id}"));
            row.add_css_class("base-picker-item");
            let sender = sender.clone();
            let popover_ = popover.clone();
            let ws_id_ = ws_id.clone();
            row.connect_clicked(move |_| {
                popover_.popdown();
                sender.input(Msg::SetParent {
                    ws_id: ws_id_.clone(),
                    parent_id: None,
                });
            });
            list.append(&row);
        }

        popover.set_child(Some(&list));
        popover.popup();
    }

    /// Every workspace reachable downward from `root` (exclusive). Attaching a
    /// row under one of its own descendants would build a cycle, so these are
    /// filtered out of the picker.
    fn descendants_of(&self, root: &str) -> HashSet<String> {
        let mut out = HashSet::new();
        let mut frontier = vec![root.to_string()];
        while let Some(cur) = frontier.pop() {
            for w in &self.data.workspaces {
                if w.parent_id.as_deref() == Some(cur.as_str()) && out.insert(w.id.clone()) {
                    frontier.push(w.id.clone());
                }
            }
        }
        out
    }

    /// Map a git repo in via the native folder picker (`pickDirectory` is
    /// frontend-local — a GtkFileDialog — then `addRepo` with the path).
    fn add_repo(&self, sender: &ComponentSender<Self>) {
        let dialog = gtk::FileDialog::builder()
            .title("Map a git repository")
            .modal(true)
            .build();
        let win = self.window.clone();
        let sender = sender.clone();
        dialog.select_folder(Some(&win), gio::Cancellable::NONE, move |result| {
            if let Ok(folder) = result {
                if let Some(path) = folder.path() {
                    sender.input(Msg::DoAddRepo(path.to_string_lossy().to_string()));
                }
            }
        });
    }

    fn remove_repo(&self, sender: &ComponentSender<Self>, repo_path: String) {
        let name = self
            .data
            .repos
            .iter()
            .find(|r| r.path == repo_path)
            .map(|r| r.name.clone())
            .unwrap_or_else(|| {
                repo_path
                    .rsplit('/')
                    .find(|s| !s.is_empty())
                    .unwrap_or(&repo_path)
                    .to_string()
            });
        let backend = self.backend.clone();
        let win = self.window.clone();
        let _ = sender;
        glib::spawn_future_local(async move {
            let ok = dialogs::confirm(
                &win,
                "Remove repo",
                &format!(
                    "Remove \"{name}\" from Orchestra?\n\nThis only un-maps the repo from Orchestra — your git repository on disk is left untouched."
                ),
            )
            .await;
            if !ok {
                return;
            }
            if let Some(backend) = backend {
                if let Err(e) = backend.call("removeRepo", vec![json!(repo_path)]) {
                    dialogs::error(&win, "Could not remove repo", &e.to_string()).await;
                }
            }
        });
    }

    fn confirm_delete(
        &self,
        sender: &ComponentSender<Self>,
        id: String,
        label: String,
        kind: DeleteKind,
    ) {
        let (title, body) = match kind {
            DeleteKind::Workspace => (
                "Delete workspace",
                format!(
                    "Delete \"{label}\" permanently?\n\nThis removes the git worktree from disk."
                ),
            ),
            DeleteKind::Scratch => (
                "Delete scratch session",
                format!(
                    "Delete scratch session \"{label}\"?\n\nThis removes its working directory and conversation from disk. Scratch sessions are not tracked by git, so this cannot be undone."
                ),
            ),
        };
        let backend = self.backend.clone();
        let win = self.window.clone();
        let sender = sender.clone();
        glib::spawn_future_local(async move {
            let ok = dialogs::confirm(&win, title, &body).await;
            if !ok {
                return;
            }
            sender.input(Msg::MarkDeleting {
                id: id.clone(),
                on: true,
            });
            if let Some(backend) = backend {
                if let Err(e) = backend.call("deleteWorkspace", vec![json!(id)]) {
                    dialogs::error(&win, "Could not delete", &e.to_string()).await;
                    sender.input(Msg::MarkDeleting {
                        id: id.clone(),
                        on: false,
                    });
                }
            }
            // Success drops the row via workspaceRemoved; the spinner clears
            // with it. (The MarkDeleting(false) on error path restores it.)
        });
    }

    fn delete_selected_archived(&self, sender: &ComponentSender<Self>) {
        let ids: Vec<String> = self
            .data
            .workspaces
            .iter()
            .filter(|w| w.archived == Some(true) && self.selected_archived.contains(&w.id))
            .map(|w| w.id.clone())
            .collect();
        if ids.is_empty() {
            return;
        }
        let n = ids.len();
        let (title, body, confirm) = if n == 1 {
            (
                "Delete workspace".to_string(),
                "Delete the selected workspace permanently?\n\nThis removes the git worktree from disk.".to_string(),
                "Delete".to_string(),
            )
        } else {
            (
                "Delete archived workspaces".to_string(),
                format!(
                    "Delete {n} archived workspaces permanently?\n\nThis removes all selected git worktrees from disk."
                ),
                format!("Delete {n}"),
            )
        };
        let backend = self.backend.clone();
        let win = self.window.clone();
        let sender = sender.clone();
        glib::spawn_future_local(async move {
            // Destructive confirm with the computed label ("Delete" / "Delete N"),
            // matching Electron (Sidebar.tsx:893-894 sets tone 'danger' and the
            // same confirmLabel). Wording and behaviour are unchanged — the label
            // was already computed above and previously discarded.
            let ok = dialogs::confirm_destructive(&win, &title, &body, &confirm).await;
            if !ok {
                return;
            }
            for id in &ids {
                sender.input(Msg::MarkDeleting {
                    id: id.clone(),
                    on: true,
                });
            }
            // Bulk progress rides the onWorkspacesDeleteProgress event pump.
            if let Some(backend) = backend {
                let payload = serde_json::to_value(&ids).unwrap();
                if let Err(e) = backend.call("deleteWorkspaces", vec![payload]) {
                    dialogs::error(&win, "Could not delete workspaces", &e.to_string()).await;
                    for id in &ids {
                        sender.input(Msg::MarkDeleting {
                            id: id.clone(),
                            on: false,
                        });
                    }
                }
            }
        });
    }

    fn import_to_sandbox(&self, sender: &ComponentSender<Self>, id: String, name: String) {
        let prefill = self
            .state
            .borrow()
            .last_sandbox_endpoint
            .clone()
            .unwrap_or_default();
        let backend = self.backend.clone();
        let win = self.window.clone();
        let state = self.state.clone();
        let state_path = self.state_path.clone();
        let sender = sender.clone();
        glib::spawn_future_local(async move {
            let body = format!(
                "Move \"{name}\" into an always-on sandbox?\n\nThe checkout (including uncommitted changes) is shipped to the sandbox container, and the local worktree is retired. The terminal then streams from the sandbox."
            );
            // The dialog's placeholder is the Electron placeholder; the prefill
            // rides in as initial text when we have a last endpoint.
            let placeholder = if prefill.is_empty() {
                "ws://sandbox-host:8787".to_string()
            } else {
                prefill
            };
            let Some(endpoint) =
                dialogs::prompt(&win, "Import to sandbox", &body, &placeholder).await
            else {
                return;
            };
            if endpoint.trim().is_empty() {
                return;
            }
            sender.input(Msg::MarkDeleting {
                id: id.clone(),
                on: true,
            });
            if let Some(backend) = backend {
                match backend.call("importToSandbox", vec![json!(id), json!(endpoint)]) {
                    Ok(_) => {
                        state.borrow_mut().last_sandbox_endpoint = Some(endpoint);
                        let _ = state.borrow().save(&state_path);
                    }
                    Err(e) => {
                        dialogs::error(&win, "Could not import to sandbox", &e.to_string()).await;
                    }
                }
            }
            sender.input(Msg::MarkDeleting { id, on: false });
        });
    }

    fn eject_from_sandbox(&self, sender: &ComponentSender<Self>, id: String, name: String) {
        let backend = self.backend.clone();
        let win = self.window.clone();
        let sender = sender.clone();
        glib::spawn_future_local(async move {
            let body = format!(
                "Move \"{name}\" back from its sandbox?\n\nA live export (history + uncommitted changes) is pulled from the container — and saved as a backup — then the workspace becomes a local worktree again. The container keeps its copy but its agent is stopped."
            );
            let ok = dialogs::confirm(&win, "Return to this machine", &body).await;
            if !ok {
                return;
            }
            sender.input(Msg::MarkDeleting {
                id: id.clone(),
                on: true,
            });
            if let Some(backend) = backend {
                if let Err(e) = backend.call("ejectFromSandbox", vec![json!(id)]) {
                    dialogs::error(
                        &win,
                        "Could not return workspace from sandbox",
                        &e.to_string(),
                    )
                    .await;
                }
            }
            sender.input(Msg::MarkDeleting { id, on: false });
        });
    }

    /// Account badge → migrate menu: every known account plus "default", each a
    /// `migrateWorkspaceAccount`. Accounts come from the backend's account list
    /// when available; the current one is checked and inert.
    fn open_account_menu(
        &self,
        sender: &ComponentSender<Self>,
        ws_id: String,
        current: Option<String>,
        anchor: gtk::Widget,
    ) {
        // (account id, display label). The default login always leads, then
        // every configured account — shown BY LABEL, never by id.
        let mut accounts: Vec<(Option<String>, String)> =
            vec![(None, DEFAULT_LOGIN_LABEL.to_string())];
        if let Some(backend) = &self.backend {
            if let Ok(v) = backend.call("listAccounts", vec![]) {
                if let Ok(list) = serde_json::from_value::<Vec<AccountBrief>>(v) {
                    for a in list {
                        accounts.push((Some(a.id), a.label));
                    }
                }
            }
        }
        let popover = gtk::Popover::new();
        popover.set_widget_name("account-menu");
        popover.set_parent(&anchor);
        let list = gtk::Box::new(gtk::Orientation::Vertical, 0);
        list.add_css_class("account-menu-list");
        for (account, label) in accounts {
            let is_current = account.as_deref() == current.as_deref();
            // Login-color dot + label, mirroring the Electron menu options.
            let row = gtk::Button::new();
            let content = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            let dot = gtk::Label::new(None);
            dot.add_css_class("dot");
            dot.set_valign(gtk::Align::Center);
            dot.set_markup(&format!(
                "<span foreground=\"{}\">\u{25cf}</span>",
                login_color_hex(&label)
            ));
            content.append(&dot);
            let text = gtk::Label::new(Some(&if is_current {
                format!("\u{2713} {label}")
            } else {
                label.clone()
            }));
            text.set_xalign(0.0);
            content.append(&text);
            row.set_child(Some(&content));
            row.set_widget_name(&format!("account-pick-{label}"));
            row.add_css_class("account-menu-item");
            row.set_sensitive(!is_current);
            let sender = sender.clone();
            let ws_id = ws_id.clone();
            let popover = popover.clone();
            row.connect_clicked(move |_| {
                popover.popdown();
                sender.input(Msg::MigrateAccount {
                    ws_id: ws_id.clone(),
                    account_id: account.clone(),
                    target_label: label.clone(),
                });
            });
            list.append(&row);
        }
        popover.set_child(Some(&list));
        popover.popup();
    }

    /// Commit a workspace move (port of `commitWsDrop`): pull the dragged id out
    /// of the full store order and re-insert it before/after the target, then
    /// persist via `reorderWorkspaces`.
    fn commit_ws_drop(&self, dragged: String, target: String, before: bool) {
        if dragged == target {
            return;
        }
        let mut ids: Vec<String> = self.data.workspaces.iter().map(|w| w.id.clone()).collect();
        let Some(from) = ids.iter().position(|i| i == &dragged) else {
            return;
        };
        ids.remove(from);
        let Some(mut to) = ids.iter().position(|i| i == &target) else {
            return;
        };
        if !before {
            to += 1;
        }
        ids.insert(to, dragged);
        self.fire_and_forget(
            "reorderWorkspaces",
            vec![serde_json::to_value(ids).unwrap()],
        );
    }

    /// Port of `commitRepoDrop` over the full repo path order.
    fn commit_repo_drop(&self, dragged: String, target: String, before: bool) {
        if dragged == target {
            return;
        }
        let mut paths: Vec<String> = self.data.repos.iter().map(|r| r.path.clone()).collect();
        let Some(from) = paths.iter().position(|p| p == &dragged) else {
            return;
        };
        paths.remove(from);
        let Some(mut to) = paths.iter().position(|p| p == &target) else {
            return;
        };
        if !before {
            to += 1;
        }
        paths.insert(to, dragged);
        self.fire_and_forget("reorderRepos", vec![serde_json::to_value(paths).unwrap()]);
    }
}

/// Minimal account row for the migrate menu + badge: the id identifies the
/// account on the wire, the label is what the user ever sees.
#[derive(serde::Deserialize)]
struct AccountBrief {
    id: String,
    label: String,
}

#[cfg(test)]
mod tests {
    use super::{parse_parent_param, parse_reorder_param};

    #[test]
    fn parent_param_attaches_and_detaches() {
        assert_eq!(
            parse_parent_param("ws-1|orch-1"),
            ("ws-1".to_string(), Some("orch-1".to_string()))
        );
        // Detach must stay expressible: a bare id and an empty trailing field
        // both mean "no parent", not a parse failure.
        assert_eq!(parse_parent_param("ws-1"), ("ws-1".to_string(), None));
        assert_eq!(parse_parent_param("ws-1|"), ("ws-1".to_string(), None));
    }

    #[test]
    fn reorder_param_parses_before_after() {
        assert_eq!(
            parse_reorder_param("ws-1|ws-2|before"),
            Some(("ws-1".into(), "ws-2".into(), true))
        );
        assert_eq!(
            parse_reorder_param("repo:/a|repo:/b|after"),
            Some(("repo:/a".into(), "repo:/b".into(), false))
        );
    }

    #[test]
    fn reorder_param_rejects_malformed() {
        assert_eq!(parse_reorder_param("only-two|parts"), None);
        assert_eq!(parse_reorder_param("a|b|sideways"), None);
        assert_eq!(parse_reorder_param(""), None);
    }
}
