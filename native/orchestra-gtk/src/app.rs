//! App shell (plan §5.6): root Relm4 component — window, sidebar/main split
//! with drag-persisted width, overlay host for future Resources/Insights/Help
//! panes, backend-discovery banner, status strip, debug menu for the dialog
//! system. The sidebar list here is a mock-fed placeholder; the real sidebar
//! (factories, spawn trees, pills) is a separate M2 workstream.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gtk::gio;
use gtk::glib;
use gtk::pango;
use gtk::prelude::*;
use relm4::prelude::*;

use orchestra_rpc::types::{Workspace, WorkspaceStatus};
use orchestra_rpc::{BackendKind as RemoteKind, ConnectionState, UiEvent};

use crate::backend::{self, Backend, BackendEvent, BackendKind, MockBackend, RpcBackend};
use crate::dialogs;
use crate::remote_control;
use crate::state::{self, UiState, WindowGeometry};
use crate::terminal::{PaneIntent, TerminalStack};

pub struct Init {
    pub remote_control: Option<PathBuf>,
}

const NO_BACKEND_BANNER: &str =
    "no backend found — start Orchestra or the daemon (retrying every 3s)";

pub struct App {
    backend: Option<Box<dyn Backend>>,
    workspaces: Vec<Workspace>,
    state: Rc<RefCell<UiState>>,
    state_path: PathBuf,
    /// Debounce generation for state saves: each change bumps it; only the
    /// timer holding the latest generation actually persists.
    save_generation: Rc<Cell<u64>>,
    /// Discovery retry loop runs only while no backend is attached.
    retry_active: Rc<Cell<bool>>,
    window: gtk::ApplicationWindow,
    paned: gtk::Paned,
    list: gtk::ListBox,
    banner: gtk::Revealer,
    banner_label: gtk::Label,
    footer_label: gtk::Label,
    /// Kept-alive terminals, one pane per workspace (plan §5.2).
    terminals: TerminalStack,
}

#[derive(Debug)]
pub enum Msg {
    RowSelected(i32),
    SidebarResized(i32),
    WindowGeometryChanged,
    RetryDiscover,
    PersistNow,
    /// Window focus-in/out → `focus` frame (backend ORs over all clients).
    FocusChanged(bool),
    /// Connection lifecycle from the RpcBackend's state stream.
    Connection(ConnectionState),
    /// An `event` frame from the backend.
    BackendEvent(BackendEvent),
    /// A `ptyData` frame routed to the terminal stack.
    PtyData(String, Vec<u8>),
    /// A terminal pane wants the backend to do something (App owns the backend).
    Pane(PaneIntent),
}

fn status_css(status: WorkspaceStatus) -> &'static str {
    match status {
        WorkspaceStatus::Idle => "idle",
        WorkspaceStatus::Running => "running",
        WorkspaceStatus::Waiting => "waiting",
        WorkspaceStatus::Error => "error",
        WorkspaceStatus::Stopped => "stopped",
    }
}

/// Plain placeholder rows (dot + name + branch), prototype-style. The M2
/// sidebar workstream replaces this with Relm4 factories.
fn populate_sidebar(list: &gtk::ListBox, workspaces: &[Workspace], selected_id: Option<&str>) {
    while let Some(row) = list.row_at_index(0) {
        list.remove(&row);
    }
    for ws in workspaces {
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        dot.add_css_class("ws-dot");
        dot.add_css_class(status_css(ws.status));
        dot.set_valign(gtk::Align::Center);
        let col = gtk::Box::new(gtk::Orientation::Vertical, 1);
        let name = gtk::Label::new(Some(&ws.name));
        name.set_xalign(0.0);
        name.set_ellipsize(pango::EllipsizeMode::End);
        name.add_css_class("ws-name");
        let branch = gtk::Label::new(Some(&ws.branch));
        branch.set_xalign(0.0);
        branch.set_ellipsize(pango::EllipsizeMode::End);
        branch.add_css_class("ws-branch");
        col.append(&name);
        col.append(&branch);
        row.append(&dot);
        row.append(&col);
        // Name the ListBoxRow itself (not the inner box): that's the widget
        // the remote-control click op selects/activates.
        let list_row = gtk::ListBoxRow::new();
        list_row.set_widget_name(&format!("ws-row-{}", ws.id));
        list_row.set_child(Some(&row));
        list.append(&list_row);
    }
    let selected_index = selected_id
        .and_then(|id| workspaces.iter().position(|w| w.id == id))
        .unwrap_or(0);
    if let Some(row) = list.row_at_index(selected_index as i32) {
        list.select_row(Some(&row));
    }
}

