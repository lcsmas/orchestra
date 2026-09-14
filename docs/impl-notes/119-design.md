# #119 asks + decision gates — design (IMPL-119)

Base: origin/master 3cdc212. Branch: bus-asks-gates-119 (remote).

## Schema — MIGRATIONS[4], SCHEMA_VERSION 4
`decision_gates` gains `recipient TEXT` (NULL = addressed to run/coordinator, matched by no reader → never wakes anyone specific).
`ALTER TABLE decision_gates ADD COLUMN recipient TEXT;`
partial index `idx_gates_recipient(run_id, recipient) WHERE resolved_at IS NULL`.
Renumber to next free int at rebase if a sibling took 4 (only #119 needs a migration this wave; #120 confirmed reuses kinds).

## bus.ts
- BusDecisionGate.recipient: string|null.
- openGate(db, runId, askedBy, question, recipient=null): writes recipient.
- openGatesForRecipient(db, runId, recipient): SELECT open gates WHERE recipient=? ORDER BY opened_at,id — surfaced by check + the predicate.
- resolveGate/getGate/openGates unchanged (re-resolve already refused by `WHERE resolved_at IS NULL`).

## Two switches govern the sweep
Lot + question pending → `wake` switch (unchanged).
GATE pending → `askGate` switch (NEW, independent).
A reader delivers AT MOST ONE order (`orchestra check`) per sweep even if both fire — the order is identical.

### shared/bus-wake.ts (policy, pure)
ReaderPendingState gains:
  gatePending: boolean          // an open gate addressed to reader exists
  gateThroughSeq: number        // max open gate id addressed to reader (dedup high-water for the gate arm)
Keep pending/pendingThroughSeq = lot OR question (wake-gated), semantics unchanged.

decideWake stays the lot/question decision (wake switch). ADD decideGateWake(pending, session, previousGate, askGateOn):
  same shape (fire/count/skip), gated on askGateOn, dedup on a SEPARATE ledger key.

Dedup: two ledgers keyed by reader — the existing `wake` ledger and a new `gate` ledger — because a reader can be pending for a lot (wake OFF → counted) AND a gate (askGate ON → fired) independently, and each must dedup on its own high-water. BUT delivery is one order: if EITHER decides `fire`, deliver once; counters: fired++ if any fired; counted++ per source that counted. To keep "exactly ONE wake for R" (T119.3) when only the gate is pending, the gate arm fires and the lot arm skips (no lot) → one delivery. When both fire, we must still deliver once — so the sweep collects per-reader intents and delivers a single order, incrementing fired once if any fired.

Simpler & matches existing counter semantics (counters count WAKES not sources): keep per-reader single decision but choose switch by source. Since the ORDER is identical and dedup is per-reader, model:
  effectiveFire = (lotOrQuestionPending && wakeOn) || (gatePending && askGateOn)
  effectiveCount = (pending-of-any-kind) && !effectiveFire   → counted once
  dedup: one ledger entry per reader keyed on combined high-water = max(pendingThroughSeq, gateThroughSeq) ONLY across sources whose switch is ON for fire; for count, across all pending sources.

DECISION: keep ONE ledger + ONE delivery per reader. decideWake gains the gate inputs so it stays the single decision site (mutation-proof, one place). Signature:
  decideWake(pending, session, previous, switches:{wake:boolean; askGate:boolean})
  fire iff (pending && wake) || (gatePending && askGate)
  count iff (pending || gatePending) && not fire
  throughSeq = max of the seqs of the sources that JUSTIFIED the action.

### main/bus-wake.ts
- readPendingReaders fills gatePending/gateThroughSeq from openGatesForRecipient (run-scoped, recipient=reader).
- add readAskGateSwitch accessor seam (mirror readWakeSwitch), default ()=>false, __freeze sets both.
- sweep reads both switches per reader per run, passes to decideWake.
- readWaitingReaders(db, readers): Set<string> — SENDER/opener side (Q-C1 export for #120).

### CLI
- gate open --to <recipient> <question...>  (recipient optional? ticket says --to R; keep optional, default null)
- gate resolve <id> --resolution <text>  (accept BOTH positional ruling AND --resolution for back-comat with existing test; prefer --resolution)
- check surfaces open gates addressed to caller: CheckOutput gains `gates: [{id, asked_by, question, opened_at}]`.
- gate list — lists open gates addressed to caller.

## Tests / arms
- Update existing sweep D2 must-FAIL arm (line 473): it now becomes the pre-#119 baseline demonstration inside T119.3 (old predicate = 0 gate wakes), then GREEN with recipient+askGate.
- T119.1 ask re-wake loop; T119.2 gate recipient+resolve+re-resolve; T119.3 must-fail; T119.4 waiting excluded.
