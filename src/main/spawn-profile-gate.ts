// #401 — which profils navigateur are being DELETED right now, as the profile service (#400, browser-profiles.ts) knows it. A spawn that hands a
// worker its spawner's profile asks here at the record build: a delete scanned its carriers when it started, so a record written during it would
// escape the detach. Tiny and Electron-free so workspaces.ts needs no import of the Electron host; the host registers the probe (browser-profiles-host.ts).
import type { BrowserProfileId } from '../shared/types.ts';

let probe: (() => BrowserProfileId[]) | null = null;

/** Installed once by browser-profiles-host.ts. */
export function setDeletingProfilesProbe(fn: (() => BrowserProfileId[]) | null): void {
  probe = fn;
}

/** Profiles whose deletion is in flight; empty when no service is installed (headless harnesses: nothing can be deleting). */
export function deletingProfiles(): BrowserProfileId[] {
  return probe ? probe() : [];
}