fn make_backend() -> Option<Box<dyn Backend>> {
    if backend::mock_requested() {
        return Some(Box::new(MockBackend::default()));
    }
    let sock = backend::discover_socket(&state::orchestra_home())?;
    match RpcBackend::connect(sock) {
        Ok(b) => Some(Box::new(b)),
        Err(e) => {
            eprintln!("[backend] connect failed: {e}");
            None
        }
    }
}

fn footer_text(backend: &Option<Box<dyn Backend>>) -> String {
    let frontend = env!("CARGO_PKG_VERSION");
    match backend {
        Some(b) => match b.kind() {
            BackendKind::Mock => {
                format!("backend: mock v{} · frontend v{frontend}", b.version())
            }
            BackendKind::Rpc => {
                let remote = match b.server_kind() {
                    Some(RemoteKind::Electron) => "electron",
                    Some(RemoteKind::Daemon) => "daemon",
                    None => "rpc",
                };
                format!("backend: {remote} v{} · frontend v{frontend}", b.version())
            }
        },
        None => format!("backend: none · frontend v{frontend}"),
    }
}

/// Forward a backend's push streams into the component's input queue. Runs on
/// the GTK main loop (async_channel receivers are futures); each loop ends
/// when the backend (and thus its bridge threads) is dropped.
///
/// pty frames are the terminal stack's alone (single consumer — see
/// `Backend::pty_data`): each `(id, bytes)` becomes a `Msg::PtyData` the
/// component routes to the matching pane's `feed()`.
fn spawn_backend_streams(sender: &ComponentSender<App>, backend: &dyn Backend) {
    let events = backend.events();
    let s = sender.clone();
    glib::spawn_future_local(async move {
        while let Ok(ev) = events.recv().await {
            s.input(Msg::BackendEvent(ev));
        }
    });
    let states = backend.connection_state();
    let s = sender.clone();
    glib::spawn_future_local(async move {
        while let Ok(state) = states.recv().await {
            s.input(Msg::Connection(state));
        }
    });
    let pty = backend.pty_data();
    let s = sender.clone();
    glib::spawn_future_local(async move {
        while let Ok((id, bytes)) = pty.recv().await {
            s.input(Msg::PtyData(id, bytes));
        }
    });
}

/// Debug menu (status strip): demoes the promise-shaped dialog system.
fn install_demo_actions(window: &gtk::ApplicationWindow) {
    let group = gio::SimpleActionGroup::new();
    let win = window.clone().upcast::<gtk::Window>();

    let add = |name: &str, run: Box<dyn Fn(gtk::Window) + 'static>| {
        let action = gio::SimpleAction::new(name, None);
        let win = win.clone();
        action.connect_activate(move |_, _| run(win.clone()));
        group.add_action(&action);
    };

    add(
        "alert",
        Box::new(|win| {
            glib::spawn_future_local(async move {
                dialogs::alert(&win, "Alert", "This is the promise-shaped alert dialog.").await;
                eprintln!("[demo] alert resolved");
            });
        }),
    );
    add(
        "confirm",
        Box::new(|win| {
            glib::spawn_future_local(async move {
                let yes = dialogs::confirm(&win, "Confirm", "Proceed with the demo action?").await;
                eprintln!("[demo] confirm resolved: {yes}");
            });
        }),
    );
    add(
        "prompt",
        Box::new(|win| {
            glib::spawn_future_local(async move {
                let text = dialogs::prompt(&win, "Prompt", "Name this demo:", "type here…").await;
                eprintln!("[demo] prompt resolved: {text:?}");
            });
        }),
    );
    add(
        "error",
        Box::new(|win| {
            glib::spawn_future_local(async move {
                dialogs::error(&win, "Error", "Something demo-shaped went wrong.").await;
                eprintln!("[demo] error resolved");
            });
        }),
    );
    add(
        "success",
        Box::new(|win| {
            glib::spawn_future_local(async move {
                dialogs::success(&win, "Success", "The demo action completed.").await;
                eprintln!("[demo] success resolved");
            });
        }),
    );

    window.insert_action_group("demo", Some(&group));
}

#[relm4::component(pub)]
impl SimpleComponent for App {
    type Init = Init;
    type Input = Msg;
    type Output = ();

