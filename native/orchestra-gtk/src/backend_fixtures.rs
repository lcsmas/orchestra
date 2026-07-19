//! MockBackend fixtures for the B5 surface (Resources / Insights / usage) —
//! serde-built JSON, mirroring what the real backend serves over ui-rpc, so
//! the overlays render real pixels (and E2E has something to screenshot)
//! without any backend. Values animate deterministically off a tick counter
//! so sparklines and traces show life in mock mode.

use serde_json::{json, Value};

/// Fixed "now" for mock data: 2026-07-18 12:00:00 UTC, matching the mock
/// workspaces' created_at era and the usage/self-tune fixture dates below (so
/// reset countdowns and "N ago" strings come out sensibly relative to it).
pub const MOCK_NOW_MS: i64 = 1_784_376_000_000;

/// Deterministic wobble in [0, amp): a couple of incommensurate sawtooths so
/// consecutive ticks differ and sparklines get a believable shape.
fn wobble(tick: u64, seed: u64, amp: f64) -> f64 {
    let phase = ((tick.wrapping_mul(7).wrapping_add(seed * 13)) % 29) as f64 / 29.0;
    let phase2 = ((tick.wrapping_mul(3).wrapping_add(seed * 5)) % 11) as f64 / 11.0;
    (phase * 0.7 + phase2 * 0.3) * amp
}

fn proc(pid: i32, comm: &str, cpu: f64, mem_mb: u64) -> Value {
    json!({ "pid": pid, "comm": comm, "cpuPct": cpu, "memBytes": mem_mb * 1024 * 1024 })
}

/// `sampleResources` result (`ResourceSnapshot`). ws-1 is a hot agent with a
/// run PTY, ws-2 idles, ws-3 is sandbox-hosted (remote — no local footprint),
/// plus one account-login PTY and the app's own processes.
pub fn resource_snapshot(tick: u64) -> Value {
    let hot = 35.0 + wobble(tick, 1, 60.0);
    let warm = 4.0 + wobble(tick, 2, 9.0);
    let run_cpu = 1.0 + wobble(tick, 3, 5.0);
    json!({
        "at": MOCK_NOW_MS + (tick as i64) * 2000,
        "cpuCores": 10,
        "memTotalBytes": 16u64 * 1024 * 1024 * 1024,
        "sessions": [
            {
                "ptyId": "ws-1",
                "workspaceId": "ws-1",
                "kind": "agent",
                "remote": false,
                "cpuPct": hot,
                "memBytes": 780u64 * 1024 * 1024,
                "procCount": 7,
                "processes": [
                    proc(41210, "claude", hot * 0.8, 512),
                    proc(41211, "node", hot * 0.15, 156),
                    proc(41209, "zsh", 0.0, 12),
                    proc(41320, "rg", hot * 0.05, 48),
                    proc(41321, "git", 0.2, 24),
                ],
            },
            {
                "ptyId": "ws-1:run",
                "workspaceId": "ws-1",
                "kind": "run",
                "remote": false,
                "cpuPct": run_cpu,
                "memBytes": 210u64 * 1024 * 1024,
                "procCount": 3,
                "processes": [
                    proc(41400, "node", run_cpu, 180),
                    proc(41401, "esbuild", 0.4, 30),
                ],
            },
            {
                "ptyId": "ws-2",
                "workspaceId": "ws-2",
                "kind": "agent",
                "remote": false,
                "cpuPct": warm,
                "memBytes": 420u64 * 1024 * 1024,
                "procCount": 4,
                "processes": [
                    proc(42100, "claude", warm, 350),
                    proc(42099, "zsh", 0.0, 11),
                ],
            },
            {
                "ptyId": "ws-3",
                "workspaceId": "ws-3",
                "kind": "agent",
                "remote": true,
                "cpuPct": 0.0,
                "memBytes": 0,
                "procCount": 0,
                "processes": [],
            },
            {
                "ptyId": "account-login:mc",
                "workspaceId": null,
                "kind": "login",
                "remote": false,
                "cpuPct": 0.3,
                "memBytes": 96u64 * 1024 * 1024,
                "procCount": 2,
                "processes": [proc(43000, "claude", 0.3, 96)],
            },
        ],
        "app": [
            { "type": "Browser", "pid": 40001, "cpuPct": 2.1 + wobble(tick, 4, 3.0), "memBytes": 310u64 * 1024 * 1024 },
            { "type": "Tab", "pid": 40002, "cpuPct": 1.2 + wobble(tick, 5, 2.0), "memBytes": 480u64 * 1024 * 1024 },
            { "type": "GPU", "pid": 40003, "cpuPct": 0.6, "memBytes": 120u64 * 1024 * 1024 },
        ],
        "disk": {
            "scratchBytes": 3_400_000_000u64,
            "logsBytes": 260_000_000u64,
            "backupsBytes": 1_100_000_000u64,
            "eventsBytes": 4_200_000u64,
            "measuredAt": MOCK_NOW_MS - 42_000,
        },
    })
}

