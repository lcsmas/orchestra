#!/usr/bin/env python3
# Verifier (seat 1, #389 FINAL): generate probe-hunk mutants for src/main/linux-keyring.ts + rig-world mutants for src/shared/keyring-rig-world.ts.
# Each find-string is checked LIVE against the working tree (exactly one hit) and the spec is written only for the ones that apply.
import os, sys
root = sys.argv[1]
out = os.environ['TMPDIR'] + '/v1/mut389f'
os.makedirs(out, exist_ok=True)
KR = 'src/main/linux-keyring.ts'
RW = 'src/shared/keyring-rig-world.ts'
M = [
  ('pm1-retry-slow-failures', KR, "retry: quick && !reply,", "retry: !reply,"),
  ('pm2-retry-replies', KR, "retry: quick && !reply,", "retry: quick,"),
  ('pm3-never-retry', KR, "retry: quick && !reply,", "retry: false,"),
  ('pm4-spawn-error-not-retried', KR, "return { state: 'unavailable', retry: true, note: `spawn ${a.spawnError} (${a.elapsedMs} ms)` };", "return { state: 'unavailable', retry: false, note: `spawn ${a.spawnError} (${a.elapsedMs} ms)` };"),
  ('pm5-quick-ms-5000', KR, "export const QUICK_FAIL_MS = 50;", "export const QUICK_FAIL_MS = 5000;"),
  ('pm6-retry-budget-check-off', KR, "if (attempt > 1 && remaining < 500) break;", "if (false) break;"),
  ('pm7-second-attempt-full-wait', KR, "String(Math.ceil((attempt === 1 ? waitMs : remaining) / 10))", "String(Math.ceil(waitMs / 10))"),
  ('pm8-iteration-counted-wait', KR, "while alive; do tick; [ \"$t\" -lt \"$deadline\" ] || break; sleep ${WRAPPER_TICK}; done", "n=0; while alive; do n=$((n+1)); [ \"$n\" -lt \"$limit\" ] || break; sleep ${WRAPPER_TICK}; done"),
  ('pm9-kill-on-deadline', KR, "if alive; then exit 3; fi", "if alive; then kill $pid; exit 3; fi"),
  ('pm10-notes-dropped', KR, "if (last.note) note(", "if (false) note("),
  ('pm11-retry-delay-0', KR, "export const RETRY_DELAY_MS = 100;", "export const RETRY_DELAY_MS = 0;"),
  ('pm12-reply-regex-anchored', KR, "/GDBus\\.Error:/.test(a.stderrLine)", "/^GDBus\\.Error:/.test(a.stderrLine)"),
  ('pm13-three-attempts', KR, "export const MAX_PROBE_ATTEMPTS = 2;", "export const MAX_PROBE_ATTEMPTS = 3;"),
  ('pm14-retry-on-unparseable-answer', KR, "return { state, retry: false, note: state === 'unavailable'", "return { state, retry: state === 'unavailable', note: state === 'unavailable'"),
  ('pm15-stderr-line-uncapped', KR, ".slice(0, 160);", ";"),
  ('pm16-tick-0.1', KR, "export const WRAPPER_TICK = '0.01';", "export const WRAPPER_TICK = '0.1';"),
  ('rw1-samedev-check-off', RW, "if (sameDev.length > 0) return", "if (false) return"),
  ('rw2-samedev-only-adjacent', RW, "const sameDev = here.filter((m) => m !== top && m.dev === top.dev);", "const sameDev = here.filter((m) => m !== top && m.dev === top.dev && m.id === top.parent);"),
  ('rw3-known-filter-off', RW, "if (cands.length > 1) cands = cands.filter((k) => known.has(Number(tok[k])));", "if (cands.length > 1) cands = cands.slice(0, 1);"),
  ('rw4-unique-shape-needs-known', RW, "if (cands.length === 1) pairs.push", "if (cands.length === 1 && known.has(Number(tok[cands[0]]))) pairs.push"),
  ('rw5-proc-net-unix-byte-exact-trimmed', RW, "if (m[2] !== undefined && m[2].startsWith('/')) sockets.push({ inode, path: m[2] });", "if (m[2] !== undefined && m[2].startsWith('/')) sockets.push({ inode, path: m[2].trim() });"),
  ('rw6-peer-path-dropped', RW, "const peerPath = peer ? scan.pathByIno.get(peer) : undefined;", "const peerPath = undefined as string | undefined;"),
]
spec = []
for name, f, old, new in M:
    s = open(os.path.join(root, f)).read()
    n = s.count(old)
    if n != 1:
        print(f"SKIP {name}: find-string occurs {n}x in {f}")
        continue
    open(f"{out}/{name}.old", 'w').write(old)
    open(f"{out}/{name}.new", 'w').write(new)
    spec.append(f"{name}|{f}")
open(f"{out}/spec.txt", 'w').write('\n'.join(spec) + '\n')
print(f"{len(spec)} mutants written to {out}")
