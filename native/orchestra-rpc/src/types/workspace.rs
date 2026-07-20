//! Mirrors of the workspace-centric shapes in `src/shared/types.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `WorkspaceStatus` (`types.ts:1`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceStatus {
    Idle,
    Running,
    Waiting,
    Error,
    Stopped,
}

/// `WorkspaceHost` (`types.ts:12`): where a workspace's agent runs. An absent
/// host field on `Workspace` means local.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkspaceHost {
    Local,
    Sandbox { endpoint: String },
}

/// `Workspace.kind` (`types.ts:67`). Absent = `Worktree`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    Worktree,
    Scratch,
    Orchestrator,
}

/// `Workspace.agent` — currently the single literal `'claude'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
}

/// `Workspace.setupStatus` (`types.ts:196`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SetupStatus {
    Pending,
    Running,
    Ok,
    Failed,
}

/// `QueuedPrompt` (`types.ts:35`): one prompt parked while the workspace's
/// account is over its usage limit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedPrompt {
    pub id: String,
    pub text: String,
    /// Epoch ms when the prompt was queued.
    pub queued_at: i64,
}

/// `Workspace` (`types.ts:47`) — every field, TS-optional as `Option<T>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<WorkspaceKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<WorkspaceHost>,
    pub repo_path: String,
    pub worktree_path: String,
    pub branch: String,
    pub base_branch: String,
    /// Epoch ms.
    pub created_at: i64,
    pub status: WorkspaceStatus,
    pub agent: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_task: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_input: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marked_unread: Option<bool>,
    /// Set on a git worktree promoted to a coordinator. The `'orchestrator'`
    /// KIND carries the same capability on its own, so read it via
    /// [`Workspace::can_orchestrate`] rather than this field directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_orchestrate: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heavy_resume_pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_manually_set: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_rename_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Epoch ms of the most recent merge into base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diverged_from_base: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unpushed_ahead: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_versions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_status: Option<SetupStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_prompts: Option<Vec<QueuedPrompt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
}

impl Workspace {
    /// Port of `isScratchLike` (`types.ts:227`): true for the non-git kinds.
    pub fn is_scratch_like(&self) -> bool {
        matches!(
            self.kind,
            Some(WorkspaceKind::Scratch) | Some(WorkspaceKind::Orchestrator)
        )
    }

    /// Port of `canOrchestrate` (`types.ts`): true for the orchestrator KIND and
    /// for any workspace carrying the capability flag — a promoted git worktree
    /// stays `kind: 'worktree'` and gains `canOrchestrate` instead, so checking
    /// the kind alone would miss it.
    pub fn can_orchestrate(&self) -> bool {
        self.kind == Some(WorkspaceKind::Orchestrator) || self.can_orchestrate == Some(true)
    }
}

/// `CreateWorkspaceInput` (`types.ts:246`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
    pub repo_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<WorkspaceHost>,
}

/// `SandboxControlState` (`types.ts:26`): cross-machine ownership state for
/// one sandbox endpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxControlState {
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_name: Option<String>,
    pub is_driver: bool,
}

/// Result of `flushQueuedPrompts` (`ipc.ts:195`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushQueuedPromptsResult {
    pub ok: bool,
    pub delivered: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The single-literal `'requested'` status of `mergeWorktree` (`ipc.ts:259`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeRequestStatus {
    Requested,
}

/// Result of `mergeWorktree`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeWorktreeResult {
    pub status: MergeRequestStatus,
}

/// Payload of the M1-added `uiNotify` event channel
/// (`docs/ui-rpc-protocol.md` §5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiNotify {
    pub ws_id: String,
    pub kind: UiNotifyKind,
    pub title: String,
    pub body: String,
}

/// `uiNotify.kind`: `'finished' | 'needsInput'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UiNotifyKind {
    Finished,
    NeedsInput,
}

/// Payload of the M1-added `accountsLoginUrl` event channel
/// (`docs/ui-rpc-protocol.md` §5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsLoginUrl {
    pub account_id: String,
    pub url: String,
}

/// Catch-all for values the crate deliberately leaves untyped.
pub type Json = Value;
