// #379 / ADR 0008 — the pure half of the CLI's identity resolution: when the host's answer is used, when the
// env FALLBACK applies, when a replaced session is refused, and what the transitional marker guard blocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  identityEnv,
  resolveHostIdentity,
  SessionSupersededError,
  staleMarkerBlocksSend,
  staleRunMarkerNewRun,
  staleMarkerPaths,
  supersededRefusalMessage,
  IDENTITY_ROUTE,
} from './session-identity.ts';
import { staleRunMarkerBody, staleRunRefusalMessage } from './reparent-run.ts';

const KEY = 'k'.repeat(64);
const ENV = { ORCHESTRA_SESSION_KEY: KEY, ORCHESTRA_WS_ID: 'ws-1' };

type Call = (route: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
const answering = (reply: Record<string, unknown>, seen: Array<{ route: string; body: Record<string, unknown> }> = []): Call =>
  async (route, body) => {
    seen.push({ route, body });
    return reply;
  };
const down: Call = async () => {
  throw new Error('could not reach Orchestra socket');
};

test('a host answer wins: run + generation come from the reply, the call carries the ws id and the key', async () => {
  const seen: Array<{ route: string; body: Record<string, unknown> }> = [];
  const r = await resolveHostIdentity(ENV, answering({ ok: true, runId: 'run-NEW', generation: 3 }, seen));
  assert.deepEqual(r, { source: 'host', runId: 'run-NEW', generation: 3 });
  assert.deepEqual(seen, [{ route: IDENTITY_ROUTE, body: { id: 'ws-1', key: KEY } }]);
});

test('generation 0 / absent / junk reads as unfenced (null), never as a stale number', async () => {
  for (const gen of [0, null, undefined, -1, 1.5, '2']) {
    const r = await resolveHostIdentity(ENV, answering({ ok: true, runId: 'r', generation: gen }));
    assert.deepEqual(r, { source: 'host', runId: 'r', generation: null }, String(gen));
  }
});

test('the identity falls back to the ws id var kept for pre-#233 keepers (ORCHESTRA_WS_ID_IDENTITY)', async () => {
  const seen: Array<{ route: string; body: Record<string, unknown> }> = [];
  await resolveHostIdentity({ ORCHESTRA_SESSION_KEY: KEY, ORCHESTRA_WS_ID_IDENTITY: 'ws-legacy' }, answering({ ok: true, runId: 'r' }, seen));
  assert.equal(seen[0].body.id, 'ws-legacy');
});

test('FALLBACK arms: a keyless session never calls the host; no ws id never calls it; unreachable / unvouched / old app all fall back to the env', async () => {
  const seen: Array<unknown> = [];
  const spy: Call = async (...a) => {
    seen.push(a);
    return {};
  };
  assert.deepEqual(await resolveHostIdentity({ ORCHESTRA_WS_ID: 'ws-1' }, spy), { source: 'env', why: 'no-key' });
  assert.deepEqual(await resolveHostIdentity({ ORCHESTRA_SESSION_KEY: '  ', ORCHESTRA_WS_ID: 'ws-1' }, spy), { source: 'env', why: 'no-key' });
  assert.deepEqual(await resolveHostIdentity({ ORCHESTRA_SESSION_KEY: KEY }, spy), { source: 'env', why: 'no-workspace' });
  assert.equal(seen.length, 0, 'no host call without a key + a ws id');

  assert.deepEqual(await resolveHostIdentity(ENV, down), { source: 'env', why: 'unreachable' });
  assert.deepEqual(await resolveHostIdentity(ENV, answering({})), { source: 'env', why: 'unvouched' }, 'an app older than #379 answers `{}` on an unknown route');
  assert.deepEqual(await resolveHostIdentity(ENV, answering({ ok: false, code: 'unregistered', error: 'x' })), { source: 'env', why: 'unvouched' });
  assert.deepEqual(await resolveHostIdentity(ENV, answering({ ok: false, error: 'internal error' })), { source: 'env', why: 'unvouched' });
  assert.deepEqual(await resolveHostIdentity(ENV, answering({ ok: true })), { source: 'env', why: 'unvouched' }, 'ok without a run is not an answer');
  assert.deepEqual(await resolveHostIdentity(ENV, answering({ ok: true, runId: '   ' })), { source: 'env', why: 'unvouched' });
});

test('a SUPERSEDED session is refused — never a fallback to its env (#128)', async () => {
  await assert.rejects(
    resolveHostIdentity(ENV, answering({ ok: false, code: 'superseded', error: 'this session of workspace ws-1 was superseded' })),
    (e: unknown) => e instanceof SessionSupersededError && /superseded/.test((e as Error).message),
  );
});

test('identityEnv: the host answer overrides the baked run AND generation; an env resolution returns the env untouched', () => {
  const baked = { ORCHESTRA_RUN_ID: 'run-OLD', ORCHESTRA_COORDINATOR_GENERATION: '9', ORCHESTRA_WS_ID: 'ws-1' };
  const live = identityEnv(baked, { source: 'host', runId: 'run-NEW', generation: 2 });
  assert.equal(live.ORCHESTRA_RUN_ID, 'run-NEW');
  assert.equal(live.ORCHESTRA_COORDINATOR_GENERATION, '2');
  assert.equal(live.ORCHESTRA_WS_ID, 'ws-1');
  const unfenced = identityEnv(baked, { source: 'host', runId: 'run-NEW', generation: null });
  assert.equal(unfenced.ORCHESTRA_COORDINATOR_GENERATION, undefined, 'a live run is never paired with a frozen generation');
  assert.equal(baked.ORCHESTRA_RUN_ID, 'run-OLD', 'the input is not mutated');
  assert.equal(identityEnv(baked, { source: 'env', why: 'unreachable' }), baked);
  assert.equal(identityEnv(baked, null), baked);
});

test('the transitional marker guard: blocks a send whose env run is NOT the run the marker names; an env that already carries it passes', () => {
  const body = staleRunMarkerBody('run-NEW');
  assert.equal(staleRunMarkerNewRun(body), 'run-NEW');
  assert.match(staleMarkerBlocksSend(body, 'run-OLD') ?? '', /^stale run:/, 'the stale env session is refused');
  assert.match(staleMarkerBlocksSend(body, undefined) ?? '', /^stale run:/, 'no env run → refused (fail closed)');
  assert.match(staleMarkerBlocksSend(body, '') ?? '', /^stale run:/);
  assert.equal(staleMarkerBlocksSend(body, 'run-NEW'), null, 'a freshly built env (bash mode) is already on the new run');
  assert.equal(staleMarkerBlocksSend(body, '  run-NEW  '), null);
  assert.match(staleMarkerBlocksSend('stale run: odd\n', 'run-NEW') ?? '', /^stale run: odd/, 'a marker that names no run blocks (fail closed)');
  assert.equal(staleMarkerBlocksSend('', 'run-NEW'), null, 'an empty file is not a marker');
});

test('the refusal text for a replaced session names the rule, never a key', () => {
  const msg = supersededRefusalMessage('this session of workspace ws-1 was superseded');
  assert.match(msg, /superseded/);
  assert.ok(!msg.includes(KEY));
});

test('MAJOR-2 the marker is looked up from the worktree root, then cwd and EVERY ancestor — never cwd alone', () => {
  const marker = (d: string): string => path.join(d, '.orchestra', 'bus-run-stale');
  const fromSub = staleMarkerPaths({ ORCHESTRA_WORKTREE: '/wt' }, '/wt/src/deep');
  assert.equal(fromSub[0], marker('/wt'), 'the session worktree env comes first');
  assert.ok(fromSub.includes(marker('/wt/src/deep')) && fromSub.includes(marker('/wt/src')) && fromSub.includes(marker('/wt')) && fromSub.includes(marker('/')), 'cwd and each ancestor');
  assert.deepEqual(staleMarkerPaths({ ORCHESTRA_WORKSPACE_PATH: '/script-ws', ORCHESTRA_WORKTREE: '/wt' }, '/x').slice(0, 2), [marker('/script-ws'), marker('/wt')], 'setup/run scripts: the explicit path wins, then the worktree');
  assert.deepEqual(staleMarkerPaths({}, '/a/b').slice(0, 3), [marker('/a/b'), marker('/a'), marker('/')], 'no env at all: walk up from cwd');
  assert.equal(new Set(staleMarkerPaths({ ORCHESTRA_WORKTREE: '/wt' }, '/wt')).size, staleMarkerPaths({ ORCHESTRA_WORKTREE: '/wt' }, '/wt').length, 'no duplicates');
});

test('MINOR-3 a keyed session whose host did not answer is told to retry, not to restart (a restart is refused mid-turn)', () => {
  const stale = staleRunRefusalMessage('stale run: x', { hostDidNotAnswer: true });
  assert.match(stale, /host did not answer/);
  assert.doesNotMatch(stale, /orchestra restart/);
  assert.match(staleRunRefusalMessage('stale run: x'), /orchestra restart/, 'a keyless session keeps the restart advice');
});
