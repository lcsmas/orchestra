// PROTOTYPE #139 (map #136) — THROWAWAY, never merged. A windowless `orchestra-hostd` (the same Electron binary,
// ORCHESTRA_ROLE=hostd) runs the host; an app launched while it is up attaches as a CLIENT over a Unix socket
// (<home>/hostd-attach.sock, NDJSON): requests {id, method, args} → {id, result|error}; pushes {push, args}.
// Findings: docs/research/139-hostd-prototype/findings.md on branch prototype/139-hostd-spike.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { orchestraHome, onBroadcast } from './platform';

export type Role = 'host' | 'hostd' | 'client';

export const attachSocketPath = (): string => path.join(orchestraHome(), 'hostd-attach.sock');
export const hostdLockPath = (): string => path.join(orchestraHome(), 'hostd.lock');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Sync, at module load: a live hostd = its lock names a live pid AND its attach socket exists. ORCHESTRA_PROTO_FORCE_HOST=1 ignores it (must-FAIL arm). */
export function decideRole(): Role {
  if (process.env.ORCHESTRA_ROLE === 'hostd') return 'hostd';
  if (process.env.ORCHESTRA_PROTO_FORCE_HOST === '1') return 'host';
  try {
    const pid = Number(fs.readFileSync(hostdLockPath(), 'utf8').trim());
    if (pid > 0 && alive(pid) && fs.existsSync(attachSocketPath())) return 'client';
  } catch {
    /* no lock → host */
  }
  return 'host';
}

/** hostd: write the pid lock (no stale-proof logic — a spike). */
export function takeHostdLock(): void {
  fs.mkdirSync(orchestraHome(), { recursive: true });
  fs.writeFileSync(hostdLockPath(), String(process.pid));
}
export function dropHostdLock(): void {
  try {
    if (fs.readFileSync(hostdLockPath(), 'utf8').trim() === String(process.pid)) fs.unlinkSync(hostdLockPath());
  } catch {
    /* gone */
  }
}

// ── hostd side ─────────────────────────────────────────────────────────────────────────────────
const clients = new Set<net.Socket>();
export const attachedClientCount = (): number => clients.size;
let server: net.Server | null = null;

function write(sock: net.Socket, obj: unknown): void {
  try {
    sock.write(`${JSON.stringify(obj)}\n`);
  } catch {
    /* client gone */
  }
}
export function pushToClients(channel: string, args: unknown[]): void {
  for (const c of clients) write(c, { push: channel, args });
}

/** Serve `handlers` (the api-handlers table + a few extras) to attached clients and fan every platform.broadcast out to them. */
export function startAttachServer(
  handlers: Record<string, (...a: unknown[]) => unknown>,
  log: (m: string) => void,
): void {
  const p = attachSocketPath();
  try {
    fs.unlinkSync(p);
  } catch {
    /* none */
  }
  onBroadcast((channel, args) => pushToClients(channel, args));
  server = net.createServer((sock) => {
    clients.add(sock);
    log(`hostd-proto: client attached (n=${clients.size})`);
    sock.on('error', () => {});
    sock.on('close', () => {
      clients.delete(sock);
      log(`hostd-proto: client detached (n=${clients.size})`);
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let req: { id: number; method: string; args?: unknown[] };
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        const h = handlers[req.method];
        if (!h) {
          write(sock, { id: req.id, error: `hostd-proto: no method ${req.method}` });
          continue;
        }
        void Promise.resolve()
          .then(() => h(...(req.args ?? [])))
          .then(
            (result) => write(sock, { id: req.id, result: result === undefined ? null : result }),
            (e: unknown) => write(sock, { id: req.id, error: e instanceof Error ? e.message : String(e) }),
          );
      }
    });
  });
  server.listen(p, () => {
    fs.chmodSync(p, 0o600);
    log(`hostd-proto: attach socket ${p}`);
  });
}
export function stopAttachServer(): void {
  for (const c of clients) c.destroy();
  server?.close();
  try {
    fs.unlinkSync(attachSocketPath());
  } catch {
    /* gone */
  }
}

// ── client side ────────────────────────────────────────────────────────────────────────────────
let conn: net.Socket | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export function connectClient(onPush: (channel: string, args: unknown[]) => void, onClose: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(attachSocketPath());
    s.setEncoding('utf8');
    let buf = '';
    s.once('connect', () => {
      conn = s;
      resolve();
    });
    s.once('error', reject);
    s.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.push) onPush(msg.push, msg.args ?? []);
        else {
          const p = pending.get(msg.id);
          if (!p) continue;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
      }
    });
    s.on('close', () => {
      conn = null;
      for (const p of pending.values()) p.reject(new Error('hostd-proto: hostd went away'));
      pending.clear();
      onClose();
    });
  });
}

export function remoteInvoke(method: string, args: unknown[]): Promise<unknown> {
  if (!conn) return Promise.reject(new Error('hostd-proto: not attached'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write(conn!, { id, method, args });
  });
}
