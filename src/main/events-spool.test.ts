import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Headless reproduction of the activity-spool READER (events-spool.ts `drain`).
//
// Symptom from the field: a turn-end (`stop`/`notify`) is sitting in the durable
// spool, in correct seq order, but the status dot stays `running` — the reader
// never applied those trailing events, and never recovers them.
//
// `drain` is pure logic over (a file, a cursor, an apply callback), so we can
// replay it headlessly. This is a FAITHFUL COPY of events-spool.ts:99-170 (minus
// rotation, and with `apply` injected in place of `applyAgentEvent`); if that
// function changes, this copy must change with it. The point is to exercise the
// exact cursor/offset/dedup logic against a real filesystem spool.
//
// The defect this guards against: `cur.offset` / `cur.lastSeq` advance as a
// batch is processed, so if an apply throws — or is skipped because the reader
// has no window — the event is consumed-but-not-applied and never re-read,
// permanently stranding the turn-ending `stop`/`notify` (dot stuck `running`).
// The fix, mirrored in this copy: (1) early-return when there is no window so
// events aren't consumed before they can be applied, and (2) isolate each apply
// in try/catch so one throw can't abort the batch and strand the events behind
// it. These tests assert the stranding can no longer happen.

interface Cursor {
  offset: number;
  buffer: string;
  lastSeq: number;
  prevSize: number;
  persistedSeq: number;
}
const newCursor = (): Cursor => ({ offset: 0, buffer: '', lastSeq: 0, prevSize: 0, persistedSeq: 0 });

// Faithful copies of events-spool.ts's reader-cursor persistence (the
// "notification replay on relaunch" fix): the highest-applied seq survives an
// app restart in a `.cursor` file beside the spool, so a spool KEPT across the
// startup wipe (live detached keeper) dedups against the PREVIOUS run instead
// of replaying — and re-notifying — every line from seq 0.
function loadPersistedSeq(cursorPath: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) as { lastSeq?: unknown };
    return typeof raw.lastSeq === 'number' && Number.isFinite(raw.lastSeq) && raw.lastSeq > 0
      ? raw.lastSeq
      : 0;
  } catch {
    return 0;
  }
}
function persistSeq(cursorPath: string, cur: Cursor): void {
  if (cur.lastSeq <= cur.persistedSeq) return;
  fs.writeFileSync(`${cursorPath}.tmp`, JSON.stringify({ lastSeq: cur.lastSeq }));
  fs.renameSync(`${cursorPath}.tmp`, cursorPath);
  cur.persistedSeq = cur.lastSeq;
}
/** A fresh run's cursor, seeded from the persisted mark like drain() does. */
function restoredCursor(cursorPath: string): Cursor {
  const persisted = loadPersistedSeq(cursorPath);
  return { offset: 0, buffer: '', lastSeq: persisted, prevSize: 0, persistedSeq: persisted };
}

/** Faithful copy of the FIXED events-spool.ts `drain`. `apply` stands in for
 *  `applyAgentEvent`; `hasWindow` stands in for the reader's window ref (drain
 *  early-returns without one, so events aren't consumed before they can be
 *  applied). */
function drain(
  p: string,
  cur: Cursor,
  apply: (event: string, tool: string | undefined) => void,
  hasWindow = true,
): void {
  if (!hasWindow) return; // ← fix: don't consume events with no window
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch {
    return;
  }
  if (size < cur.offset) {
    cur.offset = 0;
    cur.buffer = '';
  }
  if (size === cur.offset) {
    cur.prevSize = size;
    return;
  }
  let chunk = '';
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const len = size - cur.offset;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, cur.offset);
      chunk = buf.toString('utf8', 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  cur.offset = size;

  const text = cur.buffer + chunk;
  const parts = text.split('\n');
  cur.buffer = parts.pop() ?? '';

  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: { seq?: unknown; event?: unknown; tool?: unknown };
    try {
      ev = JSON.parse(trimmed) as { seq?: unknown; event?: unknown; tool?: unknown };
    } catch {
      continue;
    }
    if (typeof ev.event !== 'string') continue;
    const seq = typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : 0;
    if (seq > 0) {
      if (seq <= cur.lastSeq) continue;
      cur.lastSeq = seq;
    }
    const tool = typeof ev.tool === 'string' && ev.tool.length ? ev.tool : undefined;
    // ← fix: isolate each apply so a throw can't abort the batch and strand
    //   the events behind it.
    try {
      apply(ev.event, tool);
    } catch {
      /* swallowed in prod via log.error — see events-spool.ts */
    }
  }
  cur.prevSize = size;
  // ← fix (relaunch replay): persist the high-water mark after each batch,
  //   mirroring events-spool.ts drain(). `p + '.cursor'` matches the prod
  //   cursorPathFor naming relative to the spool.
  persistSeq(`${p}.cursor`, cur);
}

