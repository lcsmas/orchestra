// #553 — the close-out: one ready-to-file ticket text per MEASURED, non-process MINOR recorded on a vague's tickets. Pure and read-only (the CLI is src/cli/fanout-closeout.ts).
// Never lost: a measured MINOR on product code without a spec sentence has no follow-up (ledger #555 D3) — this list is its route. argued MINORs and `kind: process` findings create nothing.
import crypto from 'node:crypto';
import { REPORT_PARTS, demonstratedFindings, refusedDemonstrations, type DemonstratedEnd, type FanoutState, type FindingRecord, type FindingReport } from './fanout-state.ts';

/** Why a finding produces no ticket text. `settled-fixed` = already fixed (a follow-up landed it): filing it would duplicate a closed defect. */
export type CloseoutSkip = 'not-minor' | 'argued' | 'no-evidence' | 'process' | 'settled-fixed';

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
  /** ids (`ticket/finding`) a human must look at: a MINOR recorded with NO evidence (a bare `--finding F=MINOR` — measured or not, nobody said), */
  noEvidence: string[];
  /** every measured MINOR dropped because it was settled `fixed` — a bare coordinator assertion (D-pick, review m2): never silent, with its ref — */
  settledFixed: Array<{ id: string; ref: string }>;
  /** and every measured MINOR whose report is incomplete (a state written before the recording refusal, or hand-edited): listed, the other texts still come out (review m4). */
  malformed: Array<{ id: string; why: string }>;
}

export const markerOf = (run: string, ticket: string, finding: string): string => `fanoutcloseout${crypto.createHash('sha256').update(`${run}\0${ticket}\0${finding}`).digest('hex').slice(0, 12)}`;

/** null = this finding is a ticket text; else why not. `evidence` absent (a legacy string reads as `{severity}`) = `no-evidence`: neither a text nor « argued » — the close-out names those ids. */
export function closeoutSkip(r: FindingRecord): CloseoutSkip | null {
  if (r.severity !== 'MINOR') return 'not-minor';
  if (r.kind === 'process') return 'process';
  if (r.evidence === undefined) return 'no-evidence';
  if (r.evidence !== 'measured') return 'argued';
  if (r.settled?.how === 'fixed') return 'settled-fixed';
  return null;
}

const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The four parts, in order, as the ticket body. */
export function ticketBody(run: string, ticket: string, finding: string, report: FindingReport, ctx: { branch?: string | null; pr?: number | null } = {}): string {
  const origin = [`run ${run}`, `ticket ${ticket}`, `finding ${finding}`, ctx.branch ? `branch ${ctx.branch}` : '', ctx.pr ? `PR #${ctx.pr}` : ''].filter(Boolean).join(' · ');
  return [
    `**Input**\n${report.input.trim()}`,
    `**What happens**\n${report.happens.trim()}`,
    `**Where**\n${report.where.trim()}`,
    `**Proof**\n${report.proof.trim()}`,
    `_MINOR measured at an earlier round of the fan-out (${origin}); the code may have moved since — re-check before acting. Filed from the close-out, severity unchanged._`,
    `<!-- ${markerOf(run, ticket, finding)} -->`,
  ].join('\n\n');
}

/** Every ticket text of `state`, in ticket then finding order. Nothing is dropped silently: a measured MINOR with NO report (recording refuses it; an older or hand-edited state may hold one) is listed in `malformed` — a report OBJECT missing a part is refused by `parseState` before this runs (accepted gap: hand-edit only) and the valid texts still come out. */
export function closeoutTexts(state: FanoutState): CloseoutResult {
  const texts: TicketText[] = [];
  const skipped: Record<CloseoutSkip, number> = { 'not-minor': 0, argued: 0, 'no-evidence': 0, process: 0, 'settled-fixed': 0 };
  const noEvidence: string[] = [];
  const settledFixed: Array<{ id: string; ref: string }> = [];
  const malformed: Array<{ id: string; why: string }> = [];
  for (const [ticket, t] of Object.entries(state.tickets)) {
    for (const [finding, f] of Object.entries(t.findings)) {
      const id = `${ticket}/${finding}`;
      const why = closeoutSkip(f);
      if (why) {
        skipped[why]++;
        if (why === 'no-evidence') noEvidence.push(id);
        if (why === 'settled-fixed') settledFixed.push({ id, ref: f.settled!.ref });
        continue;
      }
      const missing = REPORT_PARTS.filter((k) => typeof f.report?.[k] !== 'string' || !f.report![k].trim());
      if (missing.length) { malformed.push({ id, why: `no ${missing.join(', ')}` }); continue; }
      const report = f.report!;
      texts.push({ run: state.run, ticket, finding, marker: markerOf(state.run, ticket, finding), title: `${oneLine(report.happens, 90)} (${oneLine(report.where, 60)})`, body: ticketBody(state.run, ticket, finding, report, t), report });
    }
  }
  return { texts, skipped, noEvidence, settledFixed, malformed };
}

