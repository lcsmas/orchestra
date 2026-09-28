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

## 9. ROOT CAUSE — 2026-09-28 (T2, ledger #198, wave CLI-unresponsive)

> **This section was amended after an initial over-claim was caught (LEAD D8).**
> The first draft claimed a code-free `curl` control reproduced the stall 35/40;
> that was a **measurement error** — the `ss` snapshot captured the live *fleet's*
> `claude` sockets, not the curls, which actually all succeeded. The corrected
> control below (a concurrent burst of pure Node TLS handshakes) is the real
> reproduction. The corrected verdict is narrower and honest about what is proven.

**Verdict: the hang is a transient, CONCURRENCY-TRIGGERED network-path pathology
on the *anthropic* path — a fraction of simultaneously-opened TLS connections to
`api.anthropic.com` are black-holed at the handshake (SYN-ACK advertises the
minimum MSS 536, then the ClientHello data is never ACKed, `bytes_acked:1`). It is
NOT an Orchestra spawn-env defect and NOT the claude-CLI's config: it reproduces
with a pure Node TLS client that shares none of that code. Serial connections
succeed; only bursts stall, and only in intermittent windows.**

### 9.1 The signature (live fleet, 2026-09-28)

Every stuck flow to anthropic, no exception, carries this `ss -tnpi` signature:

```
ESTAB 0 1504  192.168.1.19:57226  160.79.104.10:443  users:(("claude",pid=402443,fd=27))
  rcvmss:536  bytes_sent:1504  bytes_acked:1  data_segs_out:2  unacked:2  retrans:0/5  rto:15687
```

- `bytes_acked:1` = only the SYN's phantom byte ACKed; **0 bytes of the ClientHello
  ACKed**; the socket retransmits with RTO backing off (5 retrans → 15.7 s).
- `rcvmss:536` = the peer's SYN-ACK offered MSS 536 (TCP minimum). Healthy flows to
  the **same IP** get `rcvmss:1448`.

**`rcvmss:536 ⟺ stuck` is 100 %** across the captures:
- live `claude` fleet flows: 293/293 stuck flows `rcvmss:536`;
- my own Node-probe flows (§9.2): 4/4 stuck `rcvmss:536`, 0 healthy flows at 536.

Both IPv4 (`160.79.104.10`) and IPv6 (`[2607:6bc0::10]`) destinations are affected.

### 9.2 The corrected code-free control (Node TLS burst)

Pure `node:tls` handshakes — no Orchestra, no claude-CLI, no MCP
(`~/init-hang-rig/burst-probe.mjs`, `interleave.mjs`; kept out of tree):

1. **Serial vs burst is the discriminator, not the client.** 40 *serial* `curl`
   POSTs → **40/40 HTTP 401** (all TLS handshakes complete, appconnect ~0.03–0.08 s):
   **no stall**. A *concurrent burst* of 40+ Node TLS handshakes → **~40 % TIMEOUT
   in a stall window** (e.g. one run: v4-big 12/30, v4-small 10/30, v6-big 12/30,
   v6-small 9/30 timed out at 15 s).
2. **NOT specific to the 2-segment "big" ClientHello.** Small ClientHellos time
   out at nearly the same rate as ALPN-padded 2-segment ones (10 vs 12 on v4). The
   first draft's emphasis on the 1504-byte 2-segment ClientHello as the trigger is
   **not supported** — payload size is not the axis; concurrency is.
3. **It is INTERMITTENT.** Most burst rounds return 0/40 for minutes at a time; the
   stall appears in windows. Field ceiling (188 s turn-retry / ~600 s init) matches
   a transient that clears as sockets retransmit or the app times out and reconnects.

### 9.3 Localization — anthropic-path specific, not the local box

Interleaved control (`interleave.mjs`): each round fires a 40-burst at
`api.anthropic.com` AND at `cloudflare.com` back-to-back, same instant. A local
SYN-proxy / anti-flood middlebox would clamp/black-hole BOTH equally. Observed:

```
round  7: anthropic_fail=4/40   cloudflare_fail=0/40
round 11: anthropic_fail=2/40   cloudflare_fail=0/40
(cloudflare: 0/40 in every one of 21+ rounds; anthropic stalls in ~2 rounds/window)
```

