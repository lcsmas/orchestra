#!/usr/bin/env node
// #379 / ADR 0008 self-gate — IN-PLACE mutation sweep of the host-resolved bus identity. Each mutant reverts ONE clause in the real source and
// must turn its NAMED unit file(s) and/or rig red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree (the restore
// proof is `git diff` empty). CONTROL first: every named unit file and rig must be GREEN unmutated, so a RED later is the mutant's doing.
// Rigs: scripts/verify-promote-run-refresh.mjs (the real workspaces.ts reconcile + the real /identity dispatcher; killed when it exits non-zero
// AND prints `FAIL <clause>`), scripts/e2e-keeper-session-key.mjs (real keeper daemon; killed when its arm prints "ok":false).
// CLI mutants rebuild dist-electron/cli.js (src/cli/bus-identity.test.ts drives the BUILT bundle); the bundle is rebuilt again after the run.
// Run: node scripts/session-identity-mutants.mjs [--only M01,M07] [--no-rig] [--check-anchors]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = args.includes('--no-rig');

const SDK = 'src/main/agent-sdk.ts', KC = 'src/main/keeper-client.ts', WS = 'src/main/workspaces.ts', HS = 'src/main/hooks-server.ts';
const SIM = 'src/main/session-identity.ts', SIS = 'src/shared/session-identity.ts', CLI = 'src/cli/index.ts', RR = 'src/shared/reparent-run.ts', BR = 'src/main/bus-runs.ts';
const T = {
  host: 'src/main/session-identity.test.ts', pure: 'src/shared/session-identity.test.ts', bind: 'src/main/session-identity-binding.test.ts',
  cli: 'src/cli/bus-identity.test.ts', dec: 'src/shared/reparent-run.test.ts', runs: 'src/main/bus-runs.test.ts', sbx: 'src/main/sandbox-pause-wiring.test.ts',
  rrb: 'src/main/reparent-run-binding.test.ts',
};
const PROMOTE = { script: 'scripts/verify-promote-run-refresh.mjs', kind: 'promote' };
const KEY = (arm) => ({ script: 'scripts/e2e-keeper-session-key.mjs', kind: 'key', arm });

