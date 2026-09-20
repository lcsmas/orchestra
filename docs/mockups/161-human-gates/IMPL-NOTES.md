# #161 Phase-2 implementation notes (human-gate ask UI: A + B)

VERDICT of codebase recon (2026-09-20, master fe2934d, branch human-gates-161-p2):
the bus GATE LIFECYCLE is already complete and battle-tested (#119 + #158). #161
phase-2 is mostly RENDERER + a thin main-process IPC + live push. Do NOT re-build
the gate mechanism.

## What already exists (verified in source)

- `decision_gates` table with `recipient TEXT` column (bus.ts:114 BusDecisionGate;
  MIGRATIONS[4] SCHEMA_VERSION=4). A gate `recipient='human'` is a legal row TODAY.
- `openGate(db,runId,askedBy,question,recipient=null)` (bus.ts:728).
- `resolveGate(db,gateId,resolvedBy,resolution)` (bus.ts:750) — resolves once,
  refuses re-resolve (`WHERE resolved_at IS NULL`), so two racers can't clobber.
- `getGate` (766), `openGates` (773), `openGatesForRecipient` (798, single-run),
  `openGatesForRecipientInRuns` (824, CROSS-RUN via json_each over a run set).
- `getRelatedRunIds(db,runId)` → own ∪ ancestors ∪ descendants.
- CLI `orchestra gate open --to human "..."` ALREADY writes recipient='human'
  (bus-verbs.ts:772 verbGate; `--to` is a free string, no reserved constant).
- CLI `gate resolve <id> --resolution <text>` (bus-verbs.ts:790): resolves +
  sends a threaded `kind='decision_gate'` reply to `asked_by` in the GATE'S run
  (threadId `gate:<id>`), which re-wakes the asker via the normal lot path (#158).
  THIS is the exact re-wake the UI resolve must reproduce.
- `readWaitingReaders` (#119) already excludes an opener (asker on an open gate)
  from #120 escalation — "waiting" is free for a human gate too.

## What #161 phase-2 ADDS

Backend (main):
1. A read for surface B: "all OPEN gates addressed to the human, fleet-wide"
   (the human is not scoped to a related run set — they see the whole fleet).
   New helper e.g. `openGatesForRecipientAllRuns(db, 'human')` or a bare
   `SELECT ... WHERE recipient=? AND resolved_at IS NULL`. + map each gate's
   run_id/asked_by → a workspace for deep-link + surface-A placement.
2. A resolve IPC: call `resolveGate(db,id,'human',ruling)` then reproduce
   verbGate's threaded re-wake send (EXTRACT that block so CLI + IPC share it —
   never re-implement, per LESSONS "collapse to ONE").
3. Live push to the renderer on any gate open/resolve so A and B update live
   (cross-surface) and backfill==live.

Renderer:
- Surface A: inline ask row in the asking workspace's structured view
  (PermissionSlot, beside InboxTray/AskUserQuestionCard). Reuse the amber av-warn
  idiom from the mockups.
- Surface B: "Asks" section in the Sidebar aggregating all open human gates,
  each deep-linking to its workspace.

## HUMAN RECIPIENT HANDLE
Decision: reserve the literal `'human'` as the gate recipient handle for
user-directed gates (matches the mockups' `--recipient human` and the ticket's
"recipient is the USER"). Define ONE shared constant (e.g. HUMAN_GATE_RECIPIENT
in src/shared) so CLI, main read, and any doc reference agree — never a bare
string in N places.

## Acceptance arms (OPS-required, all must-FAIL/mutation-proven, drive changed files)
- gate opened to human → badge/row renders, NO agent woken — PIXEL-ASSERTED
  (assert on the IMAGE; await document.fonts.ready). Both A and B.
- answer in UI (A, and separately B) → row resolved_by=human in DB + asker re-woken.
- cross-surface: answer in B flips A live and vice versa (one gate, two views).
- backfill==live (#57): rendered rows identical live vs reconstructed from DB.
- durable across app restart: open gate still renders.

## Gates to run: tsc RC0 + `pnpm run test` (skipped=0) + headless-sway E2E + verify skill.
Update docs/codebase-map: bus.md (human recipient read), renderer-ipc-ui.md
(the IPC + sidebar Asks section), structured-agent-view.md (surface A).
