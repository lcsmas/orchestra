// #291 — the app-side decision "does this session's keeper host the Docker relay?". Kept apart from agent-sdk.ts so a
// test can drive it against a real scratch bus without the SDK / Electron chain.

import { getBus } from './bus.ts';
import { busSwitch } from './bus-runs.ts';
import { dockerRelayOffer, type DockerRelaySpec } from '../shared/docker-relay.ts';
import { log } from './logger.ts';

/** Reads the run's FROZEN `docker_relay` switch (a bus that is down, or a run with no row, reads OFF). A failed read is
 *  "no relay", never a failed spawn. Sandbox-hosted (`remote`) members never get one. */
export function dockerRelaySpecFor(runId: string | undefined, remote: boolean): DockerRelaySpec | undefined {
  let switchOn = false;
  try {
    const db = getBus();
    switchOn = !!db && !!runId && busSwitch(db, runId, 'docker_relay');
  } catch (e) {
    log.warn(`docker relay: could not read the docker_relay switch for ${runId}`, e);
  }
  return dockerRelayOffer({ remote, platform: process.platform, runId, switchOn });
}
