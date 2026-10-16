// #378 — adopt-repo, sandbox import and sandbox eject MOVE an agent's files, and used to "stop" only the agent PTY that ADR 0007 deleted
// (`stopPty(id)`): a mid-turn SDK session kept writing during the move. Each now stops the real session first — awaited, fail closed.
// workspaces.ts / sandbox-import.ts import Electron and cannot load under `node --test`, so these are SOURCE pins; the BEHAVIOUR (a live
// session is dead when the move starts, no write after the snapshot) is scripts/e2e-stop-before-move.mjs, must-FAIL on master d55d6737
// (adopt_live 3/5, import_live 2/4, eject_live 1/3 FAIL). Each pin names the surviving control it must not break.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(here, f), 'utf8');
const ws = read('workspaces.ts');
const imp = read('sandbox-import.ts');

/** From `decl` to the next column-0 declaration. */
function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.notEqual(at, -1, `declaration not found: ${decl}`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\nexport (?:const|interface|type) |\n\/\*\* /);
  return rest.slice(0, end === -1 ? rest.length : end);
}
const code = (src: string) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
const before = (s: string, a: string, b: string, msg: string) => {
  const i = s.indexOf(a), j = s.indexOf(b);
  assert.ok(i !== -1 && j !== -1, `${msg}: anchors present (${a} @${i}, ${b} @${j})`);
  assert.ok(i < j, msg);
};

test('CONTROL: the sources are the real files and the Run/nvim terminals are still stopped by every move', () => {
  assert.ok(ws.length > 100_000 && imp.length > 10_000);
  for (const [name, src] of [['adopt', body(ws, 'export async function dispatchAdoptRepoRequest(')], ['import', body(imp, 'export async function importWorkspaceToSandbox(')], ['eject', body(imp, 'export async function ejectWorkspaceFromSandbox(')]] as const) {
    assert.match(src, /stopPty\(`\$\{id\}:run`\);\s*stopPty\(`\$\{id\}:nvim`\);/, `${name}: the Run/nvim PTYs are still stopped`);
  }
});

test('stopAgentSessionForMove: snapshot the tree, stop the session, await the keeper and the jobs, then fail closed', () => {
  const f = code(body(ws, 'export async function stopAgentSessionForMove('));
  const order = ['snapshotKeeperTree(id)', 'await sdkStopIfLive(id)', 'await killKeeper(id, reason)', 'await killKeeperTree(id, tree, reason)', 'sdkSessionLive(id)'];
  let at = -1;
  for (const s of order) { const i = f.indexOf(s); assert.ok(i > at, `${s} comes after the previous step (was ${i} vs ${at})`); at = i; }
  assert.match(f, /if \(sdkSessionLive\(id\) \|\| readTrackedKeeperPid\(id\) !== null\) \{\s*throw new Error\(/, 'a session or keeper still alive afterwards throws — the move never starts');
  assert.doesNotMatch(f, /\.catch\(/, 'no swallowed stop failure (a delete is best-effort, a move is not)');
  assert.doesNotMatch(f, /forbidKeeperLaunch|stopMemberScopeIfAny/, 'a move forbids no launch and adds no scope-stop site (scope-stop-wiring pins exactly 3)');
});

test('adopt-repo: the session is stopped (awaited) before the checkout is created, and no agent-PTY stop is left', () => {
  const f = code(body(ws, 'export async function dispatchAdoptRepoRequest('));
  before(f, "await stopAgentSessionForMove(id, 'adopt-repo');", 'await createWorktree(', 'adopt stops the session before creating the checkout');
  before(f, "await stopAgentSessionForMove(id, 'adopt-repo');", 'await cp(from', 'adopt stops the session before copying .claude/.orchestra');
  assert.doesNotMatch(f, /stopPty\(id\)/, 'no bare-id stopPty (the agent PTY no longer exists)');
});

test('sandbox import / eject: the session is stopped (awaited) before the payload is staged / the export fetched', () => {
  const i = code(body(imp, 'export async function importWorkspaceToSandbox('));
  before(i, "await stopAgentSessionForMove(id, 'sandbox-import');", 'await stageImportPayload(ws)', 'import stops the session before staging');
  assert.doesNotMatch(i, /stopPty\(id\)/);
  const e = code(body(imp, 'export async function ejectWorkspaceFromSandbox('));
  before(e, "await stopAgentSessionForMove(id, 'sandbox-eject');", 'await fetchToFile(exportUrl', 'eject stops the session before fetching the export');
  assert.doesNotMatch(e, /stopPty\(id\)/);
  assert.match(imp, /import \{[^}]*stopAgentSessionForMove[^}]*\} from '\.\/workspaces';/, 'imported from workspaces');
});
