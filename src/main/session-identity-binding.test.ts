// #379 / ADR 0008 — source-binding gate (the reparent-run-binding.test.ts pattern). The pure decisions are proven in
// session-identity.test.ts / shared/session-identity.test.ts / bus-identity.test.ts (the BUILT CLI); a green suite there says
// nothing if the session start never mints/registers a key, the facade registers it on an ATTACH, a CLI verb still reads the
// baked run, or the key reaches a log. agent-sdk.ts / workspaces.ts / hooks-server.ts cannot load under `node --test`
// (Electron seams), so this reads the SHIPPED source. Every arm names the mutation that reddens it
// (scripts/session-identity-mutants.mjs applies them in place).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.join(here, rel), 'utf8');
const agentSdk = read('agent-sdk.ts');
const keeperClient = read('keeper-client.ts');
const hooks = read('hooks-server.ts');
const workspaces = read('workspaces.ts');
const identity = read('session-identity.ts');
const identityHost = read('session-identity-host.ts');
const busRuns = read('bus-runs.ts');
const cli = read('../cli/index.ts');

const live = (src: string, needle: string): boolean =>
  src.split('\n').some((l) => l.includes(needle) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
const bodyBetween = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  assert.notEqual(a, -1, `anchor not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.notEqual(b, -1, `end anchor not found: ${to}`);
  return src.slice(a, b);
};

// ── the session start: mint, hand to the env, register at a FRESH spawn only ─────────────────────────

test('buildSdkEnv: an inherited key is deleted up front; the session key is set ONLY for a local session and ONLY when handed in', () => {
  const b = bodyBetween(agentSdk, 'async function buildSdkEnv(', '\n}\n');
  assert.ok(live(b, 'delete env[SESSION_KEY_ENV];'), "Orchestra launched from an agent shell would otherwise hand a child ANOTHER workspace's key");
  assert.ok(b.indexOf('delete env[SESSION_KEY_ENV];') < b.indexOf('env[SESSION_KEY_ENV] = opts.sessionKey'), 'delete first, then the explicit assignment');
  const afterRemote = b.slice(b.indexOf('if (!remote) {'));
  assert.ok(live(afterRemote, 'if (opts.sessionKey) env[SESSION_KEY_ENV] = opts.sessionKey;'), 'assigned inside the local (!remote) branch — a sandbox CLI keeps the env fallback (unchanged)');
  assert.ok(!/\bmintSessionKey\(/.test(b), 'buildSdkEnv never mints (the probe, /status and `!cmd` callers would get a key the host never registered)');
});

test('ensureSessionInner mints ONE key per start (local only) and is the ONLY caller that hands a key to buildSdkEnv', () => {
  const inner = bodyBetween(agentSdk, 'async function ensureSessionInner(', '\n}\n');
  assert.ok(live(inner, 'const sessionKey = remote ? undefined : mintSessionKey();'));
  assert.ok(live(inner, 'await buildSdkEnv(ws, { sessionKey })'));
  const calls = [...agentSdk.matchAll(/buildSdkEnv\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a !== 'ws: Workspace, opts: { sessionKey?: string } = {}');
  assert.equal(calls.filter((a) => a.includes('sessionKey')).length, 1, 'exactly one buildSdkEnv call carries a key');
  assert.ok(calls.length >= 5, 'the probe / status / bash-mode callers exist and carry none');
});

test('the ONE keeper-spawn site registers the session key through the facade\'s hook — and the call still ends `) as never,`', () => {
  const call = bodyBetween(agentSdk, 'spawnClaudeCodeProcess: makeKeeperSpawn(', ') as never,');
  assert.ok(call.includes('sessionKey ? () => registerSessionKey(wsId, sessionKey) : undefined'), 'registers THIS start\'s key, and only when there is one');
  assert.ok(live(agentSdk, "import { registerSessionKey } from './session-identity-host.ts';"));
  assert.equal(agentSdk.match(/registerSessionKey\(/g)?.length, 1, 'the one call site (the import line has no paren)');
});

test('the facade registers the key right BEFORE the `spawn` frame of a FRESH CLI — never on the attach path', () => {
  assert.ok(live(keeperClient, 'beforeFreshSpawn?: () => void,'), 'makeKeeperSpawn accepts the optional hook');
  const fresh = bodyBetween(keeperClient, 'sock = await launchKeeperDaemon(wsId, cap);', 'ready = true;');
  const hookAt = fresh.indexOf('beforeFreshSpawn?.();');
  const frameAt = fresh.indexOf("t: 'spawn',");
  assert.ok(hookAt !== -1 && frameAt !== -1 && hookAt < frameAt, 'registered before the spawn frame is written (the CLI cannot call before its key is live)');
  assert.equal(keeperClient.match(/beforeFreshSpawn\?\.\(\)/g)?.length, 1, 'one call — not on the attach branch, not twice');
  const attach = bodyBetween(keeperClient, 'if (ack.running && ack.everStarted !== false', 'if (!sock) {');
  assert.ok(!attach.includes('beforeFreshSpawn'), 'an attach keeps the surviving CLI\'s own key');
});

// ── the host service: on the socket, Electron-free, never logging the key ────────────────────────────

test('/identity is a hooks-socket route answered by the host service; no log line in the route layer or the wiring carries the key', () => {
  assert.ok(live(hooks, "} else if (route === '/identity') {"));
  assert.ok(live(hooks, 'send(200, dispatchIdentityRequest(msg));'));
  for (const [name, src] of [['hooks-server.ts', hooks], ['session-identity-host.ts', identityHost], ['agent-sdk.ts', agentSdk]] as const) {
    const leaking = src.split('\n').map((l) => l.replace(/\s\/\/.*$/, '')).filter((l) => /\blog\.|slog\./.test(l) && /sessionKey|msg\.key|\$\{key\}|\bkey\b[,)]/.test(l) && !l.trimStart().startsWith('//'));
    assert.deepEqual(leaking, [], `${name}: a log line mentions the key`);
  }
  assert.ok(live(identityHost, 'slog.info(`session key registered for ${wsId}`);'), 'registration is logged by workspace id only');
});

test('seam inventory (#137): the identity service imports no Electron, store, bus or platform code — only node: + shared types', () => {
  const imports = identity.split('\n').filter((l) => /^import /.test(l));
  for (const l of imports) assert.match(l, /from 'node:(crypto|fs|path)'|from '\.\.\/shared\/session-identity\.ts'/, `unexpected import in the host-portable module: ${l}`);
  assert.ok(!/electron|\.\/store|\.\/bus|\.\/platform/.test(imports.join('\n')));
});

// ── the CLI: every bus verb reads the host-resolved run ──────────────────────────────────────────────

test('CLI: NO verb reads the baked $ORCHESTRA_RUN_ID / $ORCHESTRA_COORDINATOR_GENERATION — everything goes through liveEnv()', () => {
  const raw = cli.split('\n').filter((l) => /process\.env\.ORCHESTRA_(RUN_ID|COORDINATOR_GENERATION)/.test(l) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
  assert.deepEqual(raw, [], 'a raw read of the baked run/generation bypasses the host');
  const idCalls = cli.split('\n').filter((l) => l.includes('resolveBusIdentity(') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.includes('export function') && !l.includes('  resolveBusIdentity,'));
  assert.ok(idCalls.length >= 4);
  for (const l of idCalls) assert.ok(l.includes('liveEnv()'), `resolveBusIdentity must read liveEnv(): ${l.trim()}`);
  assert.ok(live(cli, 'return identityEnv(process.env, hostIdentity);'));
});

test('CLI: every verb whose case reads the run identity settles the host identity first (HOST_IDENTITY_VERBS is complete)', () => {
  const set = /const HOST_IDENTITY_VERBS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(cli);
  assert.ok(set, 'HOST_IDENTITY_VERBS exists');
  const verbs = new Set([...set![1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const sw = cli.slice(cli.indexOf('switch (command) {'));
  const blocks = sw.split(/\n    case '/).slice(1);
  let reading = 0;
  for (const b of blocks) {
    const verb = b.slice(0, b.indexOf("'"));
    if (/busIdentityOrFail\(|liveEnv\(\)/.test(b)) {
      reading++;
      assert.ok(verbs.has(verb), `\`${verb}\` reads the run identity but is not in HOST_IDENTITY_VERBS — it would read the baked env`);
    }
  }
  assert.ok(reading >= 8, `scanned the verbs that read the identity (${reading})`);
  assert.ok(live(cli, 'if (HOST_IDENTITY_VERBS.has(command)) await settleHostIdentity();'), 'settled before the verb switch');
  assert.ok(cli.indexOf('await settleHostIdentity();') < cli.indexOf('switch (command) {'));
});

