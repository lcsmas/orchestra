# Verifier seat 3 (vague #388) — #393 human tabs rig, run from a COPY outside the tree (it checks nothing out)
Depends on seat 1's `scripts/verifier-388/{lib,g10,g10b,bp-drive,mut}.*` (branch verif-barriere-navigateur-388): copy both dirs side by side into one `$TMPDIR/v3rig/`.
- `tabs-drive.mjs <app-dir> <label> [all|arms]` — built-app drive of the tab strip (real clicks, grim pixels, restart graceful/SIGKILL, cap, Help overlay, 2 workspaces, archive); run via `rigrun.sh <name> <tree> tabs-drive.mjs <label> all` (G10+G10b around it).
- `urlbar-series.sh N cand base prefix|full` — seat 1's bp-drive (`bp-prefix.mjs` = up to the first-navigation clause), candidate/base INTERLEAVED, tally of the URL-bar clause.
- `mut393.sh` + `drivemut393.sh` + `mut/` — own built-app mutants (string verified live, clean rebuild, byte-exact restore via mut.sh).
