import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTailUntil, TAIL_CHUNK_BYTES, TAIL_MAX_BYTES } from './tail-read.ts';
import { scanTranscriptTailForLoop } from './loop-scan.ts';

const NEEDLE = '"ScheduleWakeup"';

function tmpFile(content: string | Buffer): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tail-read-')), 'f.jsonl');
  fs.writeFileSync(p, content);
  return p;
}

/** A main-chain assistant ScheduleWakeup transcript line. */
function swLine(input: Record<string, unknown>, ts = '2026-08-18T12:00:00.000Z'): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input }] },
    }) + '\n'
  );
}

/** Filler transcript lines totalling at least `bytes`. */
function filler(bytes: number): string {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200) }] } }) + '\n';
  return line.repeat(Math.ceil(bytes / line.length));
}

test('needle near EOF: found within the first chunk', async () => {
  const p = tmpFile(filler(1024) + swLine({ delaySeconds: 60 }));
  const tail = await readTailUntil(p, NEEDLE);
  assert.ok(tail !== null && tail.includes(NEEDLE));
});

test('needle far from EOF (past one chunk): the walk keeps reading back until it appears', async () => {
  // The live defect's shape: deciding entry ~474 KB from EOF, window 256 KiB.
  const p = tmpFile(filler(1024) + swLine({ stop: true }) + filler(TAIL_CHUNK_BYTES * 2));
  const tail = await readTailUntil(p, NEEDLE);
  assert.ok(tail !== null && tail.includes(NEEDLE), 'needle beyond one chunk is still found');
  // And the scanner reaches the correct verdict over that window — this is the
  // end-to-end pair that was impossible with the fixed window.
  assert.equal(scanTranscriptTailForLoop(tail!, Date.now()).state, 'stopped');
});

test('needle straddling a chunk boundary is still found', async () => {
  // Place the needle so the chunk seam (measured from EOF) cuts it in half.
  const after = TAIL_CHUNK_BYTES - Math.floor(NEEDLE.length / 2);
  const content = 'A'.repeat(1000) + NEEDLE + 'B'.repeat(after);
  const p = tmpFile(content);
  const tail = await readTailUntil(p, NEEDLE);
  assert.ok(tail !== null && tail.includes(NEEDLE));
});

test('multi-byte UTF-8 char split across a chunk seam decodes intact', async () => {
  // '€' is 3 bytes; position it across the seam TAIL_CHUNK_BYTES from EOF.
  const euro = Buffer.from('€', 'utf8');
  const before = Buffer.from('start-marker '.repeat(10), 'utf8');
  const afterLen = TAIL_CHUNK_BYTES - 1; // seam lands inside the 3-byte char
  const buf = Buffer.concat([before, euro, Buffer.alloc(afterLen, 0x42)]);
  const p = tmpFile(buf);
  const tail = await readTailUntil(p, 'start-marker');
  assert.ok(tail !== null && tail.includes('€'), 'no U+FFFD mangling at the seam');
  assert.ok(!tail!.includes('�'));
});

test('no needle in a small file: whole file returned (caller sees everything)', async () => {
  const content = filler(2048);
  const p = tmpFile(content);
  const tail = await readTailUntil(p, NEEDLE);
  assert.equal(tail, content);
});

test('needle beyond the hard cap: window is capped, needle not included', async () => {
  const p = tmpFile(NEEDLE + filler(TAIL_MAX_BYTES + TAIL_CHUNK_BYTES));
  const tail = await readTailUntil(p, NEEDLE);
  assert.ok(tail !== null && !tail.includes(NEEDLE));
  assert.ok(tail!.length <= TAIL_MAX_BYTES + NEEDLE.length);
  // The scanner then reports `unknown`, which by contract clears nothing.
  assert.equal(scanTranscriptTailForLoop(tail!, Date.now()).state, 'unknown');
});

test('missing file: null', async () => {
  assert.equal(await readTailUntil('/nonexistent/nope.jsonl', NEEDLE), null);
});
