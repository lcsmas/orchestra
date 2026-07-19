//! Fixture backend (plan §5.1 "develop against MockBackend") — serves a
//! workspace set rich enough to exercise every sidebar state: orchestrator
//! and scratch spawn trees (incl. a cross-repo child), host grouping (a repo
//! with sandbox-hosted rows), every status dot, unread tags, the full pill
//! zoo (merged / released / unpushed / diff / setup / PR / Linear / size),
//! archived rows for multi-select, env notices, and repo sync states.
//!
//! It is MUTABLE: the sidebar's actions (rename, archive, delete, reorder,
//! import/eject, create…) update the fixture store and emit the same event
//! frames a real backend would, so the whole UI loop is demoable and
//! E2E-drivable without a daemon.
//!
//! Everything is deserialized rather than struct-literal so new fields on the
//! wire types (all `Option` per the serde rules) can never break the fixture
//! backend.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use orchestra_rpc::types::{RepoEntry, Workspace, WorkspaceHost};
use orchestra_rpc::ConnectionState;
use serde_json::{json, Value};

use super::{Backend, BackendError, BackendEvent, BackendKind, Result};
use crate::backend_fixtures;

const ORCHESTRA_REPO: &str = "/home/user/repos/orchestra";
const MOBILE_CLUB_REPO: &str = "/home/user/repos/mobile-club";
const SANDBOX_A: &str = "ws://sandbox-a:8787";

fn ws_fixture(v: Value) -> Workspace {
    serde_json::from_value(v).expect("mock workspace fixture matches the wire type")
}

fn repo_fixture(v: Value) -> RepoEntry {
    serde_json::from_value(v).expect("mock repo fixture matches the wire type")
}

/// Epoch ms — fixture timestamps are anchored in the past; live ones (rename,
/// sync) use now.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The active + archived fixture set. Order matters: it is the persisted
/// "store order" that drag-reorder mutates.
pub fn mock_workspaces() -> Vec<Workspace> {
    let base = 1_752_800_000_000_i64;
    let w = |extra: Value| -> Workspace {
        let mut v = json!({
            "baseBranch": "master",
            "createdAt": base,
            "agent": "claude",
            "status": "idle",
        });
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        ws_fixture(v)
    };
    vec![
        // ── Orchestrator tree: root + git child (with its own grandchild in
        //    ANOTHER repo — the cross-repo tag case) + nested scratch child.
        w(json!({
            "id": "orch-1", "kind": "orchestrator", "status": "running",
            "name": "orchestrator · gtk4-port",
            "branch": "gtk4-port-coordinator",
            "repoPath": "", "worktreePath": "/home/user/.orchestra/scratch/orch-1",
            "contextTokens": 412_000,
        })),
        w(json!({
            "id": "ws-child-a", "parentId": "orch-1", "status": "running",
            "name": "orchestra · m2-sidebar",
            "branch": "m2-sidebar", "repoPath": ORCHESTRA_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/m2-sidebar",
            "contextTokens": 84_500,
        })),
        w(json!({
            "id": "ws-grandchild", "parentId": "ws-child-a", "status": "idle",
            "name": "mobile-club · api-fixtures",
            "branch": "api-fixtures", "repoPath": MOBILE_CLUB_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/api-fixtures",
        })),
        w(json!({
            "id": "orch-scratch-kid", "parentId": "orch-1", "kind": "scratch",
            "status": "waiting", "markedUnread": true,
            "name": "scratch · verifier",
            "branch": "verifier",
            "repoPath": "", "worktreePath": "/home/user/.orchestra/scratch/orch-scratch-kid",
        })),
        // ── Scratch tree: root + one spawned git child.
        w(json!({
            "id": "scratch-1", "kind": "scratch", "status": "idle",
            "name": "scratch · api-spelunking",
            "branch": "api-spelunking",
            "repoPath": "", "worktreePath": "/home/user/.orchestra/scratch/scratch-1",
        })),
        w(json!({
            "id": "ws-from-scratch", "parentId": "scratch-1", "status": "running",
            "name": "orchestra · spike-vte-feed",
            "branch": "spike-vte-feed", "repoPath": ORCHESTRA_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/spike-vte-feed",
        })),
        // ── orchestra repo roots: one per pill state.
        // ws-1/ws-2 carry a PINNED accountId — the row badge only exercises
        // its label/tint path when an account is actually assigned (an
        // unpinned row just shows "default"), so the fixture set must include
        // assigned rows or the badge is untested.
        w(json!({
            "id": "ws-1", "status": "running",
            "name": "orchestra · fix-status-dot",
            "branch": "fix-status-dot", "repoPath": ORCHESTRA_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/fix-status-dot",
            "unpushedAhead": 3, "contextTokens": 127_000,
            "accountId": "acc-work",
        })),
        w(json!({
            "id": "ws-2", "status": "waiting",
            "name": "orchestra · usage-poll-retry",
            "branch": "usage-poll-retry", "repoPath": ORCHESTRA_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/usage-poll-retry",
            "mergedAt": base,
            // B3 prompt-queue banner: two parked prompts (the banner also
            // shows the account-limit state; ws-2 is pinned to acc-perso
            // below, whose usage reading is near-limit).
            "queuedPrompts": [
                { "id": "q1", "text": "Run the full migration and report row counts.", "queuedAt": 1_752_800_100_000_i64 },
                { "id": "q2", "text": "Then open a PR summarising the schema changes.", "queuedAt": 1_752_800_200_000_i64 },
            ],
            // B4 badge regression test: near-limit + expired login, which
            // proves the badge keeps its cached tint AND resolves a LABEL
            // (an unassigned workspace renders "default" and masks the bug).
            "accountId": "acc-perso",
        })),
        w(json!({
            "id": "ws-3", "status": "idle",
            "name": "orchestra · chime-volume",
            "branch": "chime-volume", "repoPath": ORCHESTRA_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/chime-volume",
            "mergedAt": base, "releasedAt": base,
            "releasedVersions": ["0.5.88", "0.5.89"],
            "branchManuallySet": true,
        })),
        w(json!({
            "id": "ws-4", "status": "error",
            "name": "orchestra · flaky-e2e-hunt",
            "branch": "flaky-e2e-hunt", "repoPath": ORCHESTRA_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/flaky-e2e-hunt",
            "setupStatus": "failed", "setupError": "pnpm install exited 1",
        })),
        w(json!({
            "id": "ws-5", "status": "stopped", "markedUnread": true,
            "name": "orchestra · nmc-261-terminal-glyphs",
            "branch": "nmc-261-terminal-glyphs", "repoPath": ORCHESTRA_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/nmc-261-terminal-glyphs",
            "setupStatus": "running",
        })),
        // ── mobile-club repo: local + two sandbox-hosted rows (host groups).
        w(json!({
            "id": "ws-mc-1", "status": "idle",
            "name": "mobile-club · checkout-retry",
            "branch": "checkout-retry", "repoPath": MOBILE_CLUB_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/checkout-retry",
        })),
        w(json!({
            "id": "ws-mc-sb1", "status": "running",
            "name": "mobile-club · order-webhooks",
            "branch": "order-webhooks", "repoPath": MOBILE_CLUB_REPO,
            "worktreePath": "/workspaces/order-webhooks",
            "host": { "kind": "sandbox", "endpoint": SANDBOX_A },
        })),
        w(json!({
            "id": "ws-mc-sb2", "status": "waiting",
            "name": "mobile-club · loyalty-points",
            "branch": "loyalty-points", "repoPath": MOBILE_CLUB_REPO,
            "worktreePath": "/workspaces/loyalty-points",
            "host": { "kind": "sandbox", "endpoint": SANDBOX_A },
        })),
        // ── Archived (multi-select / bulk-delete fodder).
        w(json!({
            "id": "ws-arch-1", "status": "stopped", "archived": true, "archivedAt": base,
            "name": "orchestra · old-logo-pass",
            "branch": "old-logo-pass", "repoPath": ORCHESTRA_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/old-logo-pass",
        })),
        w(json!({
            "id": "ws-arch-2", "status": "stopped", "archived": true, "archivedAt": base,
            "name": "orchestra · abandoned-spike",
            "branch": "abandoned-spike", "repoPath": ORCHESTRA_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/abandoned-spike",
        })),
        w(json!({
            "id": "ws-arch-3", "status": "stopped", "archived": true, "archivedAt": base,
            "name": "mobile-club · perf-experiment",
            "branch": "perf-experiment", "repoPath": MOBILE_CLUB_REPO,
            "worktreePath": "/home/user/.orchestra/worktrees/perf-experiment",
        })),
    ]
}

