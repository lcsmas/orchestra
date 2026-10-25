# #303 — Which empty or log-only catch blocks turn an error into a silent default?

Part of [Wayfinder: runtime reliability from distributed-systems research](https://github.com/lcsmas/orchestra/issues/296). It feeds [GO/NO-GO: fix the silent-default catch blocks, and add a guard so the class cannot come back?](https://github.com/lcsmas/orchestra/issues/312).
Builds on lead 7 of [`distributed-systems-leads.md`](distributed-systems-leads.md), which counted the population but did not classify it. [`orca-model-lineage.md`](orca-model-lineage.md) does not cover error handling. Neither is repeated here.

All code is read on `origin/master` @`743f9ab0`. Each `file:line` points at the `catch` keyword (or the `.catch(` call).

## Answer

- **10 of the 428 swallowing handlers are dangerous. Three of them were reproduced on master with a rig that fails there.** In each of the three, a read error other than ENOENT is treated as "file absent", and the code then writes or deletes on that basis. That is the [#238](https://github.com/lcsmas/orchestra/issues/238) shape ("torn `.claude.json` rebuilt from `{}`") and the [#235](https://github.com/lcsmas/orchestra/issues/235) shape ("missing source ⇒ sync to empty").
- **25 more fail OFF or fail open by design, and say so in a comment.** Most are bus switch reads that turn an SQL error into "OFF", which is the same verdict as a missing row (the [#206](https://github.com/lcsmas/orchestra/issues/206) family). They log, they last only one sweep, and none of them writes anything persistent.
- **The other 393 are legitimate under Yuan et al.'s own exemptions.** These are cleanup, a probe that means "no", parsing of untrusted lines, display defaults, and background tasks that log.
- **None of the 7 issues in the "silent acceptance" pain row is shaped like a catch.** [#59](https://github.com/lcsmas/orchestra/issues/59) is an exit code, [#134](https://github.com/lcsmas/orchestra/issues/134) a missing call, [#155](https://github.com/lcsmas/orchestra/issues/155)/[#175](https://github.com/lcsmas/orchestra/issues/175) missing validation, [#182](https://github.com/lcsmas/orchestra/issues/182)/[#206](https://github.com/lcsmas/orchestra/issues/206) a `?? OFF` on a missing row, and [#277](https://github.com/lcsmas/orchestra/issues/277) argument parsing. A catch audit would not have prevented any of them. It does catch the file-store class: #235 and #238.
- **A guard rule (R2) rediscovers both historical bugs at their pre-fix commits, and flags 8 sites on master.** The rule: a swallowing catch around a read, in a function that later writes or deletes. Of the 8 master hits, 3 are the reproduced defects, 1 is low-severity and 4 are benign.

## Method

1. **Census.** A TypeScript-AST scan (compiler API, not a regex) covered the 194 non-test `.ts` files in `src/{main,shared,keeper,cli}`. It found 664 handlers: 529 `try/catch` and 135 `.catch(fn)`. A handler counts as *swallowing* when its body is one of: empty, comment-only, log-only, `return <constant>`, log + `return <constant>`, `return;`, or `continue`.
2. **Triage.** I read every one of the 428 swallowing handlers in a dump that showed the try and catch text. Then I read the surrounding code of about 40 candidates. The buckets apply the false-positive rules of Yuan et al. OSDI'14 §5.1 (quoted below). DANGER and WATCH were assigned by hand. The other buckets were assigned by regex and then read through.
3. **Reproduction.** The three highest-risk sites were run on master. Each rig executes the real master code: the function text is extracted from the tree, or the real module is esbuild-bundled with the same stubs as `src/main/account-inherit.test.ts`. Each rig has a readable-file control arm and an EACCES arm, and runs on a scratch HOME under `/tmp` only.
4. **Prototype guard.** Two candidate static rules ran on master and on the two pre-fix trees (`db3f82ac^` for #238, `0b56cea6^` for #235).

### Source rule (Yuan et al., OSDI 2014)

[Yuan et al., "Simple Testing Can Prevent Most Critical Failures"](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf). I downloaded the PDF this session and grepped the extracted text. VERIFIED.
- "in 35% of the catastrophic failures, the faults in the error handling code fall into three trivial patterns: (i) the error handler is simply empty or only contains a log printing statement…". Also: "25% of the catastrophic failures were caused by ignoring explicit errors (an error handler that only logs the error is also considered as ignoring the error)."
- The Aspirator checker does not warn on an empty catch when "(i) the corresponding try block modifies a variable V; and (ii) the value of V is checked in the basic block following the catch block". It also does not warn when the try ends in `return`/`break`/`continue` and the code after the catch is "in effect exception handling".
- "we ignored all instances of the FileNotFound exception, because we found the vast majority of them do not indicate a true error". Also: "we use this to suppress warnings if the ignored exceptions are from a shutdown, close or cleanup method".
- They sort warnings into bug / bad practice / false positive. "Warnings are categorized as bugs only if we could definitively conclude that, once the exception occurs, the handling logic could lead to a failure." Across 9 systems: "500 new bugs and bad practices along with 115 false positives".

**What this means for Orchestra (INFERRED).** Yuan's FileNotFound exemption is exactly where Orchestra's dangerous sites hide. Each of them treats *every* error as ENOENT. That is safe for ENOENT, but it turns EACCES/EIO/EMFILE/ELOOP into "absent". That is harmless when the default is only displayed, and destructive when it is then written back.

## Census (VERIFIED, scan on 743f9ab0)

| Handler shape | `try/catch` | `.catch()` |
|---|---:|---:|
| comment-only / empty | 123 / 0 | 6 / 41 |
| log-only | 65 | 44 |
| `return <const>` | 90 | 16 |
| log + `return <const>` | 29 | 1 |
| `return;` / `continue` | 8 / 5 | — |
| **swallowing total** | **320** | **108** |
| handles the error (rethrow, retry, explicit branch) | 209 | 27 |

Comment-only plus log-only `try/catch` comes to 188 here, against 183 (125 + 58) in the leads doc. The leads doc ran on `e7aedd79` with a narrower notion of a log call. This scan also counts `slog.`/`klog.`/`plog.` as log calls, which adds 7 log-only handlers.

| Bucket (428 swallowing handlers) | n | Verdict |
|---|---:|---|
| cleanup: unlink/rm/close/kill/dispose/ROLLBACK/stop | 75 | legitimate (Yuan's cleanup exemption) |
| logged best-effort: log, then carry on | 76 | legitimate; nothing persists the default |
| read-default: display/advisory value (git stats, usage bars, skill descriptions, model menu…) | 76 | legitimate; the default is only rendered |
| probe-default: `existsSync`/`stat`/`realpath`/`new URL`/`rev-parse` → false/null | 54 | legitimate where "no" is the safe answer (all re-read) |
| background task `.catch(log)` | 37 | legitimate |
| background task `.catch(() => {})` (refresh/sync/backfill) | 30 | legitimate; each refresh is re-driven by its timer |
| `/proc` or `kill(pid, 0)` probe → "gone" | 18 | legitimate; see the EPERM note in NOT VERIFIED |
| parse of an untrusted line/frame → skip | 17 | legitimate (Yuan's after-catch exemption) |
| promise-chain serialization `prev.catch(() => {})` | 10 | legitimate; the error is reported by the link that owns it |
| **WATCH**: fail-OFF / fail-open by design, documented | 25 | see below |
| **DANGER** | 10 | see below |

## The dangerous subset (10)

"Repro" means a rig ran the real master code: the control arm keeps the data, the EACCES arm destroys it. "Code read" means INFERRED from reading the code only.

| # | Site | What the error silently becomes | What then happens | Evidence |
|---|---|---|---|---|
| D1 | [`src/main/self-tune.ts:168`](../../src/main/self-tune.ts) `ensureFoldTargets` | any read error on `~/.claude/CLAUDE.md` ⇒ "missing" | `writeFileSync(CLAUDE.md, "@LESSONS.md\n")`: the user's global instructions are **replaced** by one line, and the action log says "created". No WARN | **Repro**: control keeps the file; EACCES arm leaves `"@LESSONS.md\n"` |
| D2 | [`src/main/account-inherit.ts:663`](../../src/main/account-inherit.ts) `syncAccountInheritance` | read error on the global `CLAUDE.md` ⇒ "no @-imports" | `:751` `removeOurSymlink` prunes every imported memory link (`LESSONS.md`, `RTK.md`) from each alternate login. Those sessions then run without them until a later sync succeeds. No WARN. This is a #235 residual: the line is also flagged at `0b56cea6^:346` and survived both #235 and #238 | **Repro**: links before `[CLAUDE.md, LESSONS.md, RTK.md, settings.json]`, after `[CLAUDE.md, settings.json]` |
| D3 | [`src/main/keeper-client.ts:595`](../../src/main/keeper-client.ts) `listLiveKeepers` | pid-file read error ⇒ "stale" | `:598` unlinks the pid file, **socket** and log of a keeper whose pid is alive. It is called at startup (`src/main/index.ts:831`, `:851`) and from `events-spool.ts:359`. INFERRED: an unlinked unix socket cannot be connected to, so the surviving session is orphaned from the app | **Repro**: the alive-pid keeper loses all 3 files under EACCES. Its pid file is written tmp+rename (`src/keeper/index.ts:510-511`), so a torn read cannot trigger this; EMFILE/EIO can |
| D4 | [`src/main/workspaces.ts:2854`](../../src/main/workspaces.ts) `moveWorkspaceTranscripts` | `readdir` error ⇒ "nothing to move", no log | The caller re-pins `accountId` (`:2955-2958`), which the comment at `:2950` says must not happen: "a failure leaves the workspace on its original account … rather than pinned to an account whose config dir has no transcript". The conversation is stranded under the old account | Code read. The unmerged #240 branch `migrate-transcripts-same-dir-c13` (`transcript-move.ts:116-121`) now warns, but I did not check whether it still re-pins |
| D5 | [`src/main/sandbox-import.ts:412`](../../src/main/sandbox-import.ts) eject | backup `cp` error ⇒ ignored | The "final safety snapshot before we touch anything" (`:409`) is absent. The forced `fetch +branch:branch` (`:431`) still overwrites the local branch, and `tmp` (holding the only export copy) is deleted in `finally`. The failure most likely to break `cp` is ENOSPC, which is exactly when the snapshot matters (INFERRED) | Code read |
| D6 | [`src/main/hooks-server.ts:454`](../../src/main/hooks-server.ts), [`:462`](../../src/main/hooks-server.ts) bus-status | pause/reprise read error ⇒ field omitted | `orchestra bus-status` reports a paused run as not paused, with no log. Same family as #206. The host pause trap still enforces, so an agent misreads its state but is not freed | Code read |
| D7 | [`src/main/agent-sdk.ts:4246`](../../src/main/agent-sdk.ts) `persistWorkspacePatch` + [`src/main/store.ts:212`](../../src/main/store.ts) | store save error ⇒ logged | The patch is still broadcast as applied (`:4249`), so the callers' own `.catch(() => {})` (`agent-sdk.ts:3026`, `:5787`) can never fire. Session-id clears, picker choices and pending prompts look saved and vanish on restart. `store.ts:209-211` says so itself: "invisible at runtime" | Code read |
| D8 | [`src/main/transport/sandbox-manager.ts:172`](../../src/main/transport/sandbox-manager.ts) `getClientId` | read error ⇒ "first run" | A fresh UUID is written **over** the stored client id (`:178`). The sandbox then sees this app as a different client, and the drive is no longer resumed on reconnect | Code read; also flagged by both prototype rules |

D1–D3 share one shape: a swallowing catch around a read, followed by a write in the same function. That shape is what R2 below detects.

## WATCH (25): fail-OFF or fail-open on purpose, logged or commented

These are not bugs by Yuan's definition, because the consequence is bounded and documented. Each is still a place where "unknown" is read as "no". If [#312](https://github.com/lcsmas/orchestra/issues/312) wants the class closed, this list needs a decision, not a fix.

- **Switch read error ⇒ OFF, logged once per sweep:** `bus-wake.ts:714` (wake), `:725` (ask-gate), `:977` (default, comment only); `bus-liveness.ts:412`, `:529`, `:565`; `session-watchdog.ts:270`. If the error persists (for example a schema mismatch after a downgrade — INFERRED), the fleet silently runs with wake and liveness OFF. The log shows a WARN every sweep; the UI shows nothing.
- **Accessor error ⇒ "none":** `bus-liveness.ts:325` (waiting readers), `:338` (released), `:347` (held runs); `pause-trap.ts:693` (active pauses ⇒ 0 armed), `:768` (owed traps ⇒ none). All of them log, and the next sweep retries.
- **Fencing omitted on a bus read error:** `agent-sdk.ts:995`, `workspaces.ts:5312`. `$ORCHESTRA_COORDINATOR_GENERATION` is not set, so that session's CLI writes are unfenced ([#166](https://github.com/lcsmas/orchestra/issues/166) path), logged.
- **Run-row probe error ⇒ "no run":** `bus-run-anchor.ts:83` feeds `parentRunTarget`. INFERRED: a throwing `getRun` can give a wrong or missing `parent_run_id`, which is the #175 delivery shape. `pause-ui.ts:351` is display-only.
- **Transcript probe error ⇒ "absent ⇒ start fresh":** `agent-sdk.ts:2170`, `:2185`. The conversation forks (a WARN at `:1952`). `existsSync` returns false on EACCES as well.
- **Guards that fail open:** `cli/index.ts:286`. A non-ENOENT read of the stale-run marker counts as "not stale", so the [#142](https://github.com/lcsmas/orchestra/issues/142) refusal is skipped.
- **Read error ⇒ empty inbox:** `inbox-tray.ts:75`. No write follows, because `removeBlock` finds nothing. But the tray reports the block "gone", and the parked count, and with it the stall badge, is cleared (`:143`).
- **Count/flag persist failures:** `human-gates.ts:149`, `inbox-tray.ts:143`, `agent-sdk.ts:3026`, `:5787` (the last two cannot fire; see D7).
- **Sandbox import:** `sandbox-import.ts:101`. A config copy into the sandbox can fail silently and leave the payload partial.

## Prototype guard: does a static rule rediscover a known bug?

The evidence rule (#296 Notes) asks for exactly this test. Rules, run on three trees (VERIFIED):

- **STW**: a swallowing catch whose try assigns a variable declared outside the try, where that variable is used after the try and the same function later writes.
- **R2**: a swallowing catch whose try reads (`readFile*`/`readdir*`/`JSON.parse`), where the enclosing function later calls `write*|append*|unlink|rm|rename|remove*|prune*|delete*|upsert*|persist*|kill*|symlink*|copy*|cp`.

| Tree | STW hits | R2 hits | Known bug flagged? |
|---|---:|---:|---|
| `db3f82ac^` (pre-#238) | 8 | 9 | **yes**: `account-inherit.ts:410` (`data` = `{}` → `writeFileSync`), both rules |
| `0b56cea6^` (pre-#235) | 9 | 11 | **yes**: `:270` (`globalMcp` = `{}` → servers removed) and `:293`; R2 also flags `:346` = today's D2 |
| `743f9ab0` (master) | 7 | 8 | the fixed sites are gone; D1 is flagged by both, D2 and D3 by R2 only |

R2 on master gives 8 hits:
- the three reproduced defects (D1 `self-tune.ts:168`, D2 `account-inherit.ts:663`, D3 `keeper-client.ts:595`);
- one low-severity hit (D8 `sandbox-manager.ts:172`);
- four benign hits: `api-handlers.ts:960` (clipboard prune), `keeper-client.ts:130` (unreadable install stamp → rewrite), `sandbox-import.ts:423` (advisory meta), `workspaces.ts:5658` (hooks stamp → reinstall).

So R2 has 4 of 8 true hits on master, and 2 of 2 historical bugs at their pre-fix commits. It does not see D4–D7: D4 has `return;` in the catch, and D5–D7 are not read-then-write. The fix all eight hits would accept is Yuan's own exemption made explicit: branch on `err.code === 'ENOENT'` and rethrow or skip otherwise. That is the pattern #238's fix already uses (`account-inherit.ts` `viewFile`). An annotation like `// catch-ok: <reason>` would cover the 4 benign hits.

## Side finding (code read)

`workspaces.ts:2877`: the comment says "best-effort — leftover files, e.g. a concurrently-written transcript, just leave it in place". But `rm(srcDir, { recursive: true, force: true })` deletes leftover files. The unmerged #240 branch replaces it with a non-recursive `rmdir` (`transcript-move.ts:196`).

## VERIFIED (read or run this session)

- Yuan et al. OSDI'14: PDF downloaded from usenix.org, text extracted with pypdf, every quote above grepped from it.
- Issue bodies of #59 #134 #155 #175 #182 #206 #277 #235 #238 #312 #299 from `gh issue list --json`. None of the 7 silent-acceptance issues names a catch block as its cause.
- The pre-fix code of #238 (`git show db3f82ac^`) and of #235 (`git show 0b56cea6`) are comment-only catches that leave a `{}` default in place before a write.
- Census numbers: AST scan of `git archive origin/master src` @743f9ab0 (194 files, 664 handlers). I read all 428 swallowing handlers in the dump.
- D1, D2, D3 reproduced. Each rig runs the real master code on `/tmp/r303/rig/*`, with a control arm that keeps the data and an EACCES arm that loses it. After the D2 rig, the live `~/.claude-mc` manifest was checked read-only: it has no reference to the rig path, and the links still carry their 09-30 dates.
- D4–D8 and the WATCH entries: the code was read at the cited lines. Callers were checked for D3 (`index.ts:831/851`, `events-spool.ts:359`), D4 (`workspaces.ts:2953-2958`) and D7 (`store.ts:195-214`, `agent-sdk.ts:4238-4249`).
- STW and R2 hit counts on the three trees, as in the table.
- The #240 branch is not merged into master (`merge-base --is-ancestor` rc=1).

## NOT VERIFIED

- **The real-world trigger rate.** The rigs use EACCES (a write-only file) because it is deterministic. The realistic triggers (EMFILE under fd pressure, EIO on a slow mount, ELOOP) were not induced, and no field incident of D1–D8 is on the tracker. The reproductions prove the mechanism, not how often it fires.
- **D3's downstream effect.** That the app then cannot reattach, or starts a second CLI on the same conversation, is INFERRED. Only the unlink was observed.
- **D4–D8 were not executed.** Their effects come from code reading.
- **Whether the #240 branch's `moveProjectTranscripts` warning also stops the re-pin.**
- **The 393 "legitimate" handlers** were judged on one reading each. The regex-assigned buckets (cleanup, probe, …) could move a few entries between buckets. The 209 + 27 handlers classed as *handling* the error were not audited. `store.ts:128` (an unreadable store, EACCES included, is renamed aside and replaced by empty defaults) sits in that bucket and is loud but destructive.
- **`kill(pid, 0)` → "dead" on EPERM** (`keeper-client.ts:640`, `keeper/index.ts:432`): it only matters for a pid owned by another user. Not tested.
- **Rule precision beyond these three trees.** R2 was not run over the full history, so its recall on other past bugs is unknown.
- The persistent-file write methods themselves (tmp+rename, fsync) belong to [Research: which persistent files does Orchestra write, how, and with what concurrent writers?](https://github.com/lcsmas/orchestra/issues/299) and were not inventoried here.
