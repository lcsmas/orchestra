# Issue #176 — root-cause the metarepo init hang under burst spawn

**Status: VERDICT (final; LEAD-ruled seq 1372).** The blocking-init mechanism the ticket
premises — *"`system/init` emits only AFTER MCP connect, so a slow/contended MCP
connect wedges init"* — is **NOT present in the CLI the incident actually ran**
(`claude` 2.1.278). Across 30 burst sessions on a real metarepo worktree with the
full MCP set — 24 in `-p` mode (incl. one burst under saturating CPU load) and 6
in the SDK's exact streaming-input mode — the hang reproduced **0/30**. Init is
decoupled from MCP connect in this CLI (init fires with servers still `pending`).
The incident is
therefore either an **environmental/transient event** (a startup network stall on
the shared `api.anthropic.com` connector fetch under a 6× simultaneous burst) or a
condition specific to Orchestra's **SDK-query/keeper spawn path** that a plain
`claude -p` rig does not exercise. Ownership: **claude-CLI/MCP-side or
transient-network, NOT a fixable Orchestra spawn-env defect** on current evidence.

Rig, data and per-phase traces below. Boot-throttle (work item 3) SKIPPED per
LEAD ruling — it cannot prevent the observed class (§6). Residual closed
UNREPRODUCED with two ordered candidates (§7); coordinator raw logs did not
arrive within the pass.

---

## 1. Subject profile (metarepo = `/home/lmas/dev/metarepo`)

- **CLAUDE.md preload**: 8273 bytes (+ CONTRIBUTING.md 8.1K, MCP.md 6.0K,
  PLAN.md 40.4K, SKILLS.md 9.7K — but only CLAUDE.md is auto-preloaded).
- **MCP set resolved for a metarepo session under the `mc` account**
  (`CLAUDE_CONFIG_DIR=~/.claude-mc`), confirmed live from a session's `system/init`
  event:

  | server | source | transport | note |
  |---|---|---|---|
  | chrome-devtools | user (`.claude-mc/.claude.json`) | stdio | wrapper → `npx chrome-devtools-mcp@latest` → **launches Chromium** against shared profile `~/.config/chrome-devtools-mcp-profile` |
  | linear-server | user | http | `https://mcp.linear.app/mcp` |
  | datadog-mcp | user | http | `https://mcp.datadoghq.eu/...` |
  | metarepo-knowledge | project (`.mcp.json`) | stdio | `npx -y @modelcontextprotocol/server-filesystem .` (npm-cached, no fetch) |
  | claude.ai Claude Docs / Notion / Slack | claudeai | http | discovered via `GET api.anthropic.com/v1/mcp_servers` at startup |
  | claude.ai Google Drive | claudeai | http | `disabled` |
  | browser | SDK-injected | in-process | Orchestra's `buildBrowserToolServer`, no subprocess |

- **One session init spawns**: the `claude` node process; on first tool-ready it
  may spawn `npx` for the two stdio servers. chrome-devtools does spawn a
  Chromium subprocess, but it connects and closes cleanly (see §4).

## 2. The incident (from `~/.orchestra/logs/orchestra.log`, 2026-09-21 13:41)

- 6 metarepo workspaces created in a 12 s window (13:41:36→48): rapid-canyon,
  humble-comet, noble-willow, swift-orca, brave-ember, solar-cedar.
- Each fired `agent-sdk: getContextUsage timed out` ~2–4 s after create.
- **No `system/init`** anywhere for the wedged sessions; no first stream message.
- 13:44:36→49 all 5 burst workspaces deleted (the wedged ones).
- **CLI binary at incident time = 2.1.278**, installed 2026-09-20 17:59
  (`~/.local/share/claude/versions/`), i.e. the *same* binary this rig runs.
  → The "older blocking CLI" hypothesis is **refuted**: no CLI update happened
  between incident and repro.

`getContextUsage timed out` is a 3 s SDK probe (`agent-sdk.ts:2050`) — a
*symptom* of "no init yet", not the cause.

## 3. Rig (isolated, `ORCHESTRA_HOME=/tmp/<ws-id>/…`, never live state)

