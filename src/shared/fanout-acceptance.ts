// #510 — frozen acceptance tests: the PURE half. State transitions (freeze / amend), the amend decision check, the gate's receipt and
// deliver's receipt verdict. I/O (git, gh, fs, running the command) lives in src/cli/fanout-acceptance.ts; the state schema in fanout-state.ts.
import {
  FanoutStateError,
  acceptanceHash,
  assertAcceptancePath,
  blankTicket,
  parseRunArgv,
  type AcceptFlow,
  type Acceptance,
  type FanoutState,
  type TicketState,
} from './fanout-state.ts';
import { harnessBriefLines, type ResolvedHarness } from './fanout-harness.ts';

export const MIN_SPEC_SENTENCE = 12;

export type AcceptanceReason = 'frozen-test-changed' | 'frozen-test-failed' | 'acceptance-unproven' | 'acceptance-stale-checkout';
export type DeliverAcceptanceReason = 'frozen-test-changed' | 'frozen-test-failed' | 'acceptance-unproven' | 'acceptance-stale';

/** The gate's proof for ONE head. #512: it is keyed on CONTENT — `tree` (git tree of `head`) and `ticket` bind it to what was run; both optional so an older receipt (head-only) still parses and stays head-keyed. */
export interface Receipt { head: string; hash: string; ok: boolean; tree?: string; ticket?: string }
export interface FileStatus { path: string; status: 'same' | 'changed' | 'missing' }
/** What `fanout gate` prints under `acceptance` (frozen interface, #511). */
export interface GateAcceptance {
  ok: boolean;
  hash: string;
  files: FileStatus[];
  ran: { cmd: string; exit: number } | null;
  receipt: Receipt;
  reason?: AcceptanceReason;
  detail?: string;
}

/** Whitespace-normalised, for matching a spec sentence inside a decision body. */
export const normaliseSentence = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function parseFileList(v: string): string[] {
  const out = v.split(',').map((x) => x.trim()).filter(Boolean);
  if (out.length === 0) throw new FanoutStateError('--files needs at least one path');
  for (const p of out) assertAcceptancePath(p);
  if (new Set(out).size !== out.length) throw new FanoutStateError('--files lists a path twice');
  return out;
}

function ticketOf(state: FanoutState, id: string): TicketState | undefined {
  return state.tickets[id];
}

// ── #515: the forced flow (auto-spawned writer, gate wait, deliver pending, waiver) ─────────────────────────────

/** none = no such ticket · waived = coordinator escape recorded · frozen = tests frozen · pending = spec registered, nothing frozen, not waived (a writer is owed) ·
 *  unspecified = no spec, nothing frozen, not waived (no writer will come: `deliver` refuses until it is frozen, waived or `--no-acceptance-gate`d — #515 review M3). */
export type AcceptancePhase = 'none' | 'waived' | 'frozen' | 'pending' | 'unspecified';
export function acceptancePhase(t: TicketState | undefined): AcceptancePhase {
  if (!t) return 'none';
  if (t.acceptance) return 'frozen';
  if (t.accept?.waived) return 'waived';
  return t.spec ? 'pending' : 'unspecified';
}

/** How long a gate waits for the freeze by default (s): under the 10-minute ceiling of a foreground tool call. `--accept-wait <s>` overrides (0 = do not wait). */
export const GATE_WAIT_DEFAULT_SEC = 480;
export const GATE_WAIT_MAX_SEC = 3600;

/** The ONE shared branch the frozen tests are published to (outside what the target's CI runs). */
export const acceptanceBranch = (run: string): string => `acceptance/${run}`;

/** `accept-<ticket>`: a spawn name the naming policy accepts (letters, digits, . _ - only). */
export function acceptorName(ticket: string): string {
  const slug = ticket.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.{2,}/g, '.').slice(0, 60);
  return `accept-${slug || 'ticket'}`;
}

const withAccept = (t: TicketState, f: Partial<AcceptFlow>): AcceptFlow => ({ acceptor: null, wait: null, waived: null, ...(t.accept ?? {}), ...f });

/** The writer's brief: the spec + the ticket ONLY — never an implementer branch (the writer must derive the tests from the spec, not from the code).
 *  #538: `harness` (declared | discovered | none — fanout-harness.ts) adds the repo's integration harness + its two requirements (full-module boot, per-test execution context);
 *  absent or `none` keeps the self-contained wording byte-identical (none adds ONE line saying so). */
