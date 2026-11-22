// #469 — the fan-out vague's execution state: ONE file per run (<ORCHESTRA_HOME>/fanout/<run>/state.json),
// one writer, atomic rewrite, and a pure reconcile against git/gh reality. Prior art: Reclaim's run file + 5-step resume.
// Pure logic + tiny fs helpers; the CLI (src/cli/fanout-state.ts) owns argv and the git/gh runner.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATE_VERSION = 1;

export const TICKET_STATUSES = ['todo', 'started', 'nominated', 'gated', 'merged', 'dropped'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const VERDICTS = ['none', 'pass', 'fail', 'approve', 'changes-requested'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** #510 — the frozen acceptance tests of a ticket: path → sha256 of the bytes the test writer froze. Written ONLY by `fanout acceptance freeze|amend` (never by `state set`). */
export interface Acceptance {
  files: Record<string, string>;
  /** sha256 of the sorted `path\0sha\n` lines of `files` (see `acceptanceHash`). */
  hash: string;
  /** Targeted test command, run with cwd = the candidate checkout. */
  run: string;
  source: { branch: string | null; head: string };
  frozenAt: string;
  amendments: Array<{ at: string; decision: string; specSentence: string; hashBefore: string; hashAfter: string }>;
}

export interface TicketState {
  /** Work branch (the nominated ref NAME is frozen once nominated). */
  branch: string | null;
  /** Pull request number, when one exists. */
  pr: number | null;
  /** Head sha the verdict / nomination speaks about. */
  head: string | null;
  verdict: Verdict;
  /** Upstream ticket ids: this ticket cannot be MERGED before each is merged, and is NOMINATED/GATED early only on an upstream's verified candidate (#506). */
  dependsOn: string[];
  /** #506 — upstream id → the upstream head this ticket was built on (rebased onto) and gated against. `deliver` re-proves it at merge time. */
  builtOn: Record<string, string>;
  /** Ref of the frozen interface a dependent may START against (ledger section, sha…). */
  frozenInterface: string | null;
  /** Why a `merged` ticket counts as merged although git/gh do not show it on the target (e.g. its PR landed in a stacked base that was later squash-merged). Explicit, human-written. */
  mergedAccepted: string | null;
  status: TicketStatus;
  /** #510 — frozen acceptance tests (null = none). Not in SETTABLE_KEYS: only the acceptance verb writes it. */
  acceptance: Acceptance | null;
  updatedAt: string;
}

export interface FanoutState {
  version: typeof STATE_VERSION;
  run: string;
  /** Integration branch the tickets merge into (reality is read against `origin/<target>`). */
  target: string;
  /** `owner/name` for `gh -R`; null = the checkout's own repo. */
  repo: string | null;
  tickets: Record<string, TicketState>;
  updatedAt: string;
  reconciledAt: string | null;
}

const TOP_KEYS = new Set(['version', 'run', 'target', 'repo', 'tickets', 'updatedAt', 'reconciledAt']);
const TICKET_KEYS = new Set(['branch', 'pr', 'head', 'verdict', 'dependsOn', 'builtOn', 'frozenInterface', 'mergedAccepted', 'status', 'acceptance', 'updatedAt']);
/** The fields a `state set` may change (updatedAt is the writer's). */
export const SETTABLE_KEYS = ['branch', 'pr', 'head', 'verdict', 'dependsOn', 'builtOn', 'frozenInterface', 'mergedAccepted', 'status'] as const;
export type TicketPatch = Partial<Pick<TicketState, (typeof SETTABLE_KEYS)[number]>>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_SHA = /^[0-9a-f]{7,40}$/;
export const SAFE_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/+@-]{0,199}$/;
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9._#:-]{0,63}$/;

export class FanoutStateError extends Error {}

export function assertRunId(run: string): string {
  if (!SAFE_ID.test(run) || run.includes('..')) throw new FanoutStateError(`unsafe run id ${JSON.stringify(run)} (letters, digits, . _ - only)`);
  return run;
}
/** #486 — the run `orchestra fanout state` acts on. --run wins; else the caller's OWN run (= its workspace id: a coordinator
 *  owns the run named by its own id, `runIdOf`); `$ORCHESTRA_RUN_ID` only outside a workspace. Inside one it is the PARENT's run
 *  until the first spawn (ownsRun is set then), so it is never the default — `inherited` carries it for the hint. */
export function resolveFanoutRun(flag: string | undefined, env: { ORCHESTRA_WS_ID?: string; ORCHESTRA_WS_ID_IDENTITY?: string; ORCHESTRA_RUN_ID?: string }): { run: string | null; inherited: string | null } {
  const own = (env.ORCHESTRA_WS_ID || env.ORCHESTRA_WS_ID_IDENTITY || '').trim();
  const envRun = env.ORCHESTRA_RUN_ID?.trim() || null;
  const f = flag?.trim();
  if (f) return { run: f, inherited: null };
  if (own) return { run: own, inherited: envRun && envRun !== own ? envRun : null };
  return { run: envRun, inherited: null };
}

export function stateFile(home: string, run: string): string {
  return path.join(home, 'fanout', assertRunId(run), 'state.json');
}

export function newState(run: string, opts: { target?: string; repo?: string | null; now: string }): FanoutState {
  return { version: STATE_VERSION, run: assertRunId(run), target: opts.target ?? 'master', repo: opts.repo ?? null, tickets: {}, updatedAt: opts.now, reconciledAt: null };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function refuseUnknown(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw new FanoutStateError(`unknown field "${k}" in ${where}`);
}
const strOrNull = (v: unknown, name: string): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !v.trim()) throw new FanoutStateError(`${name} must be a non-empty string or null`);
  return v;
};
function checked(v: string | null, re: RegExp, name: string): string | null {
  if (v !== null && (!re.test(v) || v.includes('..') || v.endsWith('/') || v.endsWith('.lock'))) throw new FanoutStateError(`${name} is not an acceptable value: ${JSON.stringify(v)}`);
  return v;
}
function prOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new FanoutStateError('pr must be a positive integer or null');
  return v;
}
function depsOf(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((d) => typeof d !== 'string' || !SAFE_TICKET.test(d))) throw new FanoutStateError('dependsOn must be an array of ticket ids');
  return [...new Set(v as string[])];
}
function builtOnOf(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new FanoutStateError('builtOn must be an object {<upstream ticket>: <head sha>}');
  const out: Record<string, string> = {};
  for (const [k, h] of Object.entries(v)) {
    if (!SAFE_TICKET.test(k)) throw new FanoutStateError(`builtOn: unsafe ticket id ${JSON.stringify(k)}`);
    if (typeof h !== 'string' || !HEX_SHA.test(h)) throw new FanoutStateError(`builtOn[${k}] must be a 7-40 lowercase hex sha`);
    out[k] = h;
  }
  return out;
}
function enumOf<T extends string>(v: unknown, all: readonly T[], name: string): T {
  if (typeof v !== 'string' || !(all as readonly string[]).includes(v)) throw new FanoutStateError(`${name} must be one of ${all.join('|')} (got ${JSON.stringify(v)})`);
  return v as T;
}


