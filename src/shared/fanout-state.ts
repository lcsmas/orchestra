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
  /** #542 — the runner config the command names (`jest --config <path>`): its path and the sha256 of its bytes at the TARGET tip when frozen. Part of `hash`; the gate refuses a candidate whose copy differs. Absent = the command names none. */
  config?: { path: string; sha256: string };
  source: { branch: string | null; head: string };
  frozenAt: string;
  amendments: AcceptanceAmendment[];
  /** #539 — what the freeze's one run on the target tip found (never a refusal: those record nothing): `clean` = no ERROR (assertion FAILs accepted), `escaped` = the coordinator's recorded `--accept-unclassified` (the output could not be classified). */
  freezeCheck?: FreezeCheck;
}
export interface FreezeCheck { at: string; target: string; targetSha: string; result: 'clean' | 'escaped'; pass?: number; assertionFail?: number; skipped?: number; escape?: { by: string; reason: string; unclassified: string } }
/** The full amend: a ledger decision naming a spec sentence. `bodySha256` = sha256 of the decision comment body read at amend time; `runAfter` only when the amend changed the command. */
export interface DecisionAmendment { kind?: 'decision'; at: string; decision: string; specSentence: string; bodySha256: string; hashBefore: string; hashAfter: string; runAfter?: string; /** #542-fu: the runner config (path + sha256 from the target tip) the amended command names */ configAfter?: { path: string; sha256: string } }
/** #540 — `amend --harness-only`: setup / teardown / context only, the assertion statements proven byte-identical (`assertionsHash`). `filesBefore` = the per-file sha256 the set held BEFORE: a candidate still holding
 *  one of them (an unbroken chain of harness-only amendments up to the current set — `acceptableBytes`) is accepted, the amended bytes run from the shared branch. No decision: the coordinator's `reason` is the record. */
export interface HarnessAmendment { kind: 'harness-only'; at: string; reason: string; assertionsHash: string; filesBefore: Record<string, string>; hashBefore: string; hashAfter: string; /** the non-assertion lines the amend changed (what the coordinator attests) */ lines?: { added: number; removed: number; reorderOnly?: true } }
export type AcceptanceAmendment = DecisionAmendment | HarnessAmendment;

