// The verdict of one session-identity arm (#379): PURE over the facts identity-runner.mjs measured (ground truth: /proc, the bus
// db, session-keys.json, files, the fake API's recorded tool results). `judge(arm, facts)` -> [{id, ok, why}]. Clause ids are the
// names the README and the must-FAIL runs refer to. A clause reads ONLY the facts it names, so a master failure is attributable.
// `selftest.mjs` proves every clause can fail (a mutated copy of a known-good facts object reds exactly that clause).

export const ARMS = ['same_turn', 'superseded', 'app_closed', 'attach_keeps_key', 'restart_window'];

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameId = (a, b) => !!a && !!b && a.pid === b.pid && a.start === b.start;
const clause = (id, ok, why) => ({ id, ok: !!ok, why: ok ? '' : why });

/** Clauses every arm shares: the key never at rest / in output, the instrument saw the files, nothing survived. */
function common(f) {
  const l = f.leak ?? {};
  return [
    clause('e2_key_not_at_rest', l.keysChecked >= 1 && l.filesScanned > 0 && l.canaryFound === true && (l.files ?? []).length === 0,
      l.keysChecked < 1 ? 'no session key was read from the live CLI env — nothing to look for'
        : l.canaryFound !== true ? 'the scanner did not find a planted canary — the instrument is blind'
          : `the key string appears in file(s): ${(l.files ?? []).join(', ')}`),
    clause('e3_key_not_in_output', !l.apiRequests && !l.runnerOutput && !l.handOutput,
      `the key string appears in: ${[l.apiRequests && 'model requests', l.runnerOutput && 'runner stdout/stderr', l.handOutput && 'hand-run CLI output'].filter(Boolean).join(', ')}`),
    clause('z_no_survivors', (f.survivors ?? ['?']).length === 0 && f.hostSurvivors === 0,
      `survivors after teardown: ${JSON.stringify(f.survivors)} · host-side processes still carrying the scratch HOME: ${f.hostSurvivors}`),
    clause('z_script_intact', !(f.scriptErrors ?? []).length && !(f.unrouted ?? false), `fake-model script errors: ${JSON.stringify(f.scriptErrors)} unrouted=${f.unrouted}`),
  ];
}

const tr = (f, id) => f.toolResults?.[id];
const rcOk = (r) => !!r && r.rc === '0' && r.isError === false;

