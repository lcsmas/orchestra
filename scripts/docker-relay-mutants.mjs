// G2 (#291) — in-place mutants for the Docker relay's changed clauses (ledger #295 gate G2). One mutant at a time:
// byte-exact backup → apply → run the arms that must go RED → restore from the backup → `cmp`. A mutant that stays
// GREEN is a gap. Positive control first (the unmutated tree must be GREEN) so a red means the mutant, not a broken base.
//
//   node scripts/docker-relay-mutants.mjs            run everything (HEAVY: a mutation sweep — needs the heavy-rig token)
//   node scripts/docker-relay-mutants.mjs --check    only verify every anchor matches exactly once (no tests run)
//   node scripts/docker-relay-mutants.mjs --rig [ids]  the rig-marked mutants against the REAL-dockerd rig (HEAVY, containers)
//   node scripts/docker-relay-mutants.mjs M5 R3      a subset by id
//
// The real-dockerd rig kills the mutants marked `rig:` too (scripts/e2e-docker-relay.sh); the ids are listed so the
// verifier can re-run them against the rig with KEEPER_JS built from the mutant.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(process.env.SUBJECT_REPO ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const T = {
  shared: 'src/shared/docker-relay.test.ts',
  relay: 'src/keeper/docker-relay.test.ts',
  keeper: 'src/keeper/keeper-docker-relay.test.ts',
  sw: 'src/main/docker-relay-switch.test.ts',
  bus: 'src/shared/bus-switches.test.ts',
  bind: 'src/main/docker-relay-binding.test.ts',
  api: 'src/main/docker-api.test.ts',
};