const SHA256 = /^[0-9a-f]{64}$/;
/** A repo-relative POSIX path a frozen test may have: no absolute, no `..`, no backslash/NUL/newline, no leading `-`. */
export function assertAcceptancePath(p: unknown): string {
  if (typeof p !== 'string' || !p || p.length > 300 || p.startsWith('/') || p.startsWith('-') || /[\\\0\r\n]/.test(p) || p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new FanoutStateError(`unsafe acceptance path ${JSON.stringify(p)} (repo-relative, no .. / absolute / empty segment)`);
  }
  return p;
}
/** sha256 of the sorted `path\0sha\n` lines — the ticket's frozen-set identity. */
export function acceptanceHash(files: Record<string, string>): string {
  const lines = Object.keys(files).sort().map((k) => `${k}\0${files[k]}\n`).join('');
  return crypto.createHash('sha256').update(lines).digest('hex');
}
export const sha256Hex = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');

function acceptanceOf(v: unknown, where: string): Acceptance | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw new FanoutStateError(`${where}: acceptance must be an object or null`);
  refuseUnknown(v, new Set(['files', 'hash', 'run', 'source', 'frozenAt', 'amendments']), `${where} acceptance`);
  if (!isObj(v.files) || Object.keys(v.files).length === 0) throw new FanoutStateError(`${where}: acceptance.files must be a non-empty {path: sha256}`);
  const files: Record<string, string> = {};
  for (const [k, h] of Object.entries(v.files)) {
    assertAcceptancePath(k);
    if (typeof h !== 'string' || !SHA256.test(h)) throw new FanoutStateError(`${where}: acceptance.files[${k}] must be a 64-hex sha256`);
    files[k] = h;
  }
  if (typeof v.hash !== 'string' || v.hash !== acceptanceHash(files)) throw new FanoutStateError(`${where}: acceptance.hash does not match its files (hand-edited state?)`);
  if (typeof v.run !== 'string' || !v.run.trim() || v.run.length > 2000 || /[\r\n\0]/.test(v.run)) throw new FanoutStateError(`${where}: acceptance.run must be a single-line command`);
  if (!isObj(v.source)) throw new FanoutStateError(`${where}: acceptance.source missing`);
  refuseUnknown(v.source, new Set(['branch', 'head']), `${where} acceptance.source`);
  const head = checked(strOrNull(v.source.head, 'acceptance.source.head'), HEX_SHA, 'acceptance.source.head');
  if (!head) throw new FanoutStateError(`${where}: acceptance.source.head missing`);
  const branch = checked(strOrNull(v.source.branch, 'acceptance.source.branch'), SAFE_BRANCH, 'acceptance.source.branch');
  if (typeof v.frozenAt !== 'string') throw new FanoutStateError(`${where}: acceptance.frozenAt missing`);
  if (!Array.isArray(v.amendments)) throw new FanoutStateError(`${where}: acceptance.amendments must be an array`);
  const amendments = v.amendments.map((a, i) => {
    if (!isObj(a)) throw new FanoutStateError(`${where}: acceptance.amendments[${i}] is not an object`);
    refuseUnknown(a, new Set(['at', 'decision', 'specSentence', 'hashBefore', 'hashAfter']), `${where} acceptance.amendments[${i}]`);
    for (const k of ['at', 'decision', 'specSentence'] as const) if (typeof a[k] !== 'string' || !(a[k] as string).trim()) throw new FanoutStateError(`${where}: acceptance.amendments[${i}].${k} missing`);
    for (const k of ['hashBefore', 'hashAfter'] as const) if (typeof a[k] !== 'string' || !SHA256.test(a[k] as string)) throw new FanoutStateError(`${where}: acceptance.amendments[${i}].${k} must be a sha256`);
    return { at: a.at as string, decision: a.decision as string, specSentence: a.specSentence as string, hashBefore: a.hashBefore as string, hashAfter: a.hashAfter as string };
  });
  return { files, hash: v.hash, run: v.run, source: { branch, head }, frozenAt: v.frozenAt, amendments };
}

