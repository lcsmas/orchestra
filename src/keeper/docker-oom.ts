// #695 — the keeper listens to the REAL daemon's `oom` events for this workspace's containers (label `orchestra.ws=<id>`), so a container killed at its Docker limit never fails silently.
// A dropped stream is re-opened with a widening delay (1 s → 30 s) and `since` = the last event seen, so an event in the gap is replayed, not lost; an event seen twice is delivered once.

import http from 'node:http';
import { oomEventsPath, parseOomEventLine, type OomEvent } from '../shared/docker-oom.ts';

export interface DockerOomWatch {
  stop(): void;
}

export interface DockerOomOptions {
  upstream: string;
  ws: string;
  log: (m: string) => void;
  /** `limitBytes` = the container's `HostConfig.Memory` read from the daemon (null when the container is already gone — `--rm` — or the read failed). */
  onOom(ev: OomEvent, limitBytes: number | null): void;
  /** First reconnect delay (default 1000 ms). */
  retryMs?: number;
}

function inspectMemory(upstream: string, id: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: upstream, method: 'GET', path: `/containers/${encodeURIComponent(id)}/json`, agent: false, timeout: 5000 }, (r) => {
      if (r.statusCode !== 200) {
        r.resume();
        resolve(null);
        return;
      }
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('error', () => resolve(null));
      r.on('end', () => {
        try {
          const m = Number((JSON.parse(Buffer.concat(parts).toString('utf8')) as { HostConfig?: { Memory?: number } }).HostConfig?.Memory ?? 0);
          resolve(m > 0 ? m : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

export function watchDockerOoms(o: DockerOomOptions): DockerOomWatch {
  let stopped = false;
  let req: http.ClientRequest | null = null;
  let timer: NodeJS.Timeout | null = null;
  let failures = 0;
  let lastSec = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();

  const open = (): void => {
    if (stopped) return;
    let buf = '';
    const retry = (): void => {
      if (stopped || timer) return;
      failures += 1;
      timer = setTimeout(() => {
        timer = null;
        open();
      }, Math.min(30_000, (o.retryMs ?? 1000) * 2 ** Math.min(failures - 1, 5)));
      timer.unref();
    };
    const r = http.request({ socketPath: o.upstream, method: 'GET', path: `${oomEventsPath(o.ws)}&since=${lastSec}`, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        o.log(`docker oom watch: events answered ${res.statusCode}`);
        retry();
        return;
      }
      failures = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          const ev = line ? parseOomEventLine(line) : null;
          if (!ev) continue;
          const key = `${ev.id}@${ev.at}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > 200) seen.delete(seen.values().next().value as string);
          lastSec = Math.max(lastSec, Math.floor(ev.at / 1000));
          void inspectMemory(o.upstream, ev.id).then((limit) => {
            if (stopped) return;
            try {
              o.onOom(ev, limit);
            } catch (e) {
              o.log(`docker oom watch: handler threw: ${(e as Error).message}`);
            }
          });
        }
      });
      res.on('end', retry);
      res.on('error', retry);
    });
    r.on('error', retry);
    req = r;
    r.end();
  };
  open();
  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      req?.destroy();
    },
  };
}
