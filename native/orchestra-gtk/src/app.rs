//! App shell (plan §5.6): root Relm4 component — window, sidebar/main split
//! with drag-persisted width, overlay host for future Resources/Insights/Help
//! panes, backend-discovery banner, status strip, debug menu for the dialog
//! system. The sidebar list here is a mock-fed placeholder; the real sidebar
//! (factories, spawn trees, pills) is a separate M2 workstream.

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use gtk::gio;
use gtk::glib;
use gtk::pango;
use gtk::prelude::*;
use relm4::prelude::*;

use orchestra_rpc::types::{Workspace, WorkspaceStatus};
use orchestra_rpc::{RpcError, ServerInfo, PROTO_VERSION};

use crate::backend::{self, Backend, BackendKind, MockBackend, RpcBackend};
use crate::daemon;
use crate::dialogs;
use crate::remote_control;
use crate::state::{self, UiState, WindowGeometry};

pub struct Init {
    pub remote_control: Option<PathBuf>,
    /// `--stop-daemon-on-exit`: SIGTERM a daemon WE spawned when the window
    /// closes. Default off — plan §1.1 rule 3: agents keep working after the
    /// UI goes away.
    pub stop_daemon_on_exit: bool,
}

/// Progress reports from the attach-flow worker thread (discovery →
/// auto-spawn → handshake probe), marshalled onto the GTK loop as messages.
#[derive(Debug)]
pub enum AttachUpdate {
    /// Progress text for the discovery banner.
    Banner(String),
    /// Handshake succeeded — attach. `note` carries the story to surface.
    Attached {
        sock: PathBuf,
        info: ServerInfo,
        note: Option<AttachNote>,
    },
    /// Backend speaks a different ui-rpc protocol — REFUSED (plan §1.1 rule
    /// 5 / protocol §3). No attach; retrying cannot heal it.
    Refused { server_proto: u32 },
    /// Non-fatal failure: show `banner`, optionally a dialog, and let the 3 s
    /// discovery retries keep running.
    Failed {
        banner: String,
        dialog: Option<(String, String)>,
    },
}

/// How the successful attach came about (decides the §1.1 dialog).
#[derive(Debug)]
pub enum AttachNote {
    /// We spawned this daemon; pid recorded for `--stop-daemon-on-exit`.
    SpawnedDaemon { pid: u32 },
    /// Our spawned daemon lost the backend lock to the Electron app — which
    /// serves the same ui-rpc socket, so we attached to it instead ("two
    /// faces, one state", plan §1.1 rule 2).
    ElectronOwnsHome,
}

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
    /// An attach-flow worker thread is running; don't start a second.
    attach_in_flight: bool,
    /// Backend refused on protocol version — retrying cannot heal it.
    proto_refused: bool,
    /// What the backend said in helloOk (footer + version comparisons).
    server_info: Option<ServerInfo>,
    /// Pid of a daemon WE spawned this session, shared with the close handler
    /// for `--stop-daemon-on-exit`. Never holds a discovered backend's pid.
    spawned_pid: Rc<Cell<Option<u32>>>,
    window: gtk::ApplicationWindow,
    paned: gtk::Paned,
    list: gtk::ListBox,
    banner: gtk::Revealer,
    banner_label: gtk::Label,
    footer_label: gtk::Label,
}

