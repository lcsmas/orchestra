//! Mirrors of the repo shapes in `src/shared/types.ts`.

use serde::{Deserialize, Serialize};

/// `RepoScripts` (`types.ts:262`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoScripts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive: Option<String>,
}

/// `RepoEntry` (`types.ts:277`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub path: String,
    pub name: String,
    pub default_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scripts: Option<RepoScripts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
}

/// `RepoSyncState` (`types.ts:366`): sync status of a repo's base branch
/// against `origin/<base>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSyncState {
    pub repo_path: String,
    pub base_branch: String,
    pub behind: u64,
    pub ahead: u64,
    pub has_upstream: bool,
    /// Epoch ms of the last successful fetch; 0 before any fetch.
    pub synced_at: i64,
    pub syncing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
