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

## 8. Post-close addendum — the coordinator's answer arrived after close-out

The raw-log request (§7) was answered by ws 36773f53 AFTER the investigation
closed (bus seq 1376, 2026-09-21; integrated by the LEAD — the investigator
workspace was already released). Three facts, none overturning the verdict,
two sharpening it:

1. **No per-session logs exist for the wedged six.** The spawns are headless;
   no `<id>.log` / `<id>:run.log` was ever created, and the workspaces were
   deleted 13:44:36–49 — only `orchestra.log(.1)` survives. The §7 discriminants
   therefore need artifacts that do not exist for THIS incident: an
   OBSERVABILITY GAP (a wedged headless session leaves nothing to autopsy),
   filed as its own ticket (#177).
2. **`getContextUsage timed out` is a NOISY symptom, not a discriminant**: 383
   occurrences across multiple days in the surviving log, including ESTABLISHED
   sessions outside any burst (36773f53 itself at 11:34:26). Consistent with
   the 0/30 non-repro — the timeout alone must never be read as "boot wedge";
   only the #174 predicate (no first message + silent since spawn) is.
3. **Zero retry datapoints**: the five wedged sessions were deleted without any
   relaunch attempt (fleet cancelled), so "a retry would have succeeded" —
   the mechanism #174's recycle relies on — was never field-tested in the
   incident itself. The rig's 30/30 clean boots remain the only evidence a
   fresh start succeeds; load context at 13:41: ~30 workspaces in store,
   ~12 sibling agents running, 6 submodule-bearing worktree creations in 12 s.

---

## 9. ROOT CAUSE — PROVEN 2026-09-28 (T2, ledger #198, wave CLI-unresponsive)

**Verdict: the hang is a NETWORK-PATH pathology on TLS connections from this host
to the Anthropic anycast endpoint, NOT an Orchestra spawn-env defect and NOT the
claude-CLI's config.** A subset of TCP connections to `api.anthropic.com`
(`160.79.104.10` v4 / `[2607:6bc0::10]` v6) receive a SYN-ACK advertising the
**minimum MSS (536)**, and the path then **silently drops the CLI's first data
segment** — the ~1504-byte, 2-segment TLS ClientHello — which is **never ACKed**.
The connection is dead from the handshake. The CLI blocks on that dead socket
until an app-level timeout. Reproduced live AND with a code-free control.

### 9.1 The trace (live, 2026-09-28 ~14:00–16:00Z, real fleet running)

Captured with `ss -tnpi` on stuck flows to anthropic. Every stuck flow, no
exception:

```
ESTAB 0 1504  192.168.1.19:57226  160.79.104.10:443  users:(("claude",pid=402443,fd=27))
  rcvmss:536  bytes_sent:1504  bytes_acked:1  data_segs_out:2  unacked:2
  retrans:0/5  rto:15687   (RTO backed off 15.7 s after 5 retransmits)
```

- `bytes_acked:1` = only the SYN's phantom byte ACKed; **0 bytes of the 1504-byte
  ClientHello were ever ACKed** (`data_segs_out:2`, `unacked:2`).
- `rcvmss:536` = the peer's SYN-ACK offered MSS 536 (TCP minimum). Healthy flows
  to the **same IP** get `rcvmss:1448`.
- The host's own `advmss` is 1448 and it routes over clean WiFi (`wlp1s0f0`,
  MTU 1500, `via 192.168.1.1`); **NOT** the tailscale tunnel (tailscale0 MTU 1280
  carries no anthropic traffic). The host has **no MSS-clamp rule** (`iptables
  mangle` / `nft` clean). So the 536 clamp originates **upstream of this host** —
  ISP path or the anthropic edge/anycast — not from anything we control.

**The MSS-536 SYN-ACK deterministically predicts the black hole** (cross-tab over
one 100-flow snapshot):

| | `rcvmss:536` | `rcvmss:1448` |
|---|---|---|
| stuck (`bytes_acked:1`) | **79** | 0 |
| healthy | 0 | **21** |

100 % correlation, zero exceptions. Both v4 and v6 destinations affected (not
protocol-specific — the 09-23 note saw v6, this capture saw both). The stuck
flows clear as the CLI/kernel retransmits or the app times out and reconnects,
which is why the field symptom is a *bounded* stall (188 s turn-retry on CLI
≥2.1.280, or the ~600 s init-request API timeout) rather than a permanent hang.

### 9.2 The code-free positive control (isolates the path, exonerates the CLI)