// [id, file, [[find, replace]...], tests that must go red, note]
const MUTANTS = [
  ['M1', 'src/shared/docker-relay.ts', [['(?:v\\d+(?:\\.\\d+)*\\/)?containers\\/create', 'containers\\/create']], [T.shared], 'create regex drops the /vNN prefix (docker CLI always sends one)'],
  ['M2', 'src/shared/docker-relay.ts', [["stamped = `{${inner}${inner.trim() === '' ? '' : ','}${entries}}`;", "stamped = `{${entries}${inner.trim() === '' ? '' : ','}${inner}}`;"]], [T.shared, T.relay], 'our labels FIRST: a forged client orchestra.ws wins; rig: user_labels'],
  ['M3', 'src/shared/docker-relay.ts', [['export function stampContainerCreateBody(text: string, labels: Record<string, string>): string | null {', 'export function stampContainerCreateBody(text: string, labels: Record<string, string>): string | null {\n  { const o = JSON.parse(text) as Record<string, unknown>; return JSON.stringify({ ...o, Labels: { ...((o.Labels as object) ?? {}), ...labels } }); }']], [T.shared, T.relay], 'parse/stringify round trip corrupts int64s'],
  ['M4', 'src/shared/docker-relay.ts', [["    if (s[j] === '\\\\') j++;\n    else if (s[j] === '\"') return j + 1;", "    if (s[j] === '\"') return j + 1;"]], [T.shared], 'string scan ignores escapes'],
  ['M5', 'src/shared/docker-relay.ts', [["if (!p) return { ok: false, reason: `DOCKER_HOST=${inherited} is not a unix socket` };", "if (!p) return { ok: true, socketPath: '/var/run/docker.sock', via: 'default' };"]], [T.shared, T.keeper], 'a tcp DOCKER_HOST is silently swapped for the local daemon'],
  ['M6', 'src/shared/docker-relay.ts', [['if (args.remote || args.platform', 'if (args.platform']], [T.shared], 'sandbox member gets the relay'],
  ['M7', 'src/shared/docker-relay.ts', [['|| !args.switchOn) return undefined', ') return undefined']], [T.shared, T.sw], 'switch OFF still offers the relay'],
  ['M8', 'src/shared/docker-relay.ts', [["`${keeperSock.slice(0, -'.sock'.length)}.docker.sock`", "`${keeperSock.slice(0, -'.sock'.length)}.docker.pid`"]], [T.shared, T.keeper], 'relay socket named *.pid (listLiveKeepers would read it as a workspace)'],
  ['M9', 'src/shared/docker-relay.ts', [['if (!deps.isSocket(socketPath))', 'if (false as boolean)']], [T.shared, T.keeper], 'relay to a socket that does not exist'],
  ['R1', 'src/keeper/docker-relay.ts', [['if (stamped) body = stamped;', 'if (false as boolean) body = stamped as Buffer;']], [T.relay, T.keeper], 'creates are forwarded unstamped; rig: run_labels'],
  ['R2', 'src/keeper/docker-relay.ts', [["headers['content-length'] = String(body.length);", "headers['content-length'] = String(original.length);"]], [T.relay], 'content-length not recomputed for the stamped body'],
  ['R3', 'src/keeper/docker-relay.ts', [['      res.flushHeaders();\n', '']], [T.relay], 'response headers held until the first body byte'],
  ['R4', 'src/keeper/docker-relay.ts', [["      srv.on('upgrade', onUpgrade);\n", '']], [T.relay], 'hijacked attach/exec unsupported; rig: run_labels(-i), streams'],
  ['R5', 'src/keeper/docker-relay.ts', [['      if (head.length) up.write(head);\n', '']], [T.relay], 'bytes read with the head (exec-start body) are dropped'],
  ['R6', 'src/keeper/docker-relay.ts', [['if (stopped || busy || relay.healthy() || Date.now() < nextTryAt) return;', 'if (true as boolean) return;']], [T.relay, T.keeper], 'nothing restarts a dead relay; rig: kill_relay'],
  ['R7', 'src/keeper/docker-relay.ts', [['process.umask(0o177)', 'process.umask(0o022)'], ['            fs.chmodSync(sockPath, 0o600);\n', '']], [T.relay], 'relay socket world-accessible (full docker access)'],
  ['R8', 'src/keeper/docker-relay.ts', [['        fs.unlinkSync(sockPath); // ours by construction: one keeper per workspace owns this name', '        void 0;']], [T.relay], 'a stale socket file blocks the bind'],
  ['R9', 'src/keeper/docker-relay.ts', [["    up.on('error', (e) => badGateway(res, e));", '']], [T.relay], 'daemon down crashes / hangs the call instead of a 502'],
  ['K1', 'src/keeper/index.ts', [["      klog('docker relay disabled: could not start');\n      return env;", "      klog('docker relay disabled: could not start');\n      return { ...env, DOCKER_HOST: `unix://${relaySocketPath(sockPath)}` };"]], [T.keeper], 'DOCKER_HOST set although the relay cannot start; rig: no_relay_fallback'],
  ['K2', 'src/keeper/index.ts', [['} else if (f.dockerRelay) {', '} else if (f.dockerRelay !== null) {']], [T.keeper], 'relay started even when the switch is OFF (no dockerRelay); rig: switch_off'],
  ['K3', 'src/keeper/index.ts', [['      if (spawnInFlight) {\n        deferredFrames.push(f as KeeperClientFrame);\n        return;\n      }\n', '']], [T.keeper], 'stdin sent behind a relay spawn is dropped'],
  ['K4', 'src/keeper/index.ts', [['  relay?.stop();\n', '']], [T.keeper], 'relay socket left behind when the keeper exits'],
  ['K5', 'src/keeper/index.ts', [["    process.on('SIGUSR2', () => relay?.kill());\n", '']], [T.keeper], 'SIGUSR2 default action kills the keeper; rig: kill_relay'],
  ['K6', 'src/keeper/index.ts', [['resolveRelayUpstream(env, {', 'resolveRelayUpstream(process.env as Record<string, string | undefined>, {']], [T.keeper], 'upstream resolved from the keeper env, not the member env'],
  ['K7', 'src/keeper/index.ts', [["    return { ...env, DOCKER_HOST: `unix://${relaySock}` };", '    return env;']], [T.keeper], 'DOCKER_HOST never set; rig: run_labels'],
  ['R10', 'src/keeper/docker-relay.ts', [["    res.on('close', () => {\n      if (!res.writableFinished) up.destroy();\n    });\n", '']], [T.relay], 'an aborted client leaves its daemon-side connection open (leak)'],
  ['R11', 'src/keeper/docker-relay.ts', [["    client.on('error', end);\n", "    client.on('error', end);\n    client.on('end', end);\n"]], [T.relay], 'a client half-close (CloseWrite) kills the hijack'],
  ['R12', 'src/keeper/docker-relay.ts', [['return boundIno !== null && fs.statSync(sockPath).ino === boundIno;', 'return fs.existsSync(sockPath);']], [T.relay], 'healthy() ignores a replaced socket file'],
  ['R13', 'src/keeper/docker-relay.ts', [['    for (const s of live) s.destroy();\n', '']], [T.relay], 'a killed relay leaves in-flight streams half-alive'],
  ['R14', 'src/keeper/docker-relay.ts', [['http.createServer({ maxHeaderSize: 1 << 20 }, onRequest)', 'http.createServer(onRequest)']], [T.relay], 'node 16 KB header cap: big X-Registry-Config calls fail through the relay'],
  ['R15', 'src/keeper/docker-relay.ts', [["      ur.on('error', () => res.destroy());\n", '']], [T.relay], 'a daemon dying mid-response crashes/hangs instead of aborting the client call'],
  ['K8', 'src/keeper/index.ts', [['function dockerContextHost(env: Record<string, string | undefined>): Promise<string | null> {\n  return new Promise((resolve) => {', 'function dockerContextHost(env: Record<string, string | undefined>): Promise<string | null> {\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);\n  return new Promise((resolve) => {']], [T.keeper], 'a blocking context lookup stops the keeper answering probes'],
  ['M10', 'src/shared/docker-relay.ts', [['const relayShaped = !!inherited && isRelaySocketPath(inherited);', 'const relayShaped = false;']], [T.shared, T.keeper], 'another keeper relay is accepted as the real daemon (stacked relays, labels overwritten)'],
  ['M11', 'src/shared/docker-relay.ts', [["    const ctxEnv = { ...env };\n    delete ctxEnv.DOCKER_HOST;\n", "    const ctxEnv = { ...env };\n"]], [T.shared], 'the context lookup echoes the inherited relay back'],
  ['C1', 'src/main/keeper-client.ts', [['                ...(dockerRelay ? { dockerRelay } : {}),\n', '']], [T.bind], 'facade drops the relay spec; rig: app_switch'],
  ['C2', 'src/main/keeper-client.ts', [["if (!sockLive && (state === 'gone' || state === 'other')) unlink(keeperRelaySocketPath(wsId));", 'if (true as boolean) unlink(keeperRelaySocketPath(wsId));']], [], 'sweep removes a LIVE keeper relay socket; rig: sweep_relay_files'],
  ['B1', 'src/shared/bus-switches.ts', [['dockerRelay: false, // #291', 'dockerRelay: true, // #291']], [T.sw, T.bus], 'default ON'],
  ['B2', 'src/shared/bus-switches.ts', [["  docker_relay: 'dockerRelay', // #291\n", '']], [T.sw, T.bus], 'wire name unknown → every read OFF'],
  ['D1', 'src/main/docker-relay-switch.ts', [['dockerRelayOffer({ remote, platform', 'dockerRelayOffer({ remote: false, platform']], [T.sw], 'sandbox member gets the relay (read side)'],
  ['D2', 'src/main/docker-relay-switch.ts', [["busSwitch(db, runId, 'docker_relay')", "busSwitch(db, runId, 'liveness')"]], [T.sw], 'reads the wrong mechanism'],
  ['W1', 'src/main/agent-sdk.ts', [['}, dockerRelaySpecFor(sdkEnv.ORCHESTRA_RUN_ID, remote)) as never,', '}, undefined) as never,']], [T.bind], 'the session never asks for the relay'],
  ['A1', 'src/main/docker-api.ts', [["path: `/containers/${enc(id)}/stop?t=${timeoutSec}`", "path: `/containers/${enc(id)}/kill?t=${timeoutSec}`"]], [T.api], 'stop becomes kill'],
  ['A2', 'src/main/docker-api.ts', [['if (!isRelaySocketPath(p)) candidates.push(p);', 'candidates.push(p);']], [T.api], 'the app talks to a relay'],
  ['A3', 'src/main/docker-api.ts', [["if (res.status === 304) return 'already-stopped';", "if (res.status === 304) return 'stopped';"]], [T.api], '304 mislabelled'],
  ['A4', 'src/main/docker-api.ts', [['autoRemove: j.HostConfig?.AutoRemove === true,', 'autoRemove: false,']], [T.api], 'AutoRemove ignored (a --rm container would be stopped = deleted)'],
  ['A5', 'src/main/docker-api.ts', [["if (o.labels?.length) filters.label = o.labels;", '']], [T.api], 'label filter dropped (lists every container)'],
];

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.filter((a) => !a.startsWith('--'));
const todo = MUTANTS.filter((m) => !only.length || only.includes(m[0]));

