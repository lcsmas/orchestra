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

use crate::backend::{self, Backend, BackendKind, MockBackend, RpcBackend};
use crate::dialogs;
use crate::remote_control;
use crate::state::{self, UiState, WindowGeometry};

pub struct Init {
    pub remote_control: Option<PathBuf>,
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
    window: gtk::ApplicationWindow,
    paned: gtk::Paned,
    list: gtk::ListBox,
    banner: gtk::Revealer,
    footer_label: gtk::Label,
}

#[derive(Debug)]
pub enum Msg {
    RowSelected(i32),
    SidebarResized(i32),
    WindowGeometryChanged,
    RetryDiscover,
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

fn make_backend() -> Option<Box<dyn Backend>> {
    if backend::mock_requested() {
        return Some(Box::new(MockBackend::default()));
    }
    backend::discover_socket(&state::orchestra_home())
        .map(|sock| Box::new(RpcBackend::new(sock)) as Box<dyn Backend>)
}

fn footer_text(backend: &Option<Box<dyn Backend>>) -> String {
    let frontend = env!("CARGO_PKG_VERSION");
    match backend {
        Some(b) => match b.kind() {
            BackendKind::Mock => {
                format!("backend: mock v{} · frontend v{frontend}", b.version())
            }
            BackendKind::Rpc => {
                format!("backend: rpc (socket found — wires up in M2) · frontend v{frontend}")
            }
        },
        None => format!("backend: none · frontend v{frontend}"),
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

        let retry_active = Rc::new(Cell::new(backend.is_none()));
        if backend.is_none() {
            widgets.banner.set_reveal_child(true);
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
        widgets.footer_label.set_label(&footer_text(&backend));

        let model = App {
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
                if self.backend.is_some() {
                    return;
                }
                // M2: backend::spawn_daemon_stub() grows into launching the
                // daemon when discovery keeps failing (plan §1.1 rule 3).
                if let Some(sock) = backend::discover_socket(&state::orchestra_home()) {
                    self.backend = Some(Box::new(RpcBackend::new(sock)));
                    self.retry_active.set(false);
                    self.banner.set_reveal_child(false);
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
                    self.footer_label.set_label(&footer_text(&self.backend));
                }
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
