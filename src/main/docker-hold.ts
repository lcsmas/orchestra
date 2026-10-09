// The APP half of the Docker relay hold (#321, wave H ledger #329; pure half: src/shared/docker-hold.ts, keeper half: src/keeper/docker-hold.ts). It does three things and holds nothing itself:
//   1. publishes the guard's EFFECTIVE Admission hold (`isAdmissionHolding`, FI-2) in `<ORCHESTRA_HOME>/admission.state` at every guard sample — the keepers' relays read it;
//   2. reads the `<ws>.docker.hold` files the keepers publish while a call waits (for `bus-status`);
//   3. tells the waiting member ONCE per Admission episode (bus status), so it knows its command is waiting, why, and that nothing needs retrying.
// Deps injected (no Electron / store / bus import) so node --test drives the real code; the production wiring is docker-hold-host.ts.

import { admissionStateOf, holdIsLive, holdNoticeText, parseHoldFile, type HoldFile } from '../shared/docker-hold.ts';
import type { MemoryGuardSnapshot } from '../shared/memory-guard.ts';

export interface DockerHoldDeps {
  /** `<ORCHESTRA_HOME>/admission.state`. */
  stateFile: string;
  /** Where each workspace's keeper would publish its `<ws>.docker.hold` (the keeper's own path rule, incl. the tmpdir fallback for long homes). */
  holdFiles(): Array<{ wsId: string; file: string }>;
  now(): number;
  readText(file: string): string | null;
  /** Atomic publish (tmp + rename). */
  writeFile(file: string, text: string): void;
  removeFile(file: string): void;
  /** A bus status to the waiting member. Return false when it could NOT be delivered (no bus, unknown member): the next tick tries again. A throw is retried the same way. */
  notify(wsId: string, text: string): boolean | void;
  /** A hold shorter than this is not worth a message. */
  noticeAfterMs: number;
  warn(msg: string, err?: unknown): void;
}

export interface DockerHoldRow {
  wsId: string;
  hold: HoldFile;
}

export interface DockerHold {
  /** Publish the state for a guard snapshot (called at every sample + once at start). */
  publish(snap: MemoryGuardSnapshot): void;
  /** The holds that are live NOW. */
  holds(): DockerHoldRow[];
  /** One notice per (member, Admission episode) once its oldest call has waited `noticeAfterMs`. */
  tick(): void;
  /** App exit: the state file goes (a hold must never outlive the thing that decides it). */
  stop(): void;
}

export function createDockerHold(d: DockerHoldDeps): DockerHold {
  const noticed = new Map<string, number>();
  let warnedWrite = false;

  const holds = (): DockerHoldRow[] => {
    const now = d.now();
    const out: DockerHoldRow[] = [];
    for (const { wsId, file } of d.holdFiles()) {
      const text = d.readText(file);
      const hold = text === null ? null : parseHoldFile(text);
      if (hold && holdIsLive(hold, now)) out.push({ wsId, hold });
    }
    return out.sort((a, b) => a.hold.since - b.hold.since);
  };

  return {
    publish(snap): void {
      try {
        d.writeFile(d.stateFile, JSON.stringify(admissionStateOf(snap, d.now())));
      } catch (e) {
        if (!warnedWrite) d.warn(`docker hold: cannot publish ${d.stateFile} (the relays then never hold)`, e);
        warnedWrite = true;
      }
    },
    holds,
    tick(): void {
      const now = d.now();
      for (const { wsId, hold } of holds()) {
        if (now - hold.since < d.noticeAfterMs) continue;
        if (noticed.get(wsId) === hold.episode) continue;
        try {
          if (d.notify(wsId, holdNoticeText(hold, now)) !== false) noticed.set(wsId, hold.episode);
        } catch (e) {
          d.warn(`docker hold: notice to ${wsId} failed`, e);
        }
      }
    },
    stop(): void {
      try {
        d.removeFile(d.stateFile);
      } catch {
        /* already gone */
      }
    },
  };
}
