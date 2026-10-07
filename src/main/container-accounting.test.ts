import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTING_STALE_MS, MAX_STATS_PER_PASS, STATS_CONCURRENCY, __resetContainerAccountingForTests, getContainerAccounting, refreshContainerAccounting, type ContainerAccountingDeps } from './container-accounting.ts';
import { DockerApiError, type DockerApi, type DockerContainerSummary } from './docker-api.ts';

/** The fake clock of `world()` (`w.now`): reads pass it so the staleness limit is judged on the SAME clock as the refresh. */
const NOW = 5_000;

const MB = 1024 * 1024;
const RUN_START_MS = 1_000_000_000; // 1_000_000 s
const ctr = (id: string, created: number, labels: Record<string, string> = {}, name = id): DockerContainerSummary => ({ id, name, image: 'alpine:3', state: 'running', status: 'Up', created, labels });
const stats = (usage: number, inactive = 0) => ({ memory_stats: { usage, stats: { inactive_file: inactive } } });

/** A fake daemon: the running list + per-id stats behaviour, every call recorded. */
function world() {
  const w = {
    running: [] as DockerContainerSummary[],
    statsFor: new Map<string, unknown | Error | null>(),
    listCalls: 0,
    listArgs: [] as unknown[],
    statsCalls: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
    listThrows: null as Error | null,
    infos: [] as string[],
    warns: [] as string[],
    runStart: RUN_START_MS as number | null,
    now: 5_000,
  };
  const api = {
    socketPath: null,
    resolveSocket: async () => '/run/docker.sock',
    available: async () => true,
    listContainers: async (o?: unknown) => {
      w.listCalls += 1;
      w.listArgs.push(o);
      if (w.listThrows) throw w.listThrows;
      return w.running;
    },
    containerStats: async (id: string) => {
      w.statsCalls.push(id);
      w.inFlight += 1;
      w.maxInFlight = Math.max(w.maxInFlight, w.inFlight);
      await new Promise((r) => setImmediate(r));
      w.inFlight -= 1;
      const v = w.statsFor.get(id);
      if (v instanceof Error) throw v;
      return v === undefined ? stats(10 * MB) : v;
    },
  } as unknown as DockerApi;
  const deps: ContainerAccountingDeps = { api, earliestLiveRunStartMs: () => w.runStart, now: () => w.now, info: (m) => w.infos.push(m), warn: (m) => w.warns.push(m) };
  return { w, deps };
}
const fresh = () => {
  __resetContainerAccountingForTests();
  return world();
};

test('K1 AC: NO container-stats call when no attributed container exists (unlabelled/older containers, or none at all) — the daemon is listed once, never asked for stats', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('human-stack', 10), ctr('human-db', 20)]; // predate the run, no label
  await refreshContainerAccounting(deps);
  assert.deepEqual([w.listCalls, w.statsCalls.length], [1, 0]);
  assert.deepEqual([getContainerAccounting(NOW).docker, getContainerAccounting(NOW).byWorkspace.size, getContainerAccounting(NOW).unattributed.count], ['ok', 0, 0]);
  w.running = [];
  await refreshContainerAccounting(deps);
  assert.equal(w.statsCalls.length, 0);
});

test('K2 positive control: ONE stats call per attributed container, in ONE pass; bytes are usage minus reclaimable cache and SUM per workspace; the figure replaces (not accumulates) on the next tick', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('c1', 1, { 'orchestra.ws': 'ws-a' }), ctr('c2', 1, { 'orchestra.ws': 'ws-a' }), ctr('c3', 1, { 'orchestra.ws': 'ws-b' })];
  w.statsFor.set('c1', stats(300 * MB, 50 * MB));
  w.statsFor.set('c2', stats(100 * MB));
  w.statsFor.set('c3', stats(7 * MB));
  await refreshContainerAccounting(deps);
  assert.deepEqual(w.statsCalls.sort(), ['c1', 'c2', 'c3']);
  const acc = getContainerAccounting(NOW);
  assert.equal(acc.byWorkspace.get('ws-a'), 350 * MB);
  assert.equal(acc.byWorkspace.get('ws-b'), 7 * MB);
  assert.deepEqual([acc.countByWorkspace.get('ws-a'), acc.sampledAt, acc.docker], [2, 5_000, 'ok']);
  w.statsFor.set('c1', stats(10 * MB));
  w.now = 65_000;
  await refreshContainerAccounting(deps);
  assert.equal(getContainerAccounting(NOW).byWorkspace.get('ws-a'), 110 * MB, 'replaced, not accumulated');
  assert.equal(getContainerAccounting(NOW).sampledAt, 65_000);
});

