// #469 — `orchestra fanout state init|set|show` and `orchestra fanout resume`. Pure of process globals: argv + deps in, {code,stdout,stderr} out,
// so index.ts only forwards and the tests drive it with a fake git/gh runner. Resume = 5 steps: load, reconcile, classify, next action, write back.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FanoutStateError,
  SeatRefusal,
  SETTABLE_KEYS,
  SPEC_SENTENCE_LIMIT,
  SPEC_TEXT_MAX,
  effectiveSpec,
  sentenceAccepted,
  applyTicketPatch,
  demonstratedFindings,
  findingDemonstrated,
  refusedDemonstrations,
  applyWriteBack,
  newState,
  parseSwitchAssignments,
  readState,
  reconcile,
  resolveFanoutRun,
  setHarness,
  addDecision,
  setPlan,
  setSwitches,
  seatRecordsOn,
  planMissing,
  readyTickets,
  stateFile,
  switchesLine,
  switchesOf,
  updateState,
  type FanoutState,
  type FindingRecord,
  type Reality,
  type TicketReality,
  type TicketState,
} from '../shared/fanout-state.ts';
import type { CheckExec } from '../shared/fanout-checks.ts';
import type { IdentityResolution } from '../shared/session-identity.ts';
import { resolveCaller } from '../shared/fanout-caller.ts';
import { assertReviewCaller } from '../shared/fanout-review.ts';
import { DEMONSTRATION_LIMIT, DEMONSTRATION_WORD_FLOOR, citationsOf, isProductPath } from '../shared/fanout-demonstration.ts';
import { acceptanceOn, acceptancePhase, claimIsStale } from '../shared/fanout-acceptance.ts';
import { assertDecideCaller, countsThrough, unrecordedReviewers } from '../shared/fanout-record.ts';

/** `hostCalls` (#515): requests the verb leaves for the HOST (the app owns the spawn and the bus) — index.ts sends each to its socket route after the state is written. */
export interface HostCall { route: '/fanoutAcceptance'; body: Record<string, unknown> }
export interface RunResult { code: number; stdout: string; stderr: string; hostCalls?: HostCall[] }
/** The injectable git/gh seam: tests hand a fake; production spawns the real binary. `env` (optional, extra variables) is how a verb points git at a scratch index. */
export type Runner = (cmd: 'git' | 'gh', args: string[], cwd: string, env?: Record<string, string>) => { code: number; stdout: string; stderr: string };

export interface FanoutDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  runner: Runner;
  now: () => string;
  readStdin: () => string;
  /** #554 (review T3 m1) — the run owner's children as the HOST sees them, asked by index.ts before a `--switch` write (the bus-side first-spawn signal: an agent spawned by hand is not in the state yet).
   *  undefined = not asked · null = the host could not answer (the state-side detector alone then decides, said on stderr). */
  spawned?: string[] | null;
  /** #564 — runs one shell command of `fanout check` (undefined = the real `sh -c`; tests hand a fake). */
  exec?: CheckExec;
  /** #588 — the host's answer to `/identity` for THIS call (index.ts `settleHostIdentity`); undefined / null = the host was not asked or did not vouch. The caller proof of `fanout review` (src/shared/fanout-caller.ts). */
  identity?: IdentityResolution | null;
}

/** #554 — is this `fanout state init|set … --switch …`? Returns the run it acts on (for the host question), else null. */
export function switchVerbRun(args: string[], env: NodeJS.ProcessEnv): string | null {
  if (args[0] !== 'state' || (args[1] !== 'set' && args[1] !== 'init') || !args.includes('--switch')) return null;
  const i = args.indexOf('--run');
  return resolveFanoutRun(i >= 0 ? args[i + 1] : undefined, env).run;
}
/** Refuse a switch write once the host reports children of the run owner (the first spawn happened, recorded in the state or not). Returns the stderr note when the host could not answer. */
function checkSpawned(deps: FanoutDeps, run: string): string {
  if (deps.spawned && deps.spawned.length) throw new FanoutStateError(`the switches of run ${run} cannot change: the run owner already spawned ${deps.spawned.length} workspace(s) (${deps.spawned.slice(0, 4).join(', ')}${deps.spawned.length > 4 ? ', …' : ''}) — a switch is fixed for the run from its first spawn (start a new run to change one)`);
  return deps.spawned === null ? 'note: the host could not say whether the run has spawned; only the state was checked for the first spawn\n' : '';
}

