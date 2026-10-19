// #240 — workspaces.ts imports Electron and cannot load under `node --test`, so these are SOURCE pins of the account-migration wiring;
// the BEHAVIOUR (real `dispatchMigrateAccountRequest` over scratch config dirs, same-dir spellings, bind mount, two concurrent
// migrations) is scripts/e2e-migrate-transcripts.mjs, must-FAIL on master. The move itself is src/main/transcript-move.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.readFileSync(path.join(here, 'workspaces.ts'), 'utf8');

/** From `decl` to the next column-0 declaration. */
function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.notEqual(at, -1, `declaration not found: ${decl}`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\nexport (?:const|interface|type) |\n\/\*\* |\nconst [a-zA-Z]+ = new /);
  return rest.slice(0, end === -1 ? rest.length : end);
}
const code = (src: string) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')).join('\n');

test('CONTROL: the sources are the real functions', () => {
  assert.ok(ws.length > 100_000);
  assert.ok(code(body(ws, 'async function moveWorkspaceTranscripts(')).length > 100);
  assert.ok(code(body(ws, 'export async function dispatchMigrateAccountRequest(')).length > 1000);
});

test('moveWorkspaceTranscripts: the config dirs are compared by IDENTITY (sameDir), never by string, and the move is transcript-move.ts — no rm of its own', () => {
  const f = code(body(ws, 'async function moveWorkspaceTranscripts('));
  assert.match(f, /if \(sameDir\(srcConfigDir, dstConfigDir\)\) return \{ warnings: \[\] \};/);
  assert.doesNotMatch(f, /srcConfigDir\s*===\s*dstConfigDir|dstConfigDir\s*===\s*srcConfigDir/, 'no string compare of the two dirs');
  assert.match(f, /return moveProjectTranscripts\(path\.join\(srcConfigDir, 'projects', mangled\), path\.join\(dstConfigDir, 'projects', mangled\)\);/);
  assert.doesNotMatch(f, /\brm\(|\bunlink\(|\brename\(|\bcopyFile\(/, 'master removed the source dir right here');
  assert.match(ws, /import \{ sameDir \} from '\.\/same-dir\.ts';/);
  assert.match(ws, /import \{ moveProjectTranscripts, type MoveReport \} from '\.\/transcript-move\.ts';/);
});

test('dispatchMigrateAccountRequest: ONE migration per workspace — checked and taken with no await between, before the stop / move, released in a finally', () => {
  const d = code(body(ws, 'export async function dispatchMigrateAccountRequest('));
  const has = d.indexOf('if (migrationsInFlight.has(id))');
  const add = d.indexOf('migrationsInFlight.add(id);');
  assert.ok(has > 0 && add > has, `check then take (${has}, ${add})`);
  assert.doesNotMatch(d.slice(has, add), /\bawait\b/, 'no await between the check and the take (a gap lets two calls both pass)');
  assert.match(d.slice(has, add), /return \{ ok: false, error: /, 'the 2nd call is refused, not queued');
  for (const later of ['await sdkStopIfLive(id)', 'await moveWorkspaceTranscripts(', 'await store.upsertWorkspace(updated)']) {
    assert.ok(d.indexOf(later) > add, `${later} comes after the lock is taken`);
  }
  assert.match(d, /\} finally \{\s*migrationsInFlight\.delete\(id\);\s*\}/, 'released on every path');
  assert.match(d, /const moveReport = await moveWorkspaceTranscripts\(/, 'the warnings are kept');
  assert.match(d, /warnings: moveReport\.warnings/, 'and returned to the caller');
});

test('controls: the SDK stop and the #327 scope stop before the move are untouched', () => {
  const d = code(body(ws, 'export async function dispatchMigrateAccountRequest('));
  assert.match(d, /await sdkStopIfLive\(id\);/);
  assert.match(d, /await stopMemberScopeIfAny\(id, 'account-migration', \(\) => killKeeperIf\(id, keeperBefore, 'account-migration'\)\);/);
  assert.ok(d.indexOf('await stopMemberScopeIfAny(') < d.indexOf('await moveWorkspaceTranscripts('), 'stop before move');
});
