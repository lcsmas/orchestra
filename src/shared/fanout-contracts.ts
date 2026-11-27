// #680 — cross-ticket contracts: a behaviour one ticket OWNS and others rely on, written in the plan and answered by every reviewer's approve. Pure.
import type { ContractRecord, FanoutState } from './fanout-state.ts';

/** The contracts `ticket` is part of, in plan order, with its part. */
export function contractsOf(state: FanoutState, ticket: string): Array<{ c: ContractRecord; role: 'owner' | 'consumer' }> {
  return (state.contracts ?? []).flatMap((c): Array<{ c: ContractRecord; role: 'owner' | 'consumer' }> => (c.owner === ticket ? [{ c, role: 'owner' }] : c.consumers.includes(ticket) ? [{ c, role: 'consumer' }] : []));
}

/** `## Contracts of the run` body for `ticket`'s brief (its owner / consumer / reviewer): '' when the ticket is part of none — nothing is printed. */
export function renderContracts(state: FanoutState, ticket: string): string {
  const mine = contractsOf(state, ticket);
  if (!mine.length) return '';
  const lines = mine.map(({ c, role }) => `- ${c.id}: ${c.owner} MUST — ${c.must} (consumers: ${c.consumers.join(', ')}) — ${ticket} is ${role === 'owner' ? 'the OWNER: it provides this on every path' : 'a CONSUMER: it relies on it and must reach it through the owner, never copy it'}`);
  return `Contracts of the run (written in the plan; every approve answers each one the ticket is part of):\n${lines.join('\n')}`;
}

/** The last answer recorded for contract `id` by `ticket`'s reviews: met | unmet | null (none recorded). */
export function lastContractAnswer(state: FanoutState, ticket: string, id: string): 'met' | 'unmet' | null {
  const rs = state.tickets[ticket]?.reviews ?? [];
  for (let k = rs.length - 1; k >= 0; k--) { const a = rs[k].contracts?.[id]; if (a) return a; }
  return null;
}
