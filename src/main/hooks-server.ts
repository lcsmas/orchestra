import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { BrowserWindow } from 'electron';
import { dispatchHookEvent } from './activity';
import {
  dispatchRenameRequest,
  dispatchSpawnRequest,
  dispatchPeersRequest,
  dispatchReadRequest,
  dispatchMessageRequest,
  dispatchAddRepoRequest,
  dispatchDeleteWorkspaceRequest,
} from './workspaces';
import { log } from './logger';

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

// Stable, well-known pointer file whose contents are the absolute path of the
// live socket. Agents/PTYs get the socket via $ORCHESTRA_SOCK, but a standalone
// CLI launched from an ordinary terminal has no such env var — it reads this
// file to discover where to connect. The socket itself is named per-PID (so a
// crashed run can't collide), which is exactly why we need a fixed indirection.
function pointerFilePath(): string {
  return path.join(os.homedir(), '.orchestra', 'sock');
}

function writePointerFile(target: string): void {
  try {
    const p = pointerFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, target, { mode: 0o600 });
  } catch (e) {
    log.warn('failed to write socket pointer file', e);
  }
}

function removePointerFile(): void {
  try {
    fs.unlinkSync(pointerFilePath());
  } catch {
    /* missing is fine */
  }
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
    const route = req.url ?? '/';
    // Per-route body cap. Activity/rename payloads are tiny JSON; /spawn carries
    // the new agent's full opening prompt, which routinely runs past a few KB.
    // A too-small cap used to silently `req.destroy()` the connection — the
    // caller saw an empty reply and had to guess that the payload was the
    // culprit — so /spawn gets a generous ceiling while other routes stay
    // locked down, and an over-cap request now answers with a clear 413.
    const maxBytes = route === '/spawn' || route === '/message' ? 1_048_576 : 4096;
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return; // already over cap — discard the rest, don't buffer
      body += chunk;
      if (body.length > maxBytes) tooLarge = true;
    });
    req.on('end', () => {
      void (async () => {
        const send = (code: number, obj: unknown): void => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (tooLarge) {
          send(413, { ok: false, error: 'payload too large' });
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(body) as Record<string, unknown>;
        } catch {
          send(400, { ok: false, error: 'invalid JSON' });
          return;
        }
        try {
          if (route === '/rename') {
            if (typeof msg.id === 'string' && typeof msg.branch === 'string') {
              send(200, await dispatchRenameRequest(msg.id, msg.branch, window));
            } else {
              send(200, { ok: false, error: 'missing id or branch' });
            }
          } else if (route === '/spawn') {
            if (typeof msg.task === 'string') {
              send(
                200,
                await dispatchSpawnRequest(
                  {
                    from: typeof msg.from === 'string' ? msg.from : undefined,
                    repoPath: typeof msg.repoPath === 'string' ? msg.repoPath : undefined,
                    baseBranch: typeof msg.baseBranch === 'string' ? msg.baseBranch : undefined,
                    task: msg.task,
                    agent: 'claude',
                  },
                  window,
                ),
              );
            } else {
              send(200, { ok: false, error: 'missing task' });
            }
          } else if (route === '/peers') {
            send(200, dispatchPeersRequest({ from: typeof msg.from === 'string' ? msg.from : undefined }));
          } else if (route === '/read') {
            if (typeof msg.id === 'string') {
              send(
                200,
                dispatchReadRequest({
                  id: msg.id,
                  lines: typeof msg.lines === 'number' ? msg.lines : undefined,
                }),
              );
            } else {
              send(200, { ok: false, error: 'missing id' });
            }
          } else if (route === '/message') {
            if (typeof msg.to === 'string' && typeof msg.text === 'string') {
              send(
                200,
                await dispatchMessageRequest(
                  {
                    from: typeof msg.from === 'string' ? msg.from : undefined,
                    to: msg.to,
                    text: msg.text,
                  },
                  window,
                ),
              );
            } else {
              send(200, { ok: false, error: 'missing to or text' });
            }
          } else if (route === '/addRepo') {
            if (typeof msg.path === 'string') {
              send(200, await dispatchAddRepoRequest({ path: msg.path }, window));
            } else {
              send(200, { ok: false, error: 'missing path' });
            }
          } else if (route === '/deleteWorkspace') {
            if (typeof msg.id === 'string') {
              send(200, await dispatchDeleteWorkspaceRequest({ id: msg.id }, window));
            } else {
              send(200, { ok: false, error: 'missing id' });
            }
          } else {
            // Default route handles activity events: /event or anything else.
            if (typeof msg.id === 'string' && typeof msg.event === 'string') {
              dispatchHookEvent(msg.id, msg.event, window);
            }
            send(200, {});
          }
        } catch (e) {
          log.error(`hook route ${route} failed`, e);
          send(200, { ok: false, error: e instanceof Error ? e.message : 'internal error' });
        }
      })();
    });
    req.on('error', () => {
      /* noop */
    });
  });

  server.on('error', (err) => {
    /* keep alive — a single connection error must not tear down the server */
    log.warn('hooks server connection error', err);
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(target, () => {
      server!.removeListener('error', reject);
      socketPath = target;
      log.info(`hooks server listening on ${target}`);
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        /* best-effort: socket file mode tightening */
      }
      writePointerFile(target);
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
  removePointerFile();
}
