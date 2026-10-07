// MEMORY PAUSE arms of the pause-trap rig (#290, epic #284, wave G ledger #295). Loaded by driver.mjs (inside the same net+pid namespace): the REAL detached keeper → the REAL `claude` CLI →
// real Bash-tool processes against the scripted fake API; the host is the REAL pause-trap + the REAL memory guard (real sampler timers, real decision) + the REAL memory-Pause host
// (src/main/pause-memory-host.ts), wired like index.ts. The ONLY fake is the available-memory source (Seam 1): the stand-in app answers `{cmd:'memory', gb}` by setting it and re-measuring
// (`sampleMemoryGuardNow`, the consumers' own seam). Everything else — the Pause, the trap (interrupt + kill of the tool trees + Bilan), the Reprise — is the shipped path, read back through
// the REAL built CLI (`orchestra run status`) and the bus (read-only).
//
//   pause     critical → the `pause`-ON run is paused with the motive memory, its member's tool trees are killed, its session is intact; between the thresholds nothing changes (hysteresis);
//             recovery above the Admission threshold → the AUTOMATIC Reprise (host, coordinators first, the worker stays blocked until its OPS releases it) → ACTIVE again
//   off       the run's frozen `pause` switch is OFF: critical memory (the guard decides it) writes NOTHING and kills nothing
//   manual    a MANUAL Pause in effect during the episode is left exactly as it is and is NOT lifted after recovery
//   manuallifted  a MANUAL Pause ends (resumed + released) while memory is STILL critical: the fleet is memory-paused at the next read, not left running un-Paused for the rest of the cycle
//   wakeoff   the runs' frozen `wake` switch is OFF (the rig's default): the Pause is STILL imposed (ruling A: a frozen host is worse than a stalled Reprise); at recovery the Reprise is HELD + escalated, never started blind
//   takeover  a Pause the guard wrote is re-asserted by a coordinator during the episode ⇒ it is manual from then on: NOT lifted after recovery

const TICK_WAIT_MS = 17_000; // one memory-Pause level tick is 15 s: a negative claim ("nothing happened") must outlast a tick

export const MEMORY_ARMS = {
  'memory-pause': { scenario: 'background', markers: [7714, 7715, 7716], mustKill: ['sleep 7714', 'sleep 7715'], memoryArm: 'pause' },
  'memory-pause-off': { scenario: 'background', markers: [7714, 7715, 7716], mustKill: [], memoryArm: 'off' },
  'memory-pause-manual': { scenario: 'background', markers: [7714, 7715, 7716], mustKill: [], memoryArm: 'manual' },
  'memory-pause-takeover': { scenario: 'background', markers: [7714, 7715, 7716], mustKill: [], memoryArm: 'takeover' },
  'memory-pause-manual-lifted': { scenario: 'background', markers: [7714, 7715, 7716], mustKill: [], memoryArm: 'manuallifted' },
  'memory-pause-wake-off': { scenario: 'background', markers: [7714, 7715, 7716], mustKill: ['sleep 7714', 'sleep 7715'], memoryArm: 'wakeoff' },
};