Scratch dir `/tmp/8e378798-bc5e-49ca-bbe2-2afb6433f023/` (NOT committed):
`run_one.sh` launches one `claude -p "hi" --model haiku --output-format
stream-json --verbose --debug-file …` with **cwd = a read-only metarepo worktree**
(`git worktree add --detach`) and `CLAUDE_CONFIG_DIR=~/.claude-mc`, polls the
stream for the `system/init` line, snapshots the `ps --forest` tree, then kills.
`burst.sh N MODE` fires N concurrently, `nice -n 1`. Instrument validated: init
emits with the full 7-server set and `metarepo-knowledge` connected.

## 4. Results — the hang does NOT reproduce on 2.1.278

**Init-time distribution (seconds to `system/init`):**

| run | N | mode | min | max | mean | wedged |
|---|---|---|---|---|---|---|
| single | 1 | `-p` | 2.5 | 4.0 | — | 0 |
| burstA | 6 | `-p` | 3.0 | 5.0 | 4.1 | 0 |
| burstB | 6 | `-p` | 3.5 | 5.5 | 4.8 | 0 |
| burstC | 6 | `-p` | 4.0 | 6.0 | 5.3 | 0 |
| burstLOAD (10 busy-loops on 10 cores) | 6 | `-p` | 3.0 | 5.0 | 3.9 | 0 |
| streamburst (**SDK-exact flags**) | 6 | streaming-input | 2.0 | 3.5 | 2.9 | 0 |
| **TOTAL** | **30** | — | **2.0** | **6.0** | — | **0/30** |

The streaming-input arm matters because Orchestra does NOT spawn `claude -p`; the
SDK (`claude-agent-sdk` 0.3.241, `sdk.mjs`) builds argv as
`--output-format stream-json --verbose --input-format stream-json …` and drives a
long-lived streaming session behind the keeper. Running the rig with those exact
flags removes the "`-p` vs streaming" caveat — still **0/6 wedged**.

**Non-vacuous proof init is decoupled from MCP connect** (streamburst sess1
`system/init`, emitted at 3.0 s):

```
chrome-devtools = connected      metarepo-knowledge   = connected
linear-server   = pending        claude.ai Claude Docs = connected
datadog-mcp     = connected      claude.ai Notion      = pending
```

init fired with the full metarepo MCP set while `linear-server` and `claude.ai
Notion` were still **`pending`** — direct evidence a not-yet-connected server does
not gate init. Same debug line as the `-p` arms: `[MCP] … running fully async
(nonblocking)`.

**Why it can't wedge — the decisive trace (`debug.log`):**

```
[STARTUP] MCP configs resolved in 60ms (awaited at +152ms)
[MCP] --mcp-config servers running fully async (nonblocking)
[MCP] claude.ai connectors running fully async (nonblocking)
MCP server "chrome-devtools": Starting connection with timeout of 30000ms
… (init emits here, ~3–5s) …
MCP server "chrome-devtools": Successfully connected (transport: stdio) in 1509ms
```

- **Controlled must-block arm**: a stdio MCP server that `sleep 600`s
  (`--strict-mcp-config --mcp-config hang.json`). Its connection times out at
  **30 004 ms** — yet `system/init` **still emitted**, with that server marked
  `status:"failed"`. Proves init does not await MCP connect in 2.1.278.
- chrome-devtools connects (~1.5–2.8 s) and closes cleanly under N=6; no
  profile-`SingletonLock` deadlock observed.
- A real contention point exists but is **non-fatal and non-blocking**:
  `NON-FATAL: Lock acquisition failed for …/versions/2.1.278 … Lock already held
  by another process` fired in **all 6** burst sessions, and all 6 still inited
  (ripgrep test PASSED immediately after). Two startup network calls
  (`Failed to fetch Grove settings` 3 s, `Failed to fetch MCP registry` 5 s) also
  time out non-fatally.

## 5. Verdict

- **Blocking component**: none, in the CLI that ran the incident. `system/init`
  is emitted before/independently of every MCP connect (`--mcp-config` servers
  and claude.ai connectors both logged `running fully async (nonblocking)`), so
  no MCP server — stdio or http, fast or hung — can gate init in 2.1.278.