test('CLI send: the marker guard is the FALLBACK\'s — it runs before any bus is opened, and only without a host answer', () => {
  const sendCase = bodyBetween(cli, "case 'send': {", "case 'check': {");
  const guard = "if (hostIdentity?.source !== 'host') refuseIfStaleRun(liveEnv().ORCHESTRA_RUN_ID);";
  assert.ok(live(sendCase, guard));
  assert.ok(sendCase.indexOf(guard) < sendCase.indexOf('openBusForVerb()'));
  const checkAck = bodyBetween(cli, "case 'check': {", "case 'ask': {");
  assert.ok(!checkAck.includes('refuseIfStaleRun'), 'check/ack are always allowed in the fallback (reading old mail is never blocked)');
});

// ── the host side of promote ─────────────────────────────────────────────────────────────────────────

test('reconcile: a keyed live session is host-resolved — marker FILE only, no restart attempt, no stale flag', () => {
  const rec = bodyBetween(workspaces, 'async function reconcileRunAfterReparent(', '\n}\n');
  assert.ok(live(rec, 'const hostKey = hasSessionKey(ws.id);') && live(rec, 'hostAnswers: hostKey,'), 'the candidate carries whether the host holds a key for the workspace');
  assert.ok(live(rec, 'const detachedKeyed = !sdkLive && hostKey && readTrackedKeeperPid(ws.id) !== null;') && live(rec, 'live: sdkLive || detachedKeyed,'), 'a keeper-detached keyed CLI is as live as a session for the host');
  const branch = bodyBetween(rec, "if (action.kind === 'host-resolved') {", "if (action.kind === 'mark-stale') {");
  assert.ok(live(branch, 'await writeStaleRunMarkerFile(ws, newAnchorId);'), 'the fallback guard is armed (the app may go away)');
  assert.ok(live(branch, 'hostResolved.push(ws.id);'));
  assert.ok(!/markWorkspaceStaleRun|dispatchRestartRequest|busRunStale/.test(branch), 'no stale pane state, no restart');
  assert.ok(live(rec, 'return { restarted, markedStale, hostResolved };'));
  // the marker file helper does NOT touch the store flag
  const fileHelper = bodyBetween(workspaces, 'async function writeStaleRunMarkerFile(', '\n}\n');
  assert.ok(!/busRunStale|store\./.test(fileHelper));
});

