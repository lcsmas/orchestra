// Memory guard settings I/O (#285): the view the Settings dialog reads and the validated, HOT write. Store-free (the store is
// passed in) so node --test drives the real functions; api-handlers.ts wires `store`.

import { readMemAvailableBytes, readMemTotalBytes } from './mem-available.ts';
import { getMemoryGuardSnapshot, sampleMemoryGuardNow } from './memory-guard.ts';
import { scoped } from './logger.ts';
import {
  patchMemoryGuardSettings,
  type MemoryGuardSettings,
  type MemoryGuardSetResult,
  type MemoryGuardView,
} from '../shared/memory-guard.ts';

const slog = scoped('memory-guard');

export function memoryGuardView(settings: MemoryGuardSettings): MemoryGuardView {
  return { settings, snapshot: getMemoryGuardSnapshot(), liveAvailBytes: readMemAvailableBytes(), totalBytes: readMemTotalBytes() };
}

export interface MemoryGuardSettingsStore {
  getMemoryGuardSettings(): MemoryGuardSettings;
  setMemoryGuardSettings(next: MemoryGuardSettings): Promise<void>;
}

/** Validate → persist → re-sample at once (hot: the new thresholds decide NOW, not at the next 10/60 s tick). Invalid ⇒ nothing written. */
export async function setMemoryGuardSettings(patch: Partial<MemoryGuardSettings>, store: MemoryGuardSettingsStore): Promise<MemoryGuardSetResult> {
  const current = store.getMemoryGuardSettings();
  const res = patchMemoryGuardSettings(current, patch);
  if (!res.ok) return { ok: false, error: res.error, view: memoryGuardView(current) };
  await store.setMemoryGuardSettings(res.settings);
  slog.info(
    `settings changed — Admission ${current.admissionGb}→${res.settings.admissionGb} GB, critical ${current.criticalGb}→${res.settings.criticalGb} GB, ` +
      `Admission/fast-Veille toggle ${current.admissionEnabled ? 'ON' : 'OFF'}→${res.settings.admissionEnabled ? 'ON' : 'OFF'}`,
  );
  sampleMemoryGuardNow();
  return { ok: true, view: memoryGuardView(res.settings) };
}