#[derive(Debug)]
pub enum Msg {
    RowSelected(i32),
    SidebarResized(i32),
    WindowGeometryChanged,
    RetryDiscover,
    Attach(AttachUpdate),
    PersistNow,
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

fn footer_text(backend: &Option<Box<dyn Backend>>, server: Option<&ServerInfo>) -> String {
    let frontend = crate::app_version();
    match backend {
        Some(b) => match b.kind() {
            BackendKind::Mock => {
                format!("backend: mock v{} · frontend v{frontend}", b.version())
            }
            BackendKind::Rpc => match server {
                Some(info) => {
                    let kind = match info.backend_kind {
                        orchestra_rpc::BackendKind::Electron => "electron",
                        orchestra_rpc::BackendKind::Daemon => "daemon",
                    };
                    format!(
                        "backend: {kind} v{} · frontend v{frontend}",
                        info.app_version
                    )
                }
                None => format!("backend: rpc (handshaking…) · frontend v{frontend}"),
            },
        },
        None => format!("backend: none · frontend v{frontend}"),
    }
}

/// Spawn the attach-flow on a std worker thread, marshalling its progress
/// back as `Msg::Attach`. Kept off the GTK thread because every step blocks
/// (socket polls, child waits, the handshake) while the loop keeps painting.
fn spawn_attach(sender: &ComponentSender<App>, allow_spawn: bool) {
    let sender = sender.clone();
    let home = state::orchestra_home();
    std::thread::spawn(move || {
        attach_flow(home, allow_spawn, |u| sender.input(Msg::Attach(u)));
    });
}

// ---- attach flow (worker-thread side) --------------------------------------

/// Discovery → (optionally) daemon auto-spawn → handshake probe, reporting
/// progress as [`AttachUpdate`]s. Runs on a std thread: every step here
/// blocks (socket polls, child waits, the handshake), and the GTK loop must
/// keep painting the banner meanwhile.
fn attach_flow(home: PathBuf, allow_spawn: bool, send: impl Fn(AttachUpdate)) {
    if let Some(sock) = backend::discover_socket(&home) {
        probe_and_send(&sock, None, &send);
        return;
    }
    if !allow_spawn {
        send(AttachUpdate::Failed {
            banner: "no backend found — start Orchestra or the daemon (retrying every 3s)".into(),
            dialog: None,
        });
        return;
    }

    // Plan §1.1 rule 3: no socket → spawn the daemon and attach.
    let user_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    let Some(cmd) = daemon::locate_daemon_command(&user_home) else {
        send(AttachUpdate::Failed {
            banner: "no backend found and no daemon to start — set $ORCHESTRA_DAEMON_CMD, \
                     install the Orchestra AppImage, or build dist-electron/daemon.js"
                .into(),
            dialog: None,
        });
        return;
    };
    send(AttachUpdate::Banner(format!(
        "no backend found — starting the Orchestra daemon ({})…",
        cmd.describe()
    )));
    let mut spawned = match daemon::spawn_daemon(&cmd, &home) {
        Ok(s) => s,
        Err(e) => {
            send(AttachUpdate::Failed {
                banner: format!("failed to start the daemon: {e} (retrying discovery every 3s)"),
                dialog: None,
            });
            return;
        }
    };
    match daemon::wait_for_socket(&mut spawned, &home, Duration::from_secs(15)) {
        daemon::WaitOutcome::Ready(sock) => {
            let pid = spawned.pid;
            daemon::reap_in_background(spawned);
            probe_and_send(&sock, Some(AttachNote::SpawnedDaemon { pid }), &send);
        }
        daemon::WaitOutcome::Exited { code, output_tail } => {
            report_daemon_exit(&home, code, &output_tail, &spawned_log(&spawned), &send);
        }
        daemon::WaitOutcome::TimedOut => {
            daemon::reap_in_background(spawned);
            send(AttachUpdate::Failed {
                banner: format!(
                    "daemon started but its UI socket did not appear within 15s — \
                     see {}/logs/ (still retrying)",
                    home.display()
                ),
                dialog: None,
            });
        }
    }
}

fn spawned_log(spawned: &daemon::SpawnedDaemon) -> PathBuf {
    spawned.spawn_log.clone()
}

/// Turn a dead spawned daemon into the right §1.1 story.
fn report_daemon_exit(
    home: &Path,
    code: Option<i32>,
    output_tail: &str,
    spawn_log: &Path,
    send: &impl Fn(AttachUpdate),
) {
    match daemon::diagnose_exit(output_tail, home) {
        daemon::ExitDiagnosis::LockHeld { kind, pid } if kind == "electron" => {
            // The Electron app owns this home — and a current one serves the
            // ui-rpc socket itself. If it's there, attaching to IT is the
            // designed outcome, not an error (plan §1.1 rule 2).
            if let Some(sock) = backend::discover_socket(home) {
                probe_and_send(&sock, Some(AttachNote::ElectronOwnsHome), send);
            } else {
                send(AttachUpdate::Failed {
                    banner: "Orchestra (Electron) owns this home but serves no UI socket".into(),
                    dialog: Some((
                        "Orchestra (Electron) owns this home".into(),
                        format!(
                            "The Electron app (pid {}) already owns {} — only one backend may \
                             run per home, so the daemon refused to start.\n\nA current \
                             Orchestra serves the UI socket itself and this window would have \
                             attached to it automatically; not finding one usually means that \
                             Electron app predates ui-rpc. Update it, or quit it and this app \
                             will start (or find) a daemon on the next retry.",
                            pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into()),
                            home.display(),
                        ),
                    )),
                });
            }
        }
        daemon::ExitDiagnosis::LockHeld { kind, pid } => {
            let pid_str = pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into());
            send(AttachUpdate::Failed {
                banner: format!(
                    "a {kind} backend (pid {pid_str}) owns this home but serves no UI socket"
                ),
                dialog: Some((
                    "Backend lock held".into(),
                    format!(
                        "A {kind} backend (pid {pid_str}) holds {}/backend.lock, so the daemon \
                         we started refused to run — but no UI socket was found either.\n\n\
                         If pid {pid_str} is a live Orchestra backend it may still be booting \
                         (this app keeps retrying). If it is NOT running, the lock is stale — \
                         the next backend start reclaims a dead pid's lock automatically, so \
                         retrying shortly should heal it; if it persists, check \
                         {}/logs/orchestra.log and delete backend.lock yourself.",
                        home.display(),
                        home.display(),
                    ),
                )),
            });
        }
        daemon::ExitDiagnosis::Other => {
            send(AttachUpdate::Failed {
                banner: "the daemon exited during startup (see dialog / spawn log)".into(),
                dialog: Some((
                    "Daemon failed to start".into(),
                    format!(
                        "The spawned daemon exited{} before serving its UI socket.\n\n{}\n\n\
                         Full early output: {}",
                        code.map(|c| format!(" with code {c}")).unwrap_or_default(),
                        if output_tail.is_empty() {
                            "(no output captured)"
                        } else {
                            output_tail
                        },
                        spawn_log.display(),
                    ),
                )),
            });
        }
    }
}

