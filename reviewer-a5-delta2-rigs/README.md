reviewer-a5-delta2 — probes vs promote-parent-run-a5 @76e1309c (ledger #224). Paths are absolute to the reviewer worktree (orchestra-cosmic-koala-a0b77f4c) and its scratch master-wt/cand2 worktrees; edit before reuse.
- probe-p4b.mjs / probe-sock.test.ts : prior reviewer's probes (X1-X4, Y1-Y3, S1-S5) re-pointed at this tip. S3 asserts the OLD (unfixed) result, so its failure = D5 fixed.
- mut.py + mutants.json (16 in-place mutants of the delta clauses), mut2.py + mutants2.json (5), mut3.py + mutants3.json (3, with the out-of-`pnpm test` rig): byte-exact backup + cmp restore + CLI hash restore.
- probe-d5.test.ts : `ask --to human` and `gate open --to <8-char>` controls (survivors C1/C3).
- enum-d5b.ts : 80 sender x recipient `ask --to` pairs over 4 topologies, master CLI vs candidate CLI vs real readPendingReaders.
- zmatrix.mjs (+ matrix-*.txt): message(P4) x send matrix, master vs candidate. zprobe.mjs: mirror-row placement. zstale.mjs: stale-marker window. zcorner.mjs: delivery-OFF/wake-ON corner.