/** Parse + validate a whole state document. Unknown field (top level or per ticket) is REFUSED; so is a dependency cycle. */
export function parseState(raw: unknown): FanoutState {
  if (!isObj(raw)) throw new FanoutStateError('state is not an object');
  refuseUnknown(raw, TOP_KEYS, 'state');
  if (raw.version !== STATE_VERSION) throw new FanoutStateError(`unsupported state version ${JSON.stringify(raw.version)}`);
  if (typeof raw.run !== 'string') throw new FanoutStateError('run missing');
  if (typeof raw.target !== 'string' || !raw.target) throw new FanoutStateError('target missing');
  if (typeof raw.updatedAt !== 'string') throw new FanoutStateError('updatedAt missing');
  if (!isObj(raw.tickets)) throw new FanoutStateError('tickets missing');
  const tickets: Record<string, TicketState> = {};
  for (const [id, t] of Object.entries(raw.tickets)) {
    if (!SAFE_TICKET.test(id)) throw new FanoutStateError(`unsafe ticket id ${JSON.stringify(id)}`);
    if (!isObj(t)) throw new FanoutStateError(`ticket ${id} is not an object`);
    refuseUnknown(t, TICKET_KEYS, `ticket ${id}`);
    tickets[id] = {
      branch: checked(strOrNull(t.branch, 'branch'), SAFE_BRANCH, 'branch'),
      pr: prOrNull(t.pr),
      head: checked(strOrNull(t.head, 'head'), HEX_SHA, 'head (7-40 lowercase hex)'),
      verdict: enumOf(t.verdict ?? 'none', VERDICTS, 'verdict'),
      dependsOn: depsOf(t.dependsOn),
      builtOn: builtOnOf(t.builtOn),
      frozenInterface: strOrNull(t.frozenInterface, 'frozenInterface'),
      mergedAccepted: strOrNull(t.mergedAccepted, 'mergedAccepted'),
      status: enumOf(t.status ?? 'todo', TICKET_STATUSES, 'status'),
      acceptance: acceptanceOf(t.acceptance, `ticket ${id}`),
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : String(raw.updatedAt),
    };
  }
  const state: FanoutState = {
    version: STATE_VERSION,
    run: assertRunId(raw.run),
    target: raw.target,
    repo: strOrNull(raw.repo, 'repo'),
    tickets,
    updatedAt: raw.updatedAt,
    reconciledAt: typeof raw.reconciledAt === 'string' ? raw.reconciledAt : null,
  };
  assertAcyclic(state);
  return state;
}

function assertAcyclic(state: FanoutState): void {
  const seen = new Map<string, 1 | 2>();
  const visit = (id: string, chain: string[]): void => {
    if (seen.get(id) === 2) return;
    if (seen.get(id) === 1) throw new FanoutStateError(`dependency cycle: ${[...chain, id].join(' -> ')}`);
    seen.set(id, 1);
    for (const d of state.tickets[id]?.dependsOn ?? []) visit(d, [...chain, id]);
    seen.set(id, 2);
  };
  for (const id of Object.keys(state.tickets)) visit(id, []);
}

const sameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/**
 * #506 — may dependent `dep` be NOMINATED/GATED while its (unmerged) upstream `up` is open? Only on the upstream's verified candidate:
 * the upstream is nominated|gated with a recorded head and no failing verdict, and `dep` recorded the head it was built on = that head.
 * `upHead` overrides the state's head (reconcile passes the remote tip when it has one). null = admitted.
 */