fn mock_repos() -> Vec<RepoEntry> {
    vec![
        repo_fixture(json!({
            "path": ORCHESTRA_REPO,
            "name": "orchestra",
            "defaultBranch": "master",
            "remoteUrl": "https://github.com/lcsmas/orchestra",
            "scripts": { "setup": "pnpm install", "run": "pnpm run dev" },
        })),
        repo_fixture(json!({
            "path": MOBILE_CLUB_REPO,
            "name": "mobile-club",
            "defaultBranch": "develop",
        })),
    ]
}

fn mock_sync_states() -> HashMap<String, Value> {
    HashMap::from([
        (
            ORCHESTRA_REPO.to_string(),
            json!({
                "repoPath": ORCHESTRA_REPO, "baseBranch": "master",
                "behind": 2, "ahead": 0, "hasUpstream": true,
                "syncedAt": 1_752_800_000_000_i64, "syncing": false,
            }),
        ),
        (
            MOBILE_CLUB_REPO.to_string(),
            json!({
                "repoPath": MOBILE_CLUB_REPO, "baseBranch": "develop",
                "behind": 0, "ahead": 0, "hasUpstream": true,
                "syncedAt": 1_752_800_000_000_i64, "syncing": false,
            }),
        ),
    ])
}

#[derive(Debug)]
struct MockState {
    workspaces: Vec<Workspace>,
    repos: Vec<RepoEntry>,
    sync: HashMap<String, Value>,
    next_id: u32,
    /// Accounts surface (plan §5.4): the live account list (mutated by
    /// setAccounts) and the workspace→account pin map (mutated by migrate).
    accounts: Vec<Value>,
    workspace_accounts: HashMap<String, Option<String>>,
    /// `<ws-id>` → run-script PTY live (B3 run start/stop toggle).
    run_live: HashMap<String, bool>,
}

/// Four configured accounts spanning the interesting usage shapes: "work"
/// (healthy, Fable + extra-usage), "perso" (near-limit, expired token showing
/// cached usage), a no-scope error, and a not-logged-in account.
fn mock_accounts() -> Vec<Value> {
    vec![
        json!({ "id": "acc-work", "label": "work", "configDir": "~/.claude-work",
                "scratchDefault": true,
                "inherit": { "settings": true, "statusline": true } }),
        json!({ "id": "acc-perso", "label": "perso", "configDir": "~/.claude-perso" }),
        json!({ "id": "acc-mc", "label": "mobile-club", "configDir": "${HOME}/.claude-mc" }),
        json!({ "id": "acc-broken", "label": "broken", "configDir": "~/.claude-broken" }),
    ]
}

fn mock_workspace_accounts() -> HashMap<String, Option<String>> {
    // ws-1 pinned to work; ws-2 pinned to perso (near-limit — drives the B3
    // prompt-queue banner's usage reading); the rest default. (ids match
    // mock_workspaces.)
    HashMap::from([
        ("ws-1".to_string(), Some("acc-work".to_string())),
        ("ws-2".to_string(), Some("acc-perso".to_string())),
    ])
}

/// The global (`~/.claude`) usage snapshot: mid-range, with a Fable window so
/// the strip's conditional Fable bar renders.
fn mock_global_usage() -> Value {
    json!({
        "fiveHour": { "utilization": 41.0, "resetsAt": "2026-07-19T18:30:00Z" },
        "sevenDay": { "utilization": 63.0, "resetsAt": "2026-07-24T00:00:00Z" },
        "extraUtilization": 12.0,
        "fable": { "utilization": 22.0, "resetsAt": "2026-07-24T00:00:00Z" },
        "fetchedAt": 1_752_930_000_000_i64,
    })
}

