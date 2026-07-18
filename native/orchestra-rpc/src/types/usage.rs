//! Mirrors of the usage shapes: `UsageSnapshot`/`UsageWindow` from
//! `src/shared/types.ts` and the per-account usage shapes from
//! `src/shared/accounts.ts`.

use serde::{Deserialize, Serialize};

/// `UsageWindow` (`types.ts:389`): one rolling Claude usage limit window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Percent of the window's quota consumed, 0–100.
    pub utilization: f64,
    /// ISO-8601 timestamp at which this window's quota resets.
    pub resets_at: String,
}

/// `UsageSnapshot` (`types.ts:399`): the signed-in default login's usage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub five_hour: UsageWindow,
    pub seven_day: UsageWindow,
    /// `number | null` and TS-optional — pay-as-you-go utilization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_utilization: Option<f64>,
    /// The Fable-scoped weekly window, `UsageWindow | null` and TS-optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fable: Option<UsageWindow>,
    /// Epoch ms when this snapshot was fetched.
    pub fetched_at: i64,
}

/// `UsageWindowDetail` (`accounts.ts:84`). Same shape as {@link UsageWindow};
/// kept as its own type to mirror the TS split (`resetsAt` is `''` when
/// unknown here, never null).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowDetail {
    pub utilization: f64,
    pub resets_at: String,
}

/// `UsageData` (`accounts.ts:92`): parsed usage for one account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    pub five_hour: UsageWindowDetail,
    pub seven_day: UsageWindowDetail,
    /// `number | null` (always present in TS, nullable).
    #[serde(default)]
    pub extra_utilization: Option<f64>,
    /// `UsageWindowDetail | null`.
    #[serde(default)]
    pub fable: Option<UsageWindowDetail>,
}

/// `UsageErrorKind` (`accounts.ts:114`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageErrorKind {
    NoDir,
    NotLoggedIn,
    NoScope,
    RateLimited,
    Error,
}

/// `AccountUsageStatus` (`accounts.ts:118`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageStatus {
    pub account_id: String,
    pub ok: bool,
    /// `UsageData | null`.
    #[serde(default)]
    pub data: Option<UsageData>,
    /// `UsageErrorKind | null`.
    #[serde(default)]
    pub error_kind: Option<UsageErrorKind>,
    /// `string | null`; never contains a token.
    #[serde(default)]
    pub error_message: Option<String>,
    /// Epoch ms.
    pub fetched_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expired: Option<bool>,
}
