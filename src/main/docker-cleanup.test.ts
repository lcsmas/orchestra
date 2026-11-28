// #696 — `orchestra delete` removes the member's containers WITH their anonymous volumes, and the host sweep removes the containers of workspaces that no longer exist.
// The real Docker client (docker-api.ts) over HTTP on a unix socket against the fake dockerd (src/keeper/fake-docker-daemon.ts: honours `?v=` / `force` / 409 / volume-in-use like dockerd).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeDaemon, type FakeDaemon } from '../keeper/fake-docker-daemon.ts';
import { createDockerApi, DockerApiError, type DockerApi } from './docker-api.ts';
import { __resetSweepForTests, removeWorkspaceContainers, SWEEP_MAX_PER_PASS, sweepOrphanContainers, type SweepDeps } from './docker-cleanup.ts';
import { formatCleanupReport, isAnonymousVolumeName } from '../shared/docker-cleanup.ts';

const ANON = (n: number): string => n.toString(16).padStart(64, 'a');
const L = (ws: string, run = 'run-1'): Record<string, string> => ({ 'orchestra.ws': ws, 'orchestra.run': run });

let dir: string;
let d: FakeDaemon;
let api: DockerApi;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dclean-'));
  d = await startFakeDaemon(path.join(dir, 'd.sock'));
  api = createDockerApi({ socketPath: d.sockPath });
  __resetSweepForTests();
});
afterEach(async () => {
  await d.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isAnonymousVolumeName: only a 64-hex name is the daemon\'s own', () => {
  assert.equal(isAnonymousVolumeName(ANON(1)), true);
  assert.equal(isAnonymousVolumeName('pgdata'), false);
  assert.equal(isAnonymousVolumeName(ANON(1).slice(1)), false);
});

// ── (1) orchestra delete ───────────────────────────────────────────────────────────────────────────────────────────────────

test('delete: every container labelled for the workspace is stopped + removed with its anonymous volumes; a bystander and its volume are untouched', async () => {
  d.setContainer('web', { labels: L('ws-a'), running: true, name: 'a-web', image: 'nginx' });
  d.setContainer('db', { labels: L('ws-a'), running: true, name: 'a-db', image: 'mysql', mounts: [{ type: 'volume', name: ANON(1), destination: '/var/lib/mysql' }] });
  d.setContainer('old', { labels: L('ws-a'), running: false, name: 'a-old', image: 'redis', mounts: [{ type: 'volume', name: ANON(2), destination: '/data' }] });
  d.setContainer('other', { labels: L('ws-b'), running: true, name: 'b-db', mounts: [{ type: 'volume', name: ANON(3), destination: '/data' }] });
  d.setContainer('plain', { labels: null, running: true, name: 'hand-made', mounts: [{ type: 'volume', name: ANON(4), destination: '/data' }] });

  const r = await removeWorkspaceContainers(api, 'ws-a');

  assert.deepEqual(d.containerIds().sort(), ['other', 'plain']);
  assert.deepEqual(d.volumeNames().sort(), [ANON(3), ANON(4)].sort(), 'the anonymous volumes of ws-a went with their containers; nobody else\'s');
  assert.deepEqual(r.removed.map((c) => c.name).sort(), ['a-db', 'a-old', 'a-web']);
  assert.equal(r.removed.find((c) => c.name === 'a-db')?.anonymousVolumes, 1);
  assert.deepEqual(r.failed, []);
  const text = formatCleanupReport(r).join('\n');
  assert.match(text, /Removed 3 Docker containers/);
  assert.match(text, /a-db \(mysql\) — 1 anonymous volume\b/);
});

test('delete: the removal asks the daemon for v=1 (anonymous volumes) and a graceful stop of the running ones first', async () => {
  d.setContainer('db', { labels: L('ws-a'), running: true, name: 'a-db' });
  await removeWorkspaceContainers(api, 'ws-a');
  const reqs = d.seen.map((s) => `${s.method} ${s.url.replace(/\?.*/, '')}`);
  assert.ok(reqs.indexOf('POST /containers/db/stop') !== -1 && reqs.indexOf('POST /containers/db/stop') < reqs.indexOf('DELETE /containers/db'), reqs.join(' | '));
  assert.ok(d.seen.some((s) => s.method === 'DELETE' && /[?&]v=1(&|$)/.test(s.url)), 'rm -v');
});

test('delete: named volumes are LISTED and kept by default; --volumes removes them, except one another container still uses', async () => {
  const mk = (): void => {
    d.setContainer('db', { labels: L('ws-a'), running: true, name: 'a-db', mounts: [{ type: 'volume', name: 'pgdata', destination: '/p' }, { type: 'volume', name: 'shared', destination: '/s' }, { type: 'bind', destination: '/src' }] });
    d.setContainer('keep', { labels: L('ws-b'), running: true, name: 'b-keep', mounts: [{ type: 'volume', name: 'shared', destination: '/s' }] });
  };
  mk();
  const kept = await removeWorkspaceContainers(api, 'ws-a');
  assert.deepEqual(d.volumeNames().sort(), ['pgdata', 'shared']);
  assert.deepEqual(kept.keptNamedVolumes.sort(), ['pgdata', 'shared']);
  assert.deepEqual(kept.removedNamedVolumes, []);
  assert.match(formatCleanupReport(kept).join('\n'), /Named volumes kept \(re-run with --volumes to remove\): pgdata, shared/);

  await d.close();
  d = await startFakeDaemon(path.join(dir, 'd2.sock'));
  api = createDockerApi({ socketPath: d.sockPath });
  mk();
  const gone = await removeWorkspaceContainers(api, 'ws-a', { removeNamedVolumes: true });
  assert.deepEqual(d.volumeNames(), ['shared'], 'pgdata removed; `shared` is mounted by b-keep: the daemon refuses and nothing forces it');
  assert.deepEqual(gone.removedNamedVolumes, ['pgdata']);
  assert.match(gone.keptNamedVolumes.join(), /shared \(still used by another container\)/);
});

test('delete: a `docker run --rm` container and a workspace with no container are handled; the label is the only selector', async () => {
  d.setContainer('tmp', { labels: L('ws-a'), running: true, autoRemove: true, name: 'a-tmp' });
  d.setContainer('lookalike', { labels: { 'orchestra.ws': 'ws-a ', 'orchestra.run': 'run-1' }, running: true, name: 'padded' });
  const r = await removeWorkspaceContainers(api, 'ws-a');
  assert.deepEqual(r.removed.map((c) => c.name), ['a-tmp']);
  assert.deepEqual(d.containerIds(), ['lookalike'], 'exact label equality — a hand-padded value is not the workspace\'s');
  const none = await removeWorkspaceContainers(api, 'ws-zzz');
  assert.deepEqual(formatCleanupReport(none), [], 'nothing Docker-side → nothing printed');
});

test('delete: no daemon → reported unavailable, never thrown; a failing removal is reported and the others still go', async () => {
  const down = await removeWorkspaceContainers(createDockerApi({ socketPath: path.join(dir, 'nobody.sock') }), 'ws-a');
  assert.equal(down.unavailable, true);

  d.setContainer('c1', { labels: L('ws-a'), running: false, name: 'one' });
  d.setContainer('c2', { labels: L('ws-a'), running: false, name: 'two' });
  const flaky: DockerApi = { ...api, removeContainer: async (id, o) => { if (id === 'c1') throw new DockerApiError('docker remove c1: HTTP 500 — device busy', 'http', 500); return api.removeContainer(id, o); } };
  const r = await removeWorkspaceContainers(flaky, 'ws-a');
  assert.deepEqual(d.containerIds(), ['c1']);
  assert.equal(r.failed.length, 1);
  assert.match(formatCleanupReport(r).join('\n'), /Could not remove container one: .*device busy/);
});

// ── (2) the host sweep ─────────────────────────────────────────────────────────────────────────────────────────────────────

function sweepDeps(o: { live?: string[]; runs?: string[]; ready?: boolean } = {}): SweepDeps & { infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    apis: async () => [api],
    storeReady: () => o.ready !== false,
    workspaceExists: (id) => (o.live ?? []).includes(id),
    runKnown: (run) => (o.runs ?? ['run-1']).includes(run),
    info: (m) => void infos.push(m),
    warn: (m) => void warns.push(m),
  };
}

