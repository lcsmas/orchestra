// Production wiring of the Docker relay hold's app half (#321; logic: docker-hold.ts). Started right after the memory guard: subscribe to the guard's samples FIRST, then publish the current state
// (FI-2 item 7) — so the relays read an Admission state within one guard sample of the app starting and at every sample after. Stopped at app quit (the state file goes: fail-open).

import fs from 'node:fs';
import path from 'node:path';
import { createDockerHold, type DockerHold, type DockerHoldRow } from './docker-hold.ts';
import { getMemoryGuardSnapshot, subscribeMemoryGuardSamples } from './memory-guard.ts';
import { keeperSocketPath } from './keeper-client.ts';
import { orchestraHome } from './platform/index.ts';
import { getBus, send as busSend } from './bus.ts';
import { nearestOrchestratorId } from './wave-run-id.ts';
import { store } from './store.ts';
import { scoped } from './logger.ts';
import { admissionStateFile } from '../shared/docker-hold.ts';
import { relayHoldFile } from '../shared/docker-relay.ts';

const dlog = scoped('docker-hold');

/** A hold shorter than this sends no message (a brief dip must not chatter at every member). */
const NOTICE_AFTER_MS = 20_000;

let hold: DockerHold | null = null;
let unsubscribe: (() => void) | null = null;

function productionHold(): DockerHold {
  return createDockerHold({
    stateFile: admissionStateFile(orchestraHome()),
    holdFiles: () => store.workspaces.map((w) => ({ wsId: w.id, file: relayHoldFile(keeperSocketPath(w.id)) })),
    now: Date.now,
    readText: (f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile: (f, text) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, f);
    },
    removeFile: (f) => fs.rmSync(f, { force: true }),
    notify: (wsId, text) => {
      const db = getBus();
      const ws = store.getWorkspace(wsId);
      if (!db || !ws) return false;
      busSend(db, { runId: nearestOrchestratorId(ws, (id) => store.getWorkspace(id)), sender: 'host', kind: 'status', recipient: wsId, body: text });
      return true;
    },
    noticeAfterMs: NOTICE_AFTER_MS,
    warn: (m, e) => dlog.warn(m, e),
  });
}

export function startDockerHold(): void {
  if (hold) return;
  const h = productionHold();
  hold = h;
  // SUBSCRIBE FIRST, then reconcile from the guard's current state.
  unsubscribe = subscribeMemoryGuardSamples((snap) => {
    h.publish(snap);
    h.tick();
  });
  h.publish(getMemoryGuardSnapshot());
}

export function stopDockerHold(): void {
  unsubscribe?.();
  unsubscribe = null;
  hold?.stop();
  hold = null;
}

/** The holds the keepers publish right now (for `bus-status`); [] when the app half is not started. */
export function listDockerHolds(): DockerHoldRow[] {
  return hold ? hold.holds() : [];
}
