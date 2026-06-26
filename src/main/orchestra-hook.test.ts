import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The activity-event writer hook (ORCHESTRA_HOOK_SCRIPT in workspaces.ts) is
// pure bash and is the piece most prone to subtle concurrency bugs: several
// hook processes (pretool/posttool/stop) can fire microseconds apart and each
// must claim a DISTINCT, strictly-increasing seq, or the reader's exactly-once
// dedup would either drop real events (two share a seq) or fail to dedup. We
// keep an in-test copy of just the seq-allocation + append core and exercise it
// against the real filesystem with genuinely concurrent invocations.
//
// This mirrors the script in workspaces.ts; if that script changes, this copy
// must change with it. It is intentionally a copy rather than an import because
// the source embeds the script as a TS template literal inside a module that
// pulls in electron.
const HOOK = `#!/usr/bin/env bash
dir="\${ORCHESTRA_EVENTS_DIR:-$HOME/.orchestra/events}"
[ -n "\${ORCHESTRA_WS_ID:-}" ] || exit 0
event="\${1:-}"
[ -n "$event" ] || exit 0
mkdir -p "$dir" 2>/dev/null || true
spool="$dir/$ORCHESTRA_WS_ID.jsonl"
seqf="$dir/$ORCHESTRA_WS_ID.seq"
seq=0
if command -v flock >/dev/null 2>&1; then
  exec 9>>"$seqf"
  if flock -w 2 9; then
    cur="$(cat "$seqf" 2>/dev/null)"
    case "$cur" in ''|*[!0-9]*) cur=0 ;; esac
    seq=$((cur + 1))
    printf '%s' "$seq" >"$seqf"
  fi
  exec 9>&-
fi
printf '{"seq":%s,"event":"%s","tool":"%s"}\\n' "$seq" "$event" "" >> "$spool"
exit 0
`;

function setup(): { dir: string; script: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-hook-'));
  const script = path.join(dir, 'orchestra-hook.sh');
  fs.writeFileSync(script, HOOK, { mode: 0o755 });
  return {
    dir,
    script,
    env: { ...process.env, ORCHESTRA_EVENTS_DIR: dir, ORCHESTRA_WS_ID: 'ws-test' },
  };
}

function readSeqs(dir: string): number[] {
  const spool = path.join(dir, 'ws-test.jsonl');
  if (!fs.existsSync(spool)) return [];
  return fs
    .readFileSync(spool, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { seq: number }).seq);
}

const hasFlock = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v flock'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('sequential invocations produce strictly increasing seqs from 1', () => {
  const { dir, script, env } = setup();
  for (const ev of ['submit', 'pretool', 'posttool', 'stop']) {
    execFileSync('bash', [script, ev], { env });
  }
  const seqs = readSeqs(dir);
  assert.deepEqual(
    seqs,
    hasFlock ? [1, 2, 3, 4] : [0, 0, 0, 0],
    'each event gets the next seq (or all 0 on a flock-less host)',
  );
});

test('concurrent invocations never duplicate or skip a seq', { skip: !hasFlock }, async () => {
  const { dir, script, env } = setup();
  // Fire many writers at once; flock must serialize the read-bump-write so the
  // multiset of seqs is exactly 1..N with no gaps and no repeats.
  const N = 50;
  await Promise.all(
    Array.from({ length: N }, (_unused, i) => {
      const ev = ['submit', 'pretool', 'posttool', 'notify', 'stop'][i % 5];
      return new Promise<void>((resolve, reject) => {
        import('node:child_process').then(({ execFile }) => {
          execFile('bash', [script, ev], { env }, (err) => (err ? reject(err) : resolve()));
        });
      });
    }),
  );
  const seqs = readSeqs(dir).sort((a, b) => a - b);
  assert.equal(seqs.length, N, 'every invocation appended exactly one line');
  assert.deepEqual(
    seqs,
    Array.from({ length: N }, (_u, i) => i + 1),
    'seqs are exactly 1..N — no duplicate (collision) and no gap (lost bump)',
  );
});

test('a fresh start re-uses the wsid file path (rotation/restart resets counter externally)', () => {
  // The counter file is the single source of the next seq; deleting it (as the
  // startEventsSpool startup wipe does) restarts numbering from 1, which is
  // consistent because the reader's cursor lastSeq is also 0 on a fresh run.
  const { dir, script, env } = setup();
  execFileSync('bash', [script, 'submit'], { env });
  fs.rmSync(path.join(dir, 'ws-test.seq'), { force: true });
  fs.rmSync(path.join(dir, 'ws-test.jsonl'), { force: true });
  execFileSync('bash', [script, 'submit'], { env });
  assert.deepEqual(readSeqs(dir), hasFlock ? [1] : [0], 'numbering restarts from 1 after a wipe');
});
