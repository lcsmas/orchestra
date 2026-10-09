import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #327: the scope stop is wired on EXPLICIT stops only (delete/prune, archive, clear, account migration) and, at each, ONLY for a member that HAS a kernel scope — a member without one behaves exactly as before
// (memory_cap OFF is inert, D-Q1). Never on restart / resume / Veille (#326) / watchdog / boot. workspaces.ts and agent-sdk.ts cannot be imported under `node --test` (Electron host), so the wiring is pinned on
// source text (exact statements, not just order); the behaviour is driven by scripts/e2e-memory-cap.mjs on the facade the call sites use.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => fs.readFileSync(path.join(here, f), 'utf8');
const ws = read('workspaces.ts');
const sdk = read('agent-sdk.ts');
const host = read('scope-stop-host.ts');
const keeperClient = read('keeper-client.ts');
const slice = (src: string, head: string): string => {
  const from = src.indexOf(head);
  assert.ok(from >= 0, `anchor not found: ${head}`);
  return src.slice(from, src.indexOf('\n}\n', from));
};
const ENTRY = /stopMemberScopeFor|stopMemberScopeIfAny|clearScopedMember|memberHasScope|scope-stop-host/; // NOT global: a /g regex's .test() carries lastIndex across files

test('CONTROL: the slices are the real functions', () => {
  assert.match(slice(ws, 'async function stopStructuredSession('), /killKeeperTree\(/);
  assert.match(slice(ws, 'export async function archiveWorkspace('), /collectWorkspaceTree|upsert/);
  assert.match(slice(sdk, 'export async function sdkClear('), /session\/clear/);
  assert.match(slice(sdk, 'export async function sdkRestart('), /sdkStop|ensureSession|restart/i);
  assert.match(slice(host, 'async function boundedLocked('), /Promise\.race/);
});

test('the ONLY users of the scope-stop entries in the app are the four explicit stops (and the host itself)', () => {
  const files = fs.readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'scope-stop-host.ts');
  assert.deepEqual(files.filter((f) => ENTRY.test(read(f))).sort(), ['agent-sdk.ts', 'workspaces.ts']);
  assert.equal((ws.match(/stopMemberScopeIfAny\(/g) ?? []).length, 3, 'workspaces.ts: delete/prune, archive, account migration');
  assert.equal((sdk.match(/clearScopedMember\(/g) ?? []).length, 1, 'agent-sdk.ts: clear');
  assert.equal((sdk.match(/memberHasScope\(/g) ?? []).length, 1);
  assert.doesNotMatch(ws + sdk, /stopMemberScopeFor\(/, 'the unconditional entry is the host\'s own: a call site goes through the scope-gated ones');
  for (const other of fs.readdirSync(path.join(here, '..')).filter((d) => d !== 'main')) {
    const p = path.join(here, '..', other);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p).filter((x) => x.endsWith('.ts') || x.endsWith('.tsx'))) {
      assert.doesNotMatch(fs.readFileSync(path.join(p, f), 'utf8'), ENTRY, `${other}/${f}`);
    }
  }
});

test('delete / prune: after the session, the keeper and its tree are gone — then the scope stop, an AWAITED top-level statement (not void, not conditional)', () => {
  const fn = slice(ws, 'async function stopStructuredSession(');
  const k = fn.indexOf('killKeeperTree(');
  const s = fn.indexOf("stopMemberScopeIfAny(id, 'workspace-deleted')");
  assert.ok(k > 0 && s > k, 'the scope stop comes AFTER the keeper tree is killed');
  assert.match(fn, /\n  await stopMemberScopeIfAny\(id, 'workspace-deleted'\);/);
  assert.ok(fn.indexOf('sdkStopIfLive(') < k);
});

test('archive: for a member WITH a scope the session AND the keeper (the one read BEFORE) are stopped, then the scope — a member without one stops nothing here; all before the workspace is marked archived', () => {
  const fn = slice(ws, 'export async function archiveWorkspace(');
  assert.match(fn, /\n    const keeperBefore = readTrackedKeeperPid\(ws\.id\);\n    await stopMemberScopeIfAny\(ws\.id, 'workspace-archived', async \(\) => \{\n      await sdkStopIfLive\(ws\.id\);\n      await killKeeperIf\(ws\.id, keeperBefore, 'workspace-archived'\);\n    \}\);\n/);
  assert.ok(fn.indexOf("stopMemberScopeIfAny(ws.id, 'workspace-archived'") < fn.indexOf('archived: true'));
  assert.equal((fn.match(/sdkStopIfLive\(/g) ?? []).length, 1, 'no session stop outside the scope-gated extra: master stopped only the root (the caller)');
  assert.doesNotMatch(fn, /\bkillKeeper\(/, 'no unconditional keeper kill outside the scope-gated extra');
});

test('account migration: only for a member that HAD a session; the old keeper is killed and the scope stopped only for a member WITH a scope', () => {
  const fn = slice(ws, 'export async function dispatchMigrateAccountRequest(');
  assert.match(fn, /\n    if \(hadSdkSession\) \{\n      const keeperBefore = readTrackedKeeperPid\(id\);\n      await sdkStopIfLive\(id\);\n[^\n]*\n      await stopMemberScopeIfAny\(id, 'account-migration', \(\) => killKeeperIf\(id, keeperBefore, 'account-migration'\)\);\n    \}\n/);
  assert.doesNotMatch(fn, /\bkillKeeper\(/, 'master did not kill the keeper at a migration: only a scoped member now');
});

test('clear: a member WITHOUT a scope is cleared exactly as before (persist, announce — nothing else); WITH one the announce runs FIRST under the keeper lock, then the old keeper and the scope', () => {
  const fn = slice(sdk, 'export async function sdkClear(');
  const scoped = fn.indexOf('const scoped = memberHasScope(wsId);');
  const stop = fn.indexOf('await sdkStop(wsId)');
  assert.ok(scoped > 0 && scoped < stop, 'whether the member is scoped is decided BEFORE anything is stopped');
  assert.match(fn, /\n  const keeperBefore = scoped \? readTrackedKeeperPid\(wsId\) : null;\n/);
  assert.match(fn, /\n  if \(session\) \{\n    session\.cleared = true;\n    await sdkStop\(wsId\);\n  \}\n/, 'the original in-memory-session branch is unchanged');
  const announce = fn.slice(fn.indexOf('const announce = async'), fn.indexOf('if (!scoped) return announce();'));
  assert.ok(announce.indexOf("sdkSessionId: ''") > 0 && announce.indexOf("type: 'session/clear'") > announce.indexOf("sdkSessionId: ''"), 'announce = persist the cleared id, THEN session/clear (master\'s order)');
  assert.match(fn, /\n  if \(!scoped\) return announce\(\);\n/, 'no scope ⇒ exactly master');
  assert.match(fn, /\n  await clearScopedMember\(wsId, keeperBefore, announce\);$/, 'the last statement: the scoped clear is awaited');
  assert.doesNotMatch(fn, /\bkillKeeper\(|stopMemberScopeFor\(|withKeeperLock\(/, 'every new stop lives behind the scope-gated host entry');
});

test('a RESUME keeps its Reliquats: sdkRestart\'s own text (the `fresh` option reaches sdkClear = /clear, which stops a SCOPED member\'s scope), the MCP refresh, the rewind, sdkStop, the Veille sweep, the watchdog and the boot never stop a scope', () => {
  for (const [name, body] of [
    ['sdkRestart', slice(sdk, 'export async function sdkRestart(')],
    ['sdkMcpRefresh', slice(sdk, 'export async function sdkMcpRefresh(')],
    ['sdkRewind', slice(sdk, 'export async function sdkRewind(')],
    ['sdkStop', slice(sdk, 'export async function sdkStop(')],
  ] as const) {
    assert.doesNotMatch(body, ENTRY, `${name} must not stop a scope`);
  }
  for (const f of ['hibernation.ts', 'sdk-delivery.ts', 'index.ts', 'session-watchdog.ts', 'keeper-client.ts', 'memory-scope.ts']) {
    if (fs.existsSync(path.join(here, f))) assert.doesNotMatch(read(f), ENTRY, `${f} must not stop a scope`);
  }
});

test('host: no scope ⇒ null and nothing runs; the entries are bounded + locked; the Reliquat kill is restricted to the DEAD scopes; the live keeper is placed by its own cgroup', () => {
  assert.match(slice(host, 'export async function stopMemberScopeIfAny('), /\n  if \(!memberHasScope\(wsId\)\) return null;\n/, '`extra` is not even evaluated for a member without a scope');
  assert.match(host, /return memberScopeDeps\(wsId, e\)\.scopes\(wsId\)\.length > 0;\n  \} catch \{\n    return false;/, 'an unreadable lookup reads as NO scope: behaves exactly as before');
  assert.match(host, /const run = withKeeperLock\(wsId, op\);/, 'under the member\'s keeper lock: a launch cannot interleave with the kill');
  assert.match(host, /Promise\.race\(\[run, late\]\)/, 'bounded: a wedged systemd cannot park a delete');
  assert.match(host, /killReliquats: \(only\) => killReliquats\(wsId, \{ \.\.\.scopeDeps, scopes: \(\) => scopeDeps\.scopes\(wsId\)\.filter\(\(s\) => only\.some\(\(o\) => o\.unit === s\.unit\)\) \}, kill, \{ keeperPid: null, cliPid: null \}\),/, 'the identity-checked kill of #325, over THIS member\'s DEAD scopes only');
  assert.match(host, /liveKeeperUnit: \(\) => trackedKeeperUnit\(wsId, e\),/);
  assert.match(host, /parseProcCgroupV2\(e\.readFile\(`\$\{e\.procRoot\}\/\$\{pid\}\/cgroup`\)\)/, 'the tracked keeper is placed by ITS OWN /proc cgroup');
  assert.match(host, /ownsUnit: \(unit\) => scopeGenForWorkspace\(scopePrefix\(e\), wsId, unit\) !== null,/);
  assert.match(host, /\['--user', 'stop', '--', unit\]/);
  assert.doesNotMatch(host, /kill-who|'--all'|reset-failed/);
  assert.equal((host.match(/execFile\(/g) ?? []).length, 1, 'one systemctl call, on a single unit name');
  assert.match(host, /catch \(e\) \{\n    log\.warn\(`scope-stop\[\$\{wsId\}\] \(\$\{reason\}\) failed`, e\);\n    return null;/, 'a failed scope stop never blocks the delete / archive / clear / migration that called it');
  const clear = slice(host, 'export async function clearScopedMember(');
  const a = clear.indexOf('await announce()');
  const k = clear.indexOf('await killKeeperIfHeld(wsId, oldKeeperPid');
  const s = clear.indexOf("stopMemberScope(wsId, 'clear'");
  assert.ok(a > 0 && k > a && s > k, `announce < old-keeper kill < scope stop (${a},${k},${s})`);
  assert.match(clear, /if \(announceFailed\) throw/, 'a failed clear is surfaced, as without a scope');
});

test('keeper-client: the conditional kill only kills THE keeper read before the stop (a successor has another pid)', () => {
  assert.match(slice(keeperClient, 'export async function killKeeperIfHeld('), /if \(expectedPid === null \|\| readTrackedKeeperPid\(wsId\) !== expectedPid\) return;\n  await killKeeperUnlocked\(wsId, reason\);/);
  assert.match(keeperClient, /export function killKeeperIf\([^)]*\): Promise<void> \{\n  return serializeKeeperOp\(wsId, \(\) => killKeeperIfHeld\(wsId, expectedPid, reason\)\);/);
});
