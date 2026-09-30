# Hidden-cost inventory harness (#209, ledger #237 track C2)

`scripts/hidden-cost/` measures what Orchestra **multiplies** without anyone asking — per session start, per turn / tool call,
per background tick, per workspace, per app run — on the real code, with zero tokens (fake API, net+pid namespaces, scratch
HOME/config; D6/D7). The findings and the ranked list live in **`docs/research/hidden-cost-inventory.md`**; raw evidence in
`docs/research/hidden-cost-inventory/evidence/`. It builds on C1's session-budget harness (`session-budget.md`) and adds no budget
number (those stay in `src/shared/session-budget.ts`).

| Piece | File | Role |
|---|---|---|
| Enumeration | `enumerate.sh` | grep categories (SDK control, spawns incl. `simple-git`, net, timers, watchers, rAF, CSS, hooks…) with counts and `--list`; a control grep fails loudly (rc 3) if the instrument breaks |
| Exec/connect/DNS logger | `execlog/execlog.c` (+ `build.sh`) | `LD_PRELOAD` shim: every `exec*`/`posix_spawn*`/`connect`/`getaddrinfo` of a process tree, monotonic ms, argv |
| Whole-app rig | `app-idle-rig.sh` → `.mjs` (arms in `run-app-arms.sh`) | the BUILT app, N seeded worktrees, own sway + bwrap net/pid ns; windows: warm, steady, hidden (sway `get_tree` proof), running rows, focus cycles, Resources/Bus page, real sessions streaming (`--sessions`, `--stream-on`); CPU per process class from `/proc` (`cutime/cstime` = reaped `git`/`gh`); VOID on a renderer stall (retried) |
| Session scenarios | `session-scenario.mjs` → `scenario-runner.mjs`, `fake-api-tools.mjs` | multi-turn real-CLI sessions with tool calls, streamed deltas, http-MCP, model probe, `--parity 1` (CLI non-essential traffic left on); per-window API requests / spawns / CPU per class / renderer-IPC events |
| Per-firing micro-benches | `hook-cost.sh`, `git-poll-cost.sh`, `loop-scan-cost.sh`, `proc-table-cost.sh`, `cli-cost.sh`, `npx-mcp-cost.sh` | one sweep/spawn on real data |
| FIELD (read-only) | `fleet-census.mjs`, `live-children-watch.py`, `field-notes.py` | live process classes + `VmRSS`, the live app's child spawns, store shape, renderer-CPU warnings |
| Report tooling | `run-all.sh`, `render-tables.py`, `derive.py`, `check-anchors.py` | regenerate all evidence; tables; every extrapolation with its formula; every `path:line` cited in the report verified against `evidence/anchors.tsv` |

Traps (each cost a wrong number once): `statm × 4` reads **4× low on a 16 KB-page host** — read `VmRSS`; a `--jq` `gh` stub must print
nothing for an empty list; `swaymsg [pid=…]` cannot address a window from inside a pid namespace; `spawnSync` hooks deadlock against a
hooks server in the same process; `--hooks 0` does not remove hooks (agent-sdk installs them); the installed AppImage cannot FUSE-mount
inside bwrap (measure `orchestra` outside).
