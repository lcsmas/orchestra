import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearInFlightTools, getInFlightTools, noteToolDetail, noteToolEnd, noteToolStart } from './hibernation-activity.ts';

// #255 review M2 — the in-flight tracker keeps a one-line input summary per call (SDK `tool-use`), read by the Bilan de pause.

test('detail joins the in-flight entry whichever writer comes first (pretool hook or SDK tool-use) and leaves with the call', () => {
  const ws = 'ws-detail-1';
  noteToolDetail(ws, 'tu-1', 'npm test'); // tool-use BEFORE pretool
  noteToolStart(ws, 'Bash', 'tu-1');
  noteToolStart(ws, 'Read', 'tu-2'); // pretool BEFORE tool-use
  noteToolDetail(ws, 'tu-2', 'file_path=/w/a.ts');
  noteToolStart(ws, 'Bash', 'tu-3'); // no detail ever (terminal agent / unknown)
  const got = Object.fromEntries(getInFlightTools(ws).map((t) => [t.toolUseId, t.detail ?? null]));
  assert.deepEqual(got, { 'tu-1': 'npm test', 'tu-2': 'file_path=/w/a.ts', 'tu-3': null });
  noteToolEnd(ws, 'tu-1');
  assert.deepEqual(getInFlightTools(ws).map((t) => t.toolUseId), ['tu-2', 'tu-3']);
  noteToolStart(ws, 'Bash', 'tu-1'); // the id is reused later: it must NOT resurrect the old detail
  assert.equal(getInFlightTools(ws).find((t) => t.toolUseId === 'tu-1')!.detail, undefined);
  clearInFlightTools(ws);
  assert.deepEqual(getInFlightTools(ws), []);
});

test('detail map is bounded per workspace (FIFO) and ignores null ids / empty details', () => {
  const ws = 'ws-detail-2';
  for (let i = 0; i < 100; i++) noteToolDetail(ws, `id-${i}`, `cmd ${i}`);
  noteToolDetail(ws, null, 'x');
  noteToolDetail(ws, 'id-null', null);
  for (const id of ['id-0', 'id-35', 'id-36', 'id-99', 'id-null']) noteToolStart(ws, 'Bash', id);
  const got = Object.fromEntries(getInFlightTools(ws).map((t) => [t.toolUseId, t.detail ?? null]));
  assert.deepEqual(got, { 'id-0': null, 'id-35': null, 'id-36': 'cmd 36', 'id-99': 'cmd 99', 'id-null': null }, 'the oldest 36 of 100 were evicted (cap 64)');
  clearInFlightTools(ws);
});
