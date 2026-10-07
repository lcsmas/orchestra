// Memory guard settings I/O (#285): the view the Settings dialog reads and the validated, HOT write. Store-free (the store is
// passed in) so node --test drives the real functions; api-handlers.ts wires `store`.

import { readMemTotalBytes } from './mem-available.ts';
import { sampleMemoryGuardNow } from './memory-guard.ts';
import { scoped } from './logger.ts';
import {
  patchMemoryGuardSettings,
  type MemoryGuardSettings,
  type MemoryGuardSetResult,
  type MemoryGuardSnapshot,
  type MemoryGuardView,
} from '../shared/memory-guard.ts';

const slog = scoped('memory-guard');

/** The Settings view. The snapshot is taken FRESH (a read + decision now) and the live figure is THAT snapshot's own reading (null when the
 *  meter is dead), so the figure and the state chip beside it come from the same sample (a cached snapshot is up to 60 s old above 6 GB). */
export function memoryGuardView(settings: MemoryGuardSettings, snapshot: MemoryGuardSnapshot = sampleMemoryGuardNow()): MemoryGuardView {
  return { settings, snapshot, liveAvailBytes: snapshot.measured ? snapshot.availBytes : null, totalBytes: readMemTotalBytes() };
}

export interface MemoryGuardSettingsStore {
  getMemoryGuardSettings(): MemoryGuardSettings;
  setMemoryGuardSettings(next: MemoryGuardSettings): Promise<void>;
}

/** Validate → persist → re-sample at once (hot: the new thresholds decide NOW, not at the next 10/60 s tick). Invalid ⇒ nothing written. */
export async function setMemoryGuardSettings(
  patch: Partial<MemoryGuardSettings>,
  store: MemoryGuardSettingsStore,
  totalBytes: number | null = readMemTotalBytes(),
): Promise<MemoryGuardSetResult> {
  const current = store.getMemoryGuardSettings();
  const res = patchMemoryGuardSettings(current, patch, totalBytes);
  if (!res.ok) return { ok: false, error: res.error, view: memoryGuardView(current) };
  let saveError: unknown = null;
  try {
    await store.setMemoryGuardSettings(res.settings);
  } catch (e) {
    saveError = e; // the store already holds the value in memory (it is what the sampler reads): it IS live, it just won't survive a restart
  }
  slog.info(
    `settings changed${saveError ? ' (NOT saved to disk)' : ''} — Admission ${current.admissionGb}→${res.settings.admissionGb} GB, critical ${current.criticalGb}→${res.settings.criticalGb} GB, ` +
      `Admission/fast-Veille toggle ${current.admissionEnabled ? 'ON' : 'OFF'}→${res.settings.admissionEnabled ? 'ON' : 'OFF'}`,
  );
  const snap = sampleMemoryGuardNow();
  const view = memoryGuardView(store.getMemoryGuardSettings(), snap);
  if (saveError) {
    return { ok: false, error: `applied now, but could not be saved (${saveError instanceof Error ? saveError.message : String(saveError)}) — it is lost at the next restart`, view };
  }
  return { ok: true, view };
}