/** Human-readable list for the ledger closing report: a header with the counts, the ids nobody may lose, then each text. Zero texts still prints the header (so « nothing to file » is a stated fact). */
export function renderCloseout(res: CloseoutResult, run: string): string {
  const sk = res.skipped;
  const head = `close-out ${run}: ${res.texts.length} ticket text(s) to file — no ticket for: ${sk.argued} argued MINOR (declared), ${sk['no-evidence']} MINOR with no evidence recorded, ${sk.process} process finding(s), ${sk['settled-fixed']} measured MINOR settled fixed (+${sk['not-minor']} BLOCKING/MAJOR: the merge rule's business, not listed)`;
  const notes = [
    res.noEvidence.length ? `NO EVIDENCE RECORDED (a bare --finding <id>=MINOR: measured or argued? re-record with --json evidence + report, or they are never filed): ${res.noEvidence.join(', ')}` : '',
    res.settledFixed.length ? `SETTLED FIXED, no text (the coordinator's word — check each ref is real): ${res.settledFixed.map((s) => `${s.id} settled:${s.ref}`).join('; ')}` : '',
    res.malformed.length ? `NOT a ticket text: malformed (measured MINOR with an incomplete report — fix the record): ${res.malformed.map((m) => `${m.id} (${m.why})`).join('; ')}` : '',
  ].filter(Boolean);
  const blocks = res.texts.map((t, i) => `--- ticket text ${i + 1}/${res.texts.length} · ${t.ticket}/${t.finding} ---\nTitle: ${t.title}\n\n${t.body}`);
  return [head, ...notes, ...blocks].join('\n\n') + '\n';
}

// ── #572 — minorPolicy=demonstrated: every demonstrated finding and how it ENDED (fixed on head X / decision recorded / still open), then the demonstrations code refused. Printed only under that value. ──
export interface DemonstratedCloseout { findings: Array<DemonstratedEnd & { ticket: string }>; refused: Array<{ ticket: string; finding: string; refusal: string }> }
export function demonstratedCloseout(state: FanoutState): DemonstratedCloseout {
  const findings: DemonstratedCloseout['findings'] = [];
  const refused: DemonstratedCloseout['refused'] = [];
  for (const [ticket, t] of Object.entries(state.tickets)) {
    for (const d of demonstratedFindings(t)) findings.push({ ticket, ...d });
    for (const r of refusedDemonstrations(t)) refused.push({ ticket, ...r });
  }
  return { findings, refused };
}
const endText = (d: DemonstratedEnd): string => (d.end === 'fixed' ? `fixed on head ${d.ref}` : d.end === 'pr-body' ? `settled in the PR body: ${d.ref}` : d.end === 'decided' ? `decision recorded: ${oneLine(d.ref ?? '', 160)}` : 'STILL OPEN');
export function renderDemonstratedCloseout(c: DemonstratedCloseout): string {
  const open = c.findings.filter((f) => f.end === 'open').length;
  const head = `demonstrated findings (#572): ${c.findings.length} — ${c.findings.length - open} ended, ${open} still open; ${c.refused.length} demonstration(s) refused (those findings stayed plain)`;
  const rows = c.findings.map((f) => `  ${f.ticket}/${f.finding}  ${f.severity}  ${f.file} @${f.head.slice(0, 8)}  — ${endText(f)}  (input: ${oneLine(f.input, 100)})`);
  const refused = c.refused.map((r) => `  ${r.ticket}/${r.finding}  demonstration refused: ${r.refusal}`);
  return [head, ...rows, ...refused].join('\n') + '\n';
}
