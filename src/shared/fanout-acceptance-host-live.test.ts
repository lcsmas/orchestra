// #614 — the host's two read-only ops of the Boucle (`live`, `transcripts` of the `/fanoutAcceptance` route): vouched like `start`, and only about the workspaces the RUN's state records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchFanoutAcceptance, type AcceptanceHostDeps } from './fanout-acceptance-host.ts';
import { applyTicketPatch, newState, setPlan, stateFile, updateState } from './fanout-state.ts';

const NOW = '2026-01-01T00:00:00.000Z';
function host(): { deps: AcceptanceHostDeps; alive: Set<string> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-live-'));
  updateState(stateFile(home, 'run1'), () => {
    let s = setPlan(newState('run1', { target: 'main', repo: null, switches: { seatRecords: 'on' }, now: NOW }), ['T1'], 'declare', NOW);
    s = applyTicketPatch(s, 'T1', { implementer: 'ws-impl' }, NOW);
    return s;
  });
  const alive = new Set(['ws-impl', 'ws-stranger']);
  const deps = { home, now: () => NOW, isWorkspace: (id: string) => alive.has(id), repoPath: () => undefined, spawn: async () => ({ ok: false }), post: () => undefined, vouches: (id: string, key?: string) => id === 'run1' && key === 'k-run1', isLive: (id: string) => alive.has(id), transcriptDirOf: (id: string) => `/t/${id}` } as unknown as AcceptanceHostDeps;
  return { deps, alive };
}
const ask = (deps: AcceptanceHostDeps, o: Record<string, unknown>) => dispatchFanoutAcceptance({ run: 'run1', from: 'run1', key: 'k-run1', ids: ['ws-impl'], ...o }, deps);

test('live: answers for the run\'s own workspaces only — a stranger is not probed, a dead one is not live', async () => {
  const { deps, alive } = host();
  assert.deepEqual(await ask(deps, { op: 'live', ids: ['ws-impl', 'ws-stranger', 'ws-nobody'] }), { ok: true, op: 'live', live: ['ws-impl'] });
  alive.delete('ws-impl');
  assert.deepEqual(await ask(deps, { op: 'live' }), { ok: true, op: 'live', live: [] });
});
test('transcripts: the directory of each of the run\'s workspaces, nothing for a stranger', async () => {
  const { deps } = host();
  assert.deepEqual(await ask(deps, { op: 'transcripts', ids: ['ws-impl', 'ws-stranger'] }), { ok: true, op: 'transcripts', dirs: { 'ws-impl': '/t/ws-impl' } });
});
test('MUST-FAIL: a caller the host cannot vouch (no key, a wrong key, another workspace) is refused [live-caller] / [transcripts-caller]', async () => {
  const { deps } = host();
  for (const op of ['live', 'transcripts']) {
    for (const bad of [{ key: undefined }, { key: 'k-other' }, { from: 'ws-stranger' }]) {
      const r = await ask(deps, { op, ...bad });
      assert.equal(r.ok, false, `${op} ${JSON.stringify(bad)}`);
      assert.match(String((r as { error: string }).error), new RegExp(`^\\[${op}-caller\\]`));
    }
  }
});