/// `getWorktreeSizes` result (`WorktreeSizes`).
pub fn worktree_sizes() -> Value {
    json!({
        "sizes": {
            "ws-1": 210_000_000u64,
            "ws-2": 1_400_000_000u64,
            "ws-3": 48_000_000u64,
            "ws-4": 3_200_000_000u64,
            "ws-5": 12_000_000u64,
        },
        "exclusive": true,
    })
}

/// `listAccounts` result.
pub fn accounts() -> Value {
    json!([
        { "id": "mc", "label": "mc", "configDir": "~/.claude-mc" },
        { "id": "perso", "label": "perso", "configDir": "~/.claude-perso" },
    ])
}

/// `getUsage` result — the default login's snapshot.
pub fn global_usage() -> Value {
    json!({
        "fiveHour": { "utilization": 62.0, "resetsAt": "2026-07-18T14:00:00.000Z" },
        "sevenDay": { "utilization": 41.0, "resetsAt": "2026-07-21T09:00:00.000Z" },
        "fable": { "utilization": 78.0, "resetsAt": "2026-07-21T09:00:00.000Z" },
        "extraUtilization": 12.0,
        "fetchedAt": MOCK_NOW_MS - 90_000,
    })
}

/// `getAllAccountUsage` result: `mc` is hot (91% five-hour → sorts first and
/// exercises the red severity tier), `perso` is an expired login (error path).
pub fn account_usage() -> Value {
    json!({
        "mc": {
            "accountId": "mc",
            "ok": true,
            "data": {
                "fiveHour": { "utilization": 91.0, "resetsAt": "2026-07-18T13:20:00.000Z" },
                "sevenDay": { "utilization": 77.5, "resetsAt": "2026-07-20T22:00:00.000Z" },
                "extraUtilization": null,
                "fable": { "utilization": 34.0, "resetsAt": "2026-07-20T22:00:00.000Z" },
            },
            "errorKind": null,
            "errorMessage": null,
            "fetchedAt": MOCK_NOW_MS - 150_000,
        },
        "perso": {
            "accountId": "perso",
            "ok": false,
            "data": null,
            "errorKind": "not-logged-in",
            "errorMessage": "no OAuth token",
            "fetchedAt": MOCK_NOW_MS - 400_000,
            "expired": true,
        },
    })
}

/// `getWorkspaceAccounts` result: ws-1 pinned to mc, the rest default login.
pub fn workspace_accounts() -> Value {
    json!({
        "ws-1": { "workspaceId": "ws-1", "accountId": "mc", "label": "mc" },
        "ws-2": { "workspaceId": "ws-2", "accountId": null, "label": "default" },
        "ws-3": { "workspaceId": "ws-3", "accountId": null, "label": "default" },
    })
}

const LESSON_ADDED_1: &str =
    "[2026-07-15] Verify the harness's own wait logic before blaming the target under test.";
const LESSON_ADDED_2: &str =
    "[2026-07-15] Rebuild the artifact you are about to execute after checking out a commit.";

/// `listSelfTuneRuns` result: newest-first history — one ok run with a
/// lessons diff, one failed run.
pub fn self_tune_runs() -> Value {
    json!([
        {
            "id": "run-2026-07-15",
            "trigger": "auto",
            "status": "ok",
            "startedAt": MOCK_NOW_MS - 3 * 86_400_000,
            "finishedAt": MOCK_NOW_MS - 3 * 86_400_000 + 312_000,
            "steps": [
                {
                    "id": "insights:default", "kind": "insights", "loginId": "default",
                    "label": "default", "configDir": "~/.claude", "status": "ok",
                    "startedAt": MOCK_NOW_MS - 3 * 86_400_000,
                    "finishedAt": MOCK_NOW_MS - 3 * 86_400_000 + 121_000,
                },
                {
                    "id": "insights:mc", "kind": "insights", "loginId": "mc",
                    "label": "mc", "configDir": "~/.claude-mc", "status": "ok",
                    "startedAt": MOCK_NOW_MS - 3 * 86_400_000 + 121_000,
                    "finishedAt": MOCK_NOW_MS - 3 * 86_400_000 + 227_000,
                },
                {
                    "id": "fold", "kind": "fold", "loginId": "default",
                    "label": "fold", "configDir": "~/.claude", "status": "ok",
                    "startedAt": MOCK_NOW_MS - 3 * 86_400_000 + 227_000,
                    "finishedAt": MOCK_NOW_MS - 3 * 86_400_000 + 312_000,
                },
            ],
            "summary": "2 lessons added",
            "lessons": {
                "added": [LESSON_ADDED_1, LESSON_ADDED_2],
                "removed": ["[2026-05-02] Stale bullet reworded away by the fold."],
                "total": 31,
            },
        },
        {
            "id": "run-2026-06-12",
            "trigger": "manual",
            "status": "failed",
            "startedAt": MOCK_NOW_MS - 36 * 86_400_000,
            "finishedAt": MOCK_NOW_MS - 36 * 86_400_000 + 45_000,
            "steps": [
                {
                    "id": "insights:default", "kind": "insights", "loginId": "default",
                    "label": "default", "configDir": "~/.claude", "status": "failed",
                    "startedAt": MOCK_NOW_MS - 36 * 86_400_000,
                    "finishedAt": MOCK_NOW_MS - 36 * 86_400_000 + 45_000,
                    "exitCode": 1,
                },
                {
                    "id": "fold", "kind": "fold", "loginId": "default",
                    "label": "fold", "configDir": "~/.claude", "status": "failed",
                    "error": "insights step failed",
                },
            ],
            "summary": null,
            "lessons": null,
        },
    ])
}

