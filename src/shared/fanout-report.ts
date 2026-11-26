// #608 (spec #601 decision 11) — the closing report of `orchestra fanout run`: what merged, what was parked and why, the choices the agents took, the findings left, the cost per ticket.
// PURE and DERIVED: every line comes from the state (+ the per-ticket token counts the host read from the transcripts) — no model types a line, so the report equals the state.
// The `parked` / `choices` / `pause` / `flaky` fields are written by #603 / #607 (stack C connect: read straight from the state, no casts).
import fs from 'node:fs';
import path from 'node:path';
import type { FanoutState, FindingRecord, TicketState } from './fanout-state.ts';

// ── the views of #603's records (shapes kept; the casts are gone since the connect) ──
export type ParkCauseView = 'question' | 'situation' | 'ci' | 'upstream';
export interface ParkedView { cause: ParkCauseView; reason: string; at?: string; blockedBy?: string }
export interface ChoiceView { n: number; ticket: string; question: string; rule: 'reversible-default' | 'no-safe-option'; answer: string; at: string }
export interface PauseInfo { at: string; reason: string; check: string | null; prs: number[] }

export const parkedOf = (t: TicketState | undefined): ParkedView | null => t?.parked ?? null;
export const choicesOf = (s: FanoutState): ChoiceView[] => s.choices ?? [];
/** #645: a choice recorded with `--taken "irreversible: <what>"` (case-insensitive, leading space ignored). */
export const isIrreversibleChoice = (c: { answer: string }): boolean => /^\s*irreversible\s*:/i.test(c.answer);
export const pauseOf = (s: FanoutState): PauseInfo | null => s.pause ?? null;
/** #607 (ledger v1.2): `TicketState.ci.flaky` = the check names that went red, then green on the one re-run — read per ticket (delete the cast when #607 is merged). */
const flakyOf = (t: TicketState): string[] => t.ci?.flaky ?? [];
/** `status === 'parked'` (#603). */
export const isParked = (t: TicketState | undefined): boolean => t?.status === 'parked' || !!t?.parked;

export interface TokenCost { tokens: number; input?: number; output?: number; cacheRead?: number; cacheCreate?: number }

export interface ReportParked { ticket: string; cause: ParkCauseView; reason: string; blockedBy?: string }
/** `question` + the option the implementer recorded (`answer`, `orchestra fanout choice`, #641) + where its work is. */
export interface ReportChoice { n: number; ticket: string; question: string; rule: ChoiceView['rule']; answer: string; pr: number | null; branch: string | null }
/** A finding that did NOT end fixed: `open` (nobody closed it), `decided` (the coordinator wrote a reason), `pr-body` (settled in the PR body, no code change). */
export interface ReportFinding { ticket: string; finding: string; severity: FindingRecord['severity']; end: 'open' | 'decided' | 'pr-body' | 'on-choice'; note?: string }

export interface Report {
  run: string;
  merged: string[];
  parked: ReportParked[];
  dropped: string[];
  /** neither merged, parked nor dropped: only non-empty when the run stopped early (a pause, or `fanout run` killed). */
  unfinished: string[];
  /** #645: the choices whose `taken` starts `irreversible:` — a script the PR carries and a human runs by hand; listed FIRST. A subset of `choices` (which holds them first too). */
  irreversible: ReportChoice[];
  choices: ReportChoice[];
  findingsLeft: ReportFinding[];
  /** `<ticket>/<check>`: a red job that went green on the one automatic re-run (#607: `TicketState.ci.flaky`). */
  flaky: string[];
  costPerTicket: Record<string, TokenCost | null>;
  paused: PauseInfo | null;
}

const oneLine = (s: string, n = 300): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Ticket ids in plan order when the plan is declared, else state order — the report is the same on every build of the same state. */
export function orderedTickets(state: FanoutState): string[] {
  const all = Object.keys(state.tickets);
  const planned = (state.plan?.tickets ?? []).filter((id) => id in state.tickets);
  return [...planned, ...all.filter((id) => !planned.includes(id))];
}

export function findingsLeftOf(ticket: string, t: TicketState): ReportFinding[] {
  const out: ReportFinding[] = [];
  for (const [finding, f] of Object.entries(t.findings)) {
    if (f.settled?.how === 'fixed') continue;
    if (f.onChoice !== undefined) out.push({ ticket, finding, severity: f.severity, end: 'on-choice', note: `about choice ${f.onChoice} — never blocks` });
    else if (f.decision) out.push({ ticket, finding, severity: f.severity, end: 'decided', note: oneLine(f.decision.text) });
    else if (f.settled) out.push({ ticket, finding, severity: f.severity, end: 'pr-body', note: f.settled.ref });
    else out.push({ ticket, finding, severity: f.severity, end: 'open' });
  }
  return out;
}