export function defaultRunner(cmd: 'git' | 'gh', args: string[], cwd: string, env?: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (r.error) return { code: 127, stdout: '', stderr: String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export const FANOUT_USAGE = `usage: orchestra fanout state init --run <id> [--target <branch>] [--repo <owner/name>] [--harness <ref>] [--switch <name>=<value>[,…]]
       orchestra fanout state set --harness <ref|-> [--run <id>]     (run-level: the repo's integration harness, #538; "-" clears it)
       orchestra fanout state set --switch <name>=<value>[,…] [--run <id>]   (run-level: one switch per feature, #554 — frozen at the run's first spawn)
       orchestra fanout state set <ticket> [--run <id>] [--status s] [--branch b] [--pr n] [--head sha] [--verdict v]
                                  [--depends-on a,b] [--built-on a=sha,b=sha] [--frozen-interface ref] [--accept-merged <reason>] [--json <object|->]
                                  [--finding id=BLOCKING|MAJOR|MINOR[,…]] [--follow-up-of <merged ticket> --fixes <finding id>[,…]] [--forget-merge <reason>]
                                  [--spec <file|url|ledger section>] [--spec-text <file|->] [--finding-json <json|->] [--settle <id>=fixed|pr-body:<ref>] [--decide <id>=<text>] [--implementer <ws id>] [--verifier <ws id>]
       orchestra fanout state show [--run <id>] [--json]
       orchestra fanout check <ticket> [--head <sha>] [--run <id>]   (#564: run the repo's pre-nomination checks, record them per git tree — orchestra fanout check --help)
       orchestra fanout acceptance freeze|amend|waive|spawn|show <ticket> …   (frozen acceptance tests, #510/#515 — orchestra fanout acceptance --help)
       orchestra fanout resume [--run <id>] [--cwd <repo dir>] [--no-fetch] [--no-write] [--json]

The vague's execution state: <ORCHESTRA_HOME>/fanout/<run>/state.json (one writer, atomic rewrite, unknown field refused).
  status   todo|started|nominated|gated|merged|dropped        verdict  none|pass|fail|approve|changes-requested
  A dependent may START against a frozen interface. While an upstream is not merged it may be 'nominated'/'gated' only on that upstream's
  verified candidate (nominated|gated, head recorded, no failing verdict) with --built-on <upstream>=<head it was built on> = that head;
  'merged' is REFUSED until every upstream is merged (fanout deliver re-proves order and content at merge time).
  resume   load → reconcile against git + gh → classify → next action per ticket → write back reality-ahead facts.
           exit 0 = state matches reality, 2 = divergences reported (state claims reality does not back are never auto-corrected).
  Content key (#512): \`set --head\` / \`--built-on\` also record the git TREE of each sha (derived, read-only; unreadable ⇒ unknown ⇒ sha-keyed). \`resume\` keeps a verdict whose head
           moved to another sha with the SAME tree (it records the new head); another tree = head-moved (verdict void).
  --spec <ref>  (#515) registers the ticket's spec: Orchestra then SPAWNS that ticket's \`accept-\` test writer itself (Opus 5.5, brief = spec + ticket only);
           its \`fanout acceptance freeze\` publishes the tests to branch acceptance/<run> and tells --implementer / --verifier (workspace ids) the path + command.
           \`state show\` prints each ticket's path + run command (or "pending"). A gate on an unfrozen ticket WAITS (bounded), deliver answers acceptance-pending.
  --harness <ref>  (#538) the repo's own INTEGRATION test entry (a path and/or the command that runs it, one line ≤ 300 chars): each \`accept-\` writer's brief names it and requires every
           frozen test to boot the FULL app module through it and open its OWN execution context per test (no shared DB connection / query runner / transaction). Not declared ⇒ discovery
           on origin/<target>: root package.json scripts e2e|integration|int (test:e2e…), specs *.e2e-spec.* / *.e2e|integration|int.test.* / files under e2e|integration/, an app-boot
           fixture (test-app, create-app, app.fixture, e2e-setup…); none found ⇒ the brief says so and keeps the self-contained wording. Read at each writer SPAWN (a writer already spawned keeps its brief). A found harness is conditional wording ("if they boot the app module…"), only a declared one is a hard requirement.
           A state that DECLARES a harness is refused by a build older than #538 (unknown field): declare it only when the CLI and the app are the same build.
  --accept-merged <reason>  a merged ticket counts as merged although git/gh do not show it on the target (stacked base later
           squash-landed): the only override of a reality that contradicts the state.
  Findings (#514): --finding records a verifier/review finding (id=severity) on the ticket it was raised on; a recorded severity is never re-graded.
           A follow-up candidate on an already-merged ticket (--follow-up-of <it> --fixes <ids>, as its own ticket) is registered, gated and delivered
           only if it fixes >= 1 BLOCKING|MAJOR finding recorded on that ticket — MINOR-only, none, or an unknown id is refused; \`state set\` also refuses
           to nominate/gate a ticket that ever merged on another head (the merged head outlives an un-merge; --forget-merge <reason> clears it when the merge was never real).
           Findings are the coordinator's own record (no report reference): one finding may justify more than one follow-up, and a brand-new branch under a fresh ticket id cannot
           be told from a new ticket — the rule catches the same branch/PR as a merged ticket, any head change on it, and every un-merge/--forget-merge path (the reason is kept in forgottenMerges, denied to a scribe).
  A MINOR that breaks a sentence of the ticket (#552, minorPolicy spec): --finding-json '{"<id>":{"severity":"MINOR","specSentence":"<verbatim>","kind":"code|process","evidence":"measured|argued","report":{"input":"…","happens":"…","where":"…","proof":"…"}}}' (a measured code MINOR needs the report — #553; argued / process need none).
           Code accepts specSentence ONLY if it is a literal substring (no trim, no case-fold; empty / whitespace-only / fewer than 15 characters refused; CRLF captured as LF) of the spec TEXT captured at registration — --spec <file>
           reads the file; for a URL / ledger spec give the text: --spec-text <file|-> (derived, never settable by --json). An accepted, unsettled MINOR BLOCKS \`gate\` + \`deliver\`
           (finding-unsettled) like a MAJOR until --settle <id>=fixed:<head> (code) / --settle <id>=pr-body:<what the PR body says now> (kind process: how the work is REPORTED — never a code
           round, never a --fixes target) or the coordinator's --decide <id>=<text> (scribes: --settle / --decide / --spec-text denied). It may be named in --fixes (a process finding never).
           LIMIT: code checks the sentence is IN the spec, not that it is really broken — judging that stays with the reviewer.
  A finding with a demonstration (#572, minorPolicy demonstrated): --finding-json '{"<id>":{"severity":"MINOR|MAJOR|BLOCKING","evidence":"measured|argued","demonstration":{"input":"<the concrete situation>","observed":"<what the code does or returns, with a PRODUCT file:line>","expected":"<what the ticket asks, or why the result is wrong for the user>"}}}'.
           Code accepts it ONLY if all three fields are present, non-blank, at least ${DEMONSTRATION_WORD_FLOOR} words each (observed: besides its file:line), pairwise different, and \`observed\` cites a file:line that EXISTS on the ticket's recorded head (--head) and is PRODUCT code
           (not a test / spec file, not documentation, not vendored). A finding of ANY severity with an accepted demonstration BLOCKS \`gate\` + \`deliver\` (finding-unsettled) like a MAJOR until --settle <id>=fixed:<head> (a later head whose review no longer carries it)
           or the coordinator's --decide <id>=<text>; it may be named in --fixes. A refused demonstration is recorded WITH its reason and the finding stays an ordinary one (a MINOR is then noted, no block). A BLOCKING / MAJOR without one: as today.
           \`state show\` lists the open demonstrated findings per ticket; \`fanout closeout\` lists each and how it ended. ${DEMONSTRATION_LIMIT}
  --switch (#554, defaults #559) one switch per feature, printed by \`state show\` and FROZEN for the run at its first spawn (the first ticket past todo, the first implementer / verifier / accept- writer recorded;
           after that any change is refused with the reason; an unknown name or value is refused):
             earlyGate=on|off      on (default): a dependent is nominated/gated on its upstream's verified candidate (#506); off: it waits for the upstream's MERGE.
             acceptance=on|off     off (default): no writer spawned, no frozen test asked; on: --spec spawns the accept- writer, the gate / deliver ask for the frozen tests (#510, #515).
             minorPolicy=legacy|refuse|spec|demonstrated   legacy (default): follow-ups unrestricted (before #514); refuse: #514 (a follow-up needs a BLOCKING|MAJOR finding); spec: #552 (a MINOR quoting a spec sentence blocks);
                                   demonstrated: #572 (a finding of any severity with an accepted demonstration blocks; follow-ups unrestricted as under legacy).
             verifier=on|off       on (default): a verifier seat gates each candidate (#563); off: none is spawned, the skill text has no verifier role, \`state set --verifier\` is refused, and \`deliver\` merges on the reviewer's
                                   verdict (0 BLOCKING / 0 MAJOR on the head, tree-keyed) + a green CI on that head — \`deliver --no-review-gate\`, no verdict, an open BLOCKING|MAJOR, a red or missing CI are still refused.
             preNominationChecks=on|off   off (default): none; on (#564): \`state set <ticket> --status nominated|gated\` (with a head) is REFUSED unless the state holds a PASSING record of \`orchestra fanout check <ticket>\` for the git tree of that head
                                   (message: the failing command and its last lines, "no check record for this head", or "found NOTHING to run"). Commands are DISCOVERED (changed path → nearest package.json with a lint script, run from its dir);
                                   the target repo's optional .orchestra/pre-nomination-checks.json {"checks":[{"run","cwd"?,"timeoutSec"?}]} OVERRIDES discovery ({"checks":[]} = explicit no-check, the only way to nominate when nothing is found).
           Defaults = the v0.5.375 profile (#559: they were acceptance=on, minorPolicy=spec in v0.5.378). A run that had ALREADY spawned when they changed keeps the old ones for every switch it never set (never re-read mid-run);
           \`state show\` prints each switch as <name>=<value> (default | explicit | default kept from v0.5.378 (run started before the defaults change)).
           The installed skill follows the switches of the coordinator's DEFAULT run id (its own workspace id); a second vague under \`--run <other id>\` obeys its switches in every verb, but its members' skill text is rendered from the default run's.
           Accepted gap: a run that set no switch persists no freeze record, so a ticket moved back to todo (nothing recorded, no child) lets a switch change again; a real spawned child still refuses it (host check + recorded implementer).
           Choose them BEFORE the first spawn (\`state init --switch …\` or \`state set --switch …\`): an agent spawned by hand and not yet recorded in the state is not seen by the freeze.
  --run defaults to YOUR OWN run (your workspace id; init always); show/resume use your parent's run only when you have no state and it does; set needs your own state or --run (#486).`;

/** #587 — the seatRecords verbs, in their own help (`orchestra fanout seat-help`): the main usage stays byte-identical for a run that does not use them. */
export const SEAT_USAGE = `seatRecords (#585/#587) — switch \`state set --switch seatRecords=on\` (off by default, frozen at the first spawn). On: the plan and the interfaces are declared BEFORE the first spawn.
  orchestra fanout state set --plan <id,id,…> [--run <id>]        declare the run's ticket list (before the first spawn; --plan-add <id,…> appends, also after it)
  orchestra fanout state set <ticket> --depends-on a,b|none       declare the dependencies (none = declared empty)
  orchestra fanout state set <ticket> --interface <text|file|-> [--interface-reason <text>]   the names the dependents use (columns, queries, mutations, events): v1 needs no reason, a change is a new version and needs one; blank refused
  orchestra fanout state set --run-decision <text|file|->      append a decision of the run (coordinator only): every brief carries the decisions verbatim
  orchestra fanout state set <ticket> --follows <up>=<version>[,…]   the interface version a dependent built on (a nomination on an older one is refused with the reason of the change)
  Refused with exit 2, the message starting with its name: [plan-incomplete] (first spawn and --status started|nominated|gated: lists the plan tickets absent from the state, the tickets with no declared dependencies,
  the depended-on tickets with no interface) · [interface-blank] · [interface-reason-missing] · [interface-stale] · [interface-unfollowed] · [follows-invalid] · [plan-frozen] · [decision-blank] · [decision-caller] · [seat-records-off].
  \`state show\` then lists the plan, the interfaces and the tickets that are ready (todo, not started).`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SHA_ARG = /^[0-9a-f]{7,40}$/;
const TREE_OUT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** #512 — the git tree of `sha`: the local object first, else GitHub's commit. null = UNREADABLE — the verdict then stays sha-keyed (never looser, never "no tree"). */
export function treeOfSha(runner: Runner, sha: string, cwd: string, repo: string | null): string | null {
  if (!SHA_ARG.test(sha)) return null;
  const g = runner('git', ['rev-parse', '--verify', '-q', `${sha}^{tree}`], cwd);
  if (g.code === 0 && TREE_OUT.test(g.stdout.trim())) return g.stdout.trim();
  const a = runner('gh', ['api', `repos/${repo ?? '{owner}/{repo}'}/commits/${sha}`], cwd);
  if (a.code !== 0) return null;
  try {
    const t = ((JSON.parse(a.stdout) as { commit?: { tree?: { sha?: unknown } } }).commit?.tree?.sha);
    return typeof t === 'string' && TREE_OUT.test(t) ? t : null;
  } catch { return null; }
}

/** #572 — does `file` exist on `head`: the local object first (a commit we hold answers for sure), else GitHub's contents API. null = UNREADABLE (head not fetched, no gh): the demonstration is then refused saying so, never accepted. */
export function fileOnHead(runner: Runner, head: string, file: string, cwd: string, repo: string | null): boolean | null {
  if (!SHA_ARG.test(head) || file.startsWith('-') || file.startsWith('/')) return null;
  if (runner('git', ['rev-parse', '--verify', '-q', `${head}^{commit}`], cwd).code === 0) { // ls-tree: a REGULAR blob only — a directory (tree) and a symlink (120000, which can point at test code) are not the product file the finding cites; the gh arm refuses them the same way
    const t = runner('git', ['ls-tree', '-z', head, '--', file], cwd);
    const m = t.code === 0 ? /^(\d+) (\w+) [0-9a-f]+\t([^\0]*)\0?/.exec(t.stdout) : null;
    return !!m && m[3] === file && m[2] === 'blob' && (m[1] === '100644' || m[1] === '100755');
  }
  const a = runner('gh', ['api', `repos/${repo ?? '{owner}/{repo}'}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${head}`, '--jq', '.type'], cwd);
  if (a.code === 0) return a.stdout.trim() === 'file';
  return /\b404\b|Not Found/i.test(a.stderr) ? false : null;
}

export interface Parsed { pos: string[]; vals: Record<string, string>; bools: Set<string> }

/** Strict flag parser: an unknown flag is refused (never swallowed as a value or positional). */
export function parseArgs(args: string[], valueFlags: string[], boolFlags: string[]): Parsed {
  const out: Parsed = { pos: [], vals: {}, bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (boolFlags.includes(a)) { out.bools.add(a); continue; }
      if (!valueFlags.includes(a)) throw new FanoutStateError(`unknown flag ${a}`);
      const v = args[i + 1];
      if (v === undefined) throw new FanoutStateError(`${a} needs a value`);
      out.vals[a] = v;
      i++;
    } else out.pos.push(a);
  }
  return out;
}

/** `--built-on UP=<sha>[,UP2=<sha>]` → {UP: sha}. `-` (or empty) clears it. */
function builtOnArg(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of v.split(',').map((x) => x.trim()).filter((x) => x && x !== '-')) {
    const i = part.indexOf('=');
    if (i < 1) throw new FanoutStateError(`--built-on expects <upstream>=<sha>[,…] (got ${JSON.stringify(part)})`);
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** `--finding ID=SEV[,ID2=SEV]` → {ID: SEV}. */
function findingsArg(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of v.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 1) throw new FanoutStateError(`--finding expects <id>=BLOCKING|MAJOR|MINOR[,…] (got ${JSON.stringify(part)})`);
    out[part.slice(0, i)] = part.slice(i + 1).toUpperCase();
  }
  return out;
}
/** The state of a recorded finding, for `state set` / `show`: `(spec,unsettled)` = blocks the merge, `(process)`, `(settled:fixed)`, `(decided)`. */
function findingTags(f: FindingRecord, t: TicketState, spec: { specText: string | null } = t): string {
  const tags = [f.kind === 'process' ? 'process' : '', f.demonstration !== undefined ? (findingDemonstrated(f) ? 'demonstrated' : 'demonstration-refused') : '', f.specSentence !== undefined ? (sentenceAccepted(spec, f) ? 'spec' : 'sentence-not-in-spec') : '', f.settled ? `settled:${f.settled.how}` : f.decision ? 'decided' : (f.specSentence !== undefined && f.severity === 'MINOR' && sentenceAccepted(spec, f)) || findingDemonstrated(f) ? 'unsettled' : ''].filter(Boolean);
  return tags.length ? `(${tags.join(',')})` : '';
}
/** `--settle ID=fixed:<ref>` | `ID=pr-body:<ref>` → {ID: {how, ref}}. */
function settleArg(v: string): Record<string, { how: string; ref: string }> {
  const m = /^([^=]+)=(fixed|pr-body):([\s\S]+)$/.exec(v.trim());
  if (!m) throw new FanoutStateError(`--settle expects <finding id>=fixed:<head or commit> (a code finding) or <finding id>=pr-body:<what the PR body says now> (a process finding) (got ${JSON.stringify(v)})`);
  return { [m[1]]: { how: m[2], ref: m[3].trim() } };
}
/** `--decide ID=<text>` → {ID: {text}} (the recording workspace is added by the caller). */
function decideArg(v: string): Record<string, { text: string }> {
  const i = v.indexOf('=');
  if (i < 1 || !v.slice(i + 1).trim()) throw new FanoutStateError(`--decide expects <finding id>=<the decision> (got ${JSON.stringify(v)})`);
  return { [v.slice(0, i).trim()]: { text: v.slice(i + 1).trim() } };
}
/** #552 — the spec text read at registration: `--spec-text <file|->` (a file, or stdin: a ticket / ledger text), else `--spec <ref>` when the reference IS a readable file. Anything else (a URL, a ledger section) is NOT read: null. */
function readSpecText(ref: string | undefined, explicit: string | undefined, deps: FanoutDeps): { text: string | null; note: string; isFile?: boolean } {
  const read = (file: string): string => {
    const abs = path.resolve(deps.cwd, file);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch (e) { throw new FanoutStateError(`cannot read the spec text ${file}: ${(e as Error).message}`); }
    if (!st.isFile() || st.size > SPEC_TEXT_MAX) throw new FanoutStateError(`spec text ${file} is not a regular file of at most ${SPEC_TEXT_MAX} bytes`);
    return fs.readFileSync(abs, 'utf8');
  };
  if (explicit !== undefined) {
    const text = explicit === '-' ? deps.readStdin() : read(explicit);
    if (!text.trim()) throw new FanoutStateError('--spec-text is empty: nothing to capture');
    return { text, note: '' };
  }
  if (ref === undefined) return { text: null, note: '' };
  let isFile = false;
  try { isFile = fs.statSync(path.resolve(deps.cwd, ref)).isFile(); } catch { /* not a file: a URL / a ledger section */ }
  if (isFile) {
    if (fs.statSync(path.resolve(deps.cwd, ref)).size > SPEC_TEXT_MAX) return { isFile: true, text: null, note: `note: the spec file ${JSON.stringify(ref.slice(0, 80))} is larger than ${SPEC_TEXT_MAX} bytes: its text was NOT captured (give the relevant part with \`state set <ticket> --spec-text <file|->\`)\n` };
    return { isFile: true, text: read(ref), note: '' };
  }
  return { text: null, note: `note: the spec text of ${JSON.stringify(ref.slice(0, 80))} was NOT captured (not a readable file): a finding's specSentence is refused until \`state set <ticket> --spec-text <file|->\` records it\n` };
}

