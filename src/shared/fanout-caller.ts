// #588 (I3) — who is calling an `orchestra fanout` verb. `ORCHESTRA_WS_ID` is a plain env var any member can set (measured: ledger #591 / issue #588 task-1 comment), so the id alone proves nothing;
// what holds is the host's `/identity` (#379, ADR 0008): it answers `{id, key}` with `ok` only for the live session key of THAT workspace. A caller is `host-vouched` only when the CLI passes
// the host's `ok` resolution (a typed value built by `resolveHostIdentity` from the SAME env — never read from the env itself). Accepted gap: a same-uid process can lift a sibling's key from /proc/<pid>/environ.
import type { FanoutState } from './fanout-state.ts';
import type { IdentityResolution } from './session-identity.ts';

export type CallerRole = 'coordinator' | 'reviewer' | 'implementer' | 'other';
export interface Caller {
  id: string | null;
  role: CallerRole;
  /** `host-vouched` = the host verified {id, session key}; `env-asserted (<why>)` = the id is only what the env says (forgeable). */
  proof: string;
}
export const HOST_VOUCHED = 'host-vouched';
export const isVouched = (c: Caller): boolean => c.proof === HOST_VOUCHED;

/** The role of workspace `id` in `state`, by POSITION in the run (coordinator = the run's id; a ticket's recorded reviewer / implementer), never by what the caller says. */
export function roleInRun(state: FanoutState, id: string | null): CallerRole {
  if (!id) return 'other';
  if (id === state.run) return 'coordinator';
  const ts = Object.values(state.tickets);
  if (ts.some((t) => t.review?.reviewer?.id === id)) return 'reviewer';
  if (ts.some((t) => t.implementer === id)) return 'implementer';
  return 'other';
}

/** `resolution` = what the host said for this CLI call (omitted / env-sourced ⇒ the id is unproven). */
export function resolveCaller(
  state: FanoutState,
  env: { ORCHESTRA_WS_ID?: string; ORCHESTRA_WS_ID_IDENTITY?: string },
  resolution?: IdentityResolution | null,
): Caller {
  const id = (env.ORCHESTRA_WS_ID || env.ORCHESTRA_WS_ID_IDENTITY || '').trim() || null;
  const proof = !id ? 'env-asserted (no workspace identity)'
    : resolution?.source === 'host' ? HOST_VOUCHED
    : `env-asserted (${resolution ? `host did not vouch: ${resolution.why}` : 'not asked'})`;
  return { id, role: roleInRun(state, id), proof };
}

// ---- #612 — who may run the verbs the spike found open (`state set --status merged`, `open`, `gate`, `check`). Under seatRecords=on only (the rule `start` / `review` / `--run-decision` already live under); host-vouched only, fail closed.
export type CallerVerb = 'state' | 'open' | 'gate' | 'check';
export const CALLER_REFUSALS: Record<CallerVerb, string> = { state: 'state-caller', open: 'open-caller', gate: 'gate-caller', check: 'check-caller' };

/**
 * null = allowed. `state` (`set --status merged`) and `open` are the run OWNER's: the coordinator of the run. `gate` is read by whoever gates a ticket: any member of the run by position
 * (coordinator, a ticket's reviewer / implementer / verifier). `check` records into the state: the coordinator or the implementer OF THAT TICKET. A run with seatRecords off, or with no state, is not judged here.
 * `seatRecordsOn` is passed in (the state module owns the switch) so this stays import-free.
 */
export function callerRefusal(verb: CallerVerb, state: FanoutState | null, seatRecordsOn: boolean, caller: Caller, ticket?: string): { name: string; detail: string } | null {
  if (!state || !seatRecordsOn) return null;
  const name = CALLER_REFUSALS[verb];
  const who = caller.id ?? 'unidentified';
  const what = verb === 'state' ? '`state set --status merged`' : `\`fanout ${verb}\``;
  if (!isVouched(caller)) return { name, detail: `the host did not vouch for ${who}: ${caller.proof} — run ${what} from a live session of run ${state.run} (a forged ORCHESTRA_WS_ID proves nothing)` };
  const owner = caller.role === 'coordinator';
  if (verb === 'state' || verb === 'open') return owner ? null : { name, detail: `only the run's owner (the coordinator ${state.run}) may run ${what}; the caller is ${who} (${caller.role})` };
  if (verb === 'gate') {
    const member = caller.role !== 'other' || (!!caller.id && Object.values(state.tickets).some((t) => t.verifier === caller.id));
    return member ? null : { name, detail: `${what} is for the members of run ${state.run} (its coordinator, reviewers, implementers, verifier); the caller is ${who} (${caller.role})` };
  }
  const mine = caller.role === 'implementer' && !!ticket && state.tickets[ticket]?.implementer === caller.id;
  return owner || mine ? null : { name, detail: `${what} ${ticket ?? '<ticket>'} is the coordinator's or that ticket's implementer's; the caller is ${who} (${caller.role})` };
}

/** The `run-paused` refusal of `deliver` / `open` / `gate` (#612 C5): the SAME text as a refused spawn (`run en pause — orchestra run resume --run <id>`), reason named, exit 2. */
export function pausedVerbResult(verb: 'deliver' | 'open' | 'gate', run: string, text: string): { exit: 2; stdout: string; stderr: string } {
  return { exit: 2, stdout: `${JSON.stringify({ verdict: 'refused', reason: 'run-paused', verb, run, detail: text })}\n`, stderr: `${text}\n` };
}

/** The ticket a gate/check/open argv names: `check <ticket> [--run x] [--head y]` = the first word that is neither a flag nor a flag's value; `gate … --ticket <id>`; none otherwise. */
export function ticketArgOf(verb: string, args: string[]): string | undefined {
  if (verb === 'check') { const a = args.slice(1); for (let i = 0; i < a.length; i++) { if (a[i].startsWith('--')) i++; else return a[i]; } return undefined; }
  const i = args.indexOf('--ticket');
  return i >= 0 ? args[i + 1] : undefined;
}
