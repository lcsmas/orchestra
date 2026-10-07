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
  endpoint: 'src/shared/docker-endpoint.test.ts',
  pc: 'src/main/pause-containers.test.ts',
  ptc: 'src/main/pause-trap-containers.test.ts',
  pcr: 'src/main/pause-containers-reprise.test.ts',
  psh: 'src/shared/pause-containers.test.ts',
  pcw: 'src/main/pause-containers-wiring.test.ts',
  rs: 'src/cli/run-status.test.ts',
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
  ['M9', 'src/shared/docker-relay.ts', [["if (kind === 'other') return", 'if (false as boolean) return']], [T.shared], 'something that is not a socket (a regular file) is accepted as the daemon'],
  ['R1', 'src/keeper/docker-relay.ts', [['if (stamped) body = stamped;', 'if (false as boolean) body = stamped as Buffer;']], [T.relay, T.keeper], 'creates are forwarded unstamped; rig: run_labels'],
  ['R2', 'src/keeper/docker-relay.ts', [["headers['content-length'] = String(body.length);", "headers['content-length'] = String(original.length);"]], [T.relay], 'content-length not recomputed for the stamped body'],
  ['R3', 'src/keeper/docker-relay.ts', [['      res.flushHeaders();\n', '']], [T.relay], 'response headers held until the first body byte'],
  ['R4', 'src/keeper/docker-relay.ts', [["      srv.on('upgrade', onUpgrade);\n", '']], [T.relay], 'hijacked attach/exec unsupported; rig: run_labels(-i), streams'],
  ['R5', 'src/keeper/docker-relay.ts', [['      if (head.length) up.write(head);\n', '']], [T.relay], 'bytes read with the head (exec-start body) are dropped'],
  ['R6', 'src/keeper/docker-relay.ts', [['if (stopped || busy || relay.healthy() || Date.now() < nextTryAt) return;', 'if (true as boolean) return;']], [T.relay, T.keeper], 'nothing restarts a dead relay; rig: kill_relay'],
  ['R7', 'src/keeper/docker-relay.ts', [['process.umask(0o177)', 'process.umask(0o022)'], ['            fs.chmodSync(sockPath, 0o600);\n', '']], [T.relay], 'relay socket world-accessible (full docker access)'],
  ['R8', 'src/keeper/docker-relay.ts', [['        fs.unlinkSync(sockPath); // ours by construction: one keeper per workspace owns this name', '        void 0;']], [T.relay], 'a stale socket file blocks the bind'],
  ['R9', 'src/keeper/docker-relay.ts', [["    up.on('error', (e) => badGateway(req, res, e));", '']], [T.relay], 'daemon down crashes / hangs the call instead of a 502'],
  ['R17', 'src/keeper/docker-relay.ts', [["'content-length': Buffer.byteLength(body), connection: 'close' });", "'content-length': Buffer.byteLength(body) });"]], [T.relay], 'the 502 does not announce Connection: close'],
  ['K1', 'src/keeper/index.ts', [["      klog('docker relay disabled: could not start');\n      return env;", "      klog('docker relay disabled: could not start');\n      return { ...env, DOCKER_HOST: `unix://${relaySocketPath(sockPath)}` };"]], [T.keeper], 'DOCKER_HOST set although the relay cannot start; rig: no_relay_fallback'],
  ['K2', 'src/keeper/index.ts', [['} else if (f.dockerRelay) {', '} else if (f.dockerRelay !== null) {']], [T.keeper], 'relay started even when the switch is OFF (no dockerRelay); rig: switch_off'],
  ['K3', 'src/keeper/index.ts', [['      if (spawnInFlight) {\n        deferredFrames.push(f as KeeperClientFrame);\n        return;\n      }\n', '']], [T.keeper], 'stdin sent behind a relay spawn is dropped'],
  ['K4', 'src/keeper/index.ts', [["  if (relay) {\n    relay.stop();\n", "  if (relay) {\n"]], [T.keeper], 'relay socket left behind when the keeper exits'],
  ['K5', 'src/keeper/index.ts', [["    process.on('SIGUSR2', () => relay?.kill());\n", '']], [T.keeper], 'SIGUSR2 default action kills the keeper; rig: kill_relay'],
  ['K6', 'src/keeper/index.ts', [['resolveRelayUpstream(env, realUpstreamDeps)', 'resolveRelayUpstream(process.env as Record<string, string | undefined>, realUpstreamDeps)']], [T.keeper], 'upstream resolved from the keeper env, not the member env'],
  ['K7', 'src/keeper/index.ts', [["    return { ...env, DOCKER_HOST: `unix://${relaySock}` };", '    return env;']], [T.keeper], 'DOCKER_HOST never set; rig: run_labels'],
  ['R10', 'src/keeper/docker-relay.ts', [["    res.on('close', () => {\n      if (!res.writableFinished) up.destroy();\n    });\n", '']], [T.relay], 'an aborted client leaves its daemon-side connection open (leak)'],
  ['R11', 'src/keeper/docker-relay.ts', [["    client.on('error', end);\n", "    client.on('error', end);\n    client.on('end', end);\n"]], [T.relay], 'a client half-close (CloseWrite) kills the hijack'],
  ['R12', 'src/keeper/docker-relay.ts', [['return boundIno !== null && fs.statSync(sockPath).ino === boundIno;', 'return fs.existsSync(sockPath);']], [T.relay], 'healthy() ignores a replaced socket file'],
  ['R13', 'src/keeper/docker-relay.ts', [['    for (const s of live) s.destroy();\n', '']], [T.relay], 'a killed relay leaves in-flight streams half-alive'],
  ['R14', 'src/keeper/docker-relay.ts', [['http.createServer({ maxHeaderSize: 1 << 20 }, onRequest)', 'http.createServer(onRequest)']], [T.relay], 'node 16 KB header cap: big X-Registry-Config calls fail through the relay'],
  ['R15', 'src/keeper/docker-relay.ts', [["      ur.on('error', () => res.destroy());\n", '']], [T.relay], 'a daemon dying mid-response crashes/hangs instead of aborting the client call'],
  ['K8', 'src/shared/docker-endpoint.ts', [['export function dockerContextHostViaCli(env: Record<string, string | undefined>): Promise<string | null> {\n  return new Promise((resolve) => {', 'export function dockerContextHostViaCli(env: Record<string, string | undefined>): Promise<string | null> {\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);\n  return new Promise((resolve) => {']], [T.keeper], 'a blocking context lookup stops the keeper answering probes'],
  ['M10', 'src/shared/docker-relay.ts', [['const relayShaped = !!inherited && isRelaySocketPath(inherited);', 'const relayShaped = false;']], [T.shared, T.keeper, T.api], 'another keeper relay is accepted as the real daemon (stacked relays, labels overwritten)'],
  ['M11', 'src/shared/docker-relay.ts', [["    const ctxEnv = { ...env };\n    delete ctxEnv.DOCKER_HOST;\n", "    const ctxEnv = { ...env };\n"]], [T.shared], 'the context lookup echoes the inherited relay back'],
  ['K9', 'src/keeper/index.ts', [["    return { ...env, DOCKER_HOST: `unix://${relaySock}` };", "    return { DOCKER_HOST: `unix://${relaySock}`, ...env };"]], [T.keeper], 'F1: the member\'s own unix DOCKER_HOST beats the relay → silently unattributed; rig: run_labels is blind (clean env) — unit only'],
  ['M12', 'src/shared/docker-relay.ts', [["if (kind === 'other') return", "if (kind !== 'socket') return"]], [T.shared, T.keeper], 'F4: a daemon that is not up YET refuses the relay for the keeper\'s whole life; rig: late_daemon'],
  ['A6', 'src/main/docker-api.ts', [["const r = await resolveRelayUpstream(env, deps);", "const r = await resolveRelayUpstream({ ...env, ORCHESTRA_DOCKER_SOCKET: undefined }, deps);"]], [T.api], 'F2: the app ignores ORCHESTRA_DOCKER_SOCKET (relay stamps daemon A, Pause asks daemon B)'],
  ['A7', 'src/main/docker-api.ts', [["const r = await resolveRelayUpstream(env, deps);", "const r = await resolveRelayUpstream(env, { ...deps, dockerContextHost: () => null });"]], [T.api], 'F2: the app ignores the docker context'],
  ['A8', 'src/main/docker-api.ts', [["resolveRelayUpstream(opts.env ?? process.env, opts.deps ?? realUpstreamDeps)", "resolveRelayUpstream(process.env, opts.deps ?? realUpstreamDeps)"]], [T.api], 'F2: injected env ignored'],
  ['A9', 'src/main/docker-api.ts', [["resolveRelayUpstream(opts.env ?? process.env, opts.deps ?? realUpstreamDeps)", "resolveRelayUpstream({ ...(opts.env ?? process.env), ORCHESTRA_DOCKER_SOCKET: undefined }, opts.deps ?? realUpstreamDeps)"]], [T.api], 'F2: the DEFAULT client ignores ORCHESTRA_DOCKER_SOCKET (relay stamps daemon A, Pause asks B); rig: api_real'],
  ['E1', 'src/shared/docker-endpoint.ts', [["=== 'ENOENT' ? 'missing' : 'other'", "=== 'ENOENT' ? 'other' : 'other'"]], [T.endpoint], 'F4: a missing socket reads as "in the way"'],
  ['E2', 'src/shared/docker-endpoint.ts', [["return fs.statSync(p).isSocket() ? 'socket' : 'other';", "return fs.statSync(p).isSocket() || true ? 'socket' : 'other';"]], [T.endpoint], 'a regular file is accepted as the daemon socket'],
  ['E3', 'src/shared/docker-endpoint.ts', [["(err, stdout) => resolve(err ? null : String(stdout).trim() || null),", "(err, stdout) => resolve(String(stdout).trim() || null),"]], [T.endpoint], 'a failing docker CLI still answers'],
  ['S1', 'src/keeper/index.ts', [["    publishUpstream(up.socketPath);\n", '']], [T.keeper], 'the keeper never publishes which daemon its relay stamps on (Pause could query another one)'],
  ['S2', 'src/keeper/index.ts', [["  if (relay) {\n    relay.stop();\n    try {\n      fs.unlinkSync(relayUpstreamFile(sockPath));", "  if (relay) {\n    relay.stop();\n    try {\n      void relayUpstreamFile;"]], [T.keeper], 'the published upstream outlives its keeper'],
  ['S3', 'src/main/docker-api.ts', [["return p.startsWith('/') && !isRelaySocketPath(p) ? p : null;", "return p.startsWith('/') ? p : null;"]], [T.api], 'a published upstream that is itself a relay is believed'],
  ['S4', 'src/shared/docker-relay.ts', [["if (kind === 'missing' && via === 'default') return", "if (false as boolean && via === 'default') return"]], [T.shared], 'a guessed default path nobody listens on pins DOCKER_HOST to a relay that never answers'],
  ['S5', 'src/shared/docker-relay.ts', [["  if (isRelaySocketPath(socketPath)) return { ok: false, reason: `upstream ${socketPath} (${via}) is a keeper relay socket, not a daemon` };\n", '']], [T.shared], 'an explicit override / docker context naming a relay is forwarded to (stacked relays)'],
  ['S6', 'src/main/docker-api.ts', [["        if (e instanceof DockerApiError && e.kind === 'unavailable') cache = null;", "        if (e instanceof DockerApiError && e.kind === 'unavailable') void 0;"]], [T.api], 'a dead resolved socket is trusted for a minute (stale after a context switch)'],
  ['S7', 'src/main/docker-api.ts', [["    inflight ??= resolveRelayUpstream(", "    inflight = resolveRelayUpstream("]], [T.api], 'N concurrent callers spawn N `docker context inspect`'],
  ['S8', 'src/main/docker-api.ts', [["const stable = r.ok && r.daemonUp && r.via !== 'default';", "const stable = true;"]], [T.api], 'a no-daemon-yet / guessed resolution is cached for a minute'],
  // ── #292 (G8): a Pause dure stops the attributed containers, the Reprise restarts exactly those ──
  ['P1', 'src/main/pause-containers.ts', [["labels: [attributedLabelFilter(wsId)], status: STOPPABLE_STATES", "status: STOPPABLE_STATES"]], [T.pc, T.ptc, T.pcw], 'selection without the label: EVERY running container is stopped (the human\'s stack too); rig: pause_and_reprise'],
  ['P2', 'src/main/pause-containers.ts', [["    if (row.labels[DOCKER_LABEL_WS] !== wsId) continue;\n", '']], [T.pc, T.pcw], 'the label is not re-asserted before a destructive act'],
  ['P3', 'src/main/pause-containers.ts', [["labels: [attributedLabelFilter(wsId)], status: STOPPABLE_STATES", "labels: [attributedLabelFilter(wsId)]"]], [T.pc, T.pcw], 'stopped/exited containers are listed and "stopped" too'],
  ['P4', 'src/main/pause-containers.ts', [['else if (insp.autoRemove)', 'else if (false as boolean)']], [T.pc, T.ptc], 'a --rm container is stopped = DELETED; rig: autoremove_and_failed'],
  ['P5', 'src/main/pause-containers.ts', [['export const STOP_TIMEOUT_SEC = 10;', 'export const STOP_TIMEOUT_SEC = 0;']], [T.pc], 'stop timeout is not t=10 (SIGKILL at once: a DB loses its flush)'],
  ['P6', 'src/main/pause-containers.ts', [["entry = r === 'stopped' ? { ...base, outcome: 'stopped', atMs: o.now() } : null;", "entry = { ...base, outcome: 'stopped', atMs: o.now() };"]], [T.pc], 'a container someone ELSE stopped (or removed) is recorded as ours and restarted by the Reprise'],
  ['P7', 'src/main/pause-containers.ts', [["    if (!o.stillPaused()) return { containers: acc, lifted: true, stoppedNow };\n", '']], [T.pc, T.ptc], 'containers keep being stopped after the Reprise began'],
  ['P8', 'src/main/pause-containers.ts', [["      entry = down ? { ...base, outcome: 'stopped', atMs: o.now() } : { ...base, outcome: 'failed', error: errText(e), atMs: o.now() };", '      entry = down ? { ...base, outcome: \'stopped\', atMs: o.now() } : null;']], [T.pc, T.ptc], 'a failed stop is not recorded'],
  ['P9', 'src/main/pause-containers.ts', [["    if (acc.stopped.some((s) => s.id === row.id && s.outcome !== 'failed' && s.outcome !== 'stopping')) continue;\n", '']], [T.pc], 'a trap retry handles the same container twice'],
  ['P10', 'src/main/pause-containers.ts', [["      o.onProgress?.(acc); // durable at once: a Reprise reading the Bilan mid-trap must see what is already stopped\n", '']], [T.pc], 'stops are not persisted until the end'],
  ['P11', 'src/main/pause-trap.ts', [["        const restarted = await restartContainers(dockerApi, mine, deps.now);\n", "        const restarted: Awaited<ReturnType<typeof restartContainers>> = [];\n"]], [T.ptc], 'a lift mid-stop leaves what this attempt stopped STOPPED'],
  ['P12', 'src/main/pause-trap.ts', [["      const c = activity.containers || fresh?.activity?.containers ? mergeContainers(fresh?.activity?.containers, activity.containers ?? (dockerStepRan ? { stopped: [] } : undefined)) : undefined;", "      const c = activity.containers;"]], [T.ptc], 'the final Bilan write ignores what a concurrent writer recorded on the row'],
  ['P13', 'src/main/pause-trap.ts', [['  if (dockerApi) {\n    let liftedDuringStop = false;', '  if (false as boolean && dockerApi) {\n    let liftedDuringStop = false;']], [T.ptc, T.pcw], 'the Docker step never runs'],
  ['P14', 'src/main/pause-trap.ts', [["    if (prior.containers) activity.containers = prior.containers; // #292: a retry merges BY ID — never stops a container twice\n", '']], [T.ptc], 'a retry forgets what the first attempt stopped'],
  ['Q1', 'src/main/pause-reprise.ts', [['if (containersOwed(db, carrierRunId)) deferCoordinatorRelease(db, carrierRunId, pausedAt, by);', 'if (false as boolean) deferCoordinatorRelease(db, carrierRunId, pausedAt, by);']], [T.pcr, T.pcw], 'the Reprise releases the coordinators BEFORE the containers are back; rig: pause_and_reprise'],
  ['Q2', 'src/main/pause-reprise.ts', [['            if (!owed) {\n              const bilanned', '            if (true as boolean) {\n              const bilanned']], [T.pcr], 'the late pass opens a parked coordinator while a restart is owed'],
  ['Q3', 'src/main/pause-reprise.ts', [['if (!owed && parked) releaseCoordinators(db, c.id, cur, subtree, Date.now(), (r) => parked.wsIds.has(r.wsId.toLowerCase()), parked.by);', 'if (!owed && parked) releaseCoordinators(db, c.id, cur, subtree, Date.now(), (r) => parked.wsIds.has(r.wsId.toLowerCase()));']], [T.pcr], 'the parked release forgets who releases (a HUMAN Reprise becomes the host\'s)'],
  ['Q4', 'src/main/pause-reprise.ts', [['return !ancestorPauseStands(db, carrierRunId) && owedRowsUnder(db, carrierRunId).length > 0;', 'return false;']], [T.pcr], 'a Reprise never knows containers are owed'],
  ['Q5', 'src/shared/pause-containers.ts', [['return c.stopped.filter((s) => (s.outcome === \'stopped\' || s.outcome === \'stopping\') && !done.has(s.id));', 'return c.stopped.filter((s) => !done.has(s.id));']], [T.psh, T.pcr], 'the Reprise restarts --rm / failed entries too (not EXACTLY the stopped ones)'],
  ['Q6', 'src/shared/pause-containers.ts', [["return c.stopped.filter((s) => (s.outcome === 'stopped' || s.outcome === 'stopping') && !done.has(s.id));", "return c.stopped.filter((s) => s.outcome === 'stopped' || s.outcome === 'stopping');"]], [T.psh, T.pcr], 'restarted containers are restarted again (not idempotent)'],
  ['Q7', 'src/main/pause-containers.ts', [["        updateBilanContainers(db, row.carrier, row.wsId, row.pausedAt, (cur) => ({ stopped: cur?.stopped ?? [], restarted: mergeRestarted(cur?.restarted, mine), ...(cur?.error ? { error: cur.error } : {}) }));\n", '']], [T.pcr], 'restart results are not recorded in the Bilan'],
  ['Q8', 'src/shared/pause-consigne.ts', [["  for (const l of containerConsigneLines(c.containers, stripControl)) out.push(l);\n", '']], [T.pcr], 'the Consigne never tells the member about its containers'],
  ['Q9', 'src/main/pause-trap.ts', [["    await restartOwedContainers({ getBus: deps.getBus, api: deps.containers ?? null, ...(deps.containersFor ? { apiFor: deps.containersFor } : {}), now: deps.now, warn: (m, e) => log.warn(m, e) });", "    void restartOwedContainers;"]], [T.pcw], 'the sweep never restarts the containers'],
  ['Q10', 'src/main/pause-trap-host.ts', [["    containers: appDocker,\n", '']], [T.pcw], 'the host gives the trap no Docker client'],
  ['Q11', 'src/shared/pause-containers.ts', [["    if (!had || had.outcome === 'failed' || had.outcome === 'stopping') out.set(e.id, e);", "    out.set(e.id, e);"]], [T.psh], 'a retry overwrites an earlier stopped entry (then the Reprise cannot tell what the FIRST attempt stopped)'],
  ['P15', 'src/main/pause-containers.ts', [["  return e instanceof DockerApiError && e.kind === 'unavailable' && /no Docker socket found|ENOENT/.test(e.message);", "  return false;"]], [T.pc, T.ptc], 'a host with NO Docker alarms every member on every Pause'],
  ['P16', 'src/main/pause-containers.ts', [["        down = now !== null && !now.running;", "        down = false;"]], [T.pc], 'a stop that errored after taking effect is recorded failed (the container stays down, never restarted)'],
  ['P17', 'src/main/pause-containers.ts', [["    if (acc.stopped.length >= MAX_CONTAINER_ENTRIES) {", "    if (false as boolean) {"]], [T.pc], 'past the Bilan cap containers are stopped but unrecorded (never restarted)'],
  ['P18', 'src/main/pause-containers.ts', [["export const STOPPABLE_STATES = ['running', 'restarting'];", "export const STOPPABLE_STATES = ['running'];"]], [T.pc, T.pcw], 'a crash-looping container keeps running under a Pause'],
  ['P19', 'src/main/pause-trap.ts', [["      activity.containers = hasContainerFacts(res.containers) ? res.containers : undefined;", "      activity.containers = res.containers;"]], [T.ptc], 'every member\'s Bilan row grows an empty containers object'],
  ['P20', 'src/main/pause-trap.ts', [["      const merged = mergeContainers(rowNow?.activity?.containers, activity.containers);", "      const merged = activity.containers;"]], [T.ptc], 'a lift mid-stop overwrites the Reprise\'s restart results'],
  ['P21', 'src/main/pause-trap.ts', [["mergeContainers(fresh?.activity?.containers, activity.containers ?? (dockerStepRan ? { stopped: [] } : undefined))", "mergeContainers(activity.containers ?? (dockerStepRan ? { stopped: [] } : undefined), fresh?.activity?.containers)"]], [T.ptc], 'a later attempt inherits the earlier attempt\'s stale Docker error'],
  ['P22', 'src/main/pause-trap.ts', [["activity.containers ?? (dockerStepRan ? { stopped: [] } : undefined)", "activity.containers ?? undefined"]], [T.ptc], 'a clean attempt that found nothing leaves the earlier attempt\'s Docker error on the row'],
  ['Q12', 'src/main/pause-reprise.ts', [["    if (containersOwed(db, carrierRunId)) return false;\n    const left = db", "    const left = db"]], [T.pcr, T.pcw], 'the run goes ACTIVE over containers still owed a restart (early releases)'],
  ['Q13', 'src/main/pause-reprise.ts', [["FROM pause_records WHERE run_id = ? ORDER BY id').all(carrierRunId) as Array<{ ws_id: string; paused_at: number; activity: string | null }>;", "FROM pause_records WHERE run_id = ? AND paused_at = (SELECT MAX(paused_at) FROM pause_records p2 WHERE p2.run_id = pause_records.run_id) ORDER BY id').all(carrierRunId) as Array<{ ws_id: string; paused_at: number; activity: string | null }>;"]], [T.pcr], 'a re-Pause orphans the earlier epoch\'s stopped containers'],
  ['Q14', 'src/main/pause-containers.ts', [["      for (const { entry, wsId } of ordered) {", "      for (const { entry, wsId } of owing.flatMap((r) => r.owed.map((e) => ({ entry: e, wsId: r.wsId })))) {"]], [T.pcr], 'a container owed by two epochs is started twice'],
  ['Q15', 'src/main/pause-containers.ts', [["for (let attempt = 0; attempt < 2 && !done; attempt++) {", "for (let attempt = 0; attempt < 1 && !done; attempt++) {"]], [T.pc], 'a transient start error is never retried'],
  ['Q16', 'src/main/pause-containers.ts', [["    if (o.deadlineAt !== undefined && now() >= o.deadlineAt) {", "    if (false as boolean) {"]], [T.pc], 'a hung daemon keeps the coordinators parked for ever'],
  ['Q17', 'src/main/pause-trap.ts', [["  const dockerApi = deps.containersFor?.(m.wsId) ?? deps.containers ?? null;", "  const dockerApi = deps.containers ?? null;"]], [T.ptc], 'Pause queries the app\'s own daemon, not the one the member\'s relay stamps on (silent 0 attributed after a context switch)'],
  ['Q18', 'src/main/pause-containers.ts', [["        const api = deps.apiFor?.(wsId) ?? deps.api;", "        const api = deps.api;"]], [T.pcr], 'the Reprise restarts on the app\'s daemon: 404 \"gone\" while the containers sit stopped on the member\'s'],
  ['Q19', 'src/main/pause-trap-host.ts', [["    containersFor: (wsId) => dockerApiForMember(keeperSocketPath(wsId), appDocker),\n", '']], [T.pcw], 'the host never gives the trap the per-member client'],
  // G8 follow-up (review c/6040145027 #1–#4): re-Pause mid-step, nested Pauses, write-ahead `stopping`, restart order
  ['Q20', 'src/main/pause-containers.ts', [["        if (!stillResuming()) break; // the rest stays OWED, no result recorded\n", '']], [T.pcr], 'a re-Pause mid-step still reaches the next member: with no client for it the unattempted restart is recorded `failed` (lost for good)'],
  ['Q21', 'src/main/pause-containers.ts', [["    if (o.stillResuming && !o.stillResuming()) break;\n", '']], [T.pc], 'restartContainers keeps starting containers after a re-Pause'],
  ['Q22', 'src/main/pause-containers.ts', [["return !!cols && cols.pausedAt === Number(c.paused_at) && cols.resumeStartedAt !== null;", "return !!cols;"]], [T.pcr], 'the step never notices the epoch it serves is over'],
  ['Q23', 'src/main/pause-containers.ts', [["      if (ancestorPauseStands(db, c.id)) continue;\n", '']], [T.pcr], 'a child\'s Reprise restarts containers while an ancestor Pause still stands'],
  ['Q24', 'src/main/pause-reprise.ts', [["return !ancestorPauseStands(db, carrierRunId) && owedRowsUnder(db, carrierRunId).length > 0;", "return owedRowsUnder(db, carrierRunId).length > 0;"]], [T.pcr], 'a child under a standing ancestor Pause parks/holds its Reprise for a restart that cannot happen'],
  ['Q25', 'src/main/pause-reprise.ts', [["return [carrierRunId, ...liftedDescendantCarriers(db, carrierRunId)].flatMap((id) => owedRows(db, id));", "return [carrierRunId].flatMap((id) => owedRows(db, id));"]], [T.pcr], 'the ancestor\'s Reprise never restarts what its already-resumed child deferred (stopped for good)'],
  ['Q26', 'src/main/pause-containers.ts', [["        acc = { ...acc, stopped: mergeStopped(acc.stopped, [{ ...base, outcome: 'stopping', atMs: o.now() }]) };\n        o.onProgress?.(acc);\n", '']], [T.pc], 'no write-ahead entry: an app killed mid-stop leaves a stopped container the Bilan never mentions'],
  ['Q27', 'src/shared/pause-containers.ts', [["(s.outcome === 'stopped' || s.outcome === 'stopping') && !done.has(s.id)", "s.outcome === 'stopped' && !done.has(s.id)"]], [T.psh, T.pcr], 'a `stopping` leftover is not owed a restart'],
  ['Q28', 'src/main/pause-containers.ts', [["s.outcome !== 'failed' && s.outcome !== 'stopping')) continue;", "s.outcome !== 'failed')) continue;"]], [T.pc], 'a retry skips a container left `stopping` (still running) and never stops it'],
  ['Q29', 'src/shared/pause-containers.ts', [["if (!had || had.outcome === 'failed' || had.outcome === 'stopping') out.set(e.id, e);", "if (!had || had.outcome === 'failed') out.set(e.id, e);"]], [T.psh], 'the final outcome never replaces the write-ahead marker'],
  ['Q30', 'src/shared/pause-containers.ts', [[".sort((a, b) => b[0].atMs - a[0].atMs || b[1] - a[1])", ".sort((a, b) => a[0].atMs - b[0].atMs || a[1] - b[1])"]], [T.psh, T.pcr], 'restart in the STOP order (a fail-fast dependent starts before what it needs)'],
  ['Q31', 'src/shared/pause-containers.ts', [["b[0].atMs - a[0].atMs || b[1] - a[1])", "b[0].atMs - a[0].atMs || a[1] - b[1])"]], [T.psh], 'equal-timestamp stops restart in the stop order'],
  ['Q32', 'src/main/pause-containers.ts', [["    } else if (acc.stopped.some((s) => s.id === row.id && s.outcome === 'stopping')) {", "    } else if (false as boolean) {"]], [T.pc], 'a container someone else stopped keeps our write-ahead marker: the Reprise starts what the Pause never stopped'],
  ['Q33', 'src/cli/run-status.ts', [["const stopped = ct.stopped.filter((x) => x.outcome === 'stopped' || x.outcome === 'stopping');", "const stopped = ct.stopped.filter((x) => x.outcome === 'stopped');"]], [T.rs], '`run status` hides a `stopping` leftover the Reprise will restart'],
  ['Q34', 'src/main/pause-containers.ts', [["restarted: mergeRestarted(cur?.restarted, mine), ...(cur?.error ? { error: cur.error } : {}) }));", "restarted: mine, ...(cur?.error ? { error: cur.error } : {}) }));"]], [T.pcr], 'a later restart step overwrites the earlier step\'s results on the row (F2-Z16: the first results are lost)'],
  // G8-fu fix round 2 (review c/6041532780): the persisted Bilan must lose a removed write-ahead marker; one live-first ancestor walk for the deferral AND its collection
  ['Q35', 'src/shared/pause-containers.ts', [["  const baseStopped = overlayIds ? base?.stopped.filter((e) => e.outcome !== 'stopping' || overlayIds.has(e.id)) : base?.stopped;", "  const baseStopped = base?.stopped;"]], [T.psh, T.ptc], 'a removed write-ahead marker stays on the persisted Bilan: the Reprise starts the human\'s own container'],
  ['Q36', 'src/shared/pause-containers.ts', [["e.outcome !== 'stopping' || overlayIds.has(e.id))", "overlayIds.has(e.id))"]], [T.psh], 'the overlay drops stopped / failed entries too (not only a stopping marker)'],
  ['Q37', 'src/main/pause-reprise.ts', [["  if (tree && tree.get(runId)) {\n    const chain = liveChainInfo(tree, runId);", "  if (false as boolean && tree && tree.get(runId)) {\n    const chain = liveChainInfo(tree, runId);"]], [T.pcr], 'the deferral / collection walk only the bus run tree: re-parented runs never restart their containers'],
  ['Q38', 'src/main/pause-reprise.ts', [["    if (readCarrierColumns(db, id)?.pausedAt != null) continue; // paused or resuming: its own step\n", ""]], [T.pcr], 'an ancestor\'s Reprise collects the containers of a child still under its OWN Pause'],
  ['Q39', 'src/main/pause-reprise.ts', [["    if (chain.slice(0, at).some((mid) => readCarrierColumns(db, mid)?.pausedAt != null)) continue; // a nearer carrier (paused / resuming) covers it\n", ""]], [T.pcr], 'an ancestor\'s Reprise collects a grand-child covered by a nearer paused carrier'],
  ['Q40', 'src/main/pause-reprise.ts', [["    const at = chain.indexOf(carrierRunId);\n    if (at < 0) continue; // not below this carrier\n", "    const at = Math.max(0, chain.indexOf(carrierRunId));\n"]], [T.pcr], 'every lifted run on the host is collected by every carrier (not only the descendants)'],
  // seat 1 interim c/6041588606: W4/W5/W6 (nested-Pause guard gaps) + P10 (progress assertion)
  ['Q41', 'src/main/pause-reprise.ts', [["    if (getRun(db, id)?.flags.pause !== true) continue; // a run with the switch OFF carries no pause (a stale column is inert)\n", ""]], [T.pcr], 'a switch-OFF ancestor with a stale paused column defers its child for ever'],
  ['Q42', 'src/main/pause-reprise.ts', [["    live = !chain.dangling;\n  }\n  if (!live) {\n    const seen = new Set<string>([runId, ...ids]);", "    live = true;\n  }\n  if (!live) {\n    const seen = new Set<string>([runId, ...ids]);"]], [T.pcr], 'a dangling live chain never falls back to the bus run tree'],
  ['Q43', 'src/main/pause-reprise.ts', [["  if (!live) {\n    const seen = new Set<string>([runId, ...ids]);", "  if (false as boolean) {\n    const seen = new Set<string>([runId, ...ids]);"]], [T.pcr], 'no live tree ⇒ no ancestors at all (the bus run tree is never read)'],
  ['C1', 'src/main/keeper-client.ts', [['                ...(dockerRelay ? { dockerRelay } : {}),\n', '']], [T.bind], 'facade drops the relay spec; rig: app_switch'],
  ['C2', 'src/main/keeper-client.ts', [["if (!sockLive && (state === 'gone' || state === 'other')) {\n    unlink(keeperRelaySocketPath(wsId));", "if (true as boolean) {\n    unlink(keeperRelaySocketPath(wsId));"]], [], 'sweep removes a LIVE keeper relay socket; rig: sweep_relay_files'],
  ['B1', 'src/shared/bus-switches.ts', [['dockerRelay: false, // #291', 'dockerRelay: true, // #291']], [T.sw, T.bus], 'default ON'],
  ['B2', 'src/shared/bus-switches.ts', [["  docker_relay: 'dockerRelay', // #291\n", '']], [T.sw, T.bus], 'wire name unknown → every read OFF'],
  ['D1', 'src/main/docker-relay-switch.ts', [['dockerRelayOffer({ remote, platform', 'dockerRelayOffer({ remote: false, platform']], [T.sw], 'sandbox member gets the relay (read side)'],
  ['D2', 'src/main/docker-relay-switch.ts', [["busSwitch(db, runId, 'docker_relay')", "busSwitch(db, runId, 'liveness')"]], [T.sw], 'reads the wrong mechanism'],
  ['W1', 'src/main/agent-sdk.ts', [['}, dockerRelaySpecFor(sdkEnv.ORCHESTRA_RUN_ID, remote)) as never,', '}, undefined) as never,']], [T.bind], 'the session never asks for the relay'],
  ['A1', 'src/main/docker-api.ts', [["path: `/containers/${enc(id)}/stop?t=${timeoutSec}`", "path: `/containers/${enc(id)}/kill?t=${timeoutSec}`"]], [T.api], 'stop becomes kill'],
  ['A3', 'src/main/docker-api.ts', [["if (res.status === 304) return 'already-stopped';", "if (res.status === 304) return 'stopped';"]], [T.api], '304 mislabelled'],
  ['A4', 'src/main/docker-api.ts', [['autoRemove: j.HostConfig?.AutoRemove === true,', 'autoRemove: false,']], [T.api], 'AutoRemove ignored (a --rm container would be stopped = deleted)'],
  ['A5', 'src/main/docker-api.ts', [["if (o.labels?.length) filters.label = o.labels;", '']], [T.api], 'label filter dropped (lists every container)'],
];

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);