/// `getSelfTuneOutput` result — a canned transcript tail.
pub fn self_tune_output(run_id: &str) -> Value {
    json!(format!(
        "[{run_id}] $ claude -p \"/insights\" --dangerously-skip-permissions\n\
         Regenerating usage report for login 'default'…\n\
         Report written: ~/.claude/usage-data/report-2026-07-15-093010.html\n\
         [{run_id}] fold pass: distilling lessons across 2 logins…\n\
         Deduplicated 3 candidate lessons → 2 new bullets.\n\
         SELF-TUNE-RESULT: 2 lessons added\n"
    ))
}

/// `listSelfTuneReports` result: default has a report, `perso` never ran.
pub fn self_tune_reports() -> Value {
    json!([
        {
            "loginId": "default", "label": "default", "configDir": "~/.claude",
            "reportPath": "/home/user/.claude/usage-data/report-2026-07-15-093010.html",
        },
        {
            "loginId": "mc", "label": "mc", "configDir": "~/.claude-mc",
            "reportPath": "/home/user/.claude-mc/usage-data/report-2026-07-15-101502.html",
        },
        { "loginId": "perso", "label": "perso", "configDir": "~/.claude-perso", "reportPath": null },
    ])
}

/// `readSelfTuneLessons` result — includes the newest run's added bullets so
/// the "N new" highlighting has something to match.
pub fn lessons_md() -> Value {
    json!(format!(
        "# Lessons (auto-curated by /retro — keep under ~30 bullets, one line each)\n\
         \n\
         - [2026-05-11] Always use absolute paths in Bash commands; cwd resets between calls.\n\
         - [2026-06-02] Reserve clarifying questions for genuine scope ambiguity.\n\
         - {LESSON_ADDED_1}\n\
         - {LESSON_ADDED_2}\n"
    ))
}

/// A fake in-flight run for `startSelfTune`: returns the `running` record
/// plus the step-by-step updates and transcript chunks a streaming thread
/// replays over a few seconds (`selfTuneUpdate` / `selfTuneOutput` events).
pub fn fake_run_script(started_at: i64) -> (Value, Vec<(u64, String, Vec<Value>)>) {
    let run_id = "run-manual-mock";
    let step = |kind: &str, login: &str, status: &str| {
        let id = if kind == "fold" {
            "fold".to_string()
        } else {
            format!("insights:{login}")
        };
        json!({
            "id": id, "kind": kind, "loginId": login,
            "label": if kind == "fold" { "fold" } else { login },
            "configDir": if login == "mc" { "~/.claude-mc" } else { "~/.claude" },
            "status": status,
        })
    };
    let run = |s1: &str, s2: &str, s3: &str, status: &str, summary: Option<&str>| {
        json!({
            "id": run_id,
            "trigger": "manual",
            "status": status,
            "startedAt": started_at,
            "finishedAt": if status == "running" { Value::Null } else { json!(started_at + 6_000) },
            "steps": [
                step("insights", "default", s1),
                step("insights", "mc", s2),
                step("fold", "default", s3),
            ],
            "summary": summary,
        })
    };
    let initial = run("running", "pending", "pending", "running", None);
    let updates = vec![
        (
            600,
            "selfTuneOutput".to_string(),
            vec![json!(run_id), json!("$ claude -p \"/insights\" (login: default)\n")],
        ),
        (
            1200,
            "selfTuneOutput".to_string(),
            vec![json!(run_id), json!("Report written: report-2026-07-18-120001.html\n")],
        ),
        (
            1400,
            "selfTuneUpdate".to_string(),
            vec![run("ok", "running", "pending", "running", None)],
        ),
        (
            2200,
            "selfTuneOutput".to_string(),
            vec![json!(run_id), json!("$ claude -p \"/insights\" (login: mc)\n")],
        ),
        (
            3000,
            "selfTuneUpdate".to_string(),
            vec![run("ok", "ok", "running", "running", None)],
        ),
        (
            3600,
            "selfTuneOutput".to_string(),
            vec![json!(run_id), json!("fold pass: distilling lessons…\nSELF-TUNE-RESULT: 1 lesson added\n")],
        ),
        (
            4200,
            "selfTuneUpdate".to_string(),
            vec![run("ok", "ok", "ok", "ok", Some("1 lesson added"))],
        ),
    ];
    (initial, updates)
}
