import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accountingView,
  buildAccounting,
  classifyContainers,
  containerMemoryBytes,
  emptyAccounting,
  formatContainersLine,
  measuredContainerBytes,
  viewBytesFor,
  unattributedWarning,
  containersChipTitle,
  type ContainerRow,
} from './container-accounting.ts';

const MB = 1024 * 1024;
const row = (id: string, created: number, labels: Record<string, string> = {}, name = id): ContainerRow => ({ id, name, created, labels });
const RUN_START_MS = 1_000_000 * 1000; // 1_000_000 s

test('C1 classify: a labelled running container is attributed whatever its age; an unlabelled one only when created at/after the earliest live run start (whole seconds, >=)', () => {
  const { attributed, unattributed } = classifyContainers(
    [
      row('old-attributed', 10, { 'orchestra.ws': 'ws-a' }),
      row('human-old', 999_999), // predates the run: the human's older stack
      row('same-second', 1_000_000), // created in the very second the run started
      row('after', 1_000_500),
    ],
    RUN_START_MS + 400, // sub-second part is ignored
  );
  assert.deepEqual(attributed.map((a) => [a.id, a.wsId]), [['old-attributed', 'ws-a']]);
  assert.deepEqual(unattributed.map((u) => u.id), ['same-second', 'after']);
});

test('C2 classify: no live run → nothing is unattributed (a container cannot have been created "during a run"); attributed still counts', () => {
  const { attributed, unattributed } = classifyContainers([row('a', 5, { 'orchestra.ws': 'ws-a' }), row('b', 2_000_000)], null);
  assert.equal(attributed.length, 1);
  assert.deepEqual(unattributed, []);
});

test('C3 classify: the ownership key is exactly orchestra.ws and its value an EXACT id — a blank / whitespace-padded value (Pause would not match it either) or another key (orchestra.run alone, a compose label) does NOT attribute', () => {
  const { attributed, unattributed } = classifyContainers(
    [row('blank', 2_000_000, { 'orchestra.ws': '   ' }), row('run-only', 2_000_000, { 'orchestra.run': 'r1' }), row('compose', 2_000_000, { 'com.docker.compose.project': 'x' }), row('padded', 2_000_000, { 'orchestra.ws': ' ws-b ' })],
    RUN_START_MS,
  );
  assert.deepEqual(attributed.map((a) => [a.id, a.wsId]), [], 'a padded value is not an id');
  assert.deepEqual(unattributed.map((u) => u.id), ['blank', 'run-only', 'compose', 'padded'], 'they are NOBODY\'s: window rule applies');
});

test('C4 containerMemoryBytes (cgroup v2): usage minus inactive_file, as `docker stats` computes it', () => {
  assert.equal(containerMemoryBytes({ memory_stats: { usage: 300 * MB, stats: { inactive_file: 50 * MB, anon: 240 * MB } } }), 250 * MB);
});

test('C5 containerMemoryBytes (cgroup v1): usage minus total_inactive_file (the hierarchical key, FIRST — v1 documents carry BOTH keys); no cache key → usage as is', () => {
  assert.equal(containerMemoryBytes({ memory_stats: { usage: 120 * MB, stats: { total_inactive_file: 20 * MB, cache: 90 * MB } } }), 100 * MB);
  assert.equal(containerMemoryBytes({ memory_stats: { usage: 120 * MB, stats: { inactive_file: 5 * MB, total_inactive_file: 20 * MB } } }), 100 * MB, 'both keys (a real v1 document): the hierarchical total wins, like the docker CLI');
  assert.equal(containerMemoryBytes({ memory_stats: { usage: 77 * MB, stats: {} } }), 77 * MB);
  assert.equal(containerMemoryBytes({ memory_stats: { usage: 77 * MB } }), 77 * MB);
});