    view! {
        #[name = "main_window"]
        gtk::ApplicationWindow {
            set_title: Some("Orchestra"),
            set_default_size: (1400, 900),
            set_widget_name: "main-window",

            gtk::Box {
                set_orientation: gtk::Orientation::Vertical,
                set_widget_name: "root",

                // Non-blocking backend-discovery banner (plan §1.1: the GTK
                // app is a pure frontend; without a backend it still opens).
                #[name = "banner"]
                gtk::Revealer {
                    set_widget_name: "backend-banner",
                    set_reveal_child: false,

                    gtk::Box {
                        add_css_class: "banner",

                        #[name = "banner_label"]
                        gtk::Label {
                            set_widget_name: "backend-banner-text",
                            set_label: NO_BACKEND_BANNER,
                            set_xalign: 0.0,
                            set_hexpand: true,
                        },
                    },
                },

                // [sidebar | drag resizer | main area] — the Paned handle is
                // the resizer; its position is the persisted sidebar width.
                #[name = "paned"]
                gtk::Paned {
                    set_orientation: gtk::Orientation::Horizontal,
                    set_widget_name: "root-paned",
                    set_vexpand: true,
                    set_position: 280,
                    set_shrink_start_child: false,
                    // Window resizes flex the main area only — otherwise
                    // GtkPaned rescales the position proportionally and the
                    // persisted sidebar width drifts on every launch.
                    set_resize_start_child: false,

                    #[wrap(Some)]
                    set_start_child = &gtk::Box {
                        set_orientation: gtk::Orientation::Vertical,
                        add_css_class: "sidebar",
                        set_widget_name: "sidebar",
                        set_width_request: 200,

                        gtk::Label {
                            set_label: "WORKSPACES",
                            set_xalign: 0.0,
                            add_css_class: "sidebar-title",
                            set_widget_name: "sidebar-title",
                        },

                        gtk::ScrolledWindow {
                            set_vexpand: true,
                            set_hscrollbar_policy: gtk::PolicyType::Never,

                            #[name = "list"]
                            gtk::ListBox {
                                set_widget_name: "sidebar-list",
                                set_selection_mode: gtk::SelectionMode::Single,
                                connect_row_selected[sender] => move |_, row| {
                                    if let Some(row) = row {
                                        sender.input(Msg::RowSelected(row.index()));
                                    }
                                },
                            },
                        },
                    },

                    // Overlay host (plan §5.3): Resources / Insights / Help
                    // attach as overlay children in M2 — overlays must never
                    // unmount the main area, hence the GtkOverlay layering
                    // exists from day one.
                    #[wrap(Some)]
                    set_end_child = &gtk::Overlay {
                        set_widget_name: "overlay-host",

                        #[wrap(Some)]
                        #[name = "main_area"]
                        set_child = &gtk::Box {
                            add_css_class: "main-area",
                            set_widget_name: "main-area",
                            // The terminal stack is appended in init() (it needs
                            // the runtime `sender` to route pane intents).
                        },
                    },
                },

                gtk::Box {
                    set_orientation: gtk::Orientation::Horizontal,
                    add_css_class: "status-strip",
                    set_widget_name: "status-strip",

                    #[name = "footer_label"]
                    gtk::Label {
                        set_widget_name: "status-text",
                        add_css_class: "status-text",
                        set_xalign: 0.0,
                        set_hexpand: true,
                    },

                    #[name = "debug_menu"]
                    gtk::MenuButton {
                        set_widget_name: "debug-menu",
                        set_label: "debug",
                        set_direction: gtk::ArrowType::Up,
                    },
                },
            },
        }
    }

