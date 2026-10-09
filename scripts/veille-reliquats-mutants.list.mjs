// #326 (wave H) — the in-place mutants for Veille and Reliquats, one per changed clause. Run by scripts/veille-reliquats-mutants.mjs (byte-exact backup → apply → run the tests → restore → cmp;
// `--rig` kills the marked ones against the light rig scripts/e2e-hibernate-wake.mjs `reliquat_*`). [id, file, [[find, replace]...], tests that must go red, note]. Anchors are JS strings.

export const VT = {
  rule: 'src/shared/hibernation.test.ts',
  notice: 'src/shared/veille-reliquats.test.ts',
  judge: 'src/main/veille-reliquats.test.ts',
  port: 'src/main/veille-reliquats-port.test.ts',
  wiring: 'src/main/veille-reliquats-wiring.test.ts',
  fastw: 'src/main/hibernation-fast-veille-wiring.test.ts',
  settings: 'src/shared/memory-guard.test.ts',
  browser: 'src/main/browser-reliquats.test.ts',
};

/** mutant id → the rig arm (scripts/e2e-hibernate-wake.mjs) that must go red on it too. */
export const VT_RIG_ARM = {
  V1: 'reliquat_10min', V2: 'reliquat_none_5min', V5: 'reliquat_fast',
  J4: 'reliquat_10min', J5: 'reliquat_fast', J7: 'reliquat_31min', J3: 'reliquat_unknown',
  P2: 'reliquat_unknown', S1: 'reliquat_delay_hot',
  S2: 'reliquat_overlap', S3: 'reliquat_woken_after_stop', S4: 'reliquat_again_false', S8: 'reliquat_census_race', R1: 'reliquat_scopeless', R3: 'reliquat_woken_during_stop', S7: 'reliquat_woken_during_stop',
};

