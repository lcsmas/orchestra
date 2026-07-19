//! Backend seam for the GTK frontend (plan §1.1 / M1-A3, wired M2-B2).
//!
//! The GTK app is a pure frontend: everything of substance lives behind a
//! ui-rpc socket served by the Electron app or the daemon. `Backend` is the
//! narrow surface the shell needs, `MockBackend` serves fixtures, and
//! `RpcBackend` is the live transport: it owns an [`orchestra_rpc::RpcClient`]
//! (reader thread, ping/pong, reconnect-with-backoff) and bridges its blocking
//! `mpsc` receivers into `async_channel`s the GTK main loop can await.

use std::cell::Cell;
use std::path::{Path, PathBuf};

use orchestra_rpc::types::{RepoEntry, Workspace, WorkspaceStatus};
use orchestra_rpc::{BackendKind as RemoteKind, ClientOptions, ConnectionState, RpcClient};
use serde_json::{json, Value};

use crate::backend_fixtures;

pub type Result<T> = std::result::Result<T, BackendError>;

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("not wired yet: {0}")]
    NotWired(&'static str),
    #[error(transparent)]
    Rpc(#[from] orchestra_rpc::RpcError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Mock,
    Rpc,
}

impl BackendKind {
    pub fn label(self) -> &'static str {
        match self {
            BackendKind::Mock => "mock",
            BackendKind::Rpc => "rpc",
        }
    }
}

/// Push traffic from the backend (docs/ui-rpc-protocol.md §5–6), decoded one
/// layer up from the frame codec.
#[derive(Debug, Clone)]
pub enum BackendEvent {
    /// An `event` frame — the 22 `on*` channels of `OrchestraAPI`.
    Event { channel: String, args: Vec<Value> },
}

pub trait Backend: std::fmt::Debug {
    fn kind(&self) -> BackendKind;
    /// Backend app version for the status strip ("backend: mock v0.1.0 · …").
    fn version(&self) -> String;
    /// What the remote reported in `helloOk.backendKind` (Rpc only).
    fn server_kind(&self) -> Option<RemoteKind> {
        None
    }
    fn list_workspaces(&self) -> Result<Vec<Workspace>>;
    fn list_repos(&self) -> Result<Vec<RepoEntry>>;
    /// Generic `OrchestraAPI` method call (protocol §4).
    fn call(&self, method: &str, params: Vec<Value>) -> Result<Value>;
    /// Receiver for `event` frames. Single consumer (the app shell) in M1.
    fn events(&self) -> async_channel::Receiver<BackendEvent>;
    /// Receiver for `ptyData` frames: (pty id, raw bytes). Single consumer
    /// (async_channel is MPMC work-stealing, NOT broadcast — one message goes
    /// to one receiver; the terminal stack must be the only reader).
    fn pty_data(&self) -> async_channel::Receiver<(String, Vec<u8>)>;
    /// Receiver for connection lifecycle transitions (Connected /
    /// Reconnecting / terminal Disconnected). Mock backends never fire.
    fn connection_state(&self) -> async_channel::Receiver<ConnectionState>;
    /// `ptyWrite` fast path (protocol §2, 0x02 frames).
    fn pty_write(&self, id: &str, bytes: &[u8]) -> Result<()>;
    /// `focus` frame — the backend ORs this over all clients to decide the
    /// `focused` flag on finished/needs-input notifications.
    fn set_focused(&self, focused: bool);
}

// ---- discovery --------------------------------------------------------------

/// Locate the ui-rpc socket (protocol §1): `$ORCHESTRA_UI_SOCK` overrides;
/// otherwise the pointer file `<home>/ui-sock` names it. Returns a path only
/// if the socket actually exists on disk right now.
pub fn discover_socket(home: &Path) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ORCHESTRA_UI_SOCK") {
        let p = PathBuf::from(p);
        return p.exists().then_some(p);
    }
    discover_socket_via_pointer(home)
}

fn discover_socket_via_pointer(home: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(home.join("ui-sock")).ok()?;
    let p = PathBuf::from(raw.trim());
    p.exists().then_some(p)
}

/// M2 stub (plan §1.1 rule 3): when discovery fails, spawn the daemon
/// (`Orchestra.AppImage daemon` via the `~/.local/bin/orchestra` shim's
/// APPIMAGE, else `$ORCHESTRA_DAEMON_CMD`) and re-attach. M1 only surfaces
/// the retry banner; this exists so the call site is already in place.
pub fn spawn_daemon_stub() {}

