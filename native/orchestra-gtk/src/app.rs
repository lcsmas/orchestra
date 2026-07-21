//! App shell (plan §5.6): root Relm4 component — window, sidebar/main split
//! with drag-persisted width, overlay host for future Resources/Insights/Help
//! panes, backend-discovery banner, status strip, debug menu for the dialog
//! system. The real [`Sidebar`] component (spawn trees, pills, actions) mounts
//! as the paned start child; the shell hands it the shared backend + UI state.

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use gtk::glib;
use gtk::prelude::*;
use relm4::prelude::*;

use orchestra_rpc::types::Workspace;
use orchestra_rpc::{
    BackendKind as RemoteKind, ConnectionState, RpcError, ServerInfo, UiEvent, PROTO_VERSION,
};

use crate::accounts::AccountsController;
use crate::backend::{self, Backend, BackendEvent, BackendKind, MockBackend, RpcBackend};
use crate::ctx::Ctx;
use crate::daemon;
use crate::dialogs;
use crate::main_pane::MainPane;
use crate::notify;
use crate::overlays::insights::InsightsSection;
use crate::overlays::{OverlayKind, Overlays};
use crate::remote_control;
use crate::sidebar::{Sidebar, SidebarInit};
use crate::sound::SoundPlayer;
use crate::state::{self, UiState, WindowGeometry};
use crate::terminal::TerminalStack;

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

const NO_BACKEND_BANNER: &str =
    "no backend found — start Orchestra or the daemon (retrying every 3s)";

/// Default sidebar width, matching Electron's `SIDEBAR_WIDTH_DEFAULT = 340`
/// (App.tsx:30), which feeds `grid-template-columns: <w>px 1fr` (styles.css:390,
/// the `.app` grid). Both frontends persist a user-dragged width and fall back
/// to this default; the port's was 280, so a first run was 60px narrower than
/// Electron's for no reason other than the number never being ported.
///
/// Electron's rendered CONTENT width is 339px — the 340px track minus the
/// `.sidebar` 1px `border-right` (styles.css:430).
const SIDEBAR_WIDTH_DEFAULT: i32 = 340;

pub struct App {
    // `Rc` (not `Box`) so the accounts controller and the Resources/Insights
    // overlays can each hold a clone for polling/streaming without a second
    // socket connection.
    backend: Option<Rc<dyn Backend>>,
    /// Accounts/usage/login controller — created when a backend attaches. Owns
    /// the usage-bars strip in the sidebar footer and every accounts window;
    /// the backend event pump + login PTY bytes are forwarded here.
    accounts: Option<Rc<AccountsController>>,
    /// Shared backend seam for the main-pane widget tree (toolbar / diff /
    /// banners) — App keeps its backend in sync via [`Ctx::set_backend`].
    ctx: Rc<Ctx>,
    /// The main pane (toolbar + banners + view stack), the base child of the
    /// overlay host — always present; B5's overlays layer on top of it.
    main_pane: Rc<MainPane>,
    /// Kept-alive feed-mode terminals (plan §5.2, B2) — agent pane in the main
    /// pane's terminal slot, run pane in its run slot, nvim via the toolbar
    /// toggle. All backend calls route through `ctx` per-call.
    terminals: TerminalStack,
    /// Mirror of the workspace list so App can resolve an activated id (from
    /// the sidebar) to a full record for the main pane.
    workspaces: Vec<Workspace>,
    state: Rc<RefCell<UiState>>,
    state_path: PathBuf,
    /// The Resources/Insights/Help overlays, mounted into the overlay host
    /// once a backend is available (they need it to poll/stream).
    overlays: Option<Rc<Overlays>>,
    /// Chime playback for `agentFinished` while the window is unfocused.
    sound: Rc<SoundPlayer>,
    /// The sidebar's Insights row (§5.1) — kept so self-tune events refresh its
    /// summary/step rows and the overlay's open state highlights it.
    insights_section: Option<Rc<InsightsSection>>,
    /// Debounce generation for state saves: each change bumps it; only the
    /// timer holding the latest generation actually persists.
    save_generation: Rc<Cell<u64>>,
    /// Discovery retry loop runs only while no backend is attached.
    retry_active: Rc<Cell<bool>>,
    /// An attach-flow worker thread is running; don't start a second.
    attach_in_flight: bool,
    /// Backend refused on protocol version — retrying cannot heal it.
    proto_refused: bool,
    /// Is the attached backend actually REACHABLE right now? Distinct from
    /// `backend.is_some()`: during a reconnect the handle stays (the client owns
    /// the retry and its streams get reused) while nothing works. Display must
    /// key on this, never on handle presence — see [`footer_text`].
    backend_live: bool,
    /// What the backend said in helloOk (footer + version comparisons).
    server_info: Option<ServerInfo>,
    /// Pid of a daemon WE spawned this session, shared with the close handler
    /// for `--stop-daemon-on-exit`. Never holds a discovered backend's pid.
    spawned_pid: Rc<Cell<Option<u32>>>,
    window: gtk::ApplicationWindow,
    paned: gtk::Paned,
    /// The real sidebar (spawn trees, pills, actions) — the M2-B1 workstream.
    sidebar: Controller<Sidebar>,
    banner: gtk::Revealer,
    banner_label: gtk::Label,
    footer_label: gtk::Label,
    /// Mirror of the last `ConnectionState` we received, exposed to the
    /// remote-control harness (never shown). See its widget definition for why
    /// cause-vs-symptom must be readable separately.
    conn_state_label: gtk::Label,
    /// Sidebar footer box that hosts the usage-bars strip (mounted by the
    /// controller) — kept so a backend that attaches on retry can mount into it.
    sidebar_footer: gtk::Box,
    accounts_button: gtk::Button,
    /// Overlay host the Resources/Insights/Help overlays mount into — kept for
    /// the same reason as `sidebar_footer`: a backend arriving on the attach
    /// path has to build them then, since there is none at init.
    overlay_host: gtk::Overlay,
}

