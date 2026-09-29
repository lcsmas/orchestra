Reviewer-a17 evidence for #224 / A7+A1 (candidate release-gate-rig-rot-a17 @16749f03). Not part of the candidate.
- probe-release-gate.sh: candidate rig prelude + probes (`tomaster`, `cionly`, `untracked`, `argswallow`, `swallowminor`); copy into <candidate>/scripts/ and run `bash scripts/a17-probe.sh <probe>`; `RG_SCRIPTS_DIR=<mutant dir>` runs it against a mutant.
- mutants.py / run-mutants.sh: the release.sh/release-gate.sh mutants and the parallel runner (abs paths as run).
- a7-replace.py: single-occurrence in-place replace used for the e2e-bus-wake.mjs slice mutants (byte-exact backup + cmp).
