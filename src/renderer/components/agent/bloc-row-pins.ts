import { useSyncExternalStore } from 'react';
import type { Pin } from './bloc-pin';

/** Row ids the windowed transcript must keep rendered (a bloc in them has an open overlay / source view). Ref-counted per row id. */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const l of listeners) l(); };

export const pinRowFor = (rowId: string): Pin => () => {
  counts.set(rowId, (counts.get(rowId) ?? 0) + 1); emit();
  let released = false;
  return () => {
    if (released) return; released = true;
    const n = (counts.get(rowId) ?? 1) - 1;
    if (n <= 0) counts.delete(rowId); else counts.set(rowId, n);
    emit();
  };
};
/** How many pins hold this row right now (0 = none). */
export const rowPinCount = (rowId: string): number => counts.get(rowId) ?? 0;
/** Re-renders the caller when the pinned set changes; returns the pinned row ids. */
export function usePinnedRowIds(): ReadonlySet<string> {
  useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => version);
  return new Set(counts.keys());
}