test('sweep: a container of a deleted workspace is removed with its anonymous volumes, one log line each; live workspaces\' containers stay', async () => {
  d.setContainer('o1', { labels: L('ws-gone'), running: false, name: 'nmc3313-db', image: 'mysql', mounts: [{ type: 'volume', name: ANON(1), destination: '/d' }] });
  d.setContainer('o2', { labels: L('ws-gone2'), running: true, name: 'nmc3754-web' });
  d.setContainer('live', { labels: L('ws-live'), running: true, name: 'live-web', mounts: [{ type: 'volume', name: ANON(2), destination: '/d' }] });
  d.setContainer('plain', { labels: null, running: true, name: 'unlabelled' });
  const deps = sweepDeps({ live: ['ws-live'] });

  const res = await sweepOrphanContainers(deps);

  assert.equal(res.removed, 2);
  assert.deepEqual(d.containerIds().sort(), ['live', 'plain']);
  assert.deepEqual(d.volumeNames(), [ANON(2)]);
  assert.equal(deps.infos.length, 2, 'one log line per removed container');
  assert.match(deps.infos.join('\n'), /removed container nmc3313-db .* of deleted workspace ws-gone — 1 anonymous volume\(s\) removed/);
  assert.match(deps.infos.join('\n'), /nmc3754-web .* of deleted workspace ws-gone2/);
});

