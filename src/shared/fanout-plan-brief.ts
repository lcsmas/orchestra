// #604 (ledger #613 FROZEN v1) — the brief of the single-use plan agent (`explo-plan-<run8>`, explorer role), RENDERED BY CODE from the ticket ids: no free text from the coordinator, so no order can ride in it.
// ≤ 1 screen. The rules the CHECK enforces are the rules it states (src/shared/fanout-plan.ts); the one thing it cannot enforce — the graph equals the tickets' own dependencies — it asks for in so many words.
import { INTERFACE_KINDS, PLAN_TITLE_MAX } from './fanout-plan.ts';

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
/** #682 — a target repository the host checked out for the plan agent to READ (absolute path, read-only by convention). */
export interface PlanCheckout { repo: string; path: string }
/** A repo slug the brief may name: `owner/name`, from what the host validated — never free text. */
export const PLAN_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function renderPlanBrief(tickets: string[], opts: { run?: string; checkouts?: PlanCheckout[] } = {}): string {
  const run = opts.run ?? '<run>';
  const code = opts.checkouts?.length
    ? ['Code to READ (the target repositor' + (opts.checkouts.length > 1 ? 'ies' : 'y') + ', checked out for you, read-only):', ...opts.checkouts.map((c) => `- ${c.repo} → ${c.path}`)]
    : ['Code to READ: the target repository is your working directory (read-only for you).'];
  return [
    `You write the PLAN of run ${run}: one JSON file, then you end. You change no repository file and write no code.`,
    '',
    `Tickets (${tickets.length}):`,
    ...tickets.map((id) => `- ${id}`),
    '',
    ...code,
    '',
    'Read each ticket (its text is where its id points: the issue, the ticket, the spec file). THEN READ THE CODE the tickets name — open those files and the ones they extend (Read, Grep) in the paths above — BEFORE you write any interface: a name, a payload or a storage place you did not find there or in a ticket is a guess, and a guess is refused. Then write the file:',
    '```',
    '{ "version": 1,',
    `  "tickets": [ { "id": "<ticket>", "title": "<≤${PLAN_TITLE_MAX} chars>", "spec": "<file|url|ledger section: where its text is>", "specText": "<the ticket's FULL description, verbatim>", "dependsOn": ["<ticket>"] } ],`,
    '  "interfaces": { "<depended-on ticket>": "<one line per name: `name` — kind: …; shape: …; where: …>" },',
    '  "contracts": [ { "id": "<short id>", "owner": "<ticket>", "must": "<the behaviour, one sentence>", "consumers": ["<ticket>"] } ],',
    '  "noSharedBehaviour": ["<ticket>-<ticket>"] }',
    '```',
    'A filled interface (ONE line per name; name in backticks, then its kind, its shape and where it lives):',
    '```',
    '"interfaces": { "NMC-1": "`parcels.state` — kind: column; shape: enum(\'created\'|\'returned_to_sender\'); where: src/parcels/parcel.entity.ts\\n`ParcelReturnedToSender` — kind: event; shape: { parcelId: string, at: ISO date }; where: new src/parcels/parcel.events.ts\\n`markParcelReturnedToSender` — kind: function; shape: (parcelId: string, reason: string) => void; where: src/parcels/parcel.service.ts" }',
    '```',
    'A filled contract (a behaviour one ticket owns and another relies on):',
    '```',
    '"contracts": [ { "id": "c1", "owner": "NMC-1", "must": "every path that sets parcels.state to returned_to_sender dispatches ParcelReturnedToSender through markParcelReturnedToSender", "consumers": ["NMC-2"] } ]',
    '```',
    '',
    'Rules (code checks every one; the run does not start on a plan that fails):',
    '1. Every ticket above appears once, and no other.',
    '2. dependsOn is what the tickets themselves declare (their own "Blocked by" / "Depends on" / "after"): copy it, do not invent or drop an edge. No cycle. [] = none.',
    `3. \`interfaces\` has a key for EVERY ticket another one depends on: the names its dependents build against — a column \`orders.status\`, a route \`POST /orders\`, an event \`OrderCreated\`, a query, a mutation — each in backticks, ONE token (or \`METHOD /path\`, ≤ 80 chars), at least one, ONE name per line. A name alone is not frozen: each line also says \`kind: ${INTERFACE_KINDS.join('|')}\` and \`shape: <the type, or the payload's fields>\` and \`where: <the path of the existing code it extends, or new <module path>>\` (no backticks after the name; a path you did not see in the code is no \`where\`). A backticked sentence is no name; a name with no kind, shape or where is refused, per ticket and line.`,
    '4. `specText` is the ticket\'s whole description copied VERBATIM from where `spec` points (every sentence, every acceptance criterion line `- [ ] …`; no summary, no rewording): code records it as the ticket text the reviewer is held to, and refuses an empty one or one shorter than the title.',
    '5. `contracts`: write ONE contract for every sentence of a ticket that names ANOTHER ticket\'s behaviour ("a later manual trigger gets the same effect", "reacts to the state whatever its trigger", "the digest lists every parcel"): `owner` = the ticket that must provide that behaviour, `must` = the behaviour as one sentence (what every path does, not how), `consumers` = the tickets whose text relies on it. Code renders each contract to the owner, the consumers and their reviewers, and no approve passes without answering it. An unknown ticket, an empty `must`, a consumer equal to the owner: refused. EVERY dependency needs one: for each pair of tickets joined by a dependency (A depended on by B) some contract must name both, or the plan states `"noSharedBehaviour": ["A-B"]` (the pair share nothing: say so on purpose, the closing report lists it). A pair with neither is refused, named.',
    '6. Nothing else: any other key (decisions, notes, order…) is refused. No instruction to wait, to sequence or to hold.',
    '',
    'Write the file under $TMPDIR (scratch only: your role edits no repository file, and a run decision is blocked), or pipe the JSON to `submit -`.',
    `Submit: \`${planSubmitCommand(run)}\`. It answers at once. Accepted → you are done: end your session. Refused → it lists the reasons: fix the file, submit ONCE more. A second refusal ends the run.`,
  ].join('\n');
}