/** The report from the state alone. `costs` = the host's per-ticket token counts (null/absent = not measurable, printed as such, never 0). */
export function buildReport(state: FanoutState, costs: Record<string, TokenCost | null> = {}): Report {
  const ids = orderedTickets(state);
  const merged: string[] = [], dropped: string[] = [], unfinished: string[] = [], parked: ReportParked[] = [];
  for (const id of ids) {
    const t = state.tickets[id];
    if (t.status === 'merged') merged.push(id);
    else if (t.status === 'dropped') dropped.push(id);
    else if (isParked(t)) {
      const p = parkedOf(t);
      parked.push({ ticket: id, cause: p?.cause ?? 'situation', reason: p?.reason ?? '(no reason recorded)', ...(p?.blockedBy ? { blockedBy: p.blockedBy } : {}) });
    } else unfinished.push(id);
  }
  const all = choicesOf(state).map((c): ReportChoice => ({ n: c.n, ticket: c.ticket, question: c.question, rule: c.rule, answer: c.answer, pr: state.tickets[c.ticket]?.pr ?? null, branch: state.tickets[c.ticket]?.branch ?? null }));
  const irreversible = all.filter(isIrreversibleChoice);
  const choices = [...irreversible, ...all.filter((c) => !isIrreversibleChoice(c))];
  return {
    run: state.run, irreversible, merged, parked, dropped, unfinished, choices,
    findingsLeft: ids.flatMap((id) => findingsLeftOf(id, state.tickets[id])),
    flaky: ids.flatMap((id) => flakyOf(state.tickets[id]).map((c) => `${id}/${c}`)),
    costPerTicket: Object.fromEntries(ids.map((id) => [id, costs[id] ?? null])),
    paused: pauseOf(state),
  };
}

/** Exit code of `fanout run` (frozen, #605): 0 every ticket merged · 3 ≥ 1 parked · 4 paused with tickets still unfinished (resumable) · 1 the run stopped with tickets unfinished and nothing to say why. A `dropped` ticket is the human's word and does not fail the run. */
export function reportExit(r: Report): 0 | 1 | 3 | 4 {
  if (r.paused && r.unfinished.length) return 4; // paused with nothing left to resume is a finished run
  if (r.parked.length) return 3;
  if (r.unfinished.length || !r.merged.length) return 1; // nothing merged and nothing parked (an empty run, or only dropped tickets) did not deliver
  return 0;
}

const fmtTokens = (c: TokenCost | null): string => (c ? `${c.tokens.toLocaleString('en-US')} tokens` : 'not measured');

/** The stderr text of the report — code-rendered from {@link Report}, one fact per line. */
export function renderReport(r: Report): string {
  const L: string[] = [];
  const total = Object.values(r.costPerTicket).reduce((n, c) => n + (c?.tokens ?? 0), 0);
  L.push(`fanout run ${r.run}: ${r.merged.length} merged, ${r.parked.length} parked${r.dropped.length ? `, ${r.dropped.length} dropped` : ''}${r.unfinished.length ? `, ${r.unfinished.length} unfinished` : ''}${r.paused ? ' — PAUSED' : ''}`);
  if (r.paused) L.push(`PAUSED (${r.paused.at}): ${oneLine(r.paused.reason)}${r.paused.check ? ` — check ${r.paused.check}` : ''}${r.paused.prs.length ? ` — red on PR ${r.paused.prs.map((n) => `#${n}`).join(', ')}` : ''} — lift the pause with \`orchestra fanout state set --run ${r.run} --resume-run\`, then run \`orchestra fanout run --run ${r.run}\` again`);
  if (r.irreversible.length) {
    L.push(`IRREVERSIBLE — the PR carries a script nobody has run; run it by hand (${r.irreversible.length}):`);
    for (const c of r.irreversible) L.push(`  #${c.n} ${c.ticket} ${oneLine(c.question, 200)} → ${oneLine(c.answer, 300)}${c.pr ? ` → PR #${c.pr}` : c.branch ? ` → branch ${c.branch}` : ''}`);
  }
  L.push(`merged: ${r.merged.length ? r.merged.join(', ') : '(none)'}`);
  if (r.parked.length) { L.push('parked:'); for (const p of r.parked) L.push(`  ${p.ticket}  [${p.cause}]  ${oneLine(p.reason)}`); }
  if (r.unfinished.length) L.push(`unfinished: ${r.unfinished.join(', ')}`);
  if (r.dropped.length) L.push(`dropped: ${r.dropped.join(', ')}`);
  const plain = r.choices.filter((c) => !isIrreversibleChoice(c));
  if (plain.length) {
    L.push(`choices taken by the agents (${plain.length}) — each the reversible option the implementer recorded (\`orchestra fanout choice\`):`);
    for (const c of plain) L.push(`  #${c.n} ${c.ticket} [${c.rule}] ${oneLine(c.question, 200)} → TAKEN: ${oneLine(c.answer, 200)}${c.pr ? ` → PR #${c.pr}` : c.branch ? ` → branch ${c.branch}` : ''}`);
  }
  if (r.findingsLeft.length) {
    L.push(`findings left (${r.findingsLeft.length}):`);
    for (const f of r.findingsLeft) L.push(`  ${f.ticket}/${f.finding}  ${f.severity}  ${f.end}${f.note ? `: ${f.note}` : ''}`);
  }
  if (r.flaky.length) L.push(`flaky (red, then green on the one re-run): ${r.flaky.join(', ')}`);
  L.push(`cost: ${Object.entries(r.costPerTicket).map(([id, c]) => `${id} ${fmtTokens(c)}`).join(' · ')}${Object.keys(r.costPerTicket).length ? ` · total ${total.toLocaleString('en-US')} tokens (measured tickets only)` : ''}`);
  return L.join('\n') + '\n';
}

// ── cost per ticket, from the transcripts ─────────────────────────────────────────────────────────────────────────────

type Usage = { i: number; o: number; r: number; c: number };
const tokenCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
/** Add one transcript's assistant usages to `byId` (one entry per `message.id`, each field at its MAX: a message streamed as several lines repeats its usage and the last carries the final `output_tokens`; a resumed or forked session that copies history into a new file repeats ids — one map per COUNT keeps them single). Lines with no id are each their own message. */
function collect(jsonl: string, byId: Map<string, Usage>, anon: { n: number }): void {
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('"usage"')) continue;
    let e: { type?: unknown; message?: { id?: unknown; usage?: Record<string, unknown> } };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant' || !e.message?.usage) continue;
    const u = e.message.usage;
    const key = typeof e.message.id === 'string' ? e.message.id : `anon-${anon.n++}`;
    const prev = byId.get(key);
    const cur = { i: tokenCount(u.input_tokens), o: tokenCount(u.output_tokens), r: tokenCount(u.cache_read_input_tokens), c: tokenCount(u.cache_creation_input_tokens) };
    byId.set(key, prev ? { i: Math.max(prev.i, cur.i), o: Math.max(prev.o, cur.o), r: Math.max(prev.r, cur.r), c: Math.max(prev.c, cur.c) } : cur); // streamed lines of one message only grow: the max per field is the final count, whatever the order of lines or files
  }
}
function tokenTotal(byId: Map<string, Usage>): Required<TokenCost> {
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0;
  for (const v of byId.values()) { input += v.i; output += v.o; cacheRead += v.r; cacheCreate += v.c; }
  return { tokens: input + output + cacheRead + cacheCreate, input, output, cacheRead, cacheCreate };
}