export function upstreamBlocker(state: FanoutState, dep: TicketState, up: string, upHead?: string | null): { kind: 'ineligible' | 'changed'; why: string } | null {
  const u = state.tickets[up];
  if (!u) return { kind: 'ineligible', why: `${up} is unknown to the state` };
  if (u.status !== 'nominated' && u.status !== 'gated') return { kind: 'ineligible', why: `${up} is ${u.status} (it needs a nominated|gated candidate)` };
  if (u.verdict === 'fail' || u.verdict === 'changes-requested') return { kind: 'ineligible', why: `${up}'s verdict is ${u.verdict}` };
  const head = upHead ?? u.head;
  if (!head) return { kind: 'ineligible', why: `${up} has no recorded head` };
  const built = dep.builtOn[up];
  if (!built) return { kind: 'ineligible', why: `no builtOn for ${up} (record the head it was built on: --built-on ${up}=<sha>)` };
  if (!sameSha(built, head)) return { kind: 'changed', why: `built on ${up}@${built.slice(0, 8)} but ${up} is now at ${head.slice(0, 8)}` };
  return null;
}

/** #506 — what a ticket's upstreams mean for ITS gate and merge, from the state alone (`fanout gate --ticket` prints it; `resume` classifies the same facts).
 *  order: none (no unmerged upstream) | wait-upstream (stacked on a verified candidate: gate now, merge after it) | re-gate (the upstream moved since: verdict void) | blocked (an upstream is not an admissible candidate). */
export interface StackView {
  order: 'none' | 'wait-upstream' | 're-gate' | 'blocked';
  upstreams: Array<{ id: string; state: 'merged' | 'candidate' | 'changed' | 'ineligible'; builtOn: string | null; head: string | null; why?: string }>;
}
export function stackView(state: FanoutState, id: string): StackView | null {
  const t = state.tickets[id];
  if (!t) return null;
  const upstreams: StackView['upstreams'] = t.dependsOn.map((u) => {
    const ut = state.tickets[u];
    const head = ut?.head ?? null;
    const builtOn = t.builtOn[u] ?? null;
    if (upstreamMerged(state, u)) return builtOn && head && !sameSha(builtOn, head) ? { id: u, state: 'changed' as const, builtOn, head, why: `built on ${u}@${builtOn.slice(0, 8)} but ${u} merged at ${head.slice(0, 8)}` } : { id: u, state: 'merged' as const, builtOn, head };
    const b = upstreamBlocker(state, t, u);
    return b ? { id: u, state: b.kind, builtOn, head, why: b.why } : { id: u, state: 'candidate' as const, builtOn, head };
  });
  const order = upstreams.some((u) => u.state === 'ineligible') ? 'blocked' : upstreams.some((u) => u.state === 'changed') ? 're-gate' : upstreams.some((u) => u.state === 'candidate') ? 'wait-upstream' : 'none';
  return { order, upstreams };
}

/** Does `id` count as merged for the purpose of a dependent's rules? An unknown upstream is NOT merged. */
function upstreamMerged(state: FanoutState, id: string): boolean {
  return state.tickets[id]?.status === 'merged';
}
export function unmergedUpstreams(state: FanoutState, id: string): string[] {
  return (state.tickets[id]?.dependsOn ?? []).filter((d) => !upstreamMerged(state, d));
}

/**
 * The ONE transition function: apply `patch` to ticket `id` (creating it) and return the NEW state, or throw.
 * Rules in code:
 *  - unknown patch key refused;
 *  - a dependent may START (`started`) against a frozen interface, but is REFUSED `started` with an unmerged upstream and no frozenInterface;
 *  - `merged` is REFUSED while any upstream is not merged;
 *  - `nominated` / `gated` are admitted while an upstream is open only on its verified candidate (#506: nominated|gated, head recorded,
 *    no failing verdict, and `builtOn[upstream]` = that head) — an upstream that moved since is REFUSED until the dependent re-records.
 */
