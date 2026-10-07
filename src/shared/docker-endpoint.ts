// The REAL-world dependencies of `resolveRelayUpstream` (shared/docker-relay.ts), in ONE place so the keeper's relay and
// the app's own Docker client (main/docker-api.ts) resolve "which daemon" through the SAME function with the SAME
// probes — they cannot disagree (#291 follow-up F2: a relay stamping daemon A while Pause queried daemon B reads 0
// attributed containers, silently). Node-only (child_process/fs): imported by main + keeper, never by the renderer.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { UpstreamDeps } from './docker-relay.ts';

/** `docker context inspect` endpoint host for `env`; null when the CLI is missing or fails. ASYNC on purpose: a sync exec
 *  would stop a keeper answering probes (the app's helloAck waits 3 s) while the CLI runs. */
export function dockerContextHostViaCli(env: Record<string, string | undefined>): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 3000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
    );
  });
}

export function pathKind(p: string): 'socket' | 'missing' | 'other' {
  try {
    return fs.statSync(p).isSocket() ? 'socket' : 'other';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other';
  }
}

export const realUpstreamDeps: UpstreamDeps = { dockerContextHost: dockerContextHostViaCli, pathKind };
