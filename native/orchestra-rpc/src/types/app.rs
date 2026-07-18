//! Mirrors of app-level shapes: `EnvStatusItem` from `src/shared/types.ts`,
//! `WorktreeSizes` from `src/shared/worktree-sizes.ts`, and the two M1-added
//! methods `deps:status` / `app:info` (`docs/ui-rpc-protocol.md` §4).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::protocol::BackendKind;

/// `EnvStatusItem` (`types.ts:335`): one optional-setup check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvStatusItem {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
}

/// `WorktreeSizes` (`worktree-sizes.ts:10`): bytes keyed by workspace id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSizes {
    pub sizes: HashMap<String, u64>,
    /// True when `sizes` are btrfs EXCLUSIVE bytes, false for apparent `du`.
    pub exclusive: bool,
}

/// Result of the M1-added `deps:status` method.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepsStatus {
    pub git: bool,
    pub gh: bool,
    pub claude: bool,
    pub messages: Vec<String>,
}

/// Result of the M1-added `app:info` method.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub backend_kind: BackendKind,
    pub orchestra_home: String,
    pub log_path: String,
}

/// `log(...)` level (`ipc.ts:140`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}