export function applyTicketPatch(state: FanoutState, id: string, patch: Record<string, unknown>, now: string): FanoutState {
  if (!SAFE_TICKET.test(id)) throw new FanoutStateError(`unsafe ticket id ${JSON.stringify(id)}`);
  refuseUnknown(patch, new Set<string>(SETTABLE_KEYS), 'patch');
  const prev: TicketState = state.tickets[id] ?? {
    branch: null, pr: null, head: null, verdict: 'none', dependsOn: [], builtOn: {}, frozenInterface: null, mergedAccepted: null, status: 'todo', acceptance: null, updatedAt: now,
  };
  const next: TicketState = { ...prev, updatedAt: now };
  if ('branch' in patch) next.branch = checked(strOrNull(patch.branch, 'branch'), SAFE_BRANCH, 'branch');
  if ('pr' in patch) next.pr = prOrNull(patch.pr);
  if ('head' in patch) next.head = checked(strOrNull(patch.head, 'head'), HEX_SHA, 'head (7-40 lowercase hex)');
  if ('verdict' in patch) next.verdict = enumOf(patch.verdict, VERDICTS, 'verdict');
  if ('dependsOn' in patch) next.dependsOn = depsOf(patch.dependsOn);
  if ('builtOn' in patch) next.builtOn = builtOnOf(patch.builtOn);
  if ('frozenInterface' in patch) next.frozenInterface = strOrNull(patch.frozenInterface, 'frozenInterface');
  if ('mergedAccepted' in patch) next.mergedAccepted = strOrNull(patch.mergedAccepted, 'mergedAccepted');
  if ('status' in patch) next.status = enumOf(patch.status, TICKET_STATUSES, 'status');
  if (next.mergedAccepted && next.status !== 'merged') throw new FanoutStateError(`${id}: mergedAccepted only applies to a merged ticket (status is ${next.status})`);
  for (const k of Object.keys(next.builtOn)) if (!next.dependsOn.includes(k)) throw new FanoutStateError(`${id}: builtOn names ${k}, which is not in dependsOn`);
  // #506 review R2/D1: a patch that drops builtOn and LEAVES a pass/approve verdict (kept, swapped pass↔approve, or set in the same patch) would make it read as "built after the upstream merged" (deliver skips the content check).
  if (next.verdict === 'pass' || next.verdict === 'approve') {
    const dropped = Object.keys(prev.builtOn).filter((k) => !(k in next.builtOn));
    if (dropped.length) throw new FanoutStateError(`${id}: cannot drop builtOn ${dropped.join(', ')} while the resulting ${next.verdict} verdict stands — void it first (--verdict none --status nominated), re-gate, then record`);
  }
  if (next.dependsOn.includes(id)) throw new FanoutStateError(`ticket ${id} cannot depend on itself`);
  const out: FanoutState = { ...state, tickets: { ...state.tickets, [id]: next }, updatedAt: now };
  assertAcyclic(out);
  const open = unmergedUpstreams(out, id);
  if (open.length > 0) {
    if (next.status === 'started' && !next.frozenInterface) {
      throw new FanoutStateError(`${id} cannot start: upstream ${open.join(', ')} not merged and no frozen interface to build against (set --frozen-interface)`);
    }
    if (next.status === 'merged') {
      throw new FanoutStateError(`${id} cannot be merged: upstream ${open.join(', ')} not merged yet — a dependent merges only after its upstream`);
    }
    if (next.status === 'nominated' || next.status === 'gated') {
      const why = open.map((u) => upstreamBlocker(out, next, u)).filter((b) => b !== null).map((b) => b.why);
      if (why.length > 0) throw new FanoutStateError(`${id} cannot be ${next.status}: upstream ${open.join(', ')} not merged and not an admissible candidate — ${why.join('; ')}`);
    }
  }
  if ((next.status === 'nominated' || next.status === 'gated' || next.verdict === 'pass' || next.verdict === 'approve') && !next.head) {
    throw new FanoutStateError(`${id}: ${next.status === 'nominated' || next.status === 'gated' ? next.status : `verdict ${next.verdict}`} needs a recorded head sha (--head): the gate and the head-moved check speak about one exact head`);
  }
  return out;
}

// ── persistence: one writer, atomic rewrite ───────────────────────────────────────────────────────────────

export function readState(file: string): FanoutState | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FanoutStateError(`${file} is not valid JSON`);
  }
  return parseState(raw);
}

