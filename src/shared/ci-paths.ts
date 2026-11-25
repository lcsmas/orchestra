// #595 — path selection for the PR CI: a changed-file list in → the rigs to run + why (and why the others do not). Pure: no fs, no git, no env.
// Data = `.github/ci-rigs.json` (per rig `paths`, top-level `sharedPaths` / `noRigPaths`). Closure walking (recall check, path generation) is src/shared/ci-closure.ts.
import path from 'node:path';
import { createWalker, type Tree } from './ci-closure.ts';
import type { RigEntry, RigFile } from './ci-rigs.ts';

// ---- globs ------------------------------------------------------------------------------------------------------------------------
// Repo-root-relative, `/`-separated. `**/` = zero or more directories, `**` = anything, `*` = anything but `/`, `?` = one char but `/`. A leading `!` negates.
// A list is evaluated in order and the LAST pattern that matches decides (gitignore-style), so `src/main/**` then `!**/*.test.ts` then `src/main/x.test.ts` works.
const reCache = new Map<string, RegExp>();
export function globToRegExp(glob: string): RegExp {
  const hit = reCache.get(glob); if (hit) return hit;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; } }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const r = new RegExp(`^${re}$`); reCache.set(glob, r); return r;
}

/** Does `file` match the ordered pattern list (last matching entry wins; none ⇒ false)? Returns the deciding positive pattern, or null. */
export function matchPaths(patterns: readonly string[], file: string): string | null {
  let verdict: string | null = null;
  for (const p of patterns) {
    const neg = p.startsWith('!');
    if (globToRegExp(neg ? p.slice(1) : p).test(file)) verdict = neg ? null : p;
  }
  return verdict;
}

/** A rig's patterns with every `@set` entry replaced, in place, by the patterns of `file.pathSets[set]` (generated: the import graph of one bundle, shared by the rigs that run it). */
export function expandPaths(file: Pick<RigFile, 'pathSets'>, patterns: readonly string[]): string[] {
  return patterns.flatMap((p) => (p.startsWith('@') ? (file.pathSets?.[p.slice(1)] ?? []) : [p]));
}

/** Problems with a pattern list (it reaches `validateRigs`): empty / non-string entries, no positive entry, absolute or `..` paths. */
export function validatePatterns(owner: string, patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return [`${owner}: must be an array of globs`];
  const out: string[] = [];
  if (patterns.length === 0) out.push(`${owner}: empty list (omit it instead — an absent list means "always")`);
  for (const p of patterns) {
    if (typeof p !== 'string' || !p.trim()) { out.push(`${owner}: entry ${JSON.stringify(p)} is not a non-empty string`); continue; }
    const body = p.startsWith('!') ? p.slice(1) : p;
    if (body.startsWith('@')) continue; // a set reference: resolved by validateRigs (it knows the sets)
    if (body.startsWith('/') || body.split('/').includes('..') || body.startsWith('./')) out.push(`${owner}: ${JSON.stringify(p)} must be repo-root-relative (no leading / or ./, no ..)`);
  }
  if (patterns.length && patterns.every((p) => typeof p === 'string' && p.startsWith('!'))) out.push(`${owner}: only negated entries — nothing is ever matched`);
  return out;
}

// ---- delta files: shared files whose CHANGE can be read ---------------------------------------------------------------------------
// package.json and .github/ci-rigs.json are in `sharedPaths` (a change runs everything) but almost every PR edits one of them to add a rig. When the caller can read the file
// at the base and at the head, an edit that touches ONLY rig entries / rig scripts selects exactly those rigs; anything else (deps, build scripts, groups, sharedPaths …) is shared.
export interface DeltaCtx { before(p: string): string | null; after(p: string): string | null }
export const DELTA_FILES = ['package.json', '.github/ci-rigs.json'] as const;
type Delta = { full: string } | { ids: string[]; why: string };

const parse = (t: string | null): Record<string, unknown> | null => { if (t === null) return null; try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; } };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const RIG_SCRIPT = /^(?:test|canary):/;

/** Script names a rig command reaches through `pnpm run x` hops of package.json (its own text only; the closure walk covers files). */
function scriptsReached(command: string, scripts: Record<string, string>): Set<string> {
  const seen = new Set<string>(); const queue = [command];
  while (queue.length) for (const m of (queue.shift() as string).matchAll(/\b(?:pnpm|npm)\s+(?:run\s+)?([\w:.-]+)/g)) if (scripts[m[1]] !== undefined && !seen.has(m[1])) { seen.add(m[1]); queue.push(scripts[m[1]]); }
  return seen;
}

