//! Mirrors of the account shapes in `src/shared/accounts.ts` plus the
//! account-related IPC result types from `src/shared/ipc.ts`.

use serde::{Deserialize, Serialize};

/// `AccountInherit` (`accounts.ts:44`): what an account's config dir inherits
/// from the global `~/.claude`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInherit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statusline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Vec<String>>,
}

/// `Account` (`accounts.ts:18`): a label plus the Claude Code config dir it
/// logs in through. `configDir` is a path template (`~`, `${VAR}`) — never a
/// secret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub label: String,
    pub config_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch_default: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inherit: Option<AccountInherit>,
}

/// `WorkspaceAccount` (`types.ts:433`): a workspace's resolved account
/// identity (never a token or path).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAccount {
    pub workspace_id: String,
    /// `string | null` — null = default/stored login.
    #[serde(default)]
    pub account_id: Option<String>,
    pub label: String,
}

/// `MigrateAccountResult` (`ipc.ts:25`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateAccountResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// `string | null` and TS-optional: the account the workspace is now
    /// pinned to, or null for default login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of `listGlobalInheritables` (`ipc.ts:129`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalInheritables {
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
}
