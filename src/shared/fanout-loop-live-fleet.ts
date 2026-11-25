// #614 (spec #601, ledger #613) — the LIVE FleetPort of the Boucle. It drives the SHIPPED verbs of the built `orchestra` CLI (`fanout start`, `fanout review`, `check`, `ack`, `send`) and asks the host for the two facts only it has
// (which workspaces are alive, where their transcripts are) — so every caller proof, refusal and Admission rule is the verb's own, never a re-implementation. The loop runs as the run's coordinator (a no-agent workspace, #612): ORCHESTRA_SESSION_KEY
// in the child env is what the host vouches.
import type { FleetPort, LoopMail } from './fanout-loop-ports.ts';
import type { ExecResult } from './fanout-loop-live-git.ts';
import type { StartResult } from './fanout-start.ts';
import { FanoutStateError, SeatRefusal, type FanoutState } from './fanout-state.ts';

/** The built `orchestra` CLI (argv after the binary). Production: this very bundle re-executed (`process.execPath cli.js …`) with the loop's env. */
export type Cli = (args: string[]) => Promise<ExecResult>;
/** The host's `/fanoutAcceptance` route (src/shared/fanout-acceptance-host.ts). */
export type Host = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface LiveFleetDeps {
  run: string;
  /** The run's coordinator = the loop's caller (the run owner; `fanout start` accepts no one else). */
  caller: string;
  cli: Cli;
  host: Host;
  /** The run's state, read fresh (a reviewer's id is recorded there by the host). */
  readState: () => FanoutState | null;
  /** `ORCHESTRA_SESSION_KEY`: proves `caller` to the host on the ops that ask for it. */
  key?: string;
  /** Tokens spent on a ticket (#608's `makeCostOf` over the host's transcript directories). Absent = unmeasured. */
  costOf?: (ticket: string) => Promise<{ tokens: number } | null>;
  /** Largest lot read per `check`. */
  lotLimit?: number;
}

export type LiveFleet = FleetPort & {
  /** Re-read which of the run's workspaces are alive (the snapshot `live()` answers from). Called by the factory, `start()` and `mail()`. */
  refresh(): Promise<void>;
  /** Ack the lot still held: the pass is over. */
  close(): Promise<void>;
};

/** Every workspace the state records for the run: each ticket's implementer, its recorded reviewer and every reviewer it ever had. */
export function workspacesOfRun(s: FanoutState | null): string[] {
  const ids = new Set<string>();
  for (const t of Object.values(s?.tickets ?? {})) {
    if (t.implementer) ids.add(t.implementer);
    if (t.review?.reviewer?.id) ids.add(t.review.reviewer.id);
    for (const b of t.review?.briefs ?? []) if (b.reviewer) ids.add(b.reviewer);
  }
  return [...ids];
}

/** A refusal printed by a verb (`[name] why`, possibly after `refused: `) is a SeatRefusal; anything else a FanoutStateError. */
export function verbError(verb: string, r: ExecResult): FanoutStateError {
  const text = (r.stderr || r.stdout).trim();
  const m = /\[([a-z0-9-]+)\]\s*([\s\S]*)/.exec(text);
  return r.code === 2 && m ? new SeatRefusal(m[1], m[2].trim()) : new FanoutStateError(`orchestra ${verb} failed (exit ${r.code}): ${text.slice(0, 400)}`);
}

interface LotOut { lot: number | null; messages: Array<{ sequence: number; kind: string; sender: string; body: string }> }

/** The bus calls the question `question`; the loop's convention (frozen, ledger #613) calls it `ask`. */
const loopKind = (kind: string): string => (kind === 'question' ? 'ask' : kind);

export async function createLiveFleet(deps: LiveFleetDeps): Promise<LiveFleet> {
  let liveSet = new Set<string>();
  let held: number | null = null; // the lot this pass is working on: acked once the pass is over (a kill before that replays it — at-least-once, never lost)

  const refresh = async (): Promise<void> => {
    const ids = workspacesOfRun(deps.readState());
    if (!ids.length) { liveSet = new Set(); return; }
    const r = await deps.host({ op: 'live', run: deps.run, from: deps.caller, key: deps.key, ids });
    if (!r.ok || !Array.isArray(r.live)) throw new FanoutStateError(`the host could not tell which workspaces are alive: ${String(r.error ?? 'no answer')}`);
    liveSet = new Set((r.live as unknown[]).filter((x): x is string => typeof x === 'string'));
  };
  const ackHeld = async (): Promise<void> => {
    if (held === null) return;
    const lot = held;
    const r = await deps.cli(['ack', String(lot)]);
    if (r.code !== 0 && !/not an outstanding lot/.test(r.stderr)) throw verbError('ack', r); // an already-acked lot is fine; a real failure is not (the lot would replay forever)
    held = null;
  };
  const say = async (to: string, text: string): Promise<void> => {
    const r = await deps.cli(['send', '--type', 'status', '--to', to, '--', text]);
    if (r.code !== 0) throw verbError('send', r);
  };

  const fleet: LiveFleet = {
    async start() {
      const r = await deps.cli(['fanout', 'start', '--run', deps.run]);
      let parsed: StartResult | null = null;
      try { parsed = JSON.parse(r.stdout) as StartResult; } catch { /* a refusal prints no JSON */ }
      if (!parsed || (r.code !== 0 && r.code !== 2)) throw verbError('fanout start', r);
      await refresh();
      return parsed;
    },
    live: (ws) => liveSet.has(ws),
    wake: (ws, text) => say(ws, text),
    send: (to, text, _kind) => say(to, text), // the bus has no `answer` kind: the fixed answer is an ordinary status the agent reads on its next turn
    async mail() {
      await ackHeld(); // the previous pass has finished: its lot is spent
      await refresh();
      const r = await deps.cli(['check', '--limit', String(deps.lotLimit ?? 200)]); // a plain check NEVER acks (#115): a kill between here and the next ack replays the lot
      if (r.code !== 0) throw verbError('check', r);
      let lot: LotOut;
      try { lot = JSON.parse(r.stdout) as LotOut; } catch { throw new FanoutStateError(`orchestra check: not JSON: ${r.stdout.slice(0, 120)}`); }
      held = lot.lot;
      return lot.messages.map((m): LoopMail => ({ seq: m.sequence, kind: loopKind(m.kind), sender: m.sender, ticket: null, body: m.body }));
    },
    async spawnReviewer(ticket, head) {
      const s = deps.readState();
      const t = s?.tickets[ticket];
      if (!t?.head || !(t.head.startsWith(head) || head.startsWith(t.head))) throw new FanoutStateError(`${ticket}: the head moved (state has ${t?.head?.slice(0, 12) ?? 'none'}, asked for ${head.slice(0, 12)})`);
      const r = await deps.cli(['fanout', 'review', ticket, '--run', deps.run]);
      if (r.code !== 0) throw verbError('fanout review', r);
      const id = deps.readState()?.tickets[ticket]?.review?.reviewer?.id;
      if (!id) throw new FanoutStateError(`${ticket}: the host recorded no reviewer after \`fanout review\``);
      return { id };
    },
    async costOf(ticket) { return deps.costOf ? deps.costOf(ticket) : null; },
    refresh,
    close: ackHeld,
  };
  await refresh();
  return fleet;
}