In a stall window, anthropic stalls while cloudflare (identical concurrent load,
same moment) does not → the clamp is on the **anthropic path** (their edge/anycast
or a peering hop toward it), not a generic local box. Corroborating: the host has
**no local MSS-clamp rule** (`nft list ruleset`, `iptables -t mangle` clean) and
routes anthropic over clean WiFi (`wlp1s0f0`, MTU 1500, `via 192.168.1.1`), NOT
the tailscale tunnel (tailscale0 MTU 1280 carries no anthropic traffic). So the
MSS-536 originates upstream of this host, on the anthropic-specific path.

### 9.4 D5 (ledger's test-first hypothesis) — REFUTED

**Does resume/init time scale with transcript size? NO.** Isolated rig
(`~/init-hang-rig`, throwaway `CLAUDE_CONFIG_DIR`, `--fork-session --resume
--strict-mcp-config`, real metarepo worktree cwd, on btrfs) resuming real
transcripts: 7 MB → init@**0.96 s**, 16 MB (= the 16.5 MB W6b session) →
**0.75 s**, 28 MB → **1.00 s**. Init/resume is **flat ~1 s across 7→28 MB**; the
multi-minute delay in those same runs lived entirely in the turn's API request
(`result` at 88–95 s = the §9.1 network stall). Confirms the prior "94 MB in 4 s".

### 9.5 Ownership & fix

- **Root-cause owner: the anthropic network path** (MSS-536 SYN-ACK +
  data-segment black hole on a fraction of *burst* connections). File upstream
  with the §9.2/§9.3 Node repro. NOT an Orchestra code defect.
- **Init 600 s vs turn 188 s asymmetry** (the one CLI-side lever): the CLI's
  init-time request appears to lack the no-response retry the turn request has
  (`waited_ms:188000` on turns, none observed at init). Filed upstream — not
  Orchestra-patchable. (Inferred from field timing, not CLI source — see NOT
  VERIFIED.)
- **Product mitigation (D7 = A, ruled): BUILD a boot-concurrency throttle.**
  §9.2 proves the trigger is *concurrency*: serial succeeds, burst stalls. A
  throttle that caps simultaneous opening-turn boots directly shrinks the burst
  that provokes the clamp — the one product lever that attacks the trigger, not
  just the symptom. The shipped #174 self-heal + v0.5.285 bounded stop/rewind +
  #197 bounded boot-heal remain the recovery layer for whatever still slips
  through. (Throttle tracked as T2 code, seam `agent-sdk.ts`.)

### 9.6 VERIFIED / NOT VERIFIED

**VERIFIED (literal command / artifact beside each):**
- `rcvmss:536 ⟺ stuck (bytes_acked:1)`, 100 %: 293/293 live claude flows + 4/4
  Node-probe flows (`ss -tnpi | grep -A1 :443`; `~/init-hang-rig/stuck-capture.log`).
- Serial curl 40/40 OK (no stall); concurrent Node TLS burst ~40 % timeout in a
  window (`~/init-hang-rig/curl2.txt`, `burst2.out`).
- Anthropic-path specific: interleaved round anthropic 4/40 vs cloudflare 0/40,
  same burst (`~/init-hang-rig/interleave*.out`).
- Not ClientHello-size specific: small ≈ big timeout rate.
- D5 flat init ~1 s across 7/16/28 MB (`~/init-hang-rig/ts-*.tsv`).
- No local MSS clamp; anthropic routes over WiFi MTU 1500 (`nft list ruleset`,
  `ip route get 160.79.104.10`).

**NOT VERIFIED:**
- The EXACT hop that clamps to MSS 536 and its SYN-ACK **TTL** (LEAD's tcpdump
  discriminator): **blocked** — `tcpdump`/packet capture needs `CAP_NET_RAW`/sudo
  not available to this agent, and the brief forbids any human dialog. §9.3
  localizes to the anthropic *path* (vs cloudflare) but cannot name the hop or
  distinguish anthropic-edge from a transit middlebox. Hop ownership = NOT
  VERIFIED; needs a privileged tcpdump or a second-vantage capture.
- The CLI init-request has NO no-response retry (inferred from 600 s vs 188 s field
  timing + turn-only `waited_ms`; not read from the minified CLI binary).
- That the throttle empirically drops the fleet wedge rate (the burst repro is
  intermittent, so an end-to-end before/after needs a longer measurement window).

---

## 10. Why metarepo, not orchestra? (LEAD D10) — CONNECTION VOLUME, not a repo ingredient