/** #514 — a finding's severity as the verifier / review report grades it. Only BLOCKING and MAJOR justify a follow-up candidate on a merged ticket. */
export const FINDING_SEVERITIES = ['BLOCKING', 'MAJOR', 'MINOR'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
/** #552 — the NORMALIZED finding record (frozen interface of ledger #555; T1 declares every field, T2/T3 read them). A recorded severity is never re-graded. */
export const FINDING_EVIDENCE = ['measured', 'argued'] as const;
export type FindingEvidence = (typeof FINDING_EVIDENCE)[number];
/** `process` = a sentence about how the work is REPORTED ("write the list in the pull request"): never a code round, settled by a recorded PR-body edit. */
export const FINDING_KINDS = ['code', 'process'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
/** #553 (T2) — the four lines a measured finding must carry. T1 only validates the shape. */
export interface FindingReport { input: string; happens: string; where: string; proof: string }
/** The coordinator's recorded decision on a finding (`state set <t> --decide <id>=<text>`; `by` = the recording workspace). */
export interface FindingDecision { by: string; text: string; at: string }
/** How a finding was settled: `fixed` (a code finding, `ref` = the head / commit) or `pr-body` (a process finding, `ref` = what the PR body now says / where). */
export interface FindingSettled { how: 'fixed' | 'pr-body'; at: string; ref: string }
export interface FindingRecord {
  severity: FindingSeverity;
  evidence?: FindingEvidence;
  kind?: FindingKind;
  /** #552 — a literal substring of the ticket's captured spec text (`TicketState.specText`); code checks it is IN the spec, never that it is really broken (the reviewer judges that). */
  specSentence?: string;
  report?: FindingReport;
  decision?: FindingDecision;
  settled?: FindingSettled;
}
/** #553 (T2) — the four parts a measured MINOR on product code carries: T1's `findingOf` validates each when `report` is present; this is the rule that it IS present. */
export const REPORT_PARTS = ['input', 'happens', 'where', 'proof'] as const;
/** #553 — why this MINOR cannot be recorded (null = fine). A measured non-process MINOR becomes a ticket text at close-out, so it needs its report; a report with no `evidence` is refused too (it would count as argued and lose its text for good: evidence is never re-graded). */
export function reportGap(f: FindingRecord): string | null {
  if (f.severity !== 'MINOR' || f.kind === 'process') return null;
  if (f.evidence === 'measured' && !f.report) return `a measured MINOR on product code becomes a ticket text at close-out and needs report.{${REPORT_PARTS.join(', ')}} (or record it as evidence: "argued", which creates nothing)`;
  if (f.report && f.evidence === undefined) return 'a report needs evidence: "measured" (evidence is not re-graded afterwards) — drop the report, or record the MINOR as measured';
  return null;
}
/** What a state file holds for one finding: the legacy string (still read, and still WRITTEN while a record carries only its severity) or the normalized record. */
export type StoredFinding = FindingSeverity | FindingRecord;
/** #515 — the code-written half of the acceptance flow (never settable by `state set`): who writes the tests, how long a gate waits for them, the recorded waiver. */
export interface AcceptFlow {
  /** The `accept-` writer Orchestra spawned for this ticket (`id` null = the spawn is in flight or failed — `error`). */
  acceptor: { id: string | null; name: string; at: string; error?: string } | null;
  /** A gate waiting for the freeze: when it started, the deadline, the bound (seconds) — printed by `state show`. */
  wait: { since: string; deadline: string; boundSec: number } | null;
  /** Coordinator-only escape (`acceptance waive`): the ticket cannot have acceptance tests. */
  waived: { decision: string; reason: string; at: string } | null;
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
  /** #512 — git tree sha of `head`: the CONTENT the verdict speaks about. DERIVED by the CLI whenever `head` is set (null = unknown: the verdict then stays sha-keyed, never looser). */
  tree: string | null;
  /** #512 — upstream id → tree of the upstream head it was built on (`builtOn`), derived the same way. */
  builtOnTree: Record<string, string>;
  /** #514 — finding id → severity, from the verifier / review reports of THIS ticket's candidates. Merge-only: an id, once recorded, keeps its severity. */
  findings: Record<string, FindingRecord>;
  /** #514 — set = this ticket is a FOLLOW-UP candidate on that already-merged ticket (see `followUpRefusal`). */
  followUpOf: string | null;
  /** #514 — the head this ticket merged at, kept even if it is later un-merged (cleared only by `--forget-merge <reason>`): a candidate on any other head is a follow-up. */
  mergedHead: string | null;
  /** #514/#512 — git tree of `mergedHead` (derived like `tree`): a candidate with the SAME tree on another sha is the same content (a rebase), not a further candidate. */
  mergedTree: string | null;
  /** #514 — append-only: every `--forget-merge <reason>` (the reason, when, and the merged head it cleared). Not settable except through that flag. */
  forgottenMerges: Array<{ at: string; reason: string; was: string | null }>;
  /** #514 — the finding ids (of `followUpOf`) this follow-up fixes; at least one must be BLOCKING|MAJOR. */
  fixes: string[];
  /** #515 — the spec reference (file | url | ledger section) of a ticket whose acceptance tests are FORCED: registering it makes Orchestra spawn the `accept-` writer. null = no forced flow. */
  spec: string | null;
  /** #552 — the spec TEXT read when `spec` was registered (DERIVED by the CLI, never settable by `state set --json`; null = not captured): a finding's `specSentence` must be a literal substring of it. */
  specText: string | null;
  /** #515 — workspace ids of the ticket's implementer / verifier: the freeze status (path + command) is posted to them. */
  implementer: string | null;
  verifier: string | null;
  /** #515 — see {@link AcceptFlow}. Written only by the acceptance verbs / the host, not by `state set`. */
  accept: AcceptFlow | null;
  updatedAt: string;
}

export interface FanoutState {
  version: typeof STATE_VERSION;
  run: string;
  /** Integration branch the tickets merge into (reality is read against `origin/<target>`). */
  target: string;
  /** `owner/name` for `gh -R`; null = the checkout's own repo. */
  repo: string | null;
  /** #538 — the repo's own integration test entry, DECLARED by the coordinator (a path and/or the command that runs it; one line). Absent = not declared (the key is never written as null, so an older binary reads a state that declares nothing): the writer's brief falls back to discovery (shared/fanout-harness.ts). */
  harness?: string;
  tickets: Record<string, TicketState>;
  updatedAt: string;
  reconciledAt: string | null;
}

const TOP_KEYS = new Set(['version', 'run', 'target', 'repo', 'harness', 'tickets', 'updatedAt', 'reconciledAt']);
const TICKET_KEYS = new Set(['branch', 'pr', 'head', 'verdict', 'dependsOn', 'builtOn', 'frozenInterface', 'mergedAccepted', 'status', 'acceptance', 'spec', 'specText', 'implementer', 'verifier', 'accept', 'tree', 'builtOnTree', 'findings', 'followUpOf', 'mergedHead', 'mergedTree', 'forgottenMerges', 'fixes', 'updatedAt']);
/** The fields a `state set` may change (updatedAt is the writer's). `tree` / `builtOnTree` / `specText` are DERIVED (#512/#552): the CLI fills them, `state set --json` cannot. `forgetMerge` / `settle` / `decide` are verbs (#514/#552), not stored fields. */
export const SETTABLE_KEYS = ['branch', 'pr', 'head', 'verdict', 'dependsOn', 'builtOn', 'frozenInterface', 'mergedAccepted', 'status', 'findings', 'followUpOf', 'fixes', 'forgetMerge', 'settle', 'decide', 'spec', 'implementer', 'verifier'] as const;
export const DERIVED_KEYS = ['tree', 'builtOnTree'] as const;
export type TicketPatch = Partial<Pick<TicketState, Exclude<(typeof SETTABLE_KEYS)[number], 'forgetMerge' | 'settle' | 'decide' | 'findings'> | (typeof DERIVED_KEYS)[number]>> & { forgetMerge?: string; findings?: Record<string, StoredFinding>; settle?: Record<string, { how: string; ref: string }>; decide?: Record<string, { text: string; by?: string }> };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_SHA = /^[0-9a-f]{7,40}$/;
const TREE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const SAFE_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/+@-]{0,199}$/;
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9._#:-]{0,63}$/;

export class FanoutStateError extends Error {}

/** A ticket as `state set` creates it. */
export function blankTicket(now: string): TicketState {
  return { branch: null, pr: null, head: null, verdict: 'none', dependsOn: [], builtOn: {}, frozenInterface: null, mergedAccepted: null, status: 'todo', acceptance: null, spec: null, specText: null, implementer: null, verifier: null, accept: null, tree: null, builtOnTree: {}, findings: {}, followUpOf: null, mergedHead: null, mergedTree: null, forgottenMerges: [], fixes: [], updatedAt: now };
}

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

export function newState(run: string, opts: { target?: string; repo?: string | null; harness?: string | null; now: string }): FanoutState {
  return { version: STATE_VERSION, run: assertRunId(run), target: opts.target ?? 'master', repo: opts.repo ?? null, ...withHarness(harnessOf(opts.harness ?? null)), tickets: {}, updatedAt: opts.now, reconciledAt: null };
}

/** #538 — a declared harness: ONE printable line, ≤ 300 chars (a path and/or the command that runs the repo's integration tests); `-` / empty / null = none. */
export function harnessOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new FanoutStateError('harness must be a string or null');
  const s = v.trim();
  if (s === '' || s === '-') return null;
  if (s.length > 300 || /[\x00-\x1f\x7f]/.test(s)) throw new FanoutStateError('harness must be a single printable line of at most 300 characters (the repo\'s integration test entry: a path and/or the command that runs it)');
  return s;
}
const withHarness = (h: string | null): { harness?: string } => (h === null ? {} : { harness: h });
/** #538 — `state set --harness <ref|->`: declare (or clear) the harness; pure. */
export function setHarness(state: FanoutState, v: string, now: string): FanoutState {
  const { harness: _prev, ...rest } = state;
  return { ...rest, ...withHarness(harnessOf(v)), updatedAt: now };
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
function treeOrNull(v: unknown, name: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !TREE_SHA.test(v)) throw new FanoutStateError(`${name} must be a full lowercase hex git tree sha or null`);
  return v;
}
function builtOnTreeOf(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new FanoutStateError('builtOnTree must be an object {<upstream ticket>: <tree sha>}');
  const out: Record<string, string> = {};
  for (const [k, h] of Object.entries(v)) {
    if (!SAFE_TICKET.test(k)) throw new FanoutStateError(`builtOnTree: unsafe ticket id ${JSON.stringify(k)}`);
    out[k] = treeOrNull(h, `builtOnTree[${k}]`) ?? (() => { throw new FanoutStateError(`builtOnTree[${k}] must be a tree sha`); })();
  }
  return out;
}
const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._#:-]{0,63}$/;
/** #552 — a sentence quoted from a spec: non-empty after trim (the sentence itself is kept verbatim — no trim, no case-fold: it is matched LITERALLY), printable (newline / tab allowed). */
export const SPEC_SENTENCE_MAX = 2000;
/** A quoted fragment shorter than this (trimmed, in characters — works for CJK too) matches nearly any spec: not a sentence. */
export const SPEC_SENTENCE_MIN_CHARS = 15;
const CTRL = /[\x00-\x08\x0b-\x1f\x7f]/;
function specSentenceOf(v: unknown, where: string): string {
  if (typeof v === 'string') v = v.replace(/\r\n/g, '\n'); // the spec text is captured with LF line endings: a sentence quoted with CRLF is the same sentence
  if (typeof v !== 'string' || !v.trim()) throw new FanoutStateError(`${where}: specSentence must be a non-empty text quoted from the ticket's spec (empty / whitespace-only is refused)`);
  if (v.length > SPEC_SENTENCE_MAX || CTRL.test(v)) throw new FanoutStateError(`${where}: specSentence must be printable text of at most ${SPEC_SENTENCE_MAX} characters`);
  if (v.trim().length < SPEC_SENTENCE_MIN_CHARS) throw new FanoutStateError(`${where}: specSentence must quote at least ${SPEC_SENTENCE_MIN_CHARS} characters of the spec (a short fragment matches almost any spec) — refused`);
  return v;
}
function lineOf(v: unknown, where: string, max = 2000): string {
  if (typeof v !== 'string' || !v.trim()) throw new FanoutStateError(`${where} must be a non-empty text`);
  if (v.length > max || CTRL.test(v)) throw new FanoutStateError(`${where} must be printable text of at most ${max} characters`);
  return v;
}
function isoOf(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.trim() || Number.isNaN(Date.parse(v))) throw new FanoutStateError(`${where} must be an ISO date`);
  return v;
}
const FINDING_KEYS = new Set(['severity', 'evidence', 'kind', 'specSentence', 'report', 'decision', 'settled']);
/** Parse ONE stored finding: the legacy string `BLOCKING|MAJOR|MINOR` or the normalized record (unknown key refused, every field shape-checked). Always returns the record form. */
export function findingOf(v: unknown, where: string): FindingRecord {
  if (typeof v === 'string') return { severity: enumOf(v, FINDING_SEVERITIES, where) };
  if (!isObj(v)) throw new FanoutStateError(`${where} must be BLOCKING|MAJOR|MINOR or a finding record {severity, evidence?, kind?, specSentence?, report?, decision?, settled?}`);
  refuseUnknown(v, FINDING_KEYS, where);
  const out: FindingRecord = { severity: enumOf(v.severity, FINDING_SEVERITIES, `${where}.severity`) };
  if (v.evidence !== undefined) out.evidence = enumOf(v.evidence, FINDING_EVIDENCE, `${where}.evidence`);
  if (v.kind !== undefined) out.kind = enumOf(v.kind, FINDING_KINDS, `${where}.kind`);
  if (v.specSentence !== undefined) out.specSentence = specSentenceOf(v.specSentence, where);
  if (v.report !== undefined) {
    if (!isObj(v.report)) throw new FanoutStateError(`${where}.report must be {input, happens, where, proof}`);
    refuseUnknown(v.report, new Set(['input', 'happens', 'where', 'proof']), `${where}.report`);
    out.report = { input: lineOf(v.report.input, `${where}.report.input`), happens: lineOf(v.report.happens, `${where}.report.happens`), where: lineOf(v.report.where, `${where}.report.where`), proof: lineOf(v.report.proof, `${where}.report.proof`) };
  }
  if (v.decision !== undefined) {
    if (!isObj(v.decision)) throw new FanoutStateError(`${where}.decision must be {by, text, at}`);
    refuseUnknown(v.decision, new Set(['by', 'text', 'at']), `${where}.decision`);
    out.decision = { by: lineOf(v.decision.by, `${where}.decision.by`, 200), text: lineOf(v.decision.text, `${where}.decision.text`), at: isoOf(v.decision.at, `${where}.decision.at`) };
  }
  if (v.settled !== undefined) {
    if (!isObj(v.settled)) throw new FanoutStateError(`${where}.settled must be {how, at, ref}`);
    refuseUnknown(v.settled, new Set(['how', 'at', 'ref']), `${where}.settled`);
    out.settled = { how: enumOf(v.settled.how, ['fixed', 'pr-body'] as const, `${where}.settled.how`), at: isoOf(v.settled.at, `${where}.settled.at`), ref: lineOf(v.settled.ref, `${where}.settled.ref`, 500) };
  }
  return out;
}
function findingsOf(v: unknown): Record<string, FindingRecord> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new FanoutStateError('findings must be an object {<finding id>: BLOCKING|MAJOR|MINOR | <finding record>}');
  const out: Record<string, FindingRecord> = {};
  for (const [k, f] of Object.entries(v)) {
    if (!FINDING_ID.test(k)) throw new FanoutStateError(`findings: unsafe finding id ${JSON.stringify(k)}`);
    out[k] = findingOf(f, `findings[${k}]`);
  }
  return out;
}
/** What is written to disk: a record carrying only its severity stays the legacy string (an older build and every reader of the old shape keep working). */
function storedFindings(f: Record<string, FindingRecord>): Record<string, StoredFinding> {
  return Object.fromEntries(Object.entries(f).map(([k, r]) => [k, Object.keys(r).length === 1 ? r.severity : r]));
}
/** The limit, stated where a recorder reads it (the `state` help, the skill). */
export const SPEC_SENTENCE_LIMIT = 'Limit: code checks that the sentence is IN the spec, not that it is really broken — judging that stays with the reviewer.';
/** The on-disk ticket: findings in their stored form, and `specText` omitted while null — a state that captured no spec text stays readable by a build older than #552 (unknown field refused there). */
function storedTicket(t: TicketState): Record<string, unknown> {
  const { specText, ...rest } = t;
  return { ...rest, findings: storedFindings(t.findings), ...(specText !== null ? { specText } : {}) };
}
export const SPEC_TEXT_MAX = 200_000;
function specTextOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new FanoutStateError('specText must be text or null');
  if (v.length > SPEC_TEXT_MAX) throw new FanoutStateError(`specText is larger than ${SPEC_TEXT_MAX} characters`);
  return v;
}
function fixesOf(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((d) => typeof d !== 'string' || !FINDING_ID.test(d))) throw new FanoutStateError('fixes must be an array of finding ids');
  return [...new Set(v as string[])];
}
function forgottenOf(v: unknown): Array<{ at: string; reason: string; was: string | null }> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new FanoutStateError('forgottenMerges must be an array');
  return v.map((e, i) => {
    if (!isObj(e) || typeof e.at !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()) throw new FanoutStateError(`forgottenMerges[${i}] needs {at, reason, was}`);
    return { at: e.at, reason: e.reason, was: checked(strOrNull(e.was, 'was'), HEX_SHA, 'forgottenMerges.was') };
  });
}
/** #515 — a spec reference: one printable line (a path, a URL, a ledger section). */
function specOf(v: unknown): string | null {
  const s = strOrNull(v, 'spec');
  if (s !== null && (s.length > 500 || /[\x00-\x1f\x7f]/.test(s))) throw new FanoutStateError('spec must be a single printable line of at most 500 characters (a file, a URL, a ledger section)');
  return s === null ? null : s.trim();
}
function wsIdOf(v: unknown, name: string): string | null {
  const s = strOrNull(v, name);
  if (s !== null && !SAFE_ID.test(s)) throw new FanoutStateError(`${name} must be a workspace id (letters, digits, . _ -)`);
  return s;
}
function acceptFlowOf(v: unknown, where: string): AcceptFlow | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw new FanoutStateError(`${where}: accept must be an object or null`);
  refuseUnknown(v, new Set(['acceptor', 'wait', 'waived']), `${where} accept`);
  const iso = (x: unknown, n: string): string => { if (typeof x !== 'string' || !x.trim() || Number.isNaN(Date.parse(x))) throw new FanoutStateError(`${where}: ${n} must be an ISO date`); return x; };
  let acceptor: AcceptFlow['acceptor'] = null;
  if (v.acceptor !== undefined && v.acceptor !== null) {
    const a = v.acceptor;
    if (!isObj(a)) throw new FanoutStateError(`${where}: accept.acceptor must be an object`);
    refuseUnknown(a, new Set(['id', 'name', 'at', 'error']), `${where} accept.acceptor`);
    if (typeof a.name !== 'string' || !a.name.trim()) throw new FanoutStateError(`${where}: accept.acceptor.name missing`);
    acceptor = { id: wsIdOf(a.id, 'accept.acceptor.id'), name: a.name, at: iso(a.at, 'accept.acceptor.at'), ...(typeof a.error === 'string' && a.error ? { error: a.error.slice(0, 500) } : {}) };
  }
  let wait: AcceptFlow['wait'] = null;
  if (v.wait !== undefined && v.wait !== null) {
    const w = v.wait;
    if (!isObj(w)) throw new FanoutStateError(`${where}: accept.wait must be an object`);
    refuseUnknown(w, new Set(['since', 'deadline', 'boundSec']), `${where} accept.wait`);
    if (typeof w.boundSec !== 'number' || !Number.isInteger(w.boundSec) || w.boundSec <= 0) throw new FanoutStateError(`${where}: accept.wait.boundSec must be a positive integer`);
    wait = { since: iso(w.since, 'accept.wait.since'), deadline: iso(w.deadline, 'accept.wait.deadline'), boundSec: w.boundSec };
  }
  let waived: AcceptFlow['waived'] = null;
  if (v.waived !== undefined && v.waived !== null) {
    const w = v.waived;
    if (!isObj(w)) throw new FanoutStateError(`${where}: accept.waived must be an object`);
    refuseUnknown(w, new Set(['decision', 'reason', 'at']), `${where} accept.waived`);
    for (const k of ['decision', 'reason'] as const) if (typeof w[k] !== 'string' || !(w[k] as string).trim()) throw new FanoutStateError(`${where}: accept.waived.${k} missing`);
    waived = { decision: w.decision as string, reason: w.reason as string, at: iso(w.at, 'accept.waived.at') };
  }
  return { acceptor, wait, waived };
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
/** sha256 of the sorted `path\0sha\n` lines then one `run\0<run>\n` line — the ticket's frozen identity: the files AND the command that runs them (a receipt gated under another command is stale). */
export function acceptanceHash(files: Record<string, string>, run: string, config?: { path: string; sha256: string } | null): string {
  const lines = Object.keys(files).sort().map((k) => `${k}\0${files[k]}\n`).join('') + `run\0${run}\n` + (config ? `config\0${config.path}\0${config.sha256}\n` : ''); // #542: no config => the pre-#542 bytes, every old hash unchanged
  return crypto.createHash('sha256').update(lines).digest('hex');
}