#[derive(Debug)]
pub enum Msg {
    SidebarResized(i32),
    WindowGeometryChanged,
    RetryDiscover,
    Attach(AttachUpdate),
    PersistNow,
    /// Window focus-in/out → `focus` frame (backend ORs over all clients).
    FocusChanged(bool),
    /// Connection lifecycle from the RpcBackend's state stream.
    Connection(ConnectionState),
    /// An `event` frame from the backend.
    BackendEvent(BackendEvent),
    /// A binary `ptyData` frame: (pty id, raw bytes). Routed to the accounts
    /// controller (login PTY); other ids belong to the terminal workstream.
    PtyData(String, Vec<u8>),
    /// The sidebar activated a workspace (row-select) → drive the main pane's
    /// `set_active` (§5.3, B3). Also the target of a clicked desktop
    /// notification (B5), which presents the window and selects the workspace.
    WorkspaceActivated(String),
    /// B3's toolbar nvim toggle → reveal/hide B2's nvim file pane.
    NvimToggle(bool),
    /// Toggle one of the Resources/Insights/Help overlays (B5).
    ToggleOverlay(OverlayKind),
    /// Escape key — close the topmost overlay if any (B5).
    EscapePressed,
    /// Open the notification-sound picker (B5).
    OpenSoundPicker,
    OpenAccounts,
}

/// Depth-first search for a named widget under `root` — used to reach a mount
/// slot a sibling component owns (B1's sidebar `insights-slot`) without
/// widening that component's public surface.
fn find_named(root: &gtk::Widget, name: &str) -> Option<gtk::Box> {
    if root.widget_name() == name {
        return root.clone().downcast::<gtk::Box>().ok();
    }
    let mut child = root.first_child();
    while let Some(c) = child {
        child = c.next_sibling();
        if let Some(found) = find_named(&c, name) {
            return Some(found);
        }
    }
    None
}

/// Remove every child of a mount slot (drops B3's placeholder hint before B2
/// appends its surface).
fn clear_slot(slot: &gtk::Box) {
    while let Some(child) = slot.first_child() {
        slot.remove(&child);
    }
}

/// Whether a repo has a `run` script configured — the same source of truth the
/// toolbar gates its Run toggle on (`getRepoScripts(repoPath).run`), so the
/// pane's guidance and the toolbar never disagree.
fn repo_has_run_script(ctx: &Rc<Ctx>, repo_path: &str) -> bool {
    ctx.call_typed::<orchestra_rpc::types::RepoScripts>(
        "getRepoScripts",
        vec![serde_json::json!(repo_path)],
    )
    .map(|s| s.run.is_some())
    .unwrap_or(false)
}

/// Open a workspace's terminal surfaces: make its agent pane active (showing
/// the resume pill on first open), and mount its run surface into the main
/// pane's run slot. The agent pane's first visible fit fires `ptyStart`.
fn open_terminal(
    terminals: &mut TerminalStack,
    main_pane: &Rc<MainPane>,
    ctx: &Rc<Ctx>,
    ws: &Workspace,
) {
    let ws_id = &ws.id;
    let fresh = terminals.is_new(ws_id);
    // Do NOT replay the raw PTY scrollback log into the terminal — the same
    // decision (and for the same reason) as the renderer's `Terminal.tsx:366`.
    //
    // The log is what the CHILD wrote, and that includes sequences the child
    // sent expecting the TERMINAL to answer. A real 3 MB agent log contains
    // DA1 (`ESC[c`) and XTVERSION (`ESC[>0q`). Feeding those back makes VTE
    // answer a question nobody asked, and the answer goes out through the
    // pane's `commit` handler as `ptyWrite` — i.e. straight into the LIVE
    // Claude session's stdin, as if the user had typed it, while Claude is
    // mid-frame. Measured against VTE 0.80.5 (examples/scrollback_query_probe):
    // DA1 injects 17 bytes, XTVERSION 15, DSR 6; plain text injects 0.
    //
    // Agent context is preserved by Claude's own session store
    // (`claude --continue`), so a fresh TUI simply repaints itself.
    // (`set_active` creates the pane itself, so first open needs nothing here.)
    terminals.set_active(ws_id);
    // Mount this workspace's run surface into B3's run slot. With a run script
    // configured that's the kept-alive run pane (B3's toolbar Run button drives
    // runScriptStart; this pane just feeds it). WITHOUT one, the pane would be a
    // dead empty terminal — B3's toolbar deliberately keeps the Run tab
    // reachable as the discovery path, so show the same guidance the renderer
    // does instead (RunTerminal.tsx's !hasRunScript branch).
    let run = if repo_has_run_script(ctx, &ws.repo_path) {
        terminals.run_widget(ws_id)
    } else {
        TerminalStack::run_guidance()
    };
    let slot = main_pane.run_slot();
    clear_slot(slot);
    slot.append(&run);
    if fresh {
        // Resuming if the workspace already has activity; a brand-new spawn
        // shows "Starting agent…". The status stands in for that here.
        let resuming = ws.status != orchestra_rpc::types::WorkspaceStatus::Idle;
        terminals.show_pill(ws_id, resuming);
    }
}