// ── LEAK GUARD: a mutant that routes a relay to the host's REAL dockerd (K6, M5, M9…) can make a unit test CREATE real
// containers. Every run is bracketed by a container-id snapshot. A new container is OURS when its `orchestra.ws` label is one of our test/rig ids
// (ws-kdr-*, g2r*, g8r*) or it carries a rig label (g2rig / g8rig): counted as a LEAK and removed BY ID. A new container that is NOT ours (a sibling's rig on the
// same dockerd) is reported as FOREIGN and never touched or counted. A guard that could not read Docker (a timed-out / failing `docker ps`) is UNVERIFIED and
// fails the run — it never reads as "0 leaked".
let leaks = 0;
let unverified = 0;
let foreign = 0;
let dockerMissing = false; // the docker BINARY is not installed (ENOENT): nothing can leak. Any OTHER failure is a failed instrument (UNVERIFIED), never "no docker"
const dockerOut = (args) => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, DOCKER_HOST: '' } }).trim();
  } catch (e) {
    if (e && e.code === 'ENOENT') dockerMissing = true; // only a missing BINARY means "no docker"; a failing/timed-out/denied `docker ps` is UNVERIFIED
    return null;
  }
};
const containerIds = () => {
  const o = dockerOut(['ps', '-a', '-q', '--no-trunc']);
  return o === null ? null : new Set(o.split('\n').filter(Boolean));
};
containerIds(); // probe once so `dockerMissing` is known before the first run is bracketed
function leakCheck(before) {
  if (dockerMissing) return { leaked: 0, removed: 0 }; // no docker installed: nothing can leak (announced once at startup)
  const after = containerIds();
  if (!before || !after) {
    unverified++; // docker exists but could not be read around this run: UNVERIFIED, never "clean"
    return { leaked: 0, removed: 0 };
  }
  let leaked = 0;
  let removed = 0;
  for (const id of [...after].filter((x) => !before.has(x))) {
    const labels = dockerOut(['inspect', '-f', '{{index .Config.Labels "orchestra.ws"}}|{{index .Config.Labels "g2rig"}}|{{index .Config.Labels "g8rig"}}', id]);
    const [ws = '', g2 = '', g8 = ''] = (labels ?? '').split('|');
    if (/^(ws-kdr-|g2r|g8r)/.test(ws) || g2 || g8) {
      leaked++;
      if (dockerOut(['rm', '-f', id]) !== null) removed++;
    } else {
      foreign++;
    }
  }
  return { leaked, removed };
}
if (dockerMissing) console.log('LEAK GUARD: the docker binary is not installed (ENOENT) — containers cannot leak, guard is a no-op');

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

