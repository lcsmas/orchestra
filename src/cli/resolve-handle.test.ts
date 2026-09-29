import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHandle, type HandleCandidate } from './resolve-handle.ts';

// #144 — the PURE canonicalizer: full id / 8-char prefix / name → full id, and
// the ambiguous/unknown refusals. Drives the exact rules `send` applies before
// any bus row is written. Each test names the clause it kills.

const FULL_A = '0a5c25bb-1111-4222-8333-444455556666';
const FULL_B = '0a5c25bb-9999-4888-8777-666655554444'; // same 8-char prefix as A
const FULL_C = 'b3f55639-1d61-4d21-b6bf-0d701445dc12';

const CANDS: HandleCandidate[] = [
  { id: FULL_A, name: 'impl-144' },
  { id: FULL_C, name: 'ops-wave-g' },
];

test('resolveHandle: an 8-char prefix resolves to the FULL id (the canary case)', () => {
  // COVERS the whole point of #144 — `send --to 0a5c25bb` must become FULL_A.
  // MUTANT: drop the id-prefix tier → this returns not-ok, so the send would
  // have to store the raw handle (the defect).
  const r = resolveHandle('0a5c25bb', CANDS);
  assert.deepEqual(r, { ok: true, id: FULL_A });
});

test('resolveHandle: a full id passes through unchanged', () => {
  assert.deepEqual(resolveHandle(FULL_C, CANDS), { ok: true, id: FULL_C });
});

test('resolveHandle: a workspace NAME resolves to its id', () => {
  // MUTANT: drop the name tier → unknown, refused.
  assert.deepEqual(resolveHandle('ops-wave-g', CANDS), { ok: true, id: FULL_C });
});

test('resolveHandle: an unknown handle is REFUSED (rc≠0), never silently passed', () => {
  const r = resolveHandle('nope', CANDS);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /matches no workspace/);
});

test('resolveHandle: an AMBIGUOUS prefix is refused and NAMES the candidates', () => {
  // Two candidates share the 8-char prefix `0a5c25bb`. A resolver that returned
  // the first would deliver mail to the wrong workspace silently.
  // MUTANT: `byPrefix.length === 1` → `>= 1` picks the first → this stops being
  // refused, and the error's candidate list is what proves the refusal is
  // actionable (carry-forward: a marker as specific as the claim it certifies).
  const r = resolveHandle('0a5c25bb', [...CANDS, { id: FULL_B, name: 'other' }]);
  assert.equal(r.ok, false);
  const err = (r as { error: string }).error;
  assert.match(err, /ambiguous/);
  assert.match(err, new RegExp(FULL_A));
  assert.match(err, new RegExp(FULL_B));
});

test('resolveHandle: an ambiguous NAME (two workspaces same name) is refused', () => {
  const dup: HandleCandidate[] = [
    { id: FULL_A, name: 'twin' },
    { id: FULL_C, name: 'twin' },
  ];
  const r = resolveHandle('twin', dup);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /ambiguous/);
});

test('resolveHandle: an EXACT id wins even when it is also a prefix of another', () => {
  // FULL_A is `0a5c25bb-1111-…`; a candidate whose id is a longer string
  // starting with FULL_A would be a prefix match, but the exact id must win so
  // the caller who typed a full id is never told it is ambiguous.
  const longer = `${FULL_A}-x`;
  const r = resolveHandle(FULL_A, [...CANDS, { id: longer, name: 'longer' }]);
  assert.deepEqual(r, { ok: true, id: FULL_A });
});

test('resolveHandle: a blank/whitespace --to is refused', () => {
  assert.equal(resolveHandle('   ', CANDS).ok, false);
});

// #221 R3 — every refusal names the verb that was typed (`ask` used to print "orchestra send:").
test('resolveHandle: each refusal branch names the VERB it was given; the default stays `send`', () => {
  const err = (r: ReturnType<typeof resolveHandle>): string => (r.ok ? '' : r.error);
  for (const verb of ['ask', 'gate open']) {
    assert.match(err(resolveHandle('  ', CANDS, verb)), new RegExp(`^orchestra ${verb}: --to is empty`), `${verb} / empty`);
    assert.match(err(resolveHandle('nope', CANDS, verb)), new RegExp(`^orchestra ${verb}: --to "nope" matches no workspace`), `${verb} / unknown`);
    const dup = [
      { id: 'aaaa1111-0', name: 'same' },
      { id: 'bbbb2222-0', name: 'same' },
    ];
    assert.match(err(resolveHandle('same', dup, verb)), new RegExp(`^orchestra ${verb}: --to "same" is ambiguous`), `${verb} / ambiguous name`);
    const pre = [
      { id: 'cccc3333-a', name: 'x' },
      { id: 'cccc3333-b', name: 'y' },
    ];
    assert.match(err(resolveHandle('cccc3333', pre, verb)), new RegExp(`^orchestra ${verb}: --to "cccc3333" is ambiguous`), `${verb} / ambiguous prefix`);
  }
  assert.match(err(resolveHandle('nope', CANDS)), /^orchestra send: --to "nope" matches no workspace/, 'default verb is send');
});