/// Run-time mock switch: the `mock` cargo feature forces it, and
/// `ORCHESTRA_GTK_MOCK=1` selects it without rebuilding.
pub fn mock_requested() -> bool {
    cfg!(feature = "mock") || std::env::var("ORCHESTRA_GTK_MOCK").is_ok_and(|v| v == "1")
}

// ---- mock -------------------------------------------------------------------

/// Fixture backend so the skeleton renders real pixels (and smoke.sh has
/// something to assert) before any backend exists.
#[derive(Debug)]
pub struct MockBackend {
    // The events sender IS used: `startSelfTune` spawns a thread that replays
    // timed selfTuneUpdate/selfTuneOutput frames through a clone of it, so the
    // Insights overlay animates a live run in mock mode.
    events_tx: async_channel::Sender<BackendEvent>,
    events_rx: async_channel::Receiver<BackendEvent>,
    _pty_tx: async_channel::Sender<(String, Vec<u8>)>,
    pty_rx: async_channel::Receiver<(String, Vec<u8>)>,
    _state_tx: async_channel::Sender<ConnectionState>,
    state_rx: async_channel::Receiver<ConnectionState>,
    /// Advances on each `sampleResources` poll so sparklines/traces animate.
    tick: Cell<u64>,
    /// One in-flight fake run at a time — `startSelfTune` rejects if set, like
    /// the real backend's single-run guard.
    self_tune_running: Cell<bool>,
}

impl Default for MockBackend {
    fn default() -> Self {
        let (events_tx, events_rx) = async_channel::unbounded();
        let (pty_tx, pty_rx) = async_channel::unbounded();
        let (state_tx, state_rx) = async_channel::unbounded();
        Self {
            events_tx,
            events_rx,
            _pty_tx: pty_tx,
            pty_rx,
            _state_tx: state_tx,
            state_rx,
            tick: Cell::new(0),
            self_tune_running: Cell::new(false),
        }
    }
}

fn mock_workspace(id: &str, name: &str, branch: &str, status: WorkspaceStatus) -> Workspace {
    // Deserialized rather than struct-literal so new fields on the wire type
    // (all Option per the serde rules) can never break the fixture backend.
    serde_json::from_value(json!({
        "id": id,
        "name": name,
        "repoPath": "/home/user/repos/orchestra",
        "worktreePath": format!("/home/user/.orchestra/worktrees/{branch}"),
        "branch": branch,
        "baseBranch": "master",
        "status": status,
        "createdAt": 1_752_800_000_000_u64,
        "agent": "claude",
    }))
    .expect("mock workspace fixture matches the wire type")
}

pub fn mock_workspaces() -> Vec<Workspace> {
    vec![
        mock_workspace(
            "ws-1",
            "orchestra · fix-status-dot",
            "fix-status-dot",
            WorkspaceStatus::Running,
        ),
        mock_workspace(
            "ws-2",
            "orchestra · gtk4-port",
            "gtk4-port",
            WorkspaceStatus::Waiting,
        ),
        mock_workspace(
            "ws-3",
            "mobile-club · checkout-retry",
            "checkout-retry",
            WorkspaceStatus::Idle,
        ),
        mock_workspace(
            "ws-4",
            "orchestra · flaky-e2e-hunt",
            "flaky-e2e-hunt",
            WorkspaceStatus::Error,
        ),
        mock_workspace(
            "ws-5",
            "scratch · api-spelunking",
            "api-spelunking",
            WorkspaceStatus::Stopped,
        ),
    ]
}

