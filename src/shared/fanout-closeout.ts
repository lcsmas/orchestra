// #553 — the close-out: one ready-to-file ticket text per MEASURED, non-process MINOR recorded on a vague's tickets. Pure and read-only (the CLI is src/cli/fanout-closeout.ts).
// Never lost: a measured MINOR on product code without a spec sentence has no follow-up (ledger #555 D3) — this list is its route. argued MINORs and `kind: process` findings create nothing.
import crypto from 'node:crypto';
import { FanoutStateError, REPORT_PARTS, type FanoutState, type FindingRecord, type FindingReport } from './fanout-state.ts';

/** Why a finding produces no ticket text. `settled-fixed` = already fixed (a follow-up landed it): filing it would duplicate a closed defect. */
export type CloseoutSkip = 'not-minor' | 'argued' | 'process' | 'settled-fixed';

export interface TicketText {
  run: string;
  ticket: string;
  finding: string;
  /** stable one-token marker, hidden in the body (`fanoutcloseout<sha12 of run/ticket/finding>`) — the dedupe key when filing (a search matches ONE token). */
  marker: string;
  title: string;
  body: string;
  report: FindingReport;
}
export interface CloseoutResult {
  texts: TicketText[];
  /** counts of the findings that created nothing, by reason (never silent). */
  skipped: Record<CloseoutSkip, number>;
}

export const markerOf = (run: string, ticket: string, finding: string): string => `fanoutcloseout${crypto.createHash('sha256').update(`${run}\0${ticket}\0${finding}`).digest('hex').slice(0, 12)}`;

/** null = this finding is a ticket text; else why not. A record with no evidence (a legacy string reads as `{severity}`) is `argued`: nothing was measured. */
export function closeoutSkip(r: FindingRecord): CloseoutSkip | null {
  if (r.severity !== 'MINOR') return 'not-minor';
  if (r.kind === 'process') return 'process';
  if (r.evidence !== 'measured') return 'argued';
  if (r.settled?.how === 'fixed') return 'settled-fixed';
  return null;
}

const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The four parts, in order, as the ticket body. */
export function ticketBody(run: string, ticket: string, finding: string, report: FindingReport, ctx: { branch?: string | null; head?: string | null; pr?: number | null } = {}): string {
  const origin = [`run ${run}`, `ticket ${ticket}`, `finding ${finding}`, ctx.branch ? `branch ${ctx.branch}` : '', ctx.head ? `head ${ctx.head.slice(0, 12)}` : '', ctx.pr ? `PR #${ctx.pr}` : ''].filter(Boolean).join(' · ');
  return [
    `**Input**\n${report.input.trim()}`,
    `**What happens**\n${report.happens.trim()}`,
    `**Where**\n${report.where.trim()}`,
    `**Proof**\n${report.proof.trim()}`,
    `_MINOR measured during the fan-out (${origin}); filed from the close-out, severity unchanged._`,
    `<!-- ${markerOf(run, ticket, finding)} -->`,
  ].join('\n\n');
}

/** Every ticket text of `state`, in ticket then finding order. A measured MINOR whose report lacks a part is NOT dropped silently: `findingRecordOf` refuses it at recording, and a state edited by hand to hold one throws here. */
export function closeoutTexts(state: FanoutState): CloseoutResult {
  const texts: TicketText[] = [];
  const skipped: Record<CloseoutSkip, number> = { 'not-minor': 0, argued: 0, process: 0, 'settled-fixed': 0 };
  for (const [ticket, t] of Object.entries(state.tickets)) {
    for (const [finding, f] of Object.entries(t.findings)) {
      const why = closeoutSkip(f);
      if (why) { skipped[why]++; continue; }
      const rec = f; // closeoutSkip === null ⇒ severity MINOR + evidence measured + not process
      const missing = REPORT_PARTS.filter((k) => typeof rec.report?.[k] !== 'string' || !rec.report![k].trim());
      if (missing.length) throw new FanoutStateError(`${ticket}/${finding}: a measured MINOR with no ${missing.join(', ')} — recording refuses it (state edited by hand?)`);
      const report = rec.report!;
      texts.push({ run: state.run, ticket, finding, marker: markerOf(state.run, ticket, finding), title: `${oneLine(report.happens, 90)} (${oneLine(report.where, 60)})`, body: ticketBody(state.run, ticket, finding, report, t), report });
    }
  }
  return { texts, skipped };
}

/** Human-readable list for the ledger closing report: a header with the counts, then each text. Zero texts still prints the header (so « nothing to file » is a stated fact). */
export function renderCloseout(res: CloseoutResult, run: string): string {
  const sk = res.skipped;
  const head = `close-out ${run}: ${res.texts.length} ticket text(s) to file — no ticket for: ${sk.argued} argued MINOR, ${sk.process} process finding(s), ${sk['settled-fixed']} measured MINOR already fixed (+${sk["not-minor"]} BLOCKING/MAJOR: the merge rule's business, not listed)`;
  const blocks = res.texts.map((t, i) => `--- ticket text ${i + 1}/${res.texts.length} · ${t.ticket}/${t.finding} ---\nTitle: ${t.title}\n\n${t.body}`);
  return [head, ...blocks].join('\n\n') + '\n';
}
