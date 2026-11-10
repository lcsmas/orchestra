// #419 — the live-frame budget's figures are CHOSEN from the committed measurement (docs/evidence/419-bloc-frame-cost.jsonl, produced by scripts/measure-bloc-frames.sh
// in the built app). This test re-derives the rule on every run: change a constant without a measurement that supports it and it goes red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BLOC_LIVE_MAX } from './bloc-live-budget.ts';
import { BLOC_HTML_MAX_SOURCE_BYTES } from './reply-segments.ts';

interface Row { id: string; mode: 'cell' | 'siblings'; kind?: string; n?: number; bytes?: number | null; variant?: string | null; valid: boolean; framesRssKB?: number; framesCpuPct?: number; windowRssKB?: number; maxEvalMs?: number; totalRssKB?: number; framesProcs?: number; verdict?: string; pongs?: number }
const rows: Row[] = fs.readFileSync(path.join(process.cwd(), 'docs/evidence/419-bloc-frame-cost.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ok = rows.filter((r) => r.valid);
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const MB = 1024; // rows are in KB

test('evidence: every planned cell has ≥ 3 valid runs where it is used, and the instruments say what they must', () => {
  for (const [kind, n] of [['idle', 1], ['idle', 5], ['idle', 20], ['idle', 50], ['busy', 1], ['busy', 5], ['busy', 20]] as const) assert.ok(ok.filter((r) => r.mode === 'cell' && r.kind === kind && r.n === n).length >= 3, `${kind}/${n}`);
  // positive control: a bloc allocating 40 MB reads ≥ 35 MB above an idle one (the memory instrument can see memory)
  const big = med(ok.filter((r) => r.kind === 'big').map((r) => r.framesRssKB!)), idle1 = med(ok.filter((r) => r.kind === 'idle' && r.n === 1).map((r) => r.framesRssKB!));
  assert.ok(big - idle1 >= 35 * MB, `big ${big} idle1 ${idle1}`);
  // null control: N = 0 moves the tree by < 25 MB (baseline subtraction does not manufacture a cost)
  for (const r of ok.filter((x) => x.kind === 'none')) assert.ok(Math.abs(r.totalRssKB!) < 25 * MB, `none ${r.id} ${r.totalRssKB}`);
  // every counted cell: all N frames answered a ping, in ONE frames process
  for (const r of ok.filter((x) => x.mode === 'cell' && x.kind !== 'none' && x.kind !== 'codesrc')) { assert.equal(r.pongs, r.n, r.id); assert.equal(r.framesProcs, 1, r.id); }
});

test('LIVE_MAX rule: no larger than the largest measured N whose BUSY blocs stay ≤ 250 MB in the frames process and ≤ 100 % of a core', () => {
  const byN = new Map<number, Row[]>();
  for (const r of ok.filter((x) => x.mode === 'cell' && x.kind === 'busy')) (byN.get(r.n!) ?? byN.set(r.n!, []).get(r.n!)!).push(r);
  const fits = [...byN.entries()].filter(([, rs]) => rs.length >= 2 && med(rs.map((r) => r.framesRssKB!)) <= 250 * MB && med(rs.map((r) => r.framesCpuPct!)) <= 100).map(([n]) => n);
  const largest = Math.max(...fits);
  assert.ok(largest >= 20, `measured busy cells that fit: ${fits}`);
  assert.ok(BLOC_LIVE_MAX <= largest, `BLOC_LIVE_MAX ${BLOC_LIVE_MAX} > largest measured N that fits (${largest})`);
  assert.ok(BLOC_LIVE_MAX >= 21, 'a ~1000 px viewport of 36 px blocs shows ~21 of them: a smaller ceiling would leave visible blocs as placeholders');
});

test('size cap rule: a live bloc AT the cap costs ≤ 25 MB over a tiny one, and the over-cap code fallback stalls the window ≤ 1 s', () => {
  const small = med(ok.filter((r) => r.kind === 'src' && r.bytes === 16 * 1024 && !r.variant).map((r) => r.framesRssKB!));
  const near = ok.filter((r) => r.kind === 'src' && r.bytes === 250 * 1024 && !r.variant);
  assert.ok(near.length >= 3);
  assert.ok(250 * 1024 <= BLOC_HTML_MAX_SOURCE_BYTES, 'the measured source is within the cap');
  assert.ok(med(near.map((r) => r.framesRssKB!)) - small <= 25 * MB, 'live cost at the cap');
  const fallback = ok.filter((r) => r.kind === 'codesrc' && r.bytes === 300 * 1024);
  assert.ok(fallback.length >= 3);
  assert.ok(med(fallback.map((r) => r.maxEvalMs!)) <= 1000, 'code fallback stall');
  assert.equal(BLOC_HTML_MAX_SOURCE_BYTES, 256 * 1024, 'the cap is the measured one');
});

test('sibling freeze: every valid measurement shows ONE looping bloc freezing ALL its siblings (one shared frames process) — the window stays responsive', () => {
  const sib = ok.filter((r) => r.mode === 'siblings');
  assert.ok(sib.length >= 3);
  for (const r of sib) { assert.equal(r.verdict, 'SIBLINGS-FROZEN', r.id); assert.equal(r.framesProcs, 1, r.id); }
});
