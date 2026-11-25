// #587 PR A (ledger #591 I6) — the pieces EVERY seat brief is made of, rendered by code from the state (never typed by the coordinator): the hash of a brief, the run's decisions,
// the switches line, the interfaces. Pure; `renderReviewerBrief` (#588) and `renderImplementerBrief` (#587 PR B) import them.
import { createHash } from 'node:crypto';
import { SWITCH_NAMES, switchesOf, type FanoutState } from './fanout-state.ts';

/** sha256 hex of a brief text: what a state record keeps to show WHICH brief a seat was given. */
export const briefHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The run's decisions, verbatim and numbered; `none` when there are none (a brief never hides that it had none). */
export function renderDecisions(state: FanoutState): string {
  const d = state.decisions ?? [];
  if (!d.length) return "Decisions of the run: none recorded.";
  return `Decisions of the run (binding, verbatim — recorded by the coordinator):\n${d.map((x) => `${x.n}. ${x.text}`).join('\n')}`;
}

/** The switches in force (all of them, with their value) on ONE line. */
export function renderSwitchesLine(state: FanoutState): string {
  const sw = switchesOf(state);
  return `Switches of this run: ${SWITCH_NAMES.map((n) => `${n}=${sw[n]}`).join(' · ')}.`;
}

/** The frozen interfaces of `ids`, each with its CURRENT version and text and, after a change, the reasons of the changes; an id with no interface says so. */
export function renderInterfaces(state: FanoutState, ids: string[]): string {
  if (!ids.length) return 'Interfaces you build against: none.';
  const parts = ids.map((id) => {
    const f = state.tickets[id]?.iface ?? null;
    if (!f) return `### ${id}: no interface declared`;
    const changes = f.history.map((h) => `v${h.version}→v${h.version + 1}: ${h.reason ?? '(no reason recorded)'}`);
    return `### ${id} — interface v${f.version}${changes.length ? ` (changes: ${changes.join('; ')})` : ''}\n${f.text}`;
  });
  return `Interfaces you build against (the version you follow is recorded with \`state set <ticket> --follows <ticket>=<version>\`):\n${parts.join('\n\n')}`;
}
