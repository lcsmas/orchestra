reviewer-a8 evidence for ledger #224 (A8 #235 @96315878). Scratch-only rigs (paths hardcoded to the reviewer worktree; never point at ~/.claude*).
- run2.txt  : real-geometry attack (live-dir links built under REAL home, sync under FAKE home) x shapes S0..S5 x {cand, master}
- run1.txt  : same-HOME variant; mut.txt/mut2.txt : 7 in-place mutants (MA..MG) on the candidate; t-unfixed.txt : candidate tests on master src (11 pass/12 fail)
- proto-provenance-guard.patch : ~10-line manifest.source guard; flips S1..S5 to 7/7 links kept, candidate suite stays 23/23
- claude-p-fakehome-armA.* : `env -i HOME=<scratch> claude -p` (CLAUDE_CONFIG_DIR unset) creates <HOME>/.claude/{backups,sessions,projects} + <HOME>/.claude.json