function promoteArm(f, tag) {
  const e = f.env ?? {};
  const nr = f.noRestart ?? {};
  const sendId = `toolu_${tag}_send`;
  const out = [
    clause('a1_key_in_cli_env', e.keyLen === 64 && e.keyHex === true && e.envWsId === f.memberId, `the live CLI's env (workspace ${e.envWsId}) carries a session key of length ${e.keyLen} (want 64 hex) — ORCHESTRA_SESSION_KEY absent`),
    clause('a2_env_stale_after_promote', e.envRunId === f.leadId && !!f.memberRun,
      `CLI env ORCHESTRA_RUN_ID=${e.envRunId} (want the LEAD's ${f.leadId}) · member's own run row ${f.memberRun ? 'exists' : 'MISSING — the promote did not happen'}`),
    clause('b1_promote_rc0', rcOk(tr(f, `toolu_${tag}_promote`)), `promote tool_result: ${JSON.stringify(tr(f, `toolu_${tag}_promote`))}`),
  ];
  if (tag === 'si') {
    out.push(
      clause('b2_send_rc0', rcOk(tr(f, sendId)), `send tool_result: ${JSON.stringify(tr(f, sendId))}`),
      clause('c_row_in_new_run', (f.rows ?? []).length === 1 && f.rows[0].run_id === f.memberId && f.rows[0].run_id !== f.leadId,
        (f.rows ?? []).length === 0 ? `no 'same-turn-379' row on the bus — the send did not land (tool_result: ${JSON.stringify(tr(f, sendId))})`
          : `row(s) landed in run ${JSON.stringify((f.rows ?? []).map((r) => r.run_id))}, want exactly one in the MEMBER's own run ${f.memberId} (not the LEAD's ${f.leadId})`),
      clause('d1_no_restart_processes', nr.keeperSame === true && nr.cliSame === true && nr.cliCountStart === 1 && nr.cliCountEnd === 1,
        `keeper/CLI identity changed across the turn: ${JSON.stringify(nr)}`),
      clause('d2_same_session_id', !!nr.sessionIdStart && nr.sessionIdStart === nr.sessionIdMid && nr.sessionIdMid === nr.sessionIdEnd,
        `sdkSessionId changed across the turn: ${JSON.stringify([nr.sessionIdStart, nr.sessionIdMid, nr.sessionIdEnd])}`),
      clause('e1_registry_hash', e.hashMatches === true && e.registryMode === '600' && eq(e.registryEntries, [f.memberId]),
        `session-keys.json: sha256(env key) matches=${e.hashMatches} mode=${e.registryMode} entries=${JSON.stringify(e.registryEntries)} (want match, 600, [${f.memberId}])`),
    );
  } else {
    const hd = f.hostDown ?? {};
    const send = tr(f, 'toolu_ac_send');
    out.push(
      clause('p1_host_is_down', hd.sockFileExists === false && hd.connectable === false, `after stopHooksServer(): socket file exists=${hd.sockFileExists}, connectable=${hd.connectable}`),
      clause('p2_marker_names_new_run', f.marker?.newRun === f.memberId, `bus-run-stale marker: ${JSON.stringify(f.marker)} (want 'new run: ${f.memberId}')`),
      clause('p3_session_survived_app_close', nr.keeperSame === true && nr.cliSame === true && nr.cliCountEnd === 1, `keeper/CLI identity changed: ${JSON.stringify(nr)}`),
      clause('s1_send_refused_by_marker', !!send && send.rc === '1' && /stale run/i.test(send.text) && !/superseded/i.test(send.text), `send tool_result: ${JSON.stringify(send)} (want rc 1 + 'stale run')`),
      clause('s2_refused_send_wrote_no_row', (f.rows ?? []).length === 0, `rows for 'app-closed-379': ${JSON.stringify(f.rows)}`),
      clause('s3_check_allowed', rcOk(tr(f, 'toolu_ac_check')), `check tool_result: ${JSON.stringify(tr(f, 'toolu_ac_check'))} (want rc 0)`),
      clause('e1_registry_hash', e.hashMatches === true && e.registryMode === '600', `session-keys.json: sha256(env key) matches=${e.hashMatches} mode=${e.registryMode}`),
    );
  }
  return out;
}

function supersededArm(f) {
  const o = f.old ?? {}, n = f.new ?? {};
  const refused = (r) => !!r && r.rc === 1 && /superseded/i.test(r.stderr) && !/could not reach|unreachable/i.test(r.stderr);
  return [
    clause('a1_old_key_was_live', o.keyLen === 64 && o.hashMatches === true, `session 1: key length ${o.keyLen}, registry hash matched=${o.hashMatches} (want 64, true)`),
    clause('a2_fresh_session', f.distinctKeys === true && !!o.cli && !!n.cli && !sameId(o.cli, n.cli) && f.oldCliGone === true,
      `old CLI ${JSON.stringify(o.cli)} → new CLI ${JSON.stringify(n.cli)}, keys distinct=${f.distinctKeys}, old CLI gone=${f.oldCliGone}`),
    clause('a3_registry_holds_new_hash_only', f.registryHoldsNewHash === true && f.registryHoldsOldHash === false && eq(n.registryEntries, [f.memberId]) && f.leakExtra?.oldKeyInRegistry === false,
      `registry: new hash=${f.registryHoldsNewHash} old hash=${f.registryHoldsOldHash} entries=${JSON.stringify(n.registryEntries)}`),
    clause('h1_host_refuses_old_key', f.hostOld?.ok === false && f.hostOld?.code === 'superseded', `host /identity for the OLD key: ${JSON.stringify(f.hostOld)}`),
    clause('h2_host_answers_new_key', f.hostNew?.ok === true && f.hostNew?.runId === f.leadId, `host /identity for the NEW key: ${JSON.stringify(f.hostNew)}`),
    clause('r1_old_send_refused', refused(f.handOld?.send), `hand-run send with the old env: ${JSON.stringify(f.handOld?.send)} (want rc 1 + 'superseded')`),
    clause('r2_old_check_refused', refused(f.handOld?.check), `hand-run check with the old env: ${JSON.stringify(f.handOld?.check)} (want rc 1 + 'superseded')`),
    clause('r3_old_send_wrote_no_row', f.handOld?.rowsBefore === 0 && f.handOld?.rowsAfter === 0, `rows for 'stale-key-379': ${f.handOld?.rowsBefore} → ${f.handOld?.rowsAfter}`),
    clause('r4_control_host_vouches_new_key', f.handNew?.check?.rc === 0 && f.handNew?.check?.run === f.leadId, `hand-run check with the NEW key and a wrong env run: ${JSON.stringify(f.handNew?.check)} (want rc 0 and run = the host's ${f.leadId})`),
    clause('n1_new_session_send_lands', rcOk(tr(f, 'toolu_sup_send')) && (f.rows ?? []).length === 1 && f.rows[0].run_id === f.leadId,
      `new session's own send: tool_result ${JSON.stringify(tr(f, 'toolu_sup_send'))}, rows ${JSON.stringify(f.rows)} (want one in the LEAD run ${f.leadId})`),
  ];
}

