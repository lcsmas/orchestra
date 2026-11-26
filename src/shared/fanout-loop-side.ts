// #605 — the loop's own sidecar `<run>/loop.json`: the fields ONLY the loop reads (asked / askedTo / signalled / handled / checksSeen / held / busySince / replaced). `parkTicket`, `choices`, `pause`, `rounds`, `applyPlan` are the REAL
// #603 / #604 names in fanout-state.ts / fanout-plan.ts since the stack-B swap (the compat stubs are gone). `parseState` refuses unknown fields, hence the sidecar (reversible default, ledger #613: the loop-only fields stay out of state.json).
import fs from 'node:fs';
import path from 'node:path';
import { readState, SeatRefusal, stateFile, updateState, type FanoutState } from './fanout-state.ts';

export interface LoopSide {
  /** #605-only (not in the freeze): upstream → the head the author was asked to connect to, per dependent. Asked once per (dependent, upstream, head). */
  asked: Record<string, Record<string, string>>;
  /** #605-only: dependent → upstream → the IMPLEMENTER workspace id the ask went to (a replaced author is asked again). */
  askedTo: Record<string, Record<string, string>>;
  /** #605-only: tickets whose implementer said it nominated, read from the mail but not yet turned into a head in the state (mail is consumed on read: this makes the hand-off from `mail` to `nominations` survive a kill). */
  signalled: Record<string, true>;
  /** #605-only: mail seq → `listed` (a question's choice is written, its answer not yet sent) | `done`. Pruned past each ack. */
  handled: Record<string, 'listed' | 'done'>;
  /** #605-only: head → the check names the last poll saw (the "identical on two polls" guard of decideDelivery). */
  checksSeen: Record<string, string>;
  /** #605-only: tickets whose start Admission held (reported by `fleet.start()`) → the head the ticket had when it was held ('' = none); the hold is over once the ticket shows another head. One entry = one hold EPISODE. */
  held: Record<string, string>;
  /** #605-only: wait key (`held:T`, `review:T:head`, `ci:T:head`) → when the loop first waited on it; a wait counts as progress only for a bounded time. */
  busySince: Record<string, string>;
  /** #605-only: `rev:T:head` / `impl:T:head` → how many times a dead reviewer / implementer was replaced for that head (the cap of `LoopOptions.maxReplacements`). */
  replaced: Record<string, number>;
  /** #628 — ticket → the delivery refusal orders sent to its implementer: `head` it had, `n` orders sent for it (2 with no new head ⇒ the implementer is replaced), `at` the last order, `replacing` = released on purpose (a respawn that is no death). */
  /** #649 — dependent → how many times a CONNECT was sent again because its upstream moved (the report counts them). */
  reconnects: Record<string, number>;
  orders: Record<string, { head: string; n: number; at: string; reason: string; replacing?: true }>;
}
/** `FanoutState` + the sidecar.  */
export type LoopState = FanoutState & { loop: LoopSide };

const sideEmpty = (): LoopSide => ({ asked: {}, askedTo: {}, signalled: {}, handled: {}, checksSeen: {}, held: {}, busySince: {}, replaced: {}, orders: {}, reconnects: {} });
const sideFilePath = (home: string, run: string): string => path.join(path.dirname(stateFile(home, run)), 'loop.json');

function sideRead(file: string): LoopSide {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LoopSide>;
    return { ...sideEmpty(), ...raw };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return sideEmpty();
    throw new SeatRefusal('loop-side-unreadable', `${file} is not readable JSON: refusing to run on a half-known state`);
  }
}
function sideWrite(file: string, side: LoopSide): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(side, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const sideStrip = (s: LoopState): FanoutState => { const { loop: _l, ...rest } = s; return rest; };

export function readLoopState(home: string, run: string): LoopState | null {
  const st = readState(stateFile(home, run));
  return st ? { ...st, loop: sideRead(sideFilePath(home, run)) } : null;
}
/** Read-modify-write of the state AND its sidecar under the state's lock. `mutate(null)` = no state yet. */
export function updateLoopState(home: string, run: string, mutate: (cur: LoopState | null) => FanoutState | LoopState): LoopState {
  let out!: LoopState;
  updateState(stateFile(home, run), (cur) => {
    const side = sideRead(sideFilePath(home, run));
    const next = mutate(cur ? { ...cur, loop: side } : null);
    out = { ...next, loop: (next as Partial<LoopState>).loop ?? side }; // a pure state helper (parkTicket, recordChoice…) spreads `loop` along; a bare FanoutState keeps the side it was read with
    sideWrite(sideFilePath(home, run), out.loop);
    return sideStrip(out);
  });
  return out;
}
export const withLoop = (s: FanoutState, loop: LoopSide = sideEmpty()): LoopState => ({ ...s, loop });
