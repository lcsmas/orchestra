// `orchestra spawn --profile` (#401, ADR 0010): the PURE rule for whether a spawned worker inherits a profil navigateur.
// Honoured only when the SPAWNING workspace holds that profile; anything else is refused with a message and the worker
// starts in navigation éphémère. The host reads the caller's record and the profile list when the spawn arrives (never
// from the CLI) and applies the result straight onto the new workspace's record — there is no attach path for agents.
import { effectiveProfileId } from './browser-profile.ts';
import type { BrowserProfile, BrowserProfileId } from './types.ts';

export type SpawnProfileRefusal =
  | 'detached' // `--detached`: the worker has NO parent, and a profile is only handed from a parent to its nested worker
  | 'no-caller' // no spawning workspace on record (plain shell / unknown id): nothing to hold a profile
  | 'unvouched' // the host cannot vouch that this call comes from the live session of `from` (ADR 0008)
  | 'holds-none' // the caller has no profile, or its recorded one was deleted (dangling id)
  | 'not-held'; // the caller holds a DIFFERENT profile (or the name/id matches nothing it holds)

export type SpawnProfileDecision =
  | { kind: 'none' } // no `--profile` → navigation éphémère, nothing to say
  | { kind: 'honoured'; profileId: BrowserProfileId; message: string }
  | { kind: 'refused'; reason: SpawnProfileRefusal; message: string };

const EPHEMERAL = 'The worker starts in navigation éphémère.';

/** `requested` = the raw `--profile` value (a profile id or its name); undefined = the flag was not given.
 *  `caller` = the spawning workspace's record as the host holds it NOW; `callerVouched` = the host verified the
 *  session key of `from`. The requested value is matched ONLY against the profile the caller holds — a profile it
 *  does not hold is never looked up, so a refusal reveals nothing about the human's other profiles. */
export function decideSpawnProfile(input: {
  requested: string | undefined;
  /** `--detached`: the new workspace is parentless (the caller does not track it) — a spec reading of "its PARENT holds it" that fails closed. */
  detached: boolean;
  caller: { browserProfileId?: BrowserProfileId } | undefined;
  callerVouched: boolean;
  profiles: readonly BrowserProfile[];
}): SpawnProfileDecision {
  if (input.requested === undefined) return { kind: 'none' };
  const requested = input.requested.trim();
  const refuse = (reason: SpawnProfileRefusal, why: string): SpawnProfileDecision => ({
    kind: 'refused',
    reason,
    message: `--profile not applied: ${why} ${EPHEMERAL}`,
  });
  if (input.detached) {
    return refuse('detached', 'a --detached worker has no parent to hold a profile — spawn it nested to pass one.');
  }
  if (!input.caller) {
    return refuse('no-caller', 'no spawning workspace — only a workspace that holds a profil navigateur can pass it on.');
  }
  if (!input.callerVouched) {
    return refuse('unvouched', 'the host could not vouch for this session (a replaced or unregistered session cannot pass a profile).');
  }
  const heldId = effectiveProfileId(input.caller.browserProfileId, input.profiles);
  const held = heldId === undefined ? undefined : input.profiles.find((p) => p.id === heldId);
  if (!held) {
    return refuse('holds-none', 'you hold no profil navigateur (only the human attaches one, from the browser panel’s URL bar).');
  }
  if (requested === held.id || (requested !== '' && requested.toLowerCase() === held.name.toLowerCase())) {
    return {
      kind: 'honoured',
      profileId: held.id,
      message: `Profile “${held.name}” passed: the worker's browser panel opens signed in with it, shared with you.`,
    };
  }
  return refuse('not-held', `you hold “${held.name}”, not ${JSON.stringify(requested.slice(0, 40))} — a profile can only be passed on by a workspace that holds it.`);
}