export function acceptorBrief(o: { run: string; ticket: string; spec: string; repo: string | null; target: string; harness?: ResolvedHarness | null }): string {
  const h = o.harness ?? null;
  const withHarness = h !== null && h.source !== 'none';
  return [
    `You write the frozen ACCEPTANCE TESTS of ticket ${o.ticket} (vague run ${o.run}). Orchestra spawned you; you never see the implementer's code, and nobody waits for you: the implementer starts at dispatch.`,
    `Spec: ${o.spec}  (read the spec and the ticket ${o.ticket} — nothing else: do NOT read any implementer branch or PR for this ticket).`,
    withHarness
      ? `Write tests that fail without the feature and pass with it, derived from the spec's sentences, as test files of your own (they import the production code by path and the repo's integration harness below; no other helper, config or fixture outside the files you freeze). Commit them in your worktree.`
      : `Write tests that fail without the feature and pass with it, derived from the spec's sentences, as self-contained files (they import the production code by path; no helper, config or fixture outside the files you freeze). Commit them in your worktree.`,
    ...(h ? harnessBriefLines(h, o.target) : []),
    `Then freeze them: \`orchestra fanout acceptance freeze ${o.ticket} --run ${o.run} --files <p1,p2,…> --run-cmd "<runner> <the same paths>"\` — a DIRECT runner call (e.g. \`node --test tests/x.test.ts\`; \`orchestra fanout acceptance --help\` lists the runners). It publishes the files to branch ${acceptanceBranch(o.run)}${o.repo ? ` of ${o.repo}` : ''} and tells the ticket's implementer and verifier the path + command.`,
    `Finish with ONE \`orchestra send --type worker_done\` to your parent. You may freeze only ticket ${o.ticket}.`,
  ].join('\n');
}

/** The bus status the host posts to the ticket's implementer and verifier when the freeze lands. */
export function frozenStatusText(o: { run: string; ticket: string; files: string[]; runCmd: string; branch: string; head: string }): string {
  return `acceptance tests of ${o.ticket} are FROZEN @ ${o.head.slice(0, 12)} on ${o.branch}: ${o.files.join(', ')}. Run: ${o.runCmd}. Implementer: \`git fetch origin ${o.branch} && git checkout origin/${o.branch} -- ${o.files.join(' ')}\` (copy unchanged; do not edit). Verifier: \`fanout gate --ticket ${o.ticket} --run ${o.run} --cwd <checkout>\` runs them (a gate that waited resumes now).`;
}

/** Who the freeze status goes to: the ticket's implementer and verifier, de-duplicated, never the writer itself. */
export function frozenRecipients(t: TicketState, writer: string | null): string[] {
  return [...new Set([t.implementer, t.verifier].filter((x): x is string => !!x && x !== writer))];
}

/** A claim (`acceptor.id` null, no error) older than this is a spawn that never settled (the app died mid-spawn): it is re-claimable. */
export const CLAIM_STALE_SEC = 300;
export function claimIsStale(a: { id: string | null; error?: string; at: string }, nowIso: string): boolean {
  return a.id === null && !a.error && Date.parse(nowIso) - Date.parse(a.at) > CLAIM_STALE_SEC * 1000;
}

/** Claim the ticket's writer slot (id null = spawn in flight). Throws when a live writer already exists / the tests are frozen / waived / no spec.
 *  A failed or stale claim is retaken; `replace` (the coordinator's `acceptance spawn --replace`: its writer died, was archived…) retakes a settled one too. */
export function claimAcceptor(state: FanoutState, id: string, name: string, now: string, o: { replace?: boolean } = {}): FanoutState {
  const t = state.tickets[id];
  if (!t) throw new FanoutStateError(`ticket ${id} is not in the fanout state`);
  if (!t.spec) throw new FanoutStateError(`${id}: no spec registered (\`state set ${id} --spec <file|url|ledger section>\`) — the writer's brief is the spec`);
  if (t.acceptance) throw new FanoutStateError(`${id}: acceptance tests are already frozen`);
  if (t.accept?.waived) throw new FanoutStateError(`${id}: acceptance is waived (${t.accept.waived.decision})`);
  const a = t.accept?.acceptor;
  if (a && !a.error && !o.replace && !claimIsStale(a, now)) throw new FanoutStateError(`${id}: a writer was already spawned (${a.name}${a.id ? ` ${a.id}` : ', spawn in flight'})`);
  return { ...state, tickets: { ...state.tickets, [id]: { ...t, accept: withAccept(t, { acceptor: { id: null, name, at: now } }), updatedAt: now } }, updatedAt: now };
}
/** Record the spawn's outcome: the writer's id, or the error (the slot stays retryable). */
export function settleAcceptor(state: FanoutState, id: string, r: { id: string } | { error: string }, now: string): FanoutState {
  const t = state.tickets[id];
  const a = t?.accept?.acceptor;
  if (!t || !a) return state;
  const acceptor = 'id' in r ? { id: r.id, name: a.name, at: now } : { id: null, name: a.name, at: a.at, error: r.error.slice(0, 500) };
  return { ...state, tickets: { ...state.tickets, [id]: { ...t, accept: withAccept(t, { acceptor }), updatedAt: now } }, updatedAt: now };
}

