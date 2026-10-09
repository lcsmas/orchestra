// #321 (wave H) — the in-place mutants for the Docker relay HOLD, one per changed clause. Loaded by docker-relay-mutants.mjs (same harness: byte-exact backup → apply → run the tests → restore → cmp;
// `--rig` kills the marked ones against the REAL-dockerd rig arms hold_*). [id, file, [[find, replace]...], tests that must go red, note]. Anchors are JS strings (no String.raw: some contain a template `${`).

export const HOLD_T = {
  sharedHold: 'src/shared/docker-hold.test.ts',
  gate: 'src/keeper/docker-hold.test.ts',
  relayHold: 'src/keeper/docker-relay-hold.test.ts',
  keeper: 'src/keeper/keeper-docker-relay.test.ts',
  appHold: 'src/main/docker-hold.test.ts',
  sw: 'src/main/docker-relay-switch.test.ts',
  fleet: 'src/keeper/docker-hold-fleet.test.ts',
  lease: 'src/keeper/release-lease.test.ts',
  bind: 'src/main/docker-relay-binding.test.ts',
  wire: 'src/keeper/docker-hold-wiring.test.ts',
};

/** mutant id → the rig arm (scripts/e2e-docker-relay.mjs) that must go red on it too. */
export const HOLD_RIG_ARM = {
  H4: 'hold_unattributed', H6: 'hold_fail_open', H11: 'hold_guard_chain',
  G2: 'hold_fresh_reading', G3: 'hold_one_at_a_time', G4: 'hold_fail_open', G5: 'hold_client_leaves', G7: 'hold_create', G9: 'hold_one_at_a_time',
  X1: 'hold_create', X2: 'hold_unattributed', X3: 'hold_client_leaves', X4: 'hold_create',
  K10: 'hold_create', K11: 'hold_create', K14: 'hold_fresh_reading',
  G15: 'hold_fresh_reading', H16: 'hold_fresh_reading',
  L1: 'hold_two_keepers', L3: 'hold_two_keepers', HS4: 'hold_fleet_only',
  HS1: 'hold_guard_chain', HS3: 'hold_guard_chain', HA1: 'hold_guard_chain', HA5: 'hold_guard_chain',
};

