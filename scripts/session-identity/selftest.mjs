// Instrument self-test for judge.mjs (no containers, no claude): a known-good facts object per arm must PASS every clause, and one
// mutation per clause must make THAT clause (and only a named dependent set) FAIL — a clause that cannot fail proves nothing.
//   node scripts/session-identity/run.mjs --selftest
import { ARMS, judge } from './judge.mjs';

const H = (c) => c.repeat(64);
const ID = (pid) => ({ pid, start: String(1000 + pid) });
const KEEPER = ID(20), CLI = ID(27);
const leak = () => ({ keysChecked: 1, filesScanned: 70, files: [], canaryFound: true, apiRequests: false, runnerOutput: false, handOutput: false });
const base = () => ({ leadId: 'L', memberId: 'M', leak: leak(), survivors: [], hostSurvivors: 0 });
const envOk = (over = {}) => ({ keyLen: 64, keyHex: true, keySha: H('a'), envRunId: 'L', envWsId: 'M', registryFile: true, registryMode: '600', registryEntries: ['M'], registryHash: H('a'), registryIssuedAt: 5, hashMatches: true, ...over });
const ok = (o = {}) => ({ isError: false, rc: '0', text: 'ok', ...o });

const GOOD = {
  same_turn: () => ({
    ...base(), env: envOk(), memberRun: { id: 'M' }, rows: [{ run_id: 'M' }],
    toolResults: { toolu_si_promote: ok(), toolu_si_send: ok() },
    noRestart: { keeperSame: true, cliSame: true, cliCountStart: 1, cliCountEnd: 1, sessionIdStart: 's', sessionIdMid: 's', sessionIdEnd: 's' },
  }),
  app_closed: () => ({
    ...base(), env: envOk(), memberRun: { id: 'M' }, rows: [],
    hostDown: { sockFileExists: false, connectable: false }, marker: { newRun: 'M' },
    noRestart: { keeperSame: true, cliSame: true, cliCountStart: 1, cliCountEnd: 1 },
    toolResults: { toolu_ac_promote: ok(), toolu_ac_send: { isError: true, rc: '1', text: 'refused: stale run: ...' }, toolu_ac_check: ok() },
  }),
  superseded: () => ({
    ...base(), distinctKeys: true, oldCliGone: true, registryHoldsNewHash: true, registryHoldsOldHash: false, leakExtra: { oldKeyInRegistry: false },
    old: envOk({ keySha: H('a'), registryHash: H('a'), cli: CLI, keeper: KEEPER }),
    new: envOk({ keySha: H('b'), registryHash: H('b'), cli: ID(40), keeper: ID(33) }),
    hostOld: { ok: false, code: 'superseded' }, hostNew: { ok: true, runId: 'L' },
    handOld: { send: { rc: 1, stderr: 'refused: this session of workspace M was superseded' }, check: { rc: 1, stderr: 'refused: superseded' }, rowsBefore: 0, rowsAfter: 0 },
    handNew: { check: { rc: 0, run: 'L', stderr: '' } },
    toolResults: { toolu_sup_send: ok() }, rows: [{ run_id: 'L' }],
  }),
  restart_window: () => ({
    ...base(), genBefore: 1, genAfterRestart: 2, midCliCount: 0, registryEntryAfterBump: false, distinctKeys: true, registryHoldsNewHash: true, registryHoldsOldHash: false,
    old: envOk({ envRunId: 'M', envGeneration: '1' }),
    hostOldWindow: { ok: false, code: 'unregistered' }, hostOldAfter: { ok: false, code: 'superseded' },
    handOld: { send: { rc: 1, stderr: 'orchestra send: stale coordinator generation: presented 1, but the run is at 2' }, rowsBefore: 0, rowsAfter: 0 },
    toolResults: { toolu_rw_send: ok() }, rows: [{ run_id: 'M' }],
  }),
  attach_keeps_key: () => ({
    ...base(), attached: true, attachSettled: true, hasSessionBeforeAttach: false, hasSessionAfterAttach: true, sessionAfter: 's', env: envOk(),
    procs: { keeper: KEEPER, cli: [CLI] },
    phase1: { env: envOk(), procs: { keeper: KEEPER, cli: [CLI] }, sdkSessionId: 's' },
    registryAtStart: { hash: H('a'), issuedAt: 5 }, registryAtEnd: { hash: H('a'), issuedAt: 5, entries: ['M'], hashMatches: true },
    hostLive: { ok: true, runId: 'L' }, hostRandom: { ok: false, code: 'superseded' }, handLive: { check: { rc: 0, run: 'L' } },
    toolResults: { toolu_att_send: ok() }, rows: [{ run_id: 'L' }],
  }),
};

