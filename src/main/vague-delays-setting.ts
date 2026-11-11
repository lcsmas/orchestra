// #429: the two delays of the Vague endormie as live settings. Read at every pass of the sweep (never cached), so a change applies without a restart; a write also asks the sweep for a pass at once.
import { store } from './store.ts';
import { normalizeVagueDelays, vagueDelaysError, type VagueDelays } from '../shared/vague-human.ts';

export type SetVagueDelaysResult = { ok: true; delays: VagueDelays } | { ok: false; error: string };

let onChanged: () => void = () => {};
/** The host registers « run a sweep now » here (vague-endormie-host.ts). */
export function setVagueDelaysChangedHook(fn: () => void): void {
  onChanged = fn;
}

/** Defaults 10 / 15 min when absent or malformed; a throwing read answers the defaults. */
export function getVagueDelays(): VagueDelays {
  try {
    return normalizeVagueDelays(store.getVagueDelays());
  } catch {
    return normalizeVagueDelays(undefined);
  }
}

/** Validate, persist, and ask the sweep for a pass. An invalid value writes nothing. */
export async function setVagueDelays(next: unknown): Promise<SetVagueDelaysResult> {
  const error = vagueDelaysError(next);
  if (error) return { ok: false, error };
  const { asleepMin, humanMin } = next as VagueDelays;
  await store.setVagueDelays({ asleepMin, humanMin });
  try {
    onChanged();
  } catch {
    /* the next 30 s pass reads the new values anyway */
  }
  return { ok: true, delays: getVagueDelays() };
}