/** Coordinator-only escape for a ticket that cannot have acceptance tests (with or without a registered spec). Refused once tests are frozen. */
export function waiveInto(state: FanoutState, id: string, w: { decision: string; reason: string; now: string }): FanoutState {
  const t = state.tickets[id];
  if (!t) throw new FanoutStateError(`ticket ${id} is not in the fanout state`);
  if (t.acceptance) throw new FanoutStateError(`${id}: acceptance tests are frozen — there is nothing to waive (amend them with a ledger decision)`);
  if (t.accept?.waived) throw new FanoutStateError(`${id}: already waived (${t.accept.waived.decision})`);
  if (!w.reason.trim()) throw new FanoutStateError('a waiver needs --reason');
  return { ...state, tickets: { ...state.tickets, [id]: { ...t, accept: withAccept(t, { wait: null, waived: { decision: w.decision, reason: w.reason.trim(), at: w.now } }), updatedAt: w.now } }, updatedAt: w.now };
}

/** `deliver --no-acceptance-gate` leaves its trace on the ticket (a coordinator escape is never silent): the same record a waiver writes, with the bypass as the decision. */
export function bypassInto(state: FanoutState, id: string, b: { head: string; now: string }): FanoutState {
  const t = state.tickets[id];
  if (!t || t.acceptance || t.accept?.waived) return state;
  return { ...state, tickets: { ...state.tickets, [id]: { ...t, accept: withAccept(t, { wait: null, waived: { decision: 'deliver --no-acceptance-gate', reason: `merged without frozen acceptance tests at ${b.head.slice(0, 12)}`, at: b.now } }), updatedAt: b.now } }, updatedAt: b.now };
}

/** The gate's wait window for a ticket pending its freeze: reuse a still-open window (a concurrent gate), else open a new one of `boundSec`. */
export function openWait(state: FanoutState, id: string, boundSec: number, nowMs: number): { state: FanoutState; wait: NonNullable<AcceptFlow['wait']> } {
  const t = state.tickets[id];
  if (!t) throw new FanoutStateError(`ticket ${id} is not in the fanout state`);
  const cur = t.accept?.wait;
  if (cur && Date.parse(cur.deadline) > nowMs) return { state, wait: cur };
  const wait = { since: new Date(nowMs).toISOString(), deadline: new Date(nowMs + boundSec * 1000).toISOString(), boundSec };
  return { state: { ...state, tickets: { ...state.tickets, [id]: { ...t, accept: withAccept(t, { wait }) } } }, wait };
}

/** Record the frozen set on `id` (creating the ticket, like `state set`). Refused when one is already frozen: that is an amend. */
export function freezeInto(
  state: FanoutState, id: string,
  f: { files: Record<string, string>; run: string; source: Acceptance['source']; now: string },
): FanoutState {
  const cur = ticketOf(state, id);
  if (cur?.acceptance) throw new FanoutStateError(`${id}: acceptance tests are already frozen (hash ${cur.acceptance.hash.slice(0, 12)}) — change them with \`orchestra fanout acceptance amend\` (coordinator, ledger decision)`);
  if (Object.keys(f.files).length === 0) throw new FanoutStateError('no files to freeze');
  parseRunArgv(f.run, Object.keys(f.files));
  const acceptance: Acceptance = { files: f.files, hash: acceptanceHash(f.files, f.run), run: f.run, source: f.source, frozenAt: f.now, amendments: [] };
  const base: TicketState = cur ?? blankTicket(f.now);
  return { ...state, tickets: { ...state.tickets, [id]: { ...base, acceptance, ...(base.accept?.wait ? { accept: { ...base.accept, wait: null } } : {}), updatedAt: f.now } }, updatedAt: f.now };
}