// clause id -> mutation that must break it (per arm)
const MUT = {
  same_turn: {
    a1_key_in_cli_env: (f) => { f.env.keyLen = 0; f.env.keyHex = false; },
    a2_env_stale_after_promote: (f) => { f.env.envRunId = 'M'; },
    b1_promote_rc0: (f) => { f.toolResults.toolu_si_promote.rc = '1'; },
    b2_send_rc0: (f) => { f.toolResults.toolu_si_send = { isError: true, rc: '1', text: 'refused: stale run' }; },
    c_row_in_new_run: (f) => { f.rows = [{ run_id: 'L' }]; },
    d1_no_restart_processes: (f) => { f.noRestart.cliSame = false; },
    d2_same_session_id: (f) => { f.noRestart.sessionIdEnd = 't'; },
    e1_registry_hash: (f) => { f.env.hashMatches = false; },
    e2_key_not_at_rest: (f) => { f.leak.files = ['home/.claude/x']; },
    e3_key_not_in_output: (f) => { f.leak.runnerOutput = true; },
    z_no_survivors: (f) => { f.survivors = ['cli:1']; },
    z_script_intact: (f) => { f.unrouted = true; },
  },
  app_closed: {
    a1_key_in_cli_env: (f) => { f.env.keyLen = 0; f.env.keyHex = false; },
    a2_env_stale_after_promote: (f) => { f.memberRun = null; },
    b1_promote_rc0: (f) => { f.toolResults.toolu_ac_promote.isError = true; },
    p1_host_is_down: (f) => { f.hostDown.connectable = true; },
    p2_marker_names_new_run: (f) => { f.marker.newRun = null; },
    p3_session_survived_app_close: (f) => { f.noRestart.keeperSame = false; },
    s1_send_refused_by_marker: (f) => { f.toolResults.toolu_ac_send = ok(); },
    s2_refused_send_wrote_no_row: (f) => { f.rows = [{ run_id: 'L' }]; },
    s3_check_allowed: (f) => { f.toolResults.toolu_ac_check = { isError: true, rc: '1', text: 'x' }; },
    e1_registry_hash: (f) => { f.env.registryMode = '644'; },
    e2_key_not_at_rest: (f) => { f.leak.canaryFound = false; },
    e3_key_not_in_output: (f) => { f.leak.apiRequests = true; },
    z_no_survivors: (f) => { f.hostSurvivors = 2; },
    z_script_intact: (f) => { f.scriptErrors = ['boom']; },
  },
  superseded: {
    a1_old_key_was_live: (f) => { f.old.hashMatches = false; },
    a2_fresh_session: (f) => { f.new.cli = f.old.cli; },
    a3_registry_holds_new_hash_only: (f) => { f.registryHoldsOldHash = true; },
    h1_host_refuses_old_key: (f) => { f.hostOld = { ok: true, runId: 'L' }; },
    h2_host_answers_new_key: (f) => { f.hostNew = { ok: false, code: 'superseded' }; },
    r1_old_send_refused: (f) => { f.handOld.send = { rc: 0, stderr: '' }; },
    r2_old_check_refused: (f) => { f.handOld.check = { rc: 1, stderr: 'could not reach Orchestra socket' }; },
    r3_old_send_wrote_no_row: (f) => { f.handOld.rowsAfter = 1; },
    r4_control_host_vouches_new_key: (f) => { f.handNew.check.run = 'ws-si-bogus-env-run'; },
    n1_new_session_send_lands: (f) => { f.rows = []; },
    e2_key_not_at_rest: (f) => { f.leak.files = ['orchestra/logs/x.log']; },
    e3_key_not_in_output: (f) => { f.leak.handOutput = true; },
    z_no_survivors: (f) => { f.survivors = ['keeper:9']; },
    z_script_intact: (f) => { f.unrouted = true; },
  },
  restart_window: {
    a1_zombie_env_is_stale: (f) => { f.old.envGeneration = '0'; },
    b1_generation_bumped: (f) => { f.genAfterRestart = 1; },
    b2_window_is_open: (f) => { f.midCliCount = 1; },
    b3_key_revoked_at_bump: (f) => { f.registryEntryAfterBump = true; },
    h1_host_cannot_vouch_in_window: (f) => { f.hostOldWindow = { ok: true, runId: 'M' }; },
    z1_zombie_send_fenced: (f) => { f.handOld.send = { rc: 0, stderr: '' }; },
    z2_zombie_wrote_no_row: (f) => { f.handOld.rowsAfter = 1; },
    n1_successor_send_lands: (f) => { f.rows = []; },
    n2_successor_key_registered: (f) => { f.registryHoldsOldHash = true; },
    r1_old_key_superseded_after_successor: (f) => { f.hostOldAfter = { ok: true, runId: 'M' }; },
    e2_key_not_at_rest: (f) => { f.leak.files = ['orchestra/logs/x.log']; },
    e3_key_not_in_output: (f) => { f.leak.handOutput = true; },
    z_no_survivors: (f) => { f.survivors = ['keeper:9']; },
    z_script_intact: (f) => { f.unrouted = true; },
  },
  attach_keeps_key: {
    a1_k1_registered_before_quit: (f) => { f.phase1.env.hashMatches = false; },
    a2_reattached_to_the_surviving_cli: (f) => { f.procs.cli = [ID(99)]; },
    b1_registry_unchanged_by_attach: (f) => { f.env.registryHash = H('c'); },
    b2_live_cli_still_holds_k1: (f) => { f.env.keySha = H('d'); },
    c1_host_accepts_k1_after_attach: (f) => { f.hostLive = { ok: false, code: 'superseded' }; },
    c2_host_refuses_a_random_key: (f) => { f.hostRandom = { ok: true, runId: 'L' }; },
    c3_hand_cli_k1_resolved_by_host: (f) => { f.handLive.check.run = 'ws-si-bogus-env-run'; },
    c4_reattached_session_send_lands: (f) => { f.rows = []; },
    e2_key_not_at_rest: (f) => { f.leak.keysChecked = 0; },
    e3_key_not_in_output: (f) => { f.leak.runnerOutput = true; },
    z_no_survivors: (f) => { f.survivors = ['cli:3']; },
    z_script_intact: (f) => { f.scriptErrors = ['boom']; },
  },
};

