// The #210 arms (child processes / memory / zero survivors after workspace delete) for run.mjs, and the
// checker for the must-FAIL ones. Budget NUMBERS are not here — they live in src/shared/session-budget.ts; the
// literals below are the SHAPE each mutant must produce (a must-FAIL that broke on the wrong thing proves nothing).
//
// A must-FAIL arm is judged by `checks` (each names one BROKEN budget verdict, its literal actual, and text the
// named process tree must contain) and `mustHold` (verdict-id prefixes that must stay OK — the arm breaks the
// budget it is aimed at and nothing else).

/** One MCP server outlives a dead CLI (ignores stdin EOF/SIGTERM), so the descendant sweep is always exercised. */
const STUBBORN = Object.freeze({ stubbornMcp: 1 });
const HOLD_PROCS = ['session.processes.', 'session.beforeFirstReply.'];
const first = 'session.processes.atFirstReply.';

const ARMS = {
  'delete-cli': { mutant: null, expect: 'pass', teardown: 'cli', profile: STUBBORN },
  'delete-ui': { mutant: null, expect: 'pass', teardown: 'ui', profile: STUBBORN },

  'procs-extra-child': {
    mutant: 'keeper-extra-child', expect: 'fail',
    checks: [
      { id: `${first}other`, exact: 1, treeIncludes: ['sleep 600', 'keeper.js'] },
      { id: `${first}total`, exact: 7 },
      { id: 'session.processes.atEnd.other', exact: 1, treeIncludes: ['sleep 600'] },
      { id: 'session.processes.atEnd.total', exact: 7 },
    ],
    mustHold: [`${first}keeper`, `${first}cli`, `${first}mcp`, `${first}memoryMB`, 'session.beforeFirstReply.'],
  },
  'mem-keeper-ballast': {
    mutant: 'keeper-ballast', expect: 'fail',
    checks: [
      { id: `${first}memoryMB`, min: 750, treeIncludes: ['keeper.js', 'claude'] },
      { id: 'session.processes.atEnd.memoryMB', min: 750, treeIncludes: ['keeper.js'] },
    ],
    mustHold: [`${first}keeper`, `${first}cli`, `${first}mcp`, `${first}hook`, `${first}other`, `${first}total`, 'session.beforeFirstReply.'],
  },

  'delete-cli-skips-stop': {
    mutant: 'delete-skips-stop', expect: 'fail', teardown: 'cli', profile: STUBBORN,
    checks: [
      { id: 'session.delete.survivors', exact: 6, treeIncludes: ['keeper.js', 'claude', 'fixsrv1', 'fixsrv4'] },
      { id: 'session.delete.zeroWithinMs', never: true },
    ],
    mustHold: HOLD_PROCS,
  },
  'delete-cli-skips-tree-sweep': {
    mutant: 'delete-skips-tree-sweep', expect: 'fail', teardown: 'cli', profile: STUBBORN,
    checks: [
      { id: 'session.delete.survivors', exact: 1, treeIncludes: ['fixsrv4', '--stubborn', 'from the pre-delete tree'] },
      { id: 'session.delete.zeroWithinMs', never: true },
    ],
    mustHold: HOLD_PROCS,
  },
  // F1a: a wake (sdkSend) fired while the session is stopping and the keeper kill is in flight. `forbidKeeperLaunch`
  // (the launch tombstone) must refuse it → 0 survivors that HOLD; without it the wake launches a keeper + CLI nobody kills.
  // `mustSeeRefusal`: the positive control — the tombstone REALLY refused the wake (else 0 survivors would prove nothing).
  'delete-cli-wake-race': { mutant: null, expect: 'pass', teardown: 'cli', profile: STUBBORN, deleteOpts: { wakeDuringDelete: true }, mustSeeRefusal: true },
  'delete-cli-wake-race-no-tombstone': {
    mutant: 'delete-drops-launch-tombstone', expect: 'fail', teardown: 'cli', profile: STUBBORN, deleteOpts: { wakeDuringDelete: true },
    // NEW survivors (not in the pre-delete tree): only the pid-namespace half of the survivor census can see them (F1b).
    checks: [
      { id: 'session.delete.survivors', exact: 6, treeIncludes: ['keeper.js', 'claude', 'fixsrv4', 'NEW since the delete'] },
      { id: 'session.delete.zeroWithinMs', never: true },
    ],
    mustHold: HOLD_PROCS,
  },
  // F1b+c: something is started 1.5 s AFTER the sweep. Seen only by the census half of `alive()` (it was never in the tree)
  // and only because the zero is watched for `stableForMs` after it is first read.
  'delete-cli-late-relaunch': {
    mutant: 'delete-late-relaunch', expect: 'fail', teardown: 'cli', profile: STUBBORN,
    checks: [
      { id: 'session.delete.survivors', exact: 1, treeIncludes: ['sleep 600', 'NEW since the delete'] },
      { id: 'session.delete.zeroWithinMs', never: true },
    ],
    mustHold: HOLD_PROCS,
  },
  // F4: a delete that never returns is raced against the bound, then the tree it left is named.
  'delete-cli-hangs': {
    mutant: 'delete-hangs', expect: 'fail', teardown: 'cli', profile: STUBBORN,
    checks: [
      { id: 'session.delete.returnsWithinMs', never: true },
      { id: 'session.delete.survivors', exact: 6, treeIncludes: ['keeper.js', 'claude', 'fixsrv1', 'fixsrv4'] },
      { id: 'session.delete.zeroWithinMs', never: true },
    ],
    mustHold: HOLD_PROCS,
  },
  // The renderer route ALSO stops the session (sdkStopMany) before deleteWorkspace: measured 2026-09-30, skipping
  // stopStructuredSession alone leaves nothing on that route (masked, 0 survivors in 576 ms) — the CLI arm above is
  // the one that pins that clause; this arm removes BOTH stoppers so the UI arm can fail at all.
  'delete-ui-skips-stop': {
    mutant: 'delete-skips-stop+ui-skips-sdkstop', expect: 'fail', teardown: 'ui', profile: STUBBORN,
    checks: [
      { id: 'session.delete.survivors', exact: 6, treeIncludes: ['keeper.js', 'claude', 'fixsrv1', 'fixsrv4'] },
      { id: 'session.delete.zeroWithinMs', never: true },
    ],
    mustHold: HOLD_PROCS,
  },
};