    fn init(
        init: Self::Init,
        root: Self::Root,
        sender: ComponentSender<Self>,
    ) -> ComponentParts<Self> {
        relm4::set_global_css(include_str!("theme.css"));
        if let Some(settings) = gtk::Settings::default() {
            settings.set_gtk_application_prefer_dark_theme(true);
        }

        let state_path = state::state_path(&state::orchestra_home());
        let state = Rc::new(RefCell::new(UiState::load(&state_path)));
        let backend = make_backend();

        let widgets = view_output!();

        // Restore persisted geometry/sidebar width before first present.
        {
            let st = state.borrow();
            if let Some(geometry) = st.window {
                widgets
                    .main_window
                    .set_default_size(geometry.width, geometry.height);
                if geometry.maximized {
                    widgets.main_window.maximize();
                }
            }
            widgets.paned.set_position(st.sidebar_width.unwrap_or(280));
        }
        {
            let sender = sender.clone();
            widgets
                .paned
                .connect_notify_local(Some("position"), move |paned, _| {
                    sender.input(Msg::SidebarResized(paned.position()));
                });
        }
        {
            let sender = sender.clone();
            widgets.main_window.connect_default_width_notify(move |_| {
                sender.input(Msg::WindowGeometryChanged);
            });
        }
        {
            let sender = sender.clone();
            widgets.main_window.connect_default_height_notify(move |_| {
                sender.input(Msg::WindowGeometryChanged);
            });
        }
        // Flush state synchronously on close — a debounced save may still be
        // pending, and the main loop quits right after this.
        {
            let state = state.clone();
            let path = state_path.clone();
            widgets.main_window.connect_close_request(move |win| {
                {
                    let mut st = state.borrow_mut();
                    st.window = Some(WindowGeometry {
                        width: win.default_width(),
                        height: win.default_height(),
                        maximized: win.is_maximized(),
                    });
                }
                if let Err(e) = state.borrow().save(&path) {
                    eprintln!("[state] save on close failed: {e}");
                }
                glib::Propagation::Proceed
            });
        }

        install_demo_actions(&widgets.main_window);
        let menu = gio::Menu::new();
        menu.append(Some("Alert demo"), Some("demo.alert"));
        menu.append(Some("Confirm demo"), Some("demo.confirm"));
        menu.append(Some("Prompt demo"), Some("demo.prompt"));
        menu.append(Some("Error demo"), Some("demo.error"));
        menu.append(Some("Success demo"), Some("demo.success"));
        widgets.debug_menu.set_menu_model(Some(&menu));

        if let Some(sock) = init.remote_control {
            remote_control::serve(sock);
        }

        let retry_active = Rc::new(Cell::new(false));
        if let Some(b) = backend.as_deref() {
            spawn_backend_streams(&sender, b);
        } else {
            widgets.banner.set_reveal_child(true);
            Self::start_retry_loop(&retry_active, &sender);
        }
        // Focus reporting: GTK4 has no focus-in/out on the window; the
        // `is-active` property is the toplevel-focus signal.
        {
            let sender = sender.clone();
            widgets.main_window.connect_is_active_notify(move |w| {
                sender.input(Msg::FocusChanged(w.is_active()));
            });
        }

        let workspaces = backend
            .as_ref()
            .and_then(|b| b.list_workspaces().ok())
            .unwrap_or_default();
        populate_sidebar(
            &widgets.list,
            &workspaces,
            state.borrow().last_active_workspace.as_deref(),
        );
        widgets.footer_label.set_label(&footer_text(&backend));

        // Terminal stack: pane intents route back through the component input
        // so the App (sole backend owner) performs the RPC.
        let terminals = {
            let sender = sender.clone();
            TerminalStack::new(Rc::new(move |intent: PaneIntent| {
                sender.input(Msg::Pane(intent));
            }))
        };
        widgets.main_area.append(terminals.widget());

        let mut model = App {
            backend,
            workspaces,
            state,
            state_path,
            save_generation: Rc::new(Cell::new(0)),
            retry_active,
            window: widgets.main_window.clone(),
            paned: widgets.paned.clone(),
            list: widgets.list.clone(),
            banner: widgets.banner.clone(),
            banner_label: widgets.banner_label.clone(),
            footer_label: widgets.footer_label.clone(),
            terminals,
        };
        // Open the persisted/first workspace terminal so the pane exists and
        // begins its lazy-start on first fit. (Bind the id in its own `let` so
        // the `state` borrow ends before the `&mut model` call.)
        let initial_ws = {
            let persisted = model.state.borrow().last_active_workspace.clone();
            persisted
                .filter(|id| model.workspaces.iter().any(|w| &w.id == id))
                .or_else(|| model.workspaces.first().map(|w| w.id.clone()))
        };
        if let Some(ws) = initial_ws {
            model.terminals_open(&ws);
        }
        ComponentParts { model, widgets }
    }

