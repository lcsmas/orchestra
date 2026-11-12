// #439 (OPS ruling R2) — an attach / detach is REFUSED while the mover or a subtree member has an OPEN gate or an UNANSWERED ask whose counterparty
// would lie OUTSIDE its related runs after the move: such an exchange can never complete (the rewake / the reply is filed in a run the other side no
// longer sees) and the waiting side is excluded from liveness forever. An active DISPATCH does not refuse (every spawned child has one, #435): the old
// coordinator's dispatch simply cannot complete after a move. Pure: the post-move tree is a `lookup` the caller builds; no bus, no store.

import { coordinatorOf, coordinates, runIdOf, type RunNode, type RunLookup } from './run-position.ts';

/** One open exchange the bus holds for a workspace of the moved subtree. */
export interface OpenExchange {
  kind: 'gate' | 'ask';
  /** Gate id / the question's message sequence. */
  ref: number;
  run: string;
  /** The workspace of the moved subtree that takes part. */
  member: string;
  /** The other side. */
  counterparty: string;
  /** An ask whose RECIPIENT is the member: a mail copy of it (the move forwards unread mail) would carry a NEW sequence, and the reply threads to the copy — the asker would wait forever. */
  toMember?: boolean;
  /** An ask: the workspace id that ASKED (the reply goes `--to` it). */
  asker?: string;
}

/** The run ids `ws` can see mail / gates in: its home run, every run above it (coordinator chain) and every run below it — the tree form of `getRelatedRunIds`. */
export function relatedHomes(ws: RunNode, lookup: RunLookup, all: readonly RunNode[]): Set<string> {
  const home = runIdOf(ws, lookup);
  const out = new Set<string>([home]);
  const owner = lookup(home);
  if (!owner) return out;
  for (let cur = coordinatorOf(owner, lookup), guard = 0; cur && guard < 64; cur = coordinatorOf(cur, lookup), guard++) out.add(cur.id);
  for (const n of all) {
    if (!coordinates(n) || n.id === owner.id) continue;
    for (let cur = coordinatorOf(n, lookup), guard = 0; cur && guard < 64; cur = coordinatorOf(cur, lookup), guard++) {
      if (cur.id === owner.id) { out.add(n.id); break; }
    }
  }
  return out;
}

/** The exchanges that would be stranded: the counterparty's home run is not among the member's related runs after the move. A counterparty that is
 *  not a workspace (the human) is never stranded — the human sees every gate. */
export function strandedExchanges(
  exchanges: readonly OpenExchange[],
  lookupAfter: RunLookup,
  allAfter: readonly RunNode[],
  /** The pre-move tree: an ask TO a member is stranded too when the move would COPY it (its run is the member's old home, or leaves its related runs). */
  lookupBefore?: RunLookup,
): OpenExchange[] {
  return exchanges.filter((x) => {
    const member = lookupAfter(x.member);
    const other = lookupAfter(x.counterparty);
    if (!member || !other) return false;
    const related = relatedHomes(member, lookupAfter, allAfter);
    if (!related.has(runIdOf(other, lookupAfter))) return true;
    if (x.kind === 'ask' && x.toMember) {
      if (!related.has(x.run)) return true;
      const before = lookupBefore?.(x.member);
      if (before && runIdOf(before, lookupBefore!) === x.run && runIdOf(member, lookupAfter) !== x.run) return true;
    }
    return false;
  });
}

/** The refusal text: names the first stranded item and its counterparty (the CLI prints it, the sidebar shows it in a dialog). */
export function moveRefusal(stranded: readonly OpenExchange[], nameOf: (id: string) => string = (id) => id): string {
  const x = stranded[0];
  const what = x.kind === 'gate' ? `open decision gate #${x.ref}` : `unanswered ask #${x.ref}`;
  const more = stranded.length > 1 ? ` (+${stranded.length - 1} more)` : '';
  return `cannot move: ${what} between ${nameOf(x.member)} and ${nameOf(x.counterparty)} would be stranded outside the run${more} — ${x.kind === 'gate' ? `resolve it with \`orchestra gate resolve ${x.ref} --resolution <ruling>\`` : `the agent asked must answer with \`orchestra send --type status --to ${x.asker ?? '<asker>'} --thread ${x.ref} <reply>\` (a reply without --thread does not answer it)`} first`;
}