/** One allowlisted runner: its argv prefix (executed WITHOUT a shell) and the INERT flags it may carry (whole-token regexes; anything else is refused —
 *  a flag can load a candidate-owned module/config (`--require`, `--env-file`, `--experimental-config-file`, `--test-reporter=./x`, `--preload`, `-pPLUGIN`…) or make
 *  nothing run (`--check`, `--test-name-pattern <frozen path>`, `--test-shard=2/2`), so flags are an allowlist, not a deny list). NO package launcher (`npx`, `pnpm exec`,
 *  `yarn exec`: they resolve the runner in the candidate's tree); `python -I -m` only (-I: the checkout is not put first on sys.path). */
const RUNNERS: Array<{ prefix: string[]; flags: RegExp[]; /** #542: accepts ONE `--config <path>` / `--config=<path>` naming a tracked repo file (jest only) */ config?: true }> = [
  { prefix: ['node'], flags: [/^--test$/, /^--test-reporter=(spec|tap|dot|junit|lcov)$/, /^--test-timeout=\d{1,7}$/, /^--test-concurrency=\d{1,3}$/, /^--test-force-exit$/, /^--no-warnings$/, /^--trace-warnings$/] },
  { prefix: ['tsx'], flags: [] },
  { prefix: ['vitest'], flags: [/^--reporter=(default|dot|verbose|tap|tap-flat|json|junit)$/, /^--bail=\d{1,3}$/, /^--no-color$/] },
  { prefix: ['vitest', 'run'], flags: [/^--reporter=(default|dot|verbose|tap|tap-flat|json|junit)$/, /^--bail=\d{1,3}$/, /^--no-color$/] },
  { prefix: ['jest'], flags: [/^--ci$/, /^--runInBand$/, /^--bail$/, /^--silent$/], config: true },
  { prefix: ['mocha'], flags: [/^--reporter=(spec|dot|tap|min|list|json)$/, /^--bail$/, /^--timeout=\d{1,7}$/, /^--exit$/] },
  { prefix: ['pytest'], flags: [/^-q$/, /^-x$/, /^-v{1,2}$/, /^-s$/, /^--tb=(auto|long|short|line|native|no)$/] },
  { prefix: ['python', '-I', '-m', 'pytest'], flags: [/^-q$/, /^-x$/, /^-v{1,2}$/, /^-s$/, /^--tb=(auto|long|short|line|native|no)$/] },
  { prefix: ['python3', '-I', '-m', 'pytest'], flags: [/^-q$/, /^-x$/, /^-v{1,2}$/, /^-s$/, /^--tb=(auto|long|short|line|native|no)$/] },
  { prefix: ['python', '-I', '-m', 'unittest'], flags: [/^-v$/, /^-f$/] },
  { prefix: ['python3', '-I', '-m', 'unittest'], flags: [/^-v$/, /^-f$/] },
  { prefix: ['deno', 'test'], flags: [/^-q$/, /^--quiet$/, /^-A$/, /^--no-check$/] },
  { prefix: ['bun', 'test'], flags: [/^--bail$/, /^--timeout=\d{1,7}$/] },
  { prefix: ['ruby'], flags: [] },
  { prefix: ['rspec'], flags: [/^--fail-fast$/, /^--format=(progress|documentation)$/] },
];