/** The arms as run.mjs ARMS entries (all are session arms). */
export const PROCS_ARMS = Object.fromEntries(Object.entries(ARMS).map(([k, v]) => [k, { kind: 'session', ...v }]));

/** Positive controls of a must-PASS arm (its budgets already held): null when they hold, else what is missing. */
export function passArmProblems(spec, report) {
  if (spec.mustSeeRefusal) {
    const r = report.delete?.wake?.refusals ?? [];
    if (r.length < 1) return `held, but the launch tombstone never refused the racing wake (wake=${JSON.stringify(report.delete?.wake ?? null)}) — 0 survivors proves nothing`;
  }
  return null;
}

/** Judge a must-FAIL arm carrying `checks`. @returns {{ok: boolean, why: string}} */
export function judgeProcsArm(spec, judgement) {
  const problems = [];
  const said = [];
  const broke = judgement.verdicts.filter((v) => v.kind === 'budget' && !v.ok);
  for (const c of spec.checks) {
    const v = broke.find((b) => b.id === c.id);
    if (!v) { problems.push(`${c.id} held (must break)`); continue; }
    const a = v.actual;
    if (c.never && a !== null) problems.push(`${c.id}: expected 'never reached zero', got ${a}`);
    if (c.exact !== undefined && a !== c.exact) problems.push(`${c.id}: actual ${a} != ${c.exact}`);
    if (c.min !== undefined && !(a !== null && a >= c.min)) problems.push(`${c.id}: actual ${a} < ${c.min}`);
    const tree = (v.tree ?? []).join('\n');
    for (const t of c.treeIncludes ?? []) if (!tree.includes(t)) problems.push(`${c.id}: named tree lacks '${t}'`);
    said.push(v.message);
  }
  for (const prefix of spec.mustHold ?? []) {
    for (const v of broke) if (v.id.startsWith(prefix)) problems.push(`${v.id} broke but must hold (arm not specific)`);
  }
  const named = new Set(spec.checks.map((c) => c.id));
  const extra = broke.filter((v) => !named.has(v.id) && !(spec.mustHold ?? []).some((p) => v.id.startsWith(p)));
  if (extra.length) problems.push(`unexpected extra broken budgets: ${extra.map((v) => v.id).join(', ')}`);
  return problems.length ? { ok: false, why: problems.join(' | ') } : { ok: true, why: said.join(' | ') };
}