impl Backend for MockBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Mock
    }

    fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").into()
    }

    fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        Ok(mock_workspaces())
    }

    fn list_repos(&self) -> Result<Vec<RepoEntry>> {
        Ok(vec![serde_json::from_value(json!({
            "path": "/home/user/repos/orchestra",
            "name": "orchestra",
            "defaultBranch": "master",
        }))
        .expect("mock repo fixture matches the wire type")])
    }

    fn call(&self, method: &str, params: Vec<Value>) -> Result<Value> {
        match method {
            "app:info" => Ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "backendKind": "mock",
            })),
            // Resources page (docs/codebase-map/resources.md).
            "sampleResources" => {
                let tick = self.tick.get();
                self.tick.set(tick.wrapping_add(1));
                Ok(backend_fixtures::resource_snapshot(tick))
            }
            "getWorktreeSizes" => Ok(backend_fixtures::worktree_sizes()),
            "listAccounts" => Ok(backend_fixtures::accounts()),
            "getUsage" => Ok(backend_fixtures::global_usage()),
            "getAllAccountUsage" => Ok(backend_fixtures::account_usage()),
            "getWorkspaceAccounts" => Ok(backend_fixtures::workspace_accounts()),
            // stopAgent(id): the mock has nothing to stop — acknowledge.
            "stopAgent" => Ok(json!({ "ok": true })),
            // Insights / self-tune (docs/codebase-map/self-tune.md).
            "listSelfTuneRuns" => Ok(backend_fixtures::self_tune_runs()),
            "getSelfTuneOutput" => {
                let run_id = params.first().and_then(Value::as_str).unwrap_or("");
                Ok(backend_fixtures::self_tune_output(run_id))
            }
            "listSelfTuneReports" => Ok(backend_fixtures::self_tune_reports()),
            "openSelfTuneReport" => Ok(json!({ "ok": true })),
            "readSelfTuneLessons" => Ok(backend_fixtures::lessons_md()),
            "startSelfTune" => self.start_fake_self_tune(),
            _ => Err(BackendError::NotWired("mock backend only serves fixtures")),
        }
    }

    fn events(&self) -> async_channel::Receiver<BackendEvent> {
        self.events_rx.clone()
    }

    fn pty_data(&self) -> async_channel::Receiver<(String, Vec<u8>)> {
        self.pty_rx.clone()
    }

    fn connection_state(&self) -> async_channel::Receiver<ConnectionState> {
        self.state_rx.clone()
    }

    fn pty_write(&self, _id: &str, _bytes: &[u8]) -> Result<()> {
        Ok(())
    }

    fn set_focused(&self, _focused: bool) {}
}

impl MockBackend {
    /// `startSelfTune`: returns the initial `running` run and spawns a thread
    /// that replays timed `selfTuneUpdate`/`selfTuneOutput` frames so the
    /// Insights overlay shows a live run. Rejects if one is already in flight,
    /// mirroring the real backend's single-run guard.
    fn start_fake_self_tune(&self) -> Result<Value> {
        if self.self_tune_running.get() {
            return Ok(json!({ "ok": false, "error": "a self-tune run is already in progress" }));
        }
        self.self_tune_running.set(true);
        let (initial, updates) = backend_fixtures::fake_run_script(backend_fixtures::MOCK_NOW_MS);

        let events_tx = self.events_tx.clone();
        // A background OS thread sleeps between frames; async_channel's
        // send_blocking is safe off the glib main loop and the receiver is
        // pumped there.
        std::thread::spawn(move || {
            let mut prev = 0u64;
            for (at_ms, channel, args) in updates {
                let delay = at_ms.saturating_sub(prev);
                prev = at_ms;
                std::thread::sleep(std::time::Duration::from_millis(delay));
                let _ = events_tx.send_blocking(BackendEvent::Event { channel, args });
            }
        });
        // The guard clears when the mock backend is dropped; a fresh run needs
        // a fresh backend in mock mode (good enough for the demo/E2E path).
        Ok(json!({ "ok": true, "run": initial }))
    }
}

// ---- rpc --------------------------------------------------------------------

/// Bridge a blocking `mpsc` receiver (fed by the RpcClient's reader thread)
/// into an `async_channel` the GTK main loop awaits. The thread exits when
/// either side closes: sender gone (client dropped after a terminal
/// disconnect) or receiver gone (backend replaced).
fn bridge<T: Send + 'static, U: Send + 'static>(
    name: &str,
    rx: std::sync::mpsc::Receiver<T>,
    tx: async_channel::Sender<U>,
    map: impl Fn(T) -> U + Send + 'static,
) {
    std::thread::Builder::new()
        .name(format!("ogtk-bridge-{name}"))
        .spawn(move || {
            while let Ok(item) = rx.recv() {
                if tx.send_blocking(map(item)).is_err() {
                    return;
                }
            }
        })
        .expect("spawn bridge thread");
}

