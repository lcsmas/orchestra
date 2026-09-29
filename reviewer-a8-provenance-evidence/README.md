reviewer-a8-provenance evidence for ledger #224 (A8 #235, candidate `inherit-no-strip-a8` @865c4deb == content of cb07953f: account-inherit.ts/.test.ts/accounts-usage.md sha256 + patch-id identical).
Scratch-only rigs (paths hardcoded to the reviewer worktree + /home/lmas/rva8/scr; the rig refuses anything outside scratch or under ~/.claude*; no app boot).
- run2-S0-S5-on-tip.txt   : prior reviewer's S0–S5 real-geometry probes re-run at the tip (cand 7/7 links every shape; master 0–5)
- run4-attack-arms.txt    : D (foreign sync writes nothing: fs-write spy + mtime/ino fingerprint, 12 arms + 2 positive controls), A (HOME spellings, HOME renamed, poisoned stamp), B (legacy+alias+dangling), C (links present, manifest emptied/absent/torn), E (MCP half keyed on ~/.claude only), F (fresh account)
- run5-extra-arms.txt     : relative legacy links, symlinked login dir, skills-only legacy account, sequential fake→real
- mut-M1-M21.txt          : 11 in-place mutants of account-inherit.ts (byte-exact backup + cmp restore) run through the candidate's own test file: 4 survive (M1 M2 M14 M18)
- proto-on-disk-links.patch + run7-C-proto.txt : prototype remedy for C (judge existing symlinks at managed paths, not only manifest-listed) — closes all 12 C arms, breaks the candidate's 're-home: delete the manifest' arm (1/41 red) => spec call
- tsc.txt                 : npx tsc --noEmit on the candidate = rc 0