test('C6 containerMemoryBytes: UNMEASURED (null) for a document without a usable usage — never 0; a measured zero is 0; cache above usage clamps to 0', () => {
  for (const bad of [null, undefined, {}, { memory_stats: {} }, { memory_stats: { usage: null } }, { memory_stats: { usage: 'x' } }, { memory_stats: { usage: -1 } }, 'text', 5]) {
    assert.equal(containerMemoryBytes(bad), null, JSON.stringify(bad));
  }
  assert.equal(containerMemoryBytes({ memory_stats: { usage: 0 } }), 0);
  assert.equal(containerMemoryBytes({ memory_stats: { usage: 10, stats: { inactive_file: 99 } } }), 10, 'cache not below usage → the docker CLI reports usage as is (never 0, never negative)');
  assert.equal(containerMemoryBytes({ memory_stats: { usage: 10, stats: { total_inactive_file: 10 } } }), 10);
  assert.equal(containerMemoryBytes({ memory_stats: { usage: 10 * MB, stats: { inactive_file: 'junk' } } }), 10 * MB);
});

test('C7 buildAccounting: bytes SUM per workspace, counts include unmeasured containers, unmeasured bytes are NOT guessed', () => {
  const acc = buildAccounting(
    [
      { wsId: 'ws-a', bytes: 200 * MB },
      { wsId: 'ws-a', bytes: 50 * MB },
      { wsId: 'ws-a', bytes: null },
      { wsId: 'ws-b', bytes: null },
    ],
    [{ id: 'u1', name: 'web-1', created: 1 }],
    42,
  );
  assert.equal(acc.byWorkspace.get('ws-a'), 250 * MB);
  assert.equal(acc.byWorkspace.has('ws-b'), false, 'a workspace whose only container is unmeasured has no figure — not a 0 figure');
  assert.deepEqual([acc.countByWorkspace.get('ws-a'), acc.countByWorkspace.get('ws-b')], [3, 1]);
  assert.equal(acc.unmeasured, 2);
  assert.deepEqual([acc.unmeasuredByWorkspace.get('ws-a'), acc.unmeasuredByWorkspace.get('ws-b')], [1, 1]);
  assert.deepEqual(acc.unattributed, { count: 1, ids: ['u1'], names: ['web-1'] });
  assert.deepEqual([acc.docker, acc.sampledAt], ['ok', 42]);
});

test('C8 emptyAccounting: never refreshed = not-sampled with sampledAt null (a consumer tells "never measured" from "measured 0")', () => {
  const e = emptyAccounting();
  assert.deepEqual([e.docker, e.sampledAt, e.byWorkspace.size, e.unattributed.count], ['not-sampled', null, 0, 0]);
  assert.equal(emptyAccounting('unavailable', 7).docker, 'unavailable');
});

test('C9 viewBytesFor + measuredContainerBytes: a workspace\'s MEASURED container bytes; "unmeasured, never 0" — a workspace whose every container is unmeasured, or Docker down, has NO figure (undefined), a workspace without containers is a measured 0', () => {
  const acc = buildAccounting([{ wsId: 'ws-a', bytes: 200 * MB }, { wsId: 'ws-blind', bytes: null }, { wsId: 'ws-part', bytes: 7 * MB }, { wsId: 'ws-part', bytes: null }], [], 1);
  const view = accountingView(acc);
  assert.equal(viewBytesFor(view, 'ws-a'), 200 * MB);
  assert.equal(viewBytesFor(view, 'ws-z'), 0);
  assert.equal(viewBytesFor(null, 'ws-a'), 0);
  for (const docker of ['unavailable', 'error', 'not-sampled', 'stale'] as const) assert.equal(viewBytesFor({ ...view, docker }, 'ws-a'), 0, `${docker}: a view that was not measured adds no bytes`);
  assert.equal(viewBytesFor(view, null), 0);
  assert.equal(measuredContainerBytes(view, 'ws-a'), 200 * MB);
  assert.equal(measuredContainerBytes(view, 'ws-z'), 0, 'Docker answered, the workspace has no container: a measured 0');
  assert.equal(measuredContainerBytes(view, 'ws-blind'), undefined, 'its only container is unmeasured: NOT 0');
  assert.equal(measuredContainerBytes(view, 'ws-part'), 7 * MB, 'partly measured: the measured part');
  assert.equal(measuredContainerBytes(accountingView(emptyAccounting('unavailable', 5)), 'ws-a'), undefined);
  assert.equal(measuredContainerBytes(accountingView(emptyAccounting('error', 5)), 'ws-a'), undefined);
  assert.equal(measuredContainerBytes(null, 'ws-a'), undefined);
});

