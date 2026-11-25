// #587 PR B (ledger #591 I6) — the implementer's brief, RENDERED BY CODE from the state: `orchestra fanout start` is its only author, the coordinator adds no free text
// (what it must say goes in the run's decisions, which every brief carries). Pure. #590 later moves IMPLEMENTER_RULES to the implementer role file.
import { renderDecisions, renderInterfaces, renderSwitchesLine } from './fanout-brief-common.ts';
import type { FanoutState } from './fanout-state.ts';

/** The implementer's rules (today's, generic: nothing here is repo-specific). */
export const IMPLEMENTER_RULES = [
  'Work only in your own worktree, on your own branch. Never merge, never push the integration branch, never spawn agents.',
  'Build EXACTLY the names of the frozen interfaces above (columns, queries, mutations, events). If one must change, STOP and ask your coordinator (`orchestra send --type question`): you never change an interface yourself.',
  'Self-gate before you report: typecheck and the tests of your own diff, plus the rigs your diff touches. Report what you ran with its counts, and what you did NOT verify.',
  'Commit and push your branch. Your final report names the branch, the head sha, and the VERSION of each interface you built on (e.g. `follows A=2`): a nomination on an older version is refused.',
  'Finish with `orchestra send --type worker_done --cap "$(orchestra token)" "<report>"` in the same turn as your last act.',
].map((r, i) => `${i + 1}. ${r}`).join('\n');

export interface ImplementerBriefInput {
  state: FanoutState;
  ticket: string;
  /** Respawn only: the dead implementer's branch and the head its work reached (the new agent continues from it). */
  continueFrom?: { branch: string; head: string | null };
}

/** The brief: the ticket, the interface it provides, the interfaces it builds on, the branch base, the run's decisions, the switches, the rules. Deterministic. */
export function renderImplementerBrief(input: ImplementerBriefInput): string {
  const { state, ticket } = input;
  const t = state.tickets[ticket];
  if (!t) throw new Error(`renderImplementerBrief: ticket ${ticket} is not in the state`);
  const own = t.iface;
  const lines: string[] = [
    `You are the implementer of ticket ${ticket} in run ${state.run} (your coordinator: ${state.run}).`,
    '',
    `## Ticket ${ticket}`,
    t.spec ? `Spec: ${t.spec}` : 'Spec: none registered.',
    ...(t.specText ? ['', t.specText.trim()] : []),
    t.dependsOn.length ? `Depends on: ${t.dependsOn.join(', ')}.` : 'Depends on: nothing.',
    '',
    '## Branch',
    input.continueFrom
      ? `Continue the work of the agent that died: you are ON its branch ${input.continueFrom.branch}${input.continueFrom.head ? ` (last recorded head ${input.continueFrom.head.slice(0, 12)})` : ''}, same name, same PR. Read \`git log\` first; if the branch holds none of that work (it was deleted and recreated), say so to your coordinator before redoing it.`
      : `Branch base: origin/${state.target}${state.repo ? ` of ${state.repo}` : ''}.`,
    '',
    '## Interfaces',
    own ? `Interface you PROVIDE (frozen, v${own.version}):\n${own.text}` : 'Interface you provide: none (no other ticket depends on yours).',
    '',
    renderInterfaces(state, t.dependsOn),
    '',
    renderDecisions(state),
    '',
    renderSwitchesLine(state),
    '',
    '## Rules',
    IMPLEMENTER_RULES,
  ];
  return lines.join('\n');
}
