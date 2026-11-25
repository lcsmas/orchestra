// #568 — the ONE reader of `.github/ci-rigs.json`: the PR workflow's matrix, its summary job and the guard test all go through here.
// A rig (package.json `test:*` / `canary:*` script, or a top-level `scripts/e2e-*.{mjs,sh}` no script reaches) is either RUNS_IN_CI or LOCAL_ONLY + reason; never absent.
import fs from 'node:fs';
import path from 'node:path';

export type RigClass = 'RUNS_IN_CI' | 'LOCAL_ONLY';
export interface RigEntry {
  /** `test:foo` (package.json script) or `scripts/e2e-foo.mjs` (standalone entry point). */
  id: string;
  /** Shell command the CI job runs (RUNS_IN_CI) or the one a human runs locally (LOCAL_ONLY). */
  command: string;
  class: RigClass;
  /** Required for LOCAL_ONLY: the failure/precondition seen in the runner log. Optional note for RUNS_IN_CI. */
  reason?: string;
  /** RUNS_IN_CI: job timeout in minutes (default 10). */
  timeoutMin?: number;
  /** RUNS_IN_CI: shell run before `command` (environment prep only — never a rig rewrite), e.g. `mkdir -p ~/.cache/x`. */
  pre?: string;
  /** RUNS_IN_CI: regex (string) counting this rig's own PASS arms, when the default heuristic does not fit. */
  passPattern?: string;
  /** RUNS_IN_CI: regex (string) counting this rig's own FAIL arms. */
  failPattern?: string;
  /** RUNS_IN_CI: the group (1..groups) this rig runs in; absent ⇒ placed by `assignGroups` (longest-first onto the lightest group). */
  group?: number;
  /** Measured wall time of the first successful runner run, seconds (informational). */
  wallSec?: number;
}
export interface RigFile {
  /** How many jobs the RUNS_IN_CI rigs are spread over (D5, ledger #569). Each job installs once and runs its rigs in sequence. */
  groups?: number;
  rigs: RigEntry[];
}

const SCRIPT_EXT = /[\w./-]+\.(?:mjs|sh|cjs|py|ts)\b/g;

/** Every `scripts/**` file as `relative path → content` (no node_modules). */
function readScriptsTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (/\.(mjs|sh|cjs|py|ts|js|json)$/.test(e.name)) out.set(path.relative(root, p), fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(root, 'scripts'));
  return out;
}

/** The entry points the data file MUST classify: every `test:*`/`canary:*` script, plus every top-level `scripts/e2e-*.{mjs,sh}` no such script reaches (transitively, by file-name mention). */
export function requiredRigIds(root: string): { ids: string[]; commands: Record<string, string> } {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const rigScripts = Object.keys(pkg.scripts).filter((k) => /^(test:|canary:)/.test(k));
  const tree = readScriptsTree(root);
  const byBase = new Map<string, string[]>();
  for (const p of tree.keys()) { const b = path.basename(p); byBase.set(b, [...(byBase.get(b) ?? []), p]); }
  // Reach: a script mentioned by name, then every file mentioned inside it, … (a `pnpm run x` hop follows package.json too).
  const seen = new Set<string>();
  const queue: string[] = [];
  // A name in a comment line does not reach a script (a comment must not be able to hide a new rig from the guard).
  const code = (t: string): string => t.split('\n').filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).join('\n');
  const mention = (text: string): void => {
    for (const m of code(text).matchAll(SCRIPT_EXT)) for (const f of byBase.get(path.basename(m[0])) ?? []) if (!seen.has(f)) { seen.add(f); queue.push(f); }
  };
  for (const k of rigScripts) mention(pkg.scripts[k]);
  while (queue.length) mention(tree.get(queue.shift() as string) ?? '');
  const orphanSet = new Set([...tree.keys()].filter((p) => /^scripts\/e2e-[^/]+\.(mjs|sh)$/.test(p) && !seen.has(p)));
  // Among the orphans, a `.mjs` beside a same-stem `.sh` is that rig's helper; any other orphan a (non-`-mutants`) orphan names is its helper too. A cycle keeps its `.sh`.
  const isMutants = (f: string): boolean => /-mutants\.(mjs|sh)$/.test(f);
  const helperOf = (f: string): boolean => f.endsWith('.mjs') && orphanSet.has(f.replace(/\.mjs$/, '.sh'));
  const names = (f: string): string[] => [...orphanSet].filter((g) => g !== f && code(tree.get(f) ?? '').includes(path.basename(g)));
  const order = [...orphanSet].sort();
  const reached = new Set(order.filter(helperOf));
  const entries = new Set<string>();
  // Entries first: orphans no non-mutants orphan names; then the rest, `.sh` before `.mjs`, each marking its closure as helpers.
  const named = new Set(order.flatMap((f) => (isMutants(f) || helperOf(f) ? [] : names(f))));
  const pending = [...order.filter((f) => !named.has(f)), ...order.filter((f) => named.has(f) && f.endsWith('.sh')), ...order.filter((f) => named.has(f) && f.endsWith('.mjs'))];
  const mark = (f: string): void => { if (isMutants(f)) return; for (const g of names(f)) if (!reached.has(g) && !entries.has(g)) { reached.add(g); mark(g); } };
  for (const f of pending) { if (entries.has(f) || reached.has(f)) continue; entries.add(f); mark(f); }
  const orphans = [...entries].sort();
  const commands: Record<string, string> = {};
  for (const k of rigScripts) commands[k] = pkg.scripts[k];
  return { ids: [...rigScripts, ...orphans], commands };
}