function apply(file, edits) {
  const abs = path.join(REPO, file);
  const orig = fs.readFileSync(abs);
  let text = orig.toString('utf8');
  for (const [find, repl] of edits) {
    const n = text.split(find).length - 1;
    if (n !== 1) return { err: `anchor matched ${n}x (need exactly 1): ${find.slice(0, 80)}` };
    text = text.replace(find, () => repl);
  }
  return { abs, orig, mutated: text };
}

/** One `node --test` run in its OWN process group, SIGKILLed whole at the deadline: a mutant that makes a test HANG must read as
 *  red (`timedOut`), not wedge the sweep on a grandchild that still holds the pipe (spawnSync only kills its direct child). */
function run(tests, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--test', ...tests], { cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
      resolve({ rc: timedOut ? 124 : code, timedOut, pass: num('pass'), fail: num('fail'), skipped: num('skipped'), out });
    });
  });
}

if (checkOnly) {
  let bad = 0;
  for (const [id, file, edits] of todo) {
    const a = apply(file, edits);
    if (a.err) {
      console.log(`${id}: ANCHOR PROBLEM — ${a.err}`);
      bad++;
    } else if (a.mutated === a.orig.toString('utf8')) {
      console.log(`${id}: NO-OP mutant`);
      bad++;
    }
  }
  console.log(bad ? `${bad} bad mutant(s)` : `all ${todo.length} anchors match exactly once and change the file`);
  process.exit(bad ? 1 : 0);
}


