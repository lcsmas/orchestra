//! Conformance rig (docs/ui-rpc-protocol.md §7).
//!
//! Reads `fixtures/*.json` — captures of real request/response/event JSON
//! produced by `scripts/dump-rpc-fixtures.ts` (workstream A1) — and proves the
//! serde mirrors roundtrip them: deserialize into the typed struct for the
//! method/channel, re-serialize, and compare semantically (numbers by value,
//! absent-vs-null equivalent for `Option` fields).
//!
//! The fixtures directory may be empty on this branch (A1 runs elsewhere);
//! the rig then skips with a notice. The verifier runs the combined branches.

use std::collections::HashMap;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use orchestra_rpc::events::Event;
use orchestra_rpc::types::*;

// ---------------------------------------------------------------------------
// Semantic comparison

/// Compare an original fixture value against its typed re-serialization.
///
/// - Numbers compare by value (integer 5 == 5.0 — serde re-serializes an f64
///   field as `x.0`).
/// - An absent object key equals an explicit null (TS-optional fields decode
///   to `Option` and re-serialize as absent).
/// - A key present ONLY in the original is an *unknown field* — tolerated per
///   protocol §7 (the backend may be newer than this crate), but recorded in
///   `unknown` so the drift stays visible in the test output.
///
/// Any other divergence is a hard mismatch pushed to `errors`.
fn semantic_diff(
    original: &Value,
    reserialized: &Value,
    path: &str,
    errors: &mut Vec<String>,
    unknown: &mut Vec<String>,
) {
    match (original, reserialized) {
        (Value::Object(o), Value::Object(r)) => {
            for (k, vo) in o {
                let sub = format!("{path}.{k}");
                match r.get(k) {
                    Some(vr) => semantic_diff(vo, vr, &sub, errors, unknown),
                    None if vo.is_null() => {} // Option::None serialized as absent
                    None => unknown.push(sub),
                }
            }
            for (k, vr) in r {
                if !o.contains_key(k) && !vr.is_null() {
                    errors.push(format!("{path}.{k}: reserialization invented value {vr}"));
                }
            }
        }
        (Value::Array(o), Value::Array(r)) => {
            if o.len() != r.len() {
                errors.push(format!("{path}: array length {} != {}", o.len(), r.len()));
                return;
            }
            for (i, (vo, vr)) in o.iter().zip(r).enumerate() {
                semantic_diff(vo, vr, &format!("{path}[{i}]"), errors, unknown);
            }
        }
        (Value::Number(a), Value::Number(b)) => {
            if a.as_f64() != b.as_f64() {
                errors.push(format!("{path}: number {a} != {b}"));
            }
        }
        (a, b) => {
            if a != b {
                errors.push(format!("{path}: {a} != {b}"));
            }
        }
    }
}