test('sweep: named volumes are never removed (listed in the line); a second pass finds nothing', async () => {
  d.setContainer('o1', { labels: L('ws-gone'), running: false, name: 'old-db', mounts: [{ type: 'volume', name: 'bigdata', destination: '/d' }] });
  const deps = sweepDeps();
  await sweepOrphanContainers(deps);
  assert.deepEqual(d.volumeNames(), ['bigdata']);
  assert.match(deps.infos[0], /named volumes kept: bigdata/);
  assert.equal((await sweepOrphanContainers(sweepDeps())).removed, 0);
});

test('sweep: a container another Orchestra instance stamped (run this app does not know) is NOT ours', async () => {
  d.setContainer('foreign', { labels: L('ws-dev', 'run-of-the-dev-build'), running: true, name: 'dev-db' });
  d.setContainer('norun', { labels: { 'orchestra.ws': 'ws-x' }, running: true, name: 'no-run-stamp' });
  const res = await sweepOrphanContainers(sweepDeps());
  assert.equal(res.removed, 0);
  assert.deepEqual(d.containerIds().sort(), ['foreign', 'norun']);
});

test('sweep: an unloaded store removes NOTHING (every workspace would look deleted)', async () => {
  d.setContainer('o1', { labels: L('ws-live'), running: true, name: 'live-db' });
  const res = await sweepOrphanContainers(sweepDeps({ ready: false }));
  assert.equal(res.skipped, 'store-not-ready');
  assert.deepEqual(d.containerIds(), ['o1']);
});

test('sweep: at most SWEEP_MAX_PER_PASS per pass, the rest next pass; no daemon → skipped, no throw', async () => {
  for (let i = 0; i < SWEEP_MAX_PER_PASS + 3; i++) d.setContainer(`o${i}`, { labels: L(`ws-gone-${i}`), running: false, name: `orphan-${i}` });
  const first = await sweepOrphanContainers(sweepDeps());
  assert.equal(first.removed, SWEEP_MAX_PER_PASS);
  assert.equal(d.containerIds().length, 3);
  assert.equal((await sweepOrphanContainers(sweepDeps())).removed, 3);

  const dead = sweepDeps();
  dead.apis = async () => [createDockerApi({ socketPath: path.join(dir, 'nobody.sock') })];
  assert.equal((await sweepOrphanContainers(dead)).skipped, 'no-daemon');
});

test('sweep: a failing removal is warned about and counted, the pass goes on', async () => {
  d.setContainer('c1', { labels: L('ws-g1'), running: false, name: 'one' });
  d.setContainer('c2', { labels: L('ws-g2'), running: false, name: 'two' });
  const deps = sweepDeps();
  deps.apis = async () => [{ ...api, removeContainer: async (id, o) => { if (id === 'c1') throw new DockerApiError('boom', 'http', 500); return api.removeContainer(id, o); } } as DockerApi];
  const res = await sweepOrphanContainers(deps);
  assert.deepEqual([res.removed, res.failed], [1, 1]);
  assert.match(deps.warns.join('\n'), /could not remove container of deleted workspace ws-g1/);
});