/** One mutant = exact-once edits [file, find, replacement]. `tests` = unit files that must go red; `rig` = {script,kind[,arm]}; `cli` = rebuild the CLI bundle first. */
const MUTANTS = [
  // ── the facade: register at a FRESH spawn, never at an attach ──
  { id: 'M01', name: 'facade never registers the key', edits: [[KC, "            beforeFreshSpawn?.(); // #379: the new CLI's session key becomes the live one before the CLI exists (a throw fails this start loudly)\n", '']], tests: [T.bind], rig: KEY('key_registered_before_cli') },
  { id: 'M02', name: 'facade registers on an ATTACH too (a surviving CLI would be superseded by an unused key)', edits: [[KC, "          if (attached) onAttached?.(attachedPid, attachedTurnInFlight);", "          if (attached) { beforeFreshSpawn?.(); onAttached?.(attachedPid, attachedTurnInFlight); }"]], tests: [T.bind], rig: KEY('key_attach_keeps') },
  { id: 'M03', name: 'facade registers AFTER the spawn frame (the CLI could call before its key is live)', edits: [
      [KC, "            beforeFreshSpawn?.(); // #379: the new CLI's session key becomes the live one before the CLI exists (a throw fails this start loudly)\n", ''],
      [KC, "            if (cap?.limits) void reportCapState(wsId, cap).catch(() => {});", "            beforeFreshSpawn?.();\n            if (cap?.limits) void reportCapState(wsId, cap).catch(() => {});"]], tests: [T.bind], rig: KEY('key_registered_before_cli') },
  // ── the session start ──
  { id: 'M04', name: 'ensureSessionInner mints a key but never hands it to the env', edits: [[SDK, 'await buildSdkEnv(ws, { sessionKey })', 'await buildSdkEnv(ws)']], tests: [T.bind, T.sbx] },
  { id: 'M05', name: 'buildSdkEnv lets an inherited (another workspace\'s) key through', edits: [[SDK, '  delete env[SESSION_KEY_ENV];\n', '']], tests: [T.bind] },
  { id: 'M06', name: 'buildSdkEnv mints a key for every caller (probe / status / `!cmd` get one the host never registered)', edits: [[SDK, 'if (opts.sessionKey) env[SESSION_KEY_ENV] = opts.sessionKey;', 'env[SESSION_KEY_ENV] = opts.sessionKey ?? mintSessionKey();']], tests: [T.bind] },
  { id: 'M07', name: 'a SANDBOX session also gets a key (no host-resolved path exists for it)', edits: [[SDK, 'const sessionKey = remote ? undefined : mintSessionKey();', 'const sessionKey = mintSessionKey();']], tests: [T.bind] },
  // ── the host service ──
  { id: 'M08', name: 'verify() vouches for ANY key once an entry exists (no superseding)', edits: [[SIM, "return presented.length === stored.length && crypto.timingSafeEqual(presented, stored) ? 'ok' : 'superseded';", "return 'ok';"]], tests: [T.host], rig: PROMOTE },
  { id: 'M09', name: 'the registry persists the RAW key', edits: [[SIM, 'const next = { ...sessions, [wsId]: { hash: hashSessionKey(key), issuedAt: now() } };', 'const next = { ...sessions, [wsId]: { hash: hashSessionKey(key), issuedAt: now(), key } };']], tests: [T.host] },
  { id: 'M10', name: 'a replaced session is answered "unregistered" (the CLI would fall back to its env instead of being refused)', edits: [[SIM, "      code: 'superseded',\n      error: `this session of workspace", "      code: 'unregistered',\n      error: `this session of workspace"]], tests: [T.host], rig: PROMOTE },
  { id: 'M11', name: 'the service ignores the workspace (answers the first entry\'s run for anyone)', edits: [[SIM, "const verdict = deps.registry.verify(id, key);", "const verdict = deps.registry.verify(id, key) === 'unregistered' ? 'unregistered' : 'ok';"]], tests: [T.host], rig: PROMOTE },
  { id: 'M12', name: 'the registry file is world-readable', edits: [[SIM, 'fsx.writeFileSync(tmp, body, { mode: 0o600 });', 'fsx.writeFileSync(tmp, body, { mode: 0o644 });']], tests: [T.host] },
  { id: 'M13', name: 'the service answers the generation baked into nothing: always 0', edits: [[SIM, "return { ok: true, runId, generation: Number.isInteger(generation) && generation > 0 ? generation : null };", "return { ok: true, runId, generation: null };"]], tests: [T.host] },
  // ── the CLI ──
  { id: 'M14', name: 'liveEnv ignores the host answer', cli: true, edits: [[CLI, 'return identityEnv(process.env, hostIdentity);', 'return process.env;']], tests: [T.cli, T.bind] },
  { id: 'M15', name: 'a superseded session falls back to its env (no refusal)', cli: true, edits: [[SIS, "  if (reply.ok === false && reply.code === 'superseded') {\n    throw new SessionSupersededError(\n      typeof reply.error === 'string' && reply.error ? reply.error : 'this session was superseded',\n    );\n  }\n", '']], tests: [T.pure, T.cli] },
  { id: 'M16', name: 'an unreachable host refuses every bus verb (no env fallback)', cli: true, edits: [[SIS, "  } catch {\n    return { source: 'env', why: 'unreachable' };\n  }", "  } catch (e) {\n    throw e;\n  }"]], tests: [T.pure, T.cli] },
  { id: 'M17', name: 'the stale marker also blocks when the HOST answered', cli: true, edits: [[CLI, "if (hostIdentity?.source !== 'host') refuseIfStaleRun(liveEnv().ORCHESTRA_RUN_ID);", "refuseIfStaleRun(liveEnv().ORCHESTRA_RUN_ID);"]], tests: [T.cli, T.bind, T.rrb] },
  { id: 'M18', name: '`ack` does not settle the host identity (a replaced session could still ack)', cli: true, edits: [[CLI, "new Set(['send', 'check', 'ack', 'ask', 'token', 'gate', 'run', 'bus-status'])", "new Set(['send', 'check', 'ask', 'token', 'gate', 'run', 'bus-status'])"]], tests: [T.cli, T.bind] },
  { id: 'M19', name: 'the host generation never replaces the baked one', cli: true, edits: [[SIS, "    ORCHESTRA_COORDINATOR_GENERATION: resolution.generation === null ? undefined : String(resolution.generation),", "    ORCHESTRA_COORDINATOR_GENERATION: env.ORCHESTRA_COORDINATOR_GENERATION,"]], tests: [T.pure, T.cli] },
  { id: 'M20', name: 'the marker guard ignores "the env already carries the new run" (bash mode regresses)', cli: true, edits: [[SIS, "if (newRun !== null && envRunId && envRunId.trim() === newRun) return null;", ""]], tests: [T.pure, T.cli] },
  { id: 'M21', name: 'the CLI never sends the key (identity call without it)', cli: true, edits: [[SIS, "reply = await call(IDENTITY_ROUTE, { id, key });", "reply = await call(IDENTITY_ROUTE, { id });"]], tests: [T.pure, T.cli] },
  { id: 'M22', name: 'a keyless session still asks the host', cli: true, edits: [[SIS, "  if (!key) return { source: 'env', why: 'no-key' };\n", ""]], tests: [T.pure, T.cli] },
  // ── the host side of promote ──
  { id: 'M23', name: 'the reconcile never tells the decision the host holds a key', edits: [[WS, 'hostAnswers: hostKey,', 'hostAnswers: false,']], tests: [T.bind], rig: PROMOTE },
  { id: 'M31', name: 'a keeper-DETACHED keyed CLI is treated as cold (no marker for the fallback)', edits: [[WS, 'live: sdkLive || detachedKeyed,', 'live: sdkLive,']], tests: [T.bind, T.rrb], rig: PROMOTE },
  { id: 'M24', name: 'host-resolved also marks the workspace stale (the pane flag, the CLI "STALE RUN")', edits: [[WS, "        await writeStaleRunMarkerFile(ws, newAnchorId);\n        hostResolved.push(ws.id);", "        await markWorkspaceStaleRun(ws, newAnchorId);\n        hostResolved.push(ws.id);"]], tests: [T.bind], rig: PROMOTE },
  { id: 'M25', name: 'host-resolved writes no marker file (the app-down fallback would send into the stale run)', edits: [[WS, "        await writeStaleRunMarkerFile(ws, newAnchorId);\n        hostResolved.push(ws.id);", "        hostResolved.push(ws.id);"]], tests: [T.bind], rig: PROMOTE },
  { id: 'M26', name: 'the decision checks the host key BEFORE liveness (a cold workspace is "host-resolved")', edits: [[RR, "  if (!candidate.live) return { kind: 'notice-only' };\n  // #379: whatever `--no-restart` says, a session the host can answer needs neither the restart nor the stale state.\n  if (candidate.hostAnswers) return { kind: 'host-resolved' };", "  if (candidate.hostAnswers) return { kind: 'host-resolved' };\n  if (!candidate.live) return { kind: 'notice-only' };"]], tests: [T.dec], rig: PROMOTE },
  { id: 'M27', name: 'a deleted workspace keeps its session key', edits: [[WS, "  forgetSessionKey(id); // #379: a deleted workspace has no session to vouch for\n", '']], tests: [T.bind] },
  { id: 'M28', name: 'no /identity route on the host socket', edits: [[HS, "} else if (route === '/identity') {", "} else if (route === '/identity-off') {"]], tests: [T.bind] },
  { id: 'M29', name: 'the registration is logged WITH the key', edits: [[ 'src/main/session-identity-host.ts', 'slog.info(`session key registered for ${wsId}`);', 'slog.info(`session key registered for ${wsId}: ${key}`);' ]], tests: [T.bind] },
  // ── refreeze ──
  { id: 'M30', name: 'memory_cap is not on the one-switch re-freeze allow-list', edits: [[BR, "['dockerRelay', 'memoryCap']; // #379", "['dockerRelay']; // #379"]], tests: [T.runs, T.bind] },
];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const count = (src, s) => src.split(s).length - 1;
function anchorsOk() {
  let bad = 0, total = 0;
  for (const m of MUTANTS) for (const [f, find] of m.edits) {
    total++;
    let src = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const [f2, find2, to2] of m.edits) { if (f2 !== f) continue; if (find2 === find) break; src = src.replace(find2, () => to2); }
    const n = count(src, find);
    if (n !== 1) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${f} matches ${n}× (need exactly 1): ${JSON.stringify(find.slice(0, 80))}`); }
  }
  console.log(`ANCHORS: ${total - bad}/${total} resolve exactly once`);
  return bad === 0;
}
if (args.includes('--check-anchors')) process.exit(anchorsOk() ? 0 : 1);
if (!anchorsOk()) process.exit(2);
const touched = [...new Set(MUTANTS.flatMap((m) => m.edits.map(([f]) => f)))];
if (spawnSync('git', ['-C', REPO, 'diff', '--quiet', '--', ...touched]).status !== 0) { console.error('ABORT: a file a mutant edits has uncommitted changes — commit first (the restore proof is `git diff` empty)'); process.exit(2); }

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'identity379-mutants-'));
const unit = (files) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: REPO, encoding: 'utf8', timeout: 600000 });
const failedNames = (out) => [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
const buildCli = () => execFileSync('pnpm', ['run', 'build:cli'], { cwd: REPO, stdio: 'ignore', timeout: 300000 });
function rigRun(rig) {
  const node = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './scripts/.r2-register.mjs'];
  const argv = rig.kind === 'key' ? [...node, rig.script, rig.arm] : [rig.script];
  const r = spawnSync(process.execPath, argv, { cwd: REPO, encoding: 'utf8', timeout: 300000, env: { ...process.env, KEYKEY_HOME: path.join(BACKUP, 'key-home') } });
  const out = `${r.stdout}\n${r.stderr}`;
  fs.writeFileSync(path.join(BACKUP, `rig-${rig.kind}-${rig.arm ?? ''}-${Date.now()}.log`), out);
  const fails = rig.kind === 'key' ? (r.status === 0 ? [] : [`${rig.arm} ok:false`]) : [...out.matchAll(/^\s*FAIL (.*?)(?: — .*)?$/gm)].map((m) => m[1]);
  return { fails, rc: r.status };
}

// ── CONTROL ──
{
  buildCli();
  const files = [...new Set(MUTANTS.flatMap((m) => m.tests ?? []))];
  const u = unit(files); const red = failedNames(u.stdout);
  console.log(`CONTROL unmutated unit files (${files.length}): ${u.status === 0 && red.length === 0 ? 'GREEN (instrument can pass)' : `RED ${JSON.stringify(red)} — INSTRUMENT BROKEN`}`);
  if (u.status !== 0) process.exit(4);
  if (!noRig) for (const rig of MUTANTS.filter((m) => m.rig).map((m) => m.rig).filter((r, i, a) => a.findIndex((x) => x.script === r.script && x.arm === r.arm) === i)) {
    const g = rigRun(rig);
    console.log(`CONTROL unmutated rig ${rig.script}${rig.arm ? ' ' + rig.arm : ''}: ${g.rc === 0 && g.fails.length === 0 ? 'GREEN' : `RED ${JSON.stringify(g.fails)} rc=${g.rc} — INSTRUMENT BROKEN`}`);
    if (g.rc !== 0) process.exit(4);
  }
}

const results = [];
let cliDirty = false;
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const files = [...new Set(m.edits.map(([f]) => f))];
  const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
  files.forEach((f, i) => fs.copyFileSync(path.join(REPO, f), path.join(BACKUP, `${m.id}-${i}.bak`)));
  let killedBy = [];
  let restored = false;
  try {
    for (const [f, find, to] of m.edits) {
      const p = path.join(REPO, f);
      const src = fs.readFileSync(p, 'utf8');
      if (count(src, find) !== 1) throw new Error(`PATTERN-GONE ${m.id} ${f}`);
      fs.writeFileSync(p, src.replace(find, () => to));
    }
    if (m.cli) { buildCli(); cliDirty = true; }
    if (m.tests?.length) {
      const u = unit(m.tests);
      const red = failedNames(u.stdout);
      if (u.status !== 0 || red.length) killedBy.push(`unit: ${red.length ? red.slice(0, 2).join(' | ') : `rc=${u.status}`}`);
    }
    if (m.rig && !noRig) {
      const g = rigRun(m.rig);
      if (g.rc !== 0 || g.fails.length) killedBy.push(`rig ${m.rig.kind}${m.rig.arm ? ':' + m.rig.arm : ''}: ${g.fails.slice(0, 2).join(' | ') || `rc=${g.rc}`}`);
    }
  } finally {
    files.forEach((f, i) => fs.copyFileSync(path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)));
    restored = files.every((f, i) => sha(f) === before[f] && spawnSync('cmp', ['-s', path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)]).status === 0);
  }
  results.push({ id: m.id, name: m.name, killed: killedBy.length > 0, killedBy, restored });
  console.log(`${killedBy.length ? 'KILLED ' : 'SURVIVED'} ${m.id} ${m.name}${killedBy.length ? `\n         ← ${killedBy.join('\n         ← ')}` : ''}${restored ? '' : '\n         !! RESTORE FAILED'}`);
}
if (cliDirty) buildCli();
const survivors = results.filter((r) => !r.killed);
const unrestored = results.filter((r) => !r.restored);
const diff = spawnSync('git', ['-C', REPO, 'diff', '--stat', '--', ...touched], { encoding: 'utf8' }).stdout.trim();
console.log(`\nMUTANTS: ${results.length - survivors.length}/${results.length} killed; survivors: ${survivors.map((s) => s.id).join(', ') || 'none'}; restore: ${unrestored.length ? 'FAILED ' + unrestored.map((s) => s.id).join(',') : 'all byte-exact'}; git diff on touched files: ${diff || 'empty'}`);
process.exit(survivors.length === 0 && unrestored.length === 0 && !diff ? 0 : 1);