export function runSelftest() {
  let bad = 0;
  for (const arm of ARMS) {
    const good = judge(arm, GOOD[arm]());
    const goodFail = good.filter((c) => !c.ok);
    if (goodFail.length) { bad++; console.log(`  FAIL ${arm}: the known-good facts do not pass: ${goodFail.map((c) => c.id).join(', ')}`); }
    const ids = good.map((c) => c.id);
    const missing = ids.filter((id) => !MUT[arm][id]);
    if (missing.length) { bad++; console.log(`  FAIL ${arm}: clause(s) without a mutation (unproven): ${missing.join(', ')}`); }
    for (const [id, mutate] of Object.entries(MUT[arm])) {
      if (!ids.includes(id)) { bad++; console.log(`  FAIL ${arm}: mutation for an unknown clause ${id}`); continue; }
      const f = GOOD[arm]();
      mutate(f);
      const failed = judge(arm, f).filter((c) => !c.ok).map((c) => c.id);
      if (!failed.includes(id)) { bad++; console.log(`  FAIL ${arm}/${id}: its mutation did not red it (failed: ${JSON.stringify(failed)})`); }
    }
    console.log(`  ${arm}: ${ids.length} clauses, each mutated and reddened${goodFail.length || missing.length ? ' — WITH PROBLEMS' : ''}`);
  }
  console.log(`SESSION-IDENTITY selftest: ${bad === 0 ? 'PASS' : 'FAIL'}`);
  return bad === 0;
}