    fn update(&mut self, msg: Self::Input, sender: ComponentSender<Self>) {
        match msg {
            Msg::RowSelected(index) => {
                if let Some(id) = self.workspaces.get(index as usize).map(|w| w.id.clone()) {
                    self.state.borrow_mut().last_active_workspace = Some(id.clone());
                    self.schedule_save(&sender);
                    self.terminals_open(&id);
                }
            }
            Msg::SidebarResized(position) => {
                let changed = {
                    let mut st = self.state.borrow_mut();
                    let changed = st.sidebar_width != Some(position);
                    st.sidebar_width = Some(position);
                    changed
                };
                if changed {
                    self.schedule_save(&sender);
                }
            }
            Msg::WindowGeometryChanged => {
                let geometry = WindowGeometry {
                    width: self.window.default_width(),
                    height: self.window.default_height(),
                    maximized: self.window.is_maximized(),
                };
                let changed = {
                    let mut st = self.state.borrow_mut();
                    let changed = st.window != Some(geometry);
                    st.window = Some(geometry);
                    changed
                };
                if changed {
                    self.schedule_save(&sender);
                }
            }
            Msg::RetryDiscover => {
                if self.backend.is_some() {
                    return;
                }
                // M2: backend::spawn_daemon_stub() grows into launching the
                // daemon when discovery keeps failing (plan §1.1 rule 3).
                if let Some(b) = make_backend() {
                    spawn_backend_streams(&sender, b.as_ref());
                    b.set_focused(self.window.is_active());
                    self.backend = Some(b);
                    self.retry_active.set(false);
                    self.banner.set_reveal_child(false);
                    self.refresh_workspaces();
                    self.footer_label.set_label(&footer_text(&self.backend));
                }
            }
            Msg::FocusChanged(focused) => {
                if let Some(b) = &self.backend {
                    b.set_focused(focused);
                }
            }
            Msg::Connection(state) => match state {
                ConnectionState::Connected => {
                    self.banner.set_reveal_child(false);
                    // Reconnects re-handshake: refresh what the socket serves
                    // (server info for the footer, missed workspace updates).
                    self.refresh_workspaces();
                    self.footer_label.set_label(&footer_text(&self.backend));
                }
                ConnectionState::Reconnecting { attempt, delay_ms } => {
                    self.banner_label.set_label(&format!(
                        "backend connection lost — reconnecting (attempt {}, next try in {}s)",
                        attempt + 1,
                        delay_ms.div_ceil(1000),
                    ));
                    self.banner.set_reveal_child(true);
                }
                ConnectionState::Disconnected => {
                    // Terminal: the client gave up (or the close was
                    // deliberate). Drop it and fall back to discovery.
                    self.backend = None;
                    self.banner_label.set_label(NO_BACKEND_BANNER);
                    self.banner.set_reveal_child(true);
                    self.footer_label.set_label(&footer_text(&self.backend));
                    Self::start_retry_loop(&self.retry_active, &sender);
                }
            },
            Msg::BackendEvent(BackendEvent::Event { channel, args }) => {
                eprintln!("[backend] event '{channel}'");
                match (orchestra_rpc::Event { channel, args }).decode() {
                    Ok(UiEvent::WorkspaceUpdate(ws)) => {
                        match self.workspaces.iter_mut().find(|w| w.id == ws.id) {
                            Some(slot) => *slot = *ws,
                            None => self.workspaces.push(*ws),
                        }
                        self.repopulate_sidebar();
                    }
                    Ok(UiEvent::WorkspaceRemoved { id }) => {
                        self.workspaces.retain(|w| w.id != id);
                        self.repopulate_sidebar();
                    }
                    Ok(UiEvent::WorkspacesRemoved { ids }) => {
                        for id in &ids {
                            self.terminals.remove(id);
                        }
                        self.workspaces.retain(|w| !ids.contains(&w.id));
                        self.repopulate_sidebar();
                    }
                    // Terminal lifecycle (plan §5.2): exit/stopped show the
                    // relaunch notice; restart clears + re-arms for a branch
                    // switch. `id` may be `<ws>`, `<ws>:run`, or `<ws>:nvim`.
                    Ok(UiEvent::PtyExit { id, .. }) => self.terminals.on_exit(&id, false),
                    Ok(UiEvent::PtyStopped { id }) => self.terminals.on_exit(&id, true),
                    Ok(UiEvent::PtyRestart { id }) => self.terminals.on_restart(&id),
                    // ptyData rides the dedicated binary channel (Msg::PtyData);
                    // a JSON copy here would double-feed, so drop it.
                    Ok(UiEvent::PtyData { .. }) => {}
                    // Everything else belongs to other M2 workstreams
                    // (usage, accounts, self-tune, …).
                    _ => {}
                }
            }
            Msg::PtyData(id, bytes) => {
                self.terminals.feed(&id, &bytes);
            }
            Msg::Pane(intent) => self.handle_pane_intent(intent),
            Msg::PersistNow => {
                if let Err(e) = self.state.borrow().save(&self.state_path) {
                    eprintln!("[state] save failed: {e}");
                }
            }
        }
        let _ = &self.paned; // handle kept for M2 (programmatic width changes)
    }
}

