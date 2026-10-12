// PreToolUse guard: deny a tool call that names a NEW entry directly in /tmp when Orchestra gave the
// session a disk TMPDIR (agent-tmpdir.ts). /tmp is a tmpfs = RAM on Fedora; agents' literal /tmp rigs
// filled it (2026-10-12). Same shape as home-root-guard.ts (pure bash + grep, payload never expanded).

export const TMP_GUARD_MATCHER = 'Bash|Edit|MultiEdit|Write|NotebookEdit';

export const TMP_GUARD_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Denies a tool call that would create a new entry directly in /tmp
# when this session has a disk TMPDIR (ORCHESTRA_AGENT_TMPDIR). Existing entries stay allowed. Fail-open.
export LC_ALL=C
dest="\${ORCHESTRA_AGENT_TMPDIR:-}"
[ -n "$dest" ] && [ -d "$dest" ] || exit 0
troot="\${ORCHESTRA_TMP_GUARD_ROOT:-/tmp}"
command -v grep >/dev/null 2>&1 || exit 0
input="$(cat 2>/dev/null || true)"
[ -n "$input" ] || exit 0
if printf '%s' "$input" | grep -qE '"tool_name": *"Bash"'; then
  text="$(printf '%s' "$input" | sed -E 's/"(transcript_path|cwd)": *"[^"]*"//g')"
else
  text="$(printf '%s' "$input" | grep -oE '"(file_path|notebook_path)": *"[^"]*"')"
fi
[ -n "$text" ] || exit 0
cands="$(printf '%s' "$text" | sed 's/\\\\[nrt]/ /g' | grep -oE '(^|[^A-Za-z0-9_.$}~-])/tmp/[A-Za-z0-9_.+@%,=-]+' | sed 's#.*/##' | sort -u)"
bad=""
for name in $cands; do
  while [ "\${name%.}" != "$name" ]; do name="\${name%.}"; done
  [ -n "$name" ] || continue
  [ -e "$troot/$name" ] || [ -L "$troot/$name" ] && continue
  bad="$bad /tmp/$name"
done
[ -n "$bad" ] || exit 0
echo "[orchestra] BLOCKED: this call names new path(s) directly in /tmp:$bad. /tmp is RAM (tmpfs) on this host and is never cleaned until reboot. Use \\$TMPDIR instead (= $dest — disk-backed, deleted with this workspace): mktemp, os.tmpdir() and tempfile already go there; replace a literal /tmp/<name> with \\"\\$TMPDIR/<name>\\". Existing /tmp entries are unaffected." >&2
exit 2
`;
