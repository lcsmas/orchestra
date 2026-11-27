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
  /** Pauses between retries of a transient CLI failure (default: real timers). */
  sleep?: (ms: number) => Promise<void>;
}

export type LiveFleet = FleetPort & {
  /** Re-read which of the run's workspaces are alive (the snapshot `live()` answers from). Called by the factory, `start()` and `mail()`. */
  refresh(): Promise<void>;
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
  let idleOf = new Map<string, number>(); // idle-rule: ms idle per live workspace the host reported (running / unknown = absent)
  let skip = 0; // seqs ≤ skip were acked PARTIALLY (the loop is past them, a later message of the same lot is not): they are not handed out again
  let held: { lot: number; last: number } | null = null; // the lot `mail()` handed out: acked by `ack(upToSeq)` once the loop has handled every message of it (a kill, or a failed message, before that replays it — at-least-once, never lost)

  const refresh = async (): Promise<void> => {
    const ids = workspacesOfRun(deps.readState());
    if (!ids.length) { liveSet = new Set(); idleOf = new Map(); return; }
    const r = await deps.host({ op: 'live', run: deps.run, from: deps.caller, key: deps.key, ids });
    if (!r.ok || !Array.isArray(r.live)) throw new FanoutStateError(`the host could not tell which workspaces are alive: ${String(r.error ?? 'no answer')}`);
    liveSet = new Set((r.live as unknown[]).filter((x): x is string => typeof x === 'string'));
    const idle = typeof r.idle === 'object' && r.idle !== null ? (r.idle as Record<string, unknown>) : {};
    idleOf = new Map(Object.entries(idle).filter(([id, ms]) => liveSet.has(id) && typeof ms === 'number' && Number.isFinite(ms)).map(([id, ms]) => [id, ms as number]));
  };
  /** A transient failure of a shipped verb (exit 1: the host busy, the bus locked) is retried twice; a refusal (exit 2, `[name]`) never is. */
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retried = async (args: string[]): Promise<ExecResult> => {
    let r = await deps.cli(args);
    for (const wait of [1_000, 3_000]) { if (r.code === 0 || r.code === 2) break; await sleep(wait); r = await deps.cli(args); }
    return r;
  };
  const say = async (to: string, text: string): Promise<void> => {
    const r = await deps.cli(['send', '--type', 'status', '--to', to, '--', text]);
    if (r.code !== 0) throw verbError('send', r);
  };

  const fleet: LiveFleet = {
    async start() {
      const r = await retried(['fanout', 'start', '--run', deps.run]);
      let parsed: StartResult | null = null;
      try { parsed = JSON.parse(r.stdout) as StartResult; } catch { /* a refusal prints no JSON */ }
      if (!parsed || (r.code !== 0 && r.code !== 2)) throw verbError('fanout start', r);
      await refresh();
      return parsed;
    },
    live: (ws) => liveSet.has(ws),
    idleFor: (ws) => (liveSet.has(ws) ? idleOf.get(ws) ?? null : null),
    wake: (ws, text) => say(ws, text),
    send: (to, text, _kind) => say(to, text), // the bus has no `answer` kind: the fixed answer is an ordinary status the agent reads on its next turn
    async mail() { // never acks (FleetPort.ack does): until it is acked, the same lot comes back — `check` replays an outstanding lot
      await refresh();
      const r = await retried(['check', '--limit', String(deps.lotLimit ?? 200)]); // a plain check NEVER acks (#115)
      if (r.code !== 0) throw verbError('check', r);
      let lot: LotOut;
      try { lot = JSON.parse(r.stdout) as LotOut; } catch { throw new FanoutStateError(`orchestra check: not JSON: ${r.stdout.slice(0, 120)}`); }
      held = lot.lot !== null && lot.messages.length ? { lot: lot.lot, last: Math.max(...lot.messages.map((m) => m.sequence)) } : null;
      const fresh = lot.messages.filter((m) => m.sequence > skip);
      if (held && !fresh.length) { await fleet.ack(held.last); return fleet.mail(); } // every message of the lot is already covered by a partial ack: close it and read the next
      return fresh.map((m): LoopMail => ({ seq: m.sequence, kind: loopKind(m.kind), sender: m.sender, ticket: null, body: m.body }));
    },
    async ack(upToSeq) { // the lot is the bus's unit: acked once the loop is past its LAST message; a lower `upToSeq` (a message still failing) is remembered, so what it covers is not handed out again while the lot replays
      if (!held) return;
      if (upToSeq < held.last) { skip = Math.max(skip, upToSeq); return; }
      const r = await deps.cli(['ack', String(held.lot)]);
      if (r.code !== 0 && !/not an outstanding lot/.test(r.stderr)) throw verbError('ack', r); // an already-acked lot is fine
      held = null;
      skip = 0;
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
    async replace(ticket) { // #628: the host archives the ticket's implementer (its branch stays); `fanout start` then puts a fresh one on it
      const id = deps.readState()?.tickets[ticket]?.implementer;
      if (!id) return;
      const r = await deps.host({ op: 'release', run: deps.run, from: deps.caller, key: deps.key, ids: [id] });
      if (!r.ok) throw new FanoutStateError(`the host could not release ${id}: ${String(r.error ?? 'no answer')}`);
      await refresh();
    },
    async runPause() { // the host's pause of the run, read from `run status --json` (store-less: the bus); an unreadable answer throws — unknown is never "not paused"
      const r = await retried(['run', 'status', '--run', deps.run, '--json']);
      if (r.code !== 0) throw verbError('run status', r);
      let st: { pause?: { pausedAt?: number; pausedBy?: string | null; resumeStartedAt?: number | null } | null };
      try { st = JSON.parse(r.stdout) as typeof st; } catch { throw new FanoutStateError(`orchestra run status: not JSON: ${r.stdout.slice(0, 120)}`); }
      const p = st.pause;
      return p ? { by: p.pausedBy ?? null, since: typeof p.pausedAt === 'number' ? p.pausedAt : 0, resuming: typeof p.resumeStartedAt === 'number' } : null;
    },
    async replaceReviewer(ticket) { // idle-rule: the host archives the ticket's recorded reviewer; the next `fanout review` finds it gone and spawns a replacement
      const id = deps.readState()?.tickets[ticket]?.review?.reviewer?.id;
      if (!id) return;
      const r = await deps.host({ op: 'release', run: deps.run, from: deps.caller, key: deps.key, ids: [id] });
      if (!r.ok) throw new FanoutStateError(`the host could not release the reviewer ${id}: ${String(r.error ?? 'no answer')}`);
      await refresh();
    },
    refresh,
  };
  await refresh();
  return fleet;
}
