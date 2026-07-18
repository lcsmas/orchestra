//! Mirrors of the self-tune pipeline shapes in `src/shared/self-tune.ts`.

use serde::{Deserialize, Serialize};

/// `SelfTuneStepStatus` (`self-tune.ts:13`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelfTuneStepStatus {
    Pending,
    Running,
    Ok,
    Failed,
}

/// `SelfTuneStep.kind` (`self-tune.ts:31`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelfTuneStepKind {
    Insights,
    Fold,
}

/// `SelfTuneStep` (`self-tune.ts:27`): one step of a run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfTuneStep {
    /// `insights:<loginId>` or `fold`.
    pub id: String,
    pub kind: SelfTuneStepKind,
    pub login_id: String,
    pub label: String,
    pub config_dir: String,
    pub status: SelfTuneStepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Spawn-level failure — distinct from a non-zero exit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `LessonsDiff` (`self-tune.ts:46`): what a run did to LESSONS.md.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonsDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub total: u64,
}

/// `SelfTuneRun.trigger` (`self-tune.ts:59`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelfTuneTrigger {
    Auto,
    Manual,
}

/// `SelfTuneRun.status` (`self-tune.ts:60`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelfTuneRunStatus {
    Running,
    Ok,
    Failed,
}

/// `SelfTuneRun` (`self-tune.ts:57`): a whole pipeline run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfTuneRun {
    pub id: String,
    pub trigger: SelfTuneTrigger,
    pub status: SelfTuneRunStatus,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    pub steps: Vec<SelfTuneStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lessons: Option<LessonsDiff>,
}

/// `SelfTuneReport` (`self-tune.ts:74`): newest report per login.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfTuneReport {
    pub login_id: String,
    pub label: String,
    pub config_dir: String,
    /// `string | null` — null when the login has no report yet.
    #[serde(default)]
    pub report_path: Option<String>,
}