export function readRigFile(root: string): RigFile {
  return JSON.parse(fs.readFileSync(path.join(root, '.github', 'ci-rigs.json'), 'utf8')) as RigFile;
}

/** Problems of the data file against the repo: each one is a reason a new/removed rig would be silently absent or stale. */
export function validateRigs(file: RigFile, required: string[]): string[] {
  const problems: string[] = [];
  const ids = new Map<string, number>();
  for (const r of file.rigs) ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) problems.push(`duplicate entry: ${id} (${n}x)`);
  for (const id of required) if (!ids.has(id)) problems.push(`rig not classified: ${id} — add it to .github/ci-rigs.json as RUNS_IN_CI, or LOCAL_ONLY with a reason`);
  for (const r of file.rigs) {
    if (!required.includes(r.id)) problems.push(`stale entry (no such script/file): ${r.id}`);
    if (r.class !== 'RUNS_IN_CI' && r.class !== 'LOCAL_ONLY') problems.push(`${r.id}: class must be RUNS_IN_CI or LOCAL_ONLY, got ${JSON.stringify(r.class)}`);
    if (!r.command?.trim()) problems.push(`${r.id}: empty command`);
    if (r.class === 'LOCAL_ONLY' && !r.reason?.trim()) problems.push(`${r.id}: LOCAL_ONLY without a reason`);
    if (r.group !== undefined && !(Number.isInteger(r.group) && r.group >= 1 && r.group <= (file.groups ?? DEFAULT_GROUPS))) problems.push(`${r.id}: group ${r.group} is outside 1..${file.groups ?? DEFAULT_GROUPS}`);
    for (const k of ['passPattern', 'failPattern'] as const) {
      if (r[k] !== undefined) { try { new RegExp(r[k] as string); } catch { problems.push(`${r.id}: ${k} is not a valid regex`); } }
    }
  }
  return problems;
}

export const DEFAULT_GROUPS = 4;
const DEFAULT_WEIGHT_SEC = 300;

/** RUNS_IN_CI rig ids per group (1-based, index 0 = group 1): an explicit `group` is honoured, the rest go longest-first (by `wallSec`) onto the lightest group. Deterministic. */
export function assignGroups(file: RigFile): string[][] {
  const n = file.groups ?? DEFAULT_GROUPS;
  const groups: string[][] = Array.from({ length: n }, () => []);
  const load = Array<number>(n).fill(0);
  const weight = (r: RigEntry): number => r.wallSec ?? DEFAULT_WEIGHT_SEC;
  const ci = file.rigs.filter((r) => r.class === 'RUNS_IN_CI');
  for (const r of ci) if (Number.isInteger(r.group) && (r.group as number) >= 1 && (r.group as number) <= n) { groups[(r.group as number) - 1].push(r.id); load[(r.group as number) - 1] += weight(r); }
  for (const r of ci.filter((x) => !(Number.isInteger(x.group) && (x.group as number) >= 1 && (x.group as number) <= n)).sort((a, b) => weight(b) - weight(a) || a.id.localeCompare(b.id))) {
    const g = load.indexOf(Math.min(...load));
    groups[g].push(r.id); load[g] += weight(r);
  }
  return groups.map((g) => g.sort());
}

// ---- log parsing (shared by the rig runner and the suite runner) ------------------------------------------------------------------

export const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

export interface Counts { run: number; pass: number; fail: number; skipped: number; source: string; /** TAP `# todo` count: a todo test is not a passing one (the ticket: 0 skipped). */ todo?: number }

/** `node --test` TAP summary (`# tests 12`, `# pass 10` …). Null when the log has no summary (a truncated run is NOT a green one). */
export function parseTapSummary(log: string): Counts | null {
  const text = stripAnsi(log);
  const num = (k: string): number | null => {
    const ms = [...text.matchAll(new RegExp(`^# ${k} (\\d+)\\s*$`, 'gm'))];
    return ms.length ? Number(ms[ms.length - 1][1]) : null;
  };
  const run = num('tests'); const pass = num('pass'); const fail = num('fail'); const skipped = num('skipped');
  if (run === null || pass === null || fail === null) return null;
  const cancelled = num('cancelled') ?? 0;
  return { run, pass, fail: fail + cancelled, skipped: skipped ?? 0, todo: num('todo') ?? 0, source: 'TAP summary' };
}

