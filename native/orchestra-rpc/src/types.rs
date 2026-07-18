//! Serde mirrors of `src/shared/types.ts` (and self-tune / resources /
//! worktree-sizes shapes).
//!
//! M0 seeds the two structs everything touches; A2 completes the set against
//! the conformance fixtures. Rules (plan §7): `rename_all = "camelCase"`,
//! every TS-optional field is `Option<T>`, unknown fields tolerated
//! (serde's default), no `deny_unknown_fields` anywhere.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceStatus {
    Idle,
    Running,
    Waiting,
    Error,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHost {
    pub kind: String, // 'sandbox'
    pub endpoint: String,
}

/// Mirror of `Workspace` (`types.ts:3`). Field set completed by A2 against
/// fixtures; the fields below are the ones the M1 skeleton already renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: Option<String>, // 'worktree' (absent) | 'scratch' | 'orchestrator'
    pub repo_path: String,
    pub worktree_path: String,
    pub branch: String,
    pub base_branch: String,
    pub status: WorkspaceStatus,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub host: Option<WorkspaceHost>,
    #[serde(default)]
    pub marked_unread: Option<bool>,
    #[serde(default)]
    pub context_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub path: String,
    pub name: String,
    pub default_branch: String,
    #[serde(default)]
    pub remote_url: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_tolerates_unknown_and_missing_fields() {
        let raw = r#"{
            "id":"x","name":"repo · branch","repoPath":"/r","worktreePath":"/w",
            "branch":"b","baseBranch":"main","status":"running",
            "someFutureField":{"nested":true}
        }"#;
        let ws: Workspace = serde_json::from_str(raw).unwrap();
        assert_eq!(ws.status, WorkspaceStatus::Running);
        assert!(ws.host.is_none());
    }
}