test('a deleted workspace forgets its session key at every removal path (delete, bulk delete, prune)', () => {
  assert.equal(workspaces.match(/forgetSessionKey\(/g)?.length, 4, 'three removal paths + the coordinator bump (MAJOR-1; the import line has no paren)');
  const del = bodyBetween(workspaces, 'export async function deleteWorkspace(id: string)', '\n}\n');
  assert.ok(del.includes('forgetSessionKey(id)'));
  const bulk = bodyBetween(workspaces, 'export async function deleteWorkspaces(', '\n}\n');
  assert.ok(bulk.includes('forgetSessionKey(id)'));
  const prune = bodyBetween(workspaces, 'export async function pruneOrphanedWorkspaces()', '\n}\n');
  assert.ok(prune.includes('forgetSessionKey(ws.id)'));
});

test('refreeze --only: memoryCap joins dockerRelay on the allow-list, and nothing else', () => {
  assert.ok(live(busRuns, "export const ONE_SWITCH_REFREEZABLE: readonly BusMechanism[] = ['dockerRelay', 'memoryCap'];"));
});

test('MAJOR-1 the coordinator bump revokes the replaced session\'s key in the same tick (else /identity hands the zombie the NEW generation)', () => {
  const b = bodyBetween(workspaces, 'export function maybeBumpCoordinatorOnReplacement(', '\n}\n');
  const bumpAt = b.indexOf('const gen = bumpCoordinatorGeneration(db, anchor.anchorId);');
  const forgetAt = b.indexOf('forgetSessionKey(ws.id);');
  assert.ok(bumpAt !== -1 && forgetAt > bumpAt, 'forgotten right after the bump (both synchronous: no await between them)');
  assert.ok(!b.slice(bumpAt, forgetAt).includes('await'), 'no await between the bump and the revocation');
  assert.ok(b.indexOf('shouldBumpCoordinatorGeneration(anchor, runRowExists)') < bumpAt, 'only when a bump really happens (a plain member restart keeps its key)');
});
