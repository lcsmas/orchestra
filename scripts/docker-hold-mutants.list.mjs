// #321 (wave H) — the in-place mutants for the Docker relay HOLD, one per changed clause. Loaded by docker-relay-mutants.mjs (same harness: byte-exact backup → apply → run the tests → restore → cmp;
// `--rig` kills the marked ones against the REAL-dockerd rig arms hold_*). [id, file, [[find, replace]...], tests that must go red, note]. Anchors are JS strings (no String.raw: some contain a template `${`).

export const HOLD_T = {
  sharedHold: 'src/shared/docker-hold.test.ts',
  gate: 'src/keeper/docker-hold.test.ts',
  relayHold: 'src/keeper/docker-relay-hold.test.ts',
  keeper: 'src/keeper/keeper-docker-relay.test.ts',
  appHold: 'src/main/docker-hold.test.ts',
  sw: 'src/main/docker-relay-switch.test.ts',
};

/** mutant id → the rig arm (scripts/e2e-docker-relay.mjs) that must go red on it too. */
export const HOLD_RIG_ARM = {
  H4: 'hold_unattributed', H6: 'hold_fail_open', H11: 'hold_guard_chain',
  G2: 'hold_fresh_reading', G3: 'hold_one_at_a_time', G4: 'hold_fail_open', G5: 'hold_client_leaves', G7: 'hold_create', G9: 'hold_one_at_a_time',
  X1: 'hold_create', X2: 'hold_unattributed', X3: 'hold_client_leaves', X4: 'hold_create',
  K10: 'hold_create', K11: 'hold_create', K14: 'hold_fresh_reading',
  G15: 'hold_fresh_reading', H16: 'hold_fresh_reading',
  HS1: 'hold_guard_chain', HS3: 'hold_guard_chain', HA1: 'hold_guard_chain', HA5: 'hold_guard_chain',
};

export function holdMutants(T = HOLD_T) {
  const SH = 'src/shared/docker-hold.ts';
  const GATE = 'src/keeper/docker-hold.ts';
  const REL = 'src/keeper/docker-relay.ts';
  const APP = 'src/main/docker-hold.ts';
  const HOST = 'src/main/docker-hold-host.ts';
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
    ['G1', GATE, [['if (queue.length === 0 && !holdsNow(st, t, ttl))', 'if (!holdsNow(st, t, ttl))']], [T.gate], 'a newcomer OVERTAKES a line that is draining'],
    ['G2', GATE, [['if (!flush && !mayReleaseOne(st, o.readMem())) {', 'if (false as boolean) {']], [T.gate, T.keeper], 'the FRESH reading before each release is skipped; rig: hold_fresh_reading'],
    ['G3', GATE, [['        if (queue.length > 0 && !flush) await o.sleep(o.settleMs);\n', '']], [T.gate], 'no settle between two releases (a thundering herd); rig: hold_one_at_a_time'],
    ['G4', GATE, [['        if (holdsNow(st, t, ttl)) {', '        if (st !== null && st.held) {']], [T.gate, T.keeper], 'a STALE state keeps a line waiting for ever (not flushed); rig: hold_fail_open'],
    ['G5', GATE, [["        signal.addEventListener('abort', onAbort, { once: true });\n", '']], [T.gate, T.relayHold], 'a client that leaves stays in the line and its create is sent later; rig: hold_client_leaves'],
    ['G6', GATE, [['if (stopped || signal.aborted) return Promise.resolve(null);', 'if (stopped) return Promise.resolve(null);']], [T.gate], 'an already-aborted request is queued'],
    ['G7', GATE, [['          o.removeFile(o.holdFile);', '          void 0;']], [T.gate, T.keeper], 'the hold file outlives the wait (a phantom hold in bus-status); rig: hold_create'],
    ['G8', GATE, [['if (!force && key === lastKey && t - lastWriteAt < HEARTBEAT_MS) return;', 'if (!force && key === lastKey) return;']], [T.gate], 'no heartbeat: a long wait ages past the live TTL and vanishes from bus-status'],
    ['G9', GATE, [['const e = queue.shift();', 'const e = queue.pop();']], [T.gate], 'LIFO instead of FIFO; rig: hold_one_at_a_time'],
    ['G10', GATE, [['const since = queue[0].since;', 'const since = queue[queue.length - 1].since;']], [T.gate], 'the published `since` is the NEWEST wait, not the oldest'],
    ['G11', GATE, [['    if (running) return;\n    running = true;', '    running = true;']], [T.gate], 'two release loops run at once (double release)'],
    ['G12', GATE, [['      if (!unreadableLogged) o.log(', '      if (true as boolean) o.log(']], [T.gate], 'an unreadable state file is logged at EVERY read (a flood) instead of once'],
    ['G13', GATE, [['      unreadableLogged = true;\n    } else {\n      unreadableLogged = false;\n    }', '      unreadableLogged = true;\n    } else {\n    }']], [T.gate], 'after a good read, a new unreadable file is not logged again'],
    ['G14', GATE, [['if (text !== null && s === null) {', 'if (s === null) {']], [T.gate], 'an ABSENT state file is logged as an error (it is the normal fail-open case)'],
    ['G15', GATE, [['const flush = st === null || !stateIsFresh(st, t, ttl) || !st.enabled;', 'const flush = st === null || !stateIsFresh(st, t, ttl) || false;']], [T.gate, T.keeper], 'the Admission toggle OFF strands a waiting line (a fresh low reading still gates it)'],
    ['G16', GATE, [['...(flushed ? { flushed: true } : {}) });', '});']], [T.gate], 'a flushed release is not marked (the member is told memory came back)'],
    ['G17', GATE, [['holding: () => !stopped && (queue.length > 0 || holdsNow(readState(), o.now(), ttl)),', 'holding: () => !stopped && holdsNow(readState(), o.now(), ttl),']], [T.gate], 'holding() ignores a line that is still draining after the guard reopened'],
    ['H15', SH, [["typeof o.enabled !== 'boolean' || ", '']], [T.sharedHold], 'a state without the toggle field is obeyed'],
    ['H16', SH, [['    enabled: snap.admissionEnabled,', '    enabled: true,']], [T.sharedHold, T.appHold], 'the toggle is never published (a line waiting at toggle OFF is stranded)'],
    ['H17', SH, [["const end = flushed ? 'was released because the Admission state is no longer published (the app is gone or the toggle is off)' : 'went through when memory was back';", "const end = 'went through when memory was back';"]], [T.sharedHold], 'a flushed call is told memory was back'],
    ['X10', REL, [['if (!gate.holding() || !startIsHoldable(', 'if (!startIsHoldable(']], [T.relayHold], 'every start pays an inspect round trip even when nothing is held'],
    ['X11', REL, [['timeout: opts.inspectTimeoutMs ?? 15_000 }', 'timeout: 3_000_000 }']], [T.relayHold], 'the START inspect has no usable timeout (a slow daemon holds a stamped start for ever)'],
    ['HA17', APP, [['holdNoticeText(hold, now)) !== false) noticed.set', 'holdNoticeText(hold, now)) !== null) noticed.set']], [T.appHold], 'a notice that was NOT delivered is remembered (the member never hears of the wait)'],
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
    ['HS3', 'src/main/docker-relay-switch.ts', [[', holdState: admissionStateFile(orchestraHome()) });', ' });']], [T.sw], 'the app never names the state file; rig: hold_guard_chain'],
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
  ];
}
