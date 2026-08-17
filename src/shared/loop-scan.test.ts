import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanTranscriptTailForLoop,
  LOOP_STALE_SLACK_MS,
} from './loop-scan.ts';

// Entries mirror the REAL transcript shape (verified against a live session:
// type:'assistant', ISO `timestamp`, isSidechain, message.content[] with
// tool_use blocks carrying name + input).
const NOW = Date.parse('2026-08-17T19:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const entry = (over: Record<string, unknown>, input: Record<string, unknown>, name = 'ScheduleWakeup') =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: iso(0),
    message: { content: [{ type: 'tool_use', id: 't1', name, input }] },
    ...over,
  });
const textEntry = () =>
  JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: iso(0), message: { content: [{ type: 'text', text: 'hi' }] } });

test('armed wakeup within its window → looping, with the entry timestamp', () => {
  const at = iso(10 * 60_000); // armed 10 min ago, delay 30 min
  const tail = [textEntry(), entry({ timestamp: at }, { delaySeconds: 1800, prompt: '/loop x' })].join('\n');
  const v = scanTranscriptTailForLoop(tail, NOW);
  assert.equal(v.state, 'looping');
  assert.equal(v.at, Date.parse(at));
});

test('stop:true → stopped', () => {
  const tail = entry({}, { stop: true });
  assert.equal(scanTranscriptTailForLoop(tail, NOW).state, 'stopped');
});

test('armed wakeup long past due+slack → stale', () => {
  const at = iso(3600_000 + LOOP_STALE_SLACK_MS + 60_000); // due+slack passed by 1 min (delay 1h)
  const tail = entry({ timestamp: at }, { delaySeconds: 3600 });
  assert.equal(scanTranscriptTailForLoop(tail, NOW).state, 'stale');
});

test('the LAST ScheduleWakeup decides — a stop after an armed call wins', () => {
  const tail = [
    entry({ timestamp: iso(60_000) }, { delaySeconds: 1800 }),
    entry({ timestamp: iso(0) }, { stop: true }),
  ].join('\n');
  assert.equal(scanTranscriptTailForLoop(tail, NOW).state, 'stopped');
});

test('sidechain ScheduleWakeup is skipped (a subagent cannot own the loop)', () => {
  const tail = entry({ isSidechain: true }, { delaySeconds: 1800 });
  assert.equal(scanTranscriptTailForLoop(tail, NOW).state, 'unknown');
});

test('no ScheduleWakeup in the tail → unknown (never a clear signal)', () => {
  assert.equal(scanTranscriptTailForLoop([textEntry(), textEntry()].join('\n'), NOW).state, 'unknown');
});

test('a truncated first line (tail window cut mid-entry) is skipped, not thrown on', () => {
  const good = entry({ timestamp: iso(60_000) }, { delaySeconds: 1800 });
  const tail = good.slice(40) + '\n' + good; // garbage prefix line mentions ScheduleWakeup
  assert.equal(scanTranscriptTailForLoop(tail, NOW).state, 'looping');
});

test('a different tool sharing the tail does not match (control)', () => {
  const tail = entry({}, { delaySeconds: 1800 }, 'CronCreate');
  assert.equal(scanTranscriptTailForLoop(tail, NOW).state, 'unknown');
});

test('missing delaySeconds on an armed call assumes the max delay', () => {
  // Armed 30 min ago with no delay: within 3600s default + slack → looping.
  const tail = entry({ timestamp: iso(30 * 60_000) }, { prompt: '/loop x' });
  assert.equal(scanTranscriptTailForLoop(tail, NOW).state, 'looping');
});
