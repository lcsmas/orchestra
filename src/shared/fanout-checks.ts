// #564 (closes #562) — preNominationChecks: the candidate's fast checks recorded per git TREE (as #512 verdicts) before a nomination. Ledger #565 D2': commands are DISCOVERED
// (changed path → nearest package.json with a `lint` script), `.orchestra/pre-nomination-checks.json` is an optional override (`checks: []` = explicit no-check); nothing found = refused.
// Pure: discovery, the file's parse, the record's shape, the nomination rule. The runner (git, spawn, timeout) is src/cli/fanout-check.ts.
import type { TicketState } from './fanout-state.ts';

export const CHECKS_FILE = '.orchestra/pre-nomination-checks.json';
export const CHECK_DEFAULT_TIMEOUT_SEC = 300;
export const CHECK_TIMEOUT_MAX_SEC = 86_400;
/** Records kept per ticket (the most recent trees): a rebase onto the same tree reuses its record, an old tree's is dropped. */
export const CHECK_RECORDS_KEPT = 8;
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;

export interface CheckSpec { run: string; cwd: string; timeoutSec: number; /** discovery only: the changed paths that led to this command */ from?: string }
export interface CheckResult { run: string; cwd: string; exit: number | null; timedOut: boolean; durationMs: number; tail: string; from?: string }
/** One run of the checks at one git tree. `source` = where the commands came from; `vacuous` = an explicit empty override or no changed file (nothing to run);
 *  `nothingFound` = files changed, no override, no package with a lint script (NOT a pass); `ok` = !nothingFound and every command exited 0 inside its limit. */
export interface CheckRecord { tree: string; head: string; at: string; source: 'override' | 'discovered'; vacuous: boolean; nothingFound: boolean; changed: number; ok: boolean; results: CheckResult[];
  /** changed paths under no package with a lint script (discovery only, first 20) — they were NOT linted · the candidate itself adds/changes/deletes the override file */
  uncovered: string[]; overrideChanged: boolean }

type PkgReader = (dir: string) => { lint: boolean } | null;
const LOCKFILES: Array<[string, string]> = [['pnpm-lock.yaml', 'pnpm run lint'], ['yarn.lock', 'yarn run lint'], ['package-lock.json', 'npm run lint']];
const upDirs = (file: string): string[] => { const parts = file.split('/'); parts.pop(); const out: string[] = []; for (let n = parts.length; n >= 0; n--) out.push(parts.slice(0, n).join('/') || '.'); return out; };
/** D2' — each changed path maps to the NEAREST package.json (walking up to the repo root) that has a `lint` script; one command per such package, run from its directory.
 *  The package manager is the nearest lockfile's (pnpm / yarn / npm; none = npm). `readPkg(dir)` = null when the dir has no readable package.json. */
export function discoverChecks(changed: string[], readPkg: PkgReader, hasFile: (path: string) => boolean): { specs: CheckSpec[]; uncovered: string[] } {
  const byDir = new Map<string, string[]>();
  const uncovered: string[] = [];
  for (const f of changed) {
    const dir = upDirs(f).find((d) => readPkg(d)?.lint);
    if (dir !== undefined) byDir.set(dir, [...(byDir.get(dir) ?? []), f]); else uncovered.push(f);
  }
  const specs = [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, files]) => {
    const lock = upDirs(`${dir}/x`).map((d) => LOCKFILES.find(([name]) => hasFile(d === '.' ? name : `${d}/${name}`))).find(Boolean);
    const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? ` (+${files.length - 3})` : '');
    return { run: lock ? lock[1] : 'npm run lint', cwd: dir, timeoutSec: CHECK_DEFAULT_TIMEOUT_SEC, from: `${dir === '.' ? 'root' : dir}/package.json lint ← ${shown}` };
  });
  return { specs, uncovered };
}

/** The seam that runs one shell command (tests hand a fake; production = `defaultCheckExec`). `output` = stdout+stderr. */
export type CheckExec = (run: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv) => { exit: number | null; timedOut: boolean; output: string };