/** #515 — does this ticket owe a writer spawn? spec registered, nothing frozen, not waived, and no live writer (a failed spawn and a claim older than CLAIM_STALE_SEC — the app died mid-spawn — are retried). */
export function needsAcceptor(t: TicketState | undefined, nowIso?: string): boolean {
  if (!t || acceptancePhase(t) !== 'pending') return false;
  const a = t.accept?.acceptor;
  return !a || !!a.error || claimIsStale(a, nowIso ?? new Date().toISOString());
}
export function spawnCall(run: string, ticket: string, deps: Pick<FanoutDeps, 'env'>, replace = false): HostCall {
  const from = (deps.env.ORCHESTRA_WS_ID || deps.env.ORCHESTRA_WS_ID_IDENTITY || '').trim();
  return { route: '/fanoutAcceptance', body: { op: 'spawn', run, ticket, ...(from ? { from } : {}), ...(replace ? { replace: true } : {}) } };
}

/** #554 — after a switch is written: the host re-renders the caller's verified-fanout skill from the switches (best effort; a children's skill is rendered at ITS session start). */
export function skillsCall(run: string, deps: Pick<FanoutDeps, 'env'>): HostCall {
  const from = (deps.env.ORCHESTRA_WS_ID || deps.env.ORCHESTRA_WS_ID_IDENTITY || '').trim();
  return { route: '/fanoutAcceptance', body: { op: 'skills', run, ...(from ? { from } : {}) } };
}

