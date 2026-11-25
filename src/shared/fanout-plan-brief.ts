// #604 (ledger #613 FROZEN v1) — the brief of the single-use plan agent (`explo-plan-<run8>`, explorer role), RENDERED BY CODE from the ticket ids: no free text from the coordinator, so no order can ride in it.
// ≤ 1 screen. The rules the CHECK enforces are the rules it states (src/shared/fanout-plan.ts); the one thing it cannot enforce — the graph equals the tickets' own dependencies — it asks for in so many words.
import { PLAN_TITLE_MAX } from './fanout-plan.ts';

export const PLAN_AGENT_PREFIX = 'explo-plan-';

/** `explo-plan-<run8>`: the first 8 characters of the run id, kept to what the naming policy accepts. */
export function planAgentName(run: string): string {
  const slug = run.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^A-Za-z0-9]+/g, '').slice(0, 8);
  return `${PLAN_AGENT_PREFIX}${slug || 'run'}`;
}

/** The submit command the brief names (the agent's session is a child of the coordinator: its own run would be wrong, so `--run` is always given). */
export function planSubmitCommand(run: string): string {
  return `orchestra fanout plan submit <file> --run ${run}`;
}

/** The brief: the tickets, the schema, the rules, the one command. Deterministic; the same ids give the same text. */
export function renderPlanBrief(tickets: string[], opts: { run?: string } = {}): string {
  const run = opts.run ?? '<run>';
  return [
    `You write the PLAN of run ${run}: one JSON file, then you end. You change no repository file and write no code.`,
    '',
    `Tickets (${tickets.length}):`,
    ...tickets.map((id) => `- ${id}`),
    '',
    'Read each ticket (its text is where its id points: the issue, the ticket, the spec file). Then write the file:',
    '```',
    '{ "version": 1,',
    `  "tickets": [ { "id": "<ticket>", "title": "<≤${PLAN_TITLE_MAX} chars>", "spec": "<file|url|ledger section: where its text is>", "dependsOn": ["<ticket>"] } ],`,
    '  "interfaces": { "<depended-on ticket>": "<the exact names, in backticks>" } }',
    '```',
    '',
    'Rules (code checks every one; the run does not start on a plan that fails):',
    '1. Every ticket above appears once, and no other.',
    '2. dependsOn is what the tickets themselves declare (their own "Blocked by" / "Depends on" / "after"): copy it, do not invent or drop an edge. No cycle. [] = none.',
    '3. `interfaces` has a key for EVERY ticket another one depends on: the names its dependents build against — a column `orders.status`, a route `POST /orders`, an event `OrderCreated`, a query, a mutation — each in backticks, ONE token (or `METHOD /path`, ≤ 80 chars), at least one. A backticked sentence is no name; no names, no plan.',
    '4. Nothing else: any other key (decisions, notes, order…) is refused. No instruction to wait, to sequence or to hold.',
    '',
    'Write the file under $TMPDIR (scratch only: your role edits no repository file, and a run decision is blocked), or pipe the JSON to `submit -`.',
    `Submit: \`${planSubmitCommand(run)}\`. It answers at once. Accepted → you are done: end your session. Refused → it lists the reasons: fix the file, submit ONCE more. A second refusal ends the run.`,
  ].join('\n');
}
