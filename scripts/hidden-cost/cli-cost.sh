#!/usr/bin/env bash
# C2 #209 — cost of ONE `orchestra <verb>` invocation (every hook / agent / skill call pays it): wall, CPU (user+sys of the
# whole process tree), process count (LD_PRELOAD exec logger). `orchestra` = the machine's own shim (execs the installed AppImage).
#   bash scripts/hidden-cost/cli-cost.sh [runs=10] [verb args...]      default verb: help
set -u
runs="${1:-10}"; shift || true
verb=("${@:-help}")
here="$(cd "$(dirname "$0")" && pwd)"
so="$here/execlog/execlog.so"; [ -f "$so" ] || bash "$here/execlog/build.sh" >&2
bin="$(command -v orchestra)"; [ -n "$bin" ] || { echo "no orchestra on PATH" >&2; exit 2; }
img="$(grep -o '"[^"]*\.AppImage"' "$bin" | tr -d '"' | head -1)"
echo "orchestra=$bin -> $img ($(stat -c %s "$img" 2>/dev/null) bytes) load=$(cut -d' ' -f1-3 /proc/loadavg) verb='${verb[*]}'"
tmp="$(mktemp -d)"; TIMEFORMAT='%3R %3U %3S'
for i in $(seq "$runs"); do
  : > "$tmp/exec.$i"
  { time env LD_PRELOAD="$so" EXECLOG_FILE="$tmp/exec.$i" "$bin" "${verb[@]}" >/dev/null 2>&1 ; } 2>"$tmp/t.$i"
done
python3 - "$tmp" "$runs" <<'PY'
import sys, statistics as st
d, n = sys.argv[1], int(sys.argv[2])
w, c, p, kinds = [], [], [], {}
for i in range(1, n + 1):
    r, u, s = open(f'{d}/t.{i}').read().split()[:3]
    w.append(float(r) * 1000); c.append((float(u) + float(s)) * 1000)
    ex = [l for l in open(f'{d}/exec.{i}') if l.startswith('EXEC ')]
    p.append(len(ex))
    for l in ex:
        k = l.split()[4].split('/')[-1]; kinds[k] = kinds.get(k, 0) + 1
print(f"runs={n}  wall median {st.median(w):.0f} ms (min {min(w):.0f}, max {max(w):.0f})  cpu(user+sys) median {st.median(c):.0f} ms  processes/call median {st.median(p):.0f}")
print("exec kinds per call:", {k: round(v / n, 1) for k, v in sorted(kinds.items(), key=lambda kv: -kv[1])[:8]})
PY
rm -rf "$tmp"