// ── --rig: the same mutants against the REAL-dockerd rig (HEAVY: containers). The arm that must go red for each. ──────
const RIG_ARM = { M2: 'user_labels', R1: 'run_labels', R3: 'streams', R4: 'run_labels', R6: 'kill_relay', K1: 'no_relay_fallback', K2: 'switch_off', K5: 'kill_relay', K7: 'run_labels', C1: 'app_switch', C2: 'sweep_relay_files' };
if (args.includes('--rig')) {
  const rigIds = Object.keys(RIG_ARM).filter((id) => !only.length || only.includes(id));
  const rigRun = (arm) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './scripts/.r2-register.mjs', 'scripts/e2e-docker-relay.mjs', arm], { cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SUBJECT_REPO: REPO } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 300000);
      child.on('close', () => { clearTimeout(t); try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ ok: false, checks: [], fatal: 'no JSON from rig' }); } });
    });
  const base = {};
  for (const arm of new Set(rigIds.map((id) => RIG_ARM[id]))) {
    base[arm] = await rigRun(arm);
    console.log(`RIG POSITIVE CONTROL ${arm}: ok=${base[arm].ok} (${base[arm].checks.length} checks)`);
    if (!base[arm].ok) { console.log('rig arm not green on the unmutated tree — refusing'); process.exit(2); }
  }
  let alive = 0;
  for (const id of rigIds) {
    const [, file, edits, , note] = MUTANTS.find((m) => m[0] === id);
    const a = apply(file, edits);
    if (a.err) { console.log(`${id}: ${a.err}`); alive++; continue; }
    let r;
    try {
      fs.writeFileSync(a.abs, a.mutated);
      r = await rigRun(RIG_ARM[id]);
    } finally {
      fs.writeFileSync(a.abs, a.orig);
      if (!fs.readFileSync(a.abs).equals(a.orig)) throw new Error(`RESTORE MISMATCH for ${file}`);
    }
    const red = (r.checks ?? []).filter((c) => !c.ok && !/bystander|every rig container/.test(c.name)).map((c) => c.name.slice(0, 60));
    const killed = r.ok === false && (red.length > 0 || r.fatal);
    if (!killed) alive++;
    console.log(`${id.padEnd(3)} ${killed ? 'KILLED  ' : 'SURVIVED'} rig:${RIG_ARM[id]}  red: ${red.slice(0, 2).join(' | ') || r.fatal || '-'}  — ${note}`);
  }
  execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
  console.log(`rig mutants: ${rigIds.length - alive} killed / ${rigIds.length}`);
  process.exit(alive ? 1 : 0);
}