function packageJsonDelta(file: RigFile, before: string | null, after: string | null): Delta {
  const b = parse(before); const a = parse(after);
  if (!b || !a) return { full: 'package.json is unreadable at the base or the head' };
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (k !== 'scripts' && !same(b[k], a[k])) return { full: `package.json: \`${k}\` changed (not a rig script)` };
  const sb = (b.scripts ?? {}) as Record<string, string>; const sa = (a.scripts ?? {}) as Record<string, string>;
  const changed = [...new Set([...Object.keys(sb), ...Object.keys(sa)])].filter((k) => sb[k] !== sa[k]).sort();
  const other = changed.filter((k) => !RIG_SCRIPT.test(k));
  if (other.length) return { full: `package.json: script ${other.slice(0, 3).join(', ')} changed (not a test:/canary: rig script)` };
  const ids = file.rigs.filter((r) => r.class === 'RUNS_IN_CI' && (changed.includes(r.id) || [...scriptsReached(r.command, sa)].some((k) => changed.includes(k)))).map((r) => r.id);
  return { ids, why: `package.json script${changed.length > 1 ? 's' : ''} ${few(changed)} changed` };
}

const RIG_RUN_FIELDS = ['command', 'pre', 'passPattern', 'failPattern', 'timeoutMin', 'class'] as const;
function rigsJsonDelta(before: string | null, after: string | null): Delta {
  const b = parse(before); const a = parse(after);
  if (!b || !a) return { full: '.github/ci-rigs.json is unreadable at the base or the head' };
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (k !== 'rigs' && k !== '_doc' && !same(b[k], a[k])) return { full: `.github/ci-rigs.json: top-level \`${k}\` changed` };
  const byId = (x: Record<string, unknown>): Map<string, RigEntry> => new Map(((x.rigs ?? []) as RigEntry[]).map((r) => [r.id, r]));
  const rb = byId(b); const ra = byId(a); const ids: string[] = [];
  for (const [id, r] of ra) {
    const old = rb.get(id);
    if (r.class !== 'RUNS_IN_CI') continue;
    if (!old || RIG_RUN_FIELDS.some((f) => !same(old[f], r[f]))) ids.push(id);
  }
  return { ids, why: `.github/ci-rigs.json: entr${ids.length === 1 ? 'y' : 'ies'} ${few(ids)} added or changed` };
}

function deltaOf(file: RigFile, f: string, ctx: DeltaCtx): Delta {
  return f === 'package.json' ? packageJsonDelta(file, ctx.before(f), ctx.after(f)) : rigsJsonDelta(ctx.before(f), ctx.after(f));
}

// ---- selection --------------------------------------------------------------------------------------------------------------------
export interface RigVerdict { id: string; why: string }
export interface Selection {
  /** `all`: every RUNS_IN_CI rig runs (the reason is `fullReason`); `paths`: only the rigs linked to the changed files. */
  mode: 'all' | 'paths';
  fullReason: string | null;
  changed: string[];
  ran: RigVerdict[];
  skipped: RigVerdict[];
  /** LOCAL_ONLY rigs whose paths the change touches: CI does not run them, the verifier / owner does. */
  localOnly: RigVerdict[];
}