test('K3 AC: an UNLABELLED container created after the earliest live run start is unattributed (listed, counted, never touched — no stats, no stop); an older one and a labelled one are not', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('mine', 2_000_000, { 'orchestra.ws': 'ws-a' }), ctr('stray', 2_000_000, {}, 'web-1'), ctr('older', 5)];
  await refreshContainerAccounting(deps);
  const u = getContainerAccounting(NOW).unattributed;
  assert.deepEqual([u.count, u.ids, u.names], [1, ['stray'], ['web-1']]);
  assert.deepEqual(w.statsCalls, ['mine'], 'stats only for the ATTRIBUTED container');
  w.runStart = null; // no live run any more → nothing can be unattributed
  await refreshContainerAccounting(deps);
  assert.equal(getContainerAccounting(NOW).unattributed.count, 0);
});

test('K4 unattributed is logged once per DISTINCT set (WARN, naming them and "NEVER touched"); the clearing is logged once; no "cleared" line before anything was ever flagged', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('x', 2_000_000, {}, 'web-1')];
  await refreshContainerAccounting(deps);
  await refreshContainerAccounting(deps);
  assert.equal(w.warns.filter((l) => /unattributed container/.test(l)).length, 1);
  assert.match(w.warns[0], /web-1 \(x\) — counted and reported, NEVER touched/);
  w.running = [ctr('x', 2_000_000, {}, 'web-1'), ctr('y', 2_000_000, {}, 'db-1')];
  await refreshContainerAccounting(deps);
  assert.equal(w.warns.filter((l) => /unattributed container/.test(l)).length, 2, 'a new member of the set re-logs');
  w.running = [];
  await refreshContainerAccounting(deps);
  await refreshContainerAccounting(deps);
  assert.equal(w.infos.filter((l) => /no unattributed container any more/.test(l)).length, 1);
  const f = fresh();
  await refreshContainerAccounting(f.deps);
  assert.equal(f.w.infos.filter((l) => /no unattributed/.test(l)).length, 0);
});

test('K5 Docker unreachable: recorded as "unavailable" (NOTHING measured, last figures dropped — not zero containers, not stale bytes), logged once per transition, recovery logged, never throws', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('c1', 1, { 'orchestra.ws': 'ws-a' })];
  await refreshContainerAccounting(deps);
  assert.equal(getContainerAccounting(NOW).byWorkspace.get('ws-a'), 10 * MB);
  w.listThrows = new DockerApiError('docker unavailable: ENOENT', 'unavailable');
  for (let i = 0; i < 3; i++) await refreshContainerAccounting(deps);
  const acc = getContainerAccounting(NOW);
  assert.deepEqual([acc.docker, acc.byWorkspace.size, acc.sampledAt], ['unavailable', 0, 5_000]);
  assert.equal(w.infos.filter((l) => /Docker not reachable/.test(l)).length, 1, 'ONE line for three failed ticks');
  w.listThrows = null;
  await refreshContainerAccounting(deps);
  assert.equal(getContainerAccounting(NOW).docker, 'ok');
  assert.equal(w.infos.filter((l) => /reachable again/.test(l)).length, 1);
});

test('K6 a stats failure on ONE container counts it unmeasured (WARN) and never loses the others; a container that vanished between list and stats (404) is not counted at all; an empty stats document is unmeasured, not 0', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('ok', 1, { 'orchestra.ws': 'ws-a' }), ctr('boom', 1, { 'orchestra.ws': 'ws-a' }), ctr('gone', 1, { 'orchestra.ws': 'ws-b' }), ctr('blank', 1, { 'orchestra.ws': 'ws-c' })];
  w.statsFor.set('ok', stats(40 * MB));
  w.statsFor.set('boom', new DockerApiError('docker stats: HTTP 500', 'http', 500));
  w.statsFor.set('gone', null);
  w.statsFor.set('blank', { memory_stats: {} });
  await refreshContainerAccounting(deps);
  const acc = getContainerAccounting(NOW);
  assert.equal(acc.byWorkspace.get('ws-a'), 40 * MB);
  assert.equal(acc.countByWorkspace.get('ws-a'), 2);
  assert.equal(acc.countByWorkspace.has('ws-b'), false, 'a 404 container is not counted');
  assert.deepEqual([acc.byWorkspace.has('ws-c'), acc.countByWorkspace.get('ws-c')], [false, 1], 'an empty document is unmeasured, not a 0 figure');
  assert.equal(acc.unmeasured, 2);
  assert.ok(w.warns.some((l) => /stats of boom.*failed — counted unmeasured/.test(l)));
});

