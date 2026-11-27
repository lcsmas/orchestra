// #608 — cost per ticket from the transcripts: the pure readers behind `FleetPort.costOf`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blankTicket } from './fanout-state.ts';
import { buildReport, collectCosts, makeCostOf, openPointCountOf, renderReport, tokensOfFiles, tokensOfTranscript, transcriptFilesIn, workspacesOfTicket } from './fanout-report.ts';
import { newState } from './fanout-state.ts';

const line = (o: unknown): string => JSON.stringify(o);
const asst = (id: string | null, u: Record<string, number>, extra: Record<string, unknown> = {}): string => line({ type: 'assistant', ...extra, message: { ...(id ? { id } : {}), usage: u } });

test('tokensOfTranscript: one count per message.id (the LAST streamed line wins), sidechain lines count, junk and non-assistant lines are skipped', () => {
  const text = [
    asst('m1', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }),
    asst('m1', { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }), // same message, final output
    asst('m2', { input_tokens: 2, output_tokens: 3 }, { isSidechain: true }),
    asst(null, { input_tokens: 1, output_tokens: 1 }),
    asst(null, { input_tokens: 1, output_tokens: 1 }), // no id: each line is its own message
    line({ type: 'user', message: { usage: { input_tokens: 9999 } } }),
    '{"type":"assistant","message":{"usage":', // torn line
    'not json "usage"',
  ].join('\n');
  assert.deepEqual(tokensOfTranscript(text), { tokens: 155 + 5 + 4, input: 14, output: 45, cacheRead: 100, cacheCreate: 5 });
});

test('MUST-FAIL arm: counting every line (no dedupe) would overstate — the streamed message above is NOT 2x', () => {
  const a = asst('m1', { input_tokens: 10, output_tokens: 5 });
  assert.equal(tokensOfTranscript([a, a, a].join('\n')).tokens, 15);
});

test('tokensOfFiles: sums files, skips an unreadable one, null (not 0) when none could be read', () => {
  const files: Record<string, string> = { a: asst('m1', { input_tokens: 5, output_tokens: 5 }), b: asst('m2', { input_tokens: 1 }) };
  const read = (p: string): string => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
  assert.equal(tokensOfFiles(['a', 'b', 'gone'], read)!.tokens, 11);
  assert.equal(tokensOfFiles(['gone'], read), null);
  assert.equal(tokensOfFiles([], read), null);
});

test('makeCostOf + transcriptFilesIn over real files: every session of every worker of a ticket is its cost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'));
  try {
    fs.mkdirSync(path.join(dir, 'impl'));
    fs.mkdirSync(path.join(dir, 'rev'));
    fs.writeFileSync(path.join(dir, 'impl', 's1.jsonl'), asst('m1', { input_tokens: 100, output_tokens: 10 }));
    fs.writeFileSync(path.join(dir, 'impl', 's2.jsonl'), asst('m9', { input_tokens: 50 })); // a restarted session
    fs.writeFileSync(path.join(dir, 'impl', 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'rev', 's1.jsonl'), asst('r1', { input_tokens: 7 }));
    const costOf = makeCostOf({ workspacesOf: (t) => (t === 'A' ? ['impl', 'rev'] : []), transcriptsOf: (ws) => transcriptFilesIn(path.join(dir, ws)) });
    assert.equal((await costOf('A'))!.tokens, 167);
    assert.equal(await costOf('B'), null);
    assert.deepEqual(transcriptFilesIn(path.join(dir, 'nope')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a message copied into a second file (a resumed / forked session) is counted ONCE across the files of a ticket', () => {
  const files: Record<string, string> = { a: asst('m1', { input_tokens: 10, output_tokens: 2 }), b: [asst('m1', { input_tokens: 10, output_tokens: 2 }), asst('m2', { input_tokens: 5 })].join('\n') };
  assert.equal(tokensOfFiles(['a', 'b'], (p) => files[p])!.tokens, 17);
});

test('transcriptFilesIn reads <session>/subagents/*.jsonl too (Agent-tool transcripts are the ticket\'s cost)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-sub-'));
  try {
    fs.mkdirSync(path.join(dir, 'sess1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess1.jsonl'), asst('m1', { input_tokens: 100 }));
    fs.writeFileSync(path.join(dir, 'sess1', 'subagents', 'agent-a.jsonl'), asst('s1', { input_tokens: 40 }, { isSidechain: true }));
    fs.writeFileSync(path.join(dir, 'sess1', 'subagents', 'agent-b.jsonl'), asst('s2', { input_tokens: 2 }, { isSidechain: true }));
    fs.writeFileSync(path.join(dir, 'sess1', 'notes.txt'), 'x');
    assert.equal(transcriptFilesIn(dir).length, 3);
    const costOf = makeCostOf({ workspacesOf: () => ['w'], transcriptsOf: () => transcriptFilesIn(dir) });
    assert.equal((await costOf('A'))!.tokens, 142);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one message.id in two files with different usage: the per-field MAX wins, in either file order', () => {
  const files: Record<string, string> = { a: asst('m1', { input_tokens: 1, output_tokens: 5 }), b: asst('m1', { input_tokens: 1, output_tokens: 500 }) };
  const read = (p: string): string => files[p];
  assert.equal(tokensOfFiles(['a', 'b'], read)!.tokens, 501);
  assert.equal(tokensOfFiles(['b', 'a'], read)!.tokens, 501);
});