export class ChecksFileError extends Error {}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** D2 — `{"checks":[{"run":"<shell command>","cwd":"<relative path, default .>","timeoutSec":<positive int, default 300>}]}`. Unknown key / bad type / a cwd leaving the repo = refused. */
export function parseChecksFile(text: string): CheckSpec[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new ChecksFileError(`${CHECKS_FILE} is not valid JSON: ${(e as Error).message}`); }
  if (!isObj(raw)) throw new ChecksFileError(`${CHECKS_FILE} must be an object {"checks": [...]}`);
  for (const k of Object.keys(raw)) if (k !== 'checks') throw new ChecksFileError(`${CHECKS_FILE}: unknown key "${k}"`);
  if (!Array.isArray(raw.checks)) throw new ChecksFileError(`${CHECKS_FILE}: "checks" must be an array`);
  return raw.checks.map((c, i): CheckSpec => {
    const at = `${CHECKS_FILE}: checks[${i}]`;
    if (!isObj(c)) throw new ChecksFileError(`${at} must be an object {run, cwd?, timeoutSec?}`);
    for (const k of Object.keys(c)) if (k !== 'run' && k !== 'cwd' && k !== 'timeoutSec') throw new ChecksFileError(`${at}: unknown key "${k}"`);
    if (typeof c.run !== 'string' || !c.run.trim()) throw new ChecksFileError(`${at}.run must be a non-empty string`);
    if (c.cwd !== undefined && (typeof c.cwd !== 'string' || !c.cwd.trim())) throw new ChecksFileError(`${at}.cwd must be a non-empty string`);
    const cwd = (c.cwd as string | undefined)?.trim() ?? '.';
    if (cwd.startsWith('/') || cwd.split(/[\\/]/).includes('..')) throw new ChecksFileError(`${at}.cwd must be a path inside the repo (relative, no "..")`);
    const t = c.timeoutSec;
    if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > CHECK_TIMEOUT_MAX_SEC)) throw new ChecksFileError(`${at}.timeoutSec must be a positive integer (at most ${CHECK_TIMEOUT_MAX_SEC})`);
    return { run: c.run, cwd, timeoutSec: (t as number | undefined) ?? CHECK_DEFAULT_TIMEOUT_SEC };
  });
}

/** The last lines of a command's output, bounded: what a refusal shows. */
export function outputTail(out: string): string {
  const lines = out.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const t = lines.slice(-TAIL_LINES).join('\n');
  return t.length > TAIL_CHARS ? `…${t.slice(-TAIL_CHARS)}` : t;
}

/** Fold one run into a record. Passing = no command failed (exit !== 0 or timed out); an empty list is a vacuous pass. */
export function buildRecord(tree: string, head: string, at: string, source: CheckRecord['source'], changed: number, nothingFound: boolean, results: CheckResult[], uncovered: string[] = [], overrideChanged = false): CheckRecord {
  return { tree, head, at, source, vacuous: results.length === 0 && !nothingFound, nothingFound, changed, ok: !nothingFound && results.every((r) => r.exit === 0 && !r.timedOut), results, uncovered, overrideChanged };
}
/** Add `rec` (replacing the same tree's) and keep the CHECK_RECORDS_KEPT most recent. */
export function withRecord(records: Record<string, CheckRecord>, rec: CheckRecord): Record<string, CheckRecord> {
  const all = Object.values({ ...records, [rec.tree]: rec }).sort((a, b) => a.at.localeCompare(b.at)).slice(-CHECK_RECORDS_KEPT);
  return Object.fromEntries(all.map((r) => [r.tree, r]));
}

const failureLine = (r: CheckResult): string => `${r.timedOut ? `timed out after ${Math.round(r.durationMs / 1000)}s` : `exit ${r.exit}`}: \`${r.run}\`${r.cwd !== '.' ? ` (in ${r.cwd})` : ''}${r.tail ? `\n${r.tail}` : ''}`;
/** The nomination rule (#564): null = admitted; else the refusal text. Only the switch `on` asks; the record is looked up by the TREE of the candidate head (unknown tree = none). */
export function nominationRefusal(t: Pick<TicketState, 'tree' | 'head' | 'checks'>, ticket: string): string | null {
  const rec = t.tree ? t.checks?.[t.tree] : undefined;
  if (!rec) return `${ticket}: no check record for this head${t.head ? ` (${t.head.slice(0, 8)}${t.tree ? `, tree ${t.tree.slice(0, 8)}` : ', tree unreadable'})` : ''} — preNominationChecks is on for this run: run \`orchestra fanout check ${ticket} --head ${t.head?.slice(0, 12) ?? '<sha>'}\` from a clean worktree at that head, then nominate`;
  if (rec.ok) return null;
  if (rec.nothingFound) return `${ticket}: the pre-nomination checks found NOTHING to run for this head (tree ${rec.tree.slice(0, 8)}): ${rec.changed} changed file(s), no package.json with a \`lint\` script above them and no ${CHECKS_FILE} — add a lint script, or write the override file (an explicit {"checks":[]} is the only way to nominate with no check), then COMMIT it (the \`.orchestra/\` folder is gitignored in an Orchestra worktree: \`git add -f ${CHECKS_FILE}\`) and run \`orchestra fanout check ${ticket}\` again`;
  const bad = rec.results.filter((r) => r.exit !== 0 || r.timedOut);
  return `${ticket}: the pre-nomination checks FAILED at this head (tree ${rec.tree.slice(0, 8)}, recorded ${rec.at}) — ${bad.map(failureLine).join('\n')}\nfix, commit, run \`orchestra fanout check ${ticket}\` again`;
}