test('K7 the pass is bounded: at most STATS_CONCURRENCY stats in flight, at most MAX_STATS_PER_PASS measured (the rest counted unmeasured, NOT silently dropped)', async () => {
  const { w, deps } = fresh();
  const n = MAX_STATS_PER_PASS + 6;
  w.running = Array.from({ length: n }, (_, i) => ctr(`c${i}`, 1, { 'orchestra.ws': 'ws-a' }));
  await refreshContainerAccounting(deps);
  assert.ok(w.maxInFlight >= 2 && w.maxInFlight <= STATS_CONCURRENCY, `max in flight ${w.maxInFlight}`);
  assert.equal(w.statsCalls.length, MAX_STATS_PER_PASS);
  const acc = getContainerAccounting(NOW);
  assert.equal(acc.countByWorkspace.get('ws-a'), n);
  assert.equal(acc.unmeasured, 6);
  assert.equal(acc.byWorkspace.get('ws-a'), MAX_STATS_PER_PASS * 10 * MB);
});

test('K8 single-flight: two overlapping refreshes (a slow daemon across ticks) share ONE pass — one list, one stats call per container', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('c1', 1, { 'orchestra.ws': 'ws-a' })];
  const [a, b] = await Promise.all([refreshContainerAccounting(deps), refreshContainerAccounting(deps)]);
  assert.equal(a, b);
  assert.deepEqual([w.listCalls, w.statsCalls.length], [1, 1]);
  await refreshContainerAccounting(deps);
  assert.equal(w.listCalls, 2, 'a later tick starts a new pass');
});

test('K9 before any refresh the read is "not-sampled" (sampledAt null) — a consumer tells never-measured from measured-zero; a refresh whose body throws unexpectedly is "error" (nothing trusted, NOT the last figures kept forever as if still right)', async () => {
  const { w, deps } = fresh();
  assert.deepEqual([getContainerAccounting(NOW).docker, getContainerAccounting(NOW).sampledAt], ['not-sampled', null]);
  w.running = [ctr('c1', 1, { 'orchestra.ws': 'ws-a' })];
  await refreshContainerAccounting(deps);
  assert.equal(getContainerAccounting(NOW).byWorkspace.get('ws-a'), 10 * MB);
  (deps as { earliestLiveRunStartMs: () => number | null }).earliestLiveRunStartMs = () => {
    throw new Error('bus gone');
  };
  await refreshContainerAccounting(deps);
  const bad = getContainerAccounting(NOW);
  assert.deepEqual([bad.docker, bad.byWorkspace.size], ['error', 0]);
  assert.ok(w.warns.some((l) => /refresh failed/.test(l)));
});

test('K10 the daemon is asked for RUNNING containers only (a stopped container holds no memory and must never be attributed or counted unattributed)', async () => {
  const { w, deps } = fresh();
  await refreshContainerAccounting(deps);
  assert.deepEqual(w.listArgs, [{ status: ['running'] }]);
});

/** A second fake daemon on ANOTHER socket (a member whose relay is pinned elsewhere). */
function secondDaemon(sock: string, containers: DockerContainerSummary[], opts: { down?: boolean; statsOf?: Record<string, unknown> } = {}) {
  const calls = { list: 0, stats: [] as string[] };
  const api = {
    socketPath: sock,
    resolveSocket: async () => sock,
    available: async () => !opts.down,
    listContainers: async () => {
      calls.list += 1;
      if (opts.down) throw new DockerApiError('docker unavailable: ECONNREFUSED', 'unavailable');
      return containers;
    },
    containerStats: async (id: string) => {
      calls.stats.push(id);
      return opts.statsOf?.[id] ?? stats(33 * MB);
    },
  } as unknown as DockerApi;
  return { api, calls };
}

test('K11 a member whose relay is pinned to ANOTHER daemon is counted there (stats asked of THAT daemon); a daemon on the SAME socket is not queried twice; the app-own daemon alone answering still counts', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('own', 1, { 'orchestra.ws': 'ws-a' })];
  const other = secondDaemon('/run/other.sock', [ctr('far', 1, { 'orchestra.ws': 'ws-b' })]);
  const same = secondDaemon('/run/docker.sock', [ctr('dup', 1, { 'orchestra.ws': 'ws-c' })]);
  (deps as { extraApis?: () => DockerApi[] }).extraApis = () => [other.api, same.api];
  await refreshContainerAccounting(deps);
  const acc = getContainerAccounting(NOW);
  assert.deepEqual([acc.byWorkspace.get('ws-a'), acc.byWorkspace.get('ws-b'), acc.byWorkspace.has('ws-c')], [10 * MB, 33 * MB, false]);
  assert.deepEqual([w.statsCalls, other.calls.stats, same.calls.list], [['own'], ['far'], 0], 'each container is measured on the daemon it lives on; the same-socket duplicate is skipped');
});