const few = (xs: string[], n = 3): string => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} +${xs.length - n} more`);

/** Which rigs run for `changed`. `full` (a reason string — the `ci-full` label, a manual dispatch, the release gate) forces everything; so does an empty/unknown change list,
 *  a changed shared file, and a changed file no rig claims (a rig of ANY class claims a file through `paths`; `noRigPaths` = files the suite alone gates, on purpose). */
export function selectRigs(file: RigFile, changed: string[] | null | undefined, full?: string | null, ctx?: DeltaCtx): Selection {
  const ci = file.rigs.filter((r) => r.class === 'RUNS_IN_CI');
  const local = file.rigs.filter((r) => r.class === 'LOCAL_ONLY');
  let files = [...new Set(changed ?? [])].filter(Boolean).sort();
  const everything = (reason: string): Selection => ({
    mode: 'all', fullReason: reason, changed: files,
    ran: ci.map((r) => ({ id: r.id, why: reason })), skipped: [],
    localOnly: local.map((r) => ({ r, p: r.paths ? expandPaths(file, r.paths) : null })).filter((x) => x.p && files.some((f) => matchPaths(x.p as string[], f))).map((x) => ({ id: x.r.id, why: `changed: ${few(files.filter((f) => matchPaths(x.p as string[], f)))}` })),
  });
  if (full) return everything(full);
  if (files.length === 0) return everything('no changed-file list (empty or unreadable): cannot select, everything runs');
  const pats = new Map(file.rigs.map((r) => [r.id, r.paths ? expandPaths(file, r.paths) : null] as const));
  const shared = file.sharedPaths ?? [];
  // A delta file (package.json, ci-rigs.json) that the caller can read at both ends selects only the rigs its edit touches; not readable ⇒ plain shared.
  const forced = new Map<string, string>(); const rest: string[] = [];
  for (const f of files) {
    const p = matchPaths(shared, f);
    if (!p) { rest.push(f); continue; }
    const d = ctx && (DELTA_FILES as readonly string[]).includes(f) ? deltaOf(file, f, ctx) : { full: `shared file ${f} (matches sharedPaths ${p})` };
    if ('full' in d) return everything(d.full.startsWith('shared file') ? d.full : `shared file ${f}: ${d.full}`);
    for (const id of d.ids) if (!forced.has(id)) forced.set(id, d.why);
  }
  const noRig = file.noRigPaths ?? [];
  for (const f of rest) {
    const claimed = [...pats.values()].some((p) => p && matchPaths(p, f)) || matchPaths(noRig, f);
    if (!claimed) return everything(`unclaimed file ${f}: no rig declares it and it is not in noRigPaths`);
  }
  const files0 = files; files = rest;
  const touch = (r: RigEntry): string[] => { const p = pats.get(r.id); return p ? files.filter((f) => matchPaths(p, f)) : []; };
  const ran: RigVerdict[] = []; const skipped: RigVerdict[] = [];
  for (const r of ci) {
    if (!r.paths) { ran.push({ id: r.id, why: 'no declared paths: runs always' }); continue; }
    const t = touch(r); const fr = forced.get(r.id);
    if (t.length || fr) ran.push({ id: r.id, why: [fr, t.length ? `changed: ${few(t)}` : ''].filter(Boolean).join('; ') }); else skipped.push({ id: r.id, why: 'no changed file in its paths' });
  }
  const localOnly = local.map((r) => ({ r, t: touch(r) })).filter((x) => x.t.length).map((x) => ({ id: x.r.id, why: `changed: ${few(x.t)}` }));
  return { mode: 'paths', fullReason: null, changed: files0, ran, skipped, localOnly };
}

/** The compact form the workflow passes between jobs (inventory → matrix / summary): never the long `changed` list. */
export interface SelectionWire { mode: 'all' | 'paths'; reason: string | null; changed: number; ids: string[]; skipped: RigVerdict[]; ran: RigVerdict[]; localOnly: RigVerdict[] }
export function toWire(s: Selection): SelectionWire {
  return { mode: s.mode, reason: s.fullReason, changed: s.changed.length, ids: s.ran.map((r) => r.id), ran: s.ran, skipped: s.skipped, localOnly: s.localOnly };
}

/** Markdown for the job summary / the PR: which rigs ran, which did not and why. */
export function renderSelection(w: SelectionWire, totalCi: number): string {
  const lines = [`## Rig selection — ${w.mode === 'all' ? `**all ${totalCi} rigs** (${w.reason})` : `**${w.ran.length} of ${totalCi} rigs** linked to ${w.changed} changed file(s); ${w.skipped.length} skipped by path`}`, ''];
  if (w.mode === 'paths') {
    lines.push('Rigs **skipped by path** (the release gate runs every one of them before the tag; the label `ci-full` forces them on this PR):', '', `<details><summary>${w.skipped.length} skipped</summary>`, '', ...w.skipped.map((r) => `- \`${r.id}\` — ${r.why}`), '', '</details>', '');
    lines.push(`<details><summary>${w.ran.length} ran</summary>`, '', ...w.ran.map((r) => `- \`${r.id}\` — ${r.why}`), '', '</details>', '');
  }
  if (w.localOnly.length) lines.push(`LOCAL_ONLY rigs linked to this change (CI does NOT run them — run them locally): ${w.localOnly.map((r) => `\`${r.id}\``).join(', ')}`, '');
  return lines.join('\n');
}

// ---- recall check + path generation (uses the closure walker) ---------------------------------------------------------------------
/** The recall check: a rig's declared paths (or the shared paths) must cover every file its own command can reach. A rig with no `paths` runs always and cannot miss. */
export function recallProblems(file: RigFile, tree: Tree, pkgScripts: Record<string, string>): string[] {
  const w = createWalker(tree, pkgScripts); const out: string[] = [];
  for (const r of file.rigs) {
    if (!r.paths) continue;
    const pats = expandPaths(file, r.paths);
    const missed = [...w.closure(r.command).files].filter((f) => !matchPaths(pats, f) && !matchPaths(file.sharedPaths ?? [], f)).sort();
    if (missed.length) out.push(`${r.id}: its own command reaches ${missed.length} file(s) its declared paths do not cover — e.g. ${missed.slice(0, 4).join(', ')} (add them to its \`paths\` in .github/ci-rigs.json, or run \`node --experimental-strip-types scripts/ci/rigs.mjs paths ${r.id}\`)`);
  }
  return out;
}