/// Handshake-probe a discovered socket and send the outcome (attach, proto
/// refusal, or a retryable failure).
fn probe_and_send(sock: &Path, note: Option<AttachNote>, send: &impl Fn(AttachUpdate)) {
    match backend::probe_backend(sock) {
        Ok(info) => send(AttachUpdate::Attached {
            sock: sock.to_path_buf(),
            info,
            note,
        }),
        Err(RpcError::ProtoMismatch { server }) => send(AttachUpdate::Refused {
            server_proto: server,
        }),
        Err(e) => send(AttachUpdate::Failed {
            banner: format!(
                "backend at {} is not answering the handshake: {e} (retrying every 3s)",
                sock.display()
            ),
            dialog: None,
        }),
    }
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
                            set_label: "no backend found — start Orchestra or the daemon (retrying every 3s)",
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
                        set_child = &gtk::Box {
                            add_css_class: "main-area",
                            set_widget_name: "main-area",

                            gtk::Label {
                                set_widget_name: "main-empty",
                                set_label: "Select a workspace — terminals arrive with the M2 workstreams",
                                add_css_class: "empty-hint",
                                set_hexpand: true,
                                set_vexpand: true,
                            },
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
        // Synchronous backend creation is mock-only: the mock is the entire
        // backend. A real backend is discovered/spawned asynchronously by the
        // attach-flow worker below (its blocking socket polls and handshake
        // must not stall the first present), so it starts life as `None`.
        let backend: Option<Box<dyn Backend>> = if backend::mock_requested() {
            Some(Box::new(MockBackend::default()))
        } else {
            None
        };

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
        // Pid of a daemon WE spawned this session; the close handler SIGTERMs
        // it under `--stop-daemon-on-exit`. Shared so the attach-flow handler
        // (Msg::Attach) can record the pid after the async spawn completes.
        let spawned_pid: Rc<Cell<Option<u32>>> = Rc::new(Cell::new(None));

        // Flush state synchronously on close — a debounced save may still be
        // pending, and the main loop quits right after this. Also stops a
        // daemon we spawned, if `--stop-daemon-on-exit` was set (plan §1.1
        // rule 3 default is to LEAVE it running).
        {
            let state = state.clone();
            let path = state_path.clone();
            let spawned_pid = spawned_pid.clone();
            let stop_on_exit = init.stop_daemon_on_exit;
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
                if stop_on_exit {
                    if let Some(pid) = spawned_pid.get() {
                        daemon::stop_daemon(pid);
                    }
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

        let retry_active = Rc::new(Cell::new(backend.is_none()));
        let mut attach_in_flight = false;
        if backend.is_none() {
            widgets.banner.set_reveal_child(true);
            widgets.banner_label.set_label("connecting to a backend…");
            // Kick off the first attach worker immediately (allow_spawn: it may
            // start the daemon). The 3 s timer is the RETRY loop for when this
            // one fails and leaves no backend — it re-runs discovery only
            // (allow_spawn: false — one auto-spawn attempt per launch is
            // enough; repeated spawns would fight the backend lock).
            attach_in_flight = true;
            spawn_attach(&sender, true);

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

        let workspaces = backend
            .as_ref()
            .and_then(|b| b.list_workspaces().ok())
            .unwrap_or_default();
        populate_sidebar(
            &widgets.list,
            &workspaces,
            state.borrow().last_active_workspace.as_deref(),
        );
        widgets.footer_label.set_label(&footer_text(&backend, None));

        let model = App {
            backend,
            workspaces,
            state,
            state_path,
            save_generation: Rc::new(Cell::new(0)),
            retry_active,
            attach_in_flight,
            proto_refused: false,
            server_info: None,
            spawned_pid,
            window: widgets.main_window.clone(),
            paned: widgets.paned.clone(),
            list: widgets.list.clone(),
            banner: widgets.banner.clone(),
            banner_label: widgets.banner_label.clone(),
            footer_label: widgets.footer_label.clone(),
        };
        ComponentParts { model, widgets }
    }

    fn update(&mut self, msg: Self::Input, sender: ComponentSender<Self>) {
        match msg {
            Msg::RowSelected(index) => {
                if let Some(ws) = self.workspaces.get(index as usize) {
                    self.state.borrow_mut().last_active_workspace = Some(ws.id.clone());
                    self.schedule_save(&sender);
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
                // Nothing to do once attached, a worker is already running, or
                // the protocol was refused (retrying cannot heal a mismatch).
                if self.backend.is_some() || self.attach_in_flight || self.proto_refused {
                    return;
                }
                // Retry runs discovery only (allow_spawn: false): the first
                // attach already made the one auto-spawn attempt this launch.
                self.attach_in_flight = true;
                spawn_attach(&sender, false);
            }
            Msg::Attach(update) => self.on_attach(update),
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
    /// Apply one [`AttachUpdate`] from the attach-flow worker.
    fn on_attach(&mut self, update: AttachUpdate) {
        match update {
            AttachUpdate::Banner(text) => {
                self.banner_label.set_label(&text);
            }
            AttachUpdate::Attached { sock, info, note } => {
                self.attach_in_flight = false;
                self.retry_active.set(false);
                self.banner.set_reveal_child(false);
                let electron_owns = matches!(note, Some(AttachNote::ElectronOwnsHome));
                if let Some(AttachNote::SpawnedDaemon { pid }) = note {
                    self.spawned_pid.set(Some(pid));
                }
                // appVersion lockstep is a WARNING, not fatal (protocol §3):
                // both apps ship from the same release, so a mismatch means one
                // side is stale — surface it but still attach.
                let ours = crate::app_version();
                if info.app_version != ours {
                    let win = self.window.clone().upcast::<gtk::Window>();
                    let (theirs, kind) = (info.app_version.clone(), info.backend_kind);
                    let kind = match kind {
                        orchestra_rpc::BackendKind::Electron => "Electron app",
                        orchestra_rpc::BackendKind::Daemon => "daemon",
                    };
                    glib::spawn_future_local(async move {
                        dialogs::alert(
                            &win,
                            "Version mismatch",
                            &format!(
                                "This native frontend is v{ours} but the {kind} backend it \
                                 attached to is v{theirs}. They ship from the same release in \
                                 lockstep, so one side is out of date — update the older one. \
                                 Attaching anyway; some features may be missing or misbehave.",
                            ),
                        )
                        .await;
                    });
                }
                self.server_info = Some(info);
                self.backend = Some(Box::new(RpcBackend::new(sock)));
                let workspaces = self
                    .backend
                    .as_ref()
                    .and_then(|b| b.list_workspaces().ok())
                    .unwrap_or_default();
                self.workspaces = workspaces;
                populate_sidebar(
                    &self.list,
                    &self.workspaces,
                    self.state.borrow().last_active_workspace.as_deref(),
                );
                self.footer_label
                    .set_label(&footer_text(&self.backend, self.server_info.as_ref()));
                if electron_owns {
                    // §1.1 rule 2: our daemon lost the lock to the Electron
                    // app, which serves the same socket — we attached to it.
                    let win = self.window.clone().upcast::<gtk::Window>();
                    glib::spawn_future_local(async move {
                        dialogs::alert(
                            &win,
                            "Attached to the Electron app",
                            "Orchestra (Electron) already owns this home and serves the UI \
                             socket itself, so this window attached to it automatically — the \
                             two apps are two faces of one running backend. Changes you make \
                             here appear there and vice versa.",
                        )
                        .await;
                    });
                }
            }
            AttachUpdate::Refused { server_proto } => {
                self.attach_in_flight = false;
                self.proto_refused = true;
                self.retry_active.set(false);
                self.banner.set_reveal_child(true);
                self.banner_label.set_label(
                    "backend refused: incompatible ui-rpc protocol — update the older app",
                );
                let win = self.window.clone().upcast::<gtk::Window>();
                let ours = PROTO_VERSION;
                glib::spawn_future_local(async move {
                    dialogs::error(
                        &win,
                        "Incompatible backend",
                        &format!(
                            "The backend speaks ui-rpc protocol v{server_proto}, but this \
                             frontend speaks v{ours}. The protocol is frozen per release, so \
                             this means the two apps are from different releases — update the \
                             older side; both ship from the same release in lockstep. This \
                             window will not attach until they match.",
                        ),
                    )
                    .await;
                });
            }
            AttachUpdate::Failed { banner, dialog } => {
                self.attach_in_flight = false;
                self.banner.set_reveal_child(true);
                self.banner_label.set_label(&banner);
                if let Some((title, body)) = dialog {
                    let win = self.window.clone().upcast::<gtk::Window>();
                    glib::spawn_future_local(async move {
                        dialogs::error(&win, &title, &body).await;
                    });
                }
            }
        }
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
