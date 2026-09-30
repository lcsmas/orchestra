// A `claude` WRAPPER for the CLI-version re-run rigs (#211): stands in for `~/.local/bin/claude` on PATH.
//   --version           prints the installed version (each version is its OWN file; `claude` is a symlink re-pointed on
//                       update, exactly like the real install — a `--version` file that merely changed content would not move
//                       realpath+mtime, which is what the watcher's probe memo keys on)
//   anything else       = a session start: appends `<pid> start nice=<n>` to starts.log (the rigs' INDEPENDENT count of
//                       suite runs), then per `mode`: pass (exec the real claude) | inflate (a CLI update that adds count_tokens
//                       calls at startup, then exec) | hang (never answers) | slow (sleeps 45 s, then exec) | deadapi (API base URL points at a dead port)
import fs from 'node:fs';
import path from 'node:path';

function body(root, version, realClaude) {
  return `#!/bin/bash
ROOT=${JSON.stringify(root)}
if [ "$1" = "--version" ]; then printf '%s (Claude Code)\\n' ${JSON.stringify(version)}; exit 0; fi
echo "$$ start nice=$(awk '{print $19}' /proc/self/stat)" >> "$ROOT/starts.log"
mode="$(cat "$ROOT/mode" 2>/dev/null)"
burst() {
  local hp="\${ANTHROPIC_BASE_URL#http://}"; local host="\${hp%%:*}"; local port="\${hp##*:}"; port="\${port%%/*}"
  for i in 1 2 3 4 5 6; do
    exec 3<>"/dev/tcp/$host/$port" || return
    printf 'POST /v1/messages/count_tokens?beta=true HTTP/1.1\\r\\nHost: %s\\r\\nContent-Type: application/json\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}' "$hp" >&3
    cat <&3 >/dev/null; exec 3>&-
  done
}
case "$mode" in
  inflate) burst ;;
  hang) exec sleep 600 ;;
  slow) sleep 45 ;;
  deadapi) export ANTHROPIC_BASE_URL=http://127.0.0.1:9 ;; # the API never answers: the subject mounts but no first reply (VOID)
esac
exec ${JSON.stringify(realClaude)} "$@"
`;
}

export function makeShim(dir) {
  fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'starts.log'), '');
  fs.writeFileSync(path.join(dir, 'mode'), 'pass');
}
export const starts = (dir) => fs.readFileSync(path.join(dir, 'starts.log'), 'utf8').split('\n').filter(Boolean);
export const setMode = (dir, m) => fs.writeFileSync(path.join(dir, 'mode'), m);
/** Install versions/<v> and flip the `claude` symlink to it — what `claude update` does. */
export function setVersion(dir, v, realClaude) {
  const file = path.join(dir, 'versions', v);
  fs.writeFileSync(file, body(dir, v, realClaude), { mode: 0o755 });
  const link = path.join(dir, 'claude');
  fs.rmSync(link, { force: true });
  fs.symlinkSync(file, link);
}
