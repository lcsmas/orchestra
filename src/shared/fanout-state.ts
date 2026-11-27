// #469 — the fan-out vague's execution state: ONE file per run (<ORCHESTRA_HOME>/fanout/<run>/state.json),
// one writer, atomic rewrite, and a pure reconcile against git/gh reality. Prior art: Reclaim's run file + 5-step resume.
// Pure logic + tiny fs helpers; the CLI (src/cli/fanout-state.ts) owns argv and the git/gh runner.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nominationRefusal, withRecord, type CheckRecord } from './fanout-checks.ts';
import { DEMONSTRATION_FIELDS, DEMONSTRATION_LIMIT, DEMONSTRATION_TEXT_MAX, classifyDemonstration, demonstrationAccepted, type Demonstration, type FileOnHead } from './fanout-demonstration.ts';

export const STATE_VERSION = 1;

export const TICKET_STATUSES = ['todo', 'started', 'nominated', 'gated', 'merged', 'dropped', 'parked'] as const; // #603: parked = set aside by the loop (never merged, never dropped)
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
  /** #572 — `minorPolicy=demonstrated`: {input, observed, expected} + the verdict code gave it (accepted = `file`+`head`, else `refusal`). Written by `applyTicketPatch` from the three texts only. */
  demonstration?: Demonstration;
  report?: FindingReport;
  decision?: FindingDecision;
  settled?: FindingSettled;
  /** #589 (I4, seatRecords=on) — written ONLY by `orchestra fanout record`: the recording reviewer's workspace id, its finding text, the head it was raised on, and who read the fix on which later head. */
  by?: string;
  text?: string;
  raisedOn?: string;
  fixedBy?: { by: string; head: string; at: string };
  /** #641 — written ONLY by `fanout record --on-choice`: the finding's subject is the run's recorded choice n of this ticket; it never blocks the merge, the report lists it. */
  onChoice?: number;
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

/** #589 (I4) — one recorded verdict: who, the exact head (+ its tree) it read, the finding ids it raised / closed as fixed. */
export interface ReviewEntry { n: number; reviewer: string; head: string; tree: string | null; verdict: 'approve' | 'changes-requested'; findings: string[]; closed: string[]; at: string;
  /** #675 — the reviewer's answer per numbered acceptance criterion of the ticket text (`fanout record --json criteria`); absent = the ticket text has none. */
  criteria?: Record<string, 'met' | 'unmet'> }

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
  /** #564 — pre-nomination check records by git TREE of the head they ran on (DERIVED: only `orchestra fanout check` writes it; absent = none, never written empty). */
  checks?: Record<string, CheckRecord>;
  /** #589 (I4, seatRecords=on) — the verdicts the recorded reviewer recorded (`orchestra fanout record`), oldest first. Counts are DERIVED (`reviewCounts`), never stored. */
  reviews?: ReviewEntry[];
  /** #587 (seatRecords) — true once `--depends-on` was given (`none` = declared empty). Optional: never written under seatRecords=off, a v1 file without it loads (= false). */
  depsDeclared?: boolean;
  /** #587 — the interface other tickets build against (null / absent = none). Optional like the rest: written only by `--interface`. */
  iface?: Iface | null;
  /** #587 — upstream id → the `iface.version` of that upstream this ticket follows (`--follows`). Absent = follows nothing. */
  follows?: Record<string, number>;
  /** #588 (I3) — the reviewer Orchestra spawned for this ticket + every brief it was sent (written ONLY by `orchestra fanout review` / its host op; absent = none). */
  review?: ReviewRecord;
  /** #587 PR B (ledger #591 I6) — written ONLY by `orchestra fanout start` (the host): when this ticket's implementer was launched, `spawn` or `respawn` (a dead one replaced), the sha256 of the brief it was given, how many briefs the ticket has had. Not settable by `state set`. */
  start?: { at: string; kind: 'spawn' | 'respawn'; briefHash: string; briefs: number };
  /** #603 — set EXACTLY when `status` is `parked` (parseState refuses either without the other): why the loop set this ticket aside. Written only by `parkTicket` / `unparkTicket`. */
  parked?: ParkRecord;
  /** #603 — the situation fingerprint of each round of findings this ticket went through (`recordRound`); the same one twice = the ticket loops. */
  rounds?: RoundRecord[];
  /** #607 — the loop's CI bookkeeping for the head it last read (written ONLY by `stepCi`, never by `state set`). */
  ci?: CiRecord;
  updatedAt: string;
}

// ── #603 (ledger #613 FROZEN NAMES v1): parked, the situation fingerprint, the agents' recorded choices, the run's pause ──
export const PARK_CAUSES = ['question', 'situation', 'ci', 'upstream'] as const;
export type ParkCause = (typeof PARK_CAUSES)[number];
/** `blockedBy` is set exactly when `cause` is `upstream` (the parked ticket it waits for); a transitive dependent's reason is `blocked by <ticket>`. */
export interface ParkRecord { cause: ParkCause; reason: string; at: string; blockedBy?: string }
export interface RoundRecord { n: number; fingerprint: string; at: string }
export const CHOICE_RULES = ['reversible-default', 'no-safe-option'] as const;
export type ChoiceRule = (typeof CHOICE_RULES)[number];
export interface ChoiceRecord { n: number; ticket: string; question: string; rule: ChoiceRule; answer: string; at: string;
  /** #675 — the verbatim sentence of the ticket text this choice narrows (`fanout choice --narrows`); absent = none declared. */
  narrows?: string }
/** The ONLY pause of slice 1: `prs` = the pull requests red on the same `check` (null = no single check named). */
export interface PauseRecord { at: string; reason: string; check: string | null; prs: number[];
  /** #655 — set ONLY by the loop's environment pause: the loop stays alive, reruns the red checks (`tries` so far, next at `nextAt`) and lifts it by itself on the first green. A human `--pause` has none: exit 4. */
  auto?: { tries: number; nextAt: string } }
/** #655 — an automatic pause that lifted itself: the report says how long the run waited. */
export interface WaitRecord { at: string; until: string; ms: number; check: string | null; prs: number[]; reruns: number }

/** #607 — what `stepCi` remembers between two (disposable) passes: the ONE re-run per head, the author told, the flaky checks (report), the checks the run attributed to the environment. `head` resets `rerun`/`told`/`env`, never `reruns`/`seen`/`tells`/`flaky`. */
export interface CiRecord {
  head: string;
  rerun: { at: string; names: string[]; jobs: Record<string, string> } | null;
  told: { at: string; names: string[] } | null;
  /** re-runs made for this ticket IN TOTAL (never reset: one automatic re-run per ticket) */
  reruns: number;
  /** fingerprints (check names + normalised log tail) of the reds the author was told; cleared by a green */
  seen: string[];
  /** times the author was told about this exact set of check names; cleared by a green */
  tells: Record<string, number>;
  flaky: string[];
  /** reds the run blamed on the environment: the check and the job id of the run that was red (null = the forge gave none) */
  env: Array<{ name: string; job: string | null; reran: boolean }>;
}

/** #588 (I3) — one brief sent to the ticket's reviewer: `kind` = first spawn / delta to the SAME live reviewer / a new reviewer after the old one died. `hash` = sha256 of `text`. */
export interface ReviewBrief { n: number; kind: 'spawn' | 'wake' | 'replace'; head: string; base: string | null; hash: string; text: string; reviewer: string | null; at: string }
export interface ReviewRecord {
  /** The recorded reviewer (`id` null = the spawn is in flight, or failed — `error`). null = none yet. */
  reviewer: { id: string | null; name: string; at: string; error?: string } | null;
  /** The head the reviewer was last briefed on, and its base. */
  head: string | null;
  base: string | null;
  briefs: ReviewBrief[];
}
/** #587 — one superseded version of an interface: `reason` = WHY it was replaced (the reason given with the next version), `at` = when. */
export interface IfaceVersion { version: number; text: string; reason: string | null; at: string }
/** #587 — `version` ≥ 1 and `text` are the CURRENT version; `history` = the superseded ones, newest last. */
export interface Iface { version: number; text: string; history: IfaceVersion[] }

export interface FanoutState {
  version: typeof STATE_VERSION;
  run: string;
  /** Integration branch the tickets merge into (reality is read against `origin/<target>`). */
  target: string;
  /** `owner/name` for `gh -R`; null = the checkout's own repo. */
  repo: string | null;
  /** #538 — the repo's own integration test entry, DECLARED by the coordinator (a path and/or the command that runs it; one line). Absent = not declared (the key is never written as null, so an older binary reads a state that declares nothing): the writer's brief falls back to discovery (shared/fanout-harness.ts). */
  harness?: string;
  /** #554 — the switches the run SET explicitly (see `switchesOf`; since #559 only the explicit ones — a V378 frozen state keeps its full set). Absent = every default of `switchDefaults` (never written as null). */
  switches?: Partial<Switches>;
  /** #559 — which default set an unset switch takes: `v0.5.375` (earlyGate on, acceptance off, minorPolicy legacy) or `v0.5.378` (on/on/spec — a run that had already spawned when the defaults changed keeps it). Stamped by `stampDefaults` before any write; absent = not stamped yet (read through `defaultsProfileOf`). */
  switchDefaults?: DefaultsProfile;
  /** #554 — set at the run's FIRST SPAWN (first ticket past `todo`, first implementer/verifier/acceptor recorded — `firstSpawnSignal`): from then on no switch can change. */
  switchesFrozen?: { at: string; by: string };
  /** #587 (seatRecords) — the run's ticket list, declared by `state set --plan` before the first spawn (`--plan-add` appends, also after it). Absent = not declared. */
  plan?: { tickets: string[]; declaredAt: string };
  /** #587 PR A (ledger #591 I3 v2) — the run's decisions: what the coordinator must tell every seat; EVERY brief carries them verbatim (`fanout-brief-common.ts`). Appended by `state set --run-decision`, never edited. */
  decisions?: Array<{ n: number; text: string; by: string; at: string }>;
  /** #603 — what the agents chose when they asked (`recordChoice`), oldest first; the closing report lists each. */
  choices?: ChoiceRecord[];
  /** #603 — set while the run is paused for an environment fault (`pauseRun` / `resumeRun`). */
  pause?: PauseRecord;
  /** #655 — the automatic pauses already lifted (oldest first). */
  waited?: WaitRecord[];
  /** #654 — checks of the start check (the empty pull request) that were red, then green on the one re-run: listed `flaky` in the report. */
  startFlaky?: string[];
  /** #604 (ledger #613 FROZEN v1) — set ONLY by `applyPlan` (src/shared/fanout-plan.ts): the run's plan came from the plan step of the Boucle (hash = sha256 of the normalised plan JSON, attempts = submissions it took). From then on `--run-decision` is refused `decision-after-plan`. Not settable by `state set`. */
  loopPlan?: { at: string; hash: string; attempts: number };
  /** #604 (review r1 m3) — set ONLY by the plan step when it ENDS without a plan (`plan-refused-twice` | `plan-apply-failed`): `fanout start` / `applyPlan` refuse while it stands, so deleting the plan record does not reopen the run. Not settable by `state set`. */
  planRefusal?: { at: string; code: 'plan-refused-twice' | 'plan-apply-failed'; detail: string };
  tickets: Record<string, TicketState>;
  updatedAt: string;
  reconciledAt: string | null;
}


// ── #554: one switch per feature, frozen for the run ──────────────────────────────────────────────────────────
export const SWITCH_VALUES = { earlyGate: ['on', 'off'], acceptance: ['on', 'off'], minorPolicy: ['legacy', 'refuse', 'spec', 'demonstrated'], verifier: ['on', 'off'], preNominationChecks: ['on', 'off'], seatRecords: ['on', 'off'] } as const;
export type SwitchName = keyof typeof SWITCH_VALUES;
export const SWITCH_NAMES = Object.keys(SWITCH_VALUES) as SwitchName[];
export interface Switches { earlyGate: 'on' | 'off'; acceptance: 'on' | 'off'; minorPolicy: 'legacy' | 'refuse' | 'spec' | 'demonstrated'; verifier: 'on' | 'off'; preNominationChecks: 'on' | 'off'; seatRecords: 'on' | 'off' }
/** earlyGate (#506): off = a dependent waits for its upstream's MERGE · acceptance (#510/#515): off = no writer spawned, no frozen test asked ·
 *  minorPolicy: legacy = follow-ups unrestricted (before #514) · refuse = #514 (a MINOR-only follow-up is refused) · spec = #552 · demonstrated = #572 (a finding of ANY severity with an accepted demonstration blocks like a MAJOR; follow-ups unrestricted as under legacy) ·
 *  verifier (#563): off = no verifier seat; deliver on the reviewer's verdict + a green CI on the head (`--no-review-gate` refused, `state set --verifier` refused) ·
 *  preNominationChecks (#564): on = a nomination needs a passing `orchestra fanout check` record for the head's tree; off = none asked ·
 *  seatRecords (#585/#587): on = the plan (every ticket + its dependencies) and the interface of each depended-on ticket are declared before the first spawn; off = none of it (every render and verb as before). */