export function homeOf(env: NodeJS.ProcessEnv): string {
  return env.ORCHESTRA_HOME && env.ORCHESTRA_HOME.trim() ? env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
}
export function runOf(p: Parsed, deps: FanoutDeps, mode: 'init' | 'use' | 'write'): { run: string; note: string } {
  const { run, inherited } = resolveFanoutRun(p.vals['--run'], deps.env);
  if (!run) throw new FanoutStateError('no run: pass --run <id> (not inside an Orchestra workspace, so no own run to default to)');
  // #486 — `init` is ALWAYS the caller's own run. A scribe/verifier/worker (no run of its own) reads/updates the coordinator's state: set/show/resume
  // fall back to the parent's run ONLY when no state exists at the own run and one does at the parent's — said on stderr, never for init.
  // `set` (mode 'write') is refused there: an OPS that skipped `init` would write into its parent's state (#486 review MINOR 1) — a scribe passes --run.
  if (mode !== 'init' && inherited) {
    const has = (r: string): boolean => { try { return readState(stateFile(homeOf(deps.env), r)) !== null; } catch { return false; } };
    if (!has(run) && has(inherited)) {
      if (mode === 'write') throw new FanoutStateError(`no fanout state for your own run ${run} — run \`orchestra fanout state init\` first; to update your parent's run ${inherited} (a scribe), pass --run ${inherited}`);
      return { run: inherited, note: `note: no fanout state for your own run ${run}; using your parent's run ${inherited} (pass --run to choose)\n` };
    }
  }
  return { run, note: '' };
}
export function loadOrFail(file: string): FanoutState {
  const s = readState(file);
  if (!s) throw new FanoutStateError(`no state at ${file} — run \`orchestra fanout state init\` first`);
  return s;
}

