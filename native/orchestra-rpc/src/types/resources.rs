//! Mirrors of the Resources-page shapes in `src/shared/resources.ts` (the
//! wire-facing subset — the pure sampling helpers stay TypeScript-side).

use serde::{Deserialize, Serialize};

/// `SessionKind` (`resources.ts:36`): what kind of PTY a session id denotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Agent,
    Run,
    Nvim,
    Login,
}

/// `ProcStat` (`resources.ts:25`): one process inside a session's tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcStat {
    pub pid: i32,
    pub comm: String,
    /// Percent of one core (can exceed 100 for multi-threaded processes).
    pub cpu_pct: f64,
    pub mem_bytes: u64,
}

/// `SessionResourceStat` (`resources.ts:39`): live figures for one PTY
/// session's whole process tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResourceStat {
    pub pty_id: String,
    /// `string | null` — null for account-login PTYs.
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub kind: SessionKind,
    pub remote: bool,
    pub cpu_pct: f64,
    pub mem_bytes: u64,
    pub proc_count: u64,
    pub processes: Vec<ProcStat>,
}

/// `AppProcessStat` (`resources.ts:58`): one Electron process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppProcessStat {
    /// Electron's process type ("Browser", "Tab", "GPU", "Utility", …).
    #[serde(rename = "type")]
    pub process_type: String,
    pub pid: i32,
    pub cpu_pct: f64,
    pub mem_bytes: u64,
}

/// `DiskStats` (`resources.ts:70`): on-disk footprint of Orchestra's data
/// dirs. Every size is `number | null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    #[serde(default)]
    pub scratch_bytes: Option<u64>,
    #[serde(default)]
    pub logs_bytes: Option<u64>,
    #[serde(default)]
    pub backups_bytes: Option<u64>,
    #[serde(default)]
    pub events_bytes: Option<u64>,
    /// Epoch ms when the du pass ran.
    pub measured_at: i64,
}

/// `ResourceSnapshot` (`resources.ts:81`): one full sample.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    /// Epoch ms.
    pub at: i64,
    pub cpu_cores: u32,
    pub mem_total_bytes: u64,
    pub sessions: Vec<SessionResourceStat>,
    pub app: Vec<AppProcessStat>,
    /// `DiskStats | null`.
    #[serde(default)]
    pub disk: Option<DiskStats>,
}
