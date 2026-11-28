// #291 — the app-side decision "does this session's keeper host the Docker relay?". Kept apart from agent-sdk.ts so a
// test can drive it against a real scratch bus without the SDK / Electron chain.

import { getBus } from './bus.ts';
import { busSwitch } from './bus-runs.ts';
import { dockerRelayOffer, type DockerRelaySpec } from '../shared/docker-relay.ts';
import { isFleetMember } from '../shared/admission.ts';
import { log } from './logger.ts';
import { orchestraHome } from './platform/index.ts';
import { admissionStateFile } from '../shared/docker-hold.ts';
import { dockerLimitsFile, parseDockerLimitSettings, type DockerLimitOverrides } from '../shared/docker-limits.ts';
import fs from 'node:fs';

/** Reads the run's FROZEN `docker_relay` switch (a bus that is down, or a run with no row, reads OFF). A failed read is
 *  "no relay", never a failed spawn. Sandbox-hosted (`remote`) members never get one. The Docker HOLD (#321) is for a FLEET MEMBER only (`isFleetMember`, the predicate Admission and the Plafond use,
 *  FI-1 v1.2): a top-level / detached session — a LEAD, the human's own — gets the stamping relay but no `holdState`, so it is never held (review M2). Frozen at spawn like the run id. */
export function dockerRelaySpecFor(runId: string | undefined, remote: boolean, ws?: ({ parentId?: string } & { id?: string }) | null): DockerRelaySpec | undefined {
  let switchOn = false;
  try {
    const db = getBus();
    switchOn = !!db && !!runId && busSwitch(db, runId, 'docker_relay');
  } catch (e) {
    log.warn(`docker relay: could not read the docker_relay switch for ${runId}`, e);
  }
  return dockerRelayOffer({ remote, platform: process.platform, runId, switchOn, limits: readDockerLimitOverrides(ws?.id), ...(isFleetMember(ws) ? { holdState: admissionStateFile(orchestraHome()) } : {}) });
}

/** #695: `<ORCHESTRA_HOME>/docker-limits.json` — the setting that raises (or lowers) a member's / the host's container budgets. Read at every spawn and frozen into the frame; a missing or malformed file = the derived defaults. */
export function readDockerLimitOverrides(wsId: string | undefined, home: string = orchestraHome()): DockerLimitOverrides {
  try {
    return parseDockerLimitSettings(fs.readFileSync(dockerLimitsFile(home), 'utf8'), wsId ?? '');
  } catch {
    return {};
  }
}