export function veilleMutants(T = VT) {
  const RULE = 'src/shared/hibernation.ts';
  const NOTICE = 'src/shared/veille-reliquats.ts';
  const JUDGE = 'src/main/veille-reliquats.ts';
  const PORT = 'src/main/veille-reliquats-port.ts';
  const SWEEP = 'src/main/hibernation.ts';
  const SET = 'src/shared/memory-guard.ts';
  return [
    // ── the pure rule ───────────────────────────────────────────────────────────────────────────────────────────────────
    ['V1', RULE, [['return now - lastActivityAt >= effectiveVeilleWaitMs(thresholdMs, liveReliquats, reliquatDelayMs);', 'return now - lastActivityAt >= thresholdMs;']], [T.rule], 'a member with live Reliquats is not made to wait (the delay is ignored); rig: reliquat_10min'],
    ['V2', RULE, [['if (liveReliquats > 0 && Number.isFinite(reliquatDelayMs) && reliquatDelayMs > thresholdMs) return reliquatDelayMs;', 'if (liveReliquats >= 0 && Number.isFinite(reliquatDelayMs) && reliquatDelayMs > thresholdMs) return reliquatDelayMs;']], [T.rule], 'EVERY member waits the Reliquat delay, with or without Reliquats; rig: reliquat_none_5min'],
    ['V3', RULE, [['liveReliquats > 0 && Number.isFinite(reliquatDelayMs) && ', 'liveReliquats > 0 && ']], [T.rule], 'a garbage (Infinity) delay waits for ever'],
    ['V4', RULE, [['reliquatDelayMs > thresholdMs) return reliquatDelayMs;', 'reliquatDelayMs > 0) return reliquatDelayMs;']], [T.rule], 'a delay SHORTER than the threshold shortens the wait (unit-only: the rig runs a 30-min delay)'],
    ['V5', RULE, [['if (admissionHeld && isFleetMember(ws)) return true;', 'if (admissionHeld && isFleetMember(ws) && liveReliquats === 0) return true;']], [T.rule], 'fast Veille is delayed by Reliquats (R10: it must NOT be); rig: reliquat_fast'],
    // ── the verdict ─────────────────────────────────────────────────────────────────────────────────────────────────────
    ['J1', JUDGE, [["if (!shouldHibernate(ws, { ...signals, liveReliquats: 0 })) return { hibernate: false, why: 'not-eligible' };", '']], [T.judge], 'a census is paid for every member, eligible or not'],
    ['J2', JUDGE, [["if (!deps.port) return { hibernate: true, liveReliquats: 0, stopped: false, report: null, told: false, fast: false };", "if (!deps.port) return { hibernate: false, why: 'not-eligible' };"]], [T.judge], 'no port registered ⇒ no Veille at all (today\'s behaviour lost)'],
    ['J3', JUDGE, [["if (live === 'unknown') {", "if ((live as unknown) === 'never') {"]], [T.judge], 'an UNKNOWN census is read as a count (waits / kills on a guess); rig: reliquat_unknown'],
    ['J4', JUDGE, [['if (!shouldHibernate(ws, { ...signals, liveReliquats: live })) {', 'if (false as boolean) {']], [T.judge], 'the Reliquat delay is skipped: Reliquats are stopped as soon as the normal threshold passes; rig: reliquat_10min'],
    ['J5', JUDGE, [['const fast = signals.admissionHeld && !shouldHibernate(ws, { ...signals, admissionHeld: false, liveReliquats: live });', 'const fast = false;']], [T.judge], 'a fast Veille is worded as plain idleness; rig: reliquat_fast'],
    ['J6', JUDGE, [['if (report && (report.unknown || report.error || report.aborted)) {', 'if (false as boolean) {']], [T.judge], 'a stop that could not look still lets the member go to Veille'],
    ['J7', JUDGE, [['const told = veilleHasNews(report) ? await tellOnce(', 'const told = false ? await tellOnce(']], [T.judge], 'the member is never told what was stopped; rig: reliquat_31min'],
    ['J8', JUDGE, [["return { hibernate: false, why: 'reliquat-stop-incomplete', liveReliquats: live, detail: e instanceof Error ? e.message : String(e) };", "return { hibernate: true, liveReliquats: live, stopped: true, report: null, told: false, fast };"]], [T.judge], 'a stop that THROWS lets the Veille go on'],
    ['J9', JUDGE, [['if (!ok) deps.warn(', 'if (false as boolean) deps.warn(']], [T.judge], 'a notice that could not be queued is lost silently'],
    // ── the notice ──────────────────────────────────────────────────────────────────────────────────────────────────────
    ['N1', NOTICE, [["r.killed.some((k) => k.outcome !== 'planned')", 'r.killed.length > 0']], [T.notice], 'a `planned` kill that never completed is announced as a stop'],
    ['N2', NOTICE, [["const why = ctx.fast ? 'early, to free memory (Admission is held)' : `because you had been idle for", "const why = false ? 'early' : `because you had been idle for"]], [T.notice], 'fast Veille worded as idleness'],
    ['N3', NOTICE, [['    const c = strip(s);', '    const c = String(s);']], [T.notice], 'a command line can forge a line in the member\'s prompt (control characters kept)'],
    ['N4', NOTICE, [["    lines.push(...reliquatKilledItemLines(done, n, strip, 'see the Orchestra log'));", '']], [T.notice], 'the stopped processes are not LISTED'],
    ['N5', NOTICE, [['  for (const s of r.survivors.slice(0, LISTED))', '  for (const s of [] as typeof r.survivors)']], [T.notice], 'a Reliquat the Veille could not stop is not said'],
    ['N6', NOTICE, [["lines.push(`Orchestra looked at your leftover processes (Reliquats) ${why}; it stopped none of them:`);", "lines.push(`Orchestra stopped 0 leftover process(es) of yours (Reliquats) ${why}:`);"]], [T.notice], 'a notice with nothing stopped claims a stop'],
    // ── the port ────────────────────────────────────────────────────────────────────────────────────────────────────────
    ['P1', PORT, [['if (judgeReliquat(m.pid, m.startTicks, scope, listing, protect, kill.read).ok) n++;', 'n++;']], [T.port], 'a spared / protected process counts as a Reliquat (the member waits for nothing) — unit-only (the rig scope holds no spared process)'],
    ['P2', PORT, [["if (listing === 'unreadable') return 'unknown';", 'if (listing === \'unreadable\') continue;']], [T.port], 'an unreadable cgroup.procs reads as « no Reliquat » (UNKNOWN is not NONE); rig: reliquat_unknown'],
    ['P3', PORT, [["if (f !== 'gone' && f !== 'unreadable' && isOwnKeeperProc(f, wsId)) return 'unknown';", '']], [T.port], 'the member\'s own keeper listed as a Reliquat (pid file not published) is counted'],
    ['P4', PORT, [["      if (who && 'error' in who) return 'unknown';", '']], [T.port], 'a failed keeper/CLI resolution is ignored by the census'],
    ['P5', PORT, [["if (who && 'error' in who) return { ...emptyReliquatReport(), unknown: who.error };", '']], [T.port], 'the stop goes on without proving which processes are the session'],
    ['P6', PORT, [['if (scopes.length === 0) return countBrowsers(wsId);', 'if (true as boolean) return countBrowsers(wsId);']], [T.port], 'the browsers answer for a member that HAS a scope'],
    ['P7', PORT, [['      return scoped ?? stopBrowsers(wsId, ctx);', '      return scoped;']], [T.port], 'a member whose scope vanished mid-stop forgets its browser Reliquats (the scope-less path returns earlier, the rig cannot reach this one)'],
    ['P8', PORT, [["const scoped = await killReliquats(wsId, deps, kill, { keeperPid, cliPid, startedBeforeMs,", "const scoped = await killReliquats(wsId, deps, kill, { keeperPid: null, cliPid: null, startedBeforeMs,"]], [T.port, T.wiring], 'the member\'s keeper / CLI are not protected from the stop'],
    // ── the sweep ───────────────────────────────────────────────────────────────────────────────────────────────────────
    ['S1', SWEEP, [['store.getMemoryGuardSettings().reliquatWaitMin * 60_000', 'store.getMemoryGuardSettings().reliquatWaitMin * 1_000']], [T.wiring], 'the setting is read in seconds; rig: reliquat_delay_hot'],
    ['S2', SWEEP, [['    veilleBusy.add(ws.id);\n', '']], [T.wiring, T.fastw], 'an overlapping pass judges / stops / tells the same member twice'],
    ['S3', SWEEP, [['if ((wakeEpoch.get(ws.id) ?? 0) !== epochBefore || isBeingDeleted(ws.id)) {', 'if (false as boolean) {']], [T.wiring], 'a member woken or deleted while its verdict was awaited is hibernated anyway'],
    ['S4', SWEEP, [['      if (!again) {', '      if (false as boolean) {']], [T.wiring], 'a member that started a turn while its Reliquats were being stopped is hibernated anyway'],
    ['S5', SWEEP, [['    if (!liveSdkNow && !livePtyNow) continue;', '']], [T.wiring, T.fastw], 'a session stopped meanwhile is marked hibernated'],
    ['S6', SWEEP, [['        port: veillePort,\n', '        port: null,\n']], [T.wiring], 'the registered port is never consulted'],
    // ── the setting ─────────────────────────────────────────────────────────────────────────────────────────────────────
    ['M1', SET, [['export const DEFAULT_RELIQUAT_WAIT_MIN = 30;', 'export const DEFAULT_RELIQUAT_WAIT_MIN = 5;']], [T.settings], 'the default wait is not 30 minutes'],
    ['M2', SET, [['reliquatWaitMin: patch.reliquatWaitMin ?? current.reliquatWaitMin,', 'reliquatWaitMin: current.reliquatWaitMin,']], [T.settings], 'a patch cannot change the wait (it is not applied hot)'],
    ['M3', SET, [['s.reliquatWaitMin > MAX_RELIQUAT_WAIT_MIN) return', 's.reliquatWaitMin > 1e9) return']], [T.settings], 'an absurd wait is accepted'],
    ['M4', SET, [['    reliquatWaitMin: candidate.reliquatWaitMin,\n  };', '    reliquatWaitMin: DEFAULT_RELIQUAT_WAIT_MIN,\n  };']], [T.settings], 'an invalid thresholds pair resets the Reliquat wait too'],
    // ── review fixes ────────────────────────────────────────────────────────────────────────────────────────────────────
    ['R1', PORT, [['      if (scopes.length === 0) return stopBrowsers(wsId, ctx);\n', '']], [T.port, T.wiring], 'a scope-less member\'s stop asks the keeper / CLI identity (an unresponsive keeper keeps it awake for ever); rig: reliquat_scopeless'],
    ['R2', PORT, [['{ keeperPid, cliPid, startedBeforeMs, ...(ctx?.stillWanted', '{ keeperPid, cliPid, ...(ctx?.stillWanted']], [T.port, T.wiring], 'what the member started after the stop began (it woke) is killed too'],
    ['R3', PORT, [['...(ctx?.stillWanted ? { stillPaused: ctx.stillWanted } : {}) });', '});']], [T.port, T.wiring], 'a wake / delete during the stop does not end the signal rounds; rig: reliquat_woken_during_stop'],
    ['R4', JUDGE, [['report = await deps.port.stop(ws.id, { stillWanted: deps.stillWanted ?? (() => true) });', 'report = await deps.port.stop(ws.id);']], [T.judge], 'the sweep\'s « still wanted » check never reaches the stop'],
    ['R5', JUDGE, [['if (report && (report.unknown || report.error || report.aborted)) {', 'if (report && (report.unknown || report.error)) {']], [T.judge], 'a stop aborted by a wake lets the Veille go on'],
    ['S7', SWEEP, [['        stillWanted: () => (wakeEpoch.get(ws.id) ?? 0) === epochBefore && !isBeingDeleted(ws.id),\n', '']], [T.wiring], 'the sweep never tells the stop that the member woke; rig: reliquat_woken_during_stop'],
    ['S8', SWEEP, [['    {\n      // …and decided again on FRESH state, WHATEVER the verdict awaited', '    if (verdict.stopped) {\n      // …and decided again on FRESH state, WHATEVER the verdict awaited']], [T.wiring], 'the fresh re-check only follows a STOP (a census awaits too: a prompt delivered meanwhile is missed); rig: reliquat_census_race'],
    ['N7', NOTICE, [['lines.push(`Orchestra stopped ${n} leftover process(es) of yours (Reliquats) ${why}', 'lines.push(`Orchestra put you in Veille and stopped ${n} leftover process(es) of yours (Reliquats) ${why}']], [T.notice], 'the notice claims the Veille went through (it may be dropped after the stop)'],
    ['B3', 'src/main/browser-reliquats.ts', [["    let client: ClientState = 'no';\n    if (s.parsed.mode !== 'pipe') {\n      try {\n        const cs = d.clientState(p.pid);", "    let client: ClientState = 'no';\n    if (false as boolean) {\n      try {\n        const cs = d.clientState(p.pid);"]], [T.browser], 'the census never asks the debugging-port client (a spared browser delays a Veille for nothing)'],
    ['B4', 'src/main/resource-monitor.ts', [[".filter((o) => o.client === 'no').length;", '.length;']], [T.wiring], 'the browser count includes browsers a pass would SPARE'],
    // ── the census shares the pass\'s selection ───────────────────────────────────────────────────────────────────────────
    ['B1', 'src/main/browser-reliquats.ts', [['if (!s || s.owner.wsId !== wsId || !d.workspaceKnown(wsId)) continue;', 'if (!s || !d.workspaceKnown(wsId)) continue;']], [T.browser], 'the census counts every workspace\'s orphans'],
    ['B2', 'src/main/browser-reliquats.ts', [['  if (!launcherDead(p.ppid, parent ? { comm: parent.comm, ppid: parent.ppid } : null)) return null; // launcher alive', '']], [T.browser], 'a browser with a LIVE launcher counts as an orphan (and the pass would stop it)'],
  ];
}