// --leak-selftest: the guard's POSITIVE CONTROL — make one labelled throwaway container (never started), and require the guard to SEE and remove it.
if (args.includes('--leak-selftest')) {
  const before = containerIds();
  const made = dockerOut(['create', '--label', 'orchestra.ws=g2r-leak-selftest', 'alpine:3', 'true']);
  const lk = leakCheck(before);
  const gone = containerIds();
  const ok = before !== null && made !== null && lk.leaked === 1 && lk.removed === 1 && gone !== null && !gone.has(made);
  console.log(`LEAK GUARD SELFTEST: created=${made?.slice(0, 12) ?? 'FAILED'} leaked=${lk.leaked} removed=${lk.removed} → ${ok ? 'PASS (guard sees and removes a leak)' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
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
const G8_ARMS = new Set(['pause_and_reprise', 'restart_order', 'removed_by_hand', 'docker_absent', 'docker_refused', 'autoremove_and_failed', 'app_resolution_moved']); // arms of scripts/e2e-pause-containers.mjs (the rest: e2e-docker-relay.mjs)
// NEVER map a mutant that WIDENS the selection of what Pause stops (P1/P2/P3) onto the rig: on a shared dockerd it would stop OTHER fleets' containers (D4) — those are unit-only.
const RIG_ARM = { P15: 'docker_absent', Q17: 'app_resolution_moved', Q18: 'app_resolution_moved', Q30: 'restart_order', P4: 'autoremove_and_failed', P13: 'pause_and_reprise', Q1: 'pause_and_reprise', Q4: 'pause_and_reprise', Q7: 'pause_and_reprise', A9: 'api_real', M12: 'late_daemon', M2: 'user_labels', R1: 'run_labels', R3: 'streams', R4: 'run_labels', R6: 'kill_relay', K1: 'no_relay_fallback', K2: 'switch_off', K5: 'kill_relay', K7: 'run_labels', C1: 'app_switch', C2: 'sweep_relay_files' };
if (args.includes('--rig')) {
  const rigIds = Object.keys(RIG_ARM).filter((id) => !only.length || only.includes(id));
  const rigRun = (arm) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './scripts/.r2-register.mjs', G8_ARMS.has(arm) ? 'scripts/e2e-pause-containers.mjs' : 'scripts/e2e-docker-relay.mjs', arm], { cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SUBJECT_REPO: REPO } });
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
    const snap = containerIds();
    try {
      fs.writeFileSync(a.abs, a.mutated);
      r = await rigRun(RIG_ARM[id]);
    } finally {
      fs.writeFileSync(a.abs, a.orig);
      if (!fs.readFileSync(a.abs).equals(a.orig)) throw new Error(`RESTORE MISMATCH for ${file}`);
    }
    const lk = leakCheck(snap);
    if (lk.leaked) { console.log(`    LEAK after ${id}: ${lk.leaked} container(s) left by the rig run (removed ${lk.removed} by id); the rig's label sweep missed them`); leaks += lk.leaked; }
    const red = (r.checks ?? []).filter((c) => !c.ok && !/bystander|every rig container/.test(c.name)).map((c) => c.name.slice(0, 60));
    const killed = r.ok === false && (red.length > 0 || r.fatal);
    if (!killed) alive++;
    console.log(`${id.padEnd(3)} ${killed ? 'KILLED  ' : 'SURVIVED'} rig:${RIG_ARM[id]}  red: ${red.slice(0, 2).join(' | ') || r.fatal || '-'}  — ${note}`);
  }
  execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
  console.log(`rig mutants: ${rigIds.length - alive} killed / ${rigIds.length}; leaked containers: ${leaks}; unverified guard reads: ${unverified}; foreign: ${foreign}`);
  process.exit(alive || leaks || unverified ? 1 : 0);
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
      const snap = containerIds();
      const r = await run(tests);
      const lk = leakCheck(snap);
      verdict = r.rc !== 0 ? 'KILLED' : 'SURVIVED';
      detail = `rc=${r.rc}${r.timedOut ? ' (HUNG→killed)' : ''} pass=${r.pass} fail=${r.fail}${lk.leaked ? ` LEAK:${lk.leaked}(removed ${lk.removed})` : ''}`;
      if (lk.leaked) leaks += lk.leaked;
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
console.log(`\nLEAKED containers across the sweep: ${leaks} (must be 0) · UNVERIFIED guard reads: ${unverified} (must be 0) · foreign new containers (a sibling's, untouched): ${foreign}`);
console.log(`${results.filter((r) => r.verdict === 'KILLED').length} killed · ${results.filter((r) => r.verdict === 'RIG-ONLY').length} rig-only · ${survived.length} survived/errored of ${results.length}`);
const post = await run(allTests, 240000);
console.log(`POST-RESTORE (tree back to base): rc=${post.rc} pass=${post.pass} fail=${post.fail} skipped=${post.skipped}; git diff of mutated files must be empty`);
process.exit(survived.length || post.rc !== 0 || leaks || unverified ? 1 : 0);