// status as the renderer derives it: the last applied lifecycle event.
const statusOf = (events: string[]): string => {
  const last = events[events.length - 1];
  if (last === 'stop' || last === 'notify' || last === 'stopfail') return 'waiting';
  if (last === 'submit' || last === 'pretool' || last === 'posttool') return 'running';
  return 'idle';
};

function tmpSpool(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-spool-'));
  return path.join(dir, 'ws.jsonl');
}
function append(p: string, seq: number, event: string, tool = ''): void {
  fs.appendFileSync(p, `${JSON.stringify({ seq, event, tool })}\n`);
}

// ── Control: clean steady-state delivery applies everything in order ─────────
test('control: a normal turn delivers every event; status ends waiting', () => {
  const p = tmpSpool();
  const cur = newCursor();
  const applied: string[] = [];
  const apply = (e: string) => applied.push(e);

  append(p, 1, 'submit');
  append(p, 2, 'pretool', 'Bash');
  drain(p, cur, apply);
  append(p, 3, 'posttool', 'Bash');
  append(p, 4, 'stop');
  append(p, 5, 'notify');
  drain(p, cur, apply);

  assert.deepEqual(applied, ['submit', 'pretool', 'posttool', 'stop', 'notify']);
  assert.equal(statusOf(applied), 'waiting'); // dot would correctly go yellow
});

// ── REGRESSION 1: a throwing apply must NOT strand the trailing stop ──────────
test('a throw mid-batch no longer strands the trailing stop', () => {
  const p = tmpSpool();
  const cur = newCursor();
  const applied: string[] = [];
  // applyAgentEvent throws on one event (the field trigger: an unguarded
  // window.isFocused() on a transiently unavailable window).
  const apply = (e: string) => {
    if (e === 'posttool') throw new Error('boom');
    applied.push(e);
  };

  append(p, 1, 'submit');
  append(p, 2, 'pretool', 'Bash');
  append(p, 3, 'posttool', 'Bash'); // throws here — but is now isolated
  append(p, 4, 'stop'); // ← turn end, same batch
  drain(p, cur, apply);

  // The throw is swallowed per-line; the stop still applies → dot goes waiting.
  assert.ok(applied.includes('stop'), 'stop must survive an earlier event throwing');
  assert.equal(statusOf(applied), 'waiting', 'status correctly reflects the turn-end');
});

// ── REGRESSION 2: events drained with no window must replay, not vanish ───────
test('events seen while the window is absent replay once it returns', () => {
  const p = tmpSpool();
  const cur = newCursor();
  const applied: string[] = [];
  const apply = (e: string) => applied.push(e);

  append(p, 1, 'submit');
  append(p, 2, 'pretool', 'Bash');
  append(p, 3, 'posttool', 'Bash');
  append(p, 4, 'stop'); // turn end
  // Drain with no window: the fix early-returns WITHOUT consuming, so the cursor
  // does not advance past these events.
  drain(p, cur, apply, /* hasWindow */ false);
  assert.deepEqual(applied, [], 'nothing applied while window absent');
  assert.equal(cur.offset, 0, 'cursor must not advance with no window');

  // Window is back: every event — including the turn-end — now applies.
  drain(p, cur, apply, true);
  assert.deepEqual(applied, ['submit', 'pretool', 'posttool', 'stop']);
  assert.equal(statusOf(applied), 'waiting');
});

// ── Control: the WRITER under real concurrency does not produce drops ─────────
// Confirms the loss is the reader's apply/cursor coupling, not the writer/spool:
// the real hook script, hammered concurrently, yields a gapless, in-order,
// duplicate-free seq stream that the reader applies completely.
const HOOK = `#!/usr/bin/env bash
dir="\${ORCHESTRA_EVENTS_DIR}"
event="\${1:-}"
spool="$dir/ws.jsonl"
seqf="$dir/ws.seq"
seq=0
if command -v flock >/dev/null 2>&1; then
  exec 9>>"$seqf"
  if flock -w 5 9; then
    cur="$(cat "$seqf" 2>/dev/null)"
    case "$cur" in ''|*[!0-9]*) cur=0 ;; esac
    seq=$((cur + 1))
    printf '%s' "$seq" >"$seqf"
  fi
  exec 9>&-
fi
printf '{"seq":%s,"event":"%s","tool":"%s"}\\n' "$seq" "$event" "" >> "$spool"
`;