test('C10 accountingView: JSON-safe, heaviest workspace first, a count-only (unmeasured) workspace listed with 0 bytes', () => {
  const acc = buildAccounting([{ wsId: 'ws-small', bytes: 5 * MB }, { wsId: 'ws-big', bytes: 900 * MB }, { wsId: 'ws-blind', bytes: null }], [], 1);
  const v = accountingView(acc);
  assert.deepEqual(v.attributed.map((a) => [a.wsId, a.count, a.bytes, a.unmeasured]), [['ws-big', 1, 900 * MB, 0], ['ws-small', 1, 5 * MB, 0], ['ws-blind', 1, 0, 1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
});

test('C11 formatContainersLine: every state is one honest line — not sampled / Docker unavailable (not "0 containers") / attributed per workspace / unattributed named and "never touched"', () => {
  const label = (id: string) => ({ 'ws-a': 'feat-x', 'ws-b': 'feat-y' })[id] ?? id;
  assert.equal(formatContainersLine(accountingView(emptyAccounting()), label), 'containers: not sampled yet');
  assert.equal(formatContainersLine(accountingView(emptyAccounting('unavailable', 5)), label), 'containers: Docker unavailable — not measured');
  assert.equal(formatContainersLine(accountingView(emptyAccounting('error', 5)), label), 'containers: accounting failed — not measured');
  assert.equal(formatContainersLine(accountingView(buildAccounting([], [], 5)), label), 'containers: 0 attributed · 0 unattributed');
  const acc = buildAccounting([{ wsId: 'ws-a', bytes: 612 * MB }, { wsId: 'ws-b', bytes: 40 * MB }, { wsId: 'ws-b', bytes: null }], [{ id: 'abcdef0123456789', name: 'web-1', created: 9 }, { id: 'ffff00001111aaaa', name: '', created: 9 }], 5);
  assert.equal(
    formatContainersLine(accountingView(acc), label),
    'containers: 3 attributed (feat-x ×1 · 612 MB, feat-y ×2 · 40 MB (+1 not measured)) · 2 unattributed (web-1, ffff00001111) — never touched',
  );
  const blind = buildAccounting([{ wsId: 'ws-a', bytes: null }], [], 5);
  assert.equal(formatContainersLine(accountingView(blind), label), 'containers: 1 attributed (feat-x ×1 · not measured) · 0 unattributed');
  const big = buildAccounting([{ wsId: 'ws-a', bytes: 3 * 1024 ** 3 }], [], 5);
  assert.match(formatContainersLine(accountingView(big), label), /feat-x ×1 · 3\.0 GB/);
});

// REAL captures from the host's dockerd (cgroup v2, one-shot stats, 2026-10-07) — never hand-written payloads.
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8'));

test('C13 a REAL stats document (a container holding 64 MiB in tmpfs): the figure is the 64 MiB + base the daemon charged — shmem is NOT reclaimable cache', () => {
  const doc = fixture('docker-stats-cgroup2.json') as { memory_stats: { usage: number; stats: Record<string, number> } };
  assert.equal(doc.memory_stats.stats.shmem, 64 * MB, 'the capture really holds 64 MiB of shmem');
  assert.equal(doc.memory_stats.stats.inactive_file, 0);
  assert.equal(containerMemoryBytes(doc), 68_845_568);
});

test('C14 a REAL stats document where PAGE CACHE dominates (a container that wrote 100 MiB to its rootfs): usage 106.6 MB but the footprint is 1.77 MB — the cache is subtracted, as `docker stats` does', () => {
  const doc = fixture('docker-stats-cgroup2-filecache.json') as { memory_stats: { usage: number; stats: Record<string, number> } };
  assert.equal(doc.memory_stats.usage, 106_643_456);
  assert.equal(doc.memory_stats.stats.inactive_file, 104_873_984);
  assert.equal(containerMemoryBytes(doc), 1_769_472);
});

test('C15 classify: a container labelled for a workspace that NO LONGER EXISTS is an ORPHAN — unattributed whatever its age (the stamp proves it is Orchestra\'s), named "orphan of <id>", never attributed to nobody; with every id known (or no predicate) nothing is an orphan', () => {
  const known = new Set(['ws-a']);
  const running = [row('mine', 5, { 'orchestra.ws': 'ws-a' }), row('orphan', 5, { 'orchestra.ws': 'ws-deleted' }, 'g9-web'), row('older-human', 5)];
  const { attributed, unattributed } = classifyContainers(running, RUN_START_MS, (id) => known.has(id));
  assert.deepEqual(attributed.map((a) => a.id), ['mine']);
  assert.deepEqual(unattributed.map((u) => [u.id, u.orphanOf]), [['orphan', 'ws-deleted']], 'the human\'s older unlabelled container is still not counted');
  assert.deepEqual(classifyContainers(running, null, (id) => known.has(id)).unattributed.map((u) => u.id), ['orphan'], 'an orphan needs no live run');
  assert.equal(classifyContainers(running, RUN_START_MS).attributed.length, 2, 'no predicate: every id is known');
  const acc = buildAccounting([], unattributed, 1);
  assert.deepEqual(acc.unattributed.names, ['g9-web (orphan of ws-deleted)']);
});

test('C16 classify: an orphan must be provably THIS app\'s — a container stamped by ANOTHER Orchestra instance sharing the daemon (unknown workspace AND unknown run) is ignored: neither attributed nor reported; a missing run stamp is not proof either; with the run known it is an orphan', () => {
  const wsKnown = (id: string) => id === 'ws-a';
  const runKnown = (r: string) => r === 'run-mine';
  const running = [
    row('mine', 5, { 'orchestra.ws': 'ws-a', 'orchestra.run': 'run-mine' }),
    row('orphan-of-mine', 5, { 'orchestra.ws': 'ws-deleted', 'orchestra.run': 'run-mine' }),
    row('other-instance', 5, { 'orchestra.ws': 'ws-elsewhere', 'orchestra.run': 'run-elsewhere' }),
    row('no-run-stamp', 5, { 'orchestra.ws': 'ws-elsewhere' }),
  ];
  const { attributed, unattributed } = classifyContainers(running, null, wsKnown, runKnown);
  assert.deepEqual(attributed.map((a) => a.id), ['mine']);
  assert.deepEqual(unattributed.map((u) => [u.id, u.orphanOf]), [['orphan-of-mine', 'ws-deleted']]);
  assert.deepEqual(classifyContainers(running, null, wsKnown).unattributed.map((u) => u.id), ['orphan-of-mine', 'other-instance', 'no-run-stamp'], 'without the run predicate every unknown workspace is an orphan (the pure default)');
  // the untrusted-store rule (container-window.ts `workspaceKnownIn`) keys on the container's `orchestra.run` stamp: classify must hand it over (ws, run)
  const seen: Array<[string, string]> = [];
  classifyContainers(running, null, (ws, run) => (seen.push([ws, run]), ws === 'ws-a'), runKnown);
  assert.deepEqual(seen, [['ws-a', 'run-mine'], ['ws-deleted', 'run-mine'], ['ws-elsewhere', 'run-elsewhere'], ['ws-elsewhere', '']], 'workspaceKnown receives each container\'s workspace id AND its run stamp (\'\' when absent)');
  // end to end with the production predicate over an UNTRUSTED store: a container of THIS bus's run is attributed, another instance's is dropped, whatever the workspace id
  const untrusted = (_ws: string, run: string) => runKnown(run);
  const u = classifyContainers(running, null, untrusted, runKnown);
  assert.deepEqual(u.attributed.map((a) => a.id), ['mine', 'orphan-of-mine'], 'untrusted store + a run THIS bus has ⇒ ours');
  assert.deepEqual(u.unattributed.map((x) => x.id), [], 'untrusted store + a foreign / absent run ⇒ not reported');
});

test('C17 unattributedWarning (the dim line under the Resources table, D-pick4 A): only when Docker answered AND something is unattributed; names the containers, says "never touched"; Docker down / nothing → null (bus-status carries those states)', () => {
  const some = accountingView(buildAccounting([], [{ id: 'abcdef0123456789', name: 'web-1', created: 1 }, { id: 'ffff00001111aaaa', name: '', created: 1, orphanOf: 'ws-x' }], 5));
  assert.equal(unattributedWarning(some), '⚠ 2 unattributed containers (web-1, ffff00001111 (orphan of ws-x)) — not attributed to any workspace · never touched');
  const one = accountingView(buildAccounting([], [{ id: 'a', name: 'web-1', created: 1 }], 5));
  assert.equal(unattributedWarning(one), '⚠ 1 unattributed container (web-1) — not attributed to any workspace · never touched');
  assert.equal(unattributedWarning(accountingView(buildAccounting([], [], 5))), null);
  assert.equal(unattributedWarning(accountingView(emptyAccounting('unavailable', 5))), null);
  // the guard itself: a view that is NOT 'ok' is never read for figures, even if a future producer path leaves data on it (the production views of those states are empty, so only a hand-built one can prove the guard)
  for (const docker of ['unavailable', 'error', 'not-sampled', 'stale'] as const) assert.equal(unattributedWarning({ ...some, docker }), null, `${docker}: no unattributed line from a view that was not measured`);
  assert.equal(unattributedWarning(accountingView(emptyAccounting())), null);
  assert.equal(unattributedWarning(null), null);
});

test('C18 containersChipTitle (the 🐳 chip tooltip): count + the measured figure; partial and all-unmeasured say so; singular/plural', () => {
  assert.equal(containersChipTitle({ count: 2, bytes: 700 * MB, unmeasured: 0 }), '2 containers · 700 MB');
  assert.equal(containersChipTitle({ count: 1, bytes: 90 * MB, unmeasured: 0 }), '1 container · 90 MB');
  assert.equal(containersChipTitle({ count: 3, bytes: 612 * MB, unmeasured: 1 }), '3 containers · 612 MB (+1 not measured)');
  assert.equal(containersChipTitle({ count: 1, bytes: 0, unmeasured: 1 }), '1 container · not measured');
});

test('C19 (pre-review #2) a partial daemon outage and a stale pass are NAMED, never read as a complete zero: buildAccounting/view carry daemonsDown; the bus-status line and the Resources warning say "did not answer"; "stale" is a not-measured line', () => {
  const label = (id: string): string => id;
  const partial = buildAccounting([{ wsId: 'ws-a', bytes: 5 * MB }], [], 7, 2);
  assert.equal(accountingView(partial).daemonsDown, 2);
  assert.equal(accountingView(buildAccounting([], [], 7)).daemonsDown, 0);
  assert.match(formatContainersLine(accountingView(partial), label), /· 2 Docker daemon\(s\) did not answer — figures incomplete$/);
  assert.doesNotMatch(formatContainersLine(accountingView(buildAccounting([], [], 7)), label), /did not answer/);
  assert.equal(unattributedWarning(accountingView(partial)), '⚠ 2 Docker daemon(s) did not answer — container figures incomplete', 'a partial outage with nothing unattributed still warns');
  const both = buildAccounting([], [{ id: 'abcdef0123456789', name: 'web-1', created: 1 }], 7, 1);
  assert.match(unattributedWarning(accountingView(both)) ?? '', /^⚠ 1 unattributed container \(web-1\).*never touched · ⚠ 1 Docker daemon\(s\) did not answer/);
  assert.equal(formatContainersLine(accountingView(emptyAccounting('stale', 7)), label), 'containers: last Docker pass is too old — not measured');
  assert.equal(measuredContainerBytes(accountingView(emptyAccounting('stale', 7)), 'ws-a'), undefined, 'stale ⇒ no figure, not 0');
});
