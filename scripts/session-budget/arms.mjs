// The session-budget suite's ARM TABLE and the pure verdict logic for one arm — kept apart from run.mjs (which spawns processes) so the
// numbers and the rules that judge them are unit-pinned (src/main/session-budget-harness.test.ts). A survivor of the C1 gate was a
// constant here that nothing pinned (minBurst, the slow-arm positive control) — hence the tests over this module.

/** `minBurst` is a LITERAL (the fixture carries 50 rules): a must-FAIL that broke on 1 count_tokens would not prove "large". */
export const ARMS = {
  normal: { kind: 'session', mutant: null, expect: 'pass' },
  'boot-context-read': { kind: 'session', mutant: 'boot-context-read', expect: 'fail', mustBreak: 'session.beforeFirstReply.countTokensRequests', minBurst: 50 },
  // A slow-but-healthy startup (a slow MCP server, as npx-launched ones are): the main request waits ~1.7 s and the CLI retries a refused
  // call once. MUST PASS — and must actually SEE the retried attempt (positive control), else it proves nothing about the allowance.
  'slow-startup': { kind: 'session', mutant: null, expect: 'pass', profile: { mcpInitDelayMs: 1200 }, mustExercise: { host: 'api.anthropic.com:443', min: 4 } },
  // A buildSdkEnv edit hands the CLI DISABLE_TELEMETRY: judged from the CLI's /proc environ, not the runner's own env.
  'traffic-knob-in-env': { kind: 'session', mutant: 'traffic-knob-in-sdk-env', expect: 'void', mustVoid: 'instrument.productionEnv', mustName: 'DISABLE_TELEMETRY' },
  // An ensureSession edit fetch()es ONE new host: the app process's traffic goes through the recording proxy, so exactly one attempt shows.
  'app-egress-new-host': { kind: 'session', mutant: 'app-fetch-new-host', expect: 'fail', mustBreak: 'session.beforeFirstReply.startupEgressAttempts.telemetry.example.invalid:443', minBurst: 1, maxBurst: 1 },
  // The harness LIES about its containment (claims net+pid namespaces, drops --unshare-net): the in-run canary must catch it and the run
  // must be ABORTED before anything boots — a run only *named* contained never starts.
  'containment-canary': { kind: 'session', mutant: null, expect: 'void', mustVoid: 'instrument.containmentProven', mustName: 'want connect=ENETUNREACH', mustAbort: 'containment', lieAboutContainment: true },
  'census-selftest': { kind: 'selftest', mode: 'census' },
  'smoke-flag-path': { kind: 'selftest', mode: 'smoke' },
};

/**
 * Judge one arm's result against its spec. `res` = `{ report, judgement, aborted? }` from the runner (already free of harness errors).
 * @returns {{asExpected: boolean, why: string, voided: boolean, bad: boolean}}
 *   voided = an unexpected VOID (counts toward the VOID terminator); bad = the arm broke its expectation (counts toward FAIL).
 */
export function evaluateArm(spec, res) {
  const { report, judgement } = res;
  const broke = judgement.verdicts.filter((v) => v.kind === 'budget' && !v.ok);
  let asExpected;
  let why = '';
  let voided = false;
  if (spec.expect === 'void') {
    // A must-VOID arm: the run is EXPECTED to be judged VOID, by the named instrument, naming the named knob.
    const named = judgement.verdicts.find((v) => v.kind === 'instrument' && !v.ok && v.id === spec.mustVoid && v.message.includes(spec.mustName));
    asExpected = judgement.void && !!named;
    why = named ? named.message : `expected ${spec.mustVoid} to VOID naming ${spec.mustName} but it did not (void=${judgement.void})`;
    if (asExpected && spec.mustAbort && res.aborted !== spec.mustAbort) {
      asExpected = false;
      why = `VOID as expected, but the run was not aborted before booting (aborted=${res.aborted ?? 'no'}) — the guard did not stop the session: ${why}`;
    }
  } else if (judgement.void) {
    asExpected = false;
    voided = true;
    why = `VOID — ${judgement.verdicts.filter((v) => v.kind === 'instrument' && !v.ok).map((v) => v.message).join(' | ')}`;
  } else if (spec.expect === 'pass') {
    asExpected = judgement.ok;
    why = judgement.ok ? 'every budget held' : broke.map((v) => v.message).join(' | ');
    // Positive control: a slow-but-healthy arm that never saw the retry proves nothing about the allowance it exists to protect.
    const seen = report.startupEgress?.[spec.mustExercise?.host] ?? 0;
    if (asExpected && spec.mustExercise && seen < spec.mustExercise.min) {
      asExpected = false;
      why = `held, but the arm did not exercise the retry path (saw ${seen} startup attempts at ${spec.mustExercise.host}, need ≥ ${spec.mustExercise.min}) — it proves nothing`;
    }
  } else {
    const named = broke.find((v) => v.id === spec.mustBreak);
    const actual = named?.actual ?? 0;
    asExpected = !!named && actual >= spec.minBurst && (spec.maxBurst == null || actual <= spec.maxBurst);
    why = named ? named.message : `expected ${spec.mustBreak} to break but it held`;
    if (named && actual < spec.minBurst) why += ` — burst below ${spec.minBurst}, not the large #176 shape`;
    if (named && spec.maxBurst != null && actual > spec.maxBurst) why += ` — ${actual} attempts, expected exactly ${spec.maxBurst}`;
  }
  return { asExpected, why, voided, bad: !asExpected && (spec.expect === 'void' || !voided) };
}
