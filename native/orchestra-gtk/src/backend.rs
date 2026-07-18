//! Backend seam for the GTK frontend (plan §1.1 / M1-A3).
//!
//! The GTK app is a pure frontend: everything of substance lives behind a
//! ui-rpc socket served by the Electron app or the daemon. This module keeps
//! the crate building (and demoable) before that wiring exists: `Backend` is
//! the narrow surface the skeleton needs, `MockBackend` serves fixtures, and
//! `RpcBackend` is a stub over orchestra-rpc's current codec/types surface —
//! its connection actor is A2's deliverable and gets wired in M2.

use std::path::{Path, PathBuf};

use orchestra_rpc::frame::{self, Frame};
use orchestra_rpc::types::{RepoEntry, Workspace, WorkspaceStatus};
use serde_json::{json, Value};

pub type Result<T> = std::result::Result<T, BackendError>;

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("not wired yet: {0}")]
    NotWired(&'static str),
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
    fn list_workspaces(&self) -> Result<Vec<Workspace>>;
    fn list_repos(&self) -> Result<Vec<RepoEntry>>;
    /// Generic `OrchestraAPI` method call (protocol §4).
    fn call(&self, method: &str, params: Vec<Value>) -> Result<Value>;
    /// Receiver for `event` frames. Single consumer (the app shell) in M1.
    fn events(&self) -> async_channel::Receiver<BackendEvent>;
    /// Receiver for `ptyData` frames: (pty id, raw bytes).
    fn pty_data(&self) -> async_channel::Receiver<(String, Vec<u8>)>;
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
    // Held so the receivers stay open (a dropped sender closes the channel);
    // the mock never actually pushes.
    _events_tx: async_channel::Sender<BackendEvent>,
    events_rx: async_channel::Receiver<BackendEvent>,
    _pty_tx: async_channel::Sender<(String, Vec<u8>)>,
    pty_rx: async_channel::Receiver<(String, Vec<u8>)>,
}

impl Default for MockBackend {
    fn default() -> Self {
        let (events_tx, events_rx) = async_channel::unbounded();
        let (pty_tx, pty_rx) = async_channel::unbounded();
        Self {
            _events_tx: events_tx,
            events_rx,
            _pty_tx: pty_tx,
            pty_rx,
        }
    }
}

fn mock_workspace(id: &str, name: &str, branch: &str, status: WorkspaceStatus) -> Workspace {
    Workspace {
        id: id.into(),
        name: name.into(),
        kind: None,
        repo_path: "/home/user/repos/orchestra".into(),
        worktree_path: format!("/home/user/.orchestra/worktrees/{branch}"),
        branch: branch.into(),
        base_branch: "master".into(),
        status,
        parent_id: None,
        archived: None,
        host: None,
        marked_unread: None,
        context_tokens: None,
    }
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
        Ok(vec![RepoEntry {
            path: "/home/user/repos/orchestra".into(),
            name: "orchestra".into(),
            default_branch: "master".into(),
            remote_url: None,
            account_id: None,
        }])
    }

    fn call(&self, method: &str, _params: Vec<Value>) -> Result<Value> {
        match method {
            "app:info" => Ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "backendKind": "mock",
            })),
            _ => Err(BackendError::NotWired("mock backend only serves fixtures")),
        }
    }

    fn events(&self) -> async_channel::Receiver<BackendEvent> {
        self.events_rx.clone()
    }

    fn pty_data(&self) -> async_channel::Receiver<(String, Vec<u8>)> {
        self.pty_rx.clone()
    }

    fn pty_write(&self, _id: &str, _bytes: &[u8]) -> Result<()> {
        Ok(())
    }

    fn set_focused(&self, _focused: bool) {}
}

// ---- rpc stub ---------------------------------------------------------------

/// Thin stub over the ui-rpc socket. It codes against orchestra-rpc's frozen
/// codec (`frame.rs`) and types (`types.rs`) but does NO socket IO yet: the
/// tokio connection actor is A2's M1 deliverable, and this struct grows the
/// real transport in M2. Until then every method reports NotWired and the
/// shell shows the discovered-but-unwired state in the status strip.
#[derive(Debug)]
pub struct RpcBackend {
    sock_path: PathBuf,
    _events_tx: async_channel::Sender<BackendEvent>,
    events_rx: async_channel::Receiver<BackendEvent>,
    _pty_tx: async_channel::Sender<(String, Vec<u8>)>,
    pty_rx: async_channel::Receiver<(String, Vec<u8>)>,
}

impl RpcBackend {
    pub fn new(sock_path: PathBuf) -> Self {
        let (events_tx, events_rx) = async_channel::unbounded();
        let (pty_tx, pty_rx) = async_channel::unbounded();
        Self {
            sock_path,
            _events_tx: events_tx,
            events_rx,
            _pty_tx: pty_tx,
            pty_rx,
        }
    }

    pub fn sock_path(&self) -> &Path {
        &self.sock_path
    }

    /// The `hello` frame this client will send on connect (protocol §3),
    /// encoded with the frozen codec. Exercised by tests today, by the M2
    /// connection actor tomorrow.
    pub fn hello_frame() -> Vec<u8> {
        frame::encode(&Frame::Json(json!({
            "t": "hello",
            "proto": 1,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "clientKind": "gtk",
            "focused": true,
        })))
        .expect("hello frame is well under the frame cap")
    }
}

impl Backend for RpcBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Rpc
    }

    fn version(&self) -> String {
        // Real version arrives in the helloOk handshake (M2).
        "?".into()
    }

    fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        Err(BackendError::NotWired("RpcBackend transport lands in M2"))
    }

    fn list_repos(&self) -> Result<Vec<RepoEntry>> {
        Err(BackendError::NotWired("RpcBackend transport lands in M2"))
    }

    fn call(&self, _method: &str, _params: Vec<Value>) -> Result<Value> {
        Err(BackendError::NotWired("RpcBackend transport lands in M2"))
    }

    fn events(&self) -> async_channel::Receiver<BackendEvent> {
        self.events_rx.clone()
    }

    fn pty_data(&self) -> async_channel::Receiver<(String, Vec<u8>)> {
        self.pty_rx.clone()
    }

    fn pty_write(&self, _id: &str, _bytes: &[u8]) -> Result<()> {
        Err(BackendError::NotWired("RpcBackend transport lands in M2"))
    }

    fn set_focused(&self, _focused: bool) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchestra_rpc::frame::Decoder;

    #[test]
    fn hello_frame_decodes_with_the_frozen_codec() {
        let mut d = Decoder::new();
        d.feed(&RpcBackend::hello_frame());
        let Frame::Json(v) = d.next_frame().unwrap().unwrap() else {
            panic!("hello must be a JSON frame");
        };
        assert_eq!(v["t"], "hello");
        assert_eq!(v["proto"], 1);
        assert_eq!(v["clientKind"], "gtk");
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