/** MAJOR-1 of the #379 review: a coordinator's `restart --fresh` bumps the generation and starts NO session; the replaced session's key must stop vouching AT the bump. */
function restartWindowArm(f) {
  const o = f.old ?? {};
  const w = f.handOld ?? {};
  return [
    clause('a1_zombie_env_is_stale', o.keyLen === 64 && o.hashMatches === true && o.envRunId === f.memberId && o.envGeneration === '1',
      `the first session's env: key length ${o.keyLen} (registry match ${o.hashMatches}), run ${o.envRunId} (want ${f.memberId}), generation ${o.envGeneration} (want '1' — baked after one earlier replacement)`),
    clause('b1_generation_bumped', f.genBefore === 1 && f.genAfterRestart === 2, `coordinator generation ${f.genBefore} → ${f.genAfterRestart} (want 1 → 2: the production sdkRestart bump)`),
    clause('b2_window_is_open', f.midCliCount === 0, `${f.midCliCount} CLI process(es) after the --fresh restart — the successor must not exist yet (the window the zombie lives in)`),
    clause('b3_key_revoked_at_bump', f.registryEntryAfterBump === false, `session-keys.json still holds an entry for the member after the bump (the replaced key still vouches)`),
    clause('h1_host_cannot_vouch_in_window', f.hostOldWindow?.ok === false && f.hostOldWindow?.code === 'unregistered', `host /identity for the replaced key inside the window: ${JSON.stringify(f.hostOldWindow)} (want unregistered — never the new generation)`),
    clause('z1_zombie_send_fenced', w.send?.rc === 1 && /stale coordinator generation/i.test(w.send?.stderr ?? ''), `hand-run send with the replaced session's env (key, generation 1) inside the window: ${JSON.stringify(w.send)} (want rc 1 + 'stale coordinator generation')`),
    clause('z2_zombie_wrote_no_row', w.rowsBefore === 0 && w.rowsAfter === 0, `rows for 'zombie-window-379': ${w.rowsBefore} → ${w.rowsAfter}`),
    clause('n1_successor_send_lands', rcOk(tr(f, 'toolu_rw_send')) && (f.rows ?? []).length === 1 && f.rows[0].run_id === f.memberId, `successor's own send: ${JSON.stringify(tr(f, 'toolu_rw_send'))}, rows ${JSON.stringify(f.rows)} (want one in the member's own run ${f.memberId})`),
    clause('n2_successor_key_registered', f.distinctKeys === true && f.registryHoldsNewHash === true && f.registryHoldsOldHash === false, `distinct keys=${f.distinctKeys}, registry holds new=${f.registryHoldsNewHash} old=${f.registryHoldsOldHash}`),
    clause('r1_old_key_superseded_after_successor', f.hostOldAfter?.ok === false && f.hostOldAfter?.code === 'superseded', `host /identity for the replaced key after the successor registered: ${JSON.stringify(f.hostOldAfter)}`),
  ];
}