/** Validate, then tmp+rename in the same directory: a reader sees the old file or the new one, never a torn one. */
export function writeStateAtomic(file: string, state: FanoutState): void {
  const valid = parseState(JSON.parse(JSON.stringify(state)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(valid, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/** Read-modify-write under an O_EXCL lock so two concurrent `state set` calls cannot lose an update; a lock older than `staleMs` is broken. */
export function updateState(file: string, mutate: (cur: FanoutState | null) => FanoutState, opts: { staleMs?: number; waitMs?: number } = {}): FanoutState {
  const lock = `${file}.lock`;
  const staleMs = opts.staleMs ?? 15_000;
  const deadline = Date.now() + (opts.waitMs ?? staleMs + 5_000);
  const token = `${process.pid}.${Date.now()}.${Math.random()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.rmSync(lock, { force: true }); continue; }
      } catch { /* lock vanished: retry */ }
      if (Date.now() > deadline) throw new FanoutStateError(`state is locked (${lock}); another writer is active`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const next = mutate(readState(file));
    writeStateAtomic(file, next);
    return next;
  } finally {
    // Remove the lock only if it is still OURS (a waiter may have judged it stale and taken over).
    try { if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
  }
}

// ── reconcile: state vs reality, pure ─────────────────────────────────────────────────────────────────────

/** What git/gh said about one ticket. `error` = the read FAILED: that is UNKNOWN, never "gone". */
export interface TicketReality {
  /** Remote tip of the branch (ls-remote); null = branch absent on the remote. */
  branchHead?: string | null;
  /** Is `branchHead` (or its PR's merge) an ancestor of origin/<target>? */
  mergedIntoTarget?: boolean;
  pr?: { state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string | null; baseRefName: string | null } | null;
  /** The reads that failed, e.g. `git ls-remote: exit 128`. Non-empty ⇒ nothing is concluded from the missing part. */
  error?: string;
}
export type Reality = Record<string, TicketReality>;

export type DivergenceKind =
  | 'state-merged-reality-not'
  | 'reality-merged-state-not'
  | 'head-moved'
  | 'pr-head-moved'
  | 'branch-gone'
  | 'pr-closed-unmerged'
  | 'pr-merged-other-base'
  | 'merged-at-ungated-head'
  | 'nominated-before-upstream-merged'
  | 'upstream-changed'
  | 'reality-unreadable';

export interface Divergence { ticket: string; kind: DivergenceKind; detail: string }

export type TicketClass = 'done' | 'dropped' | 'waiting' | 'startable' | 'in-progress' | 'awaiting-gate' | 'awaiting-merge' | 'needs-fix' | 'diverged';
export type ActionName =
  | 'none' | 'wait-upstream' | 'start' | 'start-against-frozen-interface' | 'continue' | 'gate' | 'merge' | 'fix-and-renominate'
  | 're-gate' | 'record-merged' | 'investigate' | 'recreate-branch';
export interface NextAction { action: ActionName; detail: string }

export interface TicketPlan { class: TicketClass; next: NextAction; divergences: Divergence[] }
export interface ReconcilePlan {
  tickets: Record<string, TicketPlan>;
  divergences: Divergence[];
  /** Step 5: reality-AHEAD facts safe to record. State-ahead claims (merged but not) are never auto-corrected. */
  writeBack: Array<{ ticket: string; patch: TicketPatch; why: string; seen: string }>;
}

/** Reality's word on "merged": a MERGED PR, or a branch tip contained in the target. undefined = unknown.
 *  Ancestry is evidence only once the work was nominated: a `started` branch cut from the target tip is trivially "contained". */
function realityMerged(r: TicketReality | undefined, status: TicketStatus, target: string): boolean | undefined {
  if (!r) return undefined;
  // A PR merged into another base (a stacked PR's upstream branch) is NOT on the target.
  if (r.pr?.state === 'MERGED' && r.pr.baseRefName === target) return true;
  if (r.mergedIntoTarget === true && status !== 'started') return true;
  if (r.error) return undefined;
  return false;
}

/** The head a MERGED ticket landed at when it differs from the head its pass/approve verdict covered; null = no such mismatch. */
function ungatedMergeHead(t: TicketState, r: TicketReality | undefined, rm: boolean | undefined): string | null {
  if (rm !== true || (t.status !== 'gated' && t.status !== 'merged') || (t.verdict !== 'pass' && t.verdict !== 'approve') || !t.head) return null;
  const mergedHead = r?.pr?.state === 'MERGED' ? r.pr.headRefOid : r?.branchHead;
  return mergedHead && !sameSha(mergedHead, t.head) ? mergedHead : null;
}

export function reconcile(state: FanoutState, reality: Reality): ReconcilePlan {
  const divergences: Divergence[] = [];
  const writeBack: ReconcilePlan['writeBack'] = [];
  const perTicket: Record<string, Divergence[]> = {};
  const add = (d: Divergence): void => { divergences.push(d); (perTicket[d.ticket] ??= []).push(d); };

  // CLASSIFY-1: the merged set used for dependents is what REALITY confirms — a state claim reality contradicts does not unblock anyone.
  const effMerged = (id: string): boolean => {
    const t = state.tickets[id];
    if (!t) return false;
    const rm = realityMerged(reality[id], t.status, state.target);
    if (ungatedMergeHead(t, reality[id], rm)) return false; // merged at a head no verdict covered: dependents wait for the re-gate
    if (t.status === 'merged' && t.mergedAccepted) return true; // explicit human override
    return rm === undefined ? t.status === 'merged' : rm;
  };

  for (const [id, t] of Object.entries(state.tickets)) {
    const r = reality[id];
    const claimsWork = t.status !== 'todo' && t.status !== 'dropped';
    if (r?.error) add({ ticket: id, kind: 'reality-unreadable', detail: `could not read git/gh (${r.error}); nothing concluded about this ticket` });
    const rm = realityMerged(r, t.status, state.target);
    const accepted = t.status === 'merged' && !!t.mergedAccepted;
    const ungated = ungatedMergeHead(t, r, rm);
    if (t.status === 'merged' && rm === false && !accepted) {
      add({ ticket: id, kind: 'state-merged-reality-not', detail: `state says merged but ${r?.pr ? `PR #${t.pr} is ${r.pr.state}` : 'its branch tip is not in origin/' + state.target}${r?.branchHead === null ? ' and the branch is gone' : ''}` });
    }
    if (t.status !== 'merged' && t.status !== 'dropped' && rm === true) {
      add({ ticket: id, kind: 'reality-merged-state-not', detail: `reality says merged (${r?.pr?.state === 'MERGED' ? `PR #${t.pr ?? '?'} MERGED` : `tip in origin/${state.target}`}) but state says ${t.status}` });
      // An ungated-head merge is NOT recorded: the divergence must persist across resumes until the merged tree is re-gated.
      if (!ungated) writeBack.push({ ticket: id, seen: t.updatedAt, patch: { status: 'merged' }, why: 'reality merged' });
    }
    if (r && !r.error && claimsWork && t.status !== 'merged' && t.branch && r.branchHead === null && rm !== true) {
      add({ ticket: id, kind: 'branch-gone', detail: `branch ${t.branch} is not on the remote` });
    }
    if (r && !r.error && t.head && r.branchHead && !sameSha(r.branchHead, t.head) && rm !== true && (t.status === 'nominated' || t.status === 'gated')) {
      add({ ticket: id, kind: 'head-moved', detail: `branch head ${r.branchHead.slice(0, 8)} != recorded ${t.head.slice(0, 8)} — verdict ${t.verdict} is stale` });
      if (t.verdict !== 'none' || t.status === 'gated') {
        writeBack.push({ ticket: id, seen: t.updatedAt, patch: { head: r.branchHead, verdict: 'none', ...(t.status === 'gated' ? { status: 'nominated' as const } : {}) }, why: 'head moved: verdict reset' });
      } else {
        writeBack.push({ ticket: id, seen: t.updatedAt, patch: { head: r.branchHead }, why: 'head moved' });
      }
    } else if (r?.pr && t.head && r.pr.headRefOid && !sameSha(r.pr.headRefOid, t.head) && t.status !== 'merged' && r.pr.state === 'OPEN') {
      add({ ticket: id, kind: 'pr-head-moved', detail: `PR #${t.pr} head ${r.pr.headRefOid.slice(0, 8)} != recorded ${t.head.slice(0, 8)}` });
    }
    if (r?.pr?.state === 'MERGED' && r.pr.baseRefName !== state.target && rm !== true && t.status !== 'dropped' && !accepted) {
      add({ ticket: id, kind: 'pr-merged-other-base', detail: `PR #${t.pr} is MERGED into ${r.pr.baseRefName ?? '(unknown base)'}, not origin/${state.target}: not merged on the target` });
    }
    if (ungated) {
      add({ ticket: id, kind: 'merged-at-ungated-head', detail: `merged at ${ungated.slice(0, 8)} but the ${t.verdict} verdict was on ${t.head?.slice(0, 8)}: re-gate the merged tree, then \`state set ${id} --status merged --head ${ungated.slice(0, 12)}\`` });
    }
    if (r?.pr?.state === 'CLOSED' && t.status !== 'merged' && t.status !== 'dropped') {
      add({ ticket: id, kind: 'pr-closed-unmerged', detail: `PR #${t.pr} is CLOSED without merging` });
    }
    if ((t.status === 'nominated' || t.status === 'gated' || t.status === 'merged')) {
      const open = t.dependsOn.filter((d) => !effMerged(d));
      if (t.status === 'merged' && open.length) add({ ticket: id, kind: 'nominated-before-upstream-merged', detail: `merged while upstream ${open.join(', ')} is not merged` });
      if (t.status !== 'merged') {
        // #506: an open upstream is fine only on its verified candidate; the head read is the remote tip when there is one.
        const bl = open.map((u) => ({ u, b: upstreamBlocker(state, t, u, reality[u]?.error ? null : reality[u]?.branchHead) })).filter((x) => x.b !== null);
        const bad = bl.filter((x) => x.b!.kind === 'ineligible');
        const moved = bl.filter((x) => x.b!.kind === 'changed');
        if (bad.length) add({ ticket: id, kind: 'nominated-before-upstream-merged', detail: `${t.status} while upstream ${bad.map((x) => x.u).join(', ')} is not merged and not an admissible candidate: ${bad.map((x) => x.b!.why).join('; ')}` });
        // an upstream that MERGED at a head other than the one recorded in builtOn: re-gate unless the trees match (only `deliver` can tell) — no write-back, the dependent may already be re-gated
        const movedMerged = t.dependsOn.filter((d) => effMerged(d) && t.builtOn[d]).map((d) => ({ d, h: reality[d]?.pr?.state === 'MERGED' ? reality[d]!.pr!.headRefOid : state.tickets[d]?.head ?? null })).filter((x) => x.h && !sameSha(t.builtOn[x.d], x.h!));
        if (movedMerged.length) add({ ticket: id, kind: 'upstream-changed', detail: `${movedMerged.map((x) => `built on ${x.d}@${t.builtOn[x.d].slice(0, 8)} but ${x.d} merged at ${x.h!.slice(0, 8)}`).join('; ')} — re-gate (unless the trees match; deliver decides), then \`state set ${id} --built-on …\`` });
        if (moved.length) {
          add({ ticket: id, kind: 'upstream-changed', detail: `${moved.map((x) => x.b!.why).join('; ')} — verdict ${t.verdict} is void: rebase onto the new head, \`state set ${id} --built-on …\`, re-gate` });
          if (t.verdict !== 'none' || t.status === 'gated') {
            writeBack.push({ ticket: id, seen: t.updatedAt, patch: { verdict: 'none', ...(t.status === 'gated' ? { status: 'nominated' as const } : {}) }, why: 'upstream moved: verdict reset' });
          }
        }
      }
    }
  }

  const tickets: Record<string, TicketPlan> = {};
  for (const [id, t] of Object.entries(state.tickets)) {
    const own = perTicket[id] ?? [];
    const open = t.dependsOn.filter((d) => !effMerged(d));
    tickets[id] = { ...planTicket(id, t, own, open), divergences: own };
  }
  return { tickets, divergences, writeBack };
}

function planTicket(id: string, t: TicketState, own: Divergence[], open: string[]): { class: TicketClass; next: NextAction } {
  const has = (k: DivergenceKind): boolean => own.some((d) => d.kind === k);
  if (has('merged-at-ungated-head')) return { class: 'diverged', next: { action: 'investigate', detail: 'merged at a head the verdict did not cover: re-gate the merged tree on the target before releasing dependents' } };
  if (has('reality-merged-state-not')) return { class: 'diverged', next: { action: 'record-merged', detail: 'reality shows it merged: write it back (resume does), then release its dependents' } };
  if (has('state-merged-reality-not')) return { class: 'diverged', next: { action: 'investigate', detail: 'state claims merged, git/gh do not: dependents are NOT released; re-merge it or fix the state by hand' } };
  if (has('upstream-changed')) return { class: 'diverged', next: { action: 're-gate', detail: 'the upstream moved after this one was built and gated on it: its verdict is void — rebase onto the new upstream head, record --built-on, gate again (deliver would refuse upstream-changed)' } };
  if (has('nominated-before-upstream-merged')) return { class: 'diverged', next: { action: 'investigate', detail: `upstream ${open.join(', ')} is not merged and not an admissible candidate: do not gate or merge this one` } };
  if (has('pr-merged-other-base')) return { class: 'diverged', next: { action: 'investigate', detail: 'its PR merged into another branch, not the target: dependents stay blocked until it reaches the target' } };
  if (has('branch-gone')) return { class: 'diverged', next: { action: 'recreate-branch', detail: `branch ${t.branch} is gone from the remote: restore it from the worktree or restart the ticket` } };
  if (has('pr-closed-unmerged')) return { class: 'diverged', next: { action: 'investigate', detail: `PR #${t.pr} was closed unmerged: reopen or re-nominate` } };
  if (has('head-moved') || has('pr-head-moved')) {
    return { class: 'diverged', next: { action: 're-gate', detail: 'the head moved after the recorded one: its verdict is stale, gate the new head' } };
  }
  switch (t.status) {
    case 'merged': return { class: 'done', next: { action: 'none', detail: 'merged' } };
    case 'dropped': return { class: 'dropped', next: { action: 'none', detail: 'dropped' } };
    case 'todo':
      if (open.length === 0) return { class: 'startable', next: { action: 'start', detail: t.dependsOn.length ? 'every upstream is merged' : 'no upstream' } };
      if (t.frozenInterface) return { class: 'startable', next: { action: 'start-against-frozen-interface', detail: `build against ${t.frozenInterface}; nominate only once ${open.join(', ')} has a verified candidate (nominated|gated) and you rebased onto its head` } };
      return { class: 'waiting', next: { action: 'wait-upstream', detail: `waiting for ${open.join(', ')} (no frozen interface to start against)` } };
    case 'started':
      return { class: 'in-progress', next: { action: 'continue', detail: open.length ? `finish and self-gate; nomination needs ${open.join(', ')} merged or nominated|gated (rebase onto its head, --built-on)` : 'finish, self-gate, nominate' } };
    case 'nominated':
      return { class: 'awaiting-gate', next: { action: 'gate', detail: `gate head ${t.head?.slice(0, 8) ?? '(unrecorded)'} on the merge result${open.length ? ` (stacked on ${open.join(', ')}: merges only after it)` : ''}` } };
    case 'gated':
      if ((t.verdict === 'pass' || t.verdict === 'approve') && open.length) return { class: 'awaiting-merge', next: { action: 'wait-upstream', detail: `verdict ${t.verdict} on ${t.head?.slice(0, 8) ?? '(unrecorded head)'}: deliver only after ${open.join(', ')} merged (deliver refuses an earlier merge, and a moved upstream voids the verdict)` } };
      if (t.verdict === 'pass' || t.verdict === 'approve') return { class: 'awaiting-merge', next: { action: 'merge', detail: `verdict ${t.verdict} on ${t.head?.slice(0, 8) ?? '(unrecorded head)'}: merge at that exact head` } };
      return { class: 'needs-fix', next: { action: 'fix-and-renominate', detail: `verdict ${t.verdict}: the implementer fixes, then re-nominates` } };
  }
}

/** Step 5 of resume: record the reality-AHEAD facts. These bypass the transition rules on purpose (a fact is not a request), then re-validate. */
export function applyWriteBack(state: FanoutState, writeBack: ReconcilePlan['writeBack'], now: string): FanoutState {
  const tickets = { ...state.tickets };
  const mergedHere = new Set<string>();
  for (const w of writeBack) {
    const cur = tickets[w.ticket];
    // Skip a ticket changed since the plan read it (`seen`), and never lower one this batch already recorded as merged.
    if (!cur || state.tickets[w.ticket].updatedAt !== w.seen || mergedHere.has(w.ticket)) continue;
    tickets[w.ticket] = { ...cur, ...w.patch, updatedAt: now };
    if (w.patch.status === 'merged') mergedHere.add(w.ticket);
  }
  return parseState({ ...state, tickets, updatedAt: now, reconciledAt: now });
}
