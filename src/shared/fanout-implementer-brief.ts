// #587 PR B (ledger #591 I6) — the implementer's brief, RENDERED BY CODE from the state: `orchestra fanout start` is its only author, the coordinator adds no free text
// (what it must say goes in the run's decisions, which every brief carries). Pure. Its rules live in the implementer role file (#590).
import { renderDecisions, renderInterfaces, renderSwitchesLine } from './fanout-brief-common.ts';
import type { FanoutState } from './fanout-state.ts';
import { FANOUT_IMPLEMENTER_SKILL_PATH } from './fanout-implementer-skill.ts';

/** The implementer's rules (#590, I5): ONE file per role (`fanout-implementer-skill.ts`, installed at `FANOUT_IMPLEMENTER_SKILL_PATH`) — own worktree, the frozen names, the self-gate, the nomination with its `follows` versions, the final report. The brief carries the pointer, never a second copy. */
export const IMPLEMENTER_RULES = [
  'Your rules — your own worktree and branch, the frozen interface names, the self-gate before you report, the nomination with the interface versions you built on, the final report — are in your role file: read it first. Do NOT load the verified-fanout skill: it is the coordinator\'s.',
  `Your role file: ${FANOUT_IMPLEMENTER_SKILL_PATH}`,
].join('\n');

/** #605 — the agent-side half of decisions 3, 4 and 5, appended ONLY when the Boucle leads the run (`input.loop`, else `state.loopPlan` once #604 freezes it): absent ⇒ the brief is byte-identical to before (pinned by test). */
export const LOOP_BRIEF = [
  '## The loop leads this run (this overrides anything else you were told)',
  '- Start NOW on the frozen interface names above and write code at once: never wait for an upstream to merge. Merges in this run are MERGE COMMITS.',
  '- A question that would wait for a person gets a fixed answer from the loop: take the reversible option, record it under `## Choices` in your PR body, continue.',
  '- If you have NO SAFE OPTION (a contradictory spec, an irreversible act): send ONE `orchestra send --type ask` whose FIRST line is exactly `NO SAFE OPTION: <reason>`, then stop. Your ticket is set aside and the others go on.',
  '- When the loop sends `CONNECT <upstream> <head>`: merge that exact head into your branch with a MERGE COMMIT (`git merge --no-ff <head>`; never rebase, never squash), rebuild on its real names, push, then send a `status`.',
  '- After you push a candidate, send a `status`: the loop reads git for the head, not your words.',
].join('\n');

export interface ImplementerBriefInput {
  /** #605 — the Boucle leads this run: append {@link LOOP_BRIEF}. Absent = read `state.loopPlan` (#604's marker). */
  loop?: boolean;
  state: FanoutState;
  ticket: string;
  /** Respawn only: the dead implementer's branch and the head its work reached (the new agent continues from it). */
  continueFrom?: { branch: string; head: string | null };
  /** #599 — the run's target lives in ANOTHER repository than this worktree's: the brief says so (the worktree is cut from this repository's default branch; no branch of the target's name exists here). */
  crossRepo?: { targetRepo: string; defaultBranch: string | null };
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
    ...(input.continueFrom
      ? [`Continue the work of the agent that died: you are ON its branch ${input.continueFrom.branch}${input.continueFrom.head ? ` (last recorded head ${input.continueFrom.head.slice(0, 12)})` : ''}, same name, same PR. Read \`git log\` first; if the branch holds none of that work (it was deleted and recreated), say so to your coordinator before redoing it.`]
      : input.crossRepo ? [`Branch base: your worktree is cut from ${input.crossRepo.defaultBranch ?? 'the default branch'} of THIS repository, not from the run's target.`] : [`Branch base: origin/${state.target}${state.repo ? ` of ${state.repo}` : ''}.`]),
    ...(input.crossRepo ? [`Run target: branch ${state.target} of ${input.crossRepo.targetRepo} — another repository than your worktree's; no branch of that name exists here, and your work lands there through your coordinator.`] : []),
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
    ...((input.loop ?? !!(state as { loopPlan?: unknown }).loopPlan) ? ['', LOOP_BRIEF] : []),
  ];
  return lines.join('\n');
}
