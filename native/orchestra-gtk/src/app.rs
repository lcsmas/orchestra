//! App shell (plan §5.6): root Relm4 component — window, sidebar/main split
//! with drag-persisted width, overlay host for future Resources/Insights/Help
//! panes, backend-discovery banner, status strip, debug menu for the dialog
//! system. The real [`Sidebar`] component (spawn trees, pills, actions) mounts
//! as the paned start child; the shell hands it the shared backend + UI state.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gtk::gio;
use gtk::glib;
use gtk::prelude::*;
use relm4::prelude::*;

use orchestra_rpc::{BackendKind as RemoteKind, ConnectionState};

use crate::backend::{self, Backend, BackendEvent, BackendKind, MockBackend, RpcBackend};
use crate::dialogs;
use crate::remote_control;
use crate::sidebar::{Sidebar, SidebarInit};
use crate::state::{self, UiState, WindowGeometry};

pub struct Init {
    pub remote_control: Option<PathBuf>,
}

const NO_BACKEND_BANNER: &str =
    "no backend found — start Orchestra or the daemon (retrying every 3s)";

pub struct App {
    backend: Option<Rc<dyn Backend>>,
    state: Rc<RefCell<UiState>>,
    state_path: PathBuf,
    /// Debounce generation for state saves: each change bumps it; only the
    /// timer holding the latest generation actually persists.
    save_generation: Rc<Cell<u64>>,
    /// Discovery retry loop runs only while no backend is attached.
    retry_active: Rc<Cell<bool>>,
    window: gtk::ApplicationWindow,
    paned: gtk::Paned,
    /// The real sidebar (spawn trees, pills, actions) — the M2-B1 workstream.
    sidebar: Controller<Sidebar>,
    banner: gtk::Revealer,
    banner_label: gtk::Label,
    footer_label: gtk::Label,
}

#[derive(Debug)]
pub enum Msg {
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
}

fn make_backend() -> Option<Rc<dyn Backend>> {
    if backend::mock_requested() {
        return Some(Rc::new(MockBackend::default()));
    }
    let sock = backend::discover_socket(&state::orchestra_home())?;
    match RpcBackend::connect(sock) {
        Ok(b) => Some(Rc::new(b) as Rc<dyn Backend>),
        Err(e) => {
            eprintln!("[backend] connect failed: {e}");
            None
        }
    }
}

fn footer_text(backend: &Option<Rc<dyn Backend>>) -> String {
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
/// pty frames are consumed by the terminal stack (single consumer — see
/// `Backend::pty_data`); until that lands here, a drain keeps the unbounded
/// channel from accumulating output of every running workspace.
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
    glib::spawn_future_local(async move {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        while let Ok((id, bytes)) = pty.recv().await {
            if seen.insert(id.clone()) {
                eprintln!(
                    "[backend] ptyData flowing for '{id}' ({} bytes)",
                    bytes.len()
                );
            }
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

                    // The real sidebar component is attached here after
                    // `view_output!` (the M2-B1 workstream owns its widgets).
                    #[name = "sidebar_host"]
                    #[wrap(Some)]
                    set_start_child = &gtk::Box {
                        set_orientation: gtk::Orientation::Vertical,
                        set_widget_name: "sidebar-host",
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

        widgets.footer_label.set_label(&footer_text(&backend));

        // Mount the real sidebar as the paned start child (ONE component swap).
        let sidebar = Sidebar::builder()
            .launch(SidebarInit {
                backend: backend.clone(),
                state: state.clone(),
                state_path: state_path.clone(),
            })
            .detach();
        widgets.paned.set_start_child(Some(sidebar.widget()));

        let model = App {
            backend,
            state,
            state_path,
            save_generation: Rc::new(Cell::new(0)),
            retry_active,
            window: widgets.main_window.clone(),
            paned: widgets.paned.clone(),
            sidebar,
            banner: widgets.banner.clone(),
            banner_label: widgets.banner_label.clone(),
            footer_label: widgets.footer_label.clone(),
        };
        ComponentParts { model, widgets }
    }

    fn update(&mut self, msg: Self::Input, sender: ComponentSender<Self>) {
        match msg {
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
                    self.backend = Some(b.clone());
                    self.retry_active.set(false);
                    self.banner.set_reveal_child(false);
                    // Hand the live backend to the sidebar: it hydrates its own
                    // snapshot (refresh_snapshot). App owns the events() pump and
                    // forwards frames, so the sidebar does not pump itself.
                    self.sidebar.emit(crate::sidebar::Msg::Attach(b));
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
                    // Reconnects re-handshake: re-hydrate the sidebar snapshot
                    // (server info for the footer, missed workspace updates).
                    if let Some(b) = &self.backend {
                        self.sidebar.emit(crate::sidebar::Msg::Attach(b.clone()));
                    }
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
            Msg::BackendEvent(ev) => {
                // App owns the single events() consumer (spawn_backend_streams);
                // it fans each frame out to the components that care. The sidebar
                // decodes workspace:update/removed itself (its apply_event), so
                // we forward the raw frame rather than mutating a duplicate list.
                let BackendEvent::Event { channel, .. } = &ev;
                eprintln!("[backend] event '{channel}'");
                self.sidebar.emit(crate::sidebar::Msg::Backend(ev));
                // Terminals, usage, accounts, … consume their own frames as the
                // M2 workstreams mount their fan-out here.
            }
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