/** Tokens of one Claude Code transcript (`<configDir>/projects/<cwd>/<session>.jsonl`): the `usage` of every assistant line, once per `message.id`. Subagent (sidechain) lines count: they are the ticket's cost. A line that does not parse is skipped. */
export function tokensOfTranscript(jsonl: string): Required<TokenCost> {
  const byId = new Map<string, Usage>();
  collect(jsonl, byId, { n: 0 });
  return tokenTotal(byId);
}

/** {@link tokensOfTranscript} over files with ONE id map (a message copied into a second file is counted once); null when NO file could be read (unmeasured is not 0). */
export function tokensOfFiles(files: string[], read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): Required<TokenCost> | null {
  const byId = new Map<string, Usage>();
  const anon = { n: 0 };
  let any = false;
  for (const f of files) {
    let text: string;
    try { text = read(f); } catch { continue; }
    any = true;
    collect(text, byId, anon);
  }
  return any ? tokenTotal(byId) : null;
}

/** Every `*.jsonl` under a transcript directory, recursively: the session files AND `<session>/subagents/*.jsonl` (Agent-tool transcripts — measured 28 % of a real session's tokens). A workspace restarted or cleared has one file per session: all are the ticket's cost. [] when the directory is absent. */
export function transcriptFilesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); } else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/** `FleetPort.costOf` from three seams: the workspaces that worked on a ticket (implementer + every reviewer), the transcript files of a workspace, the file reader. */
export function makeCostOf(deps: { workspacesOf: (ticket: string) => string[]; transcriptsOf: (ws: string) => string[]; read?: (p: string) => string }): (ticket: string) => Promise<TokenCost | null> {
  return async (ticket) => tokensOfFiles(deps.workspacesOf(ticket).flatMap(deps.transcriptsOf), deps.read);
}

/** The costs of every ticket through the fleet's port; a port that throws reads as not measured (the report never fails for a cost). */
export async function collectCosts(state: FanoutState, costOf: (ticket: string) => Promise<TokenCost | null>): Promise<Record<string, TokenCost | null>> {
  const out: Record<string, TokenCost | null> = {};
  for (const id of orderedTickets(state)) { try { out[id] = await costOf(id); } catch { out[id] = null; } }
  return out;
}

/** Every workspace that worked on a ticket and is recorded in the state: its implementer, and every reviewer it ever had (the recorded one and each brief's). Unique, in that order. */
export function workspacesOfTicket(t: TicketState): string[] {
  const ids = [t.implementer, t.review?.reviewer?.id, ...(t.review?.briefs ?? []).map((b) => b.reviewer)];
  return [...new Set(ids.filter((x): x is string => !!x))];
}