/** Replace the frozen set (D3): appends `{at, decision, specSentence, hashBefore, hashAfter}`. A no-op amend is refused. */
export function amendInto(
  state: FanoutState, id: string,
  a: { files: Record<string, string>; decision: string; specSentence: string; bodySha256: string; source: Acceptance['source']; run?: string; now: string },
): FanoutState {
  const cur = ticketOf(state, id);
  if (!cur) throw new FanoutStateError(`ticket ${id} is not in the fanout state`);
  const acc = cur.acceptance;
  if (!acc) throw new FanoutStateError(`${id}: no frozen acceptance tests to amend — freeze first (\`orchestra fanout acceptance freeze\`)`);
  const run = a.run ?? acc.run;
  const hashAfter = acceptanceHash(a.files, run);
  if (hashAfter === acc.hash) throw new FanoutStateError(`${id}: the amendment changes nothing (same files, same command: hash ${acc.hash.slice(0, 12)})`);
  // one decision = one comment, however its URL is spelled (issues/pull, case, number): keyed on lower-cased repo + NUMERIC comment id (`-0900` ≡ `-900`)
  const key = (u: string): string => { const m = /^repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(decisionApiPath(u) ?? ''); return m ? `${m[1].toLowerCase()}#${Number(m[2])}` : u.toLowerCase(); };
  if (acc.amendments.some((m) => key(m.decision) === key(a.decision))) throw new FanoutStateError(`${id}: this decision already authorised an amendment (${a.decision}) — one decision, one amendment: record a new ledger decision`);
  parseRunArgv(run, Object.keys(a.files));
  const next: Acceptance = {
    ...acc, files: a.files, hash: hashAfter, run, source: a.source,
    amendments: [...acc.amendments, { at: a.now, decision: a.decision, specSentence: a.specSentence, bodySha256: a.bodySha256, hashBefore: acc.hash, hashAfter, ...(run !== acc.run ? { runAfter: run } : {}) }],
  };
  return { ...state, tickets: { ...state.tickets, [id]: { ...cur, acceptance: next, updatedAt: a.now } }, updatedAt: a.now };
}

/** `https://github.com/<o>/<r>/(issues|pull)/<n>#issuecomment-<id>` → the API path of that comment. null = not a ledger comment URL. */
export function decisionApiPath(url: string): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/\d+#issuecomment-(\d+)$/.exec(url.trim());
  return m ? `repos/${m[1]}/${m[2]}/issues/comments/${m[3]}` : null;
}

/** Does the (gh-read) decision body contain the spec sentence? Whitespace-normalised, sentence ≥ MIN_SPEC_SENTENCE chars. */
export function decisionNamesSentence(body: string, sentence: string): { ok: true } | { ok: false; why: string } {
  const s = normaliseSentence(sentence);
  if (s.length < MIN_SPEC_SENTENCE) return { ok: false, why: `--spec-sentence is ${s.length} chars after whitespace normalisation (min ${MIN_SPEC_SENTENCE}): quote the spec sentence that justifies the change` };
  // a quoted sentence (`> …` per line, markdown) still counts: strip the quote markers before matching
  if (!normaliseSentence(body.replace(/^[ \t]*>+[ \t]?/gm, '')).includes(s)) return { ok: false, why: 'the decision comment does not contain the spec sentence (whitespace-normalised): the decision must quote it' };
  return { ok: true };
}

/** Gate-side verdict from the facts read in the candidate checkout (D1/D2). Pure: the I/O already happened. */
export function decideGateAcceptance(acc: Acceptance, facts: {
  cwdGiven: boolean; cwdHead: string | null; head: string; dirty: string[]; files: FileStatus[]; run: () => { cmd: string; exit: number };
  /** #512 — tree of the checkout's HEAD (null = unread) and the ticket the gate was asked about: both go into the receipt. */
  cwdTree?: string | null; ticket?: string;
}): GateAcceptance {
  const receipt = (ok: boolean): Receipt => ({ head: facts.head, hash: acc.hash, ok, ...(facts.cwdTree ? { tree: facts.cwdTree } : {}), ...(facts.ticket ? { ticket: facts.ticket } : {}) });
  const refuse = (reason: AcceptanceReason, detail: string, files: FileStatus[] = facts.files, ran: GateAcceptance['ran'] = null): GateAcceptance =>
    ({ ok: false, hash: acc.hash, files, ran, receipt: receipt(false), reason, detail });
  if (!facts.cwdGiven) return refuse('acceptance-unproven', 'this ticket has frozen acceptance tests: pass --cwd <the candidate checkout> (they are run and hashed there)', []);
  if (!facts.cwdHead) return refuse('acceptance-unproven', '--cwd is not the root of a git checkout (git rev-parse HEAD / --show-toplevel): the head it holds cannot be proven', []);
  if (facts.cwdHead !== facts.head) return refuse('acceptance-stale-checkout', `--cwd is at ${facts.cwdHead.slice(0, 12)}, not --head ${facts.head.slice(0, 12)}: check out the verified head`, []);
  if (facts.dirty.length) return refuse('acceptance-stale-checkout', `--cwd has uncommitted changes to tracked files (${facts.dirty.slice(0, 5).join(', ')}): the run would not be of --head`, []);
  const bad = facts.files.filter((f) => f.status !== 'same');
  if (bad.length) return refuse('frozen-test-changed', `frozen test file(s) differ from the frozen bytes at ${facts.head.slice(0, 12)}: ${bad.slice(0, 8).map((f) => `${f.path} (${f.status})`).join(', ')}`);
  const ran = facts.run(); // only after the bytes are proven: a changed test is never executed
  if (ran.exit !== 0) return refuse('frozen-test-failed', `\`${ran.cmd}\` exited ${ran.exit}`, facts.files, ran);
  return { ok: true, hash: acc.hash, files: facts.files, ran, receipt: receipt(true) };
}

