// #255 — the production WIRING of the structured Reprise, pinned structurally (hooks-server.ts / cli/index.ts import Electron or the native bus
// behind an ABI gate, so the routes cannot run under `node --test`; the behaviour is proven by pause-reprise.test.ts / run-reprise.test.ts and the
// built-app rig scripts/pause-trap/reprise-rig.mjs). Each assertion is a STRUCTURAL relationship over comment-stripped source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = raw.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
  assert.ok(code.length > 1_000, `comment-stripping ${rel} returned too little`);
  return code;
}
const at = (code: string, needle: string): number => {
  const i = code.indexOf(needle);
  assert.notEqual(i, -1, `not found: ${needle}`);
  return i;
};

test('the host sweep calls sweepReprise BEFORE it reads the owed traps (a Reprise must never wait on a trap pass)', () => {
  const code = codeOf('src/main/pause-trap.ts');
  const sweep = code.slice(at(code, 'export async function sweepPauseTrap('));
  assert.ok(at(sweep, 'sweepReprise({') < at(sweep, 'owing = runsOwingPauseTrap(db);'), 'sweepReprise runs before runsOwingPauseTrap');
  assert.ok(sweep.includes('subtree: runSubtreeIds') && sweep.includes('storeReady: deps.storeReady'), 'it is handed the subtree walk and the store-ready gate (an unloaded store never completes a roster)');
});

test('/busStatus carries the Reprise view and `orchestra bus-status` prints it', () => {
  const hooks = codeOf('src/main/hooks-server.ts');
  assert.ok(at(hooks, 'repriseStatusView(repDb, cliRunId)') < at(hooks, '{ ...runFlagsExtra, reprise }'), '/busStatus builds the view for the asked run and adds it to the reply');
  const cli = codeOf('src/cli/index.ts');
  assert.ok(at(cli, 'if (res.reprise && typeof res.reprise === \'object\')') < at(cli, 'renderRepriseStatus(res.reprise as RepriseStatusView, { countShownAbove: pauseLineCoversReprise(res.reprise as RepriseStatusView, res.pause as PauseStatusView | undefined) })'), 'bus-status prints the shared renderer (one place for the N/M line)');
});

test('the CLI wires beginReprise / release / confirm through the SAME dynamic import as the other bus seams (the ABI gate), never a static import of the native bus', () => {
  const cli = codeOf('src/cli/index.ts');
  assert.ok(cli.includes("const pauseReprise = await import('../main/pause-reprise.ts');"), 'dynamic import inside openBusForVerb');
  for (const needle of [
    'beginReprise: busPause.beginReprise,',
    'releaseMembers: pauseReprise.releaseMembers,',
    'confirmReprise: pauseReprise.confirmReprise,',
    'resumingCarrier: (d, runId) => pauseReprise.resumingCarrierFor(d, runId, liveChainIds(runId)),',
  ]) assert.ok(cli.includes(needle), needle);
  assert.ok(!/^import .* from '\.\.\/main\/pause-reprise\.ts'/m.test(cli), 'no static import of the native-bus module');
  assert.ok(!/^import [^t].* from '\.\.\/main\/pause-reprise\.ts'/m.test(codeOf('src/cli/bus-verbs.ts')), 'bus-verbs.ts takes only TYPES from pause-reprise.ts');
  assert.ok(at(cli, "sub === 'confirm'") < at(cli, "sub === 'hold' || sub === 'resume' || sub === 'pause' || sub === 'release'"), 'confirm is dispatched before the coordinator verbs');
  assert.ok(at(cli, 'verbRunRelease(holdCtx, runPause,') > at(cli, "if (sub === 'release') {"), 'release verb is reachable from the fenced coordinator branch');
});

test('the gate reads the release in THE one place every start funnels through (pausedCarrierForWorkspace), and the lift clears every pause column', () => {
  const code = codeOf('src/main/bus-pause.ts');
  const gate = code.slice(at(code, 'export function pausedCarrierForWorkspace('));
  assert.ok(gate.includes('releasedWhileResuming(db, id, row.pausedAt, ws.id)'), 'the member-level release read');
  assert.ok(code.includes('clearPauseColumns(db, runId)'), 'setRunPause(false) clears via the one helper');
  assert.ok(code.includes('revertResumeToPaused(db, runId, who,'), 'a Pause while resuming reverts');
  assert.ok(code.includes('export const beginReprise: RepriseEntry'), 'the frozen entry point keeps the RepriseEntry type');
});

test('docs: the orchestra-comms skill SOURCE (COMMS_SKILL) documents the structured Reprise — release, Consigne, confirm, killed commands never re-run', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'workspaces.ts'), 'utf8');
  const a = src.indexOf('const COMMS_SKILL = `');
  const b = src.indexOf('const WORKSPACE_ADMIN_SKILL');
  assert.ok(a !== -1 && b > a, 'COMMS_SKILL located');
  const skill = src.slice(a, b).replace(/\\`/g, '`');
  for (const needle of [
    'orchestra run release <ws>... | --all [--run <id>]',
    'orchestra run confirm reprise',
    'Reprise is structured, never a mass wake',
    'releases ONLY the coordinators',
    'a `reprise` bus row',
    'ITS coordinator runs `orchestra run release <ws>`',
    'Consigne de reprise',
    'never re-run for you',
    '"N/M repris — manquent : …"',
  ]) assert.ok(skill.replace(/\s+/g, ' ').includes(needle.replace(/\s+/g, ' ')), `missing: ${needle}`);
});

test('the LIVE workspace tree is registered where the Reprise reads it: the host (pause-trap-host.ts, store-backed) and the store-less CLI (store.json off disk, archived resolvable but not enumerated)', () => {
  const host = codeOf('src/main/pause-trap-host.ts');
  assert.ok(host.includes('setLiveTreeSource(() => ({ get: (id) => store.getWorkspace(id), ids: () => store.workspaces.filter((w) => !w.archived).map((w) => w.id) }));'), 'host: the store, archived excluded');
  const cli = codeOf('src/cli/index.ts');
  assert.ok(cli.includes('pauseReprise.setLiveTreeSource(() => {'), 'cli: registered inside openBusForVerb, after the dynamic import');
  assert.ok(cli.includes('const nodes = toWaveNodes(records);') && cli.includes('ids: () => [...nodes.keys()].filter((id) => alive.has(id))'), 'cli: the app store file — archived stay in `get`, are dropped from `ids` (like the host)');
});

test('the in-flight command text reaches the Bilan: agent-sdk notes it from the SDK tool-use event, the host trap reads it into `activityOf`', () => {
  const sdk = codeOf('src/main/agent-sdk.ts');
  assert.ok(sdk.includes("noteToolDetail(session.wsId, ev.toolUseId, applyToolEvent(session.openToolUses, ev))") && sdk.includes('else applyToolEvent(session.openToolUses, ev);'));
  const host = codeOf('src/main/pause-trap-host.ts');
  assert.ok(host.includes('sinceMs: now - t.startedAt, input: t.detail ?? null }'));
  assert.ok(host.includes('sdk ? sdk.openTools.map((t) => ({ tool: t.tool, toolUseId: t.toolUseId, sinceMs: t.sinceMs, input: t.input })) : null,'), 'a live SDK session is the authoritative source; the hook tracker only when there is none');
});
