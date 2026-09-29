reviewer-a5-delta — probes against promote-parent-run-a5 @084398af (ledger #224). Untracked-by-candidate rigs, paths are absolute to the reviewer worktree.
- probe-p4b.mjs   : copy of scripts/verify-promote-run-refresh.mjs + arms X1-X4 (P4 exemption sender-agnostic) and Y1-Y3 (mirrored dispatch row wakes the plain parent; row-less control).
- probe-sock.test.ts : built CLI over a fake app SOCKET (S1 production path, S2 old app, S3/S5 ask+gate siblings).
- mk_mutants.py / mut.py / mutants.json / mut-run1.log : 12 in-place mutants (+G5a/b in mutants.json), byte-exact backup + cmp restore + CLI-hash restore.