/** A receipt file: the gate's `acceptance.receipt` itself, or the whole gate JSON line (its `acceptance.receipt`). */
export function parseReceipt(text: string): { ok: true; receipt: Receipt } | { ok: false; error: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'receipt is not valid JSON' }; }
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  const r = ((o?.acceptance as Record<string, unknown> | undefined)?.receipt ?? o) as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.head !== 'string' || !/^[0-9a-f]{40}$/.test(r.head) || typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash) || typeof r.ok !== 'boolean') {
    return { ok: false, error: 'receipt must be {"head":"<40-hex>","hash":"<sha256>","ok":true|false} (the gate\'s acceptance.receipt)' };
  }
  if (r.tree !== undefined && (typeof r.tree !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.tree))) return { ok: false, error: 'receipt "tree" must be a full hex git tree sha' };
  if (r.ticket !== undefined && (typeof r.ticket !== 'string' || !r.ticket)) return { ok: false, error: 'receipt "ticket" must be a non-empty string' };
  return { ok: true, receipt: { head: r.head, hash: r.hash, ok: r.ok, ...(r.tree !== undefined ? { tree: r.tree as string } : {}), ...(r.ticket !== undefined ? { ticket: r.ticket as string } : {}) } };
}

/** Deliver-side verdict on the receipt alone (the gh byte re-read is separate). `receipt` null = none given.
 *  #512: the receipt speaks about CONTENT — it holds for `verifiedHead` when it was issued for that sha OR for a head with the same git tree (`headTree` = the tree of
 *  `verifiedHead` as GitHub reports it; null = unread ⇒ sha-keyed) and, when it names a ticket, for THIS ticket. A changed frozen set / command (hash) stays `acceptance-stale`. */
export function decideDeliverReceipt(acc: Acceptance, receipt: Receipt | null, verifiedHead: string, ctx: { headTree?: string | null; ticket?: string } = {}): { ok: true } | { ok: false; reason: DeliverAcceptanceReason; detail: string } {
  if (!receipt) return { ok: false, reason: 'acceptance-unproven', detail: "this ticket has frozen acceptance tests: pass --acceptance <receipt.json> (the gate's acceptance.receipt for this head)" };
  if (receipt.ticket !== undefined && ctx.ticket !== undefined && receipt.ticket !== ctx.ticket) return { ok: false, reason: 'acceptance-stale', detail: `the receipt is for ticket ${receipt.ticket}, not ${ctx.ticket}: a verdict is bound to the ticket it was issued for` };
  if (receipt.head !== verifiedHead && !(receipt.tree && ctx.headTree && receipt.tree === ctx.headTree)) {
    return { ok: false, reason: 'acceptance-stale', detail: `the receipt is for head ${receipt.head.slice(0, 12)}${receipt.tree ? ` (tree ${receipt.tree.slice(0, 12)})` : ''}, not the verified head ${verifiedHead.slice(0, 12)}${ctx.headTree ? ` (tree ${ctx.headTree.slice(0, 12)})` : ''}: the content differs — re-run \`fanout gate\` on this head` };
  }
  if (receipt.hash !== acc.hash) return { ok: false, reason: 'acceptance-stale', detail: `the receipt is for frozen set ${receipt.hash.slice(0, 12)} but the state's is ${acc.hash.slice(0, 12)} (amended since): re-run \`fanout gate\`` };
  if (!receipt.ok) return { ok: false, reason: 'frozen-test-failed', detail: 'the gate receipt says the frozen tests did not pass (ok:false)' };
  return { ok: true };
}
