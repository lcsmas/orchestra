// #439 (OPS ruling R2) — which open exchanges a move strands. Pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveRefusal, relatedHomes, strandedExchanges, type OpenExchange } from './move-exchanges.ts';
import type { RunNode } from './run-position.ts';

// L (top-level) ─ X ─ C ; L ─ S ; Q top-level. Parented agents own a run only when ownsRun.
const nodes: RunNode[] = [
  { id: 'L' }, { id: 'X', parentId: 'L', ownsRun: true }, { id: 'C', parentId: 'X' }, { id: 'S', parentId: 'L' }, { id: 'Q' },
];
const lookup = (id: string) => nodes.find((n) => n.id === id);
const ask = (member: string, counterparty: string): OpenExchange => ({ kind: 'ask', ref: 7, run: 'L', member, counterparty });

test('#439 relatedHomes: own run, the runs above it, the runs below it', () => {
  assert.deepEqual([...relatedHomes(lookup('C')!, lookup, nodes)].sort(), ['C'.replace('C', 'X'), 'L'].sort(), 'C is a member of X\'s run, below L');
  assert.deepEqual([...relatedHomes(lookup('L')!, lookup, nodes)].sort(), ['L', 'X'], 'L sees its own run and the vague below it');
  assert.deepEqual([...relatedHomes(lookup('Q')!, lookup, nodes)], ['Q']);
});

test('#439 strandedExchanges: a counterparty whose home is outside the member\'s related runs strands; one inside does not; the human never does', () => {
  assert.equal(strandedExchanges([ask('C', 'L')], lookup, nodes).length, 0, 'L is above C: related');
  const moved: RunNode[] = nodes.map((n) => (n.id === 'X' ? { ...n, parentId: 'Q' } : n)); // X (and C) attached under Q
  const after = (id: string) => moved.find((n) => n.id === id);
  assert.equal(strandedExchanges([ask('C', 'S')], after, moved).length, 1, 'S stays under L, C now sits under Q: stranded');
  assert.equal(strandedExchanges([ask('C', 'L')], after, moved).length, 1, 'L is no longer above X');
  assert.equal(strandedExchanges([ask('C', 'Q')], after, moved).length, 0, 'Q is X\'s new coordinator');
  assert.equal(strandedExchanges([ask('C', 'the-human')], after, moved).length, 0, 'not a workspace: never stranded');
});

test('#439 moveRefusal names the item, its two sides and how many more', () => {
  const msg = moveRefusal([ask('C', 'S'), { kind: 'gate', ref: 3, run: 'L', member: 'X', counterparty: 'S' }], (id) => `ws-${id}`);
  assert.match(msg, /unanswered ask #7 between ws-C and ws-S would be stranded/);
  assert.match(msg, /\(\+1 more\)/);
  assert.match(msg, /orchestra send --type status --to <asker> --thread 7 <reply>/, 'an ask names the threaded answer that clears it (the asker id is filled in when known)');
  assert.match(moveRefusal([{ ...ask('C', 'S'), asker: 'S-id' }]), /orchestra send --type status --to S-id --thread 7 <reply>/);
  const g = moveRefusal([{ kind: 'gate', ref: 3, run: 'L', member: 'X', counterparty: 'S' }]);
  assert.match(g, /open decision gate #3/);
  assert.match(g, /orchestra gate resolve 3 --resolution/, 'a gate names its resolve verb');
});