/** The generated `pathSets` (one per built bundle) and each rig's `paths` = the sets its closure contains + the compressed rest. Pure: the CLI writes the result. */
export function generatePaths(file: RigFile, tree: Tree, pkgScripts: Record<string, string>): { pathSets: Record<string, string[]>; paths: Record<string, string[]> } {
  const w = createWalker(tree, pkgScripts);
  const builds: Record<string, string> = { 'bundle:app': 'vite build', 'bundle:cli': 'pnpm run build:cli', 'bundle:keeper': 'pnpm run build:keeper', 'bundle:acces-mobile': 'pnpm run build:acces-mobile' };
  const sets = Object.entries(builds).map(([name, cmd]) => ({ name, files: w.closure(cmd).files }));
  const pathSets: Record<string, string[]> = {};
  for (const s of sets) pathSets[s.name] = compressPaths(s.files, tree.files);
  const paths: Record<string, string[]> = {};
  for (const r of file.rigs) {
    const closure = new Set([...w.closure(r.command).files].filter((f) => f !== 'package.json'));
    const used = sets.filter((s) => [...s.files].every((f) => closure.has(f) || f === 'package.json'));
    const rest = new Set(closure); for (const s of used) for (const f of s.files) rest.delete(f);
    paths[r.id] = [...used.map((s) => `@${s.name}`), ...compressPaths(rest, tree.files), ...(r.pathsExtra ?? [])];
  }
  return { pathSets, paths };
}

const isTest = (f: string): boolean => /\.test\.(?:ts|tsx|mjs)$/.test(f);

/** Declared paths for a closure: a directory (depth ≥ 2) the closure mostly covers becomes `dir/**`, the rest are exact files, test files are re-included explicitly. */
export function compressPaths(closure: Iterable<string>, repoFiles: readonly string[], opts: { minShare?: number; minFiles?: number } = {}): string[] {
  const minShare = opts.minShare ?? 0.9; const minFiles = opts.minFiles ?? 8;
  const cl = new Set(closure);
  const nonTest = repoFiles.filter((f) => !isTest(f));
  const dirsOf = (f: string): string[] => { const out: string[] = []; let d = path.posix.dirname(f); while (d !== '.') { out.push(d); d = path.posix.dirname(d); } return out.reverse(); };
  const all = new Map<string, { total: number; hit: number }>();
  for (const f of nonTest) for (const d of dirsOf(f)) { const e = all.get(d) ?? { total: 0, hit: 0 }; e.total++; if (cl.has(f)) e.hit++; all.set(d, e); }
  const globs: string[] = []; const covered = (f: string): boolean => globs.some((g) => f.startsWith(g.slice(0, -2)));
  // Top-down by depth so the largest qualifying directory wins.
  for (const [d, e] of [...all].filter(([d]) => d.includes('/')).sort((a, b) => a[0].split('/').length - b[0].split('/').length || a[0].localeCompare(b[0]))) {
    if (e.hit >= minFiles && e.hit / e.total >= minShare && !covered(`${d}/x`)) globs.push(`${d}/**`);
  }
  const exact = [...cl].filter((f) => !covered(f)).sort();
  const out = [...globs.sort(), ...exact.filter((f) => !isTest(f))];
  const tests = [...cl].filter(isTest).sort();
  if (globs.length) { out.push('!**/*.test.ts', '!**/*.test.tsx', '!**/*.test.mjs'); out.push(...tests); }
  else out.push(...tests);
  return out;
}