fn roundtrip<T: Serialize + DeserializeOwned>(v: &Value, ctx: &str) -> Result<(), String> {
    let typed: T = serde_json::from_value(v.clone())
        .map_err(|e| format!("{ctx}: deserialize failed: {e}\n  value: {v}"))?;
    let back =
        serde_json::to_value(&typed).map_err(|e| format!("{ctx}: reserialize failed: {e}"))?;
    let mut errors = Vec::new();
    let mut unknown = Vec::new();
    semantic_diff(v, &back, "$", &mut errors, &mut unknown);
    if !unknown.is_empty() {
        eprintln!(
            "NOTICE: {ctx}: unknown field(s) tolerated (backend newer?): {}",
            unknown.join(", ")
        );
    }
    if !errors.is_empty() {
        return Err(format!(
            "{ctx}: lossy roundtrip: {}\n  original:     {v}\n  reserialized: {back}",
            errors.join("; ")
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Method → result-type dispatch (OrchestraAPI order, ipc.ts)

fn check_method(method: &str, params: &[Value], result: &Value) -> Result<(), String> {
    let ctx = format!("method '{method}' result");
    let c = ctx.as_str();
    match method {
        "addRepo" | "setRepoDefaultBranch" | "setRepoAccount" | "setRepoScripts" => {
            roundtrip::<RepoEntry>(result, c)?
        }
        "listRepos" => roundtrip::<Vec<RepoEntry>>(result, c)?,
        "listRepoSyncStates" => roundtrip::<Vec<RepoSyncState>>(result, c)?,
        "listRepoBranches" | "listBranches" => roundtrip::<Vec<String>>(result, c)?,
        "pickDirectory" | "saveClipboardImage" => roundtrip::<Option<String>>(result, c)?,
        "getAppVersion"
        | "logPath"
        | "backupSandbox"
        | "readSetupLog"
        | "runScriptScrollback"
        | "getSelfTuneOutput"
        | "readSelfTuneLessons"
        | "pty:scrollback" => roundtrip::<String>(result, c)?,
        "getEnvStatus" => roundtrip::<Vec<EnvStatusItem>>(result, c)?,
        "getLinearKeySource" => roundtrip::<LinearKeySource>(result, c)?,
        "checkLinearKey" => roundtrip::<LinearKeyCheck>(result, c)?,
        "getUsage" => roundtrip::<Option<UsageSnapshot>>(result, c)?,
        "listAccounts" | "setAccounts" => roundtrip::<Vec<Account>>(result, c)?,
        "migrateWorkspaceAccount" => roundtrip::<MigrateAccountResult>(result, c)?,
        "getAccountUsage" => roundtrip::<Option<AccountUsageStatus>>(result, c)?,
        "getAllAccountUsage" => roundtrip::<HashMap<String, AccountUsageStatus>>(result, c)?,
        "getWorkspaceAccounts" => roundtrip::<HashMap<String, WorkspaceAccount>>(result, c)?,
        "listGlobalInheritables" => roundtrip::<GlobalInheritables>(result, c)?,
        "listWorkspaces" => roundtrip::<Vec<Workspace>>(result, c)?,
        "createWorkspace"
        | "createScratchWorkspace"
        | "createOrchestratorWorkspace"
        | "importToSandbox"
        | "ejectFromSandbox"
        | "renameBranch"
        | "queuePrompt"
        | "removeQueuedPrompt"
        | "promoteWorkspace"
        | "demoteWorkspace"
        | "setWorkspaceParent"
        | "switchBranch" => roundtrip::<Workspace>(result, c)?,
        "flushQueuedPrompts" => roundtrip::<FlushQueuedPromptsResult>(result, c)?,
        "sandboxControlState" => roundtrip::<Option<SandboxControlState>>(result, c)?,
        "getDiff" => roundtrip::<Vec<DiffFile>>(result, c)?,
        "getDiffStats" => roundtrip::<DiffStats>(result, c)?,
        "getWorktreeSizes" => roundtrip::<WorktreeSizes>(result, c)?,
        "sampleResources" => roundtrip::<ResourceSnapshot>(result, c)?,
        "findPR" => roundtrip::<PrsForBranch>(result, c)?,
        "verifyLinear" => roundtrip::<Option<LinearIssue>>(result, c)?,
        "mergeWorktree" => roundtrip::<MergeWorktreeResult>(result, c)?,
        "getRepoScripts" => roundtrip::<RepoScripts>(result, c)?,
        "runScriptStatus" | "openSelfTuneReport" => roundtrip::<bool>(result, c)?,
        "listSelfTuneRuns" => roundtrip::<Vec<SelfTuneRun>>(result, c)?,
        "startSelfTune" => roundtrip::<SelfTuneRun>(result, c)?,
        "listSelfTuneReports" => roundtrip::<Vec<SelfTuneReport>>(result, c)?,
        "deps:status" => roundtrip::<DepsStatus>(result, c)?,
        "app:info" => roundtrip::<AppInfo>(result, c)?,
        // Void methods: undefined travels as null/absent.
        "removeRepo"
        | "syncRepoBase"
        | "reorderRepos"
        | "openExternal"
        | "saveLinearKey"
        | "clearLinearKey"
        | "accountLoginStart"
        | "accountLoginStop"
        | "accountLoginOpenUrl"
        | "refreshAccounts"
        | "revealLogs"
        | "log"
        | "archiveWorkspace"
        | "unarchiveWorkspace"
        | "deleteWorkspace"
        | "deleteWorkspaces"
        | "markSeen"
        | "setUnread"
        | "reorderWorkspaces"
        | "ptyStart"
        | "ptyWrite"
        | "ptyResize"
        | "ptyRepaint"
        | "restartAgent"
        | "stopAgent"
        | "nvimStart"
        | "takeSandboxControl"
        | "retrySetup"
        | "runScriptStart"
        | "runScriptStop" => {
            if !result.is_null() {
                return Err(format!(
                    "{c}: void method carried a non-null result: {result}"
                ));
            }
        }
        other => {
            return Err(format!(
                "fixture names unknown method '{other}' — type drift?"
            ))
        }
    }
    // Typed params, where the input shape is a struct worth gating.
    match method {
        "createWorkspace" => {
            roundtrip::<CreateWorkspaceInput>(
                params.first().unwrap_or(&Value::Null),
                &format!("method '{method}' params[0]"),
            )?;
        }
        "setAccounts" => {
            roundtrip::<Vec<Account>>(
                params.first().unwrap_or(&Value::Null),
                &format!("method '{method}' params[0]"),
            )?;
        }
        "setRepoScripts" => {
            roundtrip::<RepoScripts>(
                params.get(1).unwrap_or(&Value::Null),
                &format!("method '{method}' params[1]"),
            )?;
        }
        _ => {}
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Channel → args-type dispatch (event channels, protocol §5)

fn check_event(channel: &str, args: &[Value]) -> Result<(), String> {
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let ctx = |i: usize| format!("event '{channel}' args[{i}]");
    match channel {
        "workspaceUpdate" => roundtrip::<Workspace>(arg(0), &ctx(0))?,
        "workspaceRemoved" | "workspaceFocus" | "ptyRestart" | "ptyStopped"
        | "accountLoginDone" => roundtrip::<String>(arg(0), &ctx(0))?,
        "workspacesRemoved" => roundtrip::<Vec<String>>(arg(0), &ctx(0))?,
        "workspacesDeleteProgress" => {
            roundtrip::<u64>(arg(0), &ctx(0))?;
            roundtrip::<u64>(arg(1), &ctx(1))?;
        }
        "agentFinished" | "agentNeedsInput" => {
            roundtrip::<String>(arg(0), &ctx(0))?;
            roundtrip::<bool>(arg(1), &ctx(1))?;
        }
        "agentTool" => {
            roundtrip::<String>(arg(0), &ctx(0))?;
            roundtrip::<Option<String>>(arg(1), &ctx(1))?;
        }
        "agentContext" => {
            roundtrip::<String>(arg(0), &ctx(0))?;
            roundtrip::<u64>(arg(1), &ctx(1))?;
        }
        "repoSyncState" => roundtrip::<RepoSyncState>(arg(0), &ctx(0))?,
        "usageUpdate" => roundtrip::<UsageSnapshot>(arg(0), &ctx(0))?,
        "accountUsageUpdate" => roundtrip::<HashMap<String, AccountUsageStatus>>(arg(0), &ctx(0))?,
        "workspaceAccountsUpdate" => {
            roundtrip::<HashMap<String, WorkspaceAccount>>(arg(0), &ctx(0))?
        }
        "reposUpdate" => roundtrip::<Vec<RepoEntry>>(arg(0), &ctx(0))?,
        "ptyData" | "selfTuneOutput" => {
            roundtrip::<String>(arg(0), &ctx(0))?;
            roundtrip::<String>(arg(1), &ctx(1))?;
        }
        "ptyExit" => {
            roundtrip::<String>(arg(0), &ctx(0))?;
            roundtrip::<i32>(arg(1), &ctx(1))?;
        }
        "sandboxControl" => roundtrip::<SandboxControlState>(arg(0), &ctx(0))?,
        "selfTuneUpdate" => roundtrip::<SelfTuneRun>(arg(0), &ctx(0))?,
        "uiNotify" => roundtrip::<UiNotify>(arg(0), &ctx(0))?,
        "accountsLoginUrl" => roundtrip::<AccountsLoginUrl>(arg(0), &ctx(0))?,
        other => {
            return Err(format!(
                "fixture names unknown event channel '{other}' — drift?"
            ))
        }
    }
    // The client-side decoder must accept it too.
    let ev = Event {
        channel: channel.to_string(),
        args: args.to_vec(),
    };
    ev.decode()
        .map_err(|e| format!("event '{channel}': client decode failed: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Fixture loading

fn check_fixture(v: &Value, file: &str, errors: &mut Vec<String>) -> usize {
    if let Some(items) = v.as_array() {
        return items
            .iter()
            .map(|item| check_fixture(item, file, errors))
            .sum();
    }
    let tag = |k: &str| v.get(k).and_then(Value::as_str);
    let no_args: Vec<Value> = Vec::new();
    if let Some(method) = tag("method") {
        let params = v
            .get("params")
            .and_then(Value::as_array)
            .unwrap_or(&no_args);
        let result = v.get("result").unwrap_or(&Value::Null);
        if let Err(e) = check_method(method, params, result) {
            errors.push(format!("{file}: {e}"));
        }
        1
    } else if let Some(channel) = tag("channel") {
        let args = v.get("args").and_then(Value::as_array).unwrap_or(&no_args);
        if let Err(e) = check_event(channel, args) {
            errors.push(format!("{file}: {e}"));
        }
        1
    } else if v.get("dataBase64").is_some() {
        // Binary ptyData capture (`binary.ptyData.json`): `{id, dataBase64}` —
        // the dump script's stand-in for a raw `ptyData` frame. Prove the id
        // is a string and the payload decodes.
        if tag("id").is_none() {
            errors.push(format!("{file}: binary capture without a string id"));
        } else if tag("dataBase64")
            .and_then(orchestra_rpc_b64_check)
            .is_none()
        {
            errors.push(format!(
                "{file}: binary capture dataBase64 is not valid base64"
            ));
        }
        1
    } else {
        errors.push(format!(
            "{file}: fixture is neither a {{method, params, result}} nor a {{channel, args}} capture"
        ));
        0
    }
}

/// Standalone base64 sanity check (the crate keeps its codec private).
#[allow(clippy::manual_map)]
fn orchestra_rpc_b64_check(s: &str) -> Option<usize> {
    let mut bits = 0u32;
    let mut count = 0usize;
    for &c in s.as_bytes() {
        match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => {
                bits += 6;
                if bits >= 8 {
                    bits -= 8;
                    count += 1;
                }
            }
            b'=' => {}
            c if c.is_ascii_whitespace() => {}
            _ => return None,
        }
    }
    Some(count)
}

#[test]
fn fixtures_conform() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let mut files: Vec<_> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            // manifest.json is dump-run metadata (method list + skip reasons),
            // not a capture. Skipped methods have no fixture by design — their
            // types are coded straight from ipc.ts/types.ts.
            .filter(|p| p.file_name().is_none_or(|n| n != "manifest.json"))
            .collect(),
        Err(_) => Vec::new(),
    };
    files.sort();
    if let Ok(raw) = std::fs::read_to_string(dir.join("manifest.json")) {
        if let Ok(m) = serde_json::from_str::<Value>(&raw) {
            let skipped = m
                .get("skipped")
                .and_then(Value::as_object)
                .map(|o| o.len())
                .unwrap_or(0);
            eprintln!(
                "conformance: manifest lists {skipped} method(s) skipped by the dump \
                 script (no capture — typed from ipc.ts/types.ts directly)"
            );
        }
    }
    if files.is_empty() {
        eprintln!(
            "NOTICE: no fixtures in {} — conformance skipped. \
             A1's scripts/dump-rpc-fixtures.ts generates them; the verifier \
             runs this rig on the combined branches.",
            dir.display()
        );
        return;
    }
    let mut errors = Vec::new();
    let mut checked = 0usize;
    for path in &files {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                errors.push(format!("{name}: unreadable: {e}"));
                continue;
            }
        };
        match serde_json::from_str::<Value>(&raw) {
            Ok(v) => checked += check_fixture(&v, &name, &mut errors),
            Err(e) => errors.push(format!("{name}: invalid JSON: {e}")),
        }
    }
    eprintln!(
        "conformance: {checked} fixture capture(s) across {} file(s)",
        files.len()
    );
    assert!(
        errors.is_empty(),
        "{} conformance failure(s):\n{}",
        errors.len(),
        errors.join("\n")
    );
}

// ---------------------------------------------------------------------------
// Rig self-test: the machinery must work even while the fixtures dir is empty,
// so feed it synthetic captures shaped like A1's output.

#[test]
fn rig_accepts_representative_synthetic_fixtures() {
    let samples = serde_json::json!([
        {
            "method": "listWorkspaces",
            "params": [],
            "result": [{
                "id": "ws-1", "name": "repo · branch", "kind": "worktree",
                "repoPath": "/r", "worktreePath": "/w", "branch": "b",
                "baseBranch": "main", "createdAt": 1752854400000i64,
                "status": "running", "agent": "claude",
                "host": {"kind": "sandbox", "endpoint": "ws://h:8787"},
                "queuedPrompts": [{"id": "q1", "text": "hi", "queuedAt": 1752854400001i64}],
                "setupStatus": "ok", "unpushedAhead": 2, "contextTokens": 91000,
                "aFieldFromTheFuture": {"ignored": true}
            }]
        },
        {
            "method": "getAllAccountUsage",
            "params": [],
            "result": {
                "acc-1": {
                    "accountId": "acc-1", "ok": true,
                    "data": {
                        "fiveHour": {"utilization": 42.5, "resetsAt": "2026-07-18T12:00:00Z"},
                        "sevenDay": {"utilization": 91, "resetsAt": ""},
                        "extraUtilization": null,
                        "fable": {"utilization": 12, "resetsAt": "2026-07-19T00:00:00Z"}
                    },
                    "errorKind": null, "errorMessage": null,
                    "fetchedAt": 1752854400000i64
                },
                "acc-2": {
                    "accountId": "acc-2", "ok": false, "data": null,
                    "errorKind": "not-logged-in", "errorMessage": "run login",
                    "fetchedAt": 0, "expired": true
                }
            }
        },
        {
            "method": "sampleResources",
            "params": [],
            "result": {
                "at": 1752854400000i64, "cpuCores": 10, "memTotalBytes": 17179869184u64,
                "sessions": [{
                    "ptyId": "ws-1:run", "workspaceId": "ws-1", "kind": "run",
                    "remote": false, "cpuPct": 12.5, "memBytes": 1048576,
                    "procCount": 3,
                    "processes": [{"pid": 4242, "comm": "node", "cpuPct": 1.5, "memBytes": 524288}]
                }],
                "app": [{"type": "GPU", "pid": 99, "cpuPct": 0.5, "memBytes": 4096}],
                "disk": {"scratchBytes": 100, "logsBytes": null, "backupsBytes": 5,
                          "eventsBytes": 0, "measuredAt": 1752854400000i64}
            }
        },
        {"method": "ptyResize", "params": ["ws-1", 120, 40], "result": null},
        {"method": "deps:status", "params": [],
         "result": {"git": true, "gh": false, "claude": true, "messages": ["gh missing"]}},
        {"channel": "workspaceRemoved", "args": ["ws-1"]},
        {"channel": "agentTool", "args": ["ws-1", null]},
        {"channel": "usageUpdate", "args": [{
            "fiveHour": {"utilization": 10, "resetsAt": "2026-07-18T12:00:00Z"},
            "sevenDay": {"utilization": 20, "resetsAt": "2026-07-20T12:00:00Z"},
            "extraUtilization": 3.5, "fable": null,
            "fetchedAt": 1752854400000i64
        }]},
        {"channel": "uiNotify", "args": [{
            "wsId": "ws-1", "kind": "needsInput", "title": "t", "body": "b"
        }]}
    ]);
    let mut errors = Vec::new();
    let checked = check_fixture(&samples, "synthetic", &mut errors);
    assert_eq!(checked, 9);
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}

#[test]
fn rig_rejects_drift() {
    let mut errors = Vec::new();
    // Unknown enum literal must fail, proving the rig actually gates.
    check_fixture(
        &serde_json::json!({"channel": "workspaceUpdate", "args": [{
            "id": "x", "name": "n", "repoPath": "/r", "worktreePath": "/w",
            "branch": "b", "baseBranch": "m", "createdAt": 1,
            "status": "hibernating", "agent": "claude"
        }]}),
        "synthetic",
        &mut errors,
    );
    assert_eq!(
        errors.len(),
        1,
        "unknown status literal must be a conformance failure"
    );
}
