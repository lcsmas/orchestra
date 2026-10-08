// #320 — source-binding gate (the docker-relay-binding.test.ts pattern): agent-sdk.ts / keeper-client.ts / the keeper daemon / hooks-server.ts cannot load under `node --test`,
// so this reads the SHIPPED source and asserts every hop of the cap is wired: decision → makeKeeperSpawn → systemd-run launch → spawn frame → keeper setup → watch → kill delivery → bus-status.
// The decisions are proven in memory-cap-switch.test.ts / shared/memory-scope.test.ts; the real scope end to end in scripts/e2e-memory-cap.mjs. Each negative control proves the matcher can say no.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(path.join(here, rel), 'utf8');
const agentSdk = src('agent-sdk.ts');
const keeperClient = src('keeper-client.ts');
const keeper = src('../keeper/index.ts');
const hooks = src('hooks-server.ts');
const cli = src('../cli/index.ts');
const live = (s: string, needle: string): boolean => s.split('\n').some((l) => l.includes(needle) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));

test('the ONE keeper-spawn site passes the memory-cap decision as the 4th argument, computed from the frozen run id, the workspace (fleet-member test), the sandbox flag and the store\'s levels', () => {
  assert.equal(agentSdk.match(/makeKeeperSpawn\(/g)?.length, 1);
  const call = agentSdk.slice(agentSdk.indexOf('spawnClaudeCodeProcess: makeKeeperSpawn('), agentSdk.indexOf(') as never,', agentSdk.indexOf('spawnClaudeCodeProcess: makeKeeperSpawn(')));
  assert.match(call, /memoryCapSpecFor\(\{ wsId, runId: sdkEnv\.ORCHESTRA_RUN_ID, ws, remote, settings: store\.getMemoryGuardSettings\(\) \}\)/);
  assert.ok(live(agentSdk, "import { memoryCapSpecFor } from './memory-cap-switch.ts';"));
  assert.doesNotMatch(agentSdk, /admission/i, 'the serialized seam stays free of Admission (admission-wiring.test.ts pins it): fleet membership is decided INSIDE memory-cap-switch.ts');
  assert.ok(live(src('memory-cap-switch.ts'), 'hasCoordinator: isFleetMember(a.ws), remote'), 'one definition of a fleet member (Admission\'s)');
  assert.ok(!/memoryCapSpecFor/.test(agentSdk.replace(call, '').replace(/import \{ memoryCapSpecFor \}[^\n]*\n/, '')), 'the decision is made at exactly this site — not a second copy elsewhere');
  // negative control: a comment-only mention is not wiring
  assert.ok(!live('// memoryCapSpecFor({ wsId, runId: x })', 'memoryCapSpecFor({ wsId, runId'));
});

test('the facade launches the keeper through systemd-run ONLY when given a spec, falls back to a plain launch if the LAUNCHER failed, and never moves an existing process', () => {
  assert.ok(live(keeperClient, 'memoryCap?: MemoryCapLaunch,'), 'makeKeeperSpawn accepts the optional spec');
  assert.ok(live(keeperClient, 'sock = await launchKeeperDaemon(wsId, memoryCap);'));
  assert.ok(live(keeperClient, 'const launch = buildScopeLaunchArgv({'), 'the launch argv comes from the ONE pure builder');
  assert.ok(live(keeperClient, 'launching it WITHOUT a scope') || keeperClient.includes('launching it WITHOUT a scope'), 'the fallback says so in the app log');
  assert.ok(!/systemctl[^\n]*(attach|move|--property=PIDs)/i.test(keeperClient), 'no code path moves an existing process into a scope');
  assert.ok(!/\bkillMode|KillMode=control-group|oom_group/.test(keeperClient + keeper), 'never a group kill');
});

test('the spawn frame carries memoryCap ONLY when there are limits to verify (absent ⇒ today\'s frame, byte for byte)', () => {
  assert.ok(live(keeperClient, '...(memoryCap?.limits ? { memoryCap: { unit: memoryCap.unit, hardBytes: memoryCap.limits.hardBytes, wrapper: oomWrapperPath() } } : {}),'));
  assert.ok(live(keeperClient, 'installOomWrapper();'), 'installKeeper lays the tool wrapper down on every start');
});

test('the keeper verifies its own scope, starts the kill watch, wraps the tools — and does all of it BEFORE the CLI exists, on both spawn paths', () => {
  assert.ok(live(keeper, 'const capEnv = f.memoryCap ? setupMemoryCap(f.memoryCap, f.env) : f.env;'), 'relay path');
  assert.ok(live(keeper, 'startChild(f.command, f.args, f.cwd, f.memoryCap ? setupMemoryCap(f.memoryCap, f.env) : f.env);'), 'plain path');
  assert.ok(live(keeper, "const out: Record<string, string | undefined> = { ...env, CLAUDE_CODE_SHELL_PREFIX: cap.wrapper };"));
  assert.ok(live(keeper, 'if (cap.wrapper && !wrapperPathUsable(cap.wrapper)) {'), 'a wrapper path the CLI would split at a space is never set as the prefix');
  assert.ok(live(keeper, '...(capInfo ? { cap: capInfo } : {}),') && live(keeper, '...(memKills.length ? { memKills: memKills.slice() } : {}),'), 'helloAck/probe carry the state and the catch-up');
  assert.ok(live(keeper, 'send({ t: \'memKill\', rec });'), 'a kill is pushed to the attached client');
  assert.ok(live(keeper, 'memWatch?.stop();'), 'the watch ends with the keeper');
});

test('a kill reaches the app log and the listeners once (push frame AND helloAck catch-up), keyed by scope unit + seq', () => {
  assert.ok(live(keeperClient, 'deliverKills(f.memKills); // #320: kills that happened while no app was attached'));
  assert.ok(live(keeperClient, 'deliverMemKill(wsId, f.rec);'));
  assert.ok(live(keeperClient, 'log.warn(formatMemKillLine(wsId, rec));'));
  assert.ok(live(keeperClient, 'if (rec.seq <= seen) return;'));
});

test('bus-status: the route sends the levels + the memory-paused runs (D1), the CLI prints them', () => {
  assert.ok(live(hooks, 'memoryPausedRuns: memoryPausedRunViews(badDb,'));
  assert.ok(hooks.includes('memoryCap: (() => {') && hooks.includes('store.getMemoryGuardSettings()'));
  assert.ok(live(cli, 'process.stdout.write(`${formatMemoryGuardLine(res.memoryGuard as MemoryGuardSnapshot, Array.isArray(res.memoryPausedRuns)'));
  assert.ok(live(cli, 'process.stdout.write(`${formatMemoryCapLine({ ...mc, switchOn: res.runExists === false ? null : frozenForCap.memoryCap })}\\n`);'));
});
