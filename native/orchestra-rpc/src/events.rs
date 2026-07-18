//! Event channels: the 22 `on*` members of `OrchestraAPI` (`src/shared/ipc.ts`)
//! plus the two M1-added channels (`docs/ui-rpc-protocol.md` §5).
//!
//! Wire channel name = the interface member without its `on` prefix, first
//! letter lowercased (`onWorkspaceUpdate` → `workspaceUpdate`); `args` is the
//! callback's positional argument list. `onPtyData` normally travels as the
//! binary `ptyData` frame and surfaces on the client's dedicated PTY channel,
//! but a JSON `ptyData` event decodes here too (fixtures use that form).

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::types::{
    AccountUsageStatus, AccountsLoginUrl, RepoEntry, RepoSyncState, SandboxControlState,
    SelfTuneRun, UiNotify, UsageSnapshot, Workspace, WorkspaceAccount,
};

/// One `event` frame as received: `{channel, args}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub channel: String,
    pub args: Vec<Value>,
}

/// A decoded event. `Other` carries channels this crate doesn't know
/// (forward compatibility — the backend may be newer).
#[derive(Debug, Clone, PartialEq)]
pub enum UiEvent {
    WorkspaceUpdate(Box<Workspace>),
    WorkspaceRemoved {
        id: String,
    },
    WorkspacesRemoved {
        ids: Vec<String>,
    },
    WorkspacesDeleteProgress {
        done: u64,
        total: u64,
    },
    WorkspaceFocus {
        id: String,
    },
    AgentFinished {
        id: String,
        focused: bool,
    },
    AgentNeedsInput {
        id: String,
        focused: bool,
    },
    AgentTool {
        id: String,
        tool: Option<String>,
    },
    AgentContext {
        id: String,
        tokens: u64,
    },
    RepoSyncState(Box<RepoSyncState>),
    UsageUpdate(Box<UsageSnapshot>),
    AccountUsageUpdate(HashMap<String, AccountUsageStatus>),
    WorkspaceAccountsUpdate(HashMap<String, WorkspaceAccount>),
    ReposUpdate(Vec<RepoEntry>),
    AccountLoginDone {
        account_id: String,
    },
    PtyData {
        id: String,
        data: String,
    },
    PtyExit {
        id: String,
        code: i32,
    },
    PtyRestart {
        id: String,
    },
    PtyStopped {
        id: String,
    },
    SandboxControl(Box<SandboxControlState>),
    SelfTuneUpdate(Box<SelfTuneRun>),
    SelfTuneOutput {
        run_id: String,
        chunk: String,
    },
    UiNotify(Box<UiNotify>),
    AccountsLoginUrl(AccountsLoginUrl),
    /// Unknown channel — kept verbatim so callers can log or ignore it.
    Other {
        channel: String,
        args: Vec<Value>,
    },
}

#[derive(Debug, thiserror::Error)]
#[error("bad args for event channel '{channel}': {reason}")]
pub struct EventDecodeError {
    pub channel: String,
    pub reason: String,
}

fn arg<T: DeserializeOwned>(ev: &Event, index: usize) -> Result<T, EventDecodeError> {
    let v = ev.args.get(index).cloned().unwrap_or(Value::Null);
    serde_json::from_value(v).map_err(|e| EventDecodeError {
        channel: ev.channel.clone(),
        reason: format!("arg[{index}]: {e}"),
    })
}

