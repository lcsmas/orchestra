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
use orchestra_rpc::types::{CreateWorkspaceInput, EnvStatusItem, RepoSyncState, Workspace};
use serde_json::{json, Value};

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
    RemoveRepo(String),
    SyncRepoBase(String),
    AddRepo,
    /// Second half of AddRepo: the folder picker resolved to this path.
    DoAddRepo(String),
    RevealLogs,
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
    },
    // ---- drag & drop -----------------------------------------------------
    DropWs {
        dragged: String,
        target: String,
        before: bool,
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
        let ui = self.ui();
        let rows = compute_rows(&self.data, &ui);

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
        self.selecting.set(true);
        match &selected_row {
            Some(row) => self.list.select_row(Some(row)),
            None => self.list.unselect_all(),
        }
        self.selecting.set(false);

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
        for item in notices {
            self.notices_box.append(&self.build_notice(&item));
        }
    }

    fn build_notice(&self, item: &EnvStatusItem) -> gtk::Box {
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        row.add_css_class("env-notice");
        row.set_widget_name(&format!("env-notice-{}", item.id));
        let text = gtk::Label::new(Some(&format!("{}: {}", item.label, item.detail)));
        text.set_xalign(0.0);
        text.set_wrap(true);
        text.set_hexpand(true);
        row.append(&text);
        let dismiss = gtk::Button::with_label("✕");
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
            // Channels the sidebar doesn't render (usage bars, accounts, pty,
            // self-tune) are owned by sibling workstreams.
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

/// Header action button (the top strip: Help / Bell / Accounts / Scratch /
/// Orchestrator / + Repo).
fn header_button(
    label: &str,
    name: &str,
    tooltip: &str,
    sender: &relm4::Sender<Msg>,
    msg: impl Fn() -> Msg + 'static,
) -> gtk::Button {
    let b = gtk::Button::with_label(label);
    b.set_widget_name(name);
    b.add_css_class("sidebar-header-btn");
    b.set_tooltip_text(Some(tooltip));
    let sender = sender.clone();
    b.connect_clicked(move |_| sender.emit(msg()));
    b
}

impl Component for Sidebar {
    type Init = SidebarInit;
    type Input = Msg;
    type Output = ();
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
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        header.add_css_class("sidebar-header");
        header.set_widget_name("sidebar-header");
        let title = gtk::Label::new(Some("WORKSPACES"));
        title.set_xalign(0.0);
        title.add_css_class("sidebar-title");
        title.set_widget_name("sidebar-title");
        title.set_hexpand(true);
        header.append(&title);
        header.append(&header_button(
            "+ Repo",
            "header-add-repo",
            "Map a git repo into Orchestra",
            &input,
            || Msg::AddRepo,
        ));
        header.append(&header_button(
            "⚡",
            "header-new-scratch",
            "New scratch session",
            &input,
            || Msg::NewScratch,
        ));
        header.append(&header_button(
            "🌿",
            "header-new-orchestrator",
            "New orchestrator",
            &input,
            || Msg::NewOrchestrator,
        ));
        root.append(&header);

        // ---- scrolling row list -----------------------------------------
        let scroll = gtk::ScrolledWindow::new();
        scroll.set_vexpand(true);
        scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        let list = gtk::ListBox::new();
        list.set_widget_name("sidebar-list");
        list.set_selection_mode(gtk::SelectionMode::Single);
        scroll.set_child(Some(&list));
        root.append(&scroll);

        // ---- env-notice tray + insights/usage slots + footer ------------
        let notices_box = gtk::Box::new(gtk::Orientation::Vertical, 4);
        notices_box.add_css_class("env-notices");
        notices_box.set_widget_name("env-notices");
        notices_box.set_visible(false);
        root.append(&notices_box);

        // Placeholder mount points the sibling Insights / usage-bars
        // workstreams attach into (kept from day one so the layout is stable).
        let insights_slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
        insights_slot.set_widget_name("insights-slot");
        root.append(&insights_slot);
        let usage_slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
        usage_slot.set_widget_name("usage-bars-slot");
        root.append(&usage_slot);

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
            notices_box,
            row_cache: HashMap::new(),
            window,
            sender_handle: input.clone(),
        };
        model.active_id = model.state.borrow().last_active_workspace.clone();

        if let Some(backend) = model.backend.clone() {
            model.refresh_snapshot();
            pump_events(backend, input.clone());
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
                    self.state.borrow_mut().last_active_workspace = Some(id);
                    self.schedule_save(&sender);
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
            Msg::OpenRepoScripts(_path) => {
                // Modal CONTENT is a sibling workstream (B3/B4); stub-open.
                self.stub_modal(
                    &sender,
                    "Repo scripts",
                    "The setup/run/archive script editor is a separate M2 workstream.",
                );
                rebuild = false;
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
            Msg::MigrateAccount { ws_id, account_id } => {
                self.fire_and_forget(
                    "migrateWorkspaceAccount",
                    vec![json!(ws_id), json!(account_id)],
                );
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
                self.backend = Some(backend.clone());
                self.refresh_snapshot();
                pump_events(backend, self.sender_handle.clone());
            }
            Msg::Rebuild => self.persist(),
        }
        if rebuild {
            self.rebuild();
        }
    }
}

/// Consume the backend's push channel on the GTK main context, forwarding each
/// frame as a [`Msg::Backend`]. One consumer per attach.
fn pump_events(backend: Rc<dyn Backend>, input: relm4::Sender<Msg>) {
    let rx = backend.events();
    glib::spawn_future_local(async move {
        while let Ok(ev) = rx.recv().await {
            input.emit(Msg::Backend(ev));
        }
    });
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
    let footer = gtk::Box::new(gtk::Orientation::Horizontal, 8);
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
        let _ = confirm; // dialog confirm label is fixed in our dialog system
        let backend = self.backend.clone();
        let win = self.window.clone();
        let sender = sender.clone();
        glib::spawn_future_local(async move {
            let ok = dialogs::confirm(&win, &title, &body).await;
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
        let mut accounts: Vec<Option<String>> = vec![None]; // "default"
        if let Some(backend) = &self.backend {
            if let Ok(v) = backend.call("listAccounts", vec![]) {
                if let Ok(list) = serde_json::from_value::<Vec<AccountBrief>>(v) {
                    for a in list {
                        accounts.push(Some(a.id));
                    }
                }
            }
        }
        let popover = gtk::Popover::new();
        popover.set_widget_name("account-menu");
        popover.set_parent(&anchor);
        let list = gtk::Box::new(gtk::Orientation::Vertical, 0);
        list.add_css_class("account-menu-list");
        for account in accounts {
            let is_current = account.as_deref() == current.as_deref();
            let label = account.clone().unwrap_or_else(|| "default".to_string());
            let row = gtk::Button::with_label(&if is_current {
                format!("✓ {label}")
            } else {
                label.clone()
            });
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

/// Minimal account row for the migrate menu.
#[derive(serde::Deserialize)]
struct AccountBrief {
    id: String,
}

#[cfg(test)]
mod tests {
    use super::parse_reorder_param;

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
