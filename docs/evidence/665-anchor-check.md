# #665 — the mutant-anchor step on the 3 real cases (2026-11-26)

`node --experimental-strip-types --no-warnings scripts/ci/mutant-anchors.mjs --all --root <tree>` on each PR's head and on the parent of its merge (pre-merge master); ~2.8 s per tree.

| PR (issue) | parent of the merge | PR head: stale anchors named |
|---|---|---|
| #642 | OK, 1251 anchors | `test:fanout-record-mutants` · `scripts/e2e-fanout-record.mjs` · "counts: a decided finding still counts" (M25) → `src/shared/fanout-record.ts` 0×; "state file: the record-only finding fields are unknown on read" (M45) → `src/shared/fanout-state.ts` 0× |
| #648 (#645) | the two #642 anchors still stale (master was already red) | those two + `test:fanout-loop-skill-mutants` · `scripts/fanout-loop-skill-mutants.mjs` · "609 on: a stray blank line outside the block changes the off render" (M03) → `src/shared/verified-fanout-skill.ts` 0× |
| #662 | OK, 1256 anchors | `test:fanout-relaunch-mutants` · `scripts/fanout-relaunch-mutants.mjs` · `flaky-not-read` → `src/shared/fanout-report.ts` 0× (the two older ones were re-anchored by #661) |

By path (`CI_PATH_SELECTION=1`, the merge commit against its first parent) the same mutant rigs are the ones selected: 36 / 28 / 28 of 41.