test('K12 one daemon down, another up → measured from the one that answered (warned ONCE, not per tick); ALL down → unavailable', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('own', 1, { 'orchestra.ws': 'ws-a' })];
  const dead = secondDaemon('/run/dead.sock', [], { down: true });
  (deps as { extraApis?: () => DockerApi[] }).extraApis = () => [dead.api];
  for (let i = 0; i < 3; i++) await refreshContainerAccounting(deps);
  assert.deepEqual([getContainerAccounting(NOW).docker, getContainerAccounting(NOW).byWorkspace.get('ws-a')], ['ok', 10 * MB]);
  assert.equal(w.warns.filter((l) => /did not answer/.test(l)).length, 1);
  assert.equal(getContainerAccounting(NOW).daemonsDown, 1, 'a partial outage is MARKED (the figures are a lower bound), not read as a complete zero');
  w.listThrows = new DockerApiError('docker unavailable', 'unavailable');
  await refreshContainerAccounting(deps);
  assert.equal(getContainerAccounting(NOW).docker, 'unavailable');
});

test('K15 (pre-review #2) every daemon answering ⇒ daemonsDown 0; a good pass nobody has refreshed for ACCOUNTING_STALE_MS reads "stale" — never the old figures as current', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('own', 1, { 'orchestra.ws': 'ws-a' })];
  await refreshContainerAccounting(deps);
  assert.equal(getContainerAccounting(NOW).daemonsDown, 0);
  const at = getContainerAccounting(NOW).sampledAt as number;
  assert.equal(getContainerAccounting(at + ACCOUNTING_STALE_MS).docker, 'ok', 'exactly at the limit is still current');
  const stale = getContainerAccounting(at + ACCOUNTING_STALE_MS + 1);
  assert.deepEqual([stale.docker, stale.byWorkspace.size, stale.unattributed.count, stale.sampledAt], ['stale', 0, 0, at]);
});

test('K13 a container labelled for a workspace the store no longer has is an ORPHAN: unattributed (named "orphan of <id>"), WARNed once, NEVER measured or touched — whatever its age', async () => {
  const { w, deps } = fresh();
  w.running = [ctr('mine', 1, { 'orchestra.ws': 'ws-a' }), ctr('ghost', 1, { 'orchestra.ws': 'ws-deleted' }, 'g9-web')];
  (deps as { workspaceKnown?: (id: string) => boolean }).workspaceKnown = (id) => id === 'ws-a';
  w.runStart = null; // no live run: an orphan needs none
  await refreshContainerAccounting(deps);
  await refreshContainerAccounting(deps);
  const u = getContainerAccounting(NOW).unattributed;
  assert.deepEqual([u.count, u.ids, u.names], [1, ['ghost'], ['g9-web (orphan of ws-deleted)']]);
  assert.equal(w.statsCalls.includes('ghost'), false);
  assert.equal(w.warns.filter((l) => /orphan of deleted workspace ws-deleted/.test(l)).length, 1);
});

test('K14 an orphan needs a run stamp the app knows: another Orchestra instance\'s containers on the shared daemon are NOT reported (no false alarm in the LEAD\'s escalation), this app\'s deleted workspace\'s container is', async () => {
  const { w, deps } = fresh();
  w.running = [
    ctr('ghost', 1, { 'orchestra.ws': 'ws-deleted', 'orchestra.run': 'run-mine' }, 'g9-web'),
    ctr('foreign', 1, { 'orchestra.ws': 'ws-elsewhere', 'orchestra.run': 'run-elsewhere' }, 'dev-web'),
  ];
  Object.assign(deps, { workspaceKnown: () => false, runKnown: (r: string) => r === 'run-mine' });
  w.runStart = null;
  await refreshContainerAccounting(deps);
  const u = getContainerAccounting(NOW).unattributed;
  assert.deepEqual([u.count, u.ids], [1, ['ghost']]);
  assert.equal(w.statsCalls.length, 0, 'neither is measured');
});