impl Event {
    /// Decode into the typed event for the channel. Malformed args of a KNOWN
    /// channel error; unknown channels come back as [`UiEvent::Other`].
    pub fn decode(&self) -> Result<UiEvent, EventDecodeError> {
        Ok(match self.channel.as_str() {
            "workspaceUpdate" => UiEvent::WorkspaceUpdate(Box::new(arg(self, 0)?)),
            "workspaceRemoved" => UiEvent::WorkspaceRemoved { id: arg(self, 0)? },
            "workspacesRemoved" => UiEvent::WorkspacesRemoved { ids: arg(self, 0)? },
            "workspacesDeleteProgress" => UiEvent::WorkspacesDeleteProgress {
                done: arg(self, 0)?,
                total: arg(self, 1)?,
            },
            "workspaceFocus" => UiEvent::WorkspaceFocus { id: arg(self, 0)? },
            "agentFinished" => UiEvent::AgentFinished {
                id: arg(self, 0)?,
                focused: arg(self, 1)?,
            },
            "agentNeedsInput" => UiEvent::AgentNeedsInput {
                id: arg(self, 0)?,
                focused: arg(self, 1)?,
            },
            "agentTool" => UiEvent::AgentTool {
                id: arg(self, 0)?,
                tool: arg(self, 1)?,
            },
            "agentContext" => UiEvent::AgentContext {
                id: arg(self, 0)?,
                tokens: arg(self, 1)?,
            },
            "repoSyncState" => UiEvent::RepoSyncState(Box::new(arg(self, 0)?)),
            "usageUpdate" => UiEvent::UsageUpdate(Box::new(arg(self, 0)?)),
            "accountUsageUpdate" => UiEvent::AccountUsageUpdate(arg(self, 0)?),
            "workspaceAccountsUpdate" => UiEvent::WorkspaceAccountsUpdate(arg(self, 0)?),
            "reposUpdate" => UiEvent::ReposUpdate(arg(self, 0)?),
            "accountLoginDone" => UiEvent::AccountLoginDone {
                account_id: arg(self, 0)?,
            },
            "ptyData" => UiEvent::PtyData {
                id: arg(self, 0)?,
                data: arg(self, 1)?,
            },
            "ptyExit" => UiEvent::PtyExit {
                id: arg(self, 0)?,
                code: arg(self, 1)?,
            },
            "ptyRestart" => UiEvent::PtyRestart { id: arg(self, 0)? },
            "ptyStopped" => UiEvent::PtyStopped { id: arg(self, 0)? },
            "sandboxControl" => UiEvent::SandboxControl(Box::new(arg(self, 0)?)),
            "selfTuneUpdate" => UiEvent::SelfTuneUpdate(Box::new(arg(self, 0)?)),
            "selfTuneOutput" => UiEvent::SelfTuneOutput {
                run_id: arg(self, 0)?,
                chunk: arg(self, 1)?,
            },
            "uiNotify" => UiEvent::UiNotify(Box::new(arg(self, 0)?)),
            "accountsLoginUrl" => UiEvent::AccountsLoginUrl(arg(self, 0)?),
            _ => UiEvent::Other {
                channel: self.channel.clone(),
                args: self.args.clone(),
            },
        })
    }
}

/// Every JSON event channel this crate types, in `ipc.ts` order — used by the
/// conformance rig to prove fixture coverage maps somewhere.
pub const KNOWN_CHANNELS: &[&str] = &[
    "accountLoginDone",
    "ptyData",
    "ptyExit",
    "ptyRestart",
    "ptyStopped",
    "sandboxControl",
    "selfTuneUpdate",
    "selfTuneOutput",
    "workspaceUpdate",
    "workspaceRemoved",
    "workspacesRemoved",
    "workspacesDeleteProgress",
    "workspaceFocus",
    "agentFinished",
    "agentNeedsInput",
    "agentTool",
    "agentContext",
    "repoSyncState",
    "usageUpdate",
    "accountUsageUpdate",
    "workspaceAccountsUpdate",
    "reposUpdate",
    "uiNotify",
    "accountsLoginUrl",
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(channel: &str, args: Vec<Value>) -> Event {
        Event {
            channel: channel.into(),
            args,
        }
    }

    #[test]
    fn scalar_channels_decode() {
        assert_eq!(
            ev("workspaceRemoved", vec![json!("ws-1")])
                .decode()
                .unwrap(),
            UiEvent::WorkspaceRemoved { id: "ws-1".into() }
        );
        assert_eq!(
            ev("agentTool", vec![json!("ws-1"), Value::Null])
                .decode()
                .unwrap(),
            UiEvent::AgentTool {
                id: "ws-1".into(),
                tool: None
            }
        );
        assert_eq!(
            ev("workspacesDeleteProgress", vec![json!(2), json!(5)])
                .decode()
                .unwrap(),
            UiEvent::WorkspacesDeleteProgress { done: 2, total: 5 }
        );
    }

    #[test]
    fn struct_channels_decode() {
        let e = ev(
            "repoSyncState",
            vec![json!({
                "repoPath":"/r","baseBranch":"main","behind":1,"ahead":0,
                "hasUpstream":true,"syncedAt":0,"syncing":false
            })],
        );
        match e.decode().unwrap() {
            UiEvent::RepoSyncState(s) => assert_eq!(s.behind, 1),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn unknown_channel_is_other() {
        let e = ev("someFutureChannel", vec![json!(1)]);
        assert!(matches!(e.decode().unwrap(), UiEvent::Other { .. }));
    }

    #[test]
    fn known_channel_bad_args_errors() {
        assert!(ev("ptyExit", vec![json!("id"), json!("not-a-number")])
            .decode()
            .is_err());
    }
}
