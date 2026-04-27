import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { BrowserWindow } from 'electron';
import { dispatchHookEvent } from './activity';

// Tiny HTTP server bound to a Unix socket. Each workspace's
// .claude/settings.local.json registers Claude Code lifecycle hooks
// (UserPromptSubmit, Stop) whose command POSTs `{id, event}` JSON here, so
// activity tracking is driven 1:1 by Claude's own events instead of by
// scraping the PTY or sampling /proc.
//
// The socket path is exposed to spawned PTYs via ORCHESTRA_SOCK; the workspace
// id rides on ORCHESTRA_WS_ID. The hook command is env-guarded so it's a
// silent no-op when claude is run outside orchestra.

let server: http.Server | null = null;
let socketPath: string | null = null;

function defaultSocketPath(): string {
  const dir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(dir, `orchestra-${process.pid}.sock`);
}

export function getHookSocketPath(): string | null {
  return socketPath;
}

export async function startHooksServer(window: BrowserWindow): Promise<void> {
  if (server) return;
  const target = defaultSocketPath();
  // Stale socket left over by a prior crashed run with the same PID — drop it
  // before bind so listen() doesn't fail with EADDRINUSE.
  try {
    fs.unlinkSync(target);
  } catch {
    /* missing is fine */
  }

  server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      // 4 KB cap — hook payload is tiny JSON, anything bigger is noise/abuse.
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body) as { id?: unknown; event?: unknown };
        if (typeof msg.id === 'string' && typeof msg.event === 'string') {
          dispatchHookEvent(msg.id, msg.event, window);
        }
      } catch {
        /* invalid JSON — ignore */
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    req.on('error', () => {
      /* noop */
    });
  });

  server.on('error', () => {
    /* keep alive — a single connection error must not tear down the server */
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(target, () => {
      server!.removeListener('error', reject);
      socketPath = target;
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        /* best-effort: socket file mode tightening */
      }
      resolve();
    });
  });
}

export function stopHooksServer(): void {
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    server = null;
  }
  if (socketPath) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
    socketPath = null;
  }
}
