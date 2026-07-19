//! Backend seam for the GTK frontend (plan §1.1 / M1-A3).
//!
//! The GTK app is a pure frontend: everything of substance lives behind a
//! ui-rpc socket served by the Electron app or the daemon. This module keeps
//! the crate building (and demoable) before that wiring exists: `Backend` is
//! the narrow surface the skeleton needs, `MockBackend` serves fixtures, and
//! `RpcBackend` is a stub over orchestra-rpc's current codec/types surface —
//! its connection actor is A2's deliverable and gets wired in M2.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use orchestra_rpc::frame::{self, Frame};
use orchestra_rpc::types::{RepoEntry, Workspace};
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
/// something to assert) before any backend exists. Stateful: `call()` mutates
/// the workspaces (switchBranch, run start/stop, queue add/remove, …) so the
/// B3 toolbar/diff/banners exercise real round-trips in mock mode.
#[derive(Debug)]
pub struct MockBackend {
    state: RefCell<MockState>,
    // Held so the receivers stay open (a dropped sender closes the channel);
    // the mock never actually pushes.
    _events_tx: async_channel::Sender<BackendEvent>,
    events_rx: async_channel::Receiver<BackendEvent>,
    _pty_tx: async_channel::Sender<(String, Vec<u8>)>,
    pty_rx: async_channel::Receiver<(String, Vec<u8>)>,
}

#[derive(Debug)]
struct MockState {
    workspaces: Vec<Workspace>,
    branches: Vec<String>,
    /// `<ws-id>` → run-script PTY live.
    run_live: HashMap<String, bool>,
    /// Per-endpoint sandbox control (mock: ws-6's endpoint, driven elsewhere).
    sandbox: HashMap<String, Value>,
}

impl Default for MockBackend {
    fn default() -> Self {
        let (events_tx, events_rx) = async_channel::unbounded();
        let (pty_tx, pty_rx) = async_channel::unbounded();
        Self {
            state: RefCell::new(MockState {
                workspaces: mock_workspaces(),
                branches: vec![
                    "master".into(),
                    "develop".into(),
                    "fix-status-dot".into(),
                    "gtk4-port".into(),
                    "feature/diff-toolbar".into(),
                    "feature/sandbox-import".into(),
                    "release/0.6".into(),
                ],
                run_live: HashMap::new(),
                sandbox: HashMap::new(),
            }),
            _events_tx: events_tx,
            events_rx,
            _pty_tx: pty_tx,
            pty_rx,
        }
    }
}

/// Build a workspace fixture from a JSON object — deserialized rather than
/// struct-literal so new wire fields (all Option per the serde rules) can never
/// break the fixture backend. `extra` merges over the base object.
fn mock_workspace_json(base: Value) -> Workspace {
    serde_json::from_value(base).expect("mock workspace fixture matches the wire type")
}

pub fn mock_workspaces() -> Vec<Workspace> {
    let ws = |id: &str, name: &str, branch: &str, status: &str, extra: Value| {
        let mut obj = json!({
            "id": id,
            "name": name,
            "repoPath": "/home/user/repos/orchestra",
            "worktreePath": format!("/home/user/.orchestra/worktrees/{branch}"),
            "branch": branch,
            "baseBranch": "master",
            "status": status,
            "createdAt": 1_752_800_000_000_i64,
            "agent": "claude",
        });
        if let (Value::Object(o), Value::Object(e)) = (&mut obj, extra) {
            o.extend(e);
        }
        mock_workspace_json(obj)
    };
    vec![
        // Running · open PR #412 · run script · dirty worktree.
        ws(
            "ws-1",
            "orchestra · fix-status-dot",
            "fix-status-dot",
            "running",
            json!({}),
        ),
        // Waiting · 3 unpushed commits (PR button primed).
        ws(
            "ws-2",
            "orchestra · gtk4-port",
            "gtk4-port",
            "waiting",
            json!({ "unpushedAhead": 3 }),
        ),
        // Setup running.
        ws(
            "ws-3",
            "mobile-club · checkout-retry",
            "checkout-retry",
            "idle",
            json!({ "setupStatus": "running" }),
        ),
        // Setup failed + error text.
        ws(
            "ws-4",
            "orchestra · flaky-e2e-hunt",
            "flaky-e2e-hunt",
            "error",
            json!({
                "setupStatus": "failed",
                "setupError": "pnpm install exited 1 — network unreachable",
            }),
        ),
        // Scratch session (Terminal-only).
        ws(
            "ws-5",
            "scratch · api-spelunking",
            "api-spelunking",
            "stopped",
            json!({ "kind": "scratch" }),
        ),
        // Sandbox host, this machine NOT the driver.
        ws(
            "ws-6",
            "orchestra · remote-refactor",
            "remote-refactor",
            "running",
            json!({ "host": { "kind": "sandbox", "endpoint": "ws://sandbox-1:8787" } }),
        ),
        // Usage-limited with two queued prompts, pinned account "mc".
        ws(
            "ws-7",
            "orchestra · big-migration",
            "big-migration",
            "waiting",
            json!({
                "accountId": "acc-mc",
                "queuedPrompts": [
                    { "id": "q1", "text": "Run the full migration and report row counts.", "queuedAt": 1_752_800_100_000_i64 },
                    { "id": "q2", "text": "Then open a PR summarising the schema changes.", "queuedAt": 1_752_800_200_000_i64 },
                ],
            }),
        ),
    ]
}

