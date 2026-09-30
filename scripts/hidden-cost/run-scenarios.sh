#!/usr/bin/env bash
# C2 #209 — the session scenarios behind the report's per-session / per-turn / per-tool-call numbers, one fresh process each
# (bwrap net+pid ns, fake API, zero tokens). Output: $OUT/scn-<label>.json + a RUN-LOG. Never loop this (D7): ~7 min total.
#   OUT=docs/research/hidden-cost-inventory/evidence bash scripts/hidden-cost/run-scenarios.sh
set -u
cd "$(dirname "$0")/../.."
OUT="${OUT:-$HOME/.cache/hidden-cost/scn}"; mkdir -p "$OUT"
N="node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/hidden-cost/session-scenario.mjs"
run() { local label="$1"; shift; echo "== $label: $*"; $N --label "$label" --out "$OUT/scn-$label.json" "$@" > "$OUT/scn-$label.stdout" 2> "$OUT/scn-$label.stderr"; echo "   rc=$? out=$OUT/scn-$label.json"; }
pnpm run build:keeper >/dev/null 2>&1 || { echo "build:keeper failed" >&2; exit 2; }
run base        --turns 0,1,3 --idle 60 --hooks 1                       # hooks ON: per-turn / per-tool-call / idle
run nohooks     --turns 0,1,3 --idle 30 --hooks 0                       # same without Orchestra's hooks: the hook delta
run stream      --turns 0:600,0:2000 --idle 5 --hooks 0                 # streamed text deltas: renderer-IPC events/bytes per turn
run probe       --turns 0 --idle 5 --hooks 0 --probe-models 1           # cold-workspace model picker: throwaway CLI cost
run httpmcp     --turns 0 --idle 90 --hooks 0 --http-mcp 2             # 2 remote (http) MCP servers: connection attempts at start + idle retries
echo "ALL-SCENARIOS-DONE"
