// The little Docker API client the cleanup needs (list + force-remove by label) — plain HTTP over the daemon's unix socket, no docker CLI.
import http from 'node:http';
import { sleep } from './proc.ts';

/** The label every container created through a run's relay carries (freeze: `resctl.run=<id>`). */
export const RUN_LABEL = 'resctl.run';
/** The run INSTANCE's token, stamped beside the id (A2 review M3): ids are caller-chosen and two state dirs can reuse one on a shared daemon; the token never collides. */
export const TOKEN_LABEL = 'resctl.token';

export type DockerReply = { status: number; body: string };

export function dockerRequest(socketPath: string, method: string, path: string, timeoutMs = 20_000): Promise<DockerReply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, agent: false, timeout: timeoutMs }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path}: no answer in ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Ids of the containers (any state) carrying BOTH `resctl.run=<runId>` and `resctl.token=<token>`. The daemon filters; both labels are compared again here so a loose filter can never widen what gets removed. */
export async function listRunContainers(socketPath: string, runId: string, token: string): Promise<string[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${RUN_LABEL}=${runId}`, `${TOKEN_LABEL}=${token}`] }));
  const r = await dockerRequest(socketPath, 'GET', `/containers/json?all=1&filters=${filters}`);
  if (r.status !== 200) throw new Error(`docker: list containers answered ${r.status}: ${r.body.slice(0, 200)}`);
  const rows = JSON.parse(r.body) as { Id: string; Labels?: Record<string, string> | null }[];
  return rows.filter((c) => c.Labels?.[RUN_LABEL] === runId && c.Labels?.[TOKEN_LABEL] === token).map((c) => c.Id);
}

/**
 * Force-remove (with its anonymous volumes) every container of the run, until the daemon lists none twice in a row: a create the relay had already
 * forwarded when it was stopped may land after the first listing. Throws when some are still there after the last round.
 */
export async function removeRunContainers(socketPath: string, runId: string, token: string, log: (m: string) => void = () => {}): Promise<number> {
  let removed = 0;
  let empty = 0;
  let left: string[] = [];
  for (let round = 0; round < 12 && empty < 2; round++) {
    left = await listRunContainers(socketPath, runId, token);
    if (left.length === 0) {
      empty++;
      await sleep(100);
      continue;
    }
    empty = 0;
    let stuck = false;
    for (const id of left) {
      const r = await dockerRequest(socketPath, 'DELETE', `/containers/${encodeURIComponent(id)}?force=1&v=1`);
      if (r.status === 204 || r.status === 404) removed++;
      else {
        stuck = true; // 409 = a removal already in progress (another client, a --rm exit): give it a moment instead of burning the rounds
        log(`docker: removing ${id.slice(0, 12)} answered ${r.status}: ${r.body.slice(0, 200)}`);
      }
    }
    if (stuck) await sleep(250);
  }
  if (empty < 2) throw new Error(`run ${runId}: containers still there after removal: ${left.map((i) => i.slice(0, 12)).join(',')}`);
  return removed;
}