40 parallel plain `curl -X POST https://api.anthropic.com/v1/messages` — no
Orchestra, no claude-CLI, no MCP — fired in one burst:

```
35 / 40 flows → rcvmss:536 + bytes_acked:1  (stuck at ClientHello)
19 / 40 flows → rcvmss:1448                 (healthy)
```

The pathology reproduces with a client that shares **none** of the code under
suspicion. This is the decisive exoneration: the black hole is a property of the
**network path under connection burst**, triggered by opening many TLS
connections to the anycast endpoint at once. Orchestra's fleet (many CLIs each
opening several connectors near-simultaneously) is a *victim* of it, not a cause;
a single lucky connection is enough to make one session boot fine while its
sibling in the same 2 s window wedges — exactly the observed synchronized-burst
wedge (e.g. 5 sessions at 11:10:30–33Z, 2026-09-28).

### 9.3 D5 (ledger's test-first hypothesis) — REFUTED

**Does resume/init time scale with transcript size? NO.** Isolated rig
(`~/init-hang-rig`, throwaway `CLAUDE_CONFIG_DIR`, `--fork-session --resume
--strict-mcp-config`, real metarepo worktree cwd, on btrfs) resuming real
metarepo transcripts:

| transcript | size | time to `system/init` |
|---|---|---|
| vivid-canyon | 7 MB | **0.96 s** |
| crimson-horizon (= the 16.5 MB W6b session) | 16 MB | **0.75 s** |
| fuzzy-harbor | 28 MB | **1.00 s** |

Init/resume is **flat at ~1 s across 7→28 MB** — transcript loading is not the
bottleneck (confirms the prior "94 MB resumes in 4 s" note). The multi-second /
multi-minute delay in these same runs lived entirely in the *turn's API request*
(`result` at 88–95 s), which is the §9.1 network stall, not the resume. The
persistent re-wedger `15d02de8` (16.5 MB) is caught more often only because it is
long-lived and keeps sending turns into the congested window, not because its
size slows init.

### 9.4 Ownership & fix

- **Root cause owner: the network path / Anthropic edge** (MSS-536 SYN-ACK +
  data-segment black hole on a fraction of burst connections). File upstream with
  the §9.2 control as the repro. NOT an Orchestra code defect.
- **Why init hangs 600 s while a turn recovers in 188 s** (the one asymmetry we
  *do* own visibility into): the CLI's init-time request lacks the no-response
  retry that the turn request has (`waited_ms:188000` on turns, none at init).
  That is a **claude-CLI** property, filed upstream — Orchestra cannot patch it.
- **Product mitigation already shipped is the correct layer**: #174 proof-of-life
  self-heal + v0.5.285 bounded stop/rewind + #197 bounded boot-heal convert a
  black-holed boot into an automatic recycle whose fresh connections usually miss
  the transient. A boot-concurrency throttle (work item 3) would *reduce* the
  burst that triggers the MSS-536 clamp — this is the one product lever that
  attacks the trigger rather than the symptom, and §9.2 (35/40 stuck under a
  40-wide burst) is the first hard evidence it would help. **Not built here**
  (spec-axis; routed to LEAD via §Open-questions on #198 for a ruling before any
  code).

### 9.5 VERIFIED / NOT VERIFIED

**VERIFIED (literal command beside each):**
- Stuck flows carry `bytes_acked:1` + `rcvmss:536`, 294/294 in the live capture
  (`~/init-hang-rig/stuck-capture.log`); `ss -tnpi | grep -A1 :443`.
- MSS-536 ⟺ stuck, 100 % (79/0, 0/21) — one `ss` snapshot cross-tab.
- Control: 40 parallel `curl` POST → 35/40 stuck with the identical signature.
- D5: 7/16/28 MB resume all init in ~1 s (`~/init-hang-rig/ts-*.tsv`).
- Host routes anthropic over WiFi MTU 1500, no local MSS clamp (`ip route get`,
  `nft list ruleset`).

**NOT VERIFIED:**
- WHICH hop clamps to MSS 536 (ISP vs anthropic edge) — needs a traceroute/tcpdump
  from a second vantage; the control proves it is upstream of this host, not which
  upstream hop.
- That the init-request truly has NO retry in CLI 2.1.280 (inferred from the
  600 s vs 188 s field asymmetry + the turn-only `waited_ms` log; not read from CLI
  source, which is minified).
- Whether a boot throttle empirically drops the wedge rate — proposed, not
  measured end-to-end (would need the throttle built).
