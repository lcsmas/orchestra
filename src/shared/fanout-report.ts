// #605 stub of the closing report (ledger #613: `buildReport(state, deps): Report` is #608's). #605 fills what the state already says (merged, parked, choices, the findings still open, the pause); #608 owns the final shape
// and the cost / flaky parts — an add/add conflict on this file at merge time is resolved by taking #608's.
import { reviewCounts } from './fanout-record.ts';
import type { LoopState } from './fanout-loop-side.ts';
import { parkedTickets, pausedOf, type ChoiceRecord, type PauseRecord } from './fanout-state.ts';

export interface Report {
  merged: string[];
  parked: Array<{ ticket: string; cause: string; reason: string }>;
  choices: ChoiceRecord[];
  findingsLeft: Array<{ ticket: string; finding: string; severity: string }>;
  flaky: string[];
  costPerTicket: Record<string, { tokens: number } | null>;
  paused: PauseRecord | null;
}

export function buildReport(state: LoopState, _deps?: unknown): Report {
  const ids = state.plan?.tickets ?? Object.keys(state.tickets);
  return {
    merged: ids.filter((id) => state.tickets[id]?.status === 'merged'),
    parked: parkedTickets(state).map((p) => ({ ticket: p.ticket, cause: p.cause, reason: p.reason })),
    choices: state.choices ?? [],
    findingsLeft: ids.flatMap((id) => { const t = state.tickets[id]; return t ? reviewCounts(t).open.map((f) => ({ ticket: id, finding: f, severity: t.findings[f]?.severity ?? '?' })) : []; }),
    flaky: [],
    costPerTicket: Object.fromEntries(ids.map((id) => [id, null])),
    paused: pausedOf(state),
  };
}
