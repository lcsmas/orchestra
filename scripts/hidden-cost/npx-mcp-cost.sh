#!/usr/bin/env bash
# C2 #209 — cost of ONE start of an `npx -y <pkg>` stdio MCP server (metarepo's .mcp.json ships
# `npx -y @modelcontextprotocol/server-filesystem .`; every metarepo session start pays it): processes, wall to first MCP reply,
# CPU, and every DNS/connect the tree attempts (each = a registry request). Uses the machine's real npm cache (~/.npm) and the
# real network — the same thing the CLI does at each session start. NO Anthropic API involved.
#   bash scripts/hidden-cost/npx-mcp-cost.sh [runs=5] [pkg=@modelcontextprotocol/server-filesystem]
set -u
runs="${1:-5}"; pkg="${2:-@modelcontextprotocol/server-filesystem}"
here="$(cd "$(dirname "$0")" && pwd)"
so="$here/execlog/execlog.so"; [ -f "$so" ] || bash "$here/execlog/build.sh" >&2
tmp="$(mktemp -d)"; TIMEFORMAT='%3R %3U %3S'
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"hc","version":"0"}}}'
echo "pkg=$pkg load=$(cut -d' ' -f1-3 /proc/loadavg) npm=$(npm --version) prefer-offline=$(npm config get prefer-offline)"
for i in $(seq "$runs"); do
  : > "$tmp/log.$i"
  # send initialize, wait for the first reply line, then close stdin (server exits)
  { time env LD_PRELOAD="$so" EXECLOG_FILE="$tmp/log.$i" bash -c '
      coproc S { npx -y '"$pkg"' /tmp 2>/dev/null; }
      printf "%s\n" "$0" >&"${S[1]}"
      read -r -t 60 line <&"${S[0]}" && echo "REPLY_OK" >"'"$tmp"'/reply.'"$i"'" || echo "NO_REPLY" >"'"$tmp"'/reply.'"$i"'"
      exec {S[1]}>&-; wait' "$init" >/dev/null 2>&1 ; } 2>"$tmp/t.$i"
done
python3 - "$tmp" "$runs" <<'PY'
import sys, statistics as st, collections
d, n = sys.argv[1], int(sys.argv[2])
w, c, p, dns, con, kinds, ok = [], [], [], collections.Counter(), collections.Counter(), collections.Counter(), 0
for i in range(1, n + 1):
    r, u, s = open(f'{d}/t.{i}').read().split()[:3]
    w.append(float(r) * 1000); c.append((float(u) + float(s)) * 1000)
    ok += open(f'{d}/reply.{i}').read().strip() == 'REPLY_OK'
    lines = open(f'{d}/log.{i}').read().splitlines()
    ex = [l for l in lines if l.startswith('EXEC ')]; p.append(len(ex))
    for l in ex: kinds[l.split()[4].split('/')[-1]] += 1
    for l in lines:
        f = l.split()
        if f[0] == 'DNS': dns[f[3]] += 1
        if f[0] == 'CONNECT' and f[3] in ('inet', 'inet6'): con[' '.join(f[4:])] += 1
print(f"runs={n} replies_ok={ok}/{n}  wall to reply+exit median {st.median(w):.0f} ms (min {min(w):.0f} max {max(w):.0f})  cpu(user+sys) median {st.median(c):.0f} ms  processes/start median {st.median(p):.0f}")
print("exec kinds per start:", {k: round(v / n, 1) for k, v in kinds.most_common(8)})
print("DNS lookups per start:", {k: round(v / n, 1) for k, v in dns.most_common()})
print("inet connects per start:", {k: round(v / n, 1) for k, v in con.most_common(6)})
PY
rm -rf "$tmp"