test('workspacesOfTicket: implementer + every reviewer ever briefed, unique, in order', () => {
  const t = { ...blankTicket('t'), implementer: 'ws-i', review: { reviewer: { id: 'ws-r2', name: 'review-A-r2', at: 't' }, head: null, base: null, briefs: [
    { n: 1, kind: 'spawn', head: 'a', base: null, hash: 'h', text: '', reviewer: 'ws-r1', at: 't' }, { n: 2, kind: 'replace', head: 'a', base: null, hash: 'h', text: '', reviewer: 'ws-r2', at: 't' }, { n: 3, kind: 'wake', head: 'b', base: null, hash: 'h', text: '', reviewer: 'ws-r2', at: 't' }] } };
  assert.deepEqual(workspacesOfTicket(t as never), ['ws-i', 'ws-r2', 'ws-r1']);
  assert.deepEqual(workspacesOfTicket(blankTicket('t')), []);
});

test('collectCosts: a port that throws for one ticket leaves that ticket unmeasured and the others read', async () => {
  let s = newState('r', { now: 't' });
  s = { ...s, tickets: { A: blankTicket('t'), B: blankTicket('t') } };
  const costs = await collectCosts(s, async (id) => { if (id === 'A') throw new Error('boom'); return { tokens: 3 }; });
  assert.deepEqual(costs, { A: null, B: { tokens: 3 } });
});

// ── #682: the closing report counts the open points raised per run, and lists the pairs the plan declared sharing nothing ──
const pt = (id: number, status: 'open' | 'settled', how?: 'addressed' | 'decided') => ({ id, from: 'A', about: 'B', text: `point ${id}`, at: 'x', status, aboutHead: null, aboutTree: null, ...(how ? { settled: { how, at: 'x', by: 'r', ...(how === 'decided' ? { text: 'rule' } : { ticket: 'B', head: 'a'.repeat(40) }) } } : {}) });
test('#682 report: open points raised are counted per run, split by how each ended; 0 is printed as a fact', () => {
  const none = buildReport(newState('r1', { now: '2026-11-27T00:00:00.000Z' }));
  assert.deepEqual(none.openPointCount, { raised: 0, addressed: 0, decided: 0, open: 0 });
  assert.match(renderReport(none), /^open points raised: 0 \(what the plan did not freeze\)$/m);
  const st = { ...newState('r1', { now: '2026-11-27T00:00:00.000Z' }), openPoints: [pt(1, 'settled', 'addressed'), pt(2, 'settled', 'decided'), pt(3, 'open'), pt(4, 'settled', 'addressed')] };
  assert.deepEqual(openPointCountOf(st), { raised: 4, addressed: 2, decided: 1, open: 1 });
  assert.match(renderReport(buildReport(st)), /^open points raised: 4 — 2 addressed, 1 decided, 1 still open/m);
});

test('#682 report: the pairs declared noSharedBehaviour are listed; absent when none were', () => {
  const base = newState('r1', { now: '2026-11-27T00:00:00.000Z' });
  assert.equal(buildReport(base).noSharedBehaviour, undefined);
  assert.doesNotMatch(renderReport(buildReport(base)), /sharing no behaviour/);
  const r = buildReport({ ...base, noSharedBehaviour: ['A-B', 'B-C'] });
  assert.deepEqual(r.noSharedBehaviour, ['A-B', 'B-C']);
  assert.match(renderReport(r), /^pairs the plan declared sharing no behaviour \(2\)[^\n]*A-B, B-C$/m);
});
