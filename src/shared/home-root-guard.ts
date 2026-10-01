// PreToolUse guard: deny a tool call that names a NEW entry directly in $HOME.
// Agents piled rigs/logs/notes at ~ root (~250 entries, ~18 GB by 2026-10-01);
// prose rules did not hold, so this is enforced. Pure-bash + grep, no jq; never
// expands the payload in bash (O(n²) on big payloads — see hook-cost-t11-d20).
// Lives in shared/ so the test runs THIS string, not a copy.

/** Tools the guard intercepts. Bash scans the whole call; file tools only their
 * target path (never Write `content`). */
export const HOME_ROOT_GUARD_MATCHER = 'Bash|Edit|MultiEdit|Write|NotebookEdit';

/** Per-workspace, disk-backed scratch dir the deny message points agents at. */
export const AGENT_TMP_REL = '.orchestra/agent-tmp';

export const HOME_ROOT_GUARD_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Denies a tool call that would create a new entry
# directly in $HOME. Existing entries and dot-entries stay allowed. Fail-open.
export LC_ALL=C
home="\${HOME:-}"
case "$home" in ''|/) exit 0 ;; esac
command -v grep >/dev/null 2>&1 || exit 0
input="$(cat 2>/dev/null || true)"
[ -n "$input" ] || exit 0
if printf '%s' "$input" | grep -qE '"tool_name": *"Bash"'; then
  text="$input"
else
  text="$(printf '%s' "$input" | grep -oE '"(file_path|notebook_path)": *"[^"]*"')"
fi
[ -n "$text" ] || exit 0
hre="$(printf '%s' "$home" | sed 's/[][\\.*^$+?(){}|]/\\\\&/g')"
re='(^|[^A-Za-z0-9_.-])(~|\\$HOME|\\$\\{HOME\\}|'"$hre"')/[A-Za-z0-9_+@%,=-][A-Za-z0-9_.+@%,=-]*'
cands="$(printf '%s' "$text" | sed 's/\\\\[nrt]/ /g' | grep -oE "$re" | sed 's#.*/##' | sort -u)"
bad=""
for name in $cands; do
  while [ "\${name%.}" != "$name" ]; do name="\${name%.}"; done
  [ -n "$name" ] || continue
  [ -e "$home/$name" ] || [ -L "$home/$name" ] && continue
  bad="$bad $home/$name"
done
[ -n "$bad" ] || exit 0
dest="$home/${AGENT_TMP_REL}/\${ORCHESTRA_WS_ID:-<this-workspace-id>}"
echo "[orchestra] BLOCKED: this call names new path(s) directly in the home directory:$bad. The top of \\$HOME belongs to the user — put rigs, logs, notes and build copies under $dest/ instead (mkdir -p it; disk-backed, survives reboots). Existing home entries are unaffected. If you are only MENTIONING such a path, write it relative to that scratch dir. If the user explicitly asked for this exact path, ask them to create it first." >&2
exit 2
`;
