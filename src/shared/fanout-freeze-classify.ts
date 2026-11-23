// #539 — the freeze check's PURE half: run the frozen command once on the target tip, then classify each test from the runner's STRUCTURED output
// (node --test TAP): pass · assertion FAIL (accepted: not built yet) · ERROR (setup/teardown/hook, non-assertion exception, crash, load failure, timeout). Never prose.
// I/O (fetch, scratch checkout, spawn): src/cli/fanout-freeze-check.ts. Captures the unit tests read: src/shared/fanout-freeze-captures/.

/** `outText` = the content of the results file an adapter asked the runner to write (`Adapter.argv`'s `outFile`), null/absent = none was written. */
export interface ExecResult { exit: number | null; signal: string | null; timedOut: boolean; stdout: string; outText?: string | null; spawnError?: string }
export interface TestOutcome { name: string; kind: 'pass' | 'assertion-fail' | 'error' | 'skipped'; reason?: string }
export type FreezeVerdict =
  | { kind: 'clean'; runner: string; pass: number; assertionFail: number; skipped: number; tests: TestOutcome[] }
  | { kind: 'error'; runner: string; errors: TestOutcome[]; pass: number; assertionFail: number }
  | { kind: 'unclassified'; runner: string | null; why: string };

/** A runner output that cannot be classified (truncated, unparsable, counts that do not add up): fail closed. */
export class Unclassifiable extends Error {}

export interface Adapter {
  name: string;
  /** The argv to run: the frozen one with the runner's STRUCTURED reporter forced (the frozen command, and so its hash, is unchanged). `outFile` = where a file-writing reporter may put its results. */
  argv: (frozen: string[], outFile: string) => string[];
  /** True when the structured output is the file at `outFile` (read into `ExecResult.outText`), not stdout. */
  usesFile?: boolean;
  parse: (stdout: string, outText: string | null) => TestOutcome[];
}

// ── node --test (TAP) ───────────────────────────────────────────────────────────────────────────────────────

interface TapEntry {
  ok: boolean; name: string; directive: 'SKIP' | 'TODO' | null; fields: Record<string, string | null>; children: TapEntry[];
}

/** The `---` … `...` diagnostic block after a result line: top-level scalar keys only (block scalars `|-` joined; nested maps skipped). */
function parseYaml(lines: string[], baseIndent: number): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || indentOf(l) !== baseIndent) continue;
    const m = /^([A-Za-z_][\w]*):(?:\s+(.*))?$/.exec(l.trim());
    if (!m) continue;
    const rest = (m[2] ?? '').trim();
    const body: string[] = [];
    while (i + 1 < lines.length && (!lines[i + 1].trim() || indentOf(lines[i + 1]) > baseIndent)) body.push(lines[++i]);
    if (rest === '' || rest.startsWith('|') || rest.startsWith('>')) {
      out[m[1]] = rest === '' ? null : body.map((b) => b.slice(Math.min(indentOf(b), baseIndent + 2))).join('\n').trimEnd();
    } else if (rest === '~') out[m[1]] = null;
    else if (rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2) out[m[1]] = rest.slice(1, -1).replace(/''/g, "'");
    else if (rest.startsWith('"')) { try { out[m[1]] = JSON.parse(rest) as string; } catch { out[m[1]] = rest; } }
    else out[m[1]] = rest;
  }
  return out;
}

const RESULT = /^( *)(not ok|ok) (\d+)(?: - (.*?))?$/;