export async function runMemory(ctx) {
  const { A, startApp, cli, waitFor, sleep, check, allProcs, live, alive, readProc, orchHome, importSrc } = ctx;
  const mode = A.memoryArm;
  const sleepersOf = (n) => allProcs().filter((p) => live(p) && p.comm === 'sleep' && p.argv[1] === String(n));
  const keeperOf = (id) => allProcs().find((p) => live(p) && p.argv.some((a) => a.endsWith('keeper.js')) && p.argv.includes(id));
  const cliOfKeeper = (k) => allProcs().find((p) => live(p) && p.ppid === k.pid && /claude/.test(p.argv[0] ?? ''));
  const busMod = await importSrc('src/main/bus.ts');
  const busFile = `${orchHome}/bus.sqlite`;
  const withRo = (fn) => { const db = busMod.open(busFile, { readonly: true }); try { return fn(db); } finally { db.close(); } };
  const carrier = () => withRo((db) => db.prepare("SELECT paused_at, paused_by, pause_mode, pause_trap_at, resume_started_at, pause_auto FROM runs WHERE id = 'lead'").get());
  const allRuns = () => withRo((db) => JSON.stringify(db.prepare('SELECT * FROM runs ORDER BY id').all()));
  const repriseRows = () => withRo((db) => db.prepare("SELECT recipient, sender FROM messages WHERE kind = 'reprise' ORDER BY sequence").all());
  const status = () => { const r = cli('run', 'status', '--run', 'lead', '--json'); try { return { ...JSON.parse(r.out), rc: r.rc }; } catch { return { rc: r.rc, raw: r.out }; } };
  const w1row0 = (st) => st?.bilan?.find((r) => r.wsId === 'w1');
  const gone = (what, v) => (v === undefined || v === null ? `${what}: none` : JSON.stringify(v).slice(0, 200));

  const app = startApp('first', { scenario: A.scenario, pauseSwitch: mode !== 'off', wakeSwitch: mode !== 'wakeoff', memory: { startGb: 12 } });
  const ask = async (cmd) => {
    const n = app.replies.length;
    app.send(cmd);
    return waitFor(() => app.replies.slice(n).find((r) => r.reply === cmd.cmd), 30_000, `${cmd.cmd} reply`);
  };
  await app.waitEv((e) => e.ev === 'sent', 120_000, 'the first turn to be sent');
  await waitFor(() => A.markers.every((n) => sleepersOf(n).length >= 1), 90_000, `tool processes ${A.markers.join(',')} to appear`);
  const keeper = await waitFor(() => keeperOf('w1'), 10_000, 'the keeper');
  const cli0 = await waitFor(() => cliOfKeeper(keeper), 10_000, 'the CLI under the keeper');
  check('tool_procs_present_before', A.markers.every((n) => sleepersOf(n).length >= 1), `markers ${A.markers.join(',')} alive under CLI ${cli0.pid}`);
  const started = await app.waitEv((e) => e.ev === 'memory-started', 30_000, 'the memory guard to start');
  check('memory_host_present', started.host === true, started.host ? 'the memory-Pause host module is in this tree' : 'NO memory-Pause host module in this tree (master): nothing will ever react to the guard');

  // POSITIVE CONTROL of the instrument: at normal memory the guard says nothing and nothing is paused
  let g = await ask({ cmd: 'memory', gb: 12 });
  check('guard_normal_control', g.snap.pause === 'none' && g.snap.admission === 'open' && g.snap.measured === true, JSON.stringify(g.snap));
  check('no_pause_at_normal_memory', carrier()?.paused_at === null, gone('carrier', carrier()));

  const toolsAlive = () => A.markers.every((n) => sleepersOf(n).length >= 1);
  const sessionAlive = () => alive(keeper.pid, keeper.start) && alive(cli0.pid, cli0.start);
  const trapDone = () => waitFor(() => { const c = carrier(); return c?.pause_trap_at ? c : null; }, 90_000, 'the trap to be stamped').catch(() => null);

  if (mode === 'off') {
    const before = allRuns();
    g = await ask({ cmd: 'memory', gb: 2 });
    check('guard_decided_critical_control', g.snap.pause === 'held' && g.snap.pauseCycle === 1, `the guard itself says the memory Pause is due: ${JSON.stringify(g.snap)} (the instrument can say critical — a quiet fleet below is therefore a decision, not a dead meter)`);
    await sleep(TICK_WAIT_MS + 3_000);
    check('off_run_untouched', allRuns() === before && carrier()?.paused_at === null, `the pause-OFF run's rows are byte-identical after ${Math.round((TICK_WAIT_MS + 3_000) / 1000)} s of critical memory (a level tick included)`);
    check('off_tools_untouched', toolsAlive() && sessionAlive(), `tool processes ${A.markers.join(',')} still alive, keeper + CLI alive`);
    g = await ask({ cmd: 'memory', gb: 8 });
    await sleep(TICK_WAIT_MS);
    check('off_nothing_after_recovery', allRuns() === before, 'recovery changed nothing either');
    check('rig_ran_to_completion', true, '');
    return;
  }

  if (mode === 'manuallifted') {
    const p = cli('run', 'pause', '--hard', '--run', 'lead', '--as', 'lead');
    check('manual_pause_accepted', p.rc === 0 && /PAUSED/.test(p.out), `rc=${p.rc} ${p.out.trim().slice(0, 120)}`);
    const done = await trapDone();
    check('manual_trap_finished', !!done, done ? 'the manual Pause was trapped' : 'never stamped');
    g = await ask({ cmd: 'memory', gb: 2 });
    check('guard_decided_critical_control', g.snap.pause === 'held' && g.snap.pauseCycle === 1, JSON.stringify(g.snap));
    await sleep(TICK_WAIT_MS);
    check('manual_pause_left_alone_while_it_lasts', carrier()?.paused_by === 'lead' && carrier()?.pause_auto === null, `the manual Pause stands untouched under critical memory: ${JSON.stringify(carrier()).slice(0, 160)}`);
    // the coordinator resumes it by hand and releases its worker: the run is ACTIVE again — inside the SAME pause cycle, memory still critical
    const r1 = cli('run', 'resume', '--run', 'lead', '--as', 'lead');
    check('manual_resume_accepted', r1.rc === 0 && /REPRISE STARTED|LIFTED/.test(r1.out), `rc=${r1.rc} ${r1.out.trim().slice(0, 120)}`);
    const r2 = cli('run', 'release', 'w1', '--run', 'ops', '--as', 'ops');
    check('manual_release_accepted', r2.rc === 0 && /Released 1 member\(s\): w1/.test(r2.out), `rc=${r2.rc} ${r2.out.trim().slice(0, 120)}`);
    const active = await waitFor(() => { const c = carrier(); return c && c.paused_at === null ? true : (c && c.paused_by === 'host:memory' ? 'memory' : null); }, 40_000, 'the manual Pause to end').catch(() => null);
    check('manual_pause_ended_control', !!active, `the run went ${active === true ? 'ACTIVE' : active === 'memory' ? 'straight to the memory Pause' : 'neither'}`);
    const again = await waitFor(() => { const c = carrier(); return c?.paused_at && c.paused_by === 'host:memory' ? c : null; }, 40_000, 'the memory Pause after the manual one ended').catch(() => null);
    check('memory_pause_after_manual_ended', !!again && /"reason":"memory"/.test(again.pause_auto ?? ''), again ? `memory-paused ${Math.round((again.paused_at - Date.now()) / 1000)} s after: paused_by=${again.paused_by}` : 'the fleet was left running UN-Paused under critical memory (the manual Pause was ledgered as handled)');
    check('rig_ran_to_completion', true, '');
    return;
  }

  if (mode === 'manual') {
    const p = cli('run', 'pause', '--hard', '--run', 'lead', '--as', 'lead');
    check('manual_pause_accepted', p.rc === 0 && /PAUSED/.test(p.out), `rc=${p.rc} ${p.out.trim().slice(0, 120)}`);
    const done = await trapDone();
    check('manual_trap_finished', !!done, done ? 'the manual Pause was trapped' : 'never stamped');
    const before = JSON.stringify(carrier());
    g = await ask({ cmd: 'memory', gb: 2 });
    check('guard_decided_critical_control', g.snap.pause === 'held', JSON.stringify(g.snap));
    await sleep(TICK_WAIT_MS + 3_000);
    check('manual_pause_untouched_during_episode', JSON.stringify(carrier()) === before, `the manual Pause row is byte-identical under critical memory: ${before.slice(0, 160)}`);
    g = await ask({ cmd: 'memory', gb: 8 });
    check('guard_liftable_control', g.snap.pause === 'none' && g.snap.admission === 'open', `the guard itself says the memory Pause is liftable: ${JSON.stringify(g.snap)}`);
    await sleep(TICK_WAIT_MS + 3_000);
    const c = carrier();
    check('manual_pause_stays_after_recovery', JSON.stringify(c) === before && c.resume_started_at === null && repriseRows().length === 0, `after recovery the manual Pause is unchanged (resume_started_at=${c?.resume_started_at}, reprise rows=${repriseRows().length})`);
    check('rig_ran_to_completion', true, '');
    return;
  }

  // ── pause / takeover: the memory Pause itself
  g = await ask({ cmd: 'memory', gb: 4.5 });
  check('guard_admission_held_not_critical_control', g.snap.admission === 'held' && g.snap.pause === 'none', JSON.stringify(g.snap));
  await sleep(TICK_WAIT_MS);
  check('no_pause_between_thresholds', carrier()?.paused_at === null && toolsAlive(), `Admission is held but memory is not critical: nothing paused, tools alive (${gone('carrier', carrier())})`);

  g = await ask({ cmd: 'memory', gb: 2 });
  check('guard_decided_critical_control', g.snap.pause === 'held' && g.snap.pauseCycle === 1, JSON.stringify(g.snap));
  const tPause = Date.now();
  const written = await waitFor(() => { const c = carrier(); return c?.paused_at ? c : null; }, 30_000, 'the memory Pause to be written').catch(() => null);
  check('memory_pause_written', !!written && written.paused_by === 'host:memory' && written.pause_mode === 'hard' && /"reason":"memory"/.test(written.pause_auto ?? ''), written ? `paused_by=${written.paused_by} mode=${written.pause_mode} pause_auto=${String(written.pause_auto).slice(0, 120)} ${Date.now() - tPause} ms after the critical sample` : 'nothing was paused 30 s after the critical sample');
  const done = written ? await trapDone() : null;
  check('trap_finished', !!done, done ? `trap done ${Number(done.pause_trap_at) - tPause} ms after the critical sample` : 'never stamped');
  await sleep(1500);
  const leftover = A.markers.filter((n) => sleepersOf(n).length > 0);
  check('no_surviving_tool_procs', !!written && leftover.length === 0, leftover.length ? `still alive: sleep ${leftover.join(',')}` : `sleep ${A.markers.join(',')} all gone`);
  check('cli_and_keeper_alive', sessionAlive(), `keeper ${keeper.pid} / CLI ${cli0.pid} alive with their original start-times (sessions intact)`);
  const st = status();
  check('run_status_says_paused', !!st.pause && st.pause.runId === 'lead' && st.pause.pausedBy === 'host:memory', `run status pause=${JSON.stringify(st.pause ?? null).slice(0, 160)}`);
  const w1row = st.bilan?.find((r) => r.wsId === 'w1');
  const killedCmds = [...(w1row0(st)?.killed?.killed ?? []), ...(w1row0(st)?.activity?.observerKilled ?? []), ...(w1row0(st)?.activity?.earlierKilled ?? [])].map((k) => k.cmd);
  check('trap_killed_what_survives_an_interrupt', !!written && A.mustKill.every((c) => killedCmds.some((k) => k.includes(c))), `the Bilan lists killed commands ${JSON.stringify(A.mustKill)} (a background task + a daemonized job outlive an interrupt): got [${killedCmds.join(' | ')}]`);
  check('bilan_w1_recorded', !!written && !!w1row && !!w1row.snapshotRef && !w1row.error, w1row ? `w1: ref=${w1row.snapshotRef} dirty=${w1row.dirty} interrupt=${w1row.activity?.interrupt} error=${w1row.error}` : 'no Bilan row for w1');
  // the session is still RESUMABLE (a human prompt is allowed while paused and un-pauses nothing)
  const liveApp = app;
  const tHuman = Date.now();
  liveApp.send({ cmd: 'human-send', ws: 'w1', text: 'SCN:resume' });
  const te = written ? await waitFor(() => liveApp.events.find((e) => e.ev === 'turn-end' && e.ws === 'w1' && e.t >= tHuman), 90_000, 'the resume turn-end').catch(() => null) : null;
  check('session_resumable', !!te && te.isError !== true, te ? `turn-end stopReason=${te.stopReason} isError=${te.isError}` : 'no turn-end for the human prompt');

  if (mode === 'takeover') {
    const before = carrier();
    const t = cli('run', 'pause', '--hard', '--run', 'lead', '--as', 'lead'); // a coordinator re-asserts the pause already in force: it takes it over (pause_auto cleared)
    check('takeover_accepted', t.rc === 0, `rc=${t.rc} ${t.out.trim().slice(0, 140)}`);
    const after = carrier();
    check('takeover_makes_it_manual', !!after && after.paused_at === before?.paused_at && after.pause_auto === null, `paused_at kept (${after?.paused_at}), pause_auto ${before?.pause_auto ? 'cleared' : 'was already empty'} → ${after?.pause_auto}`);
    g = await ask({ cmd: 'memory', gb: 8 });
    check('guard_liftable_control', g.snap.pause === 'none' && g.snap.admission === 'open', JSON.stringify(g.snap));
    await sleep(TICK_WAIT_MS + 3_000);
    const c = carrier();
    check('takeover_stays_manual_after_recovery', !!c && c.paused_at === after?.paused_at && c.resume_started_at === null && repriseRows().length === 0, `still paused, not resuming, ${repriseRows().length} reprise row(s) after recovery`);
    check('rig_ran_to_completion', true, '');
    return;
  }

  // hysteresis: back between the thresholds — the Pause is NOT lifted
  g = await ask({ cmd: 'memory', gb: 4.5 });
  await sleep(TICK_WAIT_MS);
  check('pause_stays_between_thresholds', carrier()?.resume_started_at === null && !!carrier()?.paused_at && repriseRows().length === 0, `memory 4.5 GB (above critical, below Admission): still paused, no Reprise (${gone('carrier', carrier())})`);

  // recovery above the Admission threshold → the AUTOMATIC Reprise
  g = await ask({ cmd: 'memory', gb: 8 });
  if (mode === 'wakeoff') {
    check('guard_liftable_control', g.snap.pause === 'none' && g.snap.admission === 'open', JSON.stringify(g.snap));
    const held = await waitFor(() => { const c = carrier(); return /"held"/.test(c?.pause_auto ?? '') ? c : null; }, 40_000, 'the Reprise to be HELD').catch(() => null);
    const hold = held ? JSON.parse(held.pause_auto).held : null;
    check('reprise_held_not_started_blind', !!held && held.resume_started_at === null && hold?.motive === 'memory' && Array.isArray(hold.addressees) && hold.addressees.length > 0, held ? `held=${JSON.stringify(hold)} resume_started_at=${held.resume_started_at}` : 'never held (the Reprise either started blind or the guard never lifted)');
    const told = withRo((db) => ({ escalations: db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'escalation'").get().c, gates: db.prepare('SELECT COUNT(*) AS c FROM decision_gates').get().c }));
    check('hold_escalated_once', told.escalations + told.gates === 1, `escalations=${told.escalations} gates=${told.gates} (told ONCE: the nearest ancestor coordinator or the human)`);
    await sleep(TICK_WAIT_MS);
    const again = withRo((db) => db.prepare("SELECT (SELECT COUNT(*) FROM messages WHERE kind = 'escalation') + (SELECT COUNT(*) FROM decision_gates) AS c").get().c);
    check('hold_not_re_told_each_tick', again === 1 && repriseRows().length === 0 && carrier()?.resume_started_at === null, `after another level tick: told ${again} time(s), ${repriseRows().length} reprise row(s), still paused`);
    const lift = cli('run', 'resume', '--run', 'lead', '--as', 'lead'); // the human's way out of a held Reprise
    check('manual_resume_still_works', lift.rc === 0 && /REPRISE STARTED|LIFTED/.test(lift.out), `rc=${lift.rc} ${lift.out.trim().slice(0, 120)}`);
    check('rig_ran_to_completion', true, '');
    return;
  }
  check('guard_liftable_control', g.snap.pause === 'none' && g.snap.admission === 'open', `the guard itself says the memory Pause is liftable: ${JSON.stringify(g.snap)}`);
  const resuming = await waitFor(() => { const c = carrier(); return c?.resume_started_at ? c : null; }, 40_000, 'the automatic Reprise to start').catch(() => null);
  check('auto_reprise_after_recovery', !!resuming, resuming ? `RESUMING since ${resuming.resume_started_at}` : 'never resumed 40 s after memory recovered');
  await sleep(1500);
  const rows = repriseRows();
  const to = new Set(rows.map((r) => r.recipient));
  check('reprise_is_the_hosts_coordinators_first', !!resuming && rows.length > 0 && rows.every((r) => r.sender === 'host') && to.has('lead') && to.has('ops') && !to.has('w1'), `reprise rows: ${JSON.stringify(rows)} (the coordinators lead + ops, from the host; the worker w1 stays blocked until its OPS releases it)`);
  const rel = cli('run', 'release', 'w1', '--run', 'ops', '--as', 'ops');
  check('ops_releases_its_worker', rel.rc === 0 && /Released 1 member\(s\): w1/.test(rel.out), `rc=${rel.rc} ${rel.out.trim().slice(0, 120)}`);
  const active = await waitFor(() => (carrier()?.paused_at === null ? true : null), 30_000, 'the run to be active again').catch(() => null);
  check('run_active_again', !!active, `${gone('carrier', carrier())}`);
  check('session_still_same', sessionAlive(), 'the same keeper + CLI after the whole episode');
  check('rig_ran_to_completion', true, '');
}