export function runFanout(args: string[], deps: FanoutDeps): RunResult {
  const [sub, ...rest] = args;
  try {
    if (!sub || sub === '--help' || sub === '-h') return { code: sub ? 0 : 1, stdout: sub ? `${FANOUT_USAGE}\n` : '', stderr: sub ? '' : `${FANOUT_USAGE}\n` };
    if (sub === 'state') return runState(rest, deps);
    if (sub === 'resume') return runResume(rest, deps);
    if (sub === 'seat-help') return { code: 0, stdout: `${SEAT_USAGE}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: `unknown fanout verb "${sub}"\n${FANOUT_USAGE}\n` };
  } catch (e) {
    if (e instanceof SeatRefusal) return { code: 2, stdout: '', stderr: `${e.message}\n` }; // #587: a seatRecords refusal exits 2
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}


function runState(args: string[], deps: FanoutDeps): RunResult {
  const [verb, ...rest] = args;
  if (verb === 'init') {
    const p = parseArgs(rest, ['--run', '--target', '--repo', '--harness', '--switch'], []);
    if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]}`);
    const { run } = runOf(p, deps, 'init');
    const file = stateFile(homeOf(deps.env), run);
    const initNote = p.vals['--switch'] !== undefined ? checkSpawned(deps, run) : '';
    updateState(file, (cur) => {
      if (cur) throw new FanoutStateError(`state already exists at ${file} (run ${cur.run}, ${Object.keys(cur.tickets).length} ticket(s), updated ${cur.updatedAt}) — an earlier vague's, or another coordinator's. Continue it: \`orchestra fanout resume --run ${run}\`; start a fresh one: \`orchestra fanout state init --run <new id>\` (default is your own run ${resolveFanoutRun(undefined, deps.env).run ?? '<id>'}).`);
      return newState(run, { target: p.vals['--target'], repo: p.vals['--repo'] ?? null, ...(p.vals['--switch'] !== undefined ? { switches: parseSwitchAssignments(p.vals['--switch']) } : {}), harness: p.vals['--harness'], now: deps.now() });
    });
    return { code: 0, stdout: `initialised ${file}\n`, stderr: initNote, ...(p.vals['--switch'] !== undefined ? { hostCalls: [skillsCall(run, deps)] } : {}) };
  }
  if (verb === 'set') {
    const p = parseArgs(rest, ['--run', '--status', '--branch', '--pr', '--head', '--verdict', '--depends-on', '--built-on', '--frozen-interface', '--accept-merged', '--finding', '--follow-up-of', '--fixes', '--forget-merge', '--spec', '--spec-text', '--finding-json', '--settle', '--decide', '--implementer', '--verifier', '--json', '--harness', '--switch', '--plan', '--plan-add', '--run-decision', '--interface', '--interface-reason', '--follows'], []);
    const [ticket, ...extra] = p.pos;
    if (p.vals['--switch'] !== undefined) {
      // #554 — run-level: the switches (no ticket, no other flag); refused once the run has spawned
      if (ticket || Object.keys(p.vals).some((k) => k !== '--switch' && k !== '--run')) throw new FanoutStateError('--switch is run-level: `orchestra fanout state set --switch <name>=<value>[,…] [--run <id>]` takes no ticket and no other flag');
      const assign = parseSwitchAssignments(p.vals['--switch']);
      const sr = runOf(p, deps, 'write');
      const sfile = stateFile(homeOf(deps.env), sr.run);
      const spawnNote = checkSpawned(deps, sr.run);
      const snext = updateState(sfile, (cur) => {
        if (!cur) throw new FanoutStateError(`no state at ${sfile} — run \`orchestra fanout state init\` first`);
        return setSwitches(cur, assign, deps.now());
      });
      return { code: 0, stdout: `${switchesLine(snext)}\n`, stderr: sr.note + spawnNote, hostCalls: [skillsCall(sr.run, deps)] };
    }
    if (p.vals['--plan'] !== undefined || p.vals['--plan-add'] !== undefined) {
      // #587 — run-level: the ticket list (no ticket, no other flag); the rules are refused under seatRecords=off
      if (ticket || (p.vals['--plan'] !== undefined && p.vals['--plan-add'] !== undefined) || Object.keys(p.vals).some((k) => k !== '--plan' && k !== '--plan-add' && k !== '--run')) throw new FanoutStateError('--plan is run-level: `orchestra fanout state set --plan <id,id,…> | --plan-add <id,…> [--run <id>]` takes no ticket and no other flag');
      const mode = p.vals['--plan'] !== undefined ? 'declare' : 'add';
      const ids = (p.vals['--plan'] ?? p.vals['--plan-add'] as string).split(',').map((x) => x.trim()).filter(Boolean);
      const pr = runOf(p, deps, 'write');
      const pfile = stateFile(homeOf(deps.env), pr.run);
      const pnext = updateState(pfile, (cur) => {
        if (!cur) throw new FanoutStateError(`no state at ${pfile} — run \`orchestra fanout state init\` first`);
        return setPlan(cur, ids, mode, deps.now());
      });
      return { code: 0, stdout: `plan (#587): ${pnext.plan!.tickets.join(', ')}\n`, stderr: pr.note };
    }
    if (p.vals['--run-decision'] !== undefined) {
      // #587 PR A (I3 v2) — run-level, the COORDINATOR's alone (same guard as `acceptance amend`: the caller's workspace id is the run's); refused under seatRecords=off
      if (ticket || Object.keys(p.vals).some((k) => k !== '--run-decision' && k !== '--run')) throw new FanoutStateError('--run-decision is run-level: `orchestra fanout state set --run-decision <text|file|-> [--run <id>]` takes no ticket and no other flag');
      const text = readTextArg(p.vals['--run-decision'], deps);
      const dr = runOf(p, deps, 'write');
      const caller = (deps.env.ORCHESTRA_WS_ID || deps.env.ORCHESTRA_WS_ID_IDENTITY || '').trim();
      const dfile = stateFile(homeOf(deps.env), dr.run);
      const dnext = updateState(dfile, (cur) => {
        if (!cur) throw new FanoutStateError(`no state at ${dfile} — run \`orchestra fanout state init\` first`);
        // hardening (#588): under the real CLI (index.ts hands the host's /identity answer: `identity` is present) the coordinator must be VOUCHED by the host — an env id alone is forgeable; without the key (a unit test / embedded call) the env id is judged as before
        if (seatRecordsOn(cur) && 'identity' in deps) assertReviewCaller(cur, resolveCaller(cur, deps.env, deps.identity), 'decision-caller');
        if (seatRecordsOn(cur) && caller !== dr.run) throw new SeatRefusal('decision-caller', `only the run's coordinator (${dr.run}) records a run decision${caller ? `, not ${caller}` : ' (no workspace identity: ORCHESTRA_WS_ID is empty)'}`);
        return addDecision(cur, text, caller, deps.now());
      });
      return { code: 0, stdout: `decision ${dnext.decisions!.length} recorded (every brief of the run carries it)\n`, stderr: dr.note };
    }
    if (p.vals['--harness'] !== undefined) {
      // #538 — run-level: the declared integration harness (no ticket); `-` clears it
      if (ticket || Object.keys(p.vals).some((k) => k !== '--harness' && k !== '--run')) throw new FanoutStateError('--harness is run-level: `orchestra fanout state set --harness <ref|-> [--run <id>]` takes no ticket and no other flag');
      const hr = runOf(p, deps, 'write');
      const hfile = stateFile(homeOf(deps.env), hr.run);
      const hnext = updateState(hfile, (cur) => {
        if (!cur) throw new FanoutStateError(`no state at ${hfile} — run \`orchestra fanout state init\` first`);
        return setHarness(cur, p.vals['--harness'] as string, deps.now());
      });
      return { code: 0, stdout: `harness: ${hnext.harness ?? 'none declared (discovery on origin/' + hnext.target + ')'}\n`, stderr: hr.note };
    }
    if (!ticket || extra.length) throw new FanoutStateError('usage: orchestra fanout state set <ticket> [--status s] [--branch b] …');
    const patch: Record<string, unknown> = {};
    if (p.vals['--json'] !== undefined) {
      const text = p.vals['--json'] === '-' ? deps.readStdin() : p.vals['--json'];
      let obj: unknown;
      try { obj = JSON.parse(text); } catch { throw new FanoutStateError('--json is not valid JSON'); }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new FanoutStateError('--json must be an object');
      Object.assign(patch, obj);
    }
    const flagToKey: Record<string, string> = { '--status': 'status', '--branch': 'branch', '--pr': 'pr', '--head': 'head', '--verdict': 'verdict', '--depends-on': 'dependsOn', '--built-on': 'builtOn', '--frozen-interface': 'frozenInterface', '--accept-merged': 'mergedAccepted', '--finding': 'findings', '--follow-up-of': 'followUpOf', '--fixes': 'fixes', '--forget-merge': 'forgetMerge', '--spec': 'spec', '--implementer': 'implementer', '--verifier': 'verifier' };
    for (const [flag, key] of Object.entries(flagToKey)) {
      const v = p.vals[flag];
      if (v === undefined) continue;
      patch[key] = key === 'pr' ? (/^[0-9]+$/.test(v) ? Number(v) : NaN) : key === 'dependsOn' || key === 'fixes' ? v.split(',').map((x) => x.trim()).filter(Boolean) : key === 'findings' ? findingsArg(v) : key === 'builtOn' ? builtOnArg(v) : v;
    }
    if (p.vals['--interface'] !== undefined) patch.interface = readTextArg(p.vals['--interface'], deps);
    if (p.vals['--interface-reason'] !== undefined) patch.interfaceReason = p.vals['--interface-reason'];
    if (p.vals['--follows'] !== undefined) patch.follows = followsArg(p.vals['--follows']);
    if (p.vals['--finding-json'] !== undefined) {
      const text = p.vals['--finding-json'] === '-' ? deps.readStdin() : p.vals['--finding-json'];
      let obj: unknown;
      try { obj = JSON.parse(text); } catch { throw new FanoutStateError('--finding-json is not valid JSON'); }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new FanoutStateError('--finding-json must be an object {<finding id>: {severity, evidence?, kind?, specSentence?, demonstration?, report?}}');
      patch.findings = { ...(typeof patch.findings === 'object' && patch.findings !== null ? patch.findings : {}), ...obj };
    }
    if (p.vals['--settle'] !== undefined) patch.settle = settleArg(p.vals['--settle']);
    let blankDecide: string | null = null; // #589: a blank reason is `[decision-reason-blank]` under seatRecords=on, the old usage error otherwise (checked once the state is read)
    if (p.vals['--decide'] !== undefined) {
      const raw = p.vals['--decide'];
      const bi = raw.indexOf('=');
      if (bi >= 1 && !raw.slice(bi + 1).trim()) blankDecide = raw;
      const d = blankDecide !== null ? { [raw.slice(0, bi).trim()]: { text: '' } } : decideArg(raw);
      patch.decide = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { ...v, by: deps.env.ORCHESTRA_WS_ID?.trim() || 'coordinator' }]));
    }
    const specRead = p.vals['--spec-text'] !== undefined || typeof patch.spec === 'string' ? readSpecText(typeof patch.spec === 'string' ? patch.spec : undefined, p.vals['--spec-text'], deps) : null;
    if (Object.keys(patch).length === 0 && !specRead?.text) throw new FanoutStateError(`nothing to set (settable: ${SETTABLE_KEYS.join(', ')})`);
    const r = runOf(p, deps, 'write');
    const file = stateFile(homeOf(deps.env), r.run);
    // #512 — the content keys are DERIVED here (git, then gh), never typed: the tree of the head and of each upstream head it was built on. Unreadable ⇒ unknown ⇒ sha-keyed.
    const derived: { tree?: string | null; builtOnTree?: Record<string, string>; specText?: string | null; fileOnHead?: (head: string, file: string) => boolean | null } = {};
    const notes: string[] = specRead?.note ? [specRead.note] : [];
    if (specRead && ((specRead.isFile && specRead.text !== null) || p.vals['--spec-text'] !== undefined)) derived.specText = specRead.text; // a spec file that reads to nothing (too big…) or a non-file reference (URL / ledger) leaves the stored text alone (a `--spec-text` excerpt survives a re-registration); a CHANGED reference clears it in applyTicketPatch
    const before = readState(file);
    if (blankDecide !== null && !seatRecordsOn(before)) decideArg(blankDecide); // seatRecords off: the old usage error, unchanged
    if (before && seatRecordsOn(before) && isObj(patch.decide) && Object.keys(patch.decide).length) { // #589: a decision is the coordinator's, vouched by the host; `by` is the vouched id, never what a --json patch says
      const caller = resolveCaller(before, deps.env, deps.identity);
      assertDecideCaller(before, caller);
      patch.decide = Object.fromEntries(Object.entries(patch.decide as Record<string, Record<string, unknown>>).map(([k, v]) => [k, { ...v, by: caller.id }]));
    }
    const repo = before?.repo ?? null;
    if (before && seatRecordsOn(before) && p.vals['--depends-on']?.trim().toLowerCase() === 'none') patch.dependsOn = []; // #587: `--depends-on none` = declared empty (under off `none` stays a ticket id, as before)
    if (typeof patch.head === 'string') {
      derived.tree = treeOfSha(deps.runner, patch.head, deps.cwd, repo);
      if (!derived.tree) notes.push(`note: the tree of head ${patch.head.slice(0, 8)} is unreadable (not fetched? gh?): its verdict stays keyed on the sha, not the content\n`);
    }
    if (typeof patch.findings === 'object' && patch.findings !== null && Object.values(patch.findings).some((f) => typeof f === 'object' && f !== null && 'demonstration' in f)) {
      // #572 (review M1): every existence check (git / gh, up to 60 s) is resolved HERE, before `updateState` takes the state lock — a slow gh inside the lock let a second writer break it (stale 15 s) and lose its write (#512 reads git outside the lock for the same reason)
      const head = typeof patch.head === 'string' ? patch.head : before?.tickets[ticket]?.head ?? null;
      const known = new Map<string, boolean | null>();
      for (const f of Object.values(patch.findings)) {
        const obs = typeof f === 'object' && f !== null ? (f as { demonstration?: { observed?: unknown } }).demonstration?.observed : undefined;
        if (head && typeof obs === 'string') for (const c of citationsOf(obs)) if (isProductPath(c.path) && !known.has(c.path)) known.set(c.path, fileOnHead(deps.runner, head, c.path, deps.cwd, repo));
      }
      derived.fileOnHead = (h, p) => (h === head && known.has(p) ? known.get(p)! : null); // a head that moved between the read and the lock: unreadable, never guessed
    }
    if (patch.builtOn && typeof patch.builtOn === 'object') {
      derived.builtOnTree = {};
      for (const [up, sha] of Object.entries(patch.builtOn as Record<string, unknown>)) {
        const tr = typeof sha === 'string' ? treeOfSha(deps.runner, sha, deps.cwd, repo) : null;
        if (tr) derived.builtOnTree[up] = tr; else notes.push(`note: the tree of ${up}@${String(sha).slice(0, 8)} is unreadable: ${up} stays keyed on the sha\n`);
      }
    }
    let prev: TicketState | undefined;
    const next = updateState(file, (cur) => {
      if (!cur) throw new FanoutStateError(`no state at ${file} — run \`orchestra fanout state init\` first`);
      prev = cur.tickets[ticket];
      return applyTicketPatch(cur, ticket, patch, deps.now(), derived);
    });
    const t = next.tickets[ticket];
    // #515: a ticket that carries a spec and has no live writer, no frozen tests and no waiver gets its `accept-` writer from the HOST (the call is made after the state is on disk).
    const accOn = acceptanceOn(next); // #554: acceptance off — no writer spawn, no frozen-status post, no pending notice
    const hostCalls: HostCall[] = accOn && needsAcceptor(t, deps.now()) ? [spawnCall(r.run, ticket, deps)] : [];
    // a recipient recorded AFTER the freeze (the implementer does not exist at dispatch) still gets the frozen status (path + command), once (#515 review m7)
    const late = (['implementer', 'verifier'] as const).map((k) => t[k]).filter((id, i): id is string => !!id && id !== (prev?.[(['implementer', 'verifier'] as const)[i]] ?? null));
    if (t.acceptance && t.spec && late.length) hostCalls.push({ route: '/fanoutAcceptance', body: { op: 'frozen', run: r.run, ticket, to: [...new Set(late)], ...(deps.env.ORCHESTRA_WS_ID ? { from: deps.env.ORCHESTRA_WS_ID } : {}) } });
    // an unspecified ticket will be refused by `deliver` (acceptance-pending): say so now, not at merge time (#515 review M3)
    const notice = accOn && acceptancePhase(t) === 'unspecified' && t.status !== 'merged' && t.status !== 'dropped' ? `note: ${ticket} has no --spec, nothing frozen and no waiver: \`fanout deliver\` will refuse it (acceptance-pending) — register --spec <ref> (Orchestra spawns its test writer), \`fanout acceptance waive ${ticket} --decision <ledger comment> --reason …\`, or deliver with --no-acceptance-gate\n` : '';
    return { code: 0, stdout: `${ticket}: ${t.status} verdict=${t.verdict} branch=${t.branch ?? '-'} pr=${t.pr ?? '-'} head=${t.head?.slice(0, 8) ?? '-'}${t.tree ? ` tree=${t.tree.slice(0, 8)}` : ''}${t.followUpOf ? ` follow-up-of=${t.followUpOf} fixes=${t.fixes.join(',')}` : ''}${t.specText !== null ? ` spec-text=${t.specText.length}ch` : ''}${t.iface ? ` interface=v${t.iface.version}` : ''}${t.follows && Object.keys(t.follows).length ? ` follows=${Object.entries(t.follows).map(([u, v]) => `${u}@v${v}`).join(',')}` : ''}${Object.keys(t.findings).length ? ` findings=${Object.entries(t.findings).map(([k, v]) => `${k}:${v.severity}${findingTags(v, t, effectiveSpec(next, t))}`).join(',')}` : ''}\n`, stderr: `${r.note}${notes.join('')}${notice}`, ...(hostCalls.length ? { hostCalls } : {}) };
  }
  if (verb === 'show') {
    const p = parseArgs(rest, ['--run'], ['--json']);
    if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]}`);
    const r = runOf(p, deps, 'use');
    const file = stateFile(homeOf(deps.env), r.run);
    const s = loadOrFail(file);
    if (p.bools.has('--json')) return { code: 0, stdout: `${JSON.stringify(s, null, 2)}\n`, stderr: r.note };
    const rows = Object.entries(s.tickets).map(([id, t]) => [id, t.status, t.verdict, t.branch ?? '-', t.pr ? `#${t.pr}` : '-', t.head?.slice(0, 8) ?? '-', t.dependsOn.map((d) => (t.builtOn[d] ? `${d}@${t.builtOn[d].slice(0, 8)}` : d)).join(',') || '-', t.frozenInterface ?? '-']);
    const head = ['ticket', 'status', 'verdict', 'branch', 'pr', 'head', 'dependsOn', 'frozen'];
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
    const harnessLine = s.harness ? `harness (#538): ${s.harness}\n` : '';
    const acc = acceptanceOn(s) ? Object.entries(s.tickets).map(([id, t]) => acceptanceLine(id, t)).filter((l): l is string => l !== null) : [];
    const chk = switchesOf(s).preNominationChecks === 'on' ? Object.entries(s.tickets).filter(([, t]) => t.status !== 'merged' && t.status !== 'dropped').map(([id, t]) => checksLine(id, t)) : [];
    const dem = switchesOf(s).minorPolicy === 'demonstrated' ? demonstratedShow(s) : '';
    return { code: 0, stdout: `run ${s.run} → ${s.repo ? `${s.repo} ` : ''}origin/${s.target}  (updated ${s.updatedAt}${s.reconciledAt ? `, reconciled ${s.reconciledAt}` : ''})\n${switchesLine(s)}\n${harnessLine}${[fmt(head), ...rows.map(fmt)].join('\n')}\n${seatRecordsOn(s) ? seatShow(s) : ''}${dem}${chk.length ? `pre-nomination checks (#564):\n${chk.map((l) => `  ${l}`).join('\n')}\n` : ''}${acc.length ? `acceptance (#515):\n${acc.map((l) => `  ${l}`).join('\n')}\n` : ''}${recordsShow(s)}`, stderr: r.note };
  }
  throw new FanoutStateError(`usage: orchestra fanout state init|set|show\n${FANOUT_USAGE}`);
}

