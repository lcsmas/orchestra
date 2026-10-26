#!/usr/bin/env python3
# Verifier (seat 1, #389 FINAL): generate probe-hunk mutants for src/main/linux-keyring.ts + rig-world mutants for src/shared/keyring-rig-world.ts.
# Each find-string is checked LIVE against the working tree (exactly one hit) and the spec is written only for the ones that apply.
import os, sys
root = sys.argv[1]
out = os.environ['TMPDIR'] + '/v1/mut389f'
os.makedirs(out, exist_ok=True)
KR = 'src/main/linux-keyring.ts'
RW = 'src/shared/keyring-rig-world.ts'
RP = 'scripts/lib/rig-paths.mjs'
M = [
  ('pm1-retry-the-deadline', KR, "retry: !reply && a.status !== 3,", "retry: !reply,"),
  ('pm2-retry-replies', KR, "retry: !reply && a.status !== 3,", "retry: a.status !== 3,"),
  ('pm3-never-retry', KR, "retry: !reply && a.status !== 3,", "retry: false,"),
  ('pm4-spawn-error-not-retried', KR, "return { state: 'unavailable', retry: true, note: `spawn ${a.spawnError} (${a.elapsedMs} ms)` };", "return { state: 'unavailable', retry: false, note: `spawn ${a.spawnError} (${a.elapsedMs} ms)` };"),
  ('pm5-budget-0', KR, "export const MIN_RETRY_BUDGET_MS = 500;", "export const MIN_RETRY_BUDGET_MS = 0;"),
  ('pm6-budget-ignores-retry-delay', KR, "waitMs - (Date.now() - t0) - RETRY_DELAY_MS >= MIN_RETRY_BUDGET_MS", "waitMs - (Date.now() - t0) >= MIN_RETRY_BUDGET_MS"),
  ('pm7-second-attempt-full-wait', KR, "String(Math.ceil((attempt === 1 ? waitMs : remaining) / 10))", "String(Math.ceil(waitMs / 10))"),
  ('pm8-iteration-counted-wait', KR, "while alive; do tick; [ \"$t\" -lt \"$deadline\" ] || break; sleep ${WRAPPER_TICK}; done", "n=0; while alive; do n=$((n+1)); [ \"$n\" -lt \"$limit\" ] || break; sleep ${WRAPPER_TICK}; done"),
  ('pm9-kill-on-deadline', KR, "if alive; then exit 3; fi", "if alive; then kill $pid; exit 3; fi"),
  ('pm10-notes-dropped', KR, "if (last.note) note(", "if (false) note("),
  ('pm11-retry-delay-0', KR, "export const RETRY_DELAY_MS = 100;", "export const RETRY_DELAY_MS = 0;"),
  ('pm12-reply-regex-anchored', KR, "/GDBus\\.Error:/.test(a.stderrLine)", "/^GDBus\\.Error:/.test(a.stderrLine)"),
  ('pm13-three-attempts', KR, "export const MAX_PROBE_ATTEMPTS = 2;", "export const MAX_PROBE_ATTEMPTS = 3;"),
  ('pm14-retry-on-unparseable-answer', KR, "return { state, retry: false, note: state === 'unavailable'", "return { state, retry: state === 'unavailable', note: state === 'unavailable'"),
  ('pm15-stderr-line-uncapped', KR, ".slice(0, 160);", ";"),
  ('pm17-clean-misses-c1', KR, "const CONTROL_CHARS = /[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]/g;", "const CONTROL_CHARS = /[\\u0000-\\u001f\\u007f]/g;"),
  ('pm18-notes-not-json-quoted', KR, "probe-notes=${JSON.stringify(notes.map(cleanNote).join('; '))}", "probe-notes=\"${notes.map(cleanNote).join('; ')}\""),
  ('pm19-facts-notes-not-cleaned', KR, "JSON.stringify(notes.map(cleanNote).join('; '))", "JSON.stringify(notes.join('; '))"),
  ('pm20-retry-note-always-says-retrying', KR, "const willRetry = last.retry && attempt < MAX_PROBE_ATTEMPTS && waitMs - (Date.now() - t0) - RETRY_DELAY_MS >= MIN_RETRY_BUDGET_MS;\n      if (last.note) note(`probe#${attempt} ${last.note}${willRetry ? ' — retrying once' : ''}`);", "const willRetry = last.retry && attempt < MAX_PROBE_ATTEMPTS && waitMs - (Date.now() - t0) - RETRY_DELAY_MS >= MIN_RETRY_BUDGET_MS;\n      if (last.note) note(`probe#${attempt} ${last.note}${last.retry ? ' — retrying once' : ''}`);"),
  ('rw1-samedev-check-off', RW, "if (sameDev.length > 0) return", "if (false) return"),
  ('rw3-known-filter-off', RW, "if (cands.length > 1) cands = cands.filter((c) => known.has(c.localIno) && (c.peerIno === 0 || known.has(c.peerIno)));", "if (cands.length > 1) cands = cands.slice(0, 1);"),
  ('rw4-known-filter-ignores-peer', RW, "(c.peerIno === 0 || known.has(c.peerIno))", "true"),
  ('rw5-proc-net-unix-trimmed', RW, "if (m[2] !== undefined && m[2].startsWith('/')) sockets.push({ inode, path: m[2] });", "if (m[2] !== undefined && m[2].startsWith('/')) sockets.push({ inode, path: m[2].trim() });"),
  ('rw6-peer-path-dropped', RW, "const peerPath = peer ? scan.pathByIno.get(peer) : undefined;", "const peerPath = undefined as string | undefined;"),
  ('rw7-tail-anything', RW, "const tailOk = (toks: readonly string[]): boolean => toks.every(", "const tailOk = (toks: readonly string[]): boolean => true || toks.every("),
  ('rw8-marker-not-required', RW, "if (SS_MARKERS.has(tok[j + 1] ?? '') && tailOk(tok.slice(j + 1)))", "if (tailOk(tok.slice(j + 1)))"),
  ('rw9-about-never', RW, "return unparsed.filter((row) => row.split(/\\s+/).some((t) => /^\\d+$/.test(t) && interest.has(Number(t))));", "return [];"),
  ('rw10-about-always', RW, "return unparsed.filter((row) => row.split(/\\s+/).some((t) => /^\\d+$/.test(t) && interest.has(Number(t))));", "return [...unparsed];"),
  ('rw11-embryonic-kept', RW, "    if (inode === 0) continue; // an embryonic socket", "    // an embryonic socket"),
  ('rw12-marker-set-misses-dashes', RW, "const SS_MARKERS = new Set(['<->', '-->', '<--', '---']);", "const SS_MARKERS = new Set(['<->', '-->', '<--']);"),
  ('rw13-ambiguity-takes-first', RW, "if (cands.length === 1) pairs.push(cands[0]);\n    else unparsed.push(line);", "if (cands.length >= 1) pairs.push(cands[0]);\n    else unparsed.push(line);"),
  ('pa1-one-hop-only', RP, "for (let hops = 0; hops < 40; hops++)", "for (let hops = 0; hops < 1; hops++)"),
  ('pa2-hop-forms-dropped', RP, "out.push(target, physicalPath(target));", "out.push(target);"),
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
