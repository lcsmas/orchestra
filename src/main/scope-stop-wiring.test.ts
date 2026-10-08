import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #327: the scope stop is wired on EXPLICIT stops only (delete/prune, archive, clear, account migration) — never on restart / resume / Veille (#326) / watchdog / boot.
// workspaces.ts and agent-sdk.ts cannot be imported under `node --test` (Electron host), so the wiring is pinned on source text; the behaviour is driven by scripts/e2e-memory-cap.mjs.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => fs.readFileSync(path.join(here, f), 'utf8');
const ws = read('workspaces.ts');
const sdk = read('agent-sdk.ts');
const slice = (src: string, head: string): string => {
  const from = src.indexOf(head);
  assert.ok(from >= 0, `anchor not found: ${head}`);
  return src.slice(from, src.indexOf('\n}\n', from));
};
const CALL = /stopMemberScopeFor\(/g;

test('CONTROL: the slices are the real functions', () => {
  assert.match(slice(ws, 'async function stopStructuredSession('), /killKeeperTree\(/);
  assert.match(slice(ws, 'export async function archiveWorkspace('), /collectWorkspaceTree|upsert/);
  assert.match(slice(sdk, 'export async function sdkClear('), /session\/clear/);
  assert.match(slice(sdk, 'export async function sdkRestart('), /sdkStop|ensureSession|restart/i);
});

test('the ONLY callers of stopMemberScopeFor in the app are the four explicit stops', () => {
  const dir = fs.readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'scope-stop-host.ts');
  const callers = dir.filter((f) => CALL.test(read(f)) || (CALL.lastIndex = 0, false));
  CALL.lastIndex = 0;
  assert.deepEqual(callers.sort(), ['agent-sdk.ts', 'workspaces.ts']);
  assert.equal((ws.match(CALL) ?? []).length, 3, 'workspaces.ts: delete/prune, archive, account migration');
  assert.equal((sdk.match(CALL) ?? []).length, 1, 'agent-sdk.ts: clear');
  for (const other of fs.readdirSync(path.join(here, '..')).filter((d) => d !== 'main')) {
    const p = path.join(here, '..', other);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p).filter((x) => x.endsWith('.ts') || x.endsWith('.tsx'))) {
      assert.doesNotMatch(fs.readFileSync(path.join(p, f), 'utf8'), /stopMemberScopeFor|scope-stop-host/, `${other}/${f}`);
    }
  }
});

test('delete / prune: after the session, the keeper and its tree are gone — then the scope is stopped, with the delete reason', () => {
  const fn = slice(ws, 'async function stopStructuredSession(');
  const k = fn.indexOf('killKeeperTree(');
  const s = fn.indexOf("stopMemberScopeFor(id, 'workspace-deleted')");
  assert.ok(k > 0 && s > k, 'the scope stop comes AFTER the keeper tree is killed (a live keeper makes it a refused no-op)');
  assert.ok(fn.indexOf('sdkStopIfLive(') < k);
});

test('archive: the session AND the keeper are stopped (awaited) before the scope, before the workspace is marked archived', () => {
  const fn = slice(ws, 'export async function archiveWorkspace(');
  const a = fn.indexOf('await sdkStopIfLive(ws.id)');
  const b = fn.indexOf("await killKeeper(ws.id, 'workspace-archived')");
  const c = fn.indexOf("await stopMemberScopeFor(ws.id, 'workspace-archived')");
  const d = fn.indexOf('archived: true');
  assert.ok(a > 0 && b > a && c > b && d > c, `order sdkStopIfLive < killKeeper < stopMemberScopeFor < archived (${a},${b},${c},${d})`);
});

test('account migration: only for a member that had a session — session, keeper, then scope', () => {
  const fn = slice(ws, 'export async function dispatchMigrateAccountRequest(');
  const gate = fn.indexOf('if (hadSdkSession) {');
  const a = fn.indexOf('await sdkStopIfLive(id)', gate);
  const b = fn.indexOf("await killKeeper(id, 'account-migration')", gate);
  const c = fn.indexOf("await stopMemberScopeFor(id, 'account-migration')", gate);
  assert.ok(gate > 0 && a > gate && b > a && c > b, `order gate < sdkStopIfLive < killKeeper < stopMemberScopeFor (${gate},${a},${b},${c})`);
});

test('clear: sdkStop, then the keeper is killed, then the scope — and the resume id is dropped after', () => {
  const fn = slice(sdk, 'export async function sdkClear(');
  const a = fn.indexOf('await sdkStop(wsId)');
  const b = fn.indexOf("await killKeeper(wsId, 'clear')");
  const c = fn.indexOf("await stopMemberScopeFor(wsId, 'clear')");
  const d = fn.indexOf("sdkSessionId: ''");
  assert.ok(a > 0 && b > a && c > b && d > c, `order sdkStop < killKeeper < stopMemberScopeFor < persist (${a},${b},${c},${d})`);
});

test('a RESTART keeps its Reliquats: sdkRestart, the MCP refresh, the rewind, the Veille sweep, the watchdog and the boot never stop a scope', () => {
  for (const [name, body] of [
    ['sdkRestart', slice(sdk, 'export async function sdkRestart(')],
    ['sdkMcpRefresh', slice(sdk, 'export async function sdkMcpRefresh(')],
    ['sdkRewind', slice(sdk, 'export async function sdkRewind(')],
    ['sdkStop', slice(sdk, 'export async function sdkStop(')],
  ] as const) {
    assert.doesNotMatch(body, /stopMemberScopeFor|scope-stop/, `${name} must not stop a scope`);
  }
  for (const f of ['hibernation.ts', 'sdk-delivery.ts', 'index.ts', 'session-watchdog.ts', 'keeper-client.ts', 'memory-scope.ts']) {
    if (fs.existsSync(path.join(here, f))) assert.doesNotMatch(read(f), /stopMemberScopeFor|scope-stop/, `${f} must not stop a scope`);
  }
});

test('the host adapter stops ONLY units the member owns and uses systemctl --user stop on a unit name (never a glob, never --kill-who)', () => {
  const host = read('scope-stop-host.ts');
  assert.match(host, /\['--user', 'stop', '--', unit\]/);
  assert.match(host, /ownsUnit: \(unit\) => scopeGenForWorkspace\(scopePrefix\(e\), wsId, unit\) !== null/);
  assert.match(host, /keeperAlive: \(\) => readTrackedKeeperPid\(wsId\) !== null,/, 'a running member is never stopped under: the keeper-alive precondition reads the tracked keeper');
  assert.match(host, /killReliquats: \(\) => killReliquats\(wsId, scopeDeps, kill, \{ keeperPid: null, cliPid: null \}\),/, 'the Reliquat kill is #325\'s (identity re-read at signal time), over THIS workspace\'s scope deps');
  assert.match(host, /catch \(e\) \{\s*log\.warn\(`scope-stop\[\$\{wsId\}\] \(\$\{reason\}\) failed`, e\);\s*return null;/, 'a failed scope stop never blocks the delete / archive / clear / migration that called it');
  assert.doesNotMatch(host, /kill-who|'--all'|reset-failed/);
  assert.equal((host.match(/execFile\(/g) ?? []).length, 1, 'one systemctl call, on a single unit name');
});