impl App {
    /// 3 s discovery poll while no backend is attached. Idempotent: a loop
    /// already running keeps its timer; `retry_active` is the single switch.
    fn start_retry_loop(retry_active: &Rc<Cell<bool>>, sender: &ComponentSender<Self>) {
        if retry_active.replace(true) {
            return;
        }
        let sender = sender.clone();
        let active = retry_active.clone();
        glib::timeout_add_seconds_local(3, move || {
            if !active.get() {
                return glib::ControlFlow::Break;
            }
            sender.input(Msg::RetryDiscover);
            glib::ControlFlow::Continue
        });
    }

    /// Make a workspace's terminal the visible pane. On a pane's first open we
    /// seed its scrollback from the backend, then show the resume pill — the
    /// pane's own first-fit fires `ptyStart`.
    fn terminals_open(&mut self, ws_id: &str) {
        let fresh = self.terminals.is_new(ws_id);
        if fresh {
            if let Some(b) = &self.backend {
                if let Ok(bytes) = b.pty_scrollback(ws_id) {
                    self.terminals.feed_scrollback(ws_id, &bytes);
                }
            }
        }
        self.terminals.set_active(ws_id);
        if fresh {
            // Resuming if the workspace has prior activity; a brand-new spawn
            // shows "Starting agent…". The status stands in for that here.
            let resuming = self
                .workspaces
                .iter()
                .find(|w| w.id == ws_id)
                .map(|w| w.status != WorkspaceStatus::Idle)
                .unwrap_or(false);
            self.terminals.show_pill(ws_id, resuming);
        }
    }

    /// Perform a terminal pane's requested backend action. Errors are logged,
    /// not fatal — a disconnected backend simply drops the intent.
    fn handle_pane_intent(&mut self, intent: PaneIntent) {
        let Some(b) = &self.backend else { return };
        let res = match &intent {
            PaneIntent::Start { id, cols, rows } => b.pty_start(id, *cols, *rows),
            PaneIntent::Write { id, bytes } => b.pty_write(id, bytes),
            PaneIntent::Resize { id, cols, rows } => b.pty_resize(id, *cols, *rows),
            PaneIntent::Repaint { id, cols, rows } => b.pty_repaint(id, *cols, *rows),
            PaneIntent::PasteImage { id, mime, bytes } => {
                // Spill the image to a temp file, then bracketed-paste its path
                // (mirrors Terminal.tsx). Empty input yields no path.
                match b.save_clipboard_image(mime, bytes) {
                    Ok(Some(path)) => {
                        let paste = format!("\x1b[200~{path} \x1b[201~");
                        b.pty_write(id, paste.as_bytes())
                    }
                    Ok(None) => Ok(()),
                    Err(e) => Err(e),
                }
            }
            PaneIntent::OpenUri { uri } => {
                gtk::UriLauncher::new(uri).launch(
                    None::<&gtk::Window>,
                    gio::Cancellable::NONE,
                    |_| {},
                );
                Ok(())
            }
        };
        if let Err(e) = res {
            eprintln!("[terminal] intent failed: {e}");
        }
    }

    /// Re-hydrate the workspace list from the backend and redraw the sidebar.
    fn refresh_workspaces(&mut self) {
        self.workspaces = self
            .backend
            .as_ref()
            .and_then(|b| b.list_workspaces().ok())
            .unwrap_or_default();
        self.repopulate_sidebar();
    }

    fn repopulate_sidebar(&self) {
        populate_sidebar(
            &self.list,
            &self.workspaces,
            self.state.borrow().last_active_workspace.as_deref(),
        );
    }

    fn schedule_save(&self, sender: &ComponentSender<Self>) {
        let generation = self.save_generation.get() + 1;
        self.save_generation.set(generation);
        let latest = self.save_generation.clone();
        let sender = sender.clone();
        glib::timeout_add_local_once(Duration::from_millis(400), move || {
            if latest.get() == generation {
                sender.input(Msg::PersistNow);
            }
        });
    }
}