/// Synchronous backend creation for the MOCK path only. A real backend is
/// discovered/spawned asynchronously by the attach-flow worker (its blocking
/// socket polls, daemon spawn, and handshake must not stall the first present),
/// so this returns None for non-mock and the attach flow takes over.
fn make_backend() -> Option<Rc<dyn Backend>> {
    if backend::mock_requested() {
        return Some(Rc::new(MockBackend::default()));
    }
    None
}

/// Status-strip text.
///
/// `live` is the CONNECTION state, not merely whether a backend handle exists.
/// They diverge during a reconnect: the client owns the retry, so `self.backend`
/// stays `Some` (its streams and state are about to be reused) and only
/// `Disconnected` clears it — but nothing works meanwhile. Reporting on handle
/// presence alone made the footer claim "backend: daemon v0.5.84" while the
/// banner said "connecting…", which is the one thing a status strip must never
/// do (M4 D1a; gate criterion 5).
///
/// KNOWN BOUNDARY — presence≠reachability is a LATENT CLASS, not just this
/// function. The `Reconnecting` arm clears no handles at all, so during a
/// reconnect `self.backend`, `Ctx`'s backend (`ctx.set_backend`), the sidebar's
/// own `backend` (`sidebar/mod.rs`), and the accounts controller are all still
/// `Some` — every surface keyed on backend-PRESENCE is optimistic in that
/// window. Only the footer is fixed here, deliberately: it is the user-visible
/// liar, and clearing the handles instead would tear down state the reconnect
/// is about to reuse. Anything else that starts *claiming* liveness should take
/// the connection state the same way rather than infer it from `is_some()`.
fn footer_text(backend: &Option<Rc<dyn Backend>>, live: bool) -> String {
    // Version lockstep (plan §9): the PRODUCT version, not the crate's own.
    let frontend = crate::app_version();
    match backend {
        Some(b) => match b.kind() {
            BackendKind::Mock => {
                format!("backend: mock v{} · frontend v{frontend}", b.version())
            }
            // A handle we can't currently reach is reported as reconnecting, NOT
            // as the backend it used to be talking to.
            BackendKind::Rpc if !live => {
                format!("backend: reconnecting… · frontend v{frontend}")
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
    let s = sender.clone();
    glib::spawn_future_local(async move {
        while let Ok((id, bytes)) = pty.recv().await {
            s.input(Msg::PtyData(id, bytes));
        }
    });
}

/// Build the accounts controller for a freshly-attached backend, mount its
/// usage-bars strip into the sidebar footer (above the Accounts button), wire
/// the button, and kick initial hydration.
fn attach_accounts(
    backend: Rc<dyn Backend>,
    window: &gtk::ApplicationWindow,
    footer: &gtk::Box,
    button: &gtk::Button,
) -> Rc<AccountsController> {
    let ctrl = AccountsController::new(backend, window.clone().upcast());
    // Strip goes at the top of the footer; the Accounts button stays last.
    footer.prepend(&ctrl.usage_bars_root());
    {
        let ctrl = ctrl.clone();
        button.connect_clicked(move |_| ctrl.clone().open_settings());
    }
    ctrl.bootstrap();
    ctrl
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
                    set_position: SIDEBAR_WIDTH_DEFAULT,
                    set_shrink_start_child: false,
                    // Window resizes flex the main area only — otherwise
                    // GtkPaned rescales the position proportionally and the
                    // persisted sidebar width drifts on every launch.
                    set_resize_start_child: false,

                    // The paned start child is a vertical stack: the real
                    // sidebar component (mounted into `sidebar_host` after
                    // `view_output!`, M2-B1) over the accounts footer (§5.4).
                    #[wrap(Some)]
                    set_start_child = &gtk::Box {
                        set_orientation: gtk::Orientation::Vertical,

                        // The real sidebar component is attached here after
                        // `view_output!` (the M2-B1 workstream owns its widgets).
                        #[name = "sidebar_host"]
                        gtk::Box {
                            set_orientation: gtk::Orientation::Vertical,
                            set_widget_name: "sidebar-host",
                            set_vexpand: true,
                        },

                        // Sidebar footer (plan §5.4): the accounts controller
                        // mounts the usage-bars strip here, above the Accounts
                        // settings button.
                        #[name = "sidebar_footer"]
                        gtk::Box {
                            set_orientation: gtk::Orientation::Vertical,
                            set_widget_name: "sidebar-footer",
                            add_css_class: "sidebar-footer",

                            #[name = "accounts_button"]
                            gtk::Button {
                                set_widget_name: "accounts-open",
                                set_label: "Accounts",
                                add_css_class: "flat",
                                add_css_class: "accounts-open",
                            },
                        },
                    },

                    // Overlay host (plan §5.3): Resources / Insights / Help
                    // attach as overlay children in M2 — overlays must never
                    // unmount the main area, hence the GtkOverlay layering
                    // exists from day one. B3's MainPane (toolbar + banners +
                    // view stack) mounts here after init (it needs the toplevel
                    // window for its Ctx).
                    #[name = "overlay_host"]
                    #[wrap(Some)]
                    set_end_child = &gtk::Overlay {
                        set_widget_name: "overlay-host",
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

                    // Live ConnectionState, for the remote-control harness only
                    // — never shown (zero-width, no_show_all-equivalent via
                    // set_visible(false) would make it unreadable, so it stays
                    // "visible" but empty-sized).
                    //
                    // Why this exists: when the app wedges there is no signal at
                    // all — 0% CPU, empty log — and the BANNER is only the
                    // symptom. The cause is the ConnectionState the app last
                    // received, and the two can DISAGREE: state Disconnected
                    // while the banner still shows reconnecting copy means the
                    // fault is app-side delivery/handling; a state that never
                    // left Reconnecting means it is the client's give-up path.
                    // Exposing it as a named label lets the E2E timeout capture
                    // read cause and symptom side by side (M4 D2a).
                    #[name = "conn_state_label"]
                    gtk::Label {
                        set_widget_name: "debug-connection-state",
                        set_label: "initial",
                        set_width_request: 0,
                        set_max_width_chars: 1,
                        set_opacity: 0.0,
                    },

                    // The overlay triggers (Resources / Insights / sound / Help)
                    // and the demo dialog menu used to live here. They now sit in
                    // the sidebar header where Electron puts them
                    // (`Sidebar.tsx:1359–1385`); the strip is status text only.
                },
            },
        }
    }

    fn init(
        init: Self::Init,
        root: Self::Root,
        sender: ComponentSender<Self>,
    ) -> ComponentParts<Self> {
        // BEFORE the stylesheet: `theme.css` names Inter, and a font-family
        // that resolves before its face is registered falls back permanently
        // for the widgets already styled. This call was previously absent
        // entirely — `load_app_fonts` was defined and re-exported but never
        // invoked, so the bundled terminal symbol subset was never registered
        // either (its status glyphs had been silently falling back to the
        // proportional system face the subset exists to avoid).
        crate::terminal::load_app_fonts();
        relm4::set_global_css(include_str!("theme.css"));
        if let Some(settings) = gtk::Settings::default() {
            settings.set_gtk_application_prefer_dark_theme(true);
        }

        let state_path = state::state_path(&state::orchestra_home());
        let state = Rc::new(RefCell::new(UiState::load(&state_path)));
        // Synchronous backend creation is mock-only (make_backend returns None
        // for non-mock): the mock is the entire backend. A real backend is
        // discovered/spawned asynchronously by the attach-flow worker below (its
        // blocking socket polls, daemon spawn, and handshake must not stall the
        // first present), so it starts life as `None`.
        let backend = make_backend();
        let sound = Rc::new(SoundPlayer::new(&state::orchestra_home()));

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
            widgets
                .paned
                .set_position(st.sidebar_width.unwrap_or(SIDEBAR_WIDTH_DEFAULT));
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

        if let Some(sock) = init.remote_control {
            remote_control::serve(sock);
        }

        let retry_active = Rc::new(Cell::new(backend.is_none()));
        let mut attach_in_flight = false;
        if let Some(b) = backend.as_deref() {
            // Mock path: the backend is live now — start its stream fan-out.
            spawn_backend_streams(&sender, b);
        } else {
            // Real path: no synchronous backend. Reveal the banner and kick the
            // first attach worker immediately (allow_spawn: it may start the
            // daemon). The 3 s retry timer (start_retry_loop → Msg::RetryDiscover)
            // re-runs discovery only (allow_spawn: false) if this one leaves no
            // backend — one auto-spawn attempt per launch is enough; repeated
            // spawns would fight the backend lock.
            widgets.banner.set_reveal_child(true);
            widgets.banner_label.set_label("connecting to a backend…");
            attach_in_flight = true;
            spawn_attach(&sender, true);
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

        // At init the only synchronous backend is the mock, which is always
        // reachable; a real one attaches later via the attach flow.
        widgets.footer_label.set_label(&footer_text(&backend, true));

        // Mount the real sidebar INTO the sidebar_host box (a child of the
        // paned start child, which also holds the accounts footer below it —
        // so this is an append, NOT a paned-start-child swap that would drop
        // the footer). Forward its selection output for the shell + B3.
        let sidebar = Sidebar::builder()
            .launch(SidebarInit {
                backend: backend.clone(),
                state: state.clone(),
                state_path: state_path.clone(),
            })
            .forward(sender.input_sender(), |out| match out {
                crate::sidebar::SidebarOutput::WorkspaceActivated(id) => {
                    Msg::WorkspaceActivated(id)
                }
                crate::sidebar::SidebarOutput::HeaderAction(action) => match action {
                    crate::sidebar::HeaderAction::OpenResources => {
                        Msg::ToggleOverlay(OverlayKind::Resources)
                    }
                    crate::sidebar::HeaderAction::OpenInsights => {
                        Msg::ToggleOverlay(OverlayKind::Insights)
                    }
                    crate::sidebar::HeaderAction::OpenHelp => Msg::ToggleOverlay(OverlayKind::Help),
                    crate::sidebar::HeaderAction::OpenSoundPicker => Msg::OpenSoundPicker,
                    crate::sidebar::HeaderAction::OpenAccounts => Msg::OpenAccounts,
                },
            });
        widgets.sidebar_host.append(sidebar.widget());

        // B5: mount the Insights section into the sidebar's `insights-slot`
        // (§5.1 — between the workspace list and the usage bars). B1 builds the
        // slot; we populate it. Clicking the row toggles the Insights overlay.
        let insights_section =
            find_named(sidebar.widget().upcast_ref(), "insights-slot").map(|slot| {
                let section = InsightsSection::new({
                    let sender = sender.clone();
                    move || sender.input(Msg::ToggleOverlay(OverlayKind::Insights))
                });
                slot.append(section.widget());
                section
            });

        // Accounts/usage/login controller: needs a backend to render against.
        let accounts = backend.as_ref().map(|b| {
            attach_accounts(
                b.clone(),
                &widgets.main_window,
                &widgets.sidebar_footer,
                &widgets.accounts_button,
            )
        });

        // Shared context + main pane (toolbar / banners / view stack). The Ctx
        // is the single seam every main-pane widget calls through; it holds the
        // toplevel window (dialog parent + visible-poll gate) and the backend.
        let ctx = Ctx::new(widgets.main_window.clone().upcast::<gtk::Window>());
        ctx.set_backend(backend.clone());
        {
            // A mutation that returns an updated Workspace (switchBranch,
            // queuePrompt) re-enters the loop as a synthesized workspaceUpdate,
            // so the sidebar + main pane refresh together off the one fan-out.
            let sender = sender.clone();
            ctx.set_on_workspace_mutated(move |ws| {
                sender.input(Msg::BackendEvent(BackendEvent::Event {
                    channel: "workspaceUpdate".into(),
                    args: vec![serde_json::to_value(ws).unwrap_or(serde_json::Value::Null)],
                }));
            });
        }
        let main_pane = MainPane::new(ctx.clone());
        widgets.overlay_host.set_child(Some(main_pane.widget()));

        // B5 overlays layer ON TOP of the main pane (its always-present base
        // child) via add_overlay — Resources/Insights/Help cover the pane like
        // the Electron model, and never unmount it. They poll/stream through
        // their own backend clone.
        let overlays = backend.as_ref().map(|b| {
            Overlays::new(
                &widgets.overlay_host,
                b.clone(),
                state.clone(),
                sound.clone(),
            )
        });
        // Notification click → present the window + select the workspace
        // (routes through the same WorkspaceActivated path the sidebar uses).
        if let Some(app) = widgets.main_window.application() {
            let sender = sender.clone();
            let win = widgets.main_window.clone();
            notify::install_focus_action(&app, move |ws_id| {
                win.present();
                sender.input(Msg::WorkspaceActivated(ws_id));
            });
        }
        // Escape closes the topmost overlay.
        {
            let keys = gtk::EventControllerKey::new();
            let sender = sender.clone();
            keys.connect_key_pressed(move |_, key, _, _| {
                if key == gtk::gdk::Key::Escape {
                    sender.input(Msg::EscapePressed);
                }
                glib::Propagation::Proceed
            });
            widgets.main_window.add_controller(keys);
        }

        // Terminal stack: agent GtkStack into B3's terminal slot (clear the
        // placeholder hint first). Run/nvim panes mount lazily into their slots
        // on first activation. Backend calls resolve `ctx.backend()` per-call.
        let mut terminals = TerminalStack::new(ctx.clone());
        clear_slot(main_pane.terminal_slot());
        main_pane.terminal_slot().append(terminals.agent_widget());
        // B3's toolbar nvim toggle reveals/hides B2's nvim pane (routed through
        // the component so it reaches `&mut terminals`).
        {
            let sender = sender.clone();
            main_pane.connect_nvim_toggled(move |open| sender.input(Msg::NvimToggle(open)));
        }

        // Point the main pane at the persisted (or first) workspace so it isn't
        // empty on launch; the sidebar drives it thereafter via WorkspaceActivated.
        let workspaces = backend
            .as_ref()
            .and_then(|b| b.list_workspaces().ok())
            .unwrap_or_default();
        let initial = state
            .borrow()
            .last_active_workspace
            .as_ref()
            .and_then(|id| workspaces.iter().find(|w| &w.id == id).cloned())
            .or_else(|| workspaces.first().cloned());
        main_pane.set_active(initial.clone());
        // Open the initial workspace's terminal (mounts run/nvim slots, seeds
        // scrollback, shows the pill; the pane's first-fit fires ptyStart).
        if let Some(ws) = &initial {
            open_terminal(&mut terminals, &main_pane, &ctx, ws);
        }
        widgets.footer_label.set_label(&footer_text(&backend, true));

        let model = App {
            backend,
            accounts,
            ctx,
            main_pane,
            terminals,
            workspaces,
            state,
            state_path,
            overlays,
            sound,
            insights_section,
            save_generation: Rc::new(Cell::new(0)),
            retry_active,
            attach_in_flight,
            proto_refused: false,
            // A mock backend (the only synchronous one) is reachable by
            // construction; a real one flips this on its first Connected.
            backend_live: true,
            server_info: None,
            spawned_pid,
            window: widgets.main_window.clone(),
            paned: widgets.paned.clone(),
            sidebar,
            banner: widgets.banner.clone(),
            banner_label: widgets.banner_label.clone(),
            footer_label: widgets.footer_label.clone(),
            conn_state_label: widgets.conn_state_label.clone(),
            sidebar_footer: widgets.sidebar_footer.clone(),
            accounts_button: widgets.accounts_button.clone(),
            overlay_host: widgets.overlay_host.clone(),
        };
        // Seed the sidebar Insights row with the current run history so it
        // shows the last outcome on launch, not just after the next event.
        model.refresh_insights_section();
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
            Msg::FocusChanged(focused) => {
                if let Some(b) = &self.backend {
                    b.set_focused(focused);
                }
            }
            Msg::Connection(state) => {
                // Mirror the CAUSE for the harness before acting on it, so a cut
                // taken mid-handling still reads the state that arrived.
                //
                // STALENESS: this is the only writer besides the attach path
                // (which re-points it at a new connection before that
                // connection's stream can speak). The one residual window is a
                // just-replaced backend whose pump future has not yet noticed
                // its channel closed; it ends as soon as the dropped client
                // closes. Documented rather than silent — a mirror that stops
                // updating reads as authoritative, which is exactly the failure
                // it exists to detect.
                self.conn_state_label.set_label(
                    match &state {
                        ConnectionState::Connected => "Connected".into(),
                        ConnectionState::Reconnecting { attempt, delay_ms } => {
                            format!("Reconnecting{{attempt:{attempt},delay_ms:{delay_ms}}}")
                        }
                        ConnectionState::Disconnected => "Disconnected".into(),
                    }
                    .as_str(),
                );
                match state {
                    ConnectionState::Connected => {
                        self.backend_live = true;
                        self.banner.set_reveal_child(false);
                        // Reconnects re-handshake: re-hydrate the sidebar snapshot
                        // (server info for the footer, missed workspace updates).
                        if let Some(b) = &self.backend {
                            self.sidebar.emit(crate::sidebar::Msg::Attach(b.clone()));
                        }
                        // Re-point the main pane + terminal at the active workspace
                        // (the terminals resolve ctx.backend() per-call, so they pick
                        // up the swapped-in live backend automatically).
                        self.reselect_active();
                        // Missed self-tune transitions while disconnected.
                        self.refresh_insights_section();
                        self.footer_label
                            .set_label(&footer_text(&self.backend, self.backend_live));
                    }
                    ConnectionState::Reconnecting { attempt, delay_ms } => {
                        // The handle survives a reconnect (the client is retrying and
                        // will reuse its streams), but the backend is NOT reachable —
                        // so the footer must stop claiming it is. Without this the UI
                        // contradicts itself: "backend: daemon v0.5.84" in the footer
                        // while the banner says connecting (M4 D1a).
                        self.backend_live = false;
                        self.footer_label
                            .set_label(&footer_text(&self.backend, self.backend_live));
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
                        self.ctx.set_backend(None);
                        // Tear down the accounts controller with the backend: its
                        // usage strip is unmounted below by the fresh attach on
                        // reconnect. Dropping it here stops its minute-tick timer.
                        if let Some(accounts) = self.accounts.take() {
                            self.sidebar_footer.remove(&accounts.usage_bars_root());
                        }
                        // Same teardown for the overlays, and for the same
                        // reason: the reconnect's attach builds a FRESH set
                        // against the new backend, so the old widgets have to
                        // leave the host or every reconnect stacks another three
                        // overlays on top of the main pane (the old ones holding
                        // a backend that is gone). Dropping the controller also
                        // stops the Resources 2 s poll.
                        if let Some(overlays) = self.overlays.take() {
                            overlays.unmount(&self.overlay_host);
                        }
                        self.banner_label.set_label(NO_BACKEND_BANNER);
                        self.banner.set_reveal_child(true);
                        // backend is None here, so `live` is moot — pass the flag
                        // anyway so every call site reads uniformly.
                        self.backend_live = false;
                        self.footer_label
                            .set_label(&footer_text(&self.backend, self.backend_live));
                        Self::start_retry_loop(&self.retry_active, &sender);
                    }
                }
            }
            Msg::BackendEvent(ev) => {
                // App owns the single events() consumer (spawn_backend_streams);
                // it fans each frame out to the components that care. The sidebar
                // decodes workspace:update/removed itself (its apply_event), so
                // we forward the raw frame rather than mutating a duplicate list.
                let BackendEvent::Event { channel, args } = &ev;
                eprintln!("[backend] event '{channel}'");
                // Fan out to the main pane (B3): workspaceUpdate → toolbar/
                // banners, ptyExit → run toggle, sandboxControl → sandbox bar.
                self.dispatch_to_main_pane(channel, args);
                // Decode a COPY once and hand it to the fan-out consumers that
                // want the typed event (accounts, B5 overlays/notify/chime); the
                // raw frame still goes to the sidebar (it decodes its own
                // workspace:update/removed via apply_event).
                match (orchestra_rpc::Event {
                    channel: channel.clone(),
                    args: args.clone(),
                })
                .decode()
                {
                    Ok(decoded) => {
                        if let Some(accounts) = &self.accounts {
                            accounts.handle_event(&decoded);
                        }
                        // Insights owns the self-tune stream — hand it every event.
                        if let Some(overlays) = &self.overlays {
                            overlays.dispatch(&decoded);
                        }
                        match &decoded {
                            // Desktop notification (plan §5.6). The backend already
                            // gates on focus, so every uiNotify we get is meant to show.
                            UiEvent::UiNotify(n) => {
                                if let Some(app) = self.window.application() {
                                    notify::show(&app, n);
                                }
                            }
                            // Chime when an agent finishes while unfocused (the
                            // event's `focused` flag is the OR across clients; play
                            // only when false — the Electron chime gate).
                            UiEvent::AgentFinished { focused: false, .. } => {
                                let id = crate::sound::selected_sound_id(&self.state.borrow());
                                self.sound.play(id);
                            }
                            // Keep the sidebar Insights row in step with the
                            // run (idle summary ↔ per-step spinner rows).
                            UiEvent::SelfTuneUpdate(_) => self.refresh_insights_section(),
                            _ => {}
                        }
                    }
                    Err(e) => eprintln!("[backend] event decode failed: {e}"),
                }
                self.sidebar.emit(crate::sidebar::Msg::Backend(ev));
            }
            Msg::PtyData(id, bytes) => {
                // Login-PTY bytes go to the accounts controller; workspace PTYs
                // (`<ws>`, `<ws>:run`, `<ws>:nvim`) go to B2's terminal stack.
                // Additive: the stack drops ids with no pane, accounts ignores
                // workspace ids — each consumes only what it owns.
                if let Some(accounts) = &self.accounts {
                    accounts.handle_pty_data(&id, &bytes);
                }
                self.terminals.feed(&id, &bytes);
            }
            Msg::WorkspaceActivated(id) => {
                // The sidebar announced a row-select. Point the main pane at it
                // (§5.3 setActive: diff/toolbar/banners + markSeen), and retarget
                // the usage strip to that workspace's login. last_active_workspace
                // is already persisted by the sidebar itself.
                eprintln!("[shell] workspace activated: {id}");
                let ws = self.workspaces.iter().find(|w| w.id == id).cloned();
                self.main_pane.set_active(ws.clone());
                if let Some(ws) = &ws {
                    open_terminal(&mut self.terminals, &self.main_pane, &self.ctx, ws);
                }
                if let Some(accounts) = &self.accounts {
                    accounts.set_active_workspace(Some(id));
                }
            }
            Msg::NvimToggle(open) => {
                self.terminals.set_nvim_open(open);
            }
            Msg::ToggleOverlay(kind) => {
                if let Some(overlays) = &self.overlays {
                    overlays.toggle(kind);
                    self.sync_insights_active();
                }
            }
            Msg::EscapePressed => {
                if let Some(overlays) = &self.overlays {
                    overlays.on_escape();
                    self.sync_insights_active();
                }
            }
            Msg::OpenAccounts => {
                // Opens the same accounts settings window the footer usage-bar
                // button does (accounts/mod.rs open_settings -> settings::open).
                // Guarded because the controller is absent until the backend
                // connects, exactly like the other self.accounts call sites.
                if let Some(accounts) = &self.accounts {
                    accounts.open_settings();
                }
            }
            Msg::OpenSoundPicker => {
                let selected = crate::sound::selected_sound_id(&self.state.borrow()).to_string();
                let state = self.state.clone();
                let sender2 = sender.clone();
                crate::sound::open_sound_settings(
                    &self.window.clone().upcast(),
                    self.sound.clone(),
                    &selected,
                    move |id| {
                        state.borrow_mut().notification_sound = Some(id.to_string());
                        sender2.input(Msg::PersistNow);
                    },
                );
            }
            Msg::Attach(update) => self.on_attach(update, &sender),
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
    fn on_attach(&mut self, update: AttachUpdate, sender: &ComponentSender<Self>) {
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
                        RemoteKind::Electron => "Electron app",
                        RemoteKind::Daemon => "daemon",
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

                // The probe validated the handshake; now open the persistent
                // transport on the same socket and wire it into every consumer
                // (the same wiring the mock path does synchronously in init).
                let backend: Rc<dyn Backend> = match RpcBackend::connect(sock) {
                    Ok(b) => Rc::new(b),
                    Err(e) => {
                        // The socket answered the probe but the live connect
                        // failed (raced a backend restart?) — fall back to the
                        // retry loop rather than attaching a dead backend.
                        self.banner.set_reveal_child(true);
                        self.banner_label
                            .set_label(&format!("backend connect failed: {e} (retrying)"));
                        Self::start_retry_loop(&self.retry_active, sender);
                        return;
                    }
                };
                // Re-point the state mirror at the NEW connection before its
                // stream can report anything. Without this the mirror keeps the
                // previous client's last state across an attach — stale, and
                // stale reads as authoritative, which is the same disease as a
                // footer claiming attached. The mirror must never describe a
                // connection that no longer exists.
                self.conn_state_label
                    .set_label("Connected(attached, awaiting first stream event)");
                spawn_backend_streams(sender, backend.as_ref());
                backend.set_focused(self.window.is_active());
                self.accounts = Some(attach_accounts(
                    backend.clone(),
                    &self.window,
                    &self.sidebar_footer,
                    &self.accounts_button,
                ));
                // Same reason as `accounts` above: these need a backend to poll
                // and stream against, and at init there is none on any non-mock
                // path (`make_backend` returns None), so the init-time
                // construction is skipped and Resources/Insights/Help would stay
                // dead no-ops for the whole session. Build them here instead.
                //
                // This adds NO second consumer of events(): the overlays only
                // hold an `Rc<dyn Backend>` for request/response `call`s, and
                // their event input arrives push-style via `overlays.dispatch`
                // from App's single pump (`spawn_backend_streams`). A second
                // `events()` loop would work-steal frames away from the sidebar.
                self.overlays = Some(Overlays::new(
                    &self.overlay_host,
                    backend.clone(),
                    self.state.clone(),
                    self.sound.clone(),
                ));
                self.ctx.set_backend(Some(backend.clone()));
                self.backend = Some(backend.clone());
                // Hand the live backend to the sidebar: it hydrates its own
                // snapshot. App owns the events() pump and forwards frames.
                self.sidebar
                    .emit(crate::sidebar::Msg::Attach(backend.clone()));
                // The probe just handshook this socket, so it is reachable.
                self.backend_live = true;
                self.footer_label
                    .set_label(&footer_text(&self.backend, self.backend_live));
                self.reselect_active();
                // Startup dependency check (parity with the Electron app's
                // checkDependencies at src/main/index.ts): the backend is the
                // only side that can probe git/gh/claude, so this runs on the
                // first successful attach.
                self.check_dependencies(&backend);

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

    /// Re-read the self-tune run list and refresh the sidebar Insights row
    /// (§5.1). Cheap: `listSelfTuneRuns` is an in-memory list backend-side, and
    /// this only fires on self-tune transitions / attach.
    fn refresh_insights_section(&self) {
        let (Some(section), Some(backend)) = (&self.insights_section, &self.backend) else {
            return;
        };
        match backend.call("listSelfTuneRuns", vec![]) {
            Ok(v) => match serde_json::from_value::<Vec<orchestra_rpc::types::SelfTuneRun>>(v) {
                Ok(runs) => section.set_runs(&runs),
                Err(e) => eprintln!("[insights] bad listSelfTuneRuns shape: {e}"),
            },
            Err(e) => eprintln!("[insights] listSelfTuneRuns failed: {e}"),
        }
    }

    /// Highlight the sidebar Insights row while its overlay is the active one.
    fn sync_insights_active(&self) {
        if let Some(section) = &self.insights_section {
            let active = self
                .overlays
                .as_ref()
                .is_some_and(|o| o.active() == Some(OverlayKind::Insights));
            section.set_active(active);
        }
    }

    /// Startup dependency warning — parity with the Electron app's
    /// `checkDependencies` (src/main/index.ts): probe `deps:status` through the
    /// freshly-attached backend and, if anything is missing, show a BLOCKING
    /// dialog with Electron's exact copy and its Continue Anyway / Quit
    /// choice (Quit is the default action there, and quitting ends the app).
    ///
    /// Only the backend can run the probe, so this fires on attach rather than
    /// at startup; a frontend with no backend has nothing to warn about yet.
    fn check_dependencies(&self, backend: &Rc<dyn Backend>) {
        // The call is a blocking RPC; keep it off the first paint by deferring
        // to the main loop's idle, then only surface a dialog if it reports gaps.
        let backend = backend.clone();
        let win = self.window.clone().upcast::<gtk::Window>();
        glib::spawn_future_local(async move {
            let status = match backend.call("deps:status", vec![]) {
                Ok(v) => match serde_json::from_value::<orchestra_rpc::types::DepsStatus>(v) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[deps] status decode failed: {e}");
                        return;
                    }
                },
                Err(e) => {
                    // A backend that doesn't serve deps:status (older release,
                    // or the mock) simply gets no warning — never a hard error.
                    eprintln!("[deps] status unavailable: {e}");
                    return;
                }
            };
            if status.messages.is_empty() {
                return;
            }
            // Electron's wording, verbatim: title "Missing Dependencies",
            // message "Orchestra requires the following tools:", detail =
            // messages joined by a blank line, buttons Continue Anyway / Quit.
            let body = format!(
                "Orchestra requires the following tools:\n\n{}",
                status.messages.join("\n\n")
            );
            let cont = dialogs::confirm_labeled(
                &win,
                dialogs::Tone::Error,
                "Missing Dependencies",
                &body,
                "Continue Anyway",
                "Quit",
            )
            .await;
            if !cont {
                // Matches Electron's defaultId: 1 → app.quit().
                if let Some(app) = win
                    .downcast_ref::<gtk::ApplicationWindow>()
                    .and_then(|w| w.application())
                {
                    app.quit();
                } else {
                    win.close();
                }
            }
        });
    }

    /// Route a decoded backend event to the main pane, then keep App's own
    /// workspace mirror current. Only the channels the main pane consumes are
    /// handled here; the sidebar + accounts own the rest via their own fan-out.
    fn dispatch_to_main_pane(&mut self, channel: &str, args: &[serde_json::Value]) {
        match channel {
            // workspaceUpdate: a single Workspace record changed.
            "workspaceUpdate" => {
                if let Some(ws) = args
                    .first()
                    .and_then(|v| serde_json::from_value::<Workspace>(v.clone()).ok())
                {
                    if let Some(slot) = self.workspaces.iter_mut().find(|w| w.id == ws.id) {
                        *slot = ws.clone();
                    } else {
                        self.workspaces.push(ws.clone());
                    }
                    self.main_pane.on_workspace_changed(&ws);
                }
            }
            // ptyExit: (ptyId) — clears the run toggle when the run pty exits,
            // and shows B2's "press any key to relaunch" notice on the pane.
            "ptyExit" => {
                if let Some(id) = args.first().and_then(|v| v.as_str()) {
                    self.main_pane.on_pty_exit(id);
                    self.terminals.on_exit(id, false);
                }
            }
            // ptyStopped / ptyRestart: B2 terminal lifecycle.
            "ptyStopped" => {
                if let Some(id) = args.first().and_then(|v| v.as_str()) {
                    self.terminals.on_exit(id, true);
                }
            }
            "ptyRestart" => {
                if let Some(id) = args.first().and_then(|v| v.as_str()) {
                    self.terminals.on_restart(id);
                }
            }
            // sandboxControl: SandboxControlState — drives the read-only bar.
            "sandboxControl" => {
                if let Some(state) = args.first().and_then(|v| {
                    serde_json::from_value::<orchestra_rpc::types::SandboxControlState>(v.clone())
                        .ok()
                }) {
                    self.main_pane.on_sandbox_control(state);
                }
            }
            _ => {}
        }
    }

    /// Re-resolve the persisted active workspace against a freshly-attached
    /// backend and point the main pane at it.
    fn reselect_active(&mut self) {
        self.workspaces = self
            .backend
            .as_ref()
            .and_then(|b| b.list_workspaces().ok())
            .unwrap_or_default();
        let active = self
            .state
            .borrow()
            .last_active_workspace
            .as_ref()
            .and_then(|id| self.workspaces.iter().find(|w| &w.id == id).cloned())
            .or_else(|| self.workspaces.first().cloned());
        self.main_pane.set_active(active.clone());
        // Open the terminal too, so a reconnect (or an init that raced the
        // daemon socket) starts the agent PTY — not just repaints the chrome.
        if let Some(ws) = &active {
            open_terminal(&mut self.terminals, &self.main_pane, &self.ctx, ws);
        }
    }

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