/** TAP of `node --test` → the entry forest (children precede their parent in node's output, one indent level = 4 spaces) + the final summary counts. */
export function parseNodeTap(stdout: string): { roots: TapEntry[]; summary: Record<string, number> } {
  const lines = stdout.split('\n');
  if (!/^TAP version \d+/.test(lines[0] ?? '')) throw new Unclassifiable('the runner printed no TAP header (the structured reporter did not take effect)');
  const pending: TapEntry[][] = [];
  const summary: Record<string, number> = {};
  for (let i = 1; i < lines.length; i++) {
    const s = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(lines[i]);
    if (s) { summary[s[1]] = Number(s[2]); continue; }
    const m = RESULT.exec(lines[i]);
    if (!m) continue;
    const depth = m[1].length / 4;
    if (!Number.isInteger(depth)) throw new Unclassifiable(`TAP result line at an odd indent: ${lines[i].slice(0, 80)}`);
    let name = m[4] ?? '';
    let directive: TapEntry['directive'] = null;
    const d = /^(.*?) # (SKIP|TODO)\b.*$/.exec(name);
    if (d) { name = d[1]; directive = d[2] as 'SKIP' | 'TODO'; }
    let fields: Record<string, string | null> = {};
    if (lines[i + 1]?.trim() === '---' && lines[i + 1].length - lines[i + 1].trimStart().length === m[1].length + 2) {
      const block: string[] = [];
      let j = i + 2;
      const end = `${' '.repeat(m[1].length + 2)}...`; // EXACTLY the block's indent: node's diff elides lines with a deeper, indented `...` inside `error: |-`
      while (j < lines.length && lines[j] !== end) block.push(lines[j++]);
      if (j >= lines.length) throw new Unclassifiable('TAP diagnostic block not closed (output truncated)');
      fields = parseYaml(block, m[1].length + 2);
      i = j;
    }
    const entry: TapEntry = { ok: m[2] === 'ok', name, directive, fields, children: pending[depth + 1] ?? [] };
    pending[depth + 1] = [];
    (pending[depth] ??= []).push(entry);
  }
  // the summary is the positive terminator: a truncated / killed run has none
  for (const k of ['tests', 'pass', 'fail', 'cancelled']) if (summary[k] === undefined) throw new Unclassifiable(`no TAP summary (# ${k}): the output is truncated`);
  for (let d = 1; d < pending.length; d++) if (pending[d]?.length) throw new Unclassifiable('TAP results nested under no parent (malformed output)');
  return { roots: pending[0] ?? [], summary };
}

const firstLine = (s: string | null | undefined): string => (s ?? '').split('\n')[0].slice(0, 160);
const isAssertion = (f: Record<string, string | null>): boolean => f.failureType === 'testCodeFailure' && (f.code === 'ERR_ASSERTION' || f.name === 'AssertionError');

/** Per-entry classification. Structured fields only: `failureType`, `code`, `name` — the message text is for the report, never for the verdict. */
export function classifyNodeTap(stdout: string): TestOutcome[] {
  const { roots, summary } = parseNodeTap(stdout);
  const out: TestOutcome[] = [];
  let leaves = 0, okLeaves = 0, notOkLeaves = 0;
  const failedBelow = (e: TapEntry): boolean => e.children.some((c) => (!c.ok && !c.directive) || failedBelow(c));
  const walk = (e: TapEntry, path: string): void => {
    const full = path ? `${path} › ${e.name}` : e.name;
    for (const c of e.children) walk(c, full);
    // Node ≥ 22 labels every result `type: 'test'|'suite'`; Node 18/20 only labels suites — a result with a diagnostic block and no `type` is a test
    const type = e.fields.type ?? (Object.keys(e.fields).length > 0 ? 'test' : undefined);
    if (type !== 'test' && type !== 'suite') throw new Unclassifiable(`result "${full}" has no type field (the diagnostic block is missing)`);
    if (type === 'test') { leaves++; if (!e.directive) { if (e.ok) okLeaves++; else notOkLeaves++; } }
    // a todo test is allowed to FAIL on an assertion (the runner does not count it); any other failure of it is still an ERROR
    if (e.directive === 'SKIP' || (e.directive && (e.ok || (type === 'test' && isAssertion(e.fields))))) { out.push({ name: full, kind: 'skipped', reason: e.directive }); return; }
    if (e.ok) { if (type === 'test') out.push({ name: full, kind: 'pass' }); return; }
    const ft = e.fields.failureType ?? '(none)';
    if (ft === 'subtestsFailed' && failedBelow(e)) return; // derived: its subtests carry the verdict
    if (type === 'test' && isAssertion(e.fields)) { out.push({ name: full, kind: 'assertion-fail', reason: firstLine(e.fields.error) }); return; }
    const fileProc = 'exitCode' in e.fields || 'signal' in e.fields; // node reports a test FILE whose process ended badly (load / syntax error, top-level throw, crash, kill)
    const why = ft === 'testTimeoutFailure' ? 'timeout' : ft === 'hookFailed' ? 'setup/teardown hook failed' : ft === 'cancelledByParent' ? 'cancelled (a hook, crash or timeout above it)' : ft === 'subtestsFailed' ? 'suite failed with no failing subtest'
      : fileProc ? `the test file's process ended with ${e.fields.signal ? `signal ${e.fields.signal}` : `exit ${e.fields.exitCode}`} (load failure, top-level throw or crash)` : type === 'suite' ? ft : (e.fields.name ?? ft);
    out.push({ name: full, kind: 'error', reason: `${why}: ${firstLine(e.fields.error)}` });
  };
  for (const r of roots) walk(r, '');
  // integrity: what the runner says it ran must equal what was parsed (a lost / spoofed block must not pass)
  const tests = summary.tests, pass = summary.pass ?? 0, fail = (summary.fail ?? 0) + (summary.cancelled ?? 0);
  if (leaves !== tests || okLeaves !== pass || notOkLeaves !== fail) {
    throw new Unclassifiable(`the TAP summary (tests ${tests}, pass ${pass}, fail+cancelled ${fail}) does not match the ${leaves} test result(s) parsed (${okLeaves} ok, ${notOkLeaves} not ok)`);
  }
  if (leaves === 0) throw new Unclassifiable('the runner reported no test at all');
  return out;
}