export function holdMutants(T = HOLD_T) {
  const SH = 'src/shared/docker-hold.ts';
  const GATE = 'src/keeper/docker-hold.ts';
  const REL = 'src/keeper/docker-relay.ts';
  const APP = 'src/main/docker-hold.ts';
  const HOST = 'src/main/docker-hold-host.ts';
  const KIDX = 'src/keeper/index.ts';
  return [
    // ── pure half: which calls wait, what a START may hold, the state contract ─────────────────────────────────────────
    ['H1', SH, [['const CREATE = /^\\/(?:v\\d+(?:\\.\\d+)*\\/)?containers\\/create(?:\\?|$)/;', 'const CREATE = /^\\/containers\\/create(?:\\?|$)/;']], [T.sharedHold], 'create regex drops the /vNN prefix (the docker CLI always sends one)'],
    ['H2', SH, [["  if (method !== 'POST') return null;\n", '']], [T.sharedHold], 'a GET on /containers/create (or /start) waits'],
    ['H3', SH, [['  if (inspect.running === true) return false;\n', '']], [T.sharedHold, T.relayHold], 'a start of an already-running container waits'],
    ['H4', SH, [['  return inspect.labels?.[wsLabel] === ws;', '  return true;']], [T.sharedHold, T.relayHold], 'a start of a container made AROUND the relay (the human\'s stacks, another workspace) waits; rig: hold_unattributed'],
    ['H5', SH, [['  if (!inspect) return false; // unknown container / inspect failed: fail open', '  if (!inspect) return true;']], [T.sharedHold], 'an unknown container / failed inspect holds the start (must fail open)'],
    ['H6', SH, [['return s !== null && stateIsFresh(s, now, ttlMs) && s.held;', 'return s !== null && s.held;']], [T.sharedHold, T.keeper], 'a STALE held state (app gone) keeps holding forever; rig: hold_fail_open'],
    ['H7', SH, [['return Math.abs(now - s.ts) <= ttlMs;', 'return now - s.ts <= ttlMs;']], [T.sharedHold], 'a state stamped in the far FUTURE (clock step) wedges a hold'],
    ['H8', SH, [['  return availBytes > s.admissionBytes + s.releaseMarginBytes;', '  return availBytes >= s.admissionBytes + s.releaseMarginBytes;']], [T.sharedHold], 'release at exactly threshold + margin (Admission is strict)'],
    ['H9', SH, [['if (availBytes === null || !Number.isFinite(availBytes) || availBytes < 0) return true;', 'if (availBytes === null || !Number.isFinite(availBytes) || availBytes < 0) return false;']], [T.sharedHold, T.gate], 'an unreadable meter wedges the line'],
    ['H10', SH, [['if (o.v !== ADMISSION_STATE_VERSION || !isNum(o.ts)', 'if (!isNum(o.ts)']], [T.sharedHold, T.keeper], 'a keeper obeys a state of another version'],
    ['H11', SH, [['  const held = isAdmissionHolding(snap);', "  const held = snap.admission === 'held';"]], [T.sharedHold, T.appHold], 'the Admission toggle OFF still holds (publishes the guard\'s raw state, not the EFFECTIVE hold); rig: hold_guard_chain'],
    ['H12', SH, [['return now - h.ts <= ttlMs && h.create + h.start > 0;', 'return h.create + h.start > 0;']], [T.sharedHold, T.appHold], 'a dead keeper\'s leftover hold file shows as a live wait'],
    ['H13', SH, [["  if (live.length === 0) return '';", '']], [T.sharedHold], 'bus-status prints an empty `docker holds:` line when nothing waits'],
    ['H14', SH, [['\\/start(?:\\?|$)/;', '\\/(?:start|stop)(?:\\?|$)/;']], [T.sharedHold], 'a stop waits'],
    // ── the keeper gate ────────────────────────────────────────────────────────────────────────────────────────────────
    ['G1', GATE, [['if (queue.length === 0 && !holdsNow(st, t, ttl) && ', 'if (!holdsNow(st, t, ttl) && ']], [T.gate], 'a newcomer OVERTAKES a line that is draining'],
    ['G2', GATE, [['        if (!mayReleaseOne(st, o.readMem())) {', '        if (false as boolean) {']], [T.gate, T.keeper], 'the FRESH reading before each release is skipped; rig: hold_fresh_reading'],
    ['G3', GATE, [['        try {\n          await o.sleep(o.settleMs);\n        } finally {\n          o.lease?.release();\n        }', '        o.lease?.release();']], [T.gate], 'no settle between two releases (a thundering herd); rig: hold_one_at_a_time'],
    ['G4', GATE, [['        if (holdsNow(st, t, ttl)) {', '        if (st !== null && st.held) {']], [T.gate, T.keeper], 'a STALE state keeps a line waiting for ever (not flushed); rig: hold_fail_open'],
    ['G5', GATE, [["        signal.addEventListener('abort', onAbort, { once: true });\n", '']], [T.gate, T.relayHold], 'a client that leaves stays in the line and its create is sent later; rig: hold_client_leaves'],
    ['G6', GATE, [['if (stopped || signal.aborted) return Promise.resolve(null);', 'if (stopped) return Promise.resolve(null);']], [T.gate], 'an already-aborted request is queued'],
    ['G7', GATE, [['          o.removeFile(o.holdFile);', '          void 0;']], [T.gate, T.keeper], 'the hold file outlives the wait (a phantom hold in bus-status); rig: hold_create'],
    ['G8', GATE, [['if (!force && key === lastKey && t - lastWriteAt < HEARTBEAT_MS) return;', 'if (!force && key === lastKey) return;']], [T.gate], 'no heartbeat: a long wait ages past the live TTL and vanishes from bus-status'],
    ['G9', GATE, [['const e = queue.shift();', 'const e = queue.pop();']], [T.gate], 'LIFO instead of FIFO; rig: hold_one_at_a_time'],
    ['G10', GATE, [['const since = queue[0].since;', 'const since = queue[queue.length - 1].since;']], [T.gate], 'the published `since` is the NEWEST wait, not the oldest'],
    ['G11', GATE, [['    if (running) return;\n    running = true;', '    running = true;']], [T.gate], 'two release loops run at once (double release)'],
    ['G12', GATE, [['    if (a !== authorityNote) {', '    if (true as boolean) {']], [T.gate], 'the fail-open switch is logged at EVERY read (a flood) instead of once per change of authority'],
    ['G13', GATE, [["      if (a !== 'fresh') {", "      if (a !== 'fresh' && queue.length > 0) {"]], [T.gate, T.keeper], 'review m2: the switch to fail-open is logged only when a line waits (a wedged app switches the function off in silence)'],
    ['G14', GATE, [["const a: 'fresh' | 'absent' | 'unreadable' | 'stale' = text === null ? 'absent' :", "const a: 'fresh' | 'absent' | 'unreadable' | 'stale' = text === null ? 'unreadable' :"]], [T.gate, T.keeper], 'an ABSENT state file is logged as unreadable'],
    // ── review M1: the fleet-wide release slot ────────────────────────────────────────────────────────────────────────
    ['L1', GATE, [['if (o.lease && !o.lease.tryAcquire()) {', 'if (false as boolean) {']], [T.fleet, T.keeper], 'releases are one at a time PER KEEPER only (K keepers release K calls at once); rig: hold_two_keepers'],
    ['L2', GATE, [['          o.lease?.release();\n          publish();\n          await o.sleep(o.pollMs);', '          publish();\n          await o.sleep(o.pollMs);']], [T.fleet], 'a keeper kept in line by the fresh reading keeps the slot (the fleet\'s line stalls)'],
    ['L3', GATE, [['        try {\n          await o.sleep(o.settleMs);\n        } finally {\n          o.lease?.release();\n        }', '        o.lease?.release();\n        await o.sleep(o.settleMs);']], [T.fleet, T.keeper], 'the settle is spent OUTSIDE the slot (the next keeper reads a MemAvailable that does not show the container yet)'],
    ['L4', GATE, [['      stopped = true;\n      o.lease?.release();', '      stopped = true;']], [T.fleet], 'a stopping keeper keeps the slot until the TTL'],
    ['L5', SH, [['return !pidAlive(l.pid) || now - l.ts > ttlMs || l.ts - now > ttlMs;', 'return now - l.ts > ttlMs || l.ts - now > ttlMs;']], [T.lease, T.fleet], 'a DEAD holder\'s slot is only taken over after the TTL'],
    ['L6', SH, [['return !pidAlive(l.pid) || now - l.ts > ttlMs || l.ts - now > ttlMs;', 'return !pidAlive(l.pid);']], [T.lease], 'a stuck (alive) holder keeps the slot for ever'],
    ['L7', SH, [[' || l.ts - now > ttlMs;', ';']], [T.lease], 'a lease stamped in the far future (clock step) wedges the slot'],
    ['L8', SH, [['if (l === null) return ageMs > ttlMs;', 'if (l === null) return true;']], [T.lease], 'a lease being written (empty file) is taken over at once'],
    ['L9', 'src/keeper/release-lease.ts', [['if (mine(o.io.readText(o.file))) o.io.remove(o.file);', 'o.io.remove(o.file);']], [T.lease], 'release removes a lease another keeper holds now'],
    ['L10', 'src/keeper/release-lease.ts', [['    return true; // fail open: no arbiter ⇒ the line goes on (held stays false: nothing to give back)', '    return false;']], [T.lease], 'an unwritable lease directory strands every line (no fail-open)'],
    ['L11', 'src/keeper/release-lease.ts', [['if (moved !== seen) {', 'if (false as boolean) {']], [T.lease], 'a takeover that moved a FRESH lease keeps it moved (two holders)'],
    ['L12', SH, [['stateFile.replace(/\\.state$/, \'.lease\')', 'stateFile']], [T.lease, T.fleet], 'the lease file IS the state file (never created: the slot is always busy)'],
    ['L13', 'src/keeper/index.ts', [["fs.writeFileSync(f, text, { flag: 'wx', mode: 0o600 });", "fs.writeFileSync(f, text, { flag: 'w', mode: 0o600 });"]], [T.keeper], 'the lease create is not exclusive: every keeper \'takes\' the slot'],
    ['L14', 'src/keeper/index.ts', [['    lease: createKeeperLease(holdState),\n', '']], [T.keeper], 'the production gate is built without the fleet-wide slot'],
    // ── review round 2: oldest call first + newcomers queue behind a line in motion ─────────────────────────────────────────
    ['F1', GATE, [['if (o.fleet?.olderWaiter(queue[0].since)) {', 'if (false as boolean) {']], [T.fleet], 'a keeper draining a long line starves an OLDER call on another keeper (measured: 11 s)'],
    ['F2', GATE, [['!(authoritativeNow(st, t) && (o.fleet?.busy() ?? false))) return Promise.resolve', 'true) return Promise.resolve']], [T.fleet], 'a newcomer on another keeper jumps the fleet\'s line (Admission: it never does)'],
    ['F3', GATE, [['|| (authoritativeNow(st, t) && (o.fleet?.busy() ?? false));', ';']], [T.fleet], 'holding() ignores the fleet\'s line (a START skips nothing it should wait behind)'],
    ['F4', GATE, [['        if (flush) {\n          releaseHead(true);', '        if (flush) {\n          if (o.lease && !o.lease.tryAcquire()) {\n            await o.sleep(o.pollMs);\n            continue;\n          }\n          releaseHead(true);']], [T.fleet], 'a FLUSH (app gone, toggle OFF) waits behind a live holder of the slot'],
    ['F5', 'src/keeper/release-lease.ts', [['busy: () => waiters().length > 0 || slotHeldByOther(),', 'busy: () => waiters().length > 0,']], [T.lease], 'the slot being held (a release just happened, settling) does not make the line busy'],
    ['F6', 'src/keeper/release-lease.ts', [['busy: () => waiters().length > 0 || slotHeldByOther(),', 'busy: () => slotHeldByOther(),']], [T.lease, T.fleet], 'another keeper\'s waiting calls do not make the line busy'],
    ['F7', 'src/keeper/release-lease.ts', [['      if (n === ownName) continue;\n', '']], [T.lease], 'a keeper counts its OWN hold file as another keeper\'s line (it defers to itself)'],
    ['F8', 'src/keeper/release-lease.ts', [['w.since < since || (w.since === since && w.ws < ownId)', 'w.since <= since']], [T.lease], 'two calls that began in the same millisecond each defer to the other (deadlock)'],
    ['F9', 'src/keeper/release-lease.ts', [['if (h && holdIsLive(h, now)) out.push', 'if (h) out.push']], [T.lease], 'a dead keeper\'s leftover hold file blocks the fleet'],
    ['F10', 'src/keeper/release-lease.ts', [['      return []; // cannot look: fail open (no ordering, no queueing behind a line we cannot see)', '      throw new Error(\'cannot list\');']], [T.lease], 'an unlistable keepers directory wedges the gate instead of failing open'],
    // ── review M2 / m1 ───────────────────────────────────────────────────────────────────────────────────────────────────
    ['HS4', 'src/main/docker-relay-switch.ts', [['...(isFleetMember(ws) ? { holdState: admissionStateFile(orchestraHome()) } : {})', '...({ holdState: admissionStateFile(orchestraHome()) })']], [T.sw], 'a LEAD / top-level session gets the hold (Admission exempts it); rig: hold_fleet_only'],
    ['HS5', 'src/main/agent-sdk.ts', [['}, dockerRelaySpecFor(sdkEnv.ORCHESTRA_RUN_ID, remote, ws),', '}, dockerRelaySpecFor(sdkEnv.ORCHESTRA_RUN_ID, remote),']], [T.bind], 'the session never tells the decision which workspace it is for (no fleet-member test) — pinned by the binding test (the rig calls the decision directly, not the agent-sdk call site)'],
    ['H18', SH, [[' A client with its OWN short timeout gives up first and its call must be retried: docker-py (the python \\`docker\\` SDK, compose v1) times out after 60 s by default — give it a longer timeout.', '']], [T.sharedHold], 'review m1: the notice does not say that a 60 s client (docker-py) gives up first'],
    // ── the relay seam ─────────────────────────────────────────────────────────────────────────────────────────────────
    ['X1', REL, [['const op = opts.hold ? heldOpOf(req.method, req.url) : null;', 'const op = null as HeldOp | null;']], [T.relayHold, T.keeper], 'the relay never consults the gate; rig: hold_create'],
    ['X2', REL, [["if (!gate.holding() || !startIsHoldable(await inspectContainer(op.prefix, op.id), opts.ws, DOCKER_LABEL_WS)) {", "if (!gate.holding()) {"]], [T.relayHold], 'every start waits, whatever the container is; rig: hold_unattributed'],
    ['X3', REL, [["    res.once('close', onGone);\n", '']], [T.relayHold], 'a client that leaves is not propagated to the gate; rig: hold_client_leaves'],
    ['X4', REL, [['Warnings: [...w, heldWarning(held.waitedMs, held.reason, held.flushed)]', 'Warnings: w']], [T.relayHold], 'a create that waited says nothing to the member; rig: hold_create'],
    ['X5', REL, [["const extra = held ? ['x-orchestra-hold',", "const extra = (false as boolean) ? ['x-orchestra-hold',"]], [T.relayHold], 'the hold header is never sent'],
    ['X6', REL, [['      if (!res.destroyed && !res.headersSent) {\n        if (op.kind', '      if (false as boolean) {\n        if (op.kind']], [T.relayHold], 'a throwing gate leaves the member\'s call hanging instead of forwarding'],
    ['X7', REL, [['const held = r.waitedMs > 0 && r.reason ? { waitedMs: r.waitedMs, reason: r.reason, ...(r.flushed ? { flushed: true } : {}) } : undefined;', "const held = { waitedMs: r.waitedMs, reason: r.reason ?? 'x' };"]], [T.relayHold], 'a create that never waited is rewritten anyway'],
    ['X8', REL, [["flat.push('content-length', String(out.length), ...extra);", "flat.push('content-length', String(parts.length), ...extra);"]], [T.relayHold], 'the rewritten create answer keeps the old framing'],
    ['X9', REL, [['path: `${prefix}/containers/${encodeURIComponent(id)}/json`', 'path: `/containers/${encodeURIComponent(id)}/json`']], [T.relayHold], 'the inspect drops the API version prefix'],
    // ── keeper wiring ──────────────────────────────────────────────────────────────────────────────────────────────────
    ['K10', 'src/keeper/index.ts', [[', log: klog, ...(gate ? { hold: gate } : {}) });', ', log: klog });']], [T.keeper], 'the gate is built but never given to the relay; rig: hold_create'],
    ['K11', 'src/keeper/index.ts', [['void withDockerRelay(f.dockerRelay.runId, capEnv, f.dockerRelay.holdState).then(', 'void withDockerRelay(f.dockerRelay.runId, capEnv).then(']], [T.keeper], 'the spawn frame\'s holdState never reaches the relay; rig: hold_create'],
    ['K14', 'src/keeper/index.ts', [["return parseMemAvailableBytes(fs.readFileSync('/proc/meminfo', 'utf8'));", 'return null;']], [T.keeper], 'the keeper never takes a fresh reading; rig: hold_fresh_reading'],
    // ── the protocol / spec ────────────────────────────────────────────────────────────────────────────────────────────
    ['HS1', 'src/shared/docker-relay.ts', [['return runId ? { runId, ...(args.holdState ? { holdState: args.holdState } : {}) } : undefined;', 'return runId ? { runId } : undefined;']], [T.sw], 'the offer drops holdState; rig: hold_guard_chain'],
    ['HS2', 'src/shared/docker-relay.ts', [["'.docker.hold')", "'.docker.pid')"]], [T.keeper, T.appHold], 'the hold file is named *.pid (listLiveKeepers would read it as a workspace)'],
    ['HS3', 'src/main/docker-relay-switch.ts', [['...(isFleetMember(ws) ? { holdState: admissionStateFile(orchestraHome()) } : {})', '']], [T.sw], 'the app never names the state file; rig: hold_guard_chain'],
    // ── the app half ───────────────────────────────────────────────────────────────────────────────────────────────────
    ['HA1', APP, [['d.writeFile(d.stateFile, JSON.stringify(admissionStateOf(snap, d.now())));', "d.writeFile(d.stateFile, JSON.stringify(admissionStateOf({ ...snap, admission: 'open' }, d.now())));"]], [T.appHold], 'the app publishes NOT held whatever the guard says; rig: hold_guard_chain'],
    ['HA2', APP, [['        if (noticed.get(wsId) === hold.episode) continue;\n', '']], [T.appHold], 'the member is told at every tick, not once per episode'],
    ['HA3', APP, [['        if (now - hold.since < d.noticeAfterMs) continue;\n', '']], [T.appHold], 'a brief wait already sends a message'],
    ['HA4', APP, [['if (hold && holdIsLive(hold, now)) out.push', 'if (hold) out.push']], [T.appHold], 'a dead keeper\'s leftover shows as a live wait'],
    ['HA5', APP, [['        d.removeFile(d.stateFile);', '        void 0;']], [T.appHold], 'a quit app leaves a held state behind (it goes stale after 5 min instead of at once); rig: hold_guard_chain'],
    ['HA6', APP, [['.sort((a, b) => a.hold.since - b.hold.since)', '.sort((a, b) => b.hold.since - a.hold.since)']], [T.appHold], 'holds not listed oldest first'],
    ['HA7', APP, [['if (d.notify(wsId, holdNoticeText(hold, now)) !== false) noticed.set(wsId, hold.episode);', 'd.notify(wsId, holdNoticeText(hold, now));']], [T.appHold], 'the notice is never remembered'],
    ['HA8', HOST, [['    h.tick();\n', '']], [T.appHold], 'the notice is never evaluated'],
    ['HA9', HOST, [['  hold?.stop();\n', '']], [T.appHold], 'stopping the app leaves the state file'],
    ['HA10', HOST, [["  // SUBSCRIBE FIRST, then reconcile from the guard's current state.\n  unsubscribe = subscribeMemoryGuardSamples((snap) => {\n    h.publish(snap);\n    h.tick();\n  });\n  h.publish(getMemoryGuardSnapshot());", "  h.publish(getMemoryGuardSnapshot());\n  unsubscribe = subscribeMemoryGuardSamples((snap) => {\n    h.publish(snap);\n    h.tick();\n  });"]], [T.appHold], 'publish before subscribe: a sample landing in between is lost'],
    ['HA11', 'src/main/index.ts', [['\n  startDockerHold();\n', '\n']], [T.appHold], 'the app never starts the publisher'],
    ['HA12', 'src/main/index.ts', [['  stopDockerHold();\n', '']], [T.appHold], 'the app never stops the publisher'],
    ['HA13', 'src/main/hooks-server.ts', [['dockerHolds: listDockerHolds().map(', 'dockerHoldsX: listDockerHolds().map(']], [T.appHold], 'bus-status carries no holds'],
    ['HA14', 'src/cli/index.ts', [['        if (dh) process.stdout.write(`${dh}\\n`);', '        process.stdout.write(`${dh}\\n`);']], [T.appHold], 'the CLI prints an empty line when nothing waits'],
    ['HA15', 'src/main/keeper-client.ts', [['    unlink(relayHoldFile(keeperSocketPath(wsId)));\n', '']], [T.appHold], 'a dead keeper\'s hold file is not swept (sweepStaleKeeperFiles)'],
    ['HA16', 'src/main/keeper-client.ts', [['relayHoldFile(keeperSocketPath(wsId)), keeperLogPath(wsId)]', 'keeperLogPath(wsId)]']], [T.appHold], 'listLiveKeepers does not sweep the hold file'],
    // ── R13 (verifier K01/K02): the keeper's production wiring of the release slot and the fleet's line — either piece alone spaces two creates, so only these source pins (and the rig `hold_two_keepers`) see an unwired one ──
    ['WK1', KIDX, [['    lease: createKeeperLease(holdState),\n', '']], [T.wire], 'the gate is not handed the fleet-wide release slot (verifier K01)'],
    ['WK2', KIDX, [['    fleet: createKeeperFleetLine(holdState),\n', '']], [T.wire], 'the gate is not handed the fleet\'s line (verifier K02)'],
    ['WK3', KIDX, [['owner: wsId, pid: process.pid, log: klog', "owner: 'x', pid: process.pid, log: klog"]], [T.wire], 'the slot is owned by no workspace'],
    ['WK4', KIDX, [['ownWs: wsId, pid: process.pid, leaseFile', "ownWs: '', pid: process.pid, leaseFile"]], [T.wire], 'the line does not know which workspace is its own'],
    ['WK5', KIDX, [['leaseFile: admissionLeaseFile(holdState), io: leaseIo() })', 'leaseFile: holdState, io: leaseIo() })']], [T.wire], 'the line queues behind a slot that is not the shared one'],
    ['WK6', KIDX, [['...(gate ? { hold: gate } : {}) })', '})']], [T.wire], 'the relay is created without its gate'],
    ['WK7', KIDX, [['withDockerRelay(f.dockerRelay.runId, capEnv, f.dockerRelay.holdState)', 'withDockerRelay(f.dockerRelay.runId, capEnv, undefined)']], [T.wire], 'the spawn frame\'s holdState never reaches the relay'],
    ['WK8', KIDX, [['file: admissionLeaseFile(holdState), owner: wsId', 'file: holdState, owner: wsId']], [T.wire], 'the slot is the state file itself (it would be overwritten)'],
    ['WK9', KIDX, [['holdFile: relayHoldFile(sockPath),\n    now: Date.now,', 'holdFile: sockPath,\n    now: Date.now,']], [T.wire], 'what this keeper holds is published where the others do not look'],
  ];
}
