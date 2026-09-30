# C2 #209 — handoff (PAUSED by OPS/LEAD at 09:52 local; nothing nominated)

State: branch `hidden-cost-inventory-c2`, rebased onto master `3bfd784f` (C1 merged). Draft report `docs/research/hidden-cost-inventory.md`
has 3 placeholders left (`@@VERDICT@@` §top, `@@RANK@@` §3, `@@REPRO@@` §8) — everything else is written and every `path:line` passes
`python3 scripts/hidden-cost/check-anchors.py` (must-FAIL proofs run: shifted anchor rc 1, unverified citation rc 1, byte-exact restore).

Evidence dirs:
- `evidence-v1-pre-c1-merge/` = COMPLETE run (every arm, every micro-bench) on base `3ea8b7d2` (pkg 0.5.298, claude 2.1.284). ALL numbers in the draft come from it.
- `evidence/` = re-run on the rebased tree (`run-all.sh`, started 09:31): enumeration + all 7 scenarios done; app arms interrupted at idle8 attempt 2 (a
  renderer stall voided attempt 1 — kept in `evidence/discarded/`). Remaining: `bash scripts/hidden-cost/run-all.sh app git loopscan cli npx hooks proc scaling c1 field`.

To finish: (1) re-run the remaining steps; (2) `python3 scripts/hidden-cost/compare-evidence.py evidence-v1-pre-c1-merge evidence` and state which numbers changed
(rebase changed agent-sdk/workspaces/resource-monitor; RSS was already VmRSS in v1); (3) `render-tables.py` + `derive.py` → evidence/tables.md, derived.txt;
(4) fill the 3 placeholders (rank table = §4 sorted by field-scale cost: streaming renderer cost, running-row animation, polling fan-out, hidden-window gate,
releases stampede, focus fetch, CLI boot per SessionStart, memory per session…); (5) `bash scripts/hidden-cost/selfgate-mutant.sh` (cost-injection self-gate, NOT yet run)
and one in-place mutant per instrument claim; (6) `pnpm run test` (2765 pass / 0 fail / 0 skipped on this tree), `npx tsc --noEmit` (rc 0), `pnpm run test:session-budget` (PASS);
(7) nominate per ledger #237 (comment ≤15 lines + one bus ping).

Known open: 5 of ~20 app-rig boots stalled (renderer stops answering CDP at random points) — diagnostics captured, cause unattributed (report §7 item 8).
