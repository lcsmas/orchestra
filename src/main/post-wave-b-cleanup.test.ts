// #378 strand 3 — the dead leftovers of the removed agent PTY (ADR 0007, #225–#233) are gone, and the things deliberately KEPT are pinned
// so a later "cleanup" cannot take them with it. workspaces.ts & co import Electron, so each pin reads the shipped source; every absence
// pin names the surviving control it must not break.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const code = (src: string) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
const ws = read('src', 'main', 'workspaces.ts');
const activity = read('src', 'main', 'activity.ts');
const hooks = read('src', 'main', 'hooks-server.ts');
const sdk = read('src', 'main', 'agent-sdk.ts');

function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.notEqual(at, -1, `declaration not found: ${decl}`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\nexport (?:const|interface|type) |\n\/\*\* /);
  return rest.slice(0, end === -1 ? rest.length : end);
}

test('CONTROL: the sources are the real files and the live producers each removal sits beside still exist', () => {
  assert.ok(ws.length > 100_000 && activity.length > 30_000 && hooks.length > 10_000 && sdk.length > 100_000);
  assert.match(code(sdk), /function transcriptExistsFor\(/, 'transcriptExistsFor (the resume discriminator) stays');
  assert.match(code(activity), /export function applyAgentEvent\(/);
  assert.match(code(hooks), /route === '\/peers'/);
});

test('dead symbols: anyTranscriptExists, SANDBOX_WORKSPACE_DIR, dispatchHookEvent and the legacy /event route are gone', () => {
  assert.doesNotMatch(code(sdk), /anyTranscriptExists/);
  assert.doesNotMatch(read('src', 'shared', 'types.ts'), /SANDBOX_WORKSPACE_DIR/);
  assert.doesNotMatch(code(activity), /dispatchHookEvent/);
  assert.doesNotMatch(code(hooks), /dispatchHookEvent|msg\.event/);
  // control: an unknown route still answers an empty 200 (the retired /event shape must not start answering an error to a stale curl hook)
  assert.match(code(hooks), /\} else \{\s*send\(200, \{\}\);\s*\}/);
  // control: installOrchestraHooks still evicts the legacy `curl http://x/event` hook from an old settings file
  assert.match(code(ws), /isLegacyActivityCurl = \(cmd: string\) => cmd\.includes\('http:\/\/x\/event'\)/);
  assert.match(code(ws), /removeHookCommand\(submitList, isLegacyActivityCurl\)/);
});

test('Bilan surface: no `pty` value (no stored row carries one), the readers are untouched', () => {
  const rec = read('src', 'main', 'bus-pause-records.ts');
  assert.match(rec, /surface: 'sdk' \| 'none' \| 'remote';/);
  assert.doesNotMatch(code(rec), /'pty'/);
  assert.match(read('src', 'cli', 'run-status.ts'), /a\.surface === 'none'/, 'control: `run status` still reads the surface');
});

test('no redundant bare-id stopPty(<id>) in archive / delete / prune / branch switch — the Run and nvim terminals are still stopped', () => {
  for (const [name, decl] of [
    ['archiveWorkspace', 'export async function archiveWorkspace('],
    ['teardownWorkspace', 'async function teardownWorkspace('],
    ['pruneOrphanedWorkspaces', 'export async function pruneOrphanedWorkspaces('],
    ['switchWorkspaceBranch', 'export async function switchWorkspaceBranch('],
  ] as const) {
    const f = code(body(ws, decl));
    assert.doesNotMatch(f, /stopPty\((?:ws\.)?id\)/, `${name}: no stopPty on the bare workspace id`);
    if (name !== 'switchWorkspaceBranch') {
      assert.match(f, /stopPty\(`\$\{(?:ws\.)?id\}:run`\);\s*stopPty\(`\$\{(?:ws\.)?id\}:nvim`\);/, `${name}: still stops the Run + nvim terminals`);
    } else {
      assert.match(f, /stopPty\(nvimId\);/, 'the branch switch still recycles the nvim PTY');
      assert.doesNotMatch(f, /clearScrollback\(id\)/, 'a branch switch has no agent log to clear');
    }
  }
  // control: delete / prune still remove a leftover pre-#233 `logs/<id>.log`
  assert.match(code(body(ws, 'async function teardownWorkspace(')), /clearScrollback\(id\)/);
});

test('KEPT on purpose: the ORCHESTRA_WS_ID_IDENTITY fallback (a keeper born before #233 has a frozen env without ORCHESTRA_WS_ID)', () => {
  const cli = read('src', 'cli', 'index.ts');
  assert.match(code(cli), /const id = env\.ORCHESTRA_WS_ID \|\| env\.ORCHESTRA_WS_ID_IDENTITY;/);
  assert.match(code(read('src', 'cli', 'bus-verbs.ts')), /env\.ORCHESTRA_WS_ID_IDENTITY\?\.trim\(\)/);
  assert.match(code(sdk), /env\.ORCHESTRA_WS_ID_IDENTITY = ws\.id;/);
  // and its comments say WHY (the old "spool gate" no longer exists)
  assert.match(read('src', 'cli', 'index.ts'), /keeper born BEFORE #233/);
  assert.doesNotMatch(read('src', 'cli', 'index.ts'), /spool-ownership-gated/);
});

test('applyAgentEvent: no stopReason / queuedSubmit parameter, and every caller passes the new positional order', () => {
  const sig = code(activity).slice(code(activity).indexOf('export function applyAgentEvent('), code(activity).indexOf('): void {', code(activity).indexOf('export function applyAgentEvent(')));
  assert.doesNotMatch(sig, /stopReason|queuedSubmit/);
  assert.match(code(read('src', 'main', 'events-spool.ts')), /applyAgentEvent\(id, ev\.event, tool, transcript, crons, toolUseId\);/);
  assert.match(code(read('src', 'main', 'transport', 'sandbox-connection.ts')), /apply\(session, event, tool, undefined, undefined, toolUseId \?\? null\);/);
  assert.match(code(activity), /fireFinished\(id, event === 'stopfail' \? 'error' : undefined\);/, 'control: stopfail still derives the error reason from the event name');
});

// LEAD addition to #378 (human request): every generated coordination text names the host-enforced stop, so no agent asks a fleet to stop by message.
test('the orchestrator brief, both role reminders and the comms skill say: stop/pause a wave or fleet with `orchestra run pause` [--hard], never a message', () => {
  const LINE = 'To stop or pause a wave or a fleet: `orchestra run pause` (soft) or `orchestra run pause --hard` — never a message asking it to stop.';
  const plain = ws.replace(/\\`/g, '`'); // the reminders and the skill live in template literals with escaped backticks
  const brief = plain.slice(plain.indexOf('Track the agents you spawn with'), plain.indexOf('Follow-up work in an area a child agent already owns'));
  assert.ok(brief.length > 200, 'positive control: the brief slice is the real paragraph');
  assert.ok(brief.includes(LINE), 'the orchestrator brief carries the line');
  const reminders = plain.slice(plain.indexOf('Standing role reminder — you are an ORCHESTRATOR *and*'), plain.indexOf('\nfi\nexit 0'));
  assert.equal(reminders.split(LINE).length - 1, 2, 'both the dual-role and the pure-coordinator reminder carry the line');
  const skill = plain.slice(plain.indexOf('const COMMS_SKILL = `'), plain.indexOf('const WORKSPACE_ADMIN_SKILL'));
  assert.ok(skill.includes('To stop or pause a wave or a fleet: `orchestra run pause` (soft) or `orchestra run pause --hard` (§6) — never a message asking it to stop.'), 'the comms skill carries the line (pointing at §6)');
  assert.match(skill, /## 6\. Pause a run \(host-enforced\)/, 'control: the §6 it points at exists');
  assert.ok(ws.includes('run pause --hard') && /orchestra run pause \[--hard\]/.test(read('src', 'cli', 'help.ts')), 'control: the verb the line names exists in the CLI help');
});