export const DEFAULT_SWITCHES: Readonly<Switches> = { earlyGate: 'on', acceptance: 'off', minorPolicy: 'legacy', verifier: 'on', preNominationChecks: 'off', seatRecords: 'off' }; // #559: the v0.5.375 profile; #564 (ledger #565 D3): off in both profiles
/** #559 — the defaults of v0.5.378 (#554): kept for a run that had already spawned when the defaults changed (never re-read with other defaults mid-run). */
export const V378_DEFAULT_SWITCHES: Readonly<Switches> = { earlyGate: 'on', acceptance: 'on', minorPolicy: 'spec', verifier: 'on', preNominationChecks: 'off', seatRecords: 'off' };
export type DefaultsProfile = 'v0.5.375' | 'v0.5.378';
export const DEFAULTS_PROFILES: Readonly<Record<DefaultsProfile, Readonly<Switches>>> = { 'v0.5.375': DEFAULT_SWITCHES, 'v0.5.378': V378_DEFAULT_SWITCHES };
type SwitchHolder = { switches?: Partial<Switches>; switchDefaults?: DefaultsProfile; switchesFrozen?: unknown; tickets?: FanoutState['tickets'] };
/** #559 (ledger D1) — the default set an UNSET switch of `state` takes: the stamped one; else (not stamped — a state written before #559) `v0.5.378` once the run is frozen / has spawned, `v0.5.375` while it has not. */
export function defaultsProfileOf(state: SwitchHolder | null | undefined): DefaultsProfile {
  if (state?.switchDefaults) return state.switchDefaults;
  return state && (state.switchesFrozen || (state.tickets && firstSpawnSignal({ tickets: state.tickets } as FanoutState))) ? 'v0.5.378' : 'v0.5.375';
}
/** #559 — pin the defaults profile on the state BEFORE a writer touches it: an unspawned run gets the new one, a spawned one keeps v0.5.378. Idempotent. */
export function stampDefaults(state: FanoutState): FanoutState {
  return state.switchDefaults ? state : { ...state, switchDefaults: defaultsProfileOf(state) };
}
/** The switches in force for `state`: the stored ones over the defaults of its profile (a state that sets none = all defaults). The ONE reader — every gate / spawn / skill render goes through it. */
export function switchesOf(state: SwitchHolder | null | undefined): Switches {
  return { ...DEFAULTS_PROFILES[defaultsProfileOf(state)], ...(state?.switches ?? {}) };
}
/** #587 (I1) — is the `seatRecords` switch on for this run (plan + interfaces declared before the first spawn, #585)? */
export const seatRecordsOn = (s: SwitchHolder | null | undefined): boolean => switchesOf(s).seatRecords === 'on';
/** #559 (ledger D2) — where `name`'s value comes from: `explicit` (stored, and — for a v0.5.378 run — different from that profile's default), `default`, or `default-kept-v0.5.378` (a run that had spawned when the defaults changed). */
export function switchSourceOf(state: SwitchHolder, name: SwitchName): 'explicit' | 'default' | 'default-kept-v0.5.378' {
  const profile = defaultsProfileOf(state);
  const stored = state.switches?.[name];
  if (profile === 'v0.5.378') { // a V378 frozen set stores every key: only a changed one was chosen; one both profiles share (earlyGate) was not kept from anything
    if (stored !== undefined && stored !== V378_DEFAULT_SWITCHES[name]) return 'explicit';
    return V378_DEFAULT_SWITCHES[name] === DEFAULT_SWITCHES[name] ? 'default' : 'default-kept-v0.5.378';
  }
  return stored !== undefined ? 'explicit' : 'default';
}

const TOP_KEYS = new Set(['version', 'run', 'target', 'repo', 'harness', 'switches', 'switchDefaults', 'switchesFrozen', 'plan', 'decisions', 'loopPlan', 'planRefusal', 'tickets', 'updatedAt', 'reconciledAt']);
const TICKET_KEYS = new Set(['branch', 'pr', 'head', 'verdict', 'dependsOn', 'builtOn', 'frozenInterface', 'mergedAccepted', 'status', 'acceptance', 'spec', 'specText', 'implementer', 'verifier', 'accept', 'tree', 'builtOnTree', 'checks', 'findings', 'followUpOf', 'mergedHead', 'mergedTree', 'forgottenMerges', 'fixes', 'depsDeclared', 'iface', 'follows', 'review', 'start', 'updatedAt']);
TICKET_KEYS.add('reviews'); // #589 (I4)
TICKET_KEYS.add('parked'); // #603
TICKET_KEYS.add('rounds'); // #603
TOP_KEYS.add('choices'); // #603
TOP_KEYS.add('pause'); // #603
TOP_KEYS.add('waited'); // #655
TOP_KEYS.add('startFlaky'); // #654
TICKET_KEYS.add('ci'); // #607
/** The fields a `state set` may change (updatedAt is the writer's). `tree` / `builtOnTree` / `specText` are DERIVED (#512/#552): the CLI fills them, `state set --json` cannot. `forgetMerge` / `settle` / `decide` are verbs (#514/#552), not stored fields. */
export const SETTABLE_KEYS = ['branch', 'pr', 'head', 'verdict', 'dependsOn', 'builtOn', 'frozenInterface', 'mergedAccepted', 'status', 'findings', 'followUpOf', 'fixes', 'forgetMerge', 'settle', 'decide', 'spec', 'implementer', 'verifier'] as const;
export const DERIVED_KEYS = ['tree', 'builtOnTree'] as const;
/** #587 — the patch keys of the seatRecords rules (kept out of SETTABLE_KEYS so a `nothing to set` message stays as before): refused under seatRecords=off. */
export const SEAT_PATCH_KEYS = ['interface', 'interfaceReason', 'follows'] as const;
export type TicketPatch = Partial<Pick<TicketState, Exclude<(typeof SETTABLE_KEYS)[number], 'forgetMerge' | 'settle' | 'decide' | 'findings'> | (typeof DERIVED_KEYS)[number]>> & { forgetMerge?: string; findings?: Record<string, StoredFinding>; settle?: Record<string, { how: string; ref: string }>; decide?: Record<string, { text: string; by?: string }> };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_SHA = /^[0-9a-f]{7,40}$/;
const TREE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const SAFE_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/+@-]{0,199}$/;
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9._#:-]{0,63}$/;

export class FanoutStateError extends Error {}
/** #667 — the clone has no `user.email`: the start check's empty commit would be unverifiable, so the start is refused `[run-start-check-identity]`. */
export class StartCheckIdentityError extends FanoutStateError {}
/** #587 (I1) — a refusal of the `seatRecords` rules: the message STARTS with its name in brackets (`[plan-incomplete] …`), the CLI exits 2 on it (a plain FanoutStateError exits 1). */
export class SeatRefusal extends FanoutStateError {
  readonly refusal: string;
  constructor(refusal: string, detail: string) { super(`[${refusal}] ${detail}`); this.refusal = refusal; }
}

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

export function newState(run: string, opts: { target?: string; repo?: string | null; harness?: string | null; switches?: Partial<Switches>; now: string }): FanoutState {
  const base: FanoutState = { version: STATE_VERSION, run: assertRunId(run), target: opts.target ?? 'master', repo: opts.repo ?? null, ...withHarness(harnessOf(opts.harness ?? null)), switchDefaults: 'v0.5.375', tickets: {}, updatedAt: opts.now, reconciledAt: null }; // #559: a new run is born on the new defaults
  return opts.switches && Object.keys(opts.switches).length ? setSwitches(base, opts.switches, opts.now) : base; // #554: `init --switch` is the earliest moment to choose
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

// ── #587 (I2): the plan + the interfaces, declared before the first spawn (switch seatRecords) ─────────────────────
const IFACE_TEXT_MAX = 20_000;
export const DECISION_TEXT_MAX = 4_000;
/** Every brief of the run carries ALL the decisions: their number and total size are bounded (a refusal `[decisions-full]` names the bound). */
export const DECISIONS_MAX = 20;
export const DECISIONS_TOTAL_MAX = 16_000;
const seatOff = (what: string): SeatRefusal => new SeatRefusal('seat-records-off', `${what} is a seatRecords rule and this run has seatRecords=off (choose it before the first spawn: state set --switch seatRecords=on)`);
function ticketIdsOf(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((d) => typeof d !== 'string' || !SAFE_TICKET.test(d))) throw new FanoutStateError(`${where} must be a list of ticket ids`);
  return [...new Set(v as string[])];
}
function planOf(v: unknown): NonNullable<FanoutState['plan']> {
  if (!isObj(v)) throw new FanoutStateError('plan must be {tickets, declaredAt}');
  refuseUnknown(v, new Set(['tickets', 'declaredAt']), 'plan');
  const tickets = ticketIdsOf(v.tickets, 'plan.tickets');
  if (tickets.length === 0) throw new FanoutStateError('plan.tickets is empty');
  return { tickets, declaredAt: isoOf(v.declaredAt, 'plan.declaredAt') };
}
function loopPlanOf(v: unknown): NonNullable<FanoutState['loopPlan']> {
  if (!isObj(v)) throw new FanoutStateError('loopPlan must be {at, hash, attempts}');
  refuseUnknown(v, new Set(['at', 'hash', 'attempts']), 'loopPlan');
  if (typeof v.hash !== 'string' || !SHA256.test(v.hash)) throw new FanoutStateError('loopPlan.hash must be a sha256');
  if (!Number.isInteger(v.attempts) || (v.attempts as number) < 1) throw new FanoutStateError('loopPlan.attempts must be an integer ≥ 1');
  return { at: isoOf(v.at, 'loopPlan.at'), hash: v.hash, attempts: v.attempts as number };
}
function planRefusalOf(v: unknown): NonNullable<FanoutState['planRefusal']> {
  if (!isObj(v)) throw new FanoutStateError('planRefusal must be {at, code, detail}');
  refuseUnknown(v, new Set(['at', 'code', 'detail']), 'planRefusal');
  if (v.code !== 'plan-refused-twice' && v.code !== 'plan-apply-failed') throw new FanoutStateError('planRefusal.code must be plan-refused-twice|plan-apply-failed');
  if (typeof v.detail !== 'string' || !v.detail.trim()) throw new FanoutStateError('planRefusal.detail must be non-blank');
  return { at: isoOf(v.at, 'planRefusal.at'), code: v.code, detail: v.detail };
}
function ifaceOfStored(v: unknown, where: string): Iface | null {
  if (v === null) return null;
  if (!isObj(v)) throw new FanoutStateError(`${where}: iface must be {version, text, history}`);
  refuseUnknown(v, new Set(['version', 'text', 'history']), `${where} iface`);
  if (!Number.isInteger(v.version) || (v.version as number) < 1) throw new FanoutStateError(`${where}: iface.version must be an integer ≥ 1`);
  if (typeof v.text !== 'string' || !v.text.trim()) throw new FanoutStateError(`${where}: iface.text must be non-blank`);
  if (!Array.isArray(v.history) || v.history.length !== (v.version as number) - 1) throw new FanoutStateError(`${where}: iface.history must hold the ${(v.version as number) - 1} superseded version(s)`);
  const history = v.history.map((h, i): IfaceVersion => {
    if (!isObj(h)) throw new FanoutStateError(`${where}: iface.history[${i}] must be an object`);
    refuseUnknown(h, new Set(['version', 'text', 'reason', 'at']), `${where} iface.history[${i}]`);
    if (h.version !== i + 1) throw new FanoutStateError(`${where}: iface.history[${i}].version must be ${i + 1}`);
    if (typeof h.text !== 'string' || !h.text.trim()) throw new FanoutStateError(`${where}: iface.history[${i}].text must be non-blank`);
    if (h.reason !== null && (typeof h.reason !== 'string' || !h.reason.trim())) throw new FanoutStateError(`${where}: iface.history[${i}].reason must be a non-blank text or null`);
    return { version: h.version as number, text: h.text, reason: h.reason as string | null, at: isoOf(h.at, `${where} iface.history[${i}].at`) };
  });
  return { version: v.version as number, text: v.text, history };
}
function startOf(v: unknown, where: string): NonNullable<TicketState['start']> {
  if (!isObj(v)) throw new FanoutStateError(`${where}: start must be {at, kind, briefHash, briefs}`);
  refuseUnknown(v, new Set(['at', 'kind', 'briefHash', 'briefs']), `${where} start`);
  if (v.kind !== 'spawn' && v.kind !== 'respawn') throw new FanoutStateError(`${where}: start.kind must be spawn|respawn`);
  if (typeof v.briefHash !== 'string' || !SHA256.test(v.briefHash)) throw new FanoutStateError(`${where}: start.briefHash must be a sha256`);
  if (!Number.isInteger(v.briefs) || (v.briefs as number) < 1) throw new FanoutStateError(`${where}: start.briefs must be an integer ≥ 1`);
  return { at: isoOf(v.at, `${where} start.at`), kind: v.kind, briefHash: v.briefHash, briefs: v.briefs as number };
}
function followsOf(v: unknown, where: string): Record<string, number> {
  if (!isObj(v)) throw new FanoutStateError(`${where}: follows must be {<upstream ticket>: <interface version>}`);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!SAFE_TICKET.test(k)) throw new FanoutStateError(`${where}: follows: unsafe ticket id ${JSON.stringify(k)}`);
    if (!Number.isInteger(n) || (n as number) < 1) throw new FanoutStateError(`${where}: follows[${k}] must be an interface version (integer ≥ 1)`);
    out[k] = n as number;
  }
  return out;
}
/** `state set --plan <ids>` (declare: before the first spawn, replaces) / `--plan-add <ids>` (append: also after it). Pure; refused under seatRecords=off. */
export function setPlan(state: FanoutState, ids: string[], mode: 'declare' | 'add', now: string): FanoutState {
  const st = stampDefaults(state);
  if (!seatRecordsOn(st)) throw seatOff(mode === 'add' ? '--plan-add' : '--plan');
  const list = ticketIdsOf(ids, mode === 'add' ? '--plan-add' : '--plan');
  if (list.length === 0) throw new FanoutStateError(`${mode === 'add' ? '--plan-add' : '--plan'} needs at least one ticket id`);
  if (mode === 'declare') {
    const locked = st.plan ? switchesLockedWhy(st) : null;
    if (locked) throw new SeatRefusal('plan-frozen', `the plan of run ${st.run} is declared and the run already spawned (${locked}) — a ticket added later: state set --plan-add <id,…>`);
    return { ...st, plan: { tickets: list, declaredAt: now }, updatedAt: now };
  }
  return { ...st, plan: { tickets: [...new Set([...(st.plan?.tickets ?? []), ...list])], declaredAt: st.plan?.declaredAt ?? now }, updatedAt: now };
}
function decisionsOf(v: unknown): NonNullable<FanoutState['decisions']> {
  if (!Array.isArray(v) || v.length === 0) throw new FanoutStateError('decisions must be a non-empty list of {n, text, by, at}');
  return v.map((d, i) => {
    if (!isObj(d)) throw new FanoutStateError(`decisions[${i}] must be an object`);
    refuseUnknown(d, new Set(['n', 'text', 'by', 'at']), `decisions[${i}]`);
    if (d.n !== i + 1) throw new FanoutStateError(`decisions[${i}].n must be ${i + 1}`);
    if (typeof d.text !== 'string' || !d.text.trim()) throw new FanoutStateError(`decisions[${i}].text must be non-blank`);
    if (typeof d.by !== 'string' || !d.by.trim()) throw new FanoutStateError(`decisions[${i}].by must be non-empty`);
    return { n: i + 1, text: d.text, by: d.by, at: isoOf(d.at, `decisions[${i}].at`) };
  });
}
/** `state set --run-decision <text|file|->`: append one decision (numbered from 1, never edited). Pure; refused under seatRecords=off; a blank text → `[decision-blank]`. `by` = the recording workspace (the CLI proves it is the coordinator). */
export function addDecision(state: FanoutState, text: string, by: string, now: string): FanoutState {
  const st = stampDefaults(state);
  if (!seatRecordsOn(st)) throw seatOff('--run-decision');
  if (st.loopPlan) throw new SeatRefusal('decision-after-plan', `run ${st.run} has a plan of the loop (#604, ${st.loopPlan.at}): nothing writes a run decision after it — an order to wait cannot exist; what every seat needs is in the plan's interfaces`);
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) throw new SeatRefusal('decision-blank', 'the decision is blank — write what every seat of the run must know');
  if (t.length > DECISION_TEXT_MAX || CTRL.test(t)) throw new FanoutStateError(`a decision must be printable text of at most ${DECISION_TEXT_MAX} characters`);
  const list = st.decisions ?? [];
  if (list.length >= DECISIONS_MAX) throw new SeatRefusal('decisions-full', `the run already holds ${list.length} decisions (at most ${DECISIONS_MAX}): every brief carries them all — merge them into fewer, or start a new run`);
  const total = list.reduce((n, d) => n + d.text.length, 0);
  if (total + t.length > DECISIONS_TOTAL_MAX) throw new SeatRefusal('decisions-full', `the decisions would reach ${total + t.length} characters (at most ${DECISIONS_TOTAL_MAX} in all): every brief carries them all`);
  return { ...st, decisions: [...list, { n: list.length + 1, text: t, by, at: now }], updatedAt: now };
}
/** #587 (I2) — what stands between the run and its first spawn / a `started|nominated|gated` ticket: the plan tickets absent from the state, the tickets (not dropped) whose dependencies are not declared, the depended-on tickets with no interface. [] = nothing missing. */
export function planMissing(state: FanoutState): string[] {
  const out: string[] = [];
  if (!state.plan) out.push('no plan declared — state set --plan <id,id,…> (every ticket of the run)');
  else for (const id of state.plan.tickets) if (!state.tickets[id]) out.push(`${id}: in the plan but not in the state — state set ${id} --depends-on <a,b|none>`);
  const live = Object.entries(state.tickets).filter(([, t]) => t.status !== 'dropped');
  for (const [id, t] of live) if (t.depsDeclared !== true) out.push(`${id}: dependencies not declared — state set ${id} --depends-on <a,b|none>`);
  const needed = new Map<string, string[]>();
  for (const [id, t] of live) for (const d of t.dependsOn) if (!state.tickets[d]?.iface) needed.set(d, [...(needed.get(d) ?? []), id]);
  for (const [d, by] of needed) out.push(`${d}: ${by.join(', ')} depend${by.length === 1 ? 's' : ''} on it but it has no interface — state set ${d} --interface <text|file|->`);
  return out;
}
/** #587 (I2) — the current interface of ticket `id` (null = none, or no such ticket). */
export const interfaceOf = (state: FanoutState, id: string): TicketState['iface'] => state.tickets[id]?.iface ?? null;
/** #587 — the tickets that can be started now: todo, with the plan complete (which means their dependencies are declared and each dependency holds an interface — a held interface is what a dependent starts against). */
export function readyTickets(state: FanoutState): string[] {
  if (planMissing(state).length) return [];
  return Object.entries(state.tickets).filter(([, t]) => t.status === 'todo').map(([id]) => id);
}
/** The reasons of the changes a dependent that follows `v` of an interface has not seen: `v1→v2: <reason>; v2→v3: …`. */
function ifaceChanges(f: Iface, v: number): string {
  return f.history.filter((h) => h.version >= v).map((h) => `v${h.version}→v${h.version + 1}: ${h.reason ?? '(no reason recorded)'}`).join('; ');
}