/** Names (with the text after `# SKIP`) of skipped tests in a TAP log. */
export function tapSkips(log: string): { name: string; reason: string }[] {
  return [...stripAnsi(log).matchAll(/^\s*(?:ok|not ok) \d+ - (.*?) # SKIP\s*(.*)$/gm)].map((m) => ({ name: m[1].trim(), reason: m[2].trim() }));
}

/** Names of failed tests (`not ok N - name`) of a TAP log. */
export function tapFails(log: string): string[] {
  return [...stripAnsi(log).matchAll(/^\s*not ok \d+ - (.*?)(?: # .*)?$/gm)].map((m) => m[1].trim());
}

const PASS_DEFAULT = /^\s*(?:✓|✔|\[?PASS\]?(?![-\w])|ok\b)|\bPASS\b|"ok":\s*true|\bKILLED\b|\bGREEN\b/;
/** A rig that did not measure (VOID / BROKEN / not exercised) prints one of these and may still exit 0 with some PASS lines elsewhere: it counts as SKIPPED, which fails the job. */
const VOID_RE = /(: VOID\b(?! instrument)|^\s*VOID\b|\bBROKEN no\b|NOT EXERCISED)/;
const FAIL_DEFAULT = /^\s*(?:✗|✘|\[?FAIL\]?(?![-\w])|not ok\b)|"ok":\s*false/;

/** A rig's own arm counts: the TAP summary when it prints one, else lines matching its pass/fail pattern (defaults: PASS / ✓ / ok vs FAIL / ✗ / not ok). */
export function parseRigCounts(log: string, entry?: Pick<RigEntry, 'passPattern' | 'failPattern'>): Counts {
  const tap = parseTapSummary(log);
  if (tap && !entry?.passPattern) return tap;
  const lines = stripAnsi(log).split('\n');
  const pp = entry?.passPattern ? new RegExp(entry.passPattern) : PASS_DEFAULT;
  const fp = entry?.failPattern ? new RegExp(entry.failPattern) : FAIL_DEFAULT;
  const pass = lines.filter((l) => pp.test(l)).length;
  const fail = lines.filter((l) => fp.test(l) && !pp.test(l)).length;
  const skipped = lines.filter((l) => VOID_RE.test(l) && !/AS EXPECTED|expect VOID/.test(l)).length;
  return { run: pass + fail + skipped, pass, fail, skipped, source: entry?.passPattern ? 'passPattern lines' : 'PASS/FAIL lines' };
}

/** The verdict of one job: green only on exit 0 AND at least one arm that passed, with no failed TEST (TAP) and no unlisted skip. Zero arms is red (no silent green).
 *  A non-TAP rig's own exit code is its verdict on its FAIL lines (mutant rigs print "FAIL" for the arms a mutant is MEANT to break), so those are shown, not vetoed. */
export function judge(exitCode: number, counts: Counts, opts: { skippedAllowed?: number } = {}): { ok: boolean; why: string } {
  if (exitCode !== 0) return { ok: false, why: `command exited ${exitCode}` };
  if (counts.run === 0) return { ok: false, why: 'ran 0 tests/arms (a job that runs nothing is red)' };
  if (counts.pass === 0) return { ok: false, why: 'no passing test/arm counted' };
  if (counts.fail > 0 && counts.source === 'TAP summary') return { ok: false, why: `${counts.fail} failed` };
  if ((counts.todo ?? 0) > 0) return { ok: false, why: `${counts.todo} todo test(s) (a todo is neither a pass nor a listed skip)` };
  if (counts.skipped - (opts.skippedAllowed ?? 0) > 0) return { ok: false, why: `${counts.skipped - (opts.skippedAllowed ?? 0)} skipped (not allow-listed)` };
  return { ok: true, why: 'ok' };
}

/** One arm of a one-arm-per-process rig (scripts/ci/each-arm.mjs). An arm's verdict is its exit code AND the last JSON line carrying an `ok` key: several rigs end `process.exit(0)`
 *  unconditionally and print `{"arm":…,"ok":false}`; a VOID / BROKEN / not-exercised line is a measurement that did not happen. Red unless all three agree. */
export function judgeArm(status: number | null, output: string, expectAbort?: string): { ok: boolean; why: string } {
  const text = stripAnsi(output);
  if (expectAbort !== undefined) return status !== 0 && text.includes(expectAbort) ? { ok: true, why: 'aborted as expected' } : { ok: false, why: `expected an abort naming "${expectAbort}"` };
  if (status !== 0) return { ok: false, why: `exit ${status}` };
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('{') || !/"ok"\s*:/.test(l)) continue;
    try { const o = JSON.parse(l) as { ok?: unknown }; if (o.ok === false) return { ok: false, why: 'exit 0 but the arm printed "ok":false' }; if (o.ok === true) break; } catch { /* not a verdict line */ }
  }
  if (lines.some((l) => VOID_RE.test(l) && !/AS EXPECTED|expect VOID/.test(l))) return { ok: false, why: 'the arm printed VOID / BROKEN / not-exercised (nothing was measured)' };
  return { ok: true, why: 'ok' };
}