LEAD's field facts: 28/28 wedges on metarepo, 0 on orchestra, same account + CLI;
and a single hand-made metarepo workspace reportedly wedges 4/5. If the cause were
a *pure* per-connection network transient, it should not be repo-selective. D10
asks for the metarepo-specific factor. Answer, with evidence: **it is not a
metarepo startup ingredient — it is concurrent-connection VOLUME, which is driven
by session ACTIVITY, and the metarepo agents in the incident were the heavy ones.**

### 10.1 Boot is identical across repos (bisect, ≥3–5 spawns/arm)

Single `claude -p` boots, model `claude-opus-5-5[1m]`, isolated timing, counting
anthropic connections owned by the spawned pid (`~/init-hang-rig/d10-boot.sh`):

| arm | cwd | config | boots | init | peak conns | wedged |
|---|---|---|---|---|---|---|
| A | metarepo | full `mc` account | 5 | 1–2 s | 13 | 0/5 |
| B | metarepo | `--strict-mcp-config` (no claude.ai connectors) | 3 | 0–2 s | 11 | 0/3 |
| C | **orchestra** | full `mc` account | 3 | 1–5 s | 10–11 | 0/3 |

- **Metarepo and orchestra boots are indistinguishable**: same ~11–13 conns, same
  init range. Stripping the claude.ai connectors (`--strict-mcp-config`) barely
  moved the count (13 → 11) — the connectors are not the driver.
- **An orchestra boot ALSO produced transient stuck flows** (arm C run 1: 6 ×
  `bytes_acked:1`). The MSS-536 black hole is **NOT metarepo-specific at boot** —
  orchestra catches it too when it opens connections in a bad window.

### 10.2 Connection count tracks ACTIVITY, not repo (live fleet, ~30 pids)

Anthropic connection count per live `claude` pid, tagged by repo:

| repo | idle sessions | busy sessions | stuck flows |
|---|---|---|---|
| orchestra | 1–4 conns | **30, 32** conns | 0 (in this snapshot) |
| metarepo | 1–4 conns | **55, 61, 62** conns | 55→10, 61→6 stuck |

- **High-conn sessions exist in BOTH repos** (orchestra 30/32; metarepo 55/61/62)
  → connection count is not a repo property.
- The 62-conn session's connections were **all to `api.anthropic.com`** (50 v6 +
  12 v4), not MCP servers — so the volume is API request concurrency (parallel
  tool calls / sub-agent fan-out under a 1M-context model), not connectors.
- **Stuck flows land only on the high-conn sessions.** The more concurrent
  connections a session holds, the higher its chance that one lands in a bad
  window: measured per-connection stuck rate in a bad window **q ≈ 0.13** (8/60 on
  a 60-wide Node TLS burst; q = 0 in good windows). At 62 conns vs 2 conns the
  session-level exposure differs by more than an order of magnitude.

### 10.3 Verdict on D10

The metarepo concentration is a **selection effect**: in the incident wave the
heavy-activity agents (large parallel tool/sub-agent fan-out, 1M-context) happened
to be the metarepo ones, so they carried 50–62 concurrent connections and caught
the intermittent black hole; the orchestra agents were lighter (mostly ≤4 conns).
"154 metarepo vs 30 orchestra" is a snapshot of *which agents were busy*, not an
intrinsic metarepo trait — orchestra sessions reach 30+ conns and also get stuck
flows. No startup ingredient (CLAUDE.md size, MCP set, connectors, hooks, cwd)
flips the boot outcome (§10.1).

### 10.4 Limitation + implication (honest)

- **NOT reproduced**: the "single workspace wedges 4/5" figure. A `-p` one-shot
  boot does ONE trivial turn (~13 conns) and wedged 0/5; the field 4/5 is a
  *working* keeper-driven session that reaches the 50+ conn regime through real
  tool fan-out, which the `-p` rig does not exercise. Reproducing it needs a driven
  multi-turn session under a bad window — left as the next step.
- **Implication for the D7 boot throttle**: if the dominant exposure is per-session
  concurrent-connection count *during work* (not the multi-session boot burst),
  then a boot-concurrency throttle is only a partial mitigation — it helps the
  simultaneous-boot case but does nothing for a single busy session at 62 conns.
  The exposure-matched lever would cap concurrent in-flight API connections per
  session (or serialize tool/sub-agent fan-out) — a larger, separate change.
  Flagged for LEAD as the reason the throttle alone may not zero the heal counters.