/// Live transport over the ui-rpc socket: an [`RpcClient`] connection actor
/// (reader thread, ping/pong keepalive, reconnect-with-backoff) whose three
/// push streams are re-terminated on async channels for the GTK main loop.
///
/// `connect` performs the hello handshake synchronously (bounded by the
/// client's 10 s handshake timeout); method calls block the caller — fine for
/// init-time hydration, anything hot should go through a worker.
pub struct RpcBackend {
    sock_path: PathBuf,
    client: RpcClient,
    events_rx: async_channel::Receiver<BackendEvent>,
    pty_rx: async_channel::Receiver<(String, Vec<u8>)>,
    state_rx: async_channel::Receiver<ConnectionState>,
}

impl std::fmt::Debug for RpcBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RpcBackend")
            .field("sock_path", &self.sock_path)
            .field("connected", &self.client.is_connected())
            .finish_non_exhaustive()
    }
}

impl RpcBackend {
    /// Connect + handshake against an explicit socket path (from
    /// [`discover_socket`]). Reconnects redial this same path; when the
    /// backend restarts under a new pid-derived path, the client's give-up
    /// surfaces as `Disconnected` and the shell's discovery retry loop
    /// attaches a fresh backend.
    pub fn connect(sock_path: PathBuf) -> std::result::Result<Self, orchestra_rpc::RpcError> {
        let opts = ClientOptions {
            app_version: env!("CARGO_PKG_VERSION").into(),
            ..ClientOptions::default()
        };
        let (client, recv) = RpcClient::connect(&sock_path, opts)?;
        let (events_tx, events_rx) = async_channel::unbounded();
        let (pty_tx, pty_rx) = async_channel::unbounded();
        let (state_tx, state_rx) = async_channel::unbounded();
        bridge("events", recv.events, events_tx, |ev| BackendEvent::Event {
            channel: ev.channel,
            args: ev.args,
        });
        bridge("pty", recv.pty, pty_tx, |chunk| chunk);
        bridge("state", recv.state, state_tx, |s| s);
        Ok(Self {
            sock_path,
            client,
            events_rx,
            pty_rx,
            state_rx,
        })
    }

    pub fn sock_path(&self) -> &Path {
        &self.sock_path
    }

    /// The shared client, for subsystems (terminal stack) that want the typed
    /// wrappers directly rather than the stringly `call` surface.
    pub fn client(&self) -> &RpcClient {
        &self.client
    }
}

impl Drop for RpcBackend {
    fn drop(&mut self) {
        // Deliberate close: stops the reconnect loop and reader thread; the
        // bridge threads then drain and exit on their own.
        self.client.close();
    }
}