/** #542 — a runner config path a frozen command may name: repo-relative POSIX, plain characters only (no `..` / absolute / leading `-` / glob / backslash). Tracked-ness is a git fact, checked at freeze and at the gate. */
export function assertConfigPath(p: unknown): string {
  assertAcceptancePath(p);
  if (!/^[A-Za-z0-9._@+/-]+$/.test(p as string)) throw new FanoutStateError(`unsafe runner config path ${JSON.stringify(p)} (letters, digits and . _ @ + - / only)`);
  return p as string;
}

/**
 * The frozen command as an argv, or throws. It must be a DIRECT runner call (no shell, no indirection through `npm run`/`make`/`sh`/`env`): an allowlisted runner,
 * no shell metacharacter, only that runner's INERT flags (RUNNERS), every non-flag argument EXACTLY a frozen path, at least one.
 * #542: `jest` alone may also carry ONE `--config <path>` / `--config=<path>` (`config` = that path, for the caller to prove tracked + hash); a second one, a missing value or an unsafe path is refused.
 * Residue NOT checked: argv[0] and anything on its search path (PATH, the checkout's module/import path, a helper the test imports, what the config itself imports) are resolved in the candidate's tree.
 */
export function parseRunSpec(run: string, paths: string[]): { argv: string[]; config: string | null } {
  const why = (m: string): never => { throw new FanoutStateError(`the run command ${JSON.stringify(run)} is not a direct runner call on the frozen files: ${m} — e.g. \`node --test ${paths[0] ?? '<frozen file>'}\``); };
  if (/[^\x20-\x7e]/.test(run)) why('printable ASCII on one line only');
  if (/["'\\$`;&|<>(){}*?!#~[\]]/.test(run)) why('no shell metacharacters, quotes, comments or globs (it is executed without a shell)');
  const tokens = run.trim().split(/ +/).filter(Boolean);
  const inner = tokens; // no launcher: npx / pnpm exec / yarn exec resolve the runner from the candidate's node_modules/.bin and .npmrc
  const runner = [...RUNNERS].sort((a, b) => b.prefix.length - a.prefix.length).find((r) => r.prefix.every((t, i) => inner[i] === t)); // longest wins (`vitest run` over `vitest`)
  if (!runner) why(`the first word must be one of the allowlisted runners (${[...new Set(RUNNERS.map((r) => r.prefix[0]))].join(', ')}) called DIRECTLY — no npx / pnpm exec / yarn exec launcher, not npm, make, sh, env, a script`);
  let named = 0;
  let config: string | null = null;
  const args = inner.slice(runner!.prefix.length);
  const takeConfig = (v: string | undefined): void => {
    if (config !== null) why('--config given twice');
    if (v === undefined || v === '' || v.startsWith('-')) why('--config needs a value (a repo-relative path of a TRACKED file)');
    try { config = assertConfigPath(v); } catch (e) { why((e as Error).message); }
  };
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (runner!.config && t === '--config') { takeConfig(args[++i]); continue; }
    if (runner!.config && t.startsWith('--config=')) { takeConfig(t.slice('--config='.length)); continue; }
    if (t.startsWith('-')) { if (!runner!.flags.some((re) => re.test(t))) why(`flag ${t} is not on ${runner!.prefix.join(' ')}'s inert-flag allowlist (a flag can load code from, or stop running, the frozen files)`); continue; }
    if (!paths.includes(t)) why(`argument ${JSON.stringify(t)} is not a frozen file`);
    named++;
  }
  if (named === 0) why('it names none of the frozen files');
  if (config !== null && paths.includes(config)) why('the --config file is also a frozen test (the config is recorded from the target tip, a frozen file from the writer: the gate could never pass)');
  return { argv: tokens, config };
}
export function parseRunArgv(run: string, paths: string[]): string[] { return parseRunSpec(run, paths).argv; }
/** #542 — the runner config path `run` names (null = none); throws like `parseRunArgv`. */
export function runConfigOf(run: string, paths: string[]): string | null { return parseRunSpec(run, paths).config; }
/** #542 — the stored `config` must be exactly what `run` names: present iff the command names one, same path, a sha256. */
export function assertConfigMatchesRun(run: string, paths: string[], config: { path: string; sha256: string } | null | undefined, where: string): void {
  const named = runConfigOf(run, paths);
  if (named === null) { if (config) throw new FanoutStateError(`${where}: acceptance.config is recorded but the command names no --config`); return; }
  if (!config || config.path !== named) throw new FanoutStateError(`${where}: the command names --config ${named} but no matching acceptance.config (path + sha256) is recorded`);
  if (!SHA256.test(config.sha256)) throw new FanoutStateError(`${where}: acceptance.config.sha256 must be a 64-hex sha256`);
}
export const sha256Hex = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');

function acceptanceOf(v: unknown, where: string): Acceptance | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw new FanoutStateError(`${where}: acceptance must be an object or null`);
  refuseUnknown(v, new Set(['files', 'hash', 'run', 'config', 'source', 'frozenAt', 'amendments', 'freezeCheck']), `${where} acceptance`);
  if (!isObj(v.files) || Object.keys(v.files).length === 0) throw new FanoutStateError(`${where}: acceptance.files must be a non-empty {path: sha256}`);
  const files: Record<string, string> = {};
  for (const [k, h] of Object.entries(v.files)) {
    assertAcceptancePath(k);
    if (typeof h !== 'string' || !SHA256.test(h)) throw new FanoutStateError(`${where}: acceptance.files[${k}] must be a 64-hex sha256`);
    files[k] = h;
  }
  if (typeof v.run !== 'string' || !v.run.trim() || v.run.length > 2000 || /[\r\n\0]/.test(v.run)) throw new FanoutStateError(`${where}: acceptance.run must be a single-line command`);
  let config: Acceptance['config'];
  if (v.config !== undefined && v.config !== null) {
    if (!isObj(v.config)) throw new FanoutStateError(`${where}: acceptance.config must be an object`);
    refuseUnknown(v.config, new Set(['path', 'sha256']), `${where} acceptance.config`);
    if (typeof v.config.sha256 !== 'string' || !SHA256.test(v.config.sha256)) throw new FanoutStateError(`${where}: acceptance.config.sha256 must be a 64-hex sha256`);
    config = { path: assertConfigPath(v.config.path), sha256: v.config.sha256 };
  }
  if (typeof v.hash !== 'string' || v.hash !== acceptanceHash(files, v.run, config)) throw new FanoutStateError(`${where}: acceptance.hash does not match its files + command (hand-edited state?)`);
  assertConfigMatchesRun(v.run, Object.keys(files), config, where);
  if (!isObj(v.source)) throw new FanoutStateError(`${where}: acceptance.source missing`);
  refuseUnknown(v.source, new Set(['branch', 'head']), `${where} acceptance.source`);
  const head = checked(strOrNull(v.source.head, 'acceptance.source.head'), HEX_SHA, 'acceptance.source.head');
  if (!head) throw new FanoutStateError(`${where}: acceptance.source.head missing`);
  const branch = checked(strOrNull(v.source.branch, 'acceptance.source.branch'), SAFE_BRANCH, 'acceptance.source.branch');
  if (typeof v.frozenAt !== 'string') throw new FanoutStateError(`${where}: acceptance.frozenAt missing`);
  if (!Array.isArray(v.amendments)) throw new FanoutStateError(`${where}: acceptance.amendments must be an array`);
  const amendments = v.amendments.map((a, i): AcceptanceAmendment => {
    if (!isObj(a)) throw new FanoutStateError(`${where}: acceptance.amendments[${i}] is not an object`);
    const at = `${where} acceptance.amendments[${i}]`;
    if (a.kind === 'harness-only') {
      refuseUnknown(a, new Set(['kind', 'at', 'reason', 'assertionsHash', 'filesBefore', 'hashBefore', 'hashAfter', 'lines']), at);
      let lines: { added: number; removed: number; reorderOnly?: true } | undefined;
      if (a.lines !== undefined) {
        if (!isObj(a.lines) || !Number.isInteger(a.lines.added) || !Number.isInteger(a.lines.removed) || (a.lines.added as number) < 0 || (a.lines.removed as number) < 0) throw new FanoutStateError(`${at}.lines must be {added, removed} non-negative integers`);
        refuseUnknown(a.lines, new Set(['added', 'removed', 'reorderOnly']), `${at}.lines`);
        if (a.lines.reorderOnly !== undefined && a.lines.reorderOnly !== true) throw new FanoutStateError(`${at}.lines.reorderOnly must be true when present`);
        lines = { added: a.lines.added as number, removed: a.lines.removed as number, ...(a.lines.reorderOnly ? { reorderOnly: true as const } : {}) };
      }
      for (const k of ['at', 'reason'] as const) if (typeof a[k] !== 'string' || !(a[k] as string).trim()) throw new FanoutStateError(`${at}.${k} missing`);
      for (const k of ['assertionsHash', 'hashBefore', 'hashAfter'] as const) if (typeof a[k] !== 'string' || !SHA256.test(a[k] as string)) throw new FanoutStateError(`${at}.${k} must be a sha256`);
      if (!isObj(a.filesBefore) || Object.keys(a.filesBefore).length === 0) throw new FanoutStateError(`${at}.filesBefore must be a non-empty {path: sha256}`);
      const filesBefore: Record<string, string> = {};
      for (const [k, h] of Object.entries(a.filesBefore)) {
        assertAcceptancePath(k);
        if (typeof h !== 'string' || !SHA256.test(h)) throw new FanoutStateError(`${at}.filesBefore[${k}] must be a 64-hex sha256`);
        filesBefore[k] = h;
      }
      return { kind: 'harness-only', at: a.at as string, reason: a.reason as string, assertionsHash: a.assertionsHash as string, filesBefore, hashBefore: a.hashBefore as string, hashAfter: a.hashAfter as string, ...(lines ? { lines } : {}) };
    }
    if (a.kind !== undefined && a.kind !== 'decision') throw new FanoutStateError(`${at}.kind must be "harness-only" or "decision"`);
    refuseUnknown(a, new Set(['kind', 'at', 'decision', 'specSentence', 'bodySha256', 'hashBefore', 'hashAfter', 'runAfter', 'configAfter']), at);
    for (const k of ['at', 'decision', 'specSentence'] as const) if (typeof a[k] !== 'string' || !(a[k] as string).trim()) throw new FanoutStateError(`${where}: acceptance.amendments[${i}].${k} missing`);
    for (const k of ['bodySha256', 'hashBefore', 'hashAfter'] as const) if (typeof a[k] !== 'string' || !SHA256.test(a[k] as string)) throw new FanoutStateError(`${where}: acceptance.amendments[${i}].${k} must be a sha256`);
    let configAfter: { path: string; sha256: string } | undefined;
    if (a.configAfter !== undefined) {
      if (!isObj(a.configAfter)) throw new FanoutStateError(`${where}: acceptance.amendments[${i}].configAfter must be an object`);
      refuseUnknown(a.configAfter, new Set(['path', 'sha256']), `${where} acceptance.amendments[${i}].configAfter`);
      if (typeof a.configAfter.sha256 !== 'string' || !SHA256.test(a.configAfter.sha256)) throw new FanoutStateError(`${where}: acceptance.amendments[${i}].configAfter.sha256 must be a sha256`);
      configAfter = { path: assertConfigPath(a.configAfter.path), sha256: a.configAfter.sha256 };
    }
    if (a.runAfter !== undefined && (typeof a.runAfter !== 'string' || !a.runAfter.trim() || /[\r\n\0]/.test(a.runAfter))) throw new FanoutStateError(`${where}: acceptance.amendments[${i}].runAfter must be a single-line command`);
    return { at: a.at as string, decision: a.decision as string, specSentence: a.specSentence as string, bodySha256: a.bodySha256 as string, hashBefore: a.hashBefore as string, hashAfter: a.hashAfter as string, ...(a.runAfter !== undefined ? { runAfter: a.runAfter as string } : {}), ...(configAfter ? { configAfter } : {}) };
  });
  return { files, hash: v.hash, run: v.run, ...(config ? { config } : {}), source: { branch, head }, frozenAt: v.frozenAt, amendments, ...(v.freezeCheck !== undefined ? { freezeCheck: freezeCheckOf(v.freezeCheck, where) } : {}) };
}