/// The multi-file dirty-worktree diff ws-1 serves: a modified TS file with
/// intra-line word changes, an added markdown file, and a deleted JS file.
fn mock_diff_files() -> Value {
    json!([
        {
            "path": "src/renderer/status.ts",
            "status": "modified",
            "additions": 3,
            "deletions": 2,
            "oldContent": "export function statusDot(state: State): string {\n  const cls = state.busy ? 'busy' : 'idle';\n  return `<span class=\"${cls}\"></span>`;\n}\n",
            "newContent": "export function statusDot(state: State): string {\n  const cls = state.running ? 'running' : 'idle';\n  const title = state.label ?? cls;\n  return `<span class=\"${cls}\" title=\"${title}\"></span>`;\n}\n",
        },
        {
            "path": "docs/status.md",
            "status": "added",
            "additions": 4,
            "deletions": 0,
            "oldContent": "",
            "newContent": "# Status dots\n\nEach workspace row shows a colored dot:\n\n- green — the agent is running\n",
        },
        {
            "path": "src/legacy/old-status.js",
            "status": "deleted",
            "additions": 0,
            "deletions": 3,
            "oldContent": "function oldDot(s) {\n  return s.busy ? 'busy' : 'idle';\n}\n",
            "newContent": "",
        },
    ])
}