const allTests = [...new Set(MUTANTS.flatMap((m) => m[3]))];
const base = await run(allTests, 240000);
console.log(`POSITIVE CONTROL (unmutated): rc=${base.rc} pass=${base.pass} fail=${base.fail} skipped=${base.skipped}`);
if (base.rc !== 0 || base.skipped !== 0) {
  console.log('base is not green — refusing to judge mutants');
  process.exit(2);
}

const results = [];
for (const [id, file, edits, tests, note] of todo) {
  const a = apply(file, edits);
  if (a.err) {
    results.push({ id, file, verdict: 'ANCHOR-ERROR', detail: a.err });
    continue;
  }
  let verdict;
  let detail = '';
  try {
    fs.writeFileSync(a.abs, a.mutated);
    if (tests.length === 0) {
      verdict = 'RIG-ONLY';
      detail = 'killed by the real-dockerd rig, not a unit test';
    } else {
      const r = await run(tests);
      verdict = r.rc !== 0 ? 'KILLED' : 'SURVIVED';
      detail = `rc=${r.rc}${r.timedOut ? ' (HUNG→killed)' : ''} pass=${r.pass} fail=${r.fail}`;
    }
  } finally {
    fs.writeFileSync(a.abs, a.orig); // byte-exact restore …
    const back = fs.readFileSync(a.abs);
    if (!back.equals(a.orig)) throw new Error(`RESTORE MISMATCH for ${file} (${sha(back)} != ${sha(a.orig)})`); // … proven by comparison
  }
  results.push({ id, file, verdict, detail, note });
  console.log(`${id.padEnd(3)} ${verdict.padEnd(9)} ${detail.padEnd(24)} ${file}  — ${note}`);
}
// leave the keeper bundle built from the RESTORED sources
execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
const survived = results.filter((r) => r.verdict === 'SURVIVED' || r.verdict === 'ANCHOR-ERROR');
console.log(`\n${results.filter((r) => r.verdict === 'KILLED').length} killed · ${results.filter((r) => r.verdict === 'RIG-ONLY').length} rig-only · ${survived.length} survived/errored of ${results.length}`);
const post = await run(allTests, 240000);
console.log(`POST-RESTORE (tree back to base): rc=${post.rc} pass=${post.pass} fail=${post.fail} skipped=${post.skipped}; git diff of mutated files must be empty`);
process.exit(survived.length || post.rc !== 0 ? 1 : 0);
