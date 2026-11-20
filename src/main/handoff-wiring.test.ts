// #466 — source-wiring gate: handoff-host.ts / hooks-server.ts / agent-sdk.ts cannot load under `node --test` (store / platform seam), so the WIRING is asserted on the shipped source;
// the behaviour behind it runs in handoff-controller.test.ts (fakes) and scripts/session-budget/handoff-cache.mjs (the real session path vs the fake API).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => fs.readFileSync(path.join(here, f), 'utf8');
const live = (src: string, needle: string): boolean => src.split('\n').some((l) => l.includes(needle) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));

test('the route is served by hooks-server and the CLI verb posts to it with the session key', () => {
  const hooks = read('hooks-server.ts');
  assert.ok(live(hooks, "import { dispatchHandoffRequest } from './handoff-host.ts';"));
  assert.match(hooks, /route === '\/handoff'\) \{[\s\S]*?send\(200, dispatchHandoffRequest\(msg\)\)/);
  const cli = fs.readFileSync(path.join(here, '..', 'cli', 'index.ts'), 'utf8');
  assert.match(cli, /case 'handoff': \{[\s\S]*?request\('\/handoff', \{ id, key: process\.env\[SESSION_KEY_ENV\]/);
});

test('the clear is restart --fresh\'s path (sdkRestart fresh: coordinator generation bumped), never a kill; the start goes through the Relance delivery behind Admission', () => {
  const host = read('handoff-host.ts');
  assert.match(host, /await sdkRestart\(id, \{ fresh: true, trigger: 'cli' \}\)/);
  assert.match(host, /deliverRelance\(\s*id, text, 'handoff'/);
  assert.doesNotMatch(host, /killKeeper|sdkStop|removeWorkspace|git /, 'a handoff never kills a keeper, deletes, or touches git');
  assert.doesNotMatch(host, /origin:\s*'human'/);
});

test('the host vouches by session key, reads the run row (open run required) and the Pause gate', () => {
  const host = read('handoff-host.ts');
  assert.match(host, /sessionKeys\(\)\.verify\(id, key\) === 'ok'/);
  assert.match(host, /getRun\(db, runId\)/);
  assert.match(host, /run\.closed_at != null \? HANDOFF_ERRORS\.closedRun/);
  assert.match(host, /pauseRefusal\(ws, 'auto'\)/);
});

test('agent-sdk announces every ended turn through the seam, after the gate is released', () => {
  const sdk = read('agent-sdk.ts');
  assert.ok(live(sdk, "import { notifyTurnEnd } from './handoff-seam.ts';"));
  const at = sdk.indexOf('notifyTurnEnd({ wsId: session.wsId, sessionId: session.persistedSessionId, queueLen: session.queue.length });');
  assert.ok(at > 0, 'the seam call is in the result branch');
  assert.ok(sdk.lastIndexOf('releaseTurnGate(session);', at) > sdk.lastIndexOf("msg.type === 'result'", at), 'after the gate is released, inside the result branch');
  assert.ok(at < sdk.indexOf("} else if (msg.type === 'conversation_reset')", at), 'and before the branch ends');
  assert.doesNotMatch(read('handoff-seam.ts'), /from '\.\/agent-sdk/, 'the seam must not import agent-sdk (cycle)');
});

test('the bound = env > the workspace role (#478), read at each turn end; the listener is registered at load', () => {
  const host = read('handoff-host.ts');
  assert.match(host, /bound: \(id\) => resolveHandoffBound\(process\.env, roleBoundOf\(id\)\)\.bound/);
  // the role is the one frozen at spawn (`spawnRole`, #489), else the name's prefix — workspaceRole(), the role sentinel's own source — through the table + the override file
  assert.match(host, /workspaceRole\(ws\)/);
  assert.match(host, /store\.getWorkspace\(id\)/);
  assert.match(host, /roleSpec\(role, cfg\)\.handoffBoundTurns/);
  assert.match(host, /cfg = loadRoleConfig\(\)/);
  assert.ok(live(host, 'setTurnEndListener((info) => void controller.onTurnEnd(info));'));
});

test('the route body cap admits a full-size summary (the default 4096 B cap would 413 a normal one)', () => {
  const hooks = read('hooks-server.ts');
  assert.match(hooks, /route === '\/handoff' \? 1_048_576 : 4096/);
});

test('a held opening is kept while OWED, not while asleep: stillOwed reads the owed set, not admission\'s default', () => {
  const host = read('handoff-host.ts');
  assert.match(host, /stillOwed: \(\) => stillOwed\(id\)/);
  assert.match(host, /readOwed\(OWED_ROOT\(\), id\) !== null/);
  assert.match(read('relance-host.ts'), /wakeHeldForMemory\(ws, retry, \{ site, stillOwed: opts\.stillOwed \}\)/);
});

test('m1/m2: the owed marker is cleared ONLY on a delivered opening, an app-start sweep re-delivers it, and the handoff clears the stale-run flag like restart', () => {
  const host = read('handoff-host.ts');
  assert.match(host, /if \(r === 'sent'\) \{\n\s*clearOwed\(OWED_ROOT\(\), id\);/);
  assert.match(host, /setTimeout\(resumeOwedOpenings, 30_000\)/);
  assert.match(host, /await sdkRestart\(id, \{ fresh: true, trigger: 'cli' \}\);\n\s*await clearBusRunStale\(id\);/);
  assert.match(host, /turnInFlight: \(id\) => sdkPauseActivity\(id\)\?\.turnRunning \?\? false/);
});