- **Single vs burst**: burst adds ~2 s mean boot latency (version-dir lock +
  npm/ripgrep + the shared `api.anthropic.com/v1/mcp_servers` connector fetch)
  but never wedges. Load-independent (burstLOAD = burstA).
- **Ownership**: NOT an Orchestra spawn-env defect reproducible here. The
  residual candidates, in order of likelihood:
  1. **Transient network stall** on the startup `GET api.anthropic.com/v1/mcp_servers`
     (the one call that fans the claude.ai connectors) — 6 sessions hit the same
     endpoint with the same account token within one second; a rate-limit/stall
     there at 13:41 would delay connector setup. Environmental, not
     deterministically reproducible.
  2. A wedge specific to the **SDK-query/keeper** spawn path (Orchestra drives
     `query()` via the detached keeper, not `claude -p`) — an axis this rig does
     not cover. Needs the coordinator's raw session logs (§7) to confirm/deny.

**A false cause I discarded mid-investigation** (recorded so the next diagnoser
does not re-chase it): "older CLI blocked init on MCP connect." Refuted by the
binary mtime — 2.1.278 was installed the day *before* the incident and is what
both the incident and this rig ran.

## 6. Product boot-throttle (work item 3) — NOT built (LEAD ruling)

**Decision: SKIP — not built, neither as cure nor belt-and-braces.**
LEAD ruling 2026-09-21 (bus seq 1372).

**Reason: it cannot prevent the observed class of failure.** The measured penalty
of concurrency is small (**N=6 burst mean 4.5 s vs N=1 ~3 s**, p-max 6.0 s) and
the wedge reproduced **0/30 under concurrency + CPU saturation**. A throttle only
shaves the ~2 s burst tail; it does nothing against the residual causes (transient
connector-fetch stall / keeper path), which are not concurrency-contention here. A
guard with no measurable line it excludes is the belt-and-braces anti-pattern, so
it is not added as a safety net either.

- The right layer for a transient/non-deterministic boot wedge is the shipped
  **#174 proof-of-life self-heal**, which converts a wedged boot into an automatic
  recycle. That is also the ticket's own acceptance tripwire.
- (Recorded for completeness, NOT actioned: were a throttle ever justified by a
  measured wedge, it would gate at K=3–4 concurrent boots with instant pass below
  K so the single-spawn path is untouched.)

## 7. Close-out — residual UNREPRODUCED, two ordered candidates

Per LEAD ruling (seq 1372) point 3: the coordinator's raw logs (requested from
ws 36773f53, bus seq 1368) **did not arrive within this pass**, so the residual is
closed **UNREPRODUCED**, with the two candidates ordered and the discriminant each
future incident should apply:

**Residual cause — UNREPRODUCED (0/30 in the rig). Ordered candidates:**

1. **Transient startup connector-fetch stall** (most likely). The one startup call
   that is external, shared and per-session is `GET api.anthropic.com/v1/mcp_servers`
   (fans the claude.ai connectors). 6 sessions hit it with the same account token
   within ~1 s; a rate-limit/stall there at 13:41 would delay connector setup.
   **Discriminant**: fresh logs show the CLI reached `[claudeai-mcp] Fetching …`
   and that fetch never returned (vs `Fetched N servers`).
2. **Keeper / SDK-query spawn path.** Orchestra drives a long-lived streaming
   session behind the detached keeper, not `claude -p`. The rig covered the CLI's
   own flags (streaming-input, 0/6) but not the keeper wrapper.
   **Discriminant**: fresh logs show `claude` spawned but produced no stdout at all
   (process-level wedge before `setup()`), vs the CLI running normally with a stuck
   fetch (candidate 1).

**Field tripwire (already the ticket's acceptance):** the **#174 heal counters**
(recycle events on metarepo bursts). A future metarepo wedge reopens candidate 2
WITH fresh logs. With no deterministic repro today, the honest close is: the
**#174 resilience already dormant-izes the symptom; no Orchestra-side code change
is warranted by the evidence.**
