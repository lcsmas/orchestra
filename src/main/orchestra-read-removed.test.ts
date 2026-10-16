// #378 — `orchestra read` is RETIRED. It tailed `logs/<wsId>.log`, written only by the agent PTY that ADR 0007 deleted, so it
// answered an empty transcript for every Agent-view workspace. The CLI verb, the `/read` socket route, `dispatchReadRequest`, the
// sandbox `read` RPC and every instruction recommending it are gone; the verb itself is exercised against the BUILT cli in
// src/cli/help.test.ts (`orchestra read` → "unknown command"). These files import Electron, so each pin reads the shipped source.
// Every absence pin names the surviving control it must not break (a pin on a vanished symbol alone passes on a stub).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const ws = read('src', 'main', 'workspaces.ts');
const hooks = read('src', 'main', 'hooks-server.ts');
const manager = read('src', 'main', 'transport', 'sandbox-manager.ts');

test('CONTROL: the sources are the real files and the surviving peer routes are still served', () => {
  assert.ok(ws.length > 100_000 && hooks.length > 10_000 && manager.length > 3_000);
  assert.match(hooks, /route === '\/peers'/, 'the peers route stays');
  assert.match(hooks, /route === '\/message'/, 'the message route stays');
  assert.match(ws, /export async function dispatchPeersRequest\(/, 'dispatchPeersRequest stays');
  assert.match(manager, /case 'peers':/, 'the sandbox peers rpc stays');
});

test('no `/read` route, no dispatchReadRequest, no ANSI stripper left in the host', () => {
  assert.doesNotMatch(hooks, /route === '\/read'|dispatchReadRequest/);
  assert.doesNotMatch(ws, /dispatchReadRequest|ReadResult|stripAnsi|ANSI_RE|READ_DEFAULT_LINES|READ_MAX_LINES/);
  assert.doesNotMatch(manager, /dispatchReadRequest|case 'read'/);
});

test('the sandbox wire has no `read` rpc (both protocol copies, the shim route list and its README)', () => {
  const protocols = [read('src', 'shared', 'sandbox-protocol.ts'), read('sandbox', 'shim', 'sandbox-protocol.ts')];
  for (const p of protocols) {
    assert.match(p, /export type RpcRoute = 'rename' \| 'spawn' \| 'peers' \| 'message';/);
    assert.doesNotMatch(p, /^\s+read: \{/m, 'no `read` payload');
  }
  const core = read('sandbox', 'shim', 'shim-core.ts');
  assert.match(core, /new Set<RpcRoute>\(\[\s*'rename',\s*'spawn',\s*'peers',\s*'message',\s*\]\)/, 'the shim forwards exactly the four routes');
  assert.doesNotMatch(read('sandbox', 'README.md'), /`read`/);
});

test('no instruction the app generates or ships recommends `orchestra read`', () => {
  // the orchestrator brief, the two role reminders, the generated orchestra-comms skill, the per-turn comms resurface line
  assert.doesNotMatch(ws, /orchestra read|read a peer's transcript|Read a peer's recent transcript/);
  const files = [
    ['README.md'], ['docs', 'guide', 'cli.md'], ['docs', 'guide', 'multi-agent.md'],
    ['src', 'renderer', 'components', 'Help.tsx'], ['src', 'cli', 'help.ts'], ['src', 'cli', 'index.ts'],
  ];
  for (const f of files) assert.doesNotMatch(read(...f), /orchestra read\b/, f.join('/'));
});

test('the surviving guidance is intact: the brief tracks children through `peers`, the comms skill is renumbered', () => {
  assert.match(ws, /Track the agents you spawn with `orchestra peers`/);
  assert.match(ws, /poll it yourself with `orchestra peers`/);
  const skill = ws.slice(ws.indexOf('const COMMS_SKILL = `'), ws.indexOf('const WORKSPACE_ADMIN_SKILL')).replace(/\\`/g, '`');
  assert.ok(skill.length > 3_000, 'COMMS_SKILL located');
  assert.deepEqual(
    [...skill.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`),
    [
      '1. List the other agents',
      '2. Send a peer a message',
      '3. Verify a delegated branch actually landed',
      '4. Identify yourself',
      '5. Neutral merge arbitration',
      '6. Pause a run (host-enforced)',
    ],
  );
  assert.match(skill, /`orchestra send` \(§2\)/, 'the intro points at the renumbered send section');
});
