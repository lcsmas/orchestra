// #510 — frozen acceptance tests: the PURE half. State transitions (freeze / amend), the amend decision check, the gate's receipt and
// deliver's receipt verdict. I/O (git, gh, fs, running the command) lives in src/cli/fanout-acceptance.ts; the state schema in fanout-state.ts.
import {
  FanoutStateError,
  acceptanceHash,
  assertAcceptancePath,
  parseRunArgv,
  type Acceptance,
  type FanoutState,
  type TicketState,
} from './fanout-state.ts';

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
  const base: TicketState = cur ?? { branch: null, pr: null, head: null, verdict: 'none', dependsOn: [], builtOn: {}, frozenInterface: null, mergedAccepted: null, status: 'todo', acceptance: null, tree: null, builtOnTree: {}, findings: {}, followUpOf: null, mergedHead: null, mergedTree: null, forgottenMerges: [], fixes: [], updatedAt: f.now };
  return { ...state, tickets: { ...state.tickets, [id]: { ...base, acceptance, updatedAt: f.now } }, updatedAt: f.now };
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
