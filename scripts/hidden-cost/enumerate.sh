#!/usr/bin/env bash
# Hidden-cost inventory (#209, C2) — the ENUMERATION half: every grep used to find a cost site, with its
# raw hit count. `bash scripts/hidden-cost/enumerate.sh [--list CATEGORY]` prints `count<TAB>category<TAB>pattern`
# (or, with --list, every `file:line:text` hit of one category). The report
# (docs/research/hidden-cost-inventory.md) cites these category ids; nothing else is a source of counts.
# Positive control: the first line asserts the grep instrument itself finds a known-present site.
set -u
cd "$(dirname "$0")/../.." || exit 2
SRC=(src)
INC=(--include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.sh')
# Production code only: tests and the session-budget rig itself are not Orchestra's runtime.
prod() { grep -vE '\.test\.(ts|tsx|mjs)|/session-budget/|/hidden-cost/'; }
hits() { grep -rnE "$1" "${SRC[@]}" "${INC[@]}" 2>/dev/null | prod; }

declare -A CAT
CAT[sdk-control]='\.(getContextUsage|supportedModels|supportedCommands|supportedAgents|mcpServerStatus|setMcpServers|initializationResult|accountInfo|reloadPlugins|reloadSkills|applyFlagSettings|setModel|setPermissionMode|setMaxThinkingTokens|rewindFiles|interrupt|streamInput|reconnectMcpServer|toggleMcpServer|mcpAuthenticate|stopTask)\('
CAT[sdk-query]='\bquery\(\{|spawnClaudeCodeProcess|sdkQuery\('
CAT[proc-spawn]='\b(spawn|spawnSync|execFile|execFileSync|execSync|fork|pexec|pExecFile|execFileP|execFileAsync)\('
CAT[proc-exec]='\bexec\('
CAT[pty]='pty\.spawn|nodePty|spawnLocalPty'
CAT[net-fetch]='\bfetch\('
CAT[net-http]='https?\.(request|get)\(|net\.request\(|net\.(connect|createConnection)\(|new WebSocket|createServer\('
CAT[net-updater]='autoUpdater|checkForUpdates'
CAT[timer-interval]='setInterval\('
CAT[timer-timeout]='setTimeout\('
CAT[watch]='fs\.watch\(|watchFile\(|chokidar|\.watch\('
CAT[raf]='requestAnimationFrame'
CAT[css-infinite]='infinite'
CAT[npx]='npx |bunx |pnpm dlx|@latest'
CAT[git-net]="'(fetch|push|pull|ls-remote)'|\"(fetch|push|pull|ls-remote)\""
CAT[gh-cli]="'gh'|\"gh\"|gh (pr|api|run|issue)"
CAT[resource-read]='/proc/|readdir\(.*proc|ps -|tasklist|df -|du -'
CAT[hook-script]='hookTimeout|PreToolUse|PostToolUse|UserPromptSubmit|SessionStart|"Stop"'

if [ "${1:-}" = "--list" ]; then
  [ -n "${CAT[${2:-}]:-}" ] || { echo "unknown category ${2:-}: ${!CAT[*]}" >&2; exit 2; }
  if [ "$2" = css-infinite ]; then grep -rnE "${CAT[$2]}" src --include='*.css' --include='*.tsx' | prod; else hits "${CAT[$2]}"; fi
  exit 0
fi

# Positive control: a site that MUST exist (agent-sdk.ts calls getContextUsage). A zero here = broken instrument.
ctl=$(hits 'session\.q\.getContextUsage\(' | wc -l)
[ "$ctl" -ge 1 ] || { echo "INSTRUMENT BROKEN: control grep (session.q.getContextUsage) found $ctl hits" >&2; exit 3; }
echo "control ok (session.q.getContextUsage sites: $ctl)"
for k in $(printf '%s\n' "${!CAT[@]}" | sort); do
  if [ "$k" = css-infinite ]; then n=$(grep -rnE "${CAT[$k]}" src --include='*.css' --include='*.tsx' | prod | wc -l)
  else n=$(hits "${CAT[$k]}" | wc -l); fi
  printf '%s\t%s\t%s\n' "$n" "$k" "${CAT[$k]}"
done