impl Backend for RpcBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Rpc
    }

    fn version(&self) -> String {
        self.client
            .server_info()
            .map(|i| i.app_version)
            .unwrap_or_else(|| "?".into())
    }

    fn server_kind(&self) -> Option<RemoteKind> {
        self.client.server_info().map(|i| i.backend_kind)
    }

    fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        Ok(self.client.list_workspaces()?)
    }

    fn list_repos(&self) -> Result<Vec<RepoEntry>> {
        Ok(self.client.list_repos()?)
    }

    fn call(&self, method: &str, params: Vec<Value>) -> Result<Value> {
        Ok(self.client.call(method, params)?)
    }

    fn events(&self) -> async_channel::Receiver<BackendEvent> {
        self.events_rx.clone()
    }

    fn pty_data(&self) -> async_channel::Receiver<(String, Vec<u8>)> {
        self.pty_rx.clone()
    }

    fn connection_state(&self) -> async_channel::Receiver<ConnectionState> {
        self.state_rx.clone()
    }

    fn pty_write(&self, id: &str, bytes: &[u8]) -> Result<()> {
        Ok(self.client.send_pty_write(id, bytes)?)
    }

    fn set_focused(&self, focused: bool) {
        // Best-effort: while disconnected the flag rides the next reconnect's
        // hello, so a send failure here is not a loss.
        let _ = self.client.focus(focused);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchestra_rpc::frame::{encode, Decoder, Frame};
    use std::io::{Read as _, Write as _};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::time::{Duration, Instant};

    /// recv with a deadline so a wiring bug fails the test instead of
    /// hanging it (async_channel has no blocking recv_timeout).
    fn recv_within<T>(rx: &async_channel::Receiver<T>, what: &str) -> T {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match rx.try_recv() {
                Ok(v) => return v,
                Err(async_channel::TryRecvError::Empty) => {
                    assert!(Instant::now() < deadline, "timed out waiting for {what}");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(async_channel::TryRecvError::Closed) => {
                    panic!("channel closed waiting for {what}")
                }
            }
        }
    }

    fn read_json(stream: &mut UnixStream, decoder: &mut Decoder) -> Value {
        let mut buf = [0u8; 16 * 1024];
        loop {
            if let Some(frame) = decoder.next_frame().unwrap() {
                match frame {
                    Frame::Json(v) => return v,
                    _ => continue,
                }
            }
            let n = stream.read(&mut buf).unwrap();
            assert!(n > 0, "client closed while server expected a frame");
            decoder.feed(&buf[..n]);
        }
    }

    fn write_frame(stream: &mut UnixStream, frame: &Frame) {
        stream.write_all(&encode(frame).unwrap()).unwrap();
    }

    /// Full actor round-trip against an in-process fake backend: handshake,
    /// event + ptyData push → async channels, req/res call, focus frame.
    #[test]
    fn rpc_backend_bridges_a_live_server() {
        let dir = std::env::temp_dir().join(format!("orch-gtk-rpc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("ui.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut dec = Decoder::new();

            let hello = read_json(&mut s, &mut dec);
            assert_eq!(hello["t"], "hello");
            assert_eq!(hello["proto"], 1);
            assert_eq!(hello["clientKind"], "gtk");
            write_frame(
                &mut s,
                &Frame::Json(json!({
                    "t": "helloOk", "proto": 1,
                    "appVersion": "9.9.9", "backendKind": "daemon",
                })),
            );
            write_frame(
                &mut s,
                &Frame::Json(json!({
                    "t": "event", "channel": "agentContext",
                    "args": ["ws-1", 42_000],
                })),
            );
            write_frame(
                &mut s,
                &Frame::PtyData {
                    id: "ws-1".into(),
                    bytes: b"hi from pty".to_vec(),
                },
            );

            let req = read_json(&mut s, &mut dec);
            assert_eq!(req["t"], "req");
            assert_eq!(req["method"], "getAppVersion");
            write_frame(
                &mut s,
                &Frame::Json(json!({
                    "t": "res", "id": req["id"], "ok": true, "result": "9.9.9",
                })),
            );

            let focus = read_json(&mut s, &mut dec);
            assert_eq!(focus["t"], "focus");
            assert_eq!(focus["focused"], false);
        });

        let backend = RpcBackend::connect(sock).unwrap();

        assert_eq!(
            recv_within(&backend.connection_state(), "Connected"),
            ConnectionState::Connected
        );
        assert_eq!(backend.version(), "9.9.9");
        assert_eq!(backend.server_kind(), Some(RemoteKind::Daemon));

        let BackendEvent::Event { channel, args } = recv_within(&backend.events(), "event");
        assert_eq!(channel, "agentContext");
        assert_eq!(args, vec![json!("ws-1"), json!(42_000)]);

        let (pty_id, bytes) = recv_within(&backend.pty_data(), "ptyData");
        assert_eq!(pty_id, "ws-1");
        assert_eq!(bytes, b"hi from pty");

        let version = backend.call("getAppVersion", vec![]).unwrap();
        assert_eq!(version, json!("9.9.9"));

        backend.set_focused(false);
        server.join().expect("fake server thread panicked");

        drop(backend);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mock_serves_five_workspaces() {
        let ws = MockBackend::default().list_workspaces().unwrap();
        assert_eq!(ws.len(), 5);
        assert!(ws.iter().any(|w| w.status == WorkspaceStatus::Running));
    }

    #[test]
    fn pointer_discovery_requires_a_live_socket() {
        let dir = std::env::temp_dir().join(format!("orch-gtk-disc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // No pointer file at all.
        assert_eq!(discover_socket_via_pointer(&dir), None);

        // Pointer to a nonexistent socket.
        std::fs::write(dir.join("ui-sock"), "/nonexistent/ui.sock\n").unwrap();
        assert_eq!(discover_socket_via_pointer(&dir), None);

        // Pointer to an existing path (a plain file stands in for the socket).
        let sock = dir.join("ui.sock");
        std::fs::write(&sock, "").unwrap();
        std::fs::write(dir.join("ui-sock"), format!("{}\n", sock.display())).unwrap();
        assert_eq!(discover_socket_via_pointer(&dir), Some(sock));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