function attachArm(f) {
  const p1 = f.phase1 ?? {}, e = f.env ?? {}, r0 = f.registryAtStart ?? {}, r1 = f.registryAtEnd ?? {};
  return [
    clause('a1_k1_registered_before_quit', p1.env?.keyLen === 64 && p1.env?.hashMatches === true, `app instance 1: key length ${p1.env?.keyLen}, registry hash matched=${p1.env?.hashMatches}`),
    clause('a2_reattached_to_the_surviving_cli', f.attached === true && f.attachSettled === true && f.hasSessionBeforeAttach === false && f.hasSessionAfterAttach === true
      && sameId(p1.procs?.keeper, f.procs?.keeper) && sameId(p1.procs?.cli?.[0], f.procs?.cli?.[0]) && (f.procs?.cli ?? []).length === 1 && !!f.sessionAfter && f.sessionAfter === p1.sdkSessionId,
    `attached=${f.attached} (session before/after: ${f.hasSessionBeforeAttach}/${f.hasSessionAfterAttach}) · keeper ${JSON.stringify(p1.procs?.keeper)}→${JSON.stringify(f.procs?.keeper)} · CLI ${JSON.stringify(p1.procs?.cli)}→${JSON.stringify(f.procs?.cli)} · session id same=${f.sessionAfter === p1.sdkSessionId}`),
    clause('b1_registry_unchanged_by_attach', !!r0.hash && r0.hash === p1.env?.keySha && e.registryHash === r0.hash && e.registryIssuedAt === p1.env?.registryIssuedAt && r1.hash === r0.hash && r1.issuedAt === r0.issuedAt && eq(r1.entries, [f.memberId]),
      `registry hash at start ${r0.hash?.slice(0, 8)} (K1 ${p1.env?.keySha?.slice(0, 8)}) · after attach ${e.registryHash?.slice(0, 8)} · at end ${r1.hash?.slice(0, 8)} · issuedAt ${p1.env?.registryIssuedAt}→${e.registryIssuedAt}→${r1.issuedAt}`),
    clause('b2_live_cli_still_holds_k1', e.keyLen === 64 && e.keySha === p1.env?.keySha && e.hashMatches === true && r1.hashMatches === true,
      `the live CLI's key sha ${e.keySha?.slice(0, 8)} vs K1 ${p1.env?.keySha?.slice(0, 8)} (sha256 matches the registry after the attach / at the end: ${e.hashMatches}/${r1.hashMatches})`),
    clause('c1_host_accepts_k1_after_attach', f.hostLive?.ok === true && f.hostLive?.runId === f.leadId, `host /identity for K1 after the reattach: ${JSON.stringify(f.hostLive)}`),
    clause('c2_host_refuses_a_random_key', f.hostRandom?.ok === false && f.hostRandom?.code === 'superseded', `host /identity for a random key: ${JSON.stringify(f.hostRandom)} (negative control)`),
    clause('c3_hand_cli_k1_resolved_by_host', f.handLive?.check?.rc === 0 && f.handLive?.check?.run === f.leadId, `hand-run check with K1 and a wrong env run: ${JSON.stringify(f.handLive?.check)} (want rc 0 and run = the host's ${f.leadId})`),
    clause('c4_reattached_session_send_lands', rcOk(tr(f, 'toolu_att_send')) && (f.rows ?? []).length === 1 && f.rows[0].run_id === f.leadId,
      `reattached session's own send: tool_result ${JSON.stringify(tr(f, 'toolu_att_send'))}, rows ${JSON.stringify(f.rows)}`),
  ];
}

export function judge(arm, f) {
  const arms = {
    same_turn: () => promoteArm(f, 'si'),
    app_closed: () => promoteArm(f, 'ac'),
    superseded: () => supersededArm(f),
    attach_keeps_key: () => attachArm(f),
    restart_window: () => restartWindowArm(f),
  };
  if (!arms[arm]) throw new Error(`unknown arm ${arm}`);
  return [...arms[arm](), ...common(f)];
}

/** `SESSION-IDENTITY <arm>: PASS|FAIL` (never PASS from an empty clause list). */
export function terminator(arm, clauses) {
  return `SESSION-IDENTITY ${arm}: ${clauses.length > 0 && clauses.every((c) => c.ok) ? 'PASS' : 'FAIL'}`;
}