export const NODE_TEST: Adapter = {
  name: 'node --test (TAP)',
  argv: (frozen) => ['node', '--test-reporter=tap', ...frozen.slice(1).filter((t) => !t.startsWith('--test-reporter='))],
  parse: classifyNodeTap,
};

// ── jest (`--json --outputFile`) ────────────────────────────────────────────────────────────────────────────

interface JestAssertion { status?: unknown; fullName?: unknown; title?: unknown; failureMessages?: unknown; failureDetails?: unknown }
interface JestFile { name?: unknown; status?: unknown; assertionResults?: unknown }
const num = (o: Record<string, unknown>, k: string): number => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Unclassifiable(`the jest results lack a count (${k})`);
  return v;
};
const shortFile = (n: unknown): string => String(n ?? '(unnamed file)').split('/').slice(-2).join('/');

/** Is one `failureDetails` entry an `expect` failure? (a) it carries `matcherResult` — every matcher (`toBe`, `toEqual`, `toThrow`…); or (b) the expect library failed a test WITHOUT a
 *  matcher — `.rejects/.resolves` on a promise that settles the other way, `expect.assertions(n)` / `hasAssertions()` — shape: an object with an own `message` key (a plain thrown
 *  Error serialises to `{}`) AND its stack's first frame is inside `expect/build` or is the `expect.assertions|hasAssertions` call itself. The message TEXT is never read. */
