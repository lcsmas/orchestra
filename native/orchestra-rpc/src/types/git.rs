//! Mirrors of the diff / PR shapes in `src/shared/types.ts`.

use serde::{Deserialize, Serialize};

/// `DiffFile.status` (`types.ts:233`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// `DiffFile` (`types.ts:231`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub status: DiffFileStatus,
    pub additions: u64,
    pub deletions: u64,
    pub old_content: String,
    pub new_content: String,
}

/// `DiffStats` (`types.ts:240`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStats {
    pub additions: u64,
    pub deletions: u64,
    pub files: u64,
}

/// `PRInfo.state` — Linear's uppercase literals, verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

/// `PRInfo` (`types.ts:299`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub url: String,
    pub number: u64,
    pub state: PrState,
    pub title: String,
}

/// `PRsForBranch` (`types.ts:306`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrsForBranch {
    /// All PRs ever opened from this branch, newest-first (capped).
    pub all: Vec<PrInfo>,
    /// `PRInfo | null` on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open: Option<PrInfo>,
    /// `PRInfo | null` on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<PrInfo>,
    pub merged_count: u64,
}
