import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import { earliestLiveFleetRunStart, runKnownIn, workspaceKnownIn, type ContainerWindowDeps } from './container-window.ts';
import { liveFleetRuns } from './pause-memory.ts';
import type { AutoWorkspace } from './pause-auto.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';

// #293 (FI-3 v1.3, ledger #295) — the PRODUCTION window/ownership predicates over a REAL bus.sqlite under the real home (btrfs — never /tmp, never the live bus) and a fake store. Named arms are what
// scripts/container-memory-mutants.mjs reddens.

const ROOT = path.join(os.homedir(), '.cache', `container-window-${process.pid}`);
let n = 0;
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

type Ws = AutoWorkspace & { host?: { kind: string } };
function world(runs: Array<{ id: string; at: number }>, workspaces: Ws[], opts: { ready?: boolean; noBus?: boolean } = {}) {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = bus.openBus(path.join(ROOT, `b${n++}.sqlite`));
  for (const r of runs) {
    busRuns.startRun(db, { id: r.id, kind: 'mission', coordinator: r.id }, DEFAULT_BUS_SWITCHES);
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(r.at, r.id);
  }
  const ws = new Map(workspaces.map((w) => [w.id, w]));
  const deps: ContainerWindowDeps = {
    getBus: () => (opts.noBus ? null : db),
    getWorkspace: (id) => ws.get(id),
    listWorkspaces: () => [...ws.values()],
    storeReady: () => opts.ready ?? true,
  };
  return { db, ws, deps };
}

test('CW1 the window starts at the EARLIEST run of a live local fleet: no-member runs, archived/sandbox/gone anchors do not count, and the keeper (hibernation) is not consulted', () => {
  const w = world(
    [
      { id: 'old-empty', at: 100 }, // anchor live but NOBODY below it: not a fleet
      { id: 'old-archived', at: 200 }, // anchor archived
      { id: 'old-sandbox', at: 300 }, // anchor sandbox-hosted
      { id: 'old-gone', at: 400 }, // anchor not in the store
      { id: 'hibernated-lead', at: 1_000 }, // a LEAD in Veille (no keeper) with a live member: STILL leads its run
      { id: 'recent', at: 5_000 },
    ],
    [
      { id: 'old-empty', kind: 'orchestrator' },
      { id: 'old-archived', kind: 'orchestrator', archived: true },
      { id: 'a1', parentId: 'old-archived' },
      { id: 'old-sandbox', kind: 'orchestrator', host: { kind: 'sandbox' } },
      { id: 's1', parentId: 'old-sandbox' },
      { id: 'hibernated-lead', kind: 'orchestrator', hibernatedAt: 9 } as Ws,
      { id: 'h1', parentId: 'hibernated-lead' },
      { id: 'recent', kind: 'orchestrator' },
      { id: 'r1', parentId: 'recent' },
    ],
  );
  assert.deepEqual(liveFleetRuns(w.db, w.deps).map((r) => r.id).sort(), ['hibernated-lead', 'recent'], 'the instrument: exactly the alert/Pause definition');
  assert.equal(earliestLiveFleetRunStart(w.deps), 1_000);
});

test('CW2 the window follows the fleet, not the bus alone: archive the only member and the run stops counting; no bus / no fleet / no runs ⇒ null (nothing can be unattributed)', () => {
  const w = world([{ id: 'L', at: 700 }, { id: 'M', at: 900 }], [{ id: 'L', kind: 'orchestrator' }, { id: 'l1', parentId: 'L' }, { id: 'M', kind: 'orchestrator' }, { id: 'm1', parentId: 'M' }]);
  assert.equal(earliestLiveFleetRunStart(w.deps), 700);
  w.ws.get('l1')!.archived = true;
  assert.equal(earliestLiveFleetRunStart(w.deps), 900, 'L lost its last live member');
  w.ws.get('m1')!.archived = true;
  assert.equal(earliestLiveFleetRunStart(w.deps), null);
  assert.equal(earliestLiveFleetRunStart({ ...w.deps, getBus: () => null }), null, 'no bus');
  assert.equal(earliestLiveFleetRunStart(world([], [], {}).deps), null, 'no runs');
});

test('CW3 workspaceKnownIn: a loaded store answers by id; an UNTRUSTED store (not parsed yet, or a fresh/corrupt store.json that never loads) trusts only the container\'s run stamp — it neither orphans every container nor attributes another instance\'s', () => {
  const ws: Ws[] = [{ id: 'known', kind: 'orchestrator' }];
  const loaded = world([{ id: 'mine', at: 1 }], ws).deps;
  assert.equal(workspaceKnownIn(loaded)('known', 'whatever'), true);
  assert.equal(workspaceKnownIn(loaded)('deleted', 'mine'), false, 'a loaded store is the authority on ids, whatever the run');
  const untrusted = world([{ id: 'mine', at: 1 }], ws, { ready: false }).deps;
  assert.equal(workspaceKnownIn(untrusted)('anyone', 'mine'), true, 'untrusted store + a run THIS bus has ⇒ ours, attributed');
  assert.equal(workspaceKnownIn(untrusted)('anyone', 'someone-elses'), false, 'untrusted store + a foreign run ⇒ not known (and runKnown then drops it: another instance\'s)');
  assert.equal(workspaceKnownIn(untrusted)('anyone', ''), false, 'no run stamp proves nothing');
});

test('CW4 runKnownIn: an orphan needs a run stamp THIS bus has — empty, unknown (another instance) and "no bus" are all NOT known', () => {
  const w = world([{ id: 'mine', at: 1 }], []);
  assert.equal(runKnownIn(w.deps)('mine'), true);
  assert.equal(runKnownIn(w.deps)('someone-elses'), false);
  assert.equal(runKnownIn(w.deps)(''), false);
  assert.equal(runKnownIn({ getBus: () => null })('mine'), false);
});