/// Per-account usage: healthy+Fable+extra (work), near-crit + expired-showing-
/// cached (perso), a hard error (mobile-club: no scope), and not-logged-in.
fn mock_account_usage() -> Value {
    json!({
        "acc-work": {
            "accountId": "acc-work", "ok": true, "fetchedAt": 1_752_930_000_000_i64,
            "data": {
                "fiveHour": { "utilization": 48.0, "resetsAt": "2026-07-19T18:30:00Z" },
                "sevenDay": { "utilization": 71.0, "resetsAt": "2026-07-24T00:00:00Z" },
                "extraUtilization": 15.0,
                "fable": { "utilization": 30.0, "resetsAt": "2026-07-24T00:00:00Z" }
            }
        },
        "acc-perso": {
            "accountId": "acc-perso", "ok": true, "fetchedAt": 1_752_929_400_000_i64,
            "expired": true,
            "data": {
                "fiveHour": { "utilization": 93.0, "resetsAt": "2026-07-19T17:05:00Z" },
                "sevenDay": { "utilization": 88.0, "resetsAt": "2026-07-24T00:00:00Z" },
                "extraUtilization": null,
                "fable": null
            }
        },
        "acc-mc": {
            "accountId": "acc-mc", "ok": false, "fetchedAt": 1_752_930_000_000_i64,
            "data": null, "errorKind": "no-scope",
            "errorMessage": "token lacks user:profile"
        },
        "acc-broken": {
            "accountId": "acc-broken", "ok": false, "fetchedAt": 1_752_930_000_000_i64,
            "data": null, "errorKind": "not-logged-in", "errorMessage": "no login found"
        }
    })
}

/// The multi-file dirty-worktree diff ws-1 serves (B3 diff view): a modified
/// TS file with intra-line word changes, an added markdown file, and a deleted
/// JS file — exercises A/M/D classification, side-by-side rendering, line
/// backgrounds, and `similar` intra-line word highlights.
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