function freezeCheckOf(v: unknown, where: string): FreezeCheck {
  if (!isObj(v)) throw new FanoutStateError(`${where}: acceptance.freezeCheck must be an object`);
  refuseUnknown(v, new Set(['at', 'target', 'targetSha', 'result', 'pass', 'assertionFail', 'skipped', 'escape']), `${where} acceptance.freezeCheck`);
  for (const k of ['at', 'target'] as const) if (typeof v[k] !== 'string' || !(v[k] as string).trim()) throw new FanoutStateError(`${where}: acceptance.freezeCheck.${k} missing`);
  if (typeof v.targetSha !== 'string' || !HEX_SHA.test(v.targetSha)) throw new FanoutStateError(`${where}: acceptance.freezeCheck.targetSha must be a full commit sha`);
  if (v.result !== 'clean' && v.result !== 'escaped') throw new FanoutStateError(`${where}: acceptance.freezeCheck.result must be clean|escaped`);
  for (const k of ['pass', 'assertionFail', 'skipped'] as const) if (v[k] !== undefined && (!Number.isInteger(v[k]) || (v[k] as number) < 0)) throw new FanoutStateError(`${where}: acceptance.freezeCheck.${k} must be a count`);
  let escape: FreezeCheck['escape'];
  if (v.escape !== undefined) {
    if (!isObj(v.escape)) throw new FanoutStateError(`${where}: acceptance.freezeCheck.escape must be an object`);
    refuseUnknown(v.escape, new Set(['by', 'reason', 'unclassified']), `${where} acceptance.freezeCheck.escape`);
    for (const k of ['by', 'reason', 'unclassified'] as const) if (typeof v.escape[k] !== 'string' || !(v.escape[k] as string).trim()) throw new FanoutStateError(`${where}: acceptance.freezeCheck.escape.${k} missing`);
    escape = { by: v.escape.by as string, reason: v.escape.reason as string, unclassified: v.escape.unclassified as string };
  }
  if ((v.result === 'escaped') !== (escape !== undefined)) throw new FanoutStateError(`${where}: acceptance.freezeCheck.escape is present exactly when result is escaped`);
  return { at: v.at as string, target: v.target as string, targetSha: v.targetSha, result: v.result, ...(v.pass !== undefined ? { pass: v.pass as number } : {}), ...(v.assertionFail !== undefined ? { assertionFail: v.assertionFail as number } : {}), ...(v.skipped !== undefined ? { skipped: v.skipped as number } : {}), ...(escape ? { escape } : {}) };
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
      tree: treeOrNull(t.tree, 'tree'),
      builtOnTree: builtOnTreeOf(t.builtOnTree),
      findings: findingsOf(t.findings),
      followUpOf: checked(strOrNull(t.followUpOf, 'followUpOf'), SAFE_TICKET, 'followUpOf'),
      mergedHead: checked(strOrNull(t.mergedHead, 'mergedHead'), HEX_SHA, 'mergedHead (7-40 lowercase hex)'),
      mergedTree: treeOrNull(t.mergedTree, 'mergedTree'),
      forgottenMerges: forgottenOf(t.forgottenMerges),
      fixes: fixesOf(t.fixes),
      spec: specOf(t.spec),
      specText: specTextOf(t.specText),
      implementer: wsIdOf(t.implementer, 'implementer'),
      verifier: wsIdOf(t.verifier, 'verifier'),
      accept: acceptFlowOf(t.accept, `ticket ${id}`),
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : String(raw.updatedAt),
    };
  }
  const state: FanoutState = {
    version: STATE_VERSION,
    run: assertRunId(raw.run),
    target: raw.target,
    repo: strOrNull(raw.repo, 'repo'),
    ...withHarness(harnessOf(raw.harness)),
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
/** #512 — do two (sha, tree) pairs name the same CONTENT? Same sha, or both trees known and equal. An unknown tree never matches (fail closed: the verdict stays sha-keyed). */
export const sameContent = (aSha: string, aTree: string | null | undefined, bSha: string, bTree: string | null | undefined): boolean => sameSha(aSha, bSha) || (!!aTree && !!bTree && aTree === bTree);

/**
 * #506 — may dependent `dep` be NOMINATED/GATED while its (unmerged) upstream `up` is open? Only on the upstream's verified candidate:
 * the upstream is nominated|gated with a recorded head and no failing verdict, and `dep` recorded the head it was built on = that head.
 * `upHead` overrides the state's head (reconcile passes the remote tip when it has one; `upTree` = that tip's tree, unknown ⇒ sha-keyed). null = admitted.
 * #512: "built on" is CONTENT — the upstream moving to another sha with the tree the dependent was built on (`builtOnTree`) is not a change.
 */
export function upstreamBlocker(state: FanoutState, dep: TicketState, up: string, upHead?: string | null, upTree?: string | null): { kind: 'ineligible' | 'changed'; why: string } | null {
  const u = state.tickets[up];
  if (!u) return { kind: 'ineligible', why: `${up} is unknown to the state` };
  if (u.status !== 'nominated' && u.status !== 'gated') return { kind: 'ineligible', why: `${up} is ${u.status} (it needs a nominated|gated candidate)` };
  if (u.verdict === 'fail' || u.verdict === 'changes-requested') return { kind: 'ineligible', why: `${up}'s verdict is ${u.verdict}` };
  const head = upHead ?? u.head;
  if (!head) return { kind: 'ineligible', why: `${up} has no recorded head` };
  const built = dep.builtOn[up];
  if (!built) return { kind: 'ineligible', why: `no builtOn for ${up} (record the head it was built on: --built-on ${up}=<sha>)` };
  if (!sameContent(built, dep.builtOnTree[up], head, upHead != null ? upTree : u.tree)) return { kind: 'changed', why: `built on ${up}@${built.slice(0, 8)} but ${up} is now at ${head.slice(0, 8)}` };
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
    if (upstreamMerged(state, u)) return builtOn && head && !sameContent(builtOn, t.builtOnTree[u], head, ut?.tree) ? { id: u, state: 'changed' as const, builtOn, head, why: `built on ${u}@${builtOn.slice(0, 8)} but ${u} merged at ${head.slice(0, 8)}` } : { id: u, state: 'merged' as const, builtOn, head };
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

/** #514 — the rule, in words (every refusal carries it). */
export const FOLLOWUP_RULE = 'A follow-up candidate on an already-merged ticket needs at least one BLOCKING or MAJOR finding of that ticket it fixes, or a MINOR whose specSentence is a literal sentence of the ticket\'s captured spec; other MINOR findings get no action (no follow-up PR, no extra list).';
/** `refuse` = the #514 rule as it was (MINOR findings get no action): the wording under that switch. */
export const FOLLOWUP_RULE_REFUSE = 'A follow-up candidate on an already-merged ticket needs at least one BLOCKING or MAJOR finding of that ticket it fixes; MINOR findings get no action (no follow-up PR, no extra list).';
export type FollowUpReason = 'followup-undeclared' | 'followup-base-not-merged' | 'followup-no-finding' | 'followup-unknown-finding' | 'followup-minor-only' | 'followup-process-finding' | 'finding-unsettled';

// ── #552 — the MINOR policy. `switchesOf` is the T3 seam (#554 owns the switches, their storage and their freeze): until it lands this STUB answers the defaults, `minorPolicy: 'spec'`. ──
export type MinorPolicy = 'legacy' | 'refuse' | 'spec';
export interface FanoutSwitches { earlyGate: 'on' | 'off'; acceptance: 'on' | 'off'; minorPolicy: MinorPolicy }
export function switchesOf(state: FanoutState): FanoutSwitches {
  // STUB (T3 replaces this body): the defaults; an in-memory `switches` field (never persisted — parseState refuses it) lets a test drive the other policies.
  return { earlyGate: 'on', acceptance: 'on', minorPolicy: 'spec', ...((state as { switches?: Partial<FanoutSwitches> }).switches ?? {}) };
}
const followUpRuleOf = (policy: MinorPolicy): string => (policy === 'spec' ? FOLLOWUP_RULE : FOLLOWUP_RULE_REFUSE);

/** #552 — is the finding's `specSentence` ACCEPTED: present and a LITERAL substring (no trim, no case-fold) of the spec text captured at registration? Code checks the sentence is IN the spec, never that it is really broken — the reviewer judges that. Re-checked wherever it is acted on (a hand-edited state cannot smuggle one in). */
export function sentenceAccepted(t: Pick<TicketState, 'specText'>, f: FindingRecord): boolean {
  return f.specSentence !== undefined && f.specSentence.trim() !== '' && t.specText !== null && t.specText.includes(f.specSentence);
}
/** #552 (D5 m4) — the spec text a ticket's sentences are matched against: its own, else — a follow-up candidate has no spec of its own — the base ticket's. */
export function effectiveSpec(state: FanoutState, t: Pick<TicketState, 'specText' | 'followUpOf'>): { specText: string | null } {
  let text = t.specText;
  let up = t.followUpOf;
  for (let depth = 0; text === null && up && depth < 8; depth++) { const b: TicketState | undefined = state.tickets[up]; text = b?.specText ?? null; up = b?.followUpOf ?? null; } // a follow-up of a follow-up inherits through the chain
  return { specText: text };
}
/** Is the finding closed: settled (fixed / pr-body) or decided by the coordinator. */
export const findingClosed = (f: FindingRecord): boolean => !!f.settled || !!f.decision;
/**
 * #552 — a MINOR with an accepted specSentence, not settled and not decided, BLOCKS the merge under `minorPolicy: spec` (like a MAJOR): the ids, per ticket `id`.
 * A merged ticket is not blocked (a finding raised after the merge goes through a follow-up). `process` findings block too — their way out is the PR-body edit (`settled.how = pr-body`), not a code round.
 */
export function blockingMinors(state: FanoutState, id: string): string[] {
  const t = state.tickets[id];
  if (!t || switchesOf(state).minorPolicy !== 'spec' || t.status === 'merged' || t.mergedHead) return [];
  return Object.entries(t.findings).filter(([, f]) => f.severity === 'MINOR' && sentenceAccepted(effectiveSpec(state, t), f) && !findingClosed(f)).map(([k]) => k);
}
export function mergeBlockRefusal(state: FanoutState, id: string): FollowUpRefusal | null {
  const ids = blockingMinors(state, id);
  if (ids.length === 0) return null;
  const t = state.tickets[id];
  const how = (k: string): string => (t.findings[k].kind === 'process' ? `edit the PR body, then state set ${id} --settle ${k}=pr-body:<what it says now>` : `fix it, then state set ${id} --settle ${k}=fixed:<head>`);
  return { reason: 'finding-unsettled', detail: `${id}: ${ids.length} MINOR finding(s) break a sentence of the ticket's spec and are neither settled nor decided: ${ids.map((k) => `${k} (“${t.findings[k].specSentence!.replace(/\s+/g, ' ').slice(0, 80)}”${t.findings[k].kind === 'process' ? ', process' : ''})`).join('; ')} — ${ids.map(how).join('; ')}; or the coordinator records a decision: state set ${id} --decide <finding>=<text>. (Code checks the sentence is in the spec, not that it is really broken: the reviewer judges that.)` };
}
export interface FollowUpRefusal { reason: FollowUpReason; detail: string }

/**
 * #514 — may ticket `id` (a candidate at `head`, when the caller has one) proceed, given the follow-up rule? null = yes.
 *  - `followUpOf` set: the named ticket must exist and be merged, `fixes` must be non-empty, every id must be a finding recorded on THAT ticket,
 *    and at least one must be BLOCKING|MAJOR (MINOR-only ⇒ refused, an unknown id ⇒ refused even beside a real one).
 *  - a ticket WITHOUT `followUpOf` whose branch (`branch` = the one being gated/delivered, or its own) or PR is the one ANOTHER ticket merged at, at another head ⇒ a follow-up
 *    registered under a fresh id: refused. (A brand-new branch under a fresh id cannot be told from a new ticket: coordinator trust.)
 *  - a merged ticket with no recorded head has no merged head to compare to: the rule does not consult it (the normal path is unchanged).
 *  - ANY ticket that has merged (`mergedHead`, or status merged at its recorded head) named with a candidate head other than the one it merged at ⇒ an undeclared
 *    follow-up: refused — whether or not it has a `followUpOf` itself, and even after an un-merge. (The merged head itself = a retry of the merge: not a follow-up.)
 */
export function followUpRefusal(state: FanoutState, id: string, head?: string | null, branch?: string | null, headTree?: string | null): FollowUpRefusal | null {
  const t = state.tickets[id];
  if (!t) return null;
  const policy = switchesOf(state).minorPolicy;
  const refuse = (reason: FollowUpReason, why: string): FollowUpRefusal => ({ reason, detail: `${id}: ${why}. ${followUpRuleOf(policy)}` });
  // #512: the same git tree on another sha (rebase / author rewrite) is the same content — a retry, not a further candidate
  const sameMerge = (mh: string, mt: string | null): boolean => !!head && (sameSha(mh, head) || (!!mt && !!headTree && mt === headTree));
  const merged = t.mergedHead ?? (t.status === 'merged' ? t.head : null);
  if (head && merged && (t.mergedHead || t.status === 'merged') && !sameMerge(merged, t.mergedHead ? t.mergedTree : t.tree)) {
    return refuse('followup-undeclared', `it merged${merged ? ` at ${merged.slice(0, 8)}` : ''} and ${head.slice(0, 8)} is a further candidate on it — register it as its own ticket: state set <new id> --follow-up-of ${id} --fixes <finding id>[,…] (if the merge was never real: state set ${id} --forget-merge <reason>)`);
  }
  if (!t.followUpOf) {
    if (head) {
      for (const [mid, m] of Object.entries(state.tickets)) {
        const mh = m.mergedHead ?? (m.status === 'merged' ? m.head : null);
        const shared = (m.branch && (m.branch === branch || m.branch === t.branch) ? `branch ${m.branch}` : null) ?? (m.pr && m.pr === t.pr ? `PR #${m.pr}` : null);
        if (mid !== id && mh && shared && !sameMerge(mh, m.mergedHead ? m.mergedTree : m.tree)) {
          return refuse('followup-undeclared', `it carries ${shared}, which ${mid} merged at ${mh.slice(0, 8)}, and ${head.slice(0, 8)} is a further candidate on it — a follow-up needs its declaration: state set ${id} --follow-up-of ${mid} --fixes <finding id>[,…]`);
        }
      }
    }
    if (t.fixes.length) return refuse('followup-no-finding', '--fixes only applies to a follow-up (--follow-up-of <merged ticket>)');
    return null;
  }
  const base = state.tickets[t.followUpOf];
  if (t.followUpOf === id || !base) return refuse('followup-base-not-merged', `it follows ${t.followUpOf}, which ${t.followUpOf === id ? 'is itself' : 'is not in the state'}`);
  if (base.status !== 'merged') return refuse('followup-base-not-merged', `it follows ${t.followUpOf}, which is ${base.status}, not merged — fix it on its own branch, not by a follow-up`);
  if (t.fixes.length === 0) return refuse('followup-no-finding', `it names no finding it fixes (--fixes <id>[,…], recorded on ${t.followUpOf})`);
  const unknown = t.fixes.filter((f) => !base.findings[f]);
  if (unknown.length) return refuse('followup-unknown-finding', `finding ${unknown.join(', ')} is not recorded on ${t.followUpOf} (recorded: ${Object.keys(base.findings).join(', ') || 'none'}; record it with state set ${t.followUpOf} --finding <id>=<severity>)`);
  // #552: a process finding (how the work is REPORTED) is settled by a PR-body edit — it never starts a code round, whatever its severity
  const proc = t.fixes.filter((f) => base.findings[f].kind === 'process');
  if (proc.length) return refuse('followup-process-finding', `${proc.join(', ')} of ${t.followUpOf} is a process finding (how the work is reported): it is settled by editing the PR body (state set ${t.followUpOf} --settle ${proc[0]}=pr-body:<what it says now>), never by a code round`);
  // BLOCKING | MAJOR, or — under minorPolicy spec — a MINOR whose specSentence the captured spec contains
  const qualifies = (f: string): boolean => base.findings[f].severity === 'BLOCKING' || base.findings[f].severity === 'MAJOR' || (policy === 'spec' && sentenceAccepted(effectiveSpec(state, base), base.findings[f]));
  if (!t.fixes.some(qualifies)) {
    return refuse('followup-minor-only', `it fixes only MINOR finding(s) of ${t.followUpOf} (${t.fixes.map((f) => `${f}=${base.findings[f].severity}${base.findings[f].specSentence !== undefined ? ' (its specSentence is not in the captured spec)' : ''}`).join(', ')})`);
  }
  return null;
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
export function applyTicketPatch(state: FanoutState, id: string, patch: Record<string, unknown>, now: string, derived: { tree?: string | null; builtOnTree?: Record<string, string>; specText?: string | null } = {}): FanoutState {
  if (!SAFE_TICKET.test(id)) throw new FanoutStateError(`unsafe ticket id ${JSON.stringify(id)}`);
  refuseUnknown(patch, new Set<string>(SETTABLE_KEYS), 'patch');
  const prev: TicketState = state.tickets[id] ?? blankTicket(now);
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
  // #512 — the content keys follow head / builtOn: a derived value wins; an unchanged sha keeps its tree; a changed sha with no derived tree is UNKNOWN (null), never the old head's tree.
  if ('head' in patch) next.tree = derived.tree !== undefined ? treeOrNull(derived.tree, 'tree') : prev.head && next.head && sameSha(prev.head, next.head) ? prev.tree : null;
  const dTrees = builtOnTreeOf(derived.builtOnTree);
  next.builtOnTree = {};
  for (const [k, h] of Object.entries(next.builtOn)) {
    const t = dTrees[k] ?? (prev.builtOn[k] && sameSha(prev.builtOn[k], h) ? prev.builtOnTree[k] : undefined);
    if (t) next.builtOnTree[k] = t;
  }
  // #552 — the spec text is DERIVED (the CLI read it at registration); a new spec reference with nothing read = NOT captured, never the old spec's text
  if ('spec' in patch) next.spec = specOf(patch.spec);
  if (derived.specText !== undefined) next.specText = specTextOf(typeof derived.specText === 'string' ? derived.specText.replace(/\r\n/g, '\n') : derived.specText); // CRLF → LF: a sentence is quoted with LF
  else if ('spec' in patch && next.spec !== prev.spec) next.specText = null;
  if (next.specText !== null && next.spec === null) throw new FanoutStateError(`${id}: spec text without a spec reference (register --spec <ref> first)`);
  const followUpNow = 'followUpOf' in patch ? (typeof patch.followUpOf === 'string' ? patch.followUpOf : null) : next.followUpOf;
  const specNow = effectiveSpec(state, { specText: next.specText, followUpOf: followUpNow });
  if (next.specText !== prev.specText || followUpNow !== prev.followUpOf) {
    // EVERY ticket whose effective spec (own text, or the one inherited through the follow-up chain) passes through this change: the open accepted sentences it held must still be in the text it has now
    const after: FanoutState = { ...state, tickets: { ...state.tickets, [id]: { ...next, followUpOf: followUpNow } } };
    const lost: string[] = [];
    for (const [tid, before] of Object.entries({ ...state.tickets, [id]: prev })) {
      for (const [k, f] of Object.entries(before.findings)) {
        if (f.specSentence !== undefined && !findingClosed(f) && sentenceAccepted(effectiveSpec(state, before), f) && !sentenceAccepted(effectiveSpec(after, after.tickets[tid]), f)) lost.push(tid === id ? k : `${tid}/${k}`);
      }
    }
    if (lost.length) throw new FanoutStateError(`${id}: the new spec text no longer contains the specSentence of ${lost.join(', ')} — settle or decide ${lost.length > 1 ? 'them' : 'it'} first (re-capturing the spec must not silently un-block a merge)`);
  }
  next.findings = { ...prev.findings }; // never mutate the previous state's record (settle / decide write into it below)
  if ('findings' in patch) {
    const add = findingsOf(patch.findings);
    for (const [k, f] of Object.entries(add)) {
      const had = prev.findings[k];
      if (f.decision || f.settled) throw new FanoutStateError(`${id}: finding ${k}: decision / settled are recorded with --decide / --settle, not with --finding`);
      if (had && had.severity !== f.severity) throw new FanoutStateError(`${id}: finding ${k} is already recorded as ${had.severity} — a recorded severity is not re-graded (a MINOR cannot be promoted to justify a follow-up)`);
      for (const field of ['evidence', 'kind', 'specSentence'] as const) if (had && f[field] !== undefined && (field === 'kind' ? (had.kind ?? 'code') : had[field]) !== undefined && (field === 'kind' ? (had.kind ?? 'code') : had[field]) !== f[field]) throw new FanoutStateError(`${id}: finding ${k} already records ${field} ${JSON.stringify(field === 'kind' ? (had.kind ?? 'code') : had[field])} — a recorded finding is not rewritten (the kind is fixed when the finding is recorded: a code finding cannot become a process one to be settled by a PR-body edit)`);
      if (had?.report && f.report && JSON.stringify(had.report) !== JSON.stringify(f.report)) throw new FanoutStateError(`${id}: finding ${k} already records its report — a recorded finding is not rewritten`);
      if (f.specSentence !== undefined && !sentenceAccepted(specNow, f)) {
        throw new FanoutStateError(`${id}: finding ${k}: specSentence is not a literal sentence of ${id}'s captured spec${next.specText === null ? ' (no spec text was captured: register it with state set --spec <file> or --spec-text <file|->)' : ' (exact characters, no trim, no case-fold)'} — refused. ${SPEC_SENTENCE_LIMIT}`);
      }
      next.findings[k] = { ...(had ?? {}), ...f };
      const gap = reportGap(next.findings[k]);
      if (gap) throw new FanoutStateError(`${id}: finding ${k}: ${gap}`);
    }
  }
  for (const [k, v] of Object.entries(isObj(patch.settle) ? patch.settle : {})) {
    const f = next.findings[k];
    if (!f) throw new FanoutStateError(`${id}: --settle ${k}: no such finding recorded on ${id}`);
    if (f.settled) throw new FanoutStateError(`${id}: finding ${k} is already settled (${f.settled.how}, ${f.settled.ref})`);
    const how = f.kind === 'process' ? 'pr-body' : 'fixed';
    if (!isObj(v) || v.how !== how) throw new FanoutStateError(`${id}: finding ${k} is ${f.kind === 'process' ? 'a process finding: settled by a PR-body edit (--settle ' + k + '=pr-body:<what the PR body says now>)' : 'a code finding: settled by a fix (--settle ' + k + '=fixed:<head or commit>)'}`);
    next.findings[k] = { ...f, settled: { how, at: now, ref: lineOf(v.ref, `${id}: --settle ${k} reference`, 500) } };
  }
  for (const [k, v] of Object.entries(isObj(patch.decide) ? patch.decide : {})) {
    const f = next.findings[k];
    if (!f) throw new FanoutStateError(`${id}: --decide ${k}: no such finding recorded on ${id}`);
    if (!isObj(v)) throw new FanoutStateError(`${id}: --decide ${k} needs a text`);
    next.findings[k] = { ...f, decision: { by: lineOf(v.by ?? 'coordinator', `${id}: --decide ${k} by`, 200), text: lineOf(v.text, `${id}: --decide ${k} text`), at: now } };
  }
  if ('followUpOf' in patch) next.followUpOf = checked(strOrNull(patch.followUpOf, 'followUpOf'), SAFE_TICKET, 'followUpOf');
  if ('fixes' in patch) next.fixes = fixesOf(patch.fixes);
  if ('forgetMerge' in patch) {
    if (typeof patch.forgetMerge !== 'string' || !patch.forgetMerge.trim()) throw new FanoutStateError('--forget-merge needs a reason');
    next.forgottenMerges = [...prev.forgottenMerges, { at: now, reason: patch.forgetMerge.trim(), was: prev.mergedHead }];
    next.mergedHead = null;
    next.mergedTree = null;
  }
  // the head a ticket merged at is the first one recorded with the merge; a plain head change on a merged ticket would launder a further candidate
  if (prev.status === 'merged' && next.status === 'merged' && 'head' in patch && !('forgetMerge' in patch) && prev.head && next.head && !sameSha(prev.head, next.head)) {
    throw new FanoutStateError(`${id} is already merged at ${prev.head.slice(0, 8)}: ${next.head.slice(0, 8)} is a further candidate on it, i.e. a follow-up. ${FOLLOWUP_RULE} Register it as its own ticket: state set <new id> --follow-up-of ${id} --fixes <finding id>[,…] (recording the head it REALLY merged at after a re-gate: add --forget-merge <reason>)`);
  }
  if (next.status === 'merged' && !next.mergedHead) { next.mergedHead = next.head; next.mergedTree = next.tree; }
  if ('implementer' in patch) next.implementer = wsIdOf(patch.implementer, 'implementer');
  if ('verifier' in patch) next.verifier = wsIdOf(patch.verifier, 'verifier');
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
  // #514 — a follow-up candidate must name a BLOCKING/MAJOR finding of the merged ticket it follows; a further candidate on a merged ticket is a follow-up.
  const fu = followUpRefusal(out, id, next.status === 'nominated' || next.status === 'gated' ? next.head : undefined, next.branch, next.tree); // a nominated|gated candidate on a ticket that ever merged
  if (fu) throw new FanoutStateError(fu.detail);
  if (prev.status === 'merged' && (next.status === 'nominated' || next.status === 'gated')) { // (merged → started|todo|dropped is the explicit un-merge, not a candidate)
    throw new FanoutStateError(`${id} is already merged: a further candidate on it is a follow-up. ${FOLLOWUP_RULE} Register it as its own ticket: state set <new id> --follow-up-of ${id} --fixes <finding id>[,…] (the findings are recorded with --finding <id>=BLOCKING|MAJOR|MINOR)`);
  }
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
    try { fs.writeSync(fd, `${JSON.stringify({ ...valid, tickets: Object.fromEntries(Object.entries(valid.tickets).map(([id, t]) => [id, storedTicket(t)])) }, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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
  /** #512 — git tree of `branchHead` / of `pr.headRefOid`; undefined = unreadable (UNKNOWN: the sha comparison stands). */
  branchTree?: string | null;
  prTree?: string | null;
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
  writeBack: Array<{ ticket: string; patch: Omit<TicketPatch, 'findings' | 'settle' | 'decide'>; why: string; seen: string }>;
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
  const mergedTree = r?.pr?.state === 'MERGED' ? r.prTree : r?.branchTree;
  return mergedHead && !sameContent(mergedHead, mergedTree, t.head, t.tree) ? mergedHead : null; // #512: the verdict's tree merged = covered
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
    if (r && !r.error && t.head && r.branchHead && !sameSha(r.branchHead, t.head) && rm !== true && (t.status === 'nominated' || t.status === 'gated') && t.tree && r.branchTree === t.tree) {
      // #512: the branch moved to another sha with the SAME tree (rebase, author rewrite): the verdict stands, only the recorded head follows. Not a divergence.
      writeBack.push({ ticket: id, seen: t.updatedAt, patch: { head: r.branchHead, tree: r.branchTree }, why: `head moved to ${r.branchHead.slice(0, 8)}, same tree: ${t.verdict} verdict kept` });
    } else if (r && !r.error && t.head && r.branchHead && !sameSha(r.branchHead, t.head) && rm !== true && (t.status === 'nominated' || t.status === 'gated')) {
      add({ ticket: id, kind: 'head-moved', detail: `branch head ${r.branchHead.slice(0, 8)} != recorded ${t.head.slice(0, 8)} — verdict ${t.verdict} is stale` });
      if (t.verdict !== 'none' || t.status === 'gated') {
        writeBack.push({ ticket: id, seen: t.updatedAt, patch: { head: r.branchHead, tree: r.branchTree ?? null, verdict: 'none', ...(t.status === 'gated' ? { status: 'nominated' as const } : {}) }, why: 'head moved: verdict reset' });
      } else {
        writeBack.push({ ticket: id, seen: t.updatedAt, patch: { head: r.branchHead, tree: r.branchTree ?? null }, why: 'head moved' });
      }
    } else if (r?.pr && t.head && r.pr.headRefOid && !sameContent(r.pr.headRefOid, r.prTree, t.head, t.tree) && t.status !== 'merged' && r.pr.state === 'OPEN') {
      add({ ticket: id, kind: 'pr-head-moved', detail: `PR #${t.pr} head ${r.pr.headRefOid.slice(0, 8)} != recorded ${t.head.slice(0, 8)}` });
    }
    if (r?.pr?.state === 'MERGED' && r.pr.baseRefName !== state.target && rm !== true && t.status !== 'dropped' && !accepted) {
      add({ ticket: id, kind: 'pr-merged-other-base', detail: `PR #${t.pr} is MERGED into ${r.pr.baseRefName ?? '(unknown base)'}, not origin/${state.target}: not merged on the target` });
    }
    if (ungated) {
      add({ ticket: id, kind: 'merged-at-ungated-head', detail: `merged at ${ungated.slice(0, 8)} but the ${t.verdict} verdict was on ${t.head?.slice(0, 8)}: re-gate the merged tree, then \`state set ${id} --status merged --head ${ungated.slice(0, 12)} --forget-merge <reason>\`` });
    }
    if (r?.pr?.state === 'CLOSED' && t.status !== 'merged' && t.status !== 'dropped') {
      add({ ticket: id, kind: 'pr-closed-unmerged', detail: `PR #${t.pr} is CLOSED without merging` });
    }
    if ((t.status === 'nominated' || t.status === 'gated' || t.status === 'merged')) {
      const open = t.dependsOn.filter((d) => !effMerged(d));
      if (t.status === 'merged' && open.length) add({ ticket: id, kind: 'nominated-before-upstream-merged', detail: `merged while upstream ${open.join(', ')} is not merged` });
      if (t.status !== 'merged') {
        // #506: an open upstream is fine only on its verified candidate; the head read is the remote tip when there is one.
        const bl = open.map((u) => ({ u, b: upstreamBlocker(state, t, u, reality[u]?.error ? null : reality[u]?.branchHead, reality[u]?.branchTree) })).filter((x) => x.b !== null);
        const bad = bl.filter((x) => x.b!.kind === 'ineligible');
        const moved = bl.filter((x) => x.b!.kind === 'changed');
        if (bad.length) add({ ticket: id, kind: 'nominated-before-upstream-merged', detail: `${t.status} while upstream ${bad.map((x) => x.u).join(', ')} is not merged and not an admissible candidate: ${bad.map((x) => x.b!.why).join('; ')}` });
        // an upstream that MERGED at a head other than the one recorded in builtOn: re-gate unless the trees match (only `deliver` can tell) — no write-back, the dependent may already be re-gated
        const movedMerged = t.dependsOn.filter((d) => effMerged(d) && t.builtOn[d]).map((d) => ({ d, h: reality[d]?.pr?.state === 'MERGED' ? reality[d]!.pr!.headRefOid : state.tickets[d]?.head ?? null })).filter((x) => x.h && !sameContent(t.builtOn[x.d], t.builtOnTree[x.d], x.h!, reality[x.d]?.pr?.state === 'MERGED' ? reality[x.d]?.prTree : state.tickets[x.d]?.tree));
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
    tickets[w.ticket] = { ...cur, ...w.patch, ...(w.patch.status === 'merged' ? { mergedHead: cur.mergedHead ?? cur.head, mergedTree: cur.mergedHead ? cur.mergedTree : cur.tree } : {}), updatedAt: now };
    if (w.patch.status === 'merged') mergedHere.add(w.ticket);
  }
  return parseState({ ...state, tickets, updatedAt: now, reconciledAt: now });
}