/** `--follows up=2,other=1` → {up: 2, other: 1}. */
function followsArg(v: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of v.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^=]+)=(\d+)$/.exec(part);
    if (!m) throw new FanoutStateError(`--follows expects <upstream>=<interface version>[,…] (got ${JSON.stringify(part)})`);
    out[m[1]] = Number(m[2]);
  }
  if (Object.keys(out).length === 0) throw new FanoutStateError('--follows expects <upstream>=<interface version>[,…]');
  return out;
}
/** `<text|file|->` (--interface, --run-decision): `-` = stdin, an existing regular file = its content, anything else = the text itself (blank stays blank: the state refuses it). */
function readTextArg(v: string, deps: FanoutDeps): string {
  if (v === '-') return deps.readStdin();
  if (v.trim() && !v.includes('\n')) {
    try { const abs = path.resolve(deps.cwd, v); const st = fs.statSync(abs); if (st.isFile() && st.size <= 100_000) return fs.readFileSync(abs, 'utf8'); } catch { /* not a file: the text itself */ }
  }
  return v;
}
/** #587 — `state show` under seatRecords=on: the plan (declared / what is missing), each interface with its version, the tickets ready to start. */
export function seatShow(s: FanoutState): string {
  const missing = planMissing(s);
  const ifs = Object.entries(s.tickets).filter(([, t]) => t.iface).map(([id, t]) => `${id} v${t.iface!.version}${t.iface!.history.length ? ` (${t.iface!.history.length} change${t.iface!.history.length > 1 ? 's' : ''})` : ''}`);
  const ready = readyTickets(s);
  const decisions = s.decisions?.length ? `decisions (#587): ${s.decisions.length}${s.decisions.map((d) => `\n  ${d.n}. ${d.text.replace(/\s+/g, ' ').slice(0, 120)}`).join('')}\n` : '';
  return `plan (#587): ${s.plan ? `${s.plan.tickets.join(', ')} (declared ${s.plan.declaredAt})` : 'not declared'} — ${missing.length ? `INCOMPLETE, ${missing.length} missing: ${missing.join('; ')}` : 'complete'}\n${ifs.length ? `interfaces (#587): ${ifs.join(' · ')}\n` : ''}ready (todo, not started): ${ready.length ? ready.join(', ') : missing.length ? 'none — the plan is incomplete' : 'none'}\n${decisions}`;
}

/** #589 — `state show` under seatRecords=on: per ticket the recorded reviews (reviewer, head, word, the OPEN counts derived from its findings). Empty = nothing (the switch off prints nothing: byte-identical). */
export function recordsShow(s: FanoutState): string {
  if (!seatRecordsOn(s)) return '';
  const rows = Object.entries(s.tickets).filter(([, t]) => t.review?.reviewer || (t.reviews ?? []).length).map(([id, t]) => {
    const last = (t.reviews ?? [])[(t.reviews ?? []).length - 1];
    if (!last) return `${id}  reviewer ${t.review?.reviewer?.name ?? '?'} (${t.review?.reviewer?.id ?? 'not spawned'}): NO verdict recorded yet`;
    const c = countsThrough(t, last.n);
    return `${id}  round ${last.n} by ${last.reviewer} on ${last.head.slice(0, 8)}: ${last.verdict} — ${c.blocking} BLOCKING / ${c.major} MAJOR / ${c.minor} MINOR open${c.open.length ? ` (${c.open.join(', ')})` : ''}`;
  });
  return rows.length ? `recorded reviews (#589):\n${rows.map((l) => `  ${l}`).join('\n')}\n` : 'recorded reviews (#589): none yet\n';
}

/** #572 — `state show` under minorPolicy=demonstrated: per ticket the OPEN demonstrated findings (they block gate + deliver), then the demonstrations code refused (recorded with the reason). Empty text = nothing to say. */
export function demonstratedShow(s: FanoutState): string {
  const lines: string[] = [];
  for (const [id, t] of Object.entries(s.tickets)) {
    for (const d of demonstratedFindings(t).filter((x) => x.end === 'open' && t.status !== 'merged' && !t.mergedHead)) lines.push(`${id}/${d.finding}  ${d.severity}  OPEN  ${d.file} @${d.head.slice(0, 8)}  input: ${d.input.replace(/\s+/g, ' ').trim().slice(0, 100)}  → state set ${id} --settle ${d.finding}=fixed:<head> | --decide ${d.finding}=<text>`);
    for (const r of refusedDemonstrations(t)) lines.push(`${id}/${r.finding}  demonstration REFUSED (stays a plain ${t.findings[r.finding].severity}): ${r.refusal}`);
  }
  return lines.length ? `demonstrated findings (#572) — open ones block gate + deliver:\n${lines.map((l) => `  ${l}`).join('\n')}\n` : `demonstrated findings (#572): none open\n`;
}

/** #564 — a ticket's pre-nomination check record for its CURRENT head's tree: passing / failing (the commands) / vacuous / none yet. */
export function checksLine(id: string, t: TicketState): string {
  const rec = t.tree ? t.checks?.[t.tree] : undefined;
  if (!t.head) return `${id}  no head recorded`;
  if (!rec) return `${id}  no record for ${t.head.slice(0, 8)}${t.tree ? ` (tree ${t.tree.slice(0, 8)})` : ' (tree unreadable)'}: \`orchestra fanout check ${id}\``;
  if (rec.ok) return `${id}  pass  tree ${rec.tree.slice(0, 8)}  ${rec.vacuous ? 'vacuous (nothing to run)' : `${rec.results.length} command(s)`}  ${rec.at}${rec.overrideChanged ? '  [override file changed by this candidate]' : ''}${rec.uncovered.length ? `  [${rec.uncovered.length} changed file(s) not linted: ${rec.uncovered.slice(0, 3).join(', ')}${rec.uncovered.length > 3 ? ', …' : ''}]` : ''}`;
  if (rec.nothingFound) return `${id}  FAIL  tree ${rec.tree.slice(0, 8)}  nothing found (${rec.changed} changed file(s), no lint script, no override file)`;
  return `${id}  FAIL  tree ${rec.tree.slice(0, 8)}  ${rec.results.filter((r) => r.exit !== 0 || r.timedOut).map((r) => `${r.timedOut ? 'timeout' : `exit ${r.exit}`}: ${r.run}`).join('; ')}`;
}

/** One line per ticket with an acceptance story: where the frozen tests are + the run command, or what it waits for / why it is waived. null = nothing forced. */
export function acceptanceLine(id: string, t: TicketState): string | null {
  const ph = acceptancePhase(t);
  if (ph === 'none') return null;
  if (ph === 'unspecified') return t.status === 'merged' || t.status === 'dropped' ? null : `${id}  unspecified  no --spec, nothing frozen, not waived: \`fanout deliver\` refuses (acceptance-pending) — set --spec, \`fanout acceptance waive\`, or deliver with --no-acceptance-gate`;
  if (ph === 'frozen') {
    const a = t.acceptance!;
    return `${id}  frozen  ${a.source.branch ?? '-'}@${a.source.head.slice(0, 12)}  files: ${Object.keys(a.files).join(', ')}  run: ${a.run}`;
  }
  if (ph === 'waived') return `${id}  waived  ${t.accept!.waived!.decision} — ${t.accept!.waived!.reason}`;
  const w = t.accept?.acceptor;
  const wait = t.accept?.wait;
  return `${id}  pending  writer: ${w ? `${w.name}${w.id ? ` (${w.id})` : ''}${w.error ? ` — spawn failed: ${w.error}` : w.id ? '' : ' (spawning)'}` : 'none yet (`fanout acceptance spawn`)'}${wait ? `  gate waits until ${wait.deadline} (bound ${wait.boundSec}s)` : ''}`;
}

/** Read git + gh for every ticket that names a branch or a PR. A failed read is recorded as `error` (UNKNOWN), never as absence. */
export function gatherReality(state: FanoutState, runner: Runner, cwd: string, opts: { fetch: boolean }): Reality {
  const reality: Reality = {};
  let fetchError: string | undefined;
  if (opts.fetch) {
    const f = runner('git', ['fetch', '--quiet', 'origin'], cwd);
    if (f.code !== 0) fetchError = `git fetch origin: exit ${f.code}`;
  }
  const ancestor = (sha: string): boolean | string => {
    const r = runner('git', ['merge-base', '--is-ancestor', sha, `origin/${state.target}`], cwd);
    if (r.code === 0) return true;
    if (r.code === 1) return !fetchError ? false : `${fetchError} (ancestry of ${sha.slice(0, 8)} unverified)`;
    return `git merge-base --is-ancestor ${sha.slice(0, 8)} origin/${state.target}: exit ${r.code}`;
  };
  for (const [id, t] of Object.entries(state.tickets)) {
    if (t.status === 'todo' || t.status === 'dropped') continue;
    const r: TicketReality = {};
    const errs: string[] = [];
    if (!t.branch && !t.pr) {
      if (t.status === 'merged') errs.push('merged with no branch or PR recorded: nothing to verify');
      if (errs.length) { r.error = errs.join('; '); reality[id] = r; }
      continue;
    }
    if (t.branch) {
      const l = runner('git', ['ls-remote', '--heads', 'origin', `refs/heads/${t.branch}`], cwd);
      if (l.code !== 0) errs.push(`git ls-remote ${t.branch}: exit ${l.code}`);
      else {
        r.branchHead = l.stdout.trim() ? l.stdout.trim().split(/\s+/)[0] : null;
        if (r.branchHead) r.branchTree = r.branchHead === t.head ? t.tree : treeOfSha(runner, r.branchHead, cwd, state.repo); // #512: only a moved tip needs its content read
      }
    }
    const probe = r.branchHead ?? t.head;
    if (t.status === 'merged' && !probe && !t.pr && errs.length === 0) errs.push('merged with no head or PR recorded and the branch gone: nothing to verify');
    if (probe && errs.length === 0) {
      const a = ancestor(probe);
      if (typeof a === 'string') errs.push(a);
      else r.mergedIntoTarget = a;
    }
    if (t.pr) {
      const g = runner('gh', ['pr', 'view', String(t.pr), ...(state.repo ? ['-R', state.repo] : []), '--json', 'state,headRefOid,baseRefName'], cwd);
      if (g.code !== 0) errs.push(`gh pr view ${t.pr}: exit ${g.code}`);
      else {
        try {
          const j = JSON.parse(g.stdout) as { state?: string; headRefOid?: string; baseRefName?: string };
          if (j.state !== 'OPEN' && j.state !== 'MERGED' && j.state !== 'CLOSED') errs.push(`gh pr view ${t.pr}: unexpected state ${JSON.stringify(j.state)}`);
          else if (typeof j.baseRefName !== 'string' || !j.baseRefName) errs.push(`gh pr view ${t.pr}: no baseRefName (cannot tell which branch it merged into)`);
          else {
            r.pr = { state: j.state, headRefOid: j.headRefOid ?? null, baseRefName: j.baseRefName };
            if (j.headRefOid) r.prTree = j.headRefOid === t.head ? t.tree : treeOfSha(runner, j.headRefOid, cwd, state.repo);
          }
        } catch { errs.push(`gh pr view ${t.pr}: unparseable output`); }
      }
    }
    if (errs.length) r.error = errs.join('; ');
    reality[id] = r;
  }
  return reality;
}

function runResume(args: string[], deps: FanoutDeps): RunResult {
  const p = parseArgs(args, ['--run', '--cwd'], ['--no-fetch', '--no-write', '--json']);
  if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]}`);
  const r = runOf(p, deps, 'use');
  const file = stateFile(homeOf(deps.env), r.run);
  const out: string[] = [];
  // 1/5 load
  const state = loadOrFail(file);
  out.push(`resume ${state.run} → ${state.repo ? `${state.repo} ` : ''}origin/${state.target}`, `1/5 load        ${file}: ${Object.keys(state.tickets).length} ticket(s)`);
  // 2/5 reconcile
  const cwd = p.vals['--cwd'] ? path.resolve(deps.cwd, p.vals['--cwd']) : deps.cwd;
  const reality = gatherReality(state, deps.runner, cwd, { fetch: !p.bools.has('--no-fetch') });
  const plan = reconcile(state, reality);
  out.push(`2/5 reconcile   ${plan.divergences.length} divergence(s)`);
  for (const d of plan.divergences) out.push(`    ! ${d.ticket} ${d.kind}: ${d.detail}`);
  // 3/5 classify
  const counts: Record<string, number> = {};
  for (const t of Object.values(plan.tickets)) counts[t.class] = (counts[t.class] ?? 0) + 1;
  out.push(`3/5 classify    ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ') || '(no tickets)'}`);
  // 4/5 next action
  out.push('4/5 next action');
  for (const [id, t] of Object.entries(plan.tickets)) out.push(`    ${id.padEnd(10)} ${t.class.padEnd(14)} ${t.next.action.padEnd(32)} ${t.next.detail}`);
  // #589 — seatRecords=on: a recorded reviewer that has not recorded its head's verdict leaves the ticket refused; say who to wake / replace (alive or dead, one verb)
  const unrec = unrecordedReviewers(state);
  for (const u of unrec) out.push(`    ! ${u.ticket.padEnd(10)} reviewer-no-record              ${u.line}`);
  // 5/5 write back
  let wrote = 'skipped (--no-write)';
  if (!p.bools.has('--no-write')) {
    const now = deps.now();
    updateState(file, (cur) => applyWriteBack(cur ?? state, plan.writeBack, now));
    wrote = plan.writeBack.length ? plan.writeBack.map((w) => `${w.ticket}: ${w.why}`).join('; ') : 'nothing to correct; reconciledAt stamped';
  }
  out.push(`5/5 write back  ${wrote}`);
  const code = plan.divergences.length ? 2 : 0;
  if (p.bools.has('--json')) return { code, stdout: `${JSON.stringify({ run: state.run, divergences: plan.divergences, tickets: plan.tickets, writeBack: plan.writeBack, ...(seatRecordsOn(state) ? { reviewersWithoutRecord: unrec } : {}) }, null, 2)}\n`, stderr: r.note };
  return { code, stdout: `${out.join('\n')}\n`, stderr: r.note };
}