test('control: real hook under concurrency → reader applies every event, no drop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-hookrun-'));
  const script = path.join(dir, 'hook.sh');
  fs.writeFileSync(script, HOOK, { mode: 0o755 });
  const env = { ...process.env, ORCHESTRA_EVENTS_DIR: dir };
  const p = path.join(dir, 'ws.jsonl');

  // Fire bursts of concurrent hooks (parallel tool calls), like the real agent.
  const ROUNDS = 8;
  for (let r = 0; r < ROUNDS; r++) {
    execFileSync(
      'bash',
      ['-c', `for i in $(seq 1 6); do "${script}" pretool & "${script}" posttool & done; wait`],
      { env },
    );
  }
  execFileSync('bash', ['-c', `"${script}" stop`], { env });

  const cur = newCursor();
  const applied: string[] = [];
  drain(p, cur, (e) => applied.push(e));

  const fileLines = fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  assert.equal(applied.length, fileLines.length, 'reader applied every line in the spool');
  assert.equal(applied[applied.length - 1], 'stop', 'the turn-end applied last');
  assert.equal(statusOf(applied), 'waiting');
});

// ── Relaunch replay (the "every notification triggers on reopen" bug) ────────
//
// The startup wipe KEEPS a live detached keeper's spool, and the tailer then
// re-reads it from offset 0. The seq-dedup only lived in memory, so every app
// relaunch re-applied every kept line — and each replayed stop/notify re-fired
// its chime/OS toast for turns the user had already seen before quitting.
// Persisting the reader's high-water mark makes the dedup hold across runs.

test('relaunch: a kept spool replays NOTHING already applied by the previous run', () => {
  const p = tmpSpool();

  // Run 1: a full turn is applied and (implicitly) notified.
  const run1: string[] = [];
  const cur1 = newCursor();
  append(p, 1, 'submit');
  append(p, 2, 'pretool', 'Bash');
  append(p, 3, 'posttool', 'Bash');
  append(p, 4, 'stop');
  drain(p, cur1, (e) => run1.push(e));
  assert.equal(run1.length, 4);

  // App restarts: fresh cursor seeded from the persisted mark (spool file
  // KEPT — live keeper). Pre-quit lines must not re-apply, so no re-chime.
  const run2: string[] = [];
  const cur2 = restoredCursor(`${p}.cursor`);
  drain(p, cur2, (e) => run2.push(e));
  assert.deepEqual(run2, [], 'no replayed applies → no replayed notifications');
});

test('relaunch: lines written WHILE the app was closed still apply exactly once', () => {
  const p = tmpSpool();

  // Run 1 applies a first turn…
  const cur1 = newCursor();
  append(p, 1, 'submit');
  append(p, 2, 'stop');
  drain(p, cur1, () => {});

  // …the app quits; the detached session keeps working and finishes a turn.
  append(p, 3, 'submit');
  append(p, 4, 'stop');

  // Run 2: only the while-closed lines apply (one legit notification), and a
  // THIRD run replays nothing at all.
  const run2: string[] = [];
  const cur2 = restoredCursor(`${p}.cursor`);
  drain(p, cur2, (e) => run2.push(e));
  assert.deepEqual(run2, ['submit', 'stop']);

  const run3: string[] = [];
  const cur3 = restoredCursor(`${p}.cursor`);
  drain(p, cur3, (e) => run3.push(e));
  assert.deepEqual(run3, []);
});

test('relaunch: a missing/corrupt cursor degrades to the old replay, never a crash', () => {
  const p = tmpSpool();
  append(p, 1, 'submit');
  append(p, 2, 'stop');

  // Corrupt cursor → treated as 0 → replay-with-dedup from the top.
  fs.writeFileSync(`${p}.cursor`, 'not json');
  const applied: string[] = [];
  const cur = restoredCursor(`${p}.cursor`);
  drain(p, cur, (e) => applied.push(e));
  assert.deepEqual(applied, ['submit', 'stop']);
  // And the drain repaired the cursor: a subsequent restart replays nothing.
  const again: string[] = [];
  drain(p, restoredCursor(`${p}.cursor`), (e) => again.push(e));
  assert.deepEqual(again, []);
});