/** #554 — a switch value: the NAME and the VALUE are each checked against the closed table; anything else is refused naming what is allowed. */
function switchValueOf(name: string, v: unknown): Switches[SwitchName] {
  if (!(SWITCH_NAMES as string[]).includes(name)) throw new FanoutStateError(`unknown switch ${JSON.stringify(name)} (switches: ${SWITCH_NAMES.map((n) => `${n}=${SWITCH_VALUES[n].join('|')}`).join(', ')})`);
  const allowed = SWITCH_VALUES[name as SwitchName] as readonly string[];
  if (typeof v !== 'string' || !allowed.includes(v)) throw new FanoutStateError(`switch ${name} must be ${allowed.join('|')} (got ${JSON.stringify(v)})`);
  return v as Switches[SwitchName];
}
/** A stored `switches` object: every key known, every value in its table; a missing one stays missing (= the profile's default, #559). */
function switchesParse(v: unknown): Partial<Switches> {
  if (!isObj(v)) throw new FanoutStateError(`switches must be an object {${SWITCH_NAMES.join(', ')}}`);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = switchValueOf(k, val);
  return out as Partial<Switches>;
}
function switchDefaultsOf(v: unknown): DefaultsProfile {
  if (v !== 'v0.5.375' && v !== 'v0.5.378') throw new FanoutStateError(`switchDefaults must be "v0.5.375" or "v0.5.378" (got ${JSON.stringify(v)})`);
  return v;
}
function switchesFrozenOf(v: unknown): { at: string; by: string } {
  if (!isObj(v)) throw new FanoutStateError('switchesFrozen must be {at, by}');
  refuseUnknown(v, new Set(['at', 'by']), 'switchesFrozen');
  if (typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at)) || typeof v.by !== 'string' || !v.by.trim()) throw new FanoutStateError('switchesFrozen needs {at: ISO date, by: non-empty string}');
  return { at: v.at, by: v.by };
}
/** `earlyGate=off,acceptance=on` (the CLI's `--switch`) → a partial switches object. Unknown name / unknown value / a name twice / an empty list: refused. */
export function parseSwitchAssignments(arg: string): Partial<Switches> {
  const out: Record<string, unknown> = {};
  const parts = arg.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) throw new FanoutStateError(`--switch expects <name>=<value>[,…] (${SWITCH_NAMES.map((n) => `${n}=${SWITCH_VALUES[n].join('|')}`).join(', ')})`);
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i < 1) throw new FanoutStateError(`--switch expects <name>=<value> (got ${JSON.stringify(part)}; ${SWITCH_NAMES.map((n) => `${n}=${SWITCH_VALUES[n].join('|')}`).join(', ')})`);
    const name = part.slice(0, i);
    if (name in out) throw new FanoutStateError(`switch ${name} given twice`);
    out[name] = switchValueOf(name, part.slice(i + 1));
  }
  return out as Partial<Switches>;
}
/** #554 (ledger D1) — the first-spawn detector: the STATE-side signal, the one every CLI verb can read. A run has spawned once a ticket is past `todo` (started|nominated|gated|merged),
 *  or an implementer / verifier workspace id or a `accept-` writer is recorded. null = nothing spawned yet. (An agent spawned by hand and not yet recorded in the state is not seen: set the switches BEFORE the first spawn.) */
export function firstSpawnSignal(state: FanoutState): string | null {
  for (const [id, t] of Object.entries(state.tickets)) {
    if (t.status === 'started' || t.status === 'nominated' || t.status === 'gated' || t.status === 'merged') return `ticket ${id} is ${t.status}`;
    if (t.implementer) return `ticket ${id} has an implementer (${t.implementer})`;
    if (t.verifier) return `ticket ${id} has a verifier (${t.verifier})`;
    if (t.accept?.acceptor) return `ticket ${id} has an acceptance writer (${t.accept.acceptor.name})`;
  }
  return null;
}
/** Record the freeze at the first spawn; a no-op once frozen or while nothing has spawned. Applied by every state writer a spawn goes through (applyTicketPatch, claimAcceptor).
 *  A run that set nothing persists NOTHING (the lock is recomputed from the tickets by `switchesLockedWhy`); one that set a switch keeps its explicit values and gains the record. */
export function freezeAtFirstSpawn(state: FanoutState, now: string): FanoutState {
  if (state.switchesFrozen) return state;
  const signal = firstSpawnSignal(state);
  if (!signal) return state;
  if (!state.switches || Object.keys(state.switches).length === 0) return state;
  return { ...state, switchesFrozen: { at: now, by: `first spawn of the run: ${signal}` } };
}
/** Why the switches cannot change now (null = they can): frozen on record, or the run already spawned (a state older than #554 has no record). */
export function switchesLockedWhy(state: FanoutState): string | null {
  if (state.switchesFrozen) return `frozen ${state.switchesFrozen.at} (${state.switchesFrozen.by})`;
  const signal = firstSpawnSignal(state);
  return signal ? `the run already spawned (${signal})` : null;
}
/** `state set --switch …` / `state init --switch …`: pure. Refused after the first spawn (whatever the value, even an unchanged one) and for an unknown name / value.
 *  #559: stores the EXPLICIT values only (one equal to the default is still explicit), after stamping the defaults profile. */