export const REJECTED_INSTEAD_OF_RESOLVED = 'Received promise rejected instead of resolved';
const RESOLVES_REJECTED = new RegExp(`^expect\\(received\\)\\.(?:not\\.)?resolves[^\\n]*\\n\\n${REJECTED_INSTEAD_OF_RESOLVED}`);
export function isExpectFailure(detail: unknown, stack: string): boolean {
  if (!detail || typeof detail !== 'object') return false;
  if ('matcherResult' in (detail as object)) return true;
  if (!('message' in (detail as object))) return false;
  // THE one deliberate text read: `.resolves` on a promise that REJECTED reports "Received promise rejected instead of resolved" with the same shape as the `.rejects` mismatch we accept,
  // but the rejection is whatever the test's own code threw (a TypeError, a missing module…) — a harness error, not "behaviour not built".
  // ANCHORED: the phrase follows the `expect(received).resolves…` header line — a legit `.rejects` RED whose resolved VALUE quotes the phrase ("Resolved to value: …") is not matched
  const m = (detail as { message?: unknown }).message;
  if (typeof m === 'string' && RESOLVES_REJECTED.test(m)) return false;
  const first = stack.split('\n').map((l) => l.trim()).find((l) => l.startsWith('at '));
  return !!first && (/[\\/]expect[\\/]build[\\/]/.test(first) || /^at (?:Object\.)?(?:assertions|hasAssertions) \(/.test(first));
}

/** jest `--json` results → per-test outcomes. An assertion FAIL is a test whose EVERY `failureDetails` entry carries `matcherResult` (what `expect` attaches); a hook /
 *  body exception / timeout has none. A file with status `failed` and NO test results is "Test suite failed to run"; a suite that failed AFTER its tests (afterAll…) is only
 *  visible in the aggregate `numRuntimeErrorTestSuites`. The message text is for the report, never for the verdict. */
export function classifyJestJson(text: string | null): TestOutcome[] {
  if (text === null) throw new Unclassifiable('jest wrote no results file (it did not run to the end: bad flags / config, or it died)');
  let d: Record<string, unknown>;
  try { d = JSON.parse(text) as Record<string, unknown>; } catch { throw new Unclassifiable('the jest results file is not valid JSON (truncated)'); }
  if (!d || typeof d !== 'object' || !Array.isArray(d.testResults)) throw new Unclassifiable('the jest results have no testResults array');
  const out: TestOutcome[] = [];
  const seen = { total: 0, passed: 0, failed: 0, pending: 0, todo: 0 };
  let failedToRun = 0;
  for (const f of d.testResults as JestFile[]) {
    const file = shortFile(f.name);
    if (!Array.isArray(f.assertionResults) || typeof f.status !== 'string') throw new Unclassifiable(`jest result for ${file} has no assertionResults/status`);
    const tests = f.assertionResults as JestAssertion[];
    if (f.status === 'failed' && tests.length === 0) {
      failedToRun++;
      out.push({ name: file, kind: 'error', reason: 'Test suite failed to run (import / compile / syntax error, top-level throw, or no test in the file)' });
    }
    for (const t of tests) {
      seen.total++;
      const name = `${file} › ${String(t.fullName ?? t.title ?? '?')}`;
      if (t.status === 'passed') { seen.passed++; out.push({ name, kind: 'pass' }); continue; }
      if (t.status === 'pending' || t.status === 'skipped' || t.status === 'disabled') { seen.pending++; out.push({ name, kind: 'skipped', reason: 'SKIP' }); continue; }
      if (t.status === 'todo') { seen.todo++; out.push({ name, kind: 'skipped', reason: 'TODO' }); continue; }
      if (t.status !== 'failed') throw new Unclassifiable(`jest test "${name}" has an unknown status ${JSON.stringify(t.status)}`);
      seen.failed++;
      const det = Array.isArray(t.failureDetails) ? t.failureDetails : [];
      const stacks = Array.isArray(t.failureMessages) ? t.failureMessages.map((m) => String(m ?? '')) : [];
      const matcher = det.length > 0 && det.every((x, i) => isExpectFailure(x, stacks[i] ?? ''));
      const msg = firstLine(stacks[0] ?? '');
      out.push(matcher ? { name, kind: 'assertion-fail', reason: msg } : { name, kind: 'error', reason: `not an expect() matcher failure (a hook, a thrown exception, a timeout…): ${msg}` });
    }
  }
  // a suite that failed to run AFTER its tests ran (afterAll / teardown) shows in the aggregate only
  const runtime = num(d, 'numRuntimeErrorTestSuites');
  const late = runtime - failedToRun;
  if (late > 0) {
    const among = [...new Set((d.testResults as JestFile[]).filter((f) => f.status === 'failed' && Array.isArray(f.assertionResults) && f.assertionResults.length > 0).map((f) => shortFile(f.name)))].slice(0, 6);
    out.push({ name: among.join(', ') || '(a suite)', kind: 'error', reason: `${late} suite(s) failed to run AFTER their tests (an afterAll / teardown failure)` });
  }
  if (seen.total !== num(d, 'numTotalTests') || seen.passed !== num(d, 'numPassedTests') || seen.failed !== num(d, 'numFailedTests') || seen.pending !== num(d, 'numPendingTests') || seen.todo !== num(d, 'numTodoTests')) {
    throw new Unclassifiable(`the jest summary (${d.numTotalTests} tests, ${d.numPassedTests} passed, ${d.numFailedTests} failed) does not match the ${seen.total} test result(s) parsed`);
  }
  if (seen.total === 0 && failedToRun === 0 && late <= 0) throw new Unclassifiable('the runner reported no test at all');
  return out;
}

export const JEST: Adapter = {
  name: 'jest (--json)',
  usesFile: true,
  // `--bail` is dropped from THIS run (the frozen command / hash keep it): with 2+ test files jest exit()s on the first failing one before it writes --outputFile
  argv: (frozen, outFile) => ['jest', '--json', `--outputFile=${outFile}`, '--no-watchman', ...frozen.slice(1).filter((t) => t !== '--bail')],
  parse: (_stdout, outText) => classifyJestJson(outText),
};

/** The adapter for a frozen argv, null = no structured-output adapter for that runner (fail closed). */
export function adapterFor(argv: string[]): Adapter | null {
  return argv[0] === 'node' ? NODE_TEST : argv[0] === 'jest' ? JEST : null;
}
export const SUPPORTED_RUNNERS = 'node --test, jest';

// ── the verdict ─────────────────────────────────────────────────────────────────────────────────────────────

/** Run result + adapter → the verdict. Order matters: a wall-clock kill / signal is an ERROR whatever the output says (no partial verdict is ever "clean"). */
export function classifyRun(frozen: string[], r: ExecResult): FreezeVerdict {
  const adapter = adapterFor(frozen);
  if (!adapter) return { kind: 'unclassified', runner: null, why: `no structured-output adapter for runner "${frozen[0]}" (supported: ${SUPPORTED_RUNNERS}); its output cannot be classified` };
  const name = adapter.name;
  const procError = (reason: string): FreezeVerdict => ({ kind: 'error', runner: name, errors: [{ name: '(the frozen command)', kind: 'error', reason }], pass: 0, assertionFail: 0 });
  if (r.spawnError) return { kind: 'unclassified', runner: name, why: `the runner could not be started: ${r.spawnError}` };
  // 127 / 126 = the shell-level "not found / not executable" of `timeout`: the runner never started — resolved on the inherited PATH exactly as at the gate
  if (r.exit === 127 || r.exit === 126) return { kind: 'unclassified', runner: name, why: `the runner "${frozen[0]}" could not be started (exit ${r.exit}: not found / not executable on the PATH the freeze inherited — the gate resolves it the same way)` };
  if (r.timedOut) return procError('timeout: the frozen command did not finish within the freeze-check limit');
  if (r.signal) return procError(`crash: the runner process was killed by ${r.signal}`);
  let tests: TestOutcome[];
  try { tests = adapter.parse(r.stdout, r.outText ?? null); } catch (e) {
    if (e instanceof Unclassifiable) return { kind: 'unclassified', runner: name, why: e.message };
    throw e;
  }
  const errors = tests.filter((t) => t.kind === 'error');
  const pass = tests.filter((t) => t.kind === 'pass').length;
  const assertionFail = tests.filter((t) => t.kind === 'assertion-fail').length;
  const skipped = tests.filter((t) => t.kind === 'skipped').length;
  if (errors.length) return { kind: 'error', runner: name, errors, pass, assertionFail };
  // exit code vs report: a non-zero exit with every test green is a crash outside the tests; a zero exit with a failure is output we cannot trust
  if (r.exit !== 0 && assertionFail === 0) return procError(`exit ${r.exit} although every reported test passed (a failure outside the tests)`);
  if (r.exit === 0 && assertionFail > 0) return { kind: 'unclassified', runner: name, why: `exit 0 although ${assertionFail} test(s) reported a failure` };
  return { kind: 'clean', runner: name, pass, assertionFail, skipped, tests };
}

/** The refusal text: at most 8 errors, each named with its structured reason. */
export function formatErrors(v: Extract<FreezeVerdict, { kind: 'error' }>): string {
  const shown = v.errors.slice(0, 8).map((e) => `  - ${e.name}: ${e.reason}`).join('\n');
  return `${v.errors.length} test(s) ERRORED (a setup/teardown/harness exception, non-assertion exception, crash, load failure or timeout — not an assertion failure):\n${shown}${v.errors.length > 8 ? `\n  … and ${v.errors.length - 8} more` : ''}`;
}
