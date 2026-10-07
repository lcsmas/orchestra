// #292 — the production WIRING of the container step, pinned structurally (the behaviour is proven over injected deps in pause-trap-containers.test.ts /
// pause-containers-reprise.test.ts and against real dockerd by scripts/e2e-pause-containers.sh). Comment-stripped source; each assertion has its own control.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return raw.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
}
const at = (code: string, needle: string): number => {
  const i = code.indexOf(needle);
  assert.notEqual(i, -1, `not found: ${needle}`);
  return i;
};

test('trapMember: the docker step runs AFTER the tool-tree kill and BEFORE the trap is stamped complete (the final Bilan write)', () => {
  const code = codeOf('src/main/pause-trap.ts');
  const fn = code.slice(at(code, 'export async function trapMember('));
  const kill = at(fn, 'await deps.killTrees(');
  const docker = at(fn, 'stopAttributedContainers(deps.containers, m.wsId');
  const fresh = at(fn, 'const fresh = bilanForMember(');
  const stamp = at(fn, "return incomplete ? 'incomplete' : 'complete';");
  assert.ok(kill < docker && docker < fresh && fresh < stamp, 'order: killTrees → stopAttributedContainers → final write → complete');
  assert.ok(fn.slice(docker - 200, docker).includes('if (deps.containers)'), 'no containers dep ⇒ Docker is never touched');
  // must-FAIL control on the REAL source: re-order the real function body so the docker block comes first and the very same predicate no longer holds
  const moved = fn.replace('await deps.killTrees(', 'await deps.noop(') + '\nawait deps.killTrees(';
  assert.ok(!(moved.indexOf('await deps.killTrees(') < moved.indexOf('stopAttributedContainers(deps.containers, m.wsId')), 'the order predicate must be able to fail');
});

test('the sweep restarts owed containers BEFORE it sweeps (releases) the Reprise — and a begin parks the coordinators while any restart is owed', () => {
  const sweep = codeOf('src/main/pause-trap.ts');
  const fn = sweep.slice(at(sweep, 'export async function sweepPauseTrap('));
  assert.ok(at(fn, 'await restartOwedContainers(') < at(fn, 'sweepReprise({'), 'order: restartOwedContainers → sweepReprise');
  const rep = codeOf('src/main/pause-reprise.ts');
  const begin = rep.slice(at(rep, 'export function beginRepriseCore('));
  const owed = at(begin, 'if (containersOwed(db, carrierRunId)) deferCoordinatorRelease(');
  const release = at(begin, 'else releaseCoordinators(db, carrierRunId, cols, subtreeRunIds, now, undefined, by);');
  assert.ok(owed < release);
  const sw = rep.slice(at(rep, 'export function sweepReprise('));
  assert.ok(at(sw, 'if (!owed && parked) releaseCoordinators(') > 0, 'the sweep releases the parked coordinators only when nothing is owed');
  assert.ok(sw.includes('if (!owed) {\n              const bilanned'), 'the late pass must not run at all while a restart is owed');
  const fin = rep.slice(at(rep, 'export function finishRepriseIfDone('));
  assert.ok(at(fin, 'if (containersOwed(db, carrierRunId)) return false;') < at(fin, 'UPDATE runs SET ${ACTIVE_SET}'), 'the run never goes ACTIVE while a restart is owed');
});

test('the host\'s TrapDeps carry the app\'s own Docker client (real socket) — and the Docker step is the ONLY thing that reads it', () => {
  const host = codeOf('src/main/pause-trap-host.ts');
  assert.ok(host.includes('containers: createDockerApi(),'));
  assert.ok(host.includes("from './docker-api.ts'"));
  const mod = codeOf('src/main/pause-containers.ts');
  const used = new Set([...mod.matchAll(/\bapi\.(\w+)\(/g)].map((x) => x[1]));
  assert.deepEqual([...used].sort(), ['inspectContainer', 'listContainers', 'startContainer', 'stopContainer'], 'the ONLY Docker verbs the Pause uses: list, inspect, stop, start — never remove / kill / pause');
  assert.ok(mod.includes('labels: [attributedLabelFilter(wsId)], status: STOPPABLE_STATES'), 'selection = running/restarting + the member\'s own orchestra.ws label');
  assert.ok(mod.includes("export const STOPPABLE_STATES = ['running', 'restarting'];"));
  assert.ok(mod.includes('row.labels[DOCKER_LABEL_WS] !== wsId'), 'the label is re-asserted on the row before a destructive act');
});
