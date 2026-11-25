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
