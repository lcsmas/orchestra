// #469 — the fan-out vague's execution state: ONE file per run (<ORCHESTRA_HOME>/fanout/<run>/state.json),
// one writer, atomic rewrite, and a pure reconcile against git/gh reality. Prior art: Reclaim's run file + 5-step resume.
// Pure logic + tiny fs helpers; the CLI (src/cli/fanout-state.ts) owns argv and the git/gh runner.
import fs from 'node:fs';
import path from 'node:path';

export const STATE_VERSION = 1;

export const TICKET_STATUSES = ['todo', 'started', 'nominated', 'gated', 'merged', 'dropped'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const VERDICTS = ['none', 'pass', 'fail', 'approve', 'changes-requested'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface TicketState {
  /** Work branch (the nominated ref NAME is frozen once nominated). */
  branch: string | null;
  /** Pull request number, when one exists. */
  pr: number | null;
  /** Head sha the verdict / nomination speaks about. */
  head: string | null;
  verdict: Verdict;
  /** Upstream ticket ids: this ticket cannot be NOMINATED before each is merged. */
  dependsOn: string[];
  /** Ref of the frozen interface a dependent may START against (ledger section, sha…). */
  frozenInterface: string | null;
  /** Why a `merged` ticket counts as merged although git/gh do not show it on the target (e.g. its PR landed in a stacked base that was later squash-merged). Explicit, human-written. */
  mergedAccepted: string | null;
  status: TicketStatus;
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
const TICKET_KEYS = new Set(['branch', 'pr', 'head', 'verdict', 'dependsOn', 'frozenInterface', 'mergedAccepted', 'status', 'updatedAt']);
/** The fields a `state set` may change (updatedAt is the writer's). */
export const SETTABLE_KEYS = ['branch', 'pr', 'head', 'verdict', 'dependsOn', 'frozenInterface', 'mergedAccepted', 'status'] as const;
export type TicketPatch = Partial<Pick<TicketState, (typeof SETTABLE_KEYS)[number]>>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_SHA = /^[0-9a-f]{7,40}$/;
const SAFE_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/+@-]{0,199}$/;
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9._#:-]{0,63}$/;

export class FanoutStateError extends Error {}

export function assertRunId(run: string): string {
  if (!SAFE_ID.test(run) || run.includes('..')) throw new FanoutStateError(`unsafe run id ${JSON.stringify(run)} (letters, digits, . _ - only)`);
  return run;
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
function enumOf<T extends string>(v: unknown, all: readonly T[], name: string): T {
  if (typeof v !== 'string' || !(all as readonly string[]).includes(v)) throw new FanoutStateError(`${name} must be one of ${all.join('|')} (got ${JSON.stringify(v)})`);
  return v as T;
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
      frozenInterface: strOrNull(t.frozenInterface, 'frozenInterface'),
      mergedAccepted: strOrNull(t.mergedAccepted, 'mergedAccepted'),
      status: enumOf(t.status ?? 'todo', TICKET_STATUSES, 'status'),
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
 *  - `nominated` / `gated` / `merged` are REFUSED while any upstream is not merged (nominate-before-upstream-merged).
 */
export function applyTicketPatch(state: FanoutState, id: string, patch: Record<string, unknown>, now: string): FanoutState {
  if (!SAFE_TICKET.test(id)) throw new FanoutStateError(`unsafe ticket id ${JSON.stringify(id)}`);
  refuseUnknown(patch, new Set<string>(SETTABLE_KEYS), 'patch');
  const prev: TicketState = state.tickets[id] ?? {
    branch: null, pr: null, head: null, verdict: 'none', dependsOn: [], frozenInterface: null, mergedAccepted: null, status: 'todo', updatedAt: now,
  };
  const next: TicketState = { ...prev, updatedAt: now };
  if ('branch' in patch) next.branch = checked(strOrNull(patch.branch, 'branch'), SAFE_BRANCH, 'branch');
  if ('pr' in patch) next.pr = prOrNull(patch.pr);
  if ('head' in patch) next.head = checked(strOrNull(patch.head, 'head'), HEX_SHA, 'head (7-40 lowercase hex)');
  if ('verdict' in patch) next.verdict = enumOf(patch.verdict, VERDICTS, 'verdict');
  if ('dependsOn' in patch) next.dependsOn = depsOf(patch.dependsOn);
  if ('frozenInterface' in patch) next.frozenInterface = strOrNull(patch.frozenInterface, 'frozenInterface');
  if ('mergedAccepted' in patch) next.mergedAccepted = strOrNull(patch.mergedAccepted, 'mergedAccepted');
  if (next.mergedAccepted && next.status !== 'merged') throw new FanoutStateError(`${id}: mergedAccepted only applies to a merged ticket (status is ${next.status})`);
  if ('status' in patch) next.status = enumOf(patch.status, TICKET_STATUSES, 'status');
  if (next.dependsOn.includes(id)) throw new FanoutStateError(`ticket ${id} cannot depend on itself`);
  const out: FanoutState = { ...state, tickets: { ...state.tickets, [id]: next }, updatedAt: now };
  assertAcyclic(out);
  const open = unmergedUpstreams(out, id);
  if (open.length > 0) {
    if (next.status === 'started' && !next.frozenInterface) {
      throw new FanoutStateError(`${id} cannot start: upstream ${open.join(', ')} not merged and no frozen interface to build against (set --frozen-interface)`);
    }
    if (next.status === 'nominated' || next.status === 'gated' || next.status === 'merged') {
      throw new FanoutStateError(`${id} cannot be ${next.status}: upstream ${open.join(', ')} not merged yet — a dependent may START against a frozen interface but is not NOMINATED before its upstream is merged`);
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

const sameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

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
      if (open.length) add({ ticket: id, kind: 'nominated-before-upstream-merged', detail: `${t.status} while upstream ${open.join(', ')} is not merged` });
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
  if (has('nominated-before-upstream-merged')) return { class: 'diverged', next: { action: 'investigate', detail: `upstream ${open.join(', ')} is not merged: do not gate or merge this one` } };
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
      if (t.frozenInterface) return { class: 'startable', next: { action: 'start-against-frozen-interface', detail: `build against ${t.frozenInterface}; do NOT nominate before ${open.join(', ')} is merged` } };
      return { class: 'waiting', next: { action: 'wait-upstream', detail: `waiting for ${open.join(', ')} (no frozen interface to start against)` } };
    case 'started':
      return { class: 'in-progress', next: { action: 'continue', detail: open.length ? `finish and self-gate; nomination is refused until ${open.join(', ')} is merged` : 'finish, self-gate, nominate' } };
    case 'nominated':
      return { class: 'awaiting-gate', next: { action: 'gate', detail: `gate head ${t.head?.slice(0, 8) ?? '(unrecorded)'} on the merge result` } };
    case 'gated':
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