export function setSwitches(state: FanoutState, assign: Partial<Switches>, now: string): FanoutState {
  for (const [k, v] of Object.entries(assign)) switchValueOf(k, v);
  const locked = switchesLockedWhy(state);
  if (locked) throw new FanoutStateError(`the switches of run ${state.run} cannot change: ${locked} — a switch is fixed for the run from its first spawn (start a new run to change one)`);
  const { switches: prev, ...rest } = stampDefaults(state);
  return { ...rest, switches: { ...(prev ?? {}), ...assign }, updatedAt: now };
}
/** #554 — the switches in force for run `run` under `home`: the state file's, or the defaults when there is none / it cannot be read (a skill render must never fail an install). */
export function switchesForRun(home: string, run: string): Switches {
  try { return switchesOf(readState(stateFile(home, run))); } catch { return { ...DEFAULT_SWITCHES }; }
}
/** The stamp value of an install: the hook bundle version, plus the run's switches when any is off its default (so a default run keeps the plain version and a switch flip forces ONE re-render). */
export function switchesStamp(version: string, sw: Switches): string {
  const diff = SWITCH_NAMES.filter((n) => sw[n] !== undefined && sw[n] !== DEFAULT_SWITCHES[n]).map((n) => `${n}=${sw[n]}`);
  return diff.length ? `${version}+sw:${diff.join(',')}` : version;
}
/** One line for `state show`: each switch's value in force and where it comes from (#559), then whether they can still change. */
export function switchesLine(state: FanoutState): string {
  const sw = switchesOf(state);
  const locked = switchesLockedWhy(state);
  const label = (n: SwitchName): string => { const src = switchSourceOf(state, n); return src === 'default-kept-v0.5.378' ? 'default kept from v0.5.378 (run started before the defaults change)' : src; };
  const shown = SWITCH_NAMES.filter((n) => n !== 'seatRecords' || sw[n] !== 'off' || switchSourceOf(state, n) !== 'default'); // #587: seatRecords is listed once it is on or chosen — a default run's line stays byte-identical to master
  return `switches (#554, #559, #563): ${shown.map((n) => `${n}=${sw[n]} (${label(n)})`).join(' · ')} — ${locked ? locked : 'not frozen yet: changeable until the first spawn (state set --switch <name>=<value>)'}`;
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
const FINDING_KEYS = new Set(['severity', 'evidence', 'kind', 'specSentence', 'demonstration', 'report', 'decision', 'settled']);
for (const k of ['by', 'text', 'raisedOn', 'fixedBy', 'onChoice']) FINDING_KEYS.add(k); // #589 (I4), #641
/** #572 — a stored / patched demonstration: SHAPE only (strings, printable, bounded). A blank / short / missing field is NOT an error here: it is recorded with its refusal reason (`classifyDemonstration`). */
function demonstrationOf(v: unknown, where: string): Demonstration {
  if (!isObj(v)) throw new FanoutStateError(`${where}.demonstration must be {${DEMONSTRATION_FIELDS.join(', ')}}`);
  refuseUnknown(v, new Set([...DEMONSTRATION_FIELDS, 'file', 'head', 'refusal']), `${where}.demonstration`);
  const text = (k: string): string => {
    const x = v[k];
    if (x === undefined || x === null) return '';
    if (typeof x !== 'string') throw new FanoutStateError(`${where}.demonstration.${k} must be a text`);
    if (x.length > DEMONSTRATION_TEXT_MAX || CTRL.test(x)) throw new FanoutStateError(`${where}.demonstration.${k} must be printable text of at most ${DEMONSTRATION_TEXT_MAX} characters`);
    return x;
  };
  const out: Demonstration = { input: text('input'), observed: text('observed'), expected: text('expected') };
  for (const k of ['file', 'head', 'refusal'] as const) if (v[k] !== undefined) out[k] = lineOf(v[k], `${where}.demonstration.${k}`, 500);
  return out;
}
/** Parse ONE stored finding: the legacy string `BLOCKING|MAJOR|MINOR` or the normalized record (unknown key refused, every field shape-checked). Always returns the record form. */
export function findingOf(v: unknown, where: string): FindingRecord {
  if (typeof v === 'string') return { severity: enumOf(v, FINDING_SEVERITIES, where) };
  if (!isObj(v)) throw new FanoutStateError(`${where} must be BLOCKING|MAJOR|MINOR or a finding record {severity, evidence?, kind?, specSentence?, demonstration?, report?, decision?, settled?}`);
  refuseUnknown(v, FINDING_KEYS, where);
  const out: FindingRecord = { severity: enumOf(v.severity, FINDING_SEVERITIES, `${where}.severity`) };
  if (v.evidence !== undefined) out.evidence = enumOf(v.evidence, FINDING_EVIDENCE, `${where}.evidence`);
  if (v.kind !== undefined) out.kind = enumOf(v.kind, FINDING_KINDS, `${where}.kind`);
  if (v.specSentence !== undefined) out.specSentence = specSentenceOf(v.specSentence, where);
  if (v.demonstration !== undefined) out.demonstration = demonstrationOf(v.demonstration, where);
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
  // #589 (I4): the reviewer's own record (parsed always — a stored state holds them; the patch path refuses them off-switch, `assertPatchSource`)
  if (v.by !== undefined) out.by = lineOf(v.by, `${where}.by`, 200);
  if (v.text !== undefined) out.text = lineOf(v.text, `${where}.text`);
  if (v.raisedOn !== undefined) { if (typeof v.raisedOn !== 'string' || !HEX_SHA.test(v.raisedOn)) throw new FanoutStateError(`${where}.raisedOn must be a 7-40 lowercase hex sha`); out.raisedOn = v.raisedOn; }
  if (v.fixedBy !== undefined) {
    if (!isObj(v.fixedBy)) throw new FanoutStateError(`${where}.fixedBy must be {by, head, at}`);
    refuseUnknown(v.fixedBy, new Set(['by', 'head', 'at']), `${where}.fixedBy`);
    if (typeof v.fixedBy.head !== 'string' || !HEX_SHA.test(v.fixedBy.head)) throw new FanoutStateError(`${where}.fixedBy.head must be a 7-40 lowercase hex sha`);
    out.fixedBy = { by: lineOf(v.fixedBy.by, `${where}.fixedBy.by`, 200), head: v.fixedBy.head, at: isoOf(v.fixedBy.at, `${where}.fixedBy.at`) };
  }
  if (v.onChoice !== undefined) { if (typeof v.onChoice !== 'number' || !Number.isInteger(v.onChoice) || v.onChoice < 1) throw new FanoutStateError(`${where}.onChoice must be a choice number (1, 2, …)`); out.onChoice = v.onChoice; }
  return out;
}
/** #589 (I4) — the stored `reviews`: every field shape-checked, `n` strictly increasing from 1. */
function ciRecordOf(v: unknown, where: string): CiRecord {
  const at = `${where}: ci`;
  if (!isObj(v)) throw new FanoutStateError(`${at} must be an object`);
  refuseUnknown(v, new Set(['head', 'rerun', 'told', 'reruns', 'seen', 'tells', 'flaky', 'env']), at);
  if (typeof v.head !== 'string' || !HEX_SHA.test(v.head)) throw new FanoutStateError(`${at}.head must be a 7-40 lowercase hex sha`);
  const names = (x: unknown, k: string): string[] => { if (!Array.isArray(x) || x.some((d) => typeof d !== 'string' || !d.trim() || d.length > 200 || CTRL.test(d))) throw new FanoutStateError(`${at}.${k} must be an array of check names`); return x as string[]; };
  let rerun: CiRecord['rerun'] = null;
  if (v.rerun !== null && v.rerun !== undefined) {
    if (!isObj(v.rerun)) throw new FanoutStateError(`${at}.rerun must be an object or null`);
    refuseUnknown(v.rerun, new Set(['at', 'names', 'jobs']), `${at}.rerun`);
    const jobs: Record<string, string> = {};
    if (v.rerun.jobs !== undefined) {
      if (!isObj(v.rerun.jobs)) throw new FanoutStateError(`${at}.rerun.jobs must be {check: jobId}`);
      for (const [k, j] of Object.entries(v.rerun.jobs)) { if (typeof j !== 'string' || !j) throw new FanoutStateError(`${at}.rerun.jobs[${k}] must be a job id`); jobs[k] = j; }
    }
    rerun = { at: isoOf(v.rerun.at, `${at}.rerun.at`), names: names(v.rerun.names, 'rerun.names'), jobs };
  }
  let told: CiRecord['told'] = null;
  if (v.told !== null && v.told !== undefined) {
    if (!isObj(v.told)) throw new FanoutStateError(`${at}.told must be an object or null`);
    refuseUnknown(v.told, new Set(['at', 'names']), `${at}.told`);
    told = { at: isoOf(v.told.at, `${at}.told.at`), names: names(v.told.names, 'told.names') };
  }
  if (v.reruns !== undefined && (!Number.isInteger(v.reruns) || (v.reruns as number) < 0)) throw new FanoutStateError(`${at}.reruns must be a count`);
  const tells: Record<string, number> = {};
  if (v.tells !== undefined) {
    if (!isObj(v.tells)) throw new FanoutStateError(`${at}.tells must be {names: count}`);
    for (const [k, n] of Object.entries(v.tells)) { if (!Number.isInteger(n) || (n as number) < 0) throw new FanoutStateError(`${at}.tells[${k}] must be a count`); tells[k] = n as number; }
  }
  if (v.env !== undefined && !Array.isArray(v.env)) throw new FanoutStateError(`${at}.env must be an array`);
  const env = ((v.env ?? []) as unknown[]).map((e, i) => {
    if (!isObj(e)) throw new FanoutStateError(`${at}.env[${i}] must be an object`);
    refuseUnknown(e, new Set(['name', 'job', 'reran']), `${at}.env[${i}]`);
    if (typeof e.name !== 'string' || !e.name.trim() || CTRL.test(e.name)) throw new FanoutStateError(`${at}.env[${i}].name must be a check name`);
    if (e.job !== null && (typeof e.job !== 'string' || !e.job)) throw new FanoutStateError(`${at}.env[${i}].job must be a job id or null`);
    return { name: e.name, job: e.job as string | null, reran: e.reran === true };
  });
  return { head: v.head, rerun, told, reruns: (v.reruns as number | undefined) ?? 0, seen: names(v.seen ?? [], 'seen'), tells, flaky: names(v.flaky ?? [], 'flaky'), env };
}

function criteriaOf(v: unknown, where: string): Record<string, 'met' | 'unmet'> {
  if (!isObj(v)) throw new FanoutStateError(`${where} must be {"<n>":"met|unmet"}`);
  const out: Record<string, 'met' | 'unmet'> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!/^[1-9][0-9]{0,3}$/.test(k) || (x !== 'met' && x !== 'unmet')) throw new FanoutStateError(`${where} must be {"<n>":"met|unmet"} (got ${JSON.stringify(k)}: ${JSON.stringify(x)})`);
    out[k] = x;
  }
  return out;
}
function reviewsOf(v: unknown, where: string): ReviewEntry[] {
  if (!Array.isArray(v)) throw new FanoutStateError(`${where}: reviews must be an array`);
  return v.map((e, i) => {
    const at = `${where}: reviews[${i}]`;
    if (!isObj(e)) throw new FanoutStateError(`${at} must be an object`);
    refuseUnknown(e, new Set(['n', 'reviewer', 'head', 'tree', 'verdict', 'findings', 'closed', 'at', 'criteria']), at);
    if (!Number.isInteger(e.n) || (e.n as number) !== i + 1) throw new FanoutStateError(`${at}.n must be ${i + 1} (reviews are numbered 1.. in order)`);
    if (typeof e.head !== 'string' || !HEX_SHA.test(e.head)) throw new FanoutStateError(`${at}.head must be a 7-40 lowercase hex sha`);
    const ids = (x: unknown, k: string): string[] => { if (!Array.isArray(x) || x.some((d) => typeof d !== 'string' || !FINDING_ID.test(d))) throw new FanoutStateError(`${at}.${k} must be an array of finding ids`); return x as string[]; };
    return { n: e.n as number, reviewer: lineOf(e.reviewer, `${at}.reviewer`, 200), head: e.head, tree: treeOrNull(e.tree, `${at}.tree`), verdict: enumOf(e.verdict, ['approve', 'changes-requested'] as const, `${at}.verdict`), findings: ids(e.findings, 'findings'), closed: ids(e.closed, 'closed'), at: isoOf(e.at, `${at}.at`), ...(e.criteria !== undefined ? { criteria: criteriaOf(e.criteria, `${at}.criteria`) } : {}) };
  });
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
/** #564 — the stored check records: {<tree>: {tree, head, at, vacuous, ok, results[]}}; the key IS the record's tree, `ok` must equal what the results say (a hand-edited pass is refused). */
function checkRecordsOf(v: unknown, where: string): Record<string, CheckRecord> {
  if (!isObj(v)) throw new FanoutStateError(`${where}: checks must be an object {<tree sha>: record}`);
  const out: Record<string, CheckRecord> = {};
  for (const [tree, r] of Object.entries(v)) {
    const at = `${where}: checks[${tree.slice(0, 8)}]`;
    if (!TREE_SHA.test(tree) || !isObj(r)) throw new FanoutStateError(`${at} must be keyed by a full git tree sha and hold an object`);
    refuseUnknown(r, new Set(['tree', 'head', 'at', 'source', 'vacuous', 'nothingFound', 'changed', 'ok', 'results', 'uncovered', 'overrideChanged']), at);
    if (r.tree !== tree || typeof r.head !== 'string' || !HEX_SHA.test(r.head) || typeof r.at !== 'string' || (r.source !== 'override' && r.source !== 'discovered') || typeof r.vacuous !== 'boolean' || typeof r.nothingFound !== 'boolean' || !Number.isInteger(r.changed) || !Array.isArray(r.uncovered) || r.uncovered.some((u) => typeof u !== 'string') || typeof r.overrideChanged !== 'boolean' || typeof r.ok !== 'boolean' || !Array.isArray(r.results)) throw new FanoutStateError(`${at} needs {tree (= its key), head, at, source (override|discovered), vacuous, nothingFound, changed, uncovered[], overrideChanged, ok, results[]}`);
    const results = r.results.map((x, i) => {
      if (!isObj(x)) throw new FanoutStateError(`${at}.results[${i}] must be an object`);
      refuseUnknown(x, new Set(['run', 'cwd', 'exit', 'timedOut', 'durationMs', 'tail', 'from']), `${at}.results[${i}]`);
      if (typeof x.run !== 'string' || typeof x.cwd !== 'string' || !(x.exit === null || Number.isInteger(x.exit)) || typeof x.timedOut !== 'boolean' || typeof x.durationMs !== 'number' || typeof x.tail !== 'string' || (x.from !== undefined && typeof x.from !== 'string')) throw new FanoutStateError(`${at}.results[${i}] needs {run, cwd, exit (int|null), timedOut, durationMs, tail}`);
      return { run: x.run, cwd: x.cwd, exit: x.exit as number | null, timedOut: x.timedOut, durationMs: x.durationMs, tail: x.tail, ...(x.from !== undefined ? { from: x.from as string } : {}) };
    });
    const ok = !r.nothingFound && results.every((x) => x.exit === 0 && !x.timedOut);
    if (r.ok !== ok || r.vacuous !== (results.length === 0 && !r.nothingFound) || (r.nothingFound && results.length > 0)) throw new FanoutStateError(`${at}: ok / vacuous / nothingFound do not match its results`);
    out[tree] = { tree, head: r.head, at: r.at, source: r.source, vacuous: r.vacuous, nothingFound: r.nothingFound, changed: r.changed as number, uncovered: r.uncovered as string[], overrideChanged: r.overrideChanged, ok, results };
  }
  return out;
}
/** #564 — `orchestra fanout check`: record a run of the pre-nomination checks on ticket `id` (creates the ticket as `todo` when new). Pure; the record is keyed by its own tree. */
export function recordChecks(state: FanoutState, id: string, rec: CheckRecord, now: string): FanoutState {
  if (!SAFE_TICKET.test(id)) throw new FanoutStateError(`unsafe ticket id ${JSON.stringify(id)}`);
  if (!TREE_SHA.test(rec.tree)) throw new FanoutStateError('a check record needs the full git tree sha of the head');
  const prev = state.tickets[id] ?? blankTicket(now);
  return { ...state, tickets: { ...state.tickets, [id]: { ...prev, checks: withRecord(prev.checks ?? {}, rec), updatedAt: now } }, updatedAt: now };
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
/** #588 — a ticket's review record: the reviewer slot + the briefs sent (each `hash` is the sha256 of its `text`; a mismatch is a corrupt state). */
function reviewOf(v: unknown, where: string): ReviewRecord {
  if (!isObj(v)) throw new FanoutStateError(`${where}: review must be an object`);
  refuseUnknown(v, new Set(['reviewer', 'head', 'base', 'briefs']), `${where} review`);
  const iso = (x: unknown, n: string): string => { if (typeof x !== 'string' || Number.isNaN(Date.parse(x))) throw new FanoutStateError(`${where}: ${n} must be an ISO date`); return x; };
  let reviewer: ReviewRecord['reviewer'] = null;
  if (v.reviewer !== undefined && v.reviewer !== null) {
    const r = v.reviewer;
    if (!isObj(r)) throw new FanoutStateError(`${where}: review.reviewer must be an object or null`);
    refuseUnknown(r, new Set(['id', 'name', 'at', 'error']), `${where} review.reviewer`);
    if (typeof r.name !== 'string' || !r.name.trim()) throw new FanoutStateError(`${where}: review.reviewer.name missing`);
    reviewer = { id: wsIdOf(r.id, 'review.reviewer.id'), name: r.name, at: iso(r.at, 'review.reviewer.at'), ...(typeof r.error === 'string' && r.error ? { error: r.error.slice(0, 500) } : {}) };
  }
  const sha = (x: unknown, n: string): string | null => { const s = strOrNull(x, n); if (s !== null && !HEX_SHA.test(s)) throw new FanoutStateError(`${where}: ${n} must be 7-40 lowercase hex`); return s; };
  if (v.briefs !== undefined && !Array.isArray(v.briefs)) throw new FanoutStateError(`${where}: review.briefs must be an array`);
  const briefs = ((v.briefs as unknown[] | undefined) ?? []).map((b, i): ReviewBrief => {
    if (!isObj(b)) throw new FanoutStateError(`${where}: review.briefs[${i}] must be an object`);
    refuseUnknown(b, new Set(['n', 'kind', 'head', 'base', 'hash', 'text', 'reviewer', 'at']), `${where} review.briefs[${i}]`);
    if (b.n !== i + 1) throw new FanoutStateError(`${where}: review.briefs[${i}].n must be ${i + 1}`);
    const kind = enumOf(b.kind, ['spawn', 'wake', 'replace'] as const, `review.briefs[${i}].kind`);
    const head = sha(b.head, 'review.briefs.head');
    if (!head) throw new FanoutStateError(`${where}: review.briefs[${i}].head missing`);
    if (typeof b.hash !== 'string' || !/^[0-9a-f]{64}$/.test(b.hash)) throw new FanoutStateError(`${where}: review.briefs[${i}].hash must be a sha256 hex`);
    if (typeof b.text !== 'string' || !b.text) throw new FanoutStateError(`${where}: review.briefs[${i}].text missing`);
    return { n: b.n, kind, head, base: sha(b.base, 'review.briefs.base'), hash: b.hash, text: b.text, reviewer: wsIdOf(b.reviewer, 'review.briefs.reviewer'), at: iso(b.at, 'review.briefs.at') };
  });
  return { reviewer, head: sha(v.head, 'review.head'), base: sha(v.base, 'review.base'), briefs };
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
      ...(t.depsDeclared === true ? { depsDeclared: true as const } : t.depsDeclared === undefined || t.depsDeclared === false ? {} : (() => { throw new FanoutStateError(`ticket ${id}: depsDeclared must be a boolean`); })()),
      ...(t.iface !== undefined ? { iface: ifaceOfStored(t.iface, `ticket ${id}`) } : {}),
      ...(t.follows !== undefined ? { follows: followsOf(t.follows, `ticket ${id}`) } : {}),
      ...(t.start !== undefined ? { start: startOf(t.start, `ticket ${id}`) } : {}),
      ...(t.checks !== undefined ? { checks: checkRecordsOf(t.checks, `ticket ${id}`) } : {}),
      ...(t.review !== undefined ? { review: reviewOf(t.review, `ticket ${id}`) } : {}),
      ...(t.reviews !== undefined ? { reviews: reviewsOf(t.reviews, `ticket ${id}`) } : {}), // #589 (I4)
      ...(t.parked !== undefined ? { parked: parkOf(t.parked, `ticket ${id}`) } : {}), // #603
      ...(t.rounds !== undefined ? { rounds: roundsOf(t.rounds, `ticket ${id}`) } : {}), // #603
      ...(t.ci !== undefined ? { ci: ciRecordOf(t.ci, `ticket ${id}`) } : {}), // #607
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : String(raw.updatedAt),
    };
  }
  const state: FanoutState = {
    version: STATE_VERSION,
    run: assertRunId(raw.run),
    target: raw.target,
    repo: strOrNull(raw.repo, 'repo'),
    ...withHarness(harnessOf(raw.harness)),
    ...(raw.switches !== undefined ? { switches: switchesParse(raw.switches) } : {}),
    ...(raw.switchDefaults !== undefined ? { switchDefaults: switchDefaultsOf(raw.switchDefaults) } : {}),
    ...(raw.switchesFrozen !== undefined ? { switchesFrozen: switchesFrozenOf(raw.switchesFrozen) } : {}),
    ...(raw.plan !== undefined ? { plan: planOf(raw.plan) } : {}),
    ...(raw.decisions !== undefined ? { decisions: decisionsOf(raw.decisions) } : {}),
    ...(raw.choices !== undefined ? { choices: choicesOf(raw.choices) } : {}), // #603
    ...(raw.pause !== undefined ? { pause: pauseOf(raw.pause) } : {}), // #603
    ...(raw.waited !== undefined ? { waited: waitedOf(raw.waited) } : {}), // #655
    ...(raw.startFlaky !== undefined ? { startFlaky: startFlakyOf(raw.startFlaky) } : {}), // #654
    ...(raw.loopPlan !== undefined ? { loopPlan: loopPlanOf(raw.loopPlan) } : {}),
    ...(raw.planRefusal !== undefined ? { planRefusal: planRefusalOf(raw.planRefusal) } : {}),
    tickets,
    updatedAt: raw.updatedAt,
    reconciledAt: typeof raw.reconciledAt === 'string' ? raw.reconciledAt : null,
  };
  assertAcyclic(state);
  assertParkedCoherent(state); // #603
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
  if (switchesOf(state).earlyGate === 'off') return { kind: 'ineligible', why: `${up} is ${u.status}, not merged (earlyGate=off for this run: a dependent waits for its upstream's MERGE)` }; // #554: no candidate is admissible, only the merge
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
    if (upstreamMerged(state, u)) return builtOn && head && switchesOf(state).earlyGate === 'on' && !sameContent(builtOn, t.builtOnTree[u], head, ut?.tree) ? { id: u, state: 'changed' as const, builtOn, head, why: `built on ${u}@${builtOn.slice(0, 8)} but ${u} merged at ${head.slice(0, 8)}` } : { id: u, state: 'merged' as const, builtOn, head };
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

// ── #552 — the MINOR policy. The switches themselves (storage, freeze, `switchesOf`) are #554's, above; these aliases keep #552's names. ──
export type MinorPolicy = Switches['minorPolicy'];
export type FanoutSwitches = Switches;
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
/** Is the finding closed: settled (fixed / pr-body), decided by the coordinator, or about a recorded choice (#641). */
export const findingClosed = (f: FindingRecord): boolean => !!f.settled || !!f.decision || f.onChoice !== undefined; // #641: a finding on a recorded choice never blocks
/** #572 — the finding's demonstration is ACCEPTED (re-checked wherever it is acted on: a hand-edited state cannot smuggle one in). */
export const findingDemonstrated = (f: FindingRecord): boolean => demonstrationAccepted(f.demonstration);
/**
 * #552 — a MINOR with an accepted specSentence, not settled and not decided, BLOCKS the merge under `minorPolicy: spec` (like a MAJOR): the ids, per ticket `id`.
 * #572 — under `minorPolicy: demonstrated` a finding of ANY severity with an accepted demonstration blocks the same way (BLOCKING / MAJOR without one: as today — the review verdict carries them).
 * A merged ticket is not blocked (a finding raised after the merge goes through a follow-up). `process` findings block too — their way out is the PR-body edit (`settled.how = pr-body`), not a code round.
 */
export function blockingMinors(state: FanoutState, id: string): string[] {
  const t = state.tickets[id];
  const policy = switchesOf(state).minorPolicy;
  if (!t || (policy !== 'spec' && policy !== 'demonstrated') || t.status === 'merged' || t.mergedHead) return [];
  const holds = (f: FindingRecord): boolean => (policy === 'demonstrated' ? findingDemonstrated(f) : f.severity === 'MINOR' && sentenceAccepted(effectiveSpec(state, t), f));
  return Object.entries(t.findings).filter(([, f]) => holds(f) && !findingClosed(f)).map(([k]) => k);
}
const oneLineOf = (s: string, n: number): string => s.replace(/\s+/g, ' ').trim().slice(0, n);
export function mergeBlockRefusal(state: FanoutState, id: string): FollowUpRefusal | null {
  const ids = blockingMinors(state, id);
  if (ids.length === 0) return null;
  const t = state.tickets[id];
  const how = (k: string): string => (t.findings[k].kind === 'process' ? `edit the PR body, then state set ${id} --settle ${k}=pr-body:<what it says now>` : `fix it, then state set ${id} --settle ${k}=fixed:<head>`);
  if (switchesOf(state).minorPolicy === 'demonstrated') {
    const said = (k: string): string => { const f = t.findings[k]; return `${k} (${f.severity}${f.kind === 'process' ? ', process' : ''}: “${oneLineOf(f.demonstration!.input, 70)}” → ${f.demonstration!.file})`; };
    return { reason: 'finding-unsettled', detail: `${id}: ${ids.length} finding(s) carry an accepted demonstration (input / observed file:line / expected) and are neither settled nor decided: ${ids.map(said).join('; ')} — ${ids.map(how).join('; ')}; or the coordinator records a decision: state set ${id} --decide <finding>=<text>. (${DEMONSTRATION_LIMIT})` };
  }
  return { reason: 'finding-unsettled', detail: `${id}: ${ids.length} MINOR finding(s) break a sentence of the ticket's spec and are neither settled nor decided: ${ids.map((k) => `${k} (“${t.findings[k].specSentence!.replace(/\s+/g, ' ').slice(0, 80)}”${t.findings[k].kind === 'process' ? ', process' : ''})`).join('; ')} — ${ids.map(how).join('; ')}; or the coordinator records a decision: state set ${id} --decide <finding>=<text>. (Code checks the sentence is in the spec, not that it is really broken: the reviewer judges that.)` };
}
/** #572 — every finding of `ticket` that carries an accepted demonstration, with how it ENDED: `fixed` (settled, ref = the head), `pr-body`, `decided` (text), or `open`. */
export interface DemonstratedEnd { finding: string; severity: FindingSeverity; end: 'fixed' | 'pr-body' | 'decided' | 'open'; ref?: string; file: string; head: string; input: string }
export function demonstratedFindings(t: TicketState): DemonstratedEnd[] {
  return Object.entries(t.findings).filter(([, f]) => findingDemonstrated(f)).map(([k, f]) => ({ finding: k, severity: f.severity, end: f.settled ? f.settled.how : f.decision ? 'decided' : 'open', ...(f.settled ? { ref: f.settled.ref } : f.decision ? { ref: f.decision.text } : {}), file: f.demonstration!.file!, head: f.demonstration!.head!, input: f.demonstration!.input }));
}
/** #572 — the demonstrations code REFUSED (recorded with the reason): the finding stayed a plain finding. */
export function refusedDemonstrations(t: TicketState): Array<{ finding: string; refusal: string }> {
  return Object.entries(t.findings).filter(([, f]) => f.demonstration && !findingDemonstrated(f)).map(([k, f]) => ({ finding: k, refusal: f.demonstration!.refusal ?? 'not checked (no file / head recorded)' }));
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
  if (policy === 'legacy' || policy === 'demonstrated') return null; // #554: legacy = before #514, follow-ups unrestricted; #572: demonstrated keeps them (a demonstrated finding may be named in --fixes)
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
/** #589 (I4) — who may write what, BEFORE the transition. seatRecords=on: a finding / a settle is recorded by the reviewer's `fanout record` only (the coordinator's `--finding`, `--finding-json`, `--settle`, or their `--json` keys ⇒ `[finding-source]`),
 *  and a decision needs a written reason (`[decision-reason-blank]`). off: the four record-only finding fields are unknown, as before #589. */
function assertPatchSource(state: FanoutState, id: string, patch: Record<string, unknown>): void {
  const findings = isObj(patch.findings) ? Object.entries(patch.findings) : [];
  if (!seatRecordsOn(state)) {
    for (const [k, f] of findings) if (isObj(f)) for (const bad of ['by', 'text', 'raisedOn', 'fixedBy', 'onChoice']) if (bad in f) throw new FanoutStateError(`unknown field "${bad}" in findings[${k}]`);
    return;
  }
  if (findings.length || ('findings' in patch && patch.findings !== undefined && !isObj(patch.findings))) throw new SeatRefusal('finding-source', `${id}: seatRecords=on — a finding is recorded by the ticket's reviewer (\`orchestra fanout record ${id} --head <sha> --verdict approve|changes-requested --json <file|->\`), never typed by the coordinator (--finding / --finding-json refused)`);
  if (isObj(patch.settle) && Object.keys(patch.settle).length) throw new SeatRefusal('finding-source', `${id}: seatRecords=on — a finding is closed as fixed by the reviewer that read the fix (\`fanout record ${id} … --json\` {"fixed":[…]}); the coordinator's --settle is refused. Not fixing it: \`state set ${id} --decide <finding>=<reason>\``);
  if (patch.verdict === 'approve' || patch.verdict === 'changes-requested') throw new SeatRefusal('typed-verdict', `${id}: seatRecords=on — the word approve / changes-requested is the reviewer's, written by its \`fanout record\`; the coordinator's --verdict ${patch.verdict} is refused (pass / fail / none stay yours)`);
  for (const [k, v] of Object.entries(isObj(patch.decide) ? patch.decide : {})) if (!isObj(v) || typeof v.text !== 'string' || !v.text.trim()) throw new SeatRefusal('decision-reason-blank', `${id}: --decide ${k} needs a written reason (the closeout lists each decision with it): \`state set ${id} --decide ${k}=<why it is not fixed>\``);
}
export function applyTicketPatch(state0: FanoutState, id: string, patch: Record<string, unknown>, now: string, derived: Parameters<typeof applyTicketPatchCore>[4] = {}): FanoutState {
  assertPatchSource(stampDefaults(state0), id, patch); // #589
  return applyTicketPatchCore(state0, id, patch, now, derived);
}
/** The transition itself (#589: `fanout record` calls it directly, with the reviewer's findings the wrapper above refuses to the coordinator). */
export function applyTicketPatchCore(state0: FanoutState, id: string, patch: Record<string, unknown>, now: string, derived: { tree?: string | null; builtOnTree?: Record<string, string>; specText?: string | null; /** #572 — does a path exist on a head (the CLI reads git); absent = a demonstration's file cannot be checked (refused with that reason) */ fileOnHead?: FileOnHead } = {}): FanoutState {
  const state = stampDefaults(state0); // #559: BEFORE the patch — a first spawn made by this very patch must not read as a legacy run
  if (!SAFE_TICKET.test(id)) throw new FanoutStateError(`unsafe ticket id ${JSON.stringify(id)}`);
  if ('park' in patch || 'unpark' in patch || patch.status === 'parked') return applyParkPatch(state, id, patch, now); // #603: parking is its own transition (it moves the dependents too); it refuses every other key itself
  refuseUnknown(patch, new Set<string>([...SETTABLE_KEYS, ...SEAT_PATCH_KEYS]), 'patch');
  const seat = seatRecordsOn(state);
  for (const k of SEAT_PATCH_KEYS) if (k in patch && !seat) throw seatOff(`--${k === 'interfaceReason' ? 'interface-reason' : k}`);
  const prev: TicketState = state.tickets[id] ?? blankTicket(now);
  const next: TicketState = { ...prev, updatedAt: now };
  if (prev.status === 'parked' && 'status' in patch) throw new FanoutStateError(`${id} is parked (${prev.parked?.cause}: ${prev.parked?.reason}) — \`state set ${id} --unpark\` first; a parked ticket's status does not move by itself`);
  if ('branch' in patch) next.branch = checked(strOrNull(patch.branch, 'branch'), SAFE_BRANCH, 'branch');
  if ('pr' in patch) next.pr = prOrNull(patch.pr);
  if ('head' in patch) next.head = checked(strOrNull(patch.head, 'head'), HEX_SHA, 'head (7-40 lowercase hex)');
  if ('verdict' in patch) next.verdict = enumOf(patch.verdict, VERDICTS, 'verdict');
  if ('dependsOn' in patch) {
    next.dependsOn = depsOf(patch.dependsOn);
    if (seat && next.dependsOn.includes('none')) throw new FanoutStateError(`${id}: "none" is not a ticket id under seatRecords — \`--depends-on none\` alone means "no dependencies"`);
    if (seat) { // #587: giving the dependencies (even none) declares them; a follow on an upstream no longer depended on goes
      next.depsDeclared = true;
      if (next.follows) { const kept = Object.entries(next.follows).filter(([k]) => next.dependsOn.includes(k)); if (kept.length) next.follows = Object.fromEntries(kept); else delete next.follows; }
    }
  }
  if ('interfaceReason' in patch && !('interface' in patch)) throw new FanoutStateError(`${id}: --interface-reason needs --interface <text|file|->`);
  if ('interface' in patch) { // #587 (I2): v1 needs no reason; a CHANGE is a new version and needs one; blank refused
    const text = typeof patch.interface === 'string' ? patch.interface.replace(/\r\n/g, '\n') : '';
    if (!text.trim()) throw new SeatRefusal('interface-blank', `${id}: the interface is blank — write the names the other tickets use (columns, queries, mutations, events)`);
    if (text.length > IFACE_TEXT_MAX || CTRL.test(text)) throw new FanoutStateError(`${id}: the interface must be printable text of at most ${IFACE_TEXT_MAX} characters`);
    const cur = prev.iface ?? null;
    if (!cur) next.iface = { version: 1, text, history: [] };
    else if (cur.text !== text) {
      const reason = patch.interfaceReason;
      if (typeof reason !== 'string' || !reason.trim()) throw new SeatRefusal('interface-reason-missing', `${id}: interface v${cur.version + 1} replaces v${cur.version} — say why (--interface-reason <text>): a dependent that followed v${cur.version} is told the reason`);
      next.iface = { version: cur.version + 1, text, history: [...cur.history, { version: cur.version, text: cur.text, reason: lineOf(reason, `${id}: --interface-reason`, 1000).trim(), at: now }] };
    }
  }
  if ('follows' in patch) next.follows = { ...(prev.follows ?? {}), ...followsOf(patch.follows, id) };
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
  if (switchesOf(state).minorPolicy === 'spec' && (next.specText !== prev.specText || followUpNow !== prev.followUpOf)) { // #554 (review T1 delta2 m1): a sentence pins the merge only under `spec` — under refuse / legacy a re-capture protects nothing
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
      if (f.demonstration !== undefined) { // #572 (f is this patch's own parsed copy, safe to complete in place) — the verdict is code's, from the three texts only (a file / head / refusal typed in the patch is dropped)
        if (switchesOf(state).minorPolicy !== 'demonstrated') throw new FanoutStateError(`${id}: finding ${k}: a demonstration is recorded only under minorPolicy=demonstrated (this run: ${switchesOf(state).minorPolicy}) — drop it, or start a run with --switch minorPolicy=demonstrated`);
        const hadD = had?.demonstration;
        if (hadD && demonstrationAccepted(hadD)) {
          if (!DEMONSTRATION_FIELDS.every((x) => hadD[x] === f.demonstration![x])) throw new FanoutStateError(`${id}: finding ${k} already records an accepted demonstration — a recorded finding is not rewritten`);
          f.demonstration = hadD; // the same texts again: the verdict (and the head it was read on) stand
        } else if (had && findingClosed(had)) throw new FanoutStateError(`${id}: finding ${k} is already ${had.settled ? 'settled' : 'decided'}: it takes no new demonstration`);
        else f.demonstration = classifyDemonstration(f.demonstration, { head: next.head, fileOnHead: derived.fileOnHead });
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
  const legacyMinor = switchesOf(state).minorPolicy === 'legacy' || switchesOf(state).minorPolicy === 'demonstrated'; // #554: before #514 a further candidate on a merged ticket was not a follow-up
  if (!legacyMinor && prev.status === 'merged' && next.status === 'merged' && 'head' in patch && !('forgetMerge' in patch) && prev.head && next.head && !sameSha(prev.head, next.head)) {
    throw new FanoutStateError(`${id} is already merged at ${prev.head.slice(0, 8)}: ${next.head.slice(0, 8)} is a further candidate on it, i.e. a follow-up. ${FOLLOWUP_RULE} Register it as its own ticket: state set <new id> --follow-up-of ${id} --fixes <finding id>[,…] (recording the head it REALLY merged at after a re-gate: add --forget-merge <reason>)`);
  }
  if (next.status === 'merged' && !next.mergedHead) { next.mergedHead = next.head; next.mergedTree = next.tree; }
  if ('implementer' in patch) next.implementer = wsIdOf(patch.implementer, 'implementer');
  // #588 (review r1 MINOR-2): the recorded REVIEWER of a ticket may never be recorded as its implementer / verifier (refused at the write, not only at the next `fanout review`)
  const rid = next.review?.reviewer?.id;
  if (rid && (('implementer' in patch && next.implementer === rid) || ('verifier' in patch && patch.verifier === rid))) throw new SeatRefusal('review-role', `${id}: ${rid} is this ticket's recorded reviewer — it cannot also be its ${next.implementer === rid ? 'implementer' : 'verifier'}`);
  if ('verifier' in patch) {
    next.verifier = wsIdOf(patch.verifier, 'verifier');
    if (next.verifier && switchesOf(state).verifier === 'off') throw new FanoutStateError(`${id}: verifier=off (#563) — this run has no verifier seat, so no verifier workspace is recorded`);
  }
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
  if (!legacyMinor && prev.status === 'merged' && (next.status === 'nominated' || next.status === 'gated')) { // (merged → started|todo|dropped is the explicit un-merge, not a candidate)
    throw new FanoutStateError(`${id} is already merged: a further candidate on it is a follow-up. ${FOLLOWUP_RULE} Register it as its own ticket: state set <new id> --follow-up-of ${id} --fixes <finding id>[,…] (the findings are recorded with --finding <id>=BLOCKING|MAJOR|MINOR)`);
  }
  if (seat) { // #587 (I2): the plan + the interfaces are declared before a ticket starts / is nominated / is gated, and a dependent names the interface version it follows
    const starts = 'status' in patch && (next.status === 'started' || next.status === 'nominated' || next.status === 'gated');
    const spawns = (!!next.implementer && next.implementer !== prev.implementer) || (!!next.verifier && next.verifier !== prev.verifier); // a seat recorded on the ticket IS a spawn (the first one, and a follow-up's later one)
    if (starts || spawns) {
      const missing = planMissing(out);
      if (missing.length) throw new SeatRefusal('plan-incomplete', `${id}: cannot ${starts ? `be ${next.status}` : 'record the first spawn'} — ${missing.length} thing(s) missing from the plan: ${missing.join('; ')}`);
    }
    for (const [up, v] of Object.entries(next.follows ?? {})) {
      const f = out.tickets[up]?.iface;
      if (!next.dependsOn.includes(up)) throw new SeatRefusal('follows-invalid', `${id}: --follows ${up}=${v}: ${up} is not in dependsOn (${next.dependsOn.join(', ') || 'none'})`);
      if (!f) throw new SeatRefusal('follows-invalid', `${id}: --follows ${up}=${v}: ${up} has no interface to follow (state set ${up} --interface <text|file|->)`);
      if (v > f.version) throw new SeatRefusal('follows-invalid', `${id}: --follows ${up}=${v}: ${up}'s interface is at v${f.version}, there is no v${v}`);
    }
    const merging = next.status === 'merged' && prev.status !== 'merged' && 'status' in patch; // a recorded follow that went stale does not merge either (an unfollowed one is the nomination's rule)
    if (((next.status === 'nominated' || next.status === 'gated') && ('status' in patch || 'head' in patch || 'verdict' in patch || 'follows' in patch)) || merging) {
      for (const up of next.dependsOn) {
        const f = out.tickets[up]?.iface;
        if (!f) continue;
        const v = next.follows?.[up];
        if (v === undefined && merging) continue;
        if (v === undefined) throw new SeatRefusal('interface-unfollowed', `${id} cannot be ${next.status}: it names no version of ${up}'s interface (now v${f.version}) — build on it and record --follows ${up}=${f.version}`);
        if (v !== f.version) throw new SeatRefusal('interface-stale', `${id} cannot be ${next.status}: it follows ${up} v${v} but ${up}'s interface is now v${f.version} (${ifaceChanges(f, v)}) — rebuild on v${f.version} and record --follows ${up}=${f.version}`);
      }
    }
  }
  const open = unmergedUpstreams(out, id);
  if (open.length > 0) {
    if (switchesOf(state).earlyGate === 'off' && (next.status === 'nominated' || next.status === 'gated')) { // #554: before #506 — nominated|gated|merged all wait for the upstream's merge
      throw new FanoutStateError(`${id} cannot be ${next.status}: upstream ${open.join(', ')} not merged yet — earlyGate is off for this run: a dependent may START against a frozen interface but is not nominated or gated before its upstream is MERGED`);
    }
    if (next.status === 'started' && !next.frozenInterface && !(seat && open.every((u) => out.tickets[u]?.iface))) { // #587: under seatRecords a held interface IS the frozen interface a dependent starts against
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
  if (switchesOf(state).preNominationChecks === 'on' && (next.status === 'nominated' || next.status === 'gated' || next.verdict === 'pass' || next.verdict === 'approve') && next.head && ('status' in patch || 'head' in patch || 'verdict' in patch)) { // #564: the record of THIS head's tree, or no candidate (a pass verdict is a candidate's too)
    const refusal = nominationRefusal(next, id);
    if (refusal) throw new FanoutStateError(refusal);
  }
  if ((next.status === 'nominated' || next.status === 'gated' || next.verdict === 'pass' || next.verdict === 'approve') && !next.head) {
    throw new FanoutStateError(`${id}: ${next.status === 'nominated' || next.status === 'gated' ? next.status : `verdict ${next.verdict}`} needs a recorded head sha (--head): the gate and the head-moved check speak about one exact head`);
  }
  return freezeAtFirstSpawn(out, now); // #554: the first spawn of the run fixes the switches
}

// ── #603 (ledger #613 FROZEN NAMES v1): parked / rounds / choices / pause — parsers, then the pure transitions ───────────────────
const parkRefusal = (code: string, detail: string): SeatRefusal => new SeatRefusal(code, detail);
const HEX_FP = /^[0-9a-f]{8,64}$/;
/** A reason / check name over its bound is CUT (`max - 1` characters + `…`), never refused: the loop's decision to park or pause must land (the full text lives in the agent's PR body). */
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
export const PARK_REASON_MAX = 1000;
export const CHOICE_TEXT_MAX = 2000;
export const PAUSE_CHECK_MAX = 300;
export const CHOICES_MAX = 500;
function parkOf(v: unknown, where: string): ParkRecord {
  if (!isObj(v)) throw new FanoutStateError(`${where}: parked must be {cause, reason, at}`);
  refuseUnknown(v, new Set(['cause', 'reason', 'at', 'blockedBy']), `${where} parked`);
  const cause = enumOf(v.cause, PARK_CAUSES, `${where}: parked.cause`);
  if (typeof v.reason !== 'string' || !v.reason.trim()) throw parkRefusal('park-no-reason', `${where}: parked has no reason — a parked ticket says why`);
  const reason = lineOf(v.reason, `${where}: parked.reason`, PARK_REASON_MAX);
  const at = isoOf(v.at, `${where}: parked.at`);
  if (cause === 'upstream') {
    if (typeof v.blockedBy !== 'string' || !SAFE_TICKET.test(v.blockedBy)) throw new FanoutStateError(`${where}: parked.cause upstream needs blockedBy (the parked ticket it waits for)`);
    return { cause, reason, at, blockedBy: v.blockedBy };
  }
  if (v.blockedBy !== undefined) throw new FanoutStateError(`${where}: parked.blockedBy only applies to cause upstream`);
  return { cause, reason, at };
}
function roundsOf(v: unknown, where: string): RoundRecord[] {
  if (!Array.isArray(v)) throw new FanoutStateError(`${where}: rounds must be a list of {n, fingerprint, at}`);
  let last = 0;
  return v.map((r, i) => {
    if (!isObj(r)) throw new FanoutStateError(`${where}: rounds[${i}] must be an object`);
    refuseUnknown(r, new Set(['n', 'fingerprint', 'at']), `${where} rounds[${i}]`);
    // `n` is the round's own number (the review's, v1.1): any positive integer, strictly increasing — rounds with no review of their own (an approve, a connect) leave gaps
    if (!Number.isInteger(r.n) || (r.n as number) <= last) throw new FanoutStateError(`${where}: rounds[${i}].n must be an integer greater than ${last} (rounds are numbered by review, strictly increasing)`);
    last = r.n as number;
    if (typeof r.fingerprint !== 'string' || !HEX_FP.test(r.fingerprint)) throw new FanoutStateError(`${where}: rounds[${i}].fingerprint must be lowercase hex (a situationFingerprint)`);
    return { n: r.n as number, fingerprint: r.fingerprint, at: isoOf(r.at, `${where}: rounds[${i}].at`) };
  });
}
function choiceFieldOf(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.trim()) throw parkRefusal('choice-bad', `${where} must be a non-blank text`);
  if (v.length > CHOICE_TEXT_MAX || CTRL.test(v)) throw parkRefusal('choice-bad', `${where} must be printable text of at most ${CHOICE_TEXT_MAX} characters`);
  return v.replace(/\r\n/g, '\n').trim();
}
function choiceOf(e: unknown, n: number, at: string | null, where: string): ChoiceRecord {
  if (!isObj(e)) throw parkRefusal('choice-bad', `${where} must be an object {ticket, question, rule, answer}`);
  refuseUnknown(e, new Set(['n', 'ticket', 'question', 'rule', 'answer', 'at', 'narrows']), where);
  if (typeof e.ticket !== 'string' || !SAFE_TICKET.test(e.ticket)) throw parkRefusal('choice-bad', `${where}.ticket must be a ticket id`);
  if (typeof e.rule !== 'string' || !(CHOICE_RULES as readonly string[]).includes(e.rule)) throw parkRefusal('choice-bad', `${where}.rule must be ${CHOICE_RULES.join('|')}`);
  return { n, ticket: e.ticket, question: choiceFieldOf(e.question, `${where}.question`), rule: e.rule as ChoiceRule, answer: choiceFieldOf(e.answer, `${where}.answer`), at: at ?? isoOf(e.at, `${where}.at`), ...(e.narrows !== undefined ? { narrows: specSentenceOf(e.narrows, `${where}.narrows`) } : {}) };
}
function choicesOf(v: unknown): ChoiceRecord[] {
  if (!Array.isArray(v) || v.length === 0) throw new FanoutStateError('choices must be a non-empty list of {n, ticket, question, rule, answer, at}');
  return v.map((e, i) => {
    if (isObj(e) && e.n !== i + 1) throw new FanoutStateError(`choices[${i}].n must be ${i + 1}`);
    return choiceOf(e, i + 1, isObj(e) && typeof e.at === 'string' ? isoOf(e.at, `choices[${i}].at`) : null, `choices[${i}]`);
  });
}
function pauseOf(v: unknown): PauseRecord {
  if (!isObj(v)) throw new FanoutStateError('pause must be {at, reason, check, prs}');
  refuseUnknown(v, new Set(['at', 'reason', 'check', 'prs', 'auto']), 'pause');
  if (typeof v.reason !== 'string' || !v.reason.trim()) throw parkRefusal('pause-no-reason', 'pause has no reason — a paused run says why');
  const reason = lineOf(v.reason, 'pause.reason', PARK_REASON_MAX);
  if (v.check !== null && (typeof v.check !== 'string' || !v.check.trim() || v.check.length > PAUSE_CHECK_MAX || CTRL.test(v.check))) throw new FanoutStateError('pause.check must be a check name or null');
  if (!Array.isArray(v.prs) || v.prs.some((n) => !Number.isInteger(n) || (n as number) < 1)) throw new FanoutStateError('pause.prs must be a list of pull request numbers');
  const auto = v.auto === undefined ? null : v.auto;
  if (auto !== null && (!isObj(auto) || !Number.isInteger(auto.tries) || (auto.tries as number) < 0)) throw new FanoutStateError('pause.auto must be {tries, nextAt}');
  return { at: isoOf(v.at, 'pause.at'), reason, check: v.check as string | null, prs: [...new Set(v.prs as number[])].sort((a, b) => a - b), ...(auto ? { auto: { tries: (auto as { tries: number }).tries, nextAt: isoOf((auto as { nextAt: unknown }).nextAt, 'pause.auto.nextAt') } } : {}) };
}
function waitedOf(v: unknown): WaitRecord[] {
  if (!Array.isArray(v)) throw new FanoutStateError('waited must be a list of {at, until, ms, check, prs, reruns}');
  return v.map((e, i) => {
    if (!isObj(e) || !Number.isFinite(e.ms) || !Number.isInteger(e.reruns) || !Array.isArray(e.prs)) throw new FanoutStateError(`waited[${i}] must be {at, until, ms, check, prs, reruns}`);
    return { at: isoOf(e.at, `waited[${i}].at`), until: isoOf(e.until, `waited[${i}].until`), ms: e.ms as number, check: typeof e.check === 'string' ? e.check : null, prs: (e.prs as unknown[]).filter((n): n is number => Number.isInteger(n)), reruns: e.reruns as number };
  });
}
function startFlakyOf(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw new FanoutStateError('startFlaky must be a list of check names');
  return [...new Set(v as string[])];
}
/** status `parked` ⇔ a `parked` record (a half-written parking is refused when read AND when written); `blockedBy` names a ticket of the state. */
function assertParkedCoherent(state: FanoutState): void {
  for (const [id, t] of Object.entries(state.tickets)) {
    if (t.status === 'parked' && !t.parked) throw parkRefusal('park-no-reason', `ticket ${id}: status parked with no \`parked\` record (cause + reason)`);
    if (t.status !== 'parked' && t.parked) throw new FanoutStateError(`ticket ${id}: a \`parked\` record on a ticket whose status is ${t.status}`);
    if (t.parked?.blockedBy && !state.tickets[t.parked.blockedBy]) throw new FanoutStateError(`ticket ${id}: parked.blockedBy names ${t.parked.blockedBy}, which is not a ticket of the run`);
  }
}

/** Every ticket `id` depends on, directly or not (never `id` itself). */
function upstreamClosure(state: FanoutState, id: string): Set<string> {
  const out = new Set<string>();
  const walk = (x: string): void => { for (const d of state.tickets[x]?.dependsOn ?? []) if (!out.has(d)) { out.add(d); walk(d); } };
  walk(id);
  out.delete(id);
  return out;
}
/** The tickets that depend on `id`, directly or not. */
function dependentsOf(state: FanoutState, id: string): string[] {
  return Object.keys(state.tickets).filter((x) => x !== id && upstreamClosure(state, x).has(id));
}
/** What a ticket goes back to when it is unparked: `started` if it ever had work (a branch, a head, an implementer, a launch), else `todo`. The loop re-derives the rest from git. */
const restoredStatus = (t: TicketState): TicketStatus => (t.branch || t.head || t.implementer || t.start ? 'started' : 'todo');
function withoutPark(t: TicketState, now: string): TicketState {
  const { parked: _p, ...rest } = t;
  return { ...rest, status: restoredStatus(t), verdict: 'none', updatedAt: now }; // a verdict spoke about work that was set aside: it is read again from the next round
}

/** `parkTicket` — set `id` aside with a `cause` (question | situation | ci) and a written `reason`; EVERY ticket that depends on it, directly or not, is parked `upstream` with `blocked by <id>`.
 *  Refusals: `park-bad-cause` (not one of the three; `upstream` is only ever given to a dependent), `park-no-reason`, `park-unknown-ticket`, `park-merged` (a merged ticket is done), `park-dropped`.
 *  Idempotent: a ticket already parked for its own cause keeps its first record (a restarted loop parks again without rewriting history). */
export function parkTicket(state: FanoutState, id: string, input: { cause: ParkCause | string; reason: string }, now: string): FanoutState {
  if (typeof input.cause !== 'string' || !(PARK_CAUSES as readonly string[]).includes(input.cause) || input.cause === 'upstream') throw parkRefusal('park-bad-cause', `${id}: --park needs a cause: ${PARK_CAUSES.filter((c) => c !== 'upstream').join('|')} (got ${JSON.stringify(input.cause)}${input.cause === 'upstream' ? '; `upstream` is given to the dependents of a parked ticket, never chosen' : ''})`);
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw parkRefusal('park-no-reason', `${id}: a parked ticket needs a reason (--park-reason <text>): the closing report prints it`);
  const reason = lineOf(clip(input.reason.trim(), PARK_REASON_MAX), `${id}: park reason`, PARK_REASON_MAX);
  const t = state.tickets[id];
  if (!t) throw parkRefusal('park-unknown-ticket', `${id}: no such ticket in run ${state.run} — nothing to park`);
  if (t.status === 'merged') throw parkRefusal('park-merged', `${id} is merged — a merged ticket is done, not parked`);
  if (t.status === 'dropped') throw parkRefusal('park-dropped', `${id} is dropped — a dropped ticket is already out of the run`);
  const tickets = { ...state.tickets };
  if (!(t.status === 'parked' && t.parked && t.parked.cause !== 'upstream')) tickets[id] = { ...t, status: 'parked', parked: { cause: input.cause as ParkCause, reason, at: now }, updatedAt: now };
  for (const d of dependentsOf(state, id)) {
    const dt = tickets[d];
    if (dt.status === 'merged' || dt.status === 'dropped' || dt.status === 'parked') continue; // done, out, or already parked (a root keeps its own cause)
    tickets[d] = { ...dt, status: 'parked', parked: { cause: 'upstream', reason: `blocked by ${id}`, at: now, blockedBy: id }, updatedAt: now };
  }
  return { ...state, tickets, updatedAt: now };
}

/** After a root parking went away (unparked, or the ticket merged by hand): a ticket parked `upstream` stays parked only while some ticket it depends on is still parked for its OWN cause (blockedBy follows to it), else it goes back to work. Idempotent. */
export function releaseUpstreamParks(state: FanoutState, now: string): FanoutState {
  const roots = new Set(Object.entries(state.tickets).filter(([, t]) => t.status === 'parked' && t.parked && t.parked.cause !== 'upstream').map(([id]) => id));
  let tickets = state.tickets;
  for (const [id, t] of Object.entries(state.tickets)) {
    if (t.status !== 'parked' || t.parked?.cause !== 'upstream') continue;
    const still = [...upstreamClosure(state, id)].filter((u) => roots.has(u)).sort();
    if (still.length === 0) tickets = { ...tickets, [id]: withoutPark(t, now) };
    else if (!still.includes(t.parked.blockedBy ?? '')) tickets = { ...tickets, [id]: { ...t, parked: { ...t.parked, reason: `blocked by ${still[0]}`, blockedBy: still[0] }, updatedAt: now } };
  }
  return tickets === state.tickets ? state : { ...state, tickets, updatedAt: now };
}

/** `unparkTicket` — take a ticket parked for its own cause back to work; the dependents it was holding go back too unless another parked ticket still holds them. */
export function unparkTicket(state: FanoutState, id: string, now: string): FanoutState {
  const t = state.tickets[id];
  if (!t) throw new FanoutStateError(`${id}: no such ticket in run ${state.run}`);
  if (t.status !== 'parked' || !t.parked) throw new FanoutStateError(`${id} is not parked (status ${t.status})`);
  if (t.parked.cause === 'upstream') throw new FanoutStateError(`${id} is parked because ${t.parked.blockedBy} is — unpark ${t.parked.blockedBy} (its dependents follow)`);
  const freed = releaseUpstreamParks({ ...state, tickets: { ...state.tickets, [id]: withoutPark(t, now) }, updatedAt: now }, now);
  const held = [...upstreamClosure(freed, id)].filter((u) => freed.tickets[u]?.status === 'parked' && freed.tickets[u].parked?.cause !== 'upstream').sort();
  if (held.length === 0) return freed;
  const me = freed.tickets[id]; // its own cause is gone but a ticket it depends on is still parked: it goes back to being held by that one, never live under a parked upstream
  return { ...freed, tickets: { ...freed.tickets, [id]: { ...me, status: 'parked', parked: { cause: 'upstream', reason: `blocked by ${held[0]}`, at: now, blockedBy: held[0] } } }, updatedAt: now };
}
/** `state set <ticket> --park … / --unpark / --status parked`: the patch forms of the two transitions (alone: no other key but `status: parked` with a park). */
function applyParkPatch(state: FanoutState, id: string, patch: Record<string, unknown>, now: string): FanoutState {
  if (!SAFE_TICKET.test(id)) throw new FanoutStateError(`unsafe ticket id ${JSON.stringify(id)}`);
  if ('unpark' in patch) {
    if (Object.keys(patch).some((k) => k !== 'unpark')) throw new FanoutStateError(`${id}: --unpark takes no other flag`);
    if (patch.unpark !== true) throw new FanoutStateError(`${id}: unpark must be true`);
    return unparkTicket(state, id, now);
  }
  if (Object.keys(patch).some((k) => k !== 'park' && k !== 'status')) throw new FanoutStateError(`${id}: --park takes only --park-reason (and --status parked), no other flag`);
  if ('status' in patch && patch.status !== 'parked') throw new FanoutStateError(`${id}: --park sets the status parked; ${JSON.stringify(patch.status)} cannot go with it`);
  const park = isObj(patch.park) ? patch.park : null;
  if (!park) throw parkRefusal('park-no-reason', `${id}: --status parked needs --park <cause> --park-reason <text> (cause: ${PARK_CAUSES.filter((c) => c !== 'upstream').join('|')})`);
  return parkTicket(state, id, { cause: park.cause as string, reason: park.reason as string }, now);
}

/** Every parked ticket, in the state's ticket order, with its record. */
export function parkedTickets(state: FanoutState): Array<{ ticket: string } & ParkRecord> {
  return Object.entries(state.tickets).filter(([, t]) => t.status === 'parked' && t.parked).map(([ticket, t]) => ({ ticket, ...t.parked! }));
}

/** The situation of a round: the open findings (ids) + the candidate tree, as one sha256 hex. The same pair twice = the same situation. */
export function situationFingerprint(input: { openFindings: string[]; tree: string }): string {
  return crypto.createHash('sha256').update(`findings:${[...input.openFindings].sort().join(',')}\ntree:${input.tree}`).digest('hex');
}
/** Record one round of `id`'s findings. `repeat` = this fingerprint was ALREADY recorded for the ticket (the second sighting parks it). One call per round: recording the same round twice is a repeat.
 *  `n` = the round's number when the caller has one (the review's); absent = the last number + 1 (= length + 1 while the rounds are contiguous). It must exceed the last recorded `n`. */
export function recordRound(state: FanoutState, id: string, fingerprint: string, now: string, n?: number): { state: FanoutState; repeat: boolean } {
  if (typeof fingerprint !== 'string' || !HEX_FP.test(fingerprint)) throw new FanoutStateError(`${id}: a round fingerprint is lowercase hex (situationFingerprint) — got ${JSON.stringify(fingerprint)}`);
  const t = state.tickets[id];
  if (!t) throw new FanoutStateError(`${id}: no such ticket in run ${state.run} — no round to record`);
  const rounds = t.rounds ?? [];
  const repeat = rounds.some((r) => r.fingerprint === fingerprint);
  const last = rounds.length ? rounds[rounds.length - 1].n : 0;
  if (n !== undefined && (!Number.isInteger(n) || n <= last)) throw new FanoutStateError(`${id}: round number ${n} must be an integer greater than the last recorded round (${last})`);
  return { state: { ...state, tickets: { ...state.tickets, [id]: { ...t, rounds: [...rounds, { n: n ?? last + 1, fingerprint, at: now }], updatedAt: now } }, updatedAt: now }, repeat };
}

/** Record what an agent chose when it asked (`[choice-bad]` on a blank / unknown-rule / oversized entry). Numbered from 1, never edited. */
export function recordChoice(state: FanoutState, entry: { ticket: string; question: string; rule: ChoiceRule | string; answer: string; narrows?: string; n?: number; at?: string }, now: string): FanoutState {
  const list = state.choices ?? [];
  if (list.length >= CHOICES_MAX) throw parkRefusal('choice-bad', `the run already holds ${list.length} choices (at most ${CHOICES_MAX})`);
  const rec = choiceOf({ ticket: entry.ticket, question: entry.question, rule: entry.rule, ...(entry.narrows !== undefined ? { narrows: entry.narrows } : {}), answer: entry.answer }, list.length + 1, now, 'choice');
  return { ...state, choices: [...list, rec], updatedAt: now };
}

/** Pause the run: the same check is red on several pull requests, which is the environment, not a ticket. `[pause-no-reason]` without a reason. A second call while paused keeps the first record and adds the pull requests. */
export function pauseRun(state: FanoutState, input: { reason: string; check: string | null; prs: number[]; auto?: { tries: number; nextAt: string } }, now: string): FanoutState {
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw parkRefusal('pause-no-reason', 'a pause needs a reason (--pause <reason>): the report says why the run stopped');
  const next = pauseOf({ at: now, reason: clip(input.reason.trim(), PARK_REASON_MAX), check: typeof input.check === 'string' ? clip(input.check, PAUSE_CHECK_MAX) : input.check ?? null, prs: input.prs ?? [], ...(input.auto ? { auto: input.auto } : {}) });
  if (state.pause) return { ...state, pause: { ...state.pause, prs: [...new Set([...state.pause.prs, ...next.prs])].sort((a, b) => a - b) }, updatedAt: now };
  return { ...state, pause: next, updatedAt: now };
}
/** Lift the pause (a no-op when the run is not paused). */
export function resumeRun(state: FanoutState, now: string): FanoutState {
  if (!state.pause) return state;
  const { pause: _p, ...rest } = state;
  return { ...rest, updatedAt: now };
}
export const pausedOf = (state: FanoutState): PauseRecord | null => state.pause ?? null;

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
    const cur = readState(file);
    const next = mutate(cur && stampDefaults(cur)); // #559: stamped BEFORE any writer's patch
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

export type TicketClass = 'done' | 'dropped' | 'parked' | 'waiting' | 'startable' | 'in-progress' | 'awaiting-gate' | 'awaiting-merge' | 'needs-fix' | 'diverged';
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
  if (r.mergedIntoTarget === true && status !== 'started' && status !== 'parked') return true; // #603: a parked branch cut from the target tip is trivially "contained", like a started one — never a merge
  if (r.error) return undefined;
  return false;
}

/** The head a MERGED ticket landed at when it differs from the head its pass/approve verdict covered; null = no such mismatch. */
function ungatedMergeHead(t: TicketState, r: TicketReality | undefined, rm: boolean | undefined): string | null {
  if (rm !== true || (t.status !== 'gated' && t.status !== 'merged' && t.status !== 'parked') || (t.verdict !== 'pass' && t.verdict !== 'approve') || !t.head) return null;
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
    const claimsWork = t.status !== 'todo' && t.status !== 'dropped' && t.status !== 'parked'; // #603: a parked ticket's branch / PR may be gone or closed on purpose
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
      else if (t.status === 'parked') writeBack.push({ ticket: id, seen: t.updatedAt, patch: { status: 'merged', head: ungated, tree: (r?.pr?.state === 'MERGED' ? r.prTree : r?.branchTree) ?? null, verdict: 'none' }, why: `a parked ticket merged by hand at ${ungated.slice(0, 8)} (adopted at the head that really merged; the verdict was on another)` }); // #603 r1: the divergence below stays
    }
    if (r && !r.error && claimsWork && t.status !== 'merged' && t.branch && r.branchHead === null && rm !== true) {
      add({ ticket: id, kind: 'branch-gone', detail: `branch ${t.branch} is not on the remote` });
    }
    if (r && !r.error && t.head && r.branchHead && !sameSha(r.branchHead, t.head) && rm !== true && (t.status === 'nominated' || t.status === 'gated') && t.tree && r.branchTree === t.tree) {
      // #512: the branch moved to another sha with the SAME tree (rebase, author rewrite): the verdict stands, only the recorded head follows. Not a divergence.
      writeBack.push({ ticket: id, seen: t.updatedAt, patch: { head: r.branchHead, tree: r.branchTree }, why: `head moved to ${r.branchHead.slice(0, 8)}, same tree: ${t.verdict} verdict kept` });
    } else if (r && !r.error && t.head && r.branchHead && !sameSha(r.branchHead, t.head) && rm !== true && (t.status === 'nominated' || t.status === 'gated')) {
      add({ ticket: id, kind: 'head-moved', detail: `branch head ${r.branchHead.slice(0, 8)} != recorded ${t.head.slice(0, 8)} — verdict ${t.verdict} is stale` });
      // #564: preNominationChecks on — a nominated|gated ticket moved onto a tree with no passing check record is no candidate any more: back to `started` (re-run `fanout check`, then nominate)
      const demote = switchesOf(state).preNominationChecks === 'on' && !(r.branchTree && t.checks?.[r.branchTree]?.ok);
      if (t.verdict !== 'none' || t.status === 'gated' || demote) {
        writeBack.push({ ticket: id, seen: t.updatedAt, patch: { head: r.branchHead, tree: r.branchTree ?? null, verdict: 'none', ...(demote ? { status: 'started' as const } : t.status === 'gated' ? { status: 'nominated' as const } : {}) }, why: demote ? 'head moved onto a tree with no passing pre-nomination check record: verdict reset, back to started' : 'head moved: verdict reset' });
      } else {
        writeBack.push({ ticket: id, seen: t.updatedAt, patch: { head: r.branchHead, tree: r.branchTree ?? null }, why: 'head moved' });
      }
    } else if (r?.pr && t.head && r.pr.headRefOid && !sameContent(r.pr.headRefOid, r.prTree, t.head, t.tree) && t.status !== 'merged' && t.status !== 'parked' && r.pr.state === 'OPEN') {
      add({ ticket: id, kind: 'pr-head-moved', detail: `PR #${t.pr} head ${r.pr.headRefOid.slice(0, 8)} != recorded ${t.head.slice(0, 8)}` });
    }
    if (r?.pr?.state === 'MERGED' && r.pr.baseRefName !== state.target && rm !== true && t.status !== 'dropped' && !accepted) {
      add({ ticket: id, kind: 'pr-merged-other-base', detail: `PR #${t.pr} is MERGED into ${r.pr.baseRefName ?? '(unknown base)'}, not origin/${state.target}: not merged on the target` });
    }
    if (ungated) {
      add({ ticket: id, kind: 'merged-at-ungated-head', detail: `merged at ${ungated.slice(0, 8)} but the ${t.verdict} verdict was on ${t.head?.slice(0, 8)}: re-gate the merged tree, then \`state set ${id} --status merged --head ${ungated.slice(0, 12)} --forget-merge <reason>\`` });
    }
    if (r?.pr?.state === 'CLOSED' && t.status !== 'merged' && t.status !== 'dropped' && t.status !== 'parked') {
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
        const movedMerged = t.dependsOn.filter((d) => switchesOf(state).earlyGate === 'on' && effMerged(d) && t.builtOn[d]).map((d) => ({ d, h: reality[d]?.pr?.state === 'MERGED' ? reality[d]!.pr!.headRefOid : state.tickets[d]?.head ?? null })).filter((x) => x.h && !sameContent(t.builtOn[x.d], t.builtOnTree[x.d], x.h!, reality[x.d]?.pr?.state === 'MERGED' ? reality[x.d]?.prTree : state.tickets[x.d]?.tree));
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
    tickets[id] = { ...planTicket(id, t, own, open, switchesOf(state).earlyGate === 'on'), divergences: own };
  }
  return { tickets, divergences, writeBack };
}

function planTicket(id: string, t: TicketState, own: Divergence[], open: string[], early = true): { class: TicketClass; next: NextAction } {
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
    case 'parked': return { class: 'parked', next: { action: 'none', detail: `parked (${t.parked?.cause}): ${t.parked?.reason} — never counted as merged; \`state set ${id} --unpark\` returns it to work` } };
    case 'todo':
      if (open.length === 0) return { class: 'startable', next: { action: 'start', detail: t.dependsOn.length ? 'every upstream is merged' : 'no upstream' } };
      if (t.frozenInterface) return { class: 'startable', next: { action: 'start-against-frozen-interface', detail: `build against ${t.frozenInterface}; ${early ? `nominate only once ${open.join(', ')} has a verified candidate (nominated|gated) and you rebased onto its head` : `nominate only once ${open.join(', ')} is MERGED (earlyGate=off)`}` } };
      return { class: 'waiting', next: { action: 'wait-upstream', detail: `waiting for ${open.join(', ')} (no frozen interface to start against)` } };
    case 'started':
      return { class: 'in-progress', next: { action: 'continue', detail: open.length ? (early ? `finish and self-gate; nomination needs ${open.join(', ')} merged or nominated|gated (rebase onto its head, --built-on)` : `finish and self-gate; nomination needs ${open.join(', ')} MERGED (earlyGate=off)`) : 'finish, self-gate, nominate' } };
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
    const { parked: _parked, ...curRest } = cur; // #603: reality moved the ticket on (e.g. merged by hand): its parking ends with it
    tickets[w.ticket] = { ...(w.patch.status ? curRest : cur), ...w.patch, ...(w.patch.status === 'merged' ? { mergedHead: cur.mergedHead ?? w.patch.head ?? cur.head, mergedTree: cur.mergedHead ? cur.mergedTree : w.patch.tree !== undefined ? w.patch.tree : cur.tree } : {}), updatedAt: now };
    if (w.patch.status === 'merged') mergedHere.add(w.ticket);
  }
  return parseState(releaseUpstreamParks({ ...state, tickets, updatedAt: now, reconciledAt: now }, now));
}