impl Backend for MockBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Mock
    }

    fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").into()
    }

    fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        Ok(self.state.borrow().workspaces.clone())
    }

    fn list_repos(&self) -> Result<Vec<RepoEntry>> {
        Ok(vec![serde_json::from_value(json!({
            "path": "/home/user/repos/orchestra",
            "name": "orchestra",
            "defaultBranch": "master",
            "scripts": { "run": "pnpm run dev" },
        }))
        .expect("mock repo fixture matches the wire type")])
    }

    fn call(&self, method: &str, params: Vec<Value>) -> Result<Value> {
        // First positional arg as &str (most methods take a ws or repo id).
        let arg0 = || params.first().and_then(|v| v.as_str()).map(str::to_owned);
        match method {
            "app:info" => Ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "backendKind": "mock",
            })),

            // -- diff / stats / PR --------------------------------------------
            "getDiff" => match arg0().as_deref() {
                Some("ws-1") => Ok(mock_diff_files()),
                _ => Ok(json!([])),
            },
            "getDiffStats" => match arg0().as_deref() {
                Some("ws-1") => Ok(json!({ "additions": 7, "deletions": 5, "files": 3 })),
                _ => Ok(json!({ "additions": 0, "deletions": 0, "files": 0 })),
            },
            "findPR" => match arg0().as_deref() {
                Some("ws-1") => Ok(json!({
                    "all": [{ "url": "https://github.com/o/o/pull/412", "number": 412, "state": "OPEN", "title": "Fix status dot latency" }],
                    "open": { "url": "https://github.com/o/o/pull/412", "number": 412, "state": "OPEN", "title": "Fix status dot latency" },
                    "latest": { "url": "https://github.com/o/o/pull/412", "number": 412, "state": "OPEN", "title": "Fix status dot latency" },
                    "mergedCount": 0,
                })),
                _ => Ok(json!({ "all": [], "mergedCount": 0 })),
            },

            // -- branches -----------------------------------------------------
            "listBranches" | "listRepoBranches" => Ok(json!(self.state.borrow().branches)),
            "switchBranch" => {
                let (Some(id), Some(branch)) = (arg0(), params.get(1).and_then(|v| v.as_str()))
                else {
                    return Err(BackendError::NotWired("switchBranch needs (id, branch)"));
                };
                let mut st = self.state.borrow_mut();
                if let Some(ws) = st.workspaces.iter_mut().find(|w| w.id == id) {
                    ws.branch = branch.to_owned();
                    ws.branch_manually_set = Some(true);
                    return Ok(serde_json::to_value(ws.clone()).unwrap());
                }
                Err(BackendError::NotWired("switchBranch: unknown workspace"))
            }

            // -- repo scripts -------------------------------------------------
            "getRepoScripts" => Ok(json!({ "run": "pnpm run dev", "setup": "pnpm install" })),

            // -- agent / run --------------------------------------------------
            "restartAgent" => Ok(json!(null)),
            "runScriptStatus" => {
                Ok(json!(*self
                    .state
                    .borrow()
                    .run_live
                    .get(&arg0().unwrap_or_default())
                    .unwrap_or(&false)))
            }
            "runScriptStart" => {
                if let Some(id) = arg0() {
                    self.state.borrow_mut().run_live.insert(id, true);
                }
                Ok(json!(true))
            }
            "runScriptStop" => {
                if let Some(id) = arg0() {
                    self.state.borrow_mut().run_live.insert(id, false);
                }
                Ok(json!(true))
            }
            "markSeen" => Ok(json!(null)),

            // -- setup banner -------------------------------------------------
            "readSetupLog" => match arg0().as_deref() {
                Some("ws-3") => Ok(json!(
                    "$ pnpm install\nProgress: resolved 812, reused 800, downloaded 12\nLinking dependencies...\n"
                )),
                Some("ws-4") => Ok(json!(
                    "$ pnpm install\nnpm ERR! network request to registry failed\npnpm install exited 1 — network unreachable\n"
                )),
                _ => Ok(json!("")),
            },
            "retrySetup" => {
                // Flip the workspace to running so the banner reflects a retry.
                if let Some(id) = arg0() {
                    let mut st = self.state.borrow_mut();
                    if let Some(ws) = st.workspaces.iter_mut().find(|w| w.id == id) {
                        ws.setup_status =
                            Some(orchestra_rpc::types::SetupStatus::Running);
                        ws.setup_error = None;
                    }
                }
                Ok(json!(null))
            }

            // -- prompt queue -------------------------------------------------
            "queuePrompt" => {
                let (Some(id), Some(text)) = (arg0(), params.get(1).and_then(|v| v.as_str()))
                else {
                    return Err(BackendError::NotWired("queuePrompt needs (id, text)"));
                };
                let mut st = self.state.borrow_mut();
                if let Some(ws) = st.workspaces.iter_mut().find(|w| w.id == id) {
                    let mut q = ws.queued_prompts.take().unwrap_or_default();
                    q.push(orchestra_rpc::types::QueuedPrompt {
                        id: format!("q{}", q.len() + 1),
                        text: text.to_owned(),
                        queued_at: 1_752_800_300_000,
                    });
                    ws.queued_prompts = Some(q);
                    return Ok(serde_json::to_value(ws.clone()).unwrap());
                }
                Err(BackendError::NotWired("queuePrompt: unknown workspace"))
            }
            "removeQueuedPrompt" => {
                let (Some(id), Some(pid)) = (arg0(), params.get(1).and_then(|v| v.as_str()))
                else {
                    return Err(BackendError::NotWired("removeQueuedPrompt needs (id, promptId)"));
                };
                let mut st = self.state.borrow_mut();
                if let Some(ws) = st.workspaces.iter_mut().find(|w| w.id == id) {
                    if let Some(q) = ws.queued_prompts.as_mut() {
                        q.retain(|p| p.id != pid);
                    }
                }
                Ok(json!(null))
            }
            "flushQueuedPrompts" => {
                if let Some(id) = arg0() {
                    let mut st = self.state.borrow_mut();
                    if let Some(ws) = st.workspaces.iter_mut().find(|w| w.id == id) {
                        let n = ws.queued_prompts.take().map(|q| q.len()).unwrap_or(0);
                        return Ok(json!({ "ok": true, "delivered": n }));
                    }
                }
                Ok(json!({ "ok": true, "delivered": 0 }))
            }

            // -- accounts / usage --------------------------------------------
            "getWorkspaceAccounts" => Ok(json!(self
                .state
                .borrow()
                .workspaces
                .iter()
                .map(|w| {
                    match w.account_id.as_deref() {
                        Some("acc-mc") => json!({ "workspaceId": w.id, "accountId": "acc-mc", "label": "mc" }),
                        _ => json!({ "workspaceId": w.id, "accountId": Value::Null, "label": "default" }),
                    }
                })
                .collect::<Vec<_>>())),
            "getAccountUsage" => match arg0().as_deref() {
                // "mc" is over its 5-hour limit, resets far in the future.
                Some("acc-mc") => Ok(json!({
                    "accountId": "acc-mc",
                    "ok": true,
                    "data": {
                        "fiveHour": { "utilization": 100.0, "resetsAt": "2027-01-01T00:00:00Z" },
                        "sevenDay": { "utilization": 40.0, "resetsAt": "2027-01-01T00:00:00Z" },
                        "extraUtilization": Value::Null,
                        "fable": Value::Null,
                    },
                    "fetchedAt": 1_900_000_000_000_i64,
                })),
                _ => Ok(json!({ "accountId": arg0(), "ok": false, "fetchedAt": 0 })),
            },
            "getUsage" => Ok(json!({
                "fiveHour": { "utilization": 12.0, "resetsAt": "2027-01-01T00:00:00Z" },
                "sevenDay": { "utilization": 30.0, "resetsAt": "2027-01-01T00:00:00Z" },
                "fetchedAt": 1_900_000_000_000_i64,
            })),

            // -- sandbox ------------------------------------------------------
            "sandboxControlState" => match arg0().as_deref() {
                Some("ws-6") => Ok(json!({
                    "endpoint": "ws://sandbox-1:8787",
                    "driverId": "lucas-desktop",
                    "driverName": "lucas-desktop",
                    "isDriver": false,
                })),
                _ => Ok(json!(null)),
            },
            "takeSandboxControl" => {
                if let Some(id) = arg0() {
                    self.state.borrow_mut().sandbox.insert(id, json!({ "isDriver": true }));
                }
                Ok(json!(null))
            }

            // -- merge --------------------------------------------------------
            "mergeWorktree" => Ok(json!({ "status": "requested" })),

            _ => Err(BackendError::NotWired("mock backend does not serve this method")),
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
    use orchestra_rpc::types::WorkspaceStatus;

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
    fn mock_serves_seven_workspaces() {
        let ws = MockBackend::default().list_workspaces().unwrap();
        assert_eq!(ws.len(), 7);
        assert!(ws.iter().any(|w| w.status == WorkspaceStatus::Running));
        // The B3 fixture surface: a scratch, a sandbox host, and a queued one.
        assert!(ws.iter().any(|w| w.is_scratch_like()));
        assert!(ws.iter().any(|w| w.host.is_some()));
        assert!(ws.iter().any(|w| w.queued_prompts.is_some()));
    }

    #[test]
    fn mock_switch_branch_mutates_and_returns_the_workspace() {
        let b = MockBackend::default();
        let updated = b
            .call("switchBranch", vec![json!("ws-1"), json!("develop")])
            .unwrap();
        assert_eq!(updated["branch"], "develop");
        // The mutation sticks for the next read.
        let ws = b.list_workspaces().unwrap();
        assert_eq!(ws.iter().find(|w| w.id == "ws-1").unwrap().branch, "develop");
    }

    #[test]
    fn mock_diff_has_the_three_classifications() {
        let b = MockBackend::default();
        let diff = b.call("getDiff", vec![json!("ws-1")]).unwrap();
        let files = diff.as_array().unwrap();
        assert_eq!(files.len(), 3);
        let statuses: Vec<&str> = files.iter().map(|f| f["status"].as_str().unwrap()).collect();
        assert!(statuses.contains(&"modified"));
        assert!(statuses.contains(&"added"));
        assert!(statuses.contains(&"deleted"));
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