/// Fixture backend so the sidebar renders (and mutates) real states before
/// any backend exists. Single-threaded by design — it lives on the GTK main
/// context, like every other `Backend`.
#[derive(Debug)]
pub struct MockBackend {
    state: RefCell<MockState>,
    events_tx: async_channel::Sender<BackendEvent>,
    events_rx: async_channel::Receiver<BackendEvent>,
    /// Also written by the fake login flow (account-login:<id> banner + echo).
    pty_tx: async_channel::Sender<(String, Vec<u8>)>,
    pty_rx: async_channel::Receiver<(String, Vec<u8>)>,
    // The mock is "always connected": it seeds one Connected state so the app's
    // Connection handler fires the same first-attach path as a live backend,
    // then holds the sender so the receiver stays open (never reconnects).
    _state_tx: async_channel::Sender<ConnectionState>,
    state_rx: async_channel::Receiver<ConnectionState>,
    /// B5 Resources: advances on each `sampleResources` poll so sparklines and
    /// per-agent traces animate deterministically.
    res_tick: Cell<u64>,
    /// B5 Insights: one in-flight fake self-tune run at a time — `startSelfTune`
    /// rejects while set, mirroring the real backend's single-run guard. Shared
    /// with the replay thread, which clears it when the run finishes.
    self_tune_running: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Default for MockBackend {
    fn default() -> Self {
        let (events_tx, events_rx) = async_channel::unbounded();
        let (pty_tx, pty_rx) = async_channel::unbounded();
        let (state_tx, state_rx) = async_channel::unbounded();
        let _ = state_tx.try_send(ConnectionState::Connected);
        Self {
            state: RefCell::new(MockState {
                workspaces: mock_workspaces(),
                repos: mock_repos(),
                sync: mock_sync_states(),
                next_id: 1,
                accounts: mock_accounts(),
                workspace_accounts: mock_workspace_accounts(),
                run_live: HashMap::new(),
            }),
            events_tx,
            events_rx,
            pty_tx,
            pty_rx,
            _state_tx: state_tx,
            state_rx,
            res_tick: Cell::new(0),
            self_tune_running: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

impl MockBackend {
    /// Emit an event frame exactly as the wire would deliver it.
    fn emit(&self, channel: &str, args: Vec<Value>) {
        let _ = self.events_tx.try_send(BackendEvent::Event {
            channel: channel.into(),
            args,
        });
    }

    fn emit_workspace_update(&self, ws: &Workspace) {
        self.emit(
            "workspaceUpdate",
            vec![serde_json::to_value(ws).expect("workspace serializes")],
        );
    }

    fn emit_repos_update(&self) {
        let repos = self.state.borrow().repos.clone();
        self.emit(
            "reposUpdate",
            vec![serde_json::to_value(repos).expect("repos serialize")],
        );
    }

    /// Mutate one workspace by id, then emit its update. Errors when absent.
    fn update_ws(&self, id: &str, f: impl FnOnce(&mut Workspace)) -> Result<Workspace> {
        let updated = {
            let mut st = self.state.borrow_mut();
            let ws = st
                .workspaces
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or_else(|| BackendError::Method(format!("no workspace {id}")))?;
            f(ws);
            ws.clone()
        };
        self.emit_workspace_update(&updated);
        Ok(updated)
    }

    fn arg<T: serde::de::DeserializeOwned>(params: &[Value], i: usize) -> Result<T> {
        serde_json::from_value(params.get(i).cloned().unwrap_or(Value::Null))
            .map_err(|e| BackendError::Method(format!("bad param {i}: {e}")))
    }

    /// The workspace→account map as the wire `WorkspaceAccount` object keyed by
    /// workspace id (what `getWorkspaceAccounts` returns and `workspaceAccounts`
    /// broadcasts). Labels resolve from the live account list.
    fn workspace_accounts_value(&self) -> Value {
        let st = self.state.borrow();
        let label_of = |id: &str| -> String {
            st.accounts
                .iter()
                .find(|a| a["id"] == id)
                .and_then(|a| a["label"].as_str())
                .unwrap_or(id)
                .to_string()
        };
        let map: serde_json::Map<String, Value> = st
            .workspace_accounts
            .iter()
            .map(|(ws, acct)| {
                let label = acct
                    .as_deref()
                    .map(label_of)
                    .unwrap_or_else(|| "default".into());
                (
                    ws.clone(),
                    json!({ "workspaceId": ws, "accountId": acct, "label": label }),
                )
            })
            .collect();
        Value::Object(map)
    }

    fn create(&self, extra: Value) -> Result<Value> {
        let ws = {
            let mut st = self.state.borrow_mut();
            let n = st.next_id;
            st.next_id += 1;
            let mut v = json!({
                "id": format!("ws-new-{n}"),
                "baseBranch": "master",
                "createdAt": now_ms(),
                "agent": "claude",
                "status": "idle",
            });
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let ws = ws_fixture(v);
            st.workspaces.push(ws.clone());
            ws
        };
        self.emit_workspace_update(&ws);
        Ok(serde_json::to_value(&ws).expect("workspace serializes"))
    }

    /// `startSelfTune` (B5): return the initial `running` run and spawn a thread
    /// that replays timed `selfTuneUpdate`/`selfTuneOutput` frames so the
    /// Insights overlay shows a live run.
    ///
    /// Wire contract (ipc.ts:282): resolves with the BARE `SelfTuneRun` and
    /// REJECTS when a run is already in flight — self-tune.ts:284 throws
    /// "A self-tune run is already in progress", which crosses ui-rpc as a
    /// frame-level error and reaches the client as `Err`. So the guard returns
    /// `Err(BackendError::Method)` here (NOT an `{ok:false}` envelope, which
    /// the real handler never emits), keeping the rejection path testable.
    fn start_fake_self_tune(&self) -> Result<Value> {
        use std::sync::atomic::Ordering;
        // Atomic test-and-set: claim the slot or reject, never both.
        if self
            .self_tune_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(BackendError::Method(
                "A self-tune run is already in progress".into(),
            ));
        }
        let (initial, updates) = backend_fixtures::fake_run_script(backend_fixtures::MOCK_NOW_MS);

        let events_tx = self.events_tx.clone();
        // A background OS thread sleeps between frames; async_channel's
        // send_blocking is safe off the glib main loop and the receiver is
        // pumped there. The last frame marks the run finished, so the thread
        // clears the in-flight guard — a second Run-now then starts a fresh run,
        // exactly like the real guard (which only rejects while `running`).
        let running = self.self_tune_running.clone();
        std::thread::spawn(move || {
            let mut prev = 0u64;
            for (at_ms, channel, args) in updates {
                let delay = at_ms.saturating_sub(prev);
                prev = at_ms;
                std::thread::sleep(std::time::Duration::from_millis(delay));
                let _ = events_tx.send_blocking(BackendEvent::Event { channel, args });
            }
            running.store(false, std::sync::atomic::Ordering::Release);
        });
        // BARE SelfTuneRun on the wire (ipc.ts:282) — no envelope.
        Ok(initial)
    }
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
        Ok(self.state.borrow().repos.clone())
    }

    fn call(&self, method: &str, params: Vec<Value>) -> Result<Value> {
        match method {
            "app:info" => Ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "backendKind": "mock",
            })),
            "getAppVersion" => Ok(json!(env!("CARGO_PKG_VERSION"))),
            "listWorkspaces" => Ok(serde_json::to_value(self.list_workspaces()?).unwrap()),
            "listRepos" => Ok(serde_json::to_value(self.list_repos()?).unwrap()),
            "listRepoSyncStates" => {
                let st = self.state.borrow();
                Ok(Value::Array(st.sync.values().cloned().collect()))
            }
            "getEnvStatus" => Ok(json!([
                {
                    "id": "linear",
                    "label": "Linear",
                    "ok": false,
                    "detail": "Branch names carrying issue keys can link to Linear.",
                },
                {
                    "id": "gh",
                    "label": "GitHub CLI",
                    "ok": false,
                    "detail": "PR badges need an authenticated gh.",
                    "docsUrl": "https://cli.github.com",
                },
            ])),
            "getWorktreeSizes" => Ok(json!({
                "exclusive": true,
                "sizes": {
                    "ws-1": 61_000_000_u64,
                    "ws-4": 128_000_000_u64,
                    "ws-child-a": 3_400_000_u64,
                    "ws-arch-1": 512_000_000_u64,
                    "ws-arch-2": 9_800_000_u64,
                    "ws-arch-3": 74_000_000_u64,
                },
            })),
            "getDiffStats" => {
                let id: String = Self::arg(&params, 0)?;
                Ok(match id.as_str() {
                    "ws-1" => json!({"additions": 120, "deletions": 30, "files": 5}),
                    "ws-child-a" => json!({"additions": 10, "deletions": 2, "files": 3}),
                    _ => json!({"additions": 0, "deletions": 0, "files": 0}),
                })
            }
            "findPR" => {
                let id: String = Self::arg(&params, 0)?;
                let prs = |list: Vec<Value>| json!({"all": list, "mergedCount": 0});
                Ok(match id.as_str() {
                    "ws-1" => prs(vec![json!({
                        "url": "https://github.com/lcsmas/orchestra/pull/815",
                        "number": 815, "state": "OPEN", "title": "Fix status dot latency"
                    })]),
                    "ws-2" => prs(vec![json!({
                        "url": "https://github.com/lcsmas/orchestra/pull/812",
                        "number": 812, "state": "MERGED", "title": "Usage poll retry"
                    })]),
                    // Four PRs → exercises open-first ordering AND the +N pill.
                    "ws-5" => prs(vec![
                        json!({"url": "https://github.com/lcsmas/orchestra/pull/799",
                               "number": 799, "state": "MERGED", "title": "Glyphs 1"}),
                        json!({"url": "https://github.com/lcsmas/orchestra/pull/798",
                               "number": 798, "state": "CLOSED", "title": "Glyphs 2"}),
                        json!({"url": "https://github.com/lcsmas/orchestra/pull/801",
                               "number": 801, "state": "OPEN", "title": "Glyphs 3"}),
                        json!({"url": "https://github.com/lcsmas/orchestra/pull/797",
                               "number": 797, "state": "MERGED", "title": "Glyphs 4"}),
                    ]),
                    _ => prs(vec![]),
                })
            }
            "verifyLinear" => {
                let id: String = Self::arg(&params, 0)?;
                Ok(match id.as_str() {
                    "ws-5" => json!({
                        "identifier": "NMC-261",
                        "url": "https://linear.app/team/issue/NMC-261",
                        "title": "Terminal circled-number glyphs squished",
                    }),
                    _ => Value::Null,
                })
            }
            "listRepoBranches" => Ok(json!(["master", "develop", "release/0.5", "spike/vte"])),
            "renameBranch" => {
                let id: String = Self::arg(&params, 0)?;
                let branch: String = Self::arg(&params, 1)?;
                let ws = self.update_ws(&id, |w| {
                    w.branch = branch.clone();
                    w.branch_manually_set = Some(true);
                })?;
                Ok(serde_json::to_value(&ws).unwrap())
            }
            "setUnread" => {
                let id: String = Self::arg(&params, 0)?;
                let unread: bool = Self::arg(&params, 1)?;
                self.update_ws(&id, |w| w.marked_unread = unread.then_some(true))?;
                Ok(Value::Null)
            }
            "markSeen" => {
                let id: String = Self::arg(&params, 0)?;
                self.update_ws(&id, |w| w.marked_unread = None)?;
                Ok(Value::Null)
            }
            "archiveWorkspace" => {
                let id: String = Self::arg(&params, 0)?;
                self.update_ws(&id, |w| {
                    w.archived = Some(true);
                    w.archived_at = Some(now_ms());
                })?;
                Ok(Value::Null)
            }
            "unarchiveWorkspace" => {
                let id: String = Self::arg(&params, 0)?;
                self.update_ws(&id, |w| {
                    w.archived = None;
                    w.archived_at = None;
                })?;
                Ok(Value::Null)
            }
            "deleteWorkspace" => {
                let id: String = Self::arg(&params, 0)?;
                self.state.borrow_mut().workspaces.retain(|w| w.id != id);
                self.emit("workspaceRemoved", vec![json!(id)]);
                Ok(Value::Null)
            }
            "deleteWorkspaces" => {
                let ids: Vec<String> = Self::arg(&params, 0)?;
                let total = ids.len();
                for (i, _) in ids.iter().enumerate() {
                    self.emit("workspacesDeleteProgress", vec![json!(i + 1), json!(total)]);
                }
                self.state
                    .borrow_mut()
                    .workspaces
                    .retain(|w| !ids.contains(&w.id));
                self.emit("workspacesRemoved", vec![json!(ids)]);
                Ok(Value::Null)
            }
            "importToSandbox" => {
                let id: String = Self::arg(&params, 0)?;
                let endpoint: String = Self::arg(&params, 1)?;
                let ws = self.update_ws(&id, |w| {
                    w.host = Some(WorkspaceHost::Sandbox { endpoint });
                })?;
                Ok(serde_json::to_value(&ws).unwrap())
            }
            "ejectFromSandbox" => {
                let id: String = Self::arg(&params, 0)?;
                let ws = self.update_ws(&id, |w| w.host = None)?;
                Ok(serde_json::to_value(&ws).unwrap())
            }
            "migrateWorkspaceAccount" => {
                let id: String = Self::arg(&params, 0)?;
                let account: Option<String> = Self::arg(&params, 1)?;
                // The "broken" account is a deterministic FAILURE fixture.
                // Parity with the real handler (`api-handlers.ts:357`), which
                // THROWS on `!res.ok` — so failure reaches a GTK client as a
                // method error, never as an ok:false payload.
                if account.as_deref() == Some("acc-broken") {
                    return Err(BackendError::Method(
                        "no login found in that account's config dir".into(),
                    ));
                }
                // Update the workspace's pinned account (B1's sidebar badge
                // reads w.account_id + repaints on workspaceUpdate) …
                self.update_ws(&id, |w| w.account_id = account.clone())?;
                // … AND the workspace→account map + broadcast (the accounts
                // controller's usage strip / migrate menu repaint on it).
                self.state
                    .borrow_mut()
                    .workspace_accounts
                    .insert(id.clone(), account.clone());
                self.emit("workspaceAccounts", vec![self.workspace_accounts_value()]);
                // MigrateAccountResult. `resumed` reports whether a RUNNING
                // agent was restarted after the move; the fixture resumes the
                // running rows so the "couldn't resume" notice stays a genuine
                // exception rather than firing on every migrate.
                let resumed = self
                    .state
                    .borrow()
                    .workspaces
                    .iter()
                    .find(|w| w.id == id)
                    .map(|w| w.status == orchestra_rpc::types::WorkspaceStatus::Running)
                    .unwrap_or(false);
                Ok(json!({ "ok": true, "id": id, "accountId": account, "resumed": resumed }))
            }

            // ---- accounts / usage (plan §5.4) --------------------------------
            "listAccounts" => Ok(Value::Array(self.state.borrow().accounts.clone())),
            "getUsage" => Ok(mock_global_usage()),
            "getAllAccountUsage" => Ok(mock_account_usage()),
            "getAccountUsage" => {
                let id: String = Self::arg(&params, 0)?;
                Ok(mock_account_usage()
                    .get(&id)
                    .cloned()
                    .unwrap_or(Value::Null))
            }
            "getWorkspaceAccounts" => Ok(self.workspace_accounts_value()),

            // ---- Resources page (B5, docs/codebase-map/resources.md) ---------
            // Animated off a tick so sparklines/traces show life in mock mode.
            "sampleResources" => {
                let tick = self.res_tick.get();
                self.res_tick.set(tick.wrapping_add(1));
                Ok(backend_fixtures::resource_snapshot(tick))
            }
            // `stopAgent(id): Promise<void>` (ipc.ts:219) — validate the key,
            // then return the wire's void (null), not an invented envelope.
            "stopAgent" => {
                let _id: String = Self::arg(&params, 0)?;
                Ok(Value::Null)
            }

            // ---- Insights / self-tune (B5, docs/codebase-map/self-tune.md) ---
            "listSelfTuneRuns" => Ok(backend_fixtures::self_tune_runs()),
            // `getSelfTuneOutput(runId): Promise<string>` — a keyed lookup, so
            // the key is validated rather than silently defaulted.
            "getSelfTuneOutput" => {
                let run_id: String = Self::arg(&params, 0)?;
                Ok(backend_fixtures::self_tune_output(&run_id))
            }
            "listSelfTuneReports" => Ok(backend_fixtures::self_tune_reports()),
            // `openSelfTuneReport(loginId): Promise<boolean>` (ipc.ts:290) —
            // a BARE bool on the wire: false when that login has no report yet
            // (self-tune.ts:134 resolves false when `reportPath` is null). The
            // fixture answers from the same report list the UI reads, so the
            // false path is reachable (login "perso" has reportPath: null).
            "openSelfTuneReport" => {
                let login_id: String = Self::arg(&params, 0)?;
                let has_report = backend_fixtures::self_tune_reports()
                    .as_array()
                    .map(|reports| {
                        reports.iter().any(|r| {
                            r.get("loginId").and_then(Value::as_str) == Some(login_id.as_str())
                                && !r.get("reportPath").is_none_or(Value::is_null)
                        })
                    })
                    .unwrap_or(false);
                Ok(Value::Bool(has_report))
            }
            "readSelfTuneLessons" => Ok(backend_fixtures::lessons_md()),
            "startSelfTune" => self.start_fake_self_tune(),

            "listGlobalInheritables" => Ok(json!({
                "skills": ["ship", "verify", "retro", "map-codebase"],
                "mcpServers": ["chrome-devtools", "linear"],
            })),
            "setAccounts" => {
                let list: Value = Self::arg(&params, 0)?;
                if let Value::Array(arr) = &list {
                    self.state.borrow_mut().accounts = arr.clone();
                }
                // Labels may have changed → re-broadcast the workspace map.
                self.emit("workspaceAccounts", vec![self.workspace_accounts_value()]);
                Ok(list)
            }
            "setRepoAccount" => Ok(Value::Bool(true)),
            "refreshAccounts" => {
                self.emit("accountUsageUpdate", vec![mock_account_usage()]);
                Ok(Value::Null)
            }

            // ---- per-account login flow --------------------------------------
            "accountLoginStart" => {
                let id: String = Self::arg(&params, 0)?;
                let pty = format!("account-login:{id}");
                // Fake the `claude /login` banner + a login URL the modal's
                // link handler would open (drives accountLoginOpenUrl below).
                let banner = format!(
                    "\x1b[1mclaude /login\x1b[0m (mock)\r\n\r\n\
                     Open this URL to authenticate account \x1b[36m{id}\x1b[0m:\r\n\
                     \x1b[4mhttps://claude.ai/oauth/authorize?mock={id}\x1b[0m\r\n\r\n\
                     Waiting for sign-in… (mock; use the login window)\r\n"
                );
                let _ = self.pty_tx.try_send((pty, banner.into_bytes()));
                Ok(Value::Null)
            }
            "accountLoginStop" => Ok(Value::Null),
            "accountLoginOpenUrl" => {
                let id: String = Self::arg(&params, 0)?;
                let url: String =
                    Self::arg(&params, 1).unwrap_or_else(|_| "https://claude.ai/".into());
                // The daemon turns an open-url request into an accountsLoginUrl
                // event addressed to GTK clients (protocol §4).
                self.emit(
                    "accountsLoginUrl",
                    vec![json!({ "accountId": id, "url": url })],
                );
                Ok(Value::Null)
            }
            "createWorkspace" => {
                let input: Value = Self::arg(&params, 0)?;
                let repo_path: String = input
                    .get("repoPath")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let base = input
                    .get("baseBranch")
                    .and_then(Value::as_str)
                    .unwrap_or("master")
                    .to_string();
                let n = self.state.borrow().next_id;
                let branch = format!("fuzzy-otter-{n}");
                let mut extra = json!({
                    "name": format!("new · {branch}"),
                    "branch": branch,
                    "repoPath": repo_path,
                    "worktreePath": format!("/home/user/.orchestra/worktrees/fuzzy-otter-{n}"),
                    "baseBranch": base,
                });
                if let Some(parent) = input.get("parentId").and_then(Value::as_str) {
                    extra["parentId"] = json!(parent);
                }
                self.create(extra)
            }
            "createScratchWorkspace" | "createOrchestratorWorkspace" => {
                let kind = if method == "createScratchWorkspace" {
                    "scratch"
                } else {
                    "orchestrator"
                };
                let n = self.state.borrow().next_id;
                self.create(json!({
                    "kind": kind,
                    "name": format!("{kind} · session-{n}"),
                    "branch": format!("{kind}-session-{n}"),
                    "repoPath": "",
                    "worktreePath": format!("/home/user/.orchestra/scratch/new-{n}"),
                }))
            }
            "addRepo" => {
                let path: String = Self::arg(&params, 0)?;
                let name = path
                    .rsplit('/')
                    .find(|s| !s.is_empty())
                    .unwrap_or(&path)
                    .to_string();
                let repo = repo_fixture(json!({
                    "path": path, "name": name, "defaultBranch": "master",
                }));
                self.state.borrow_mut().repos.push(repo.clone());
                self.emit_repos_update();
                Ok(serde_json::to_value(&repo).unwrap())
            }
            "removeRepo" => {
                let path: String = Self::arg(&params, 0)?;
                // Parity with main's guard: a repo holding ANY workspaces
                // (active, archived, or scratch-spawned) can't be removed.
                let in_use = self
                    .state
                    .borrow()
                    .workspaces
                    .iter()
                    .any(|w| w.repo_path == path);
                if in_use {
                    return Err(BackendError::Method(format!(
                        "repo {path} still has workspaces"
                    )));
                }
                self.state.borrow_mut().repos.retain(|r| r.path != path);
                self.emit_repos_update();
                Ok(Value::Null)
            }
            "reorderWorkspaces" => {
                let ids: Vec<String> = Self::arg(&params, 0)?;
                let mut st = self.state.borrow_mut();
                st.workspaces
                    .sort_by_key(|w| ids.iter().position(|id| id == &w.id).unwrap_or(usize::MAX));
                Ok(Value::Null)
            }
            "reorderRepos" => {
                let paths: Vec<String> = Self::arg(&params, 0)?;
                let mut st = self.state.borrow_mut();
                st.repos.sort_by_key(|r| {
                    paths
                        .iter()
                        .position(|p| p == &r.path)
                        .unwrap_or(usize::MAX)
                });
                drop(st);
                self.emit_repos_update();
                Ok(Value::Null)
            }
            "syncRepoBase" => {
                let path: String = Self::arg(&params, 0)?;
                let (mut syncing, done) = {
                    let st = self.state.borrow();
                    let cur = st
                        .sync
                        .get(&path)
                        .cloned()
                        .ok_or_else(|| BackendError::Method(format!("no repo {path}")))?;
                    let mut syncing = cur.clone();
                    syncing["syncing"] = json!(true);
                    let mut done = cur;
                    done["syncing"] = json!(false);
                    done["behind"] = json!(0);
                    done["syncedAt"] = json!(now_ms());
                    (syncing, done)
                };
                self.emit("repoSyncState", vec![syncing.take()]);
                self.state
                    .borrow_mut()
                    .sync
                    .insert(path.clone(), done.clone());
                self.emit("repoSyncState", vec![done]);
                Ok(Value::Null)
            }
            "openExternal" | "revealLogs" | "log" => Ok(Value::Null),

            // ── B3 main-pane methods (diff / toolbar / banners) ─────────────
            // (getUsage / getAccountUsage / getWorkspaceAccounts are B4's.)
            // Full-content diff for the one dirty-worktree fixture: a modified
            // TS file with intra-line word changes, an added markdown, and a
            // deleted JS file (drives the side-by-side view + intra-line
            // highlights + A/M/D classification).
            "getDiff" => {
                let id: String = Self::arg(&params, 0)?;
                Ok(if id == "ws-1" {
                    mock_diff_files()
                } else {
                    json!([])
                })
            }
            "getRepoScripts" => {
                let path: String = Self::arg(&params, 0)?;
                let st = self.state.borrow();
                Ok(st
                    .repos
                    .iter()
                    .find(|r| r.path == path)
                    .and_then(|r| r.scripts.clone())
                    .map(|s| serde_json::to_value(s).unwrap())
                    .unwrap_or_else(|| json!({})))
            }
            // switchBranch mirrors renameBranch's mutation but is the toolbar's
            // branch-picker entry point.
            "switchBranch" => {
                let id: String = Self::arg(&params, 0)?;
                let branch: String = Self::arg(&params, 1)?;
                let ws = self.update_ws(&id, |w| {
                    w.branch = branch.clone();
                    w.branch_manually_set = Some(true);
                })?;
                Ok(serde_json::to_value(&ws).unwrap())
            }
            // listBranches is the toolbar picker's source (listRepoBranches is
            // the sidebar's new-workspace picker — same fixture list).
            "listBranches" => Ok(json!(["master", "develop", "release/0.5", "spike/vte"])),
            "restartAgent" => Ok(Value::Null),

            // Run-script toggle (per-workspace live flag).
            "runScriptStatus" => {
                let id: String = Self::arg(&params, 0)?;
                let running = *self.state.borrow().run_live.get(&id).unwrap_or(&false);
                Ok(json!(running))
            }
            "runScriptStart" => {
                let id: String = Self::arg(&params, 0)?;
                self.state.borrow_mut().run_live.insert(id, true);
                Ok(json!(true))
            }
            "runScriptStop" => {
                let id: String = Self::arg(&params, 0)?;
                self.state.borrow_mut().run_live.insert(id, false);
                Ok(json!(true))
            }

            // Setup banner: log tail + retry (ws-4 failed, ws-5 running).
            "readSetupLog" => {
                let id: String = Self::arg(&params, 0)?;
                Ok(match id.as_str() {
                    "ws-5" => json!(
                        "$ pnpm install\nProgress: resolved 812, reused 800, downloaded 12\nLinking dependencies...\n"
                    ),
                    "ws-4" => json!(
                        "$ pnpm install\nnpm ERR! network request to registry failed\npnpm install exited 1\n"
                    ),
                    _ => json!(""),
                })
            }
            "retrySetup" => {
                let id: String = Self::arg(&params, 0)?;
                self.update_ws(&id, |w| {
                    w.setup_status = Some(orchestra_rpc::types::SetupStatus::Running);
                    w.setup_error = None;
                })?;
                Ok(Value::Null)
            }

            // Prompt queue (ws-2 seeded with two prompts + a pinned account).
            "queuePrompt" => {
                let id: String = Self::arg(&params, 0)?;
                let text: String = Self::arg(&params, 1)?;
                let ws = self.update_ws(&id, |w| {
                    let mut q = w.queued_prompts.take().unwrap_or_default();
                    let n = q.len() + 1;
                    q.push(orchestra_rpc::types::QueuedPrompt {
                        id: format!("q{n}"),
                        text: text.clone(),
                        queued_at: now_ms(),
                    });
                    w.queued_prompts = Some(q);
                })?;
                Ok(serde_json::to_value(&ws).unwrap())
            }
            "removeQueuedPrompt" => {
                let id: String = Self::arg(&params, 0)?;
                let pid: String = Self::arg(&params, 1)?;
                self.update_ws(&id, |w| {
                    if let Some(q) = w.queued_prompts.as_mut() {
                        q.retain(|p| p.id != pid);
                    }
                })?;
                Ok(Value::Null)
            }
            "flushQueuedPrompts" => {
                let id: String = Self::arg(&params, 0)?;
                let mut delivered = 0u64;
                self.update_ws(&id, |w| {
                    delivered = w.queued_prompts.take().map(|q| q.len() as u64).unwrap_or(0);
                })?;
                Ok(json!({ "ok": true, "delivered": delivered }))
            }

            // Sandbox read-only bar (ws-mc-sb1 / ws-mc-sb2 are sandbox-hosted;
            // this machine is not the driver).
            "sandboxControlState" => {
                let id: String = Self::arg(&params, 0)?;
                Ok(if id == "ws-mc-sb1" || id == "ws-mc-sb2" {
                    json!({
                        "endpoint": SANDBOX_A,
                        "driverId": "lucas-desktop",
                        "driverName": "lucas-desktop",
                        "isDriver": false,
                    })
                } else {
                    Value::Null
                })
            }
            "takeSandboxControl" => Ok(Value::Null),

            // Merge is delegated to the agent → { status: "requested" }.
            "mergeWorktree" => Ok(json!({ "status": "requested" })),

            _ => Err(BackendError::NotWired(
                "mock backend does not serve this method",
            )),
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

    fn pty_write(&self, id: &str, bytes: &[u8]) -> Result<()> {
        // Local echo on the login PTY so typing in the modal is visible.
        if id.starts_with("account-login:") {
            let _ = self.pty_tx.try_send((id.to_string(), bytes.to_vec()));
        }
        Ok(())
    }

    fn set_focused(&self, _focused: bool) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchestra_rpc::types::WorkspaceStatus;

    #[test]
    fn fixture_set_covers_the_ledger_states() {
        let ws = mock_workspaces();
        // Spawn trees: an orchestrator root with children, incl. a grandchild
        // in a different repo, and a scratch root with a child.
        assert!(ws
            .iter()
            .any(|w| w.id == "orch-1" && w.parent_id.is_none() && w.is_scratch_like()));
        assert!(ws.iter().any(
            |w| w.parent_id.as_deref() == Some("ws-child-a") && w.repo_path == MOBILE_CLUB_REPO
        ));
        assert!(ws
            .iter()
            .any(|w| w.parent_id.as_deref() == Some("scratch-1")));
        // Host grouping: sandbox-hosted rows plus a local one in the same repo.
        let mc: Vec<_> = ws
            .iter()
            .filter(|w| w.repo_path == MOBILE_CLUB_REPO)
            .collect();
        assert!(mc.iter().any(|w| w.host.is_some()));
        assert!(mc.iter().any(|w| w.host.is_none()));
        // Every status dot appears somewhere.
        for status in [
            WorkspaceStatus::Idle,
            WorkspaceStatus::Running,
            WorkspaceStatus::Waiting,
            WorkspaceStatus::Error,
            WorkspaceStatus::Stopped,
        ] {
            assert!(ws.iter().any(|w| w.status == status), "{status:?} missing");
        }
        // Pill fodder + unread + archived multi-select.
        assert!(ws.iter().any(|w| w.marked_unread == Some(true)));
        assert!(ws.iter().any(|w| w.released_versions.is_some()));
        assert!(ws.iter().any(|w| w.unpushed_ahead.unwrap_or(0) > 0));
        assert!(ws.iter().filter(|w| w.archived == Some(true)).count() >= 3);
    }

    #[test]
    fn mutations_update_state_and_emit_events() {
        let b = MockBackend::default();
        let rx = b.events();

        b.call("renameBranch", vec![json!("ws-1"), json!("renamed-branch")])
            .unwrap();
        let ws = b.list_workspaces().unwrap();
        let w1 = ws.iter().find(|w| w.id == "ws-1").unwrap();
        assert_eq!(w1.branch, "renamed-branch");
        assert_eq!(w1.branch_manually_set, Some(true));
        let BackendEvent::Event { channel, args } = rx.try_recv().unwrap();
        assert_eq!(channel, "workspaceUpdate");
        assert_eq!(args[0]["branch"], "renamed-branch");

        b.call("archiveWorkspace", vec![json!("ws-1")]).unwrap();
        assert_eq!(
            b.list_workspaces()
                .unwrap()
                .iter()
                .find(|w| w.id == "ws-1")
                .unwrap()
                .archived,
            Some(true)
        );

        b.call("deleteWorkspace", vec![json!("ws-arch-1")]).unwrap();
        assert!(!b
            .list_workspaces()
            .unwrap()
            .iter()
            .any(|w| w.id == "ws-arch-1"));
    }

    #[test]
    fn bulk_delete_emits_progress_then_removal() {
        let b = MockBackend::default();
        let rx = b.events();
        b.call("deleteWorkspaces", vec![json!(["ws-arch-1", "ws-arch-2"])])
            .unwrap();
        let mut channels = Vec::new();
        while let Ok(BackendEvent::Event { channel, .. }) = rx.try_recv() {
            channels.push(channel);
        }
        assert_eq!(
            channels,
            vec![
                "workspacesDeleteProgress",
                "workspacesDeleteProgress",
                "workspacesRemoved"
            ]
        );
    }

    #[test]
    fn remove_repo_guard_matches_main() {
        let b = MockBackend::default();
        // orchestra repo still has workspaces → rejected.
        assert!(b.call("removeRepo", vec![json!(ORCHESTRA_REPO)]).is_err());
        // A freshly added empty repo removes fine.
        b.call("addRepo", vec![json!("/tmp/fresh-repo")]).unwrap();
        b.call("removeRepo", vec![json!("/tmp/fresh-repo")])
            .unwrap();
        assert!(!b
            .list_repos()
            .unwrap()
            .iter()
            .any(|r| r.path == "/tmp/fresh-repo"));
    }

    #[test]
    fn reorder_workspaces_persists_order() {
        let b = MockBackend::default();
        let mut ids: Vec<String> = b
            .list_workspaces()
            .unwrap()
            .iter()
            .map(|w| w.id.clone())
            .collect();
        let first = ids.remove(0);
        ids.push(first);
        b.call("reorderWorkspaces", vec![json!(ids)]).unwrap();
        let after: Vec<String> = b
            .list_workspaces()
            .unwrap()
            .iter()
            .map(|w| w.id.clone())
            .collect();
        assert_eq!(after, ids);
    }

    #[test]
    fn sync_repo_base_emits_syncing_then_done() {
        let b = MockBackend::default();
        let rx = b.events();
        b.call("syncRepoBase", vec![json!(ORCHESTRA_REPO)]).unwrap();
        let BackendEvent::Event { args: a1, .. } = rx.try_recv().unwrap();
        assert_eq!(a1[0]["syncing"], true);
        let BackendEvent::Event { args: a2, .. } = rx.try_recv().unwrap();
        assert_eq!(a2[0]["syncing"], false);
        assert_eq!(a2[0]["behind"], 0);
    }

    // ---- B5 self-tune wire-shape contracts (M3 gap fixes) -------------------

    /// `openSelfTuneReport: (loginId) => Promise<boolean>` (ipc.ts:290) — a
    /// BARE bool, false when that login has no report yet (self-tune.ts:134).
    /// The mock must reproduce BOTH branches or the false path is untestable.
    #[test]
    fn open_self_tune_report_returns_a_bare_bool_both_ways() {
        let b = MockBackend::default();
        // A login WITH a report → true.
        let yes = b
            .call("openSelfTuneReport", vec![json!("default")])
            .unwrap();
        assert_eq!(yes, Value::Bool(true), "expected a bare `true`, got {yes}");
        // A login with `reportPath: null` → false (the branch that used to be
        // structurally unreachable behind an {ok:true} envelope).
        let no = b.call("openSelfTuneReport", vec![json!("perso")]).unwrap();
        assert_eq!(no, Value::Bool(false), "expected a bare `false`, got {no}");
        // An unknown login is also "no report".
        let unknown = b.call("openSelfTuneReport", vec![json!("nope")]).unwrap();
        assert_eq!(unknown, Value::Bool(false));
    }

    /// Keyed lookups validate their key (systemic rule): a missing/wrong-typed
    /// param is an error, not a silently-defaulted fixture.
    #[test]
    fn keyed_self_tune_arms_validate_their_key() {
        let b = MockBackend::default();
        assert!(b.call("openSelfTuneReport", vec![]).is_err());
        assert!(b.call("openSelfTuneReport", vec![json!(7)]).is_err());
        assert!(b.call("getSelfTuneOutput", vec![]).is_err());
        assert!(b.call("stopAgent", vec![]).is_err());
        // `stopAgent: Promise<void>` → null on the wire, not an envelope.
        assert_eq!(
            b.call("stopAgent", vec![json!("ws-1")]).unwrap(),
            Value::Null
        );
    }

    /// `startSelfTune: () => Promise<SelfTuneRun>` (ipc.ts:282) — resolves with
    /// the BARE run record and REJECTS while one is in flight
    /// (self-tune.ts:284 throws). No `{ok, run}` envelope exists on the wire.
    #[test]
    fn start_self_tune_returns_a_bare_run_and_rejects_when_in_flight() {
        let b = MockBackend::default();
        let v = b.call("startSelfTune", vec![]).unwrap();
        assert!(
            v.get("ok").is_none() && v.get("run").is_none(),
            "must not wrap the run in an envelope: {v}"
        );
        let run: orchestra_rpc::types::SelfTuneRun =
            serde_json::from_value(v).expect("a bare SelfTuneRun deserializes");
        assert_eq!(run.status, orchestra_rpc::types::SelfTuneRunStatus::Running);
        assert_eq!(run.trigger, orchestra_rpc::types::SelfTuneTrigger::Manual);
        // Second start while the first is in flight → Err, matching the real
        // handler's throw (which crosses ui-rpc as a frame-level error).
        let err = b.call("startSelfTune", vec![]).unwrap_err();
        assert!(
            format!("{err}").contains("already in progress"),
            "unexpected rejection: {err}"
        );
    }
}
