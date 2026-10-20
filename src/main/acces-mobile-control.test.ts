// The phone's interrupt + rewind in main: the guards with fake effects — each refusal beside a passing control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileControls, REWIND_GONE, REWIND_RUNNING, type MobileControlDeps } from './acces-mobile-control.ts';
import type { RenderMessage } from '../shared/types.ts';

const U = (id: string, text: string, rewindId?: string, queued?: boolean) => ({ id, role: 'user', text, rewindId, queued }) as RenderMessage;
const A = (id: string) => ({ id, role: 'assistant', text: 'ok' }) as RenderMessage;
const FOLD = [U('u1', 'first', 'r1'), A('a1'), U('u2', 'from a peer'), A('a2'), U('u3', 'redo this', 'r3'), A('a3'), U('u4', 'parked', 'r4', true)];

function rig(over: Partial<MobileControlDeps> = {}) {
  const calls: unknown[][] = [];
  let running = false;
  const c = createMobileControls({
    liveId: (id) => (id === 'w1' ? 'w1' : undefined),
    fold: async () => FOLD,
    isRunning: () => running,
    interrupt: async (id) => void calls.push(['interrupt', id]),
    preview: async (id, r) => (calls.push(['preview', id, r]), { canRewind: true, filesChanged: ['a'] }),
    rewind: async (id, r, prev) => (calls.push(['rewind', id, r, prev]), { type: 'session/rewind', seq: 1, at: 1, rewindId: r }),
    ...over,
  });
  return { c, calls, setRunning: (v: boolean) => (running = v) };
}

test('interrupt: the live workspace is interrupted; unknown / archived ⇒ refused, nothing called', async () => {
  const r = rig();
  assert.deepEqual(await r.c.interrupt({ id: 'w1' }), { ok: true });
  assert.deepEqual(await r.c.interrupt({ id: 'gone' }), { ok: false, error: 'unknown or archived workspace' });
  assert.deepEqual(r.calls, [['interrupt', 'w1']]);
});

test('rewind: cut fallback = the previous rewindable turn, the undone text returned (control for every refusal below)', async () => {
  const r = rig();
  assert.deepEqual(await r.c.rewind({ id: 'w1', rewindId: 'r3' }), { ok: true, text: 'redo this' });
  assert.deepEqual(await r.c.rewind({ id: 'w1', rewindId: 'r1' }), { ok: true, text: 'first' });
  assert.deepEqual(r.calls, [['rewind', 'w1', 'r3', 'r1'], ['rewind', 'w1', 'r1', undefined]], 'the id-less peer turn is skipped; the first turn has no predecessor');
});

test('rewind must-FAIL: mid-turn, a target not in the fold, a queued prompt, a bad id, an unknown workspace ⇒ refused, sdkRewind never called', async () => {
  const r = rig();
  r.setRunning(true);
  assert.deepEqual(await r.c.rewind({ id: 'w1', rewindId: 'r3' }), { ok: false, error: REWIND_RUNNING });
  r.setRunning(false);
  assert.deepEqual(await r.c.rewind({ id: 'w1', rewindId: 'nope' }), { ok: false, error: REWIND_GONE });
  assert.deepEqual(await r.c.rewind({ id: 'w1', rewindId: 'r4' }), { ok: false, error: REWIND_GONE }, 'a queued prompt is not a rewind target');
  assert.deepEqual(await r.c.rewind({ id: 'w1', rewindId: '../x' }), { ok: false, error: 'bad rewind id' });
  assert.deepEqual(await r.c.rewind({ id: 'gone', rewindId: 'r3' }), { ok: false, error: 'unknown or archived workspace' });
  assert.deepEqual(r.calls, []);
  assert.equal((await r.c.rewind({ id: 'w1', rewindId: 'r3' })).ok, true, 'control: the same target once idle');
});

test('rewind: the files caveat travels; a throwing sdkRewind is a refusal, never a false ok', async () => {
  const partial = rig({ rewind: async (_i, r) => ({ type: 'session/rewind', seq: 1, at: 1, rewindId: r, filesError: 'No file checkpoint' }) });
  assert.deepEqual(await partial.c.rewind({ id: 'w1', rewindId: 'r3' }), { ok: true, text: 'redo this', filesError: 'No file checkpoint' });
  const broken = rig({ rewind: async () => { throw new Error('keeper gone'); } });
  assert.deepEqual(await broken.c.rewind({ id: 'w1', rewindId: 'r3' }), { ok: false, error: 'keeper gone' });
});

test('preview: only for a turn of the fold; allowed mid-turn (a dry run)', async () => {
  const r = rig();
  r.setRunning(true);
  assert.deepEqual(await r.c.preview({ id: 'w1', rewindId: 'r1' }), { ok: true, preview: { canRewind: true, filesChanged: ['a'] } });
  assert.deepEqual(await r.c.preview({ id: 'w1', rewindId: 'nope' }), { ok: false, error: REWIND_GONE });
  assert.deepEqual(r.calls, [['preview', 'w1', 'r1']]);
});
