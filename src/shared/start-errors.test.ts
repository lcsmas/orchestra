import test from 'node:test';
import assert from 'node:assert/strict';
import { interleaveStartErrors } from './start-errors.ts';
import type { AgentEvent } from './types.ts';

const ev = (at: number, tag: string): AgentEvent => ({ type: 'notice', kind: 'info', seq: 0, at, text: tag }) as AgentEvent;
const tags = (es: AgentEvent[]) => es.map((e) => (e.type === 'error' ? `E@${e.at}` : (e as { text: string }).text));

test('no persisted errors → the events come back untouched (same array)', () => {
  const events = [ev(10, 'a')];
  assert.equal(interleaveStartErrors(events, [], { seq: 100 }), events);
});

test('with NO transcript events the rows come back on their own, oldest first, with fresh seqs', () => {
  const out = interleaveStartErrors([], [{ at: 30, message: 'later' }, { at: 20, message: 'earlier' }], { seq: 500 });
  assert.deepEqual(out.map((e) => [e.type, e.at, (e as { message: string }).message, e.seq]), [
    ['error', 20, 'earlier', 500],
    ['error', 30, 'later', 501],
  ]);
});

test('rows interleave by `at`: before the first STRICTLY newer event; ties keep the event first; rows after the last event go last', () => {
  const out = interleaveStartErrors([ev(10, 'a'), ev(20, 'b'), ev(40, 'c')], [{ at: 10, message: 'tie' }, { at: 25, message: 'mid' }, { at: 99, message: 'tail' }], { seq: 0 });
  assert.deepEqual(tags(out), ['a', 'E@10', 'b', 'E@25', 'c', 'E@99']);
});

test('the transcript events keep their exact relative order (no global sort): a row lands before the FIRST strictly newer event', () => {
  const out = interleaveStartErrors([ev(50, 'x'), ev(10, 'y'), ev(30, 'z')], [{ at: 20, message: 'm' }], { seq: 0 });
  assert.deepEqual(tags(out), ['E@20', 'x', 'y', 'z']);
});
