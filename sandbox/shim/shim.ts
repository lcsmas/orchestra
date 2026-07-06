/**
 * Orchestra sandbox shim.
 *
 * Runs inside the agent sandbox image (sandbox/Dockerfile) as a long-lived
 * process. It is the sandbox-side terminator of the single bidirectional
 * Orchestra↔sandbox connection: one WebSocket carries everything that is
 * local-only in the Electron app today, and this shim does sandbox-side exactly
 * what Orchestra does on the host —
 *
 *   1. PTY (pty.ts / local-pty.ts): on a `spawn` frame, start `claude …` in
 *      /workspace via node-pty; relay its output as `data` frames and its exit
 *      as an `exit` frame; apply `write`/`resize`/`kill` frames to it.
 *   2. Activity spool (events-spool.ts): tail $ORCHESTRA_EVENTS_DIR/<wsid>.jsonl
 *      (the agent's hooks append {event,tool?} lines there) and emit one `event`
 *      frame per line. The host no longer reads a local file — the frames are
 *      the spool.
 *   3. Hook control plane (hooks-server.ts): serve a unix socket at
 *      $ORCHESTRA_SOCK speaking the same tiny HTTP the agent already POSTs to
 *      (/rename /spawn /peers /read /message). Each request becomes an `rpc`
 *      frame sent to the host; the host runs the real dispatcher and answers
 *      with an `rpcReply`, which the shim returns as the HTTP response. The
 *      dispatchers (workspace creation, peer messaging, …) only make sense on
 *      the host, so the control plane is forwarded, not reimplemented here.
 *
 * The wire vocabulary and framing come verbatim from the vendored
 * sandbox-protocol.ts, so a frame the host encodes is the exact object this
 * shim decodes and vice-versa.
 *
 * One connection, many sessions: every terminal/event frame carries `session`
 * (the workspace id) so a single sandbox can host several agents at once. A
 * `spawn` frame's env/cwd are taken from the host (it resolves the same env
 * pty.ts builds), so the shim does not invent the claude command line — it runs
 * exactly what the host tells it to.
 */

import { spawn as ptySpawn, type IPty } from 'node-pty';
import { WebSocketServer, type WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FrameDecoder,
  encodeFrame,
  isFrame,
  type Frame,
  type SpawnFrame,
  type WriteFrame,
  type ResizeFrame,
  type KillFrame,
  type RpcReplyFrame,
  type HelloFrame,
  type RpcRoute,
  type RpcReplyPayload,
} from './sandbox-protocol.js';
import {
  parseSpoolChunk,
  routeFromUrl,
  maxBodyBytesFor,
  isForwarded,
  DriveBroker,
} from './shim-core.js';
import { createImportHandler, isProvisioned } from './shim-import.js';

// ─── Config (env-driven, with sane sandbox defaults) ────────────────────────

/** TCP port the WS server listens on inside the sandbox. The host's transport
 *  layer (Tailscale / direct TLS) terminates the outer TLS and connects here. */
const WS_PORT = Number(process.env.ORCHESTRA_SHIM_PORT ?? '8787');

/** Where the agent's hooks append activity lines. Must match the
 *  $ORCHESTRA_EVENTS_DIR handed to the agent PTY (we set it on spawn, below). */
const EVENTS_DIR = process.env.ORCHESTRA_EVENTS_DIR || '/home/agent/.orchestra/events';

/** Unix socket the agent POSTs hook routes to. Must match the $ORCHESTRA_SOCK
 *  handed to the agent PTY. */
const SOCK_PATH = process.env.ORCHESTRA_SOCK || '/home/agent/.orchestra/hooks.sock';

/** Safety-net rescan cadence for the spool tail, mirroring events-spool.ts. */
const SPOOL_POLL_MS = 1000;

/** The container-owned checkout. /workspace in the image (Dockerfile WORKDIR);
 *  overridable so tests can provision into a temp dir. */
const WORKSPACE_DIR = process.env.ORCHESTRA_WORKSPACE_DIR || '/workspace';

/** Where a successful import is recorded (for idempotent retries) and where
 *  the payload's claude-config is seeded. Both test-overridable. */
const IMPORT_META_PATH =
  process.env.ORCHESTRA_IMPORT_META || path.join(os.homedir(), '.orchestra', 'import-meta.json');
const CLAUDE_HOME = process.env.ORCHESTRA_CLAUDE_HOME || os.homedir();

// ─── Logging ────────────────────────────────────────────────────────────────

function log(...args: unknown[]): void {
  // Plain stderr — the shim's own diagnostics, never mixed into a session's
  // `data` stream (which is the agent PTY's stdout, relayed verbatim).
  console.error('[shim]', ...args);
}

// ─── Attached clients + the drive lock (P4 item C) ──────────────────────────
//
// A sandbox accepts MANY simultaneous Orchestra clients (one per machine), all
// receiving every data/exit/event frame — but exactly ONE, the driver, may
// write. The DriveBroker (shim-core.ts) owns the election: first client to
// `hello` drives, `takeControl` is an explicit take-over, a reconnect bearing
// the driver's clientId resumes its drive, and when the driver detaches the
// longest-attached identified client is promoted. Ownership changes are
// broadcast to everyone as `control` frames (isDriver computed per recipient).
//
// Broadcasts no-op when nobody is attached (the agent keeps running; output is
// recovered from scrollback on reattach — the PTY itself is unaffected).

const broker = new DriveBroker<WebSocket>();

/** Broadcast a sandbox→client frame to every attached client. */
function send(frame: Frame): void {
  const encoded = encodeFrame(frame);
  for (const ws of broker.connections()) {
    if (ws.readyState === ws.OPEN) ws.send(encoded);
  }
}

/** Send one client its current ownership state. */
function sendControl(ws: WebSocket): void {
  if (ws.readyState === ws.OPEN) ws.send(encodeFrame(broker.stateFor(ws)));
}

/** Ownership changed — tell every client where the drive now sits. */
function broadcastControl(): void {
  for (const ws of broker.connections()) sendControl(ws);
}

// ─── Sessions (agent PTYs) ──────────────────────────────────────────────────

interface Session {
  id: string;
  proc: IPty;
}

const sessions = new Map<string, Session>();

function startSession(f: SpawnFrame): void {
  if (sessions.has(f.session)) {
    log(`spawn ignored — session already running: ${f.session}`);
    return;
  }
  // The host resolves the full env (it owns the secrets contract); we make sure
  // the two sandbox-local rendezvous paths the agent's hooks use are present and
  // point at this shim's spool dir + socket, regardless of what the host sent.
  const env: Record<string, string> = {
    ...f.env,
    ORCHESTRA_WS_ID: f.session,
    ORCHESTRA_EVENTS_DIR: EVENTS_DIR,
    ORCHESTRA_SOCK: SOCK_PATH,
  };
  let proc: IPty;
  try {
    proc = ptySpawn(f.command, f.args, {
      name: 'xterm-256color',
      cols: f.cols,
      rows: f.rows,
      cwd: f.cwd,
      env,
    });
  } catch (e) {
    log(`spawn failed session=${f.session} cmd=${f.command}:`, e);
    // Surface as an immediate non-zero exit so the host doesn't wait forever for
    // a session that never started.
    send({ t: 'exit', session: f.session, exitCode: 127 });
    return;
  }
  log(`spawned session=${f.session} pid=${proc.pid} cmd=${f.command} cwd=${f.cwd}`);
  const session: Session = { id: f.session, proc };
  sessions.set(f.session, session);
  ensureSpoolWatch(f.session);

  proc.onData((data) => send({ t: 'data', session: f.session, data }));
  proc.onExit(({ exitCode }) => {
    log(`session exited session=${f.session} code=${exitCode}`);
    send({ t: 'exit', session: f.session, exitCode });
    sessions.delete(f.session);
    // Drain any final spool lines before forgetting the cursor.
    drainSpool(f.session);
  });
}

function handleWrite(f: WriteFrame): void {
  sessions.get(f.session)?.proc.write(f.data);
}

function handleResize(f: ResizeFrame): void {
  const s = sessions.get(f.session);
  if (!s) return;
  try {
    s.proc.resize(Math.max(20, f.cols), Math.max(5, f.rows));
  } catch {
    /* resize on a just-exited pty throws on some platforms — ignore */
  }
}

function handleKill(f: KillFrame): void {
  const s = sessions.get(f.session);
  if (!s) return;
  try {
    s.proc.kill();
  } catch {
    /* already dead */
  }
}

// ─── Activity spool tail ────────────────────────────────────────────────────
//
// Sandbox-side mirror of events-spool.ts. The agent's hooks append one JSON
// line per lifecycle event to <EVENTS_DIR>/<wsid>.jsonl; we tail each watched
// file and emit one `event` frame per line. We do NOT truncate the spool here
// (the host's drain owns turn-boundary truncation in the local case; here the
// frames are consumed live, so we just advance a byte cursor and let the file
// grow within a turn — it is reset by the agent hooks' own lifecycle the same
// way, and a long-lived file is bounded by the host truncating via … actually
// nothing truncates remotely yet, so we truncate at turn boundaries ourselves,
// exactly like events-spool.ts, to bound growth).

interface Cursor {
  offset: number;
  buffer: string;
}

const cursors = new Map<string, Cursor>();
const watched = new Set<string>();
let spoolWatcher: fs.FSWatcher | null = null;
let spoolPoll: ReturnType<typeof setInterval> | null = null;

function spoolPathFor(id: string): string {
  return path.join(EVENTS_DIR, `${id}.jsonl`);
}

function idFromFilename(name: string): string | null {
  if (!name.endsWith('.jsonl')) return null;
  return name.slice(0, -'.jsonl'.length) || null;
}

/** Begin tailing a session's spool file. Idempotent. The directory watcher is
 *  shared; this only marks the id as one we emit frames for. */
function ensureSpoolWatch(id: string): void {
  watched.add(id);
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  if (!spoolWatcher) {
    try {
      spoolWatcher = fs.watch(EVENTS_DIR, (_event, filename) => {
        if (!filename) {
          drainAllSpools();
          return;
        }
        const fid = idFromFilename(filename.toString());
        if (fid) drainSpool(fid);
      });
      spoolWatcher.on('error', () => {
        /* poll fallback keeps going */
      });
    } catch {
      spoolWatcher = null; // poll-only
    }
  }
  if (!spoolPoll) {
    spoolPoll = setInterval(drainAllSpools, SPOOL_POLL_MS);
    if (typeof spoolPoll.unref === 'function') spoolPoll.unref();
  }
  // Pick up anything already written before the watch was established.
  drainSpool(id);
}

function drainAllSpools(): void {
  for (const id of watched) drainSpool(id);
}

/** Read appended bytes since the cursor, emit one `event` frame per complete
 *  JSON line, and truncate at a turn boundary (stop/notify) — a near-verbatim
 *  port of events-spool.ts:drain, with the applyAgentEvent call replaced by an
 *  `event` frame to the host. */
function drainSpool(id: string): void {
  const p = spoolPathFor(id);
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch {
    return; // not created yet, or removed
  }
  let cur = cursors.get(id);
  if (!cur) {
    cur = { offset: 0, buffer: '' };
    cursors.set(id, cur);
  }
  if (size < cur.offset) {
    // File shrank (truncated at a turn boundary, or recreated) — restart.
    cur.offset = 0;
    cur.buffer = '';
  }
  if (size === cur.offset) return;

  let chunk = '';
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const len = size - cur.offset;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, cur.offset);
      chunk = buf.toString('utf8', 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  cur.offset = size;

  const { events, leftover, truncate } = parseSpoolChunk(cur.buffer, chunk);
  cur.buffer = leftover;
  for (const ev of events) {
    send({ t: 'event', session: id, event: ev.event, tool: ev.tool });
  }

  if (truncate) {
    try {
      fs.truncateSync(p, 0);
      cur.offset = 0;
    } catch {
      /* best-effort: next drain's shrink-detect recovers */
    }
  }
}

// ─── Hook control-plane socket → rpc frames ─────────────────────────────────
//
// Sandbox-side mirror of hooks-server.ts. The agent POSTs the five routes to
// $ORCHESTRA_SOCK; we forward each as an `rpc` frame to the host (the only side
// that can run the real dispatcher — it creates worktrees, messages peers,
// renames branches) and return the host's `rpcReply` payload as the HTTP
// response, so the agent's `curl` round-trips look identical to the local case.

let rpcSeq = 0;
const pendingRpc = new Map<number, (reply: RpcReplyPayload) => void>();

/** Forward one request to the DRIVER and resolve with its reply. Only the
 *  driving machine runs the dispatchers (it owns the workspace store the
 *  routes act on); observers never see rpc frames. Rejects (so the caller can
 *  502) if nobody drives or the driver never answers. */
function forwardRpc(route: RpcRoute, payload: unknown): Promise<RpcReplyPayload> {
  return new Promise((resolve, reject) => {
    const driver = broker.connections().find((ws) => broker.isDriver(ws));
    if (!driver || driver.readyState !== driver.OPEN) {
      reject(new Error('no driving Orchestra client attached'));
      return;
    }
    const id = ++rpcSeq;
    const timer = setTimeout(() => {
      if (pendingRpc.delete(id)) {
        reject(new Error(`rpc ${route} timed out`));
      }
    }, 30_000);
    if (typeof timer.unref === 'function') timer.unref();
    pendingRpc.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    // payload is the agent's POST body, shaped per RpcRequestPayloads[route]; the
    // host's dispatcher applies the same field guards hooks-server.ts does, so we
    // forward it as-is rather than re-validating here.
    driver.send(encodeFrame({ t: 'rpc', id, route, payload: payload as never }));
  });
}

function handleRpcReply(f: RpcReplyFrame): void {
  const resolver = pendingRpc.get(f.id);
  if (!resolver) return; // unknown/late id — drop
  pendingRpc.delete(f.id);
  resolver(f.payload);
}

function startHookSocket(): void {
  try {
    fs.mkdirSync(path.dirname(SOCK_PATH), { recursive: true });
  } catch {
    /* best-effort */
  }
  try {
    fs.unlinkSync(SOCK_PATH); // drop a stale socket from a prior run
  } catch {
    /* missing is fine */
  }

  const server = http.createServer((req, res) => {
    const sendJson = (code: number, obj: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const route = routeFromUrl(req.url);
    // Same per-route body caps as hooks-server.ts: /spawn and /message carry the
    // agent's opening prompt / message text and need headroom; the rest are tiny.
    const maxBytes = maxBodyBytesFor(route);
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > maxBytes) tooLarge = true;
    });
    req.on('error', () => {
      /* noop */
    });
    req.on('end', () => {
      void (async () => {
        if (tooLarge) {
          sendJson(413, { ok: false, error: 'payload too large' });
          return;
        }
        if (!isForwarded(route)) {
          // Activity/default route: the spool tail carries these, so just ack.
          sendJson(200, {});
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(body);
        } catch {
          sendJson(400, { ok: false, error: 'invalid JSON' });
          return;
        }
        try {
          const reply = await forwardRpc(route as RpcRoute, msg);
          sendJson(200, reply);
        } catch (e) {
          // Match hooks-server.ts's convention: a failed route still answers 200
          // with {ok:false} so the agent's curl gets a parseable body.
          sendJson(200, { ok: false, error: e instanceof Error ? e.message : 'rpc failed' });
        }
      })();
    });
  });

  server.on('error', (err) => log('hook socket server error:', err));
  server.listen(SOCK_PATH, () => {
    try {
      fs.chmodSync(SOCK_PATH, 0o600);
    } catch {
      /* best-effort */
    }
    log(`hook socket listening on ${SOCK_PATH}`);
  });
}

// ─── Frame dispatch ─────────────────────────────────────────────────────────

/** May this client's session-mutating frame (spawn/write/resize/kill) be
 *  honored? Driver: yes. No driver at all: adopt the sender (grandfathers a
 *  pre-ownership Orchestra build attached alone). Observer: dropped. */
function mayDrive(ws: WebSocket, what: string): boolean {
  if (broker.isDriver(ws)) return true;
  if (broker.adoptIfVacant(ws)) {
    log(`vacant drive adopted by a writing client (${what})`);
    broadcastControl();
    return true;
  }
  log(`dropping ${what} from a read-only observer`);
  return false;
}

function onFrame(ws: WebSocket, frame: Frame): void {
  // Only client→sandbox frames are valid here; a sandbox→client frame arriving
  // from the host is a protocol error we ignore (the host never sends data/exit/
  // event/rpc to us — those originate here).
  switch (frame.t) {
    case 'hello': {
      const f = frame as HelloFrame;
      log(`client hello id=${f.clientId} name=${f.name}`);
      if (broker.hello(ws, f.clientId, f.name)) broadcastControl();
      else sendControl(ws); // no change, but the newcomer needs its state
      break;
    }
    case 'takeControl':
      log('take-over requested');
      if (broker.takeControl(ws)) broadcastControl();
      break;
    case 'spawn': {
      const f = frame as SpawnFrame;
      // An observer "spawning" an ALREADY-running session is the reattach
      // flow: its transport is registered, data frames are broadcast, so it
      // just watches. startSession's dup guard makes this a no-op either way.
      if (sessions.has(f.session)) break;
      if (mayDrive(ws, 'spawn')) {
        startSession(f);
      } else if (ws.readyState === ws.OPEN) {
        // A dropped spawn for a NOT-running session would leave the observer
        // staring at a dead terminal forever — answer it (targeted, not
        // broadcast: only this client asked) with an explanation and an exit.
        ws.send(
          encodeFrame({
            t: 'data',
            session: f.session,
            data: '\r\n\x1b[33m[orchestra] read-only — another machine drives this sandbox; take control to start the agent\x1b[0m\r\n',
          }),
        );
        ws.send(encodeFrame({ t: 'exit', session: f.session, exitCode: 0 }));
      }
      break;
    }
    case 'write':
      if (mayDrive(ws, 'write')) handleWrite(frame as WriteFrame);
      break;
    case 'resize':
      if (mayDrive(ws, 'resize')) handleResize(frame as ResizeFrame);
      break;
    case 'kill':
      if (mayDrive(ws, 'kill')) handleKill(frame as KillFrame);
      break;
    case 'rpcReply':
      handleRpcReply(frame as RpcReplyFrame);
      break;
    default:
      log(`ignoring unexpected sandbox-bound frame type: ${(frame as Frame).t}`);
  }
}

// ─── WS + HTTP server ───────────────────────────────────────────────────────
//
// One TCP port serves both planes: WS upgrades carry the session protocol
// (frames), and two plain-HTTP routes carry the container admin plane —
// GET /healthz (is the shim up / is a workspace provisioned) and POST /import
// (one-way provisioning: bundle + overlay → container-owned /workspace
// checkout; see shim-import.ts). HTTP avoids the 16 MiB frame cap and needs no
// host→shim RPC correlation machinery.

function startWsServer(): void {
  const handleImport = createImportHandler({
    workspaceDir: WORKSPACE_DIR,
    claudeHome: CLAUDE_HOME,
    metaPath: IMPORT_META_PATH,
    log,
  });

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          provisioned: isProvisioned(WORKSPACE_DIR),
          sessions: [...sessions.keys()],
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/import') {
      handleImport(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  server.on('error', (err) => log('HTTP server error:', err));

  const wss = new WebSocketServer({ server });
  wss.on('error', (err) => log('WS server error:', err));

  wss.on('connection', (ws) => {
    broker.attach(ws);
    log(`client attached (${broker.clientCount} total)`);
    // Tell the newcomer who currently drives; its own role may change when it
    // says hello (or takes control).
    sendControl(ws);
    const decoder = new FrameDecoder();

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      // ws delivers binary frames as Buffer (or array of Buffers for fragmented
      // messages); normalize to a single Buffer for the length-prefixed decoder.
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      let frames: Frame[];
      try {
        frames = decoder.push(buf);
      } catch (e) {
        // A framing/JSON error is unrecoverable for the stream — tear it down
        // rather than try to resync (matches the protocol module's contract).
        log('frame decode error — closing connection:', e);
        try {
          ws.close(1002, 'protocol error');
        } catch {
          /* ignore */
        }
        return;
      }
      for (const frame of frames) {
        if (!isFrame(frame)) {
          log('dropping non-frame object on wire');
          continue;
        }
        onFrame(ws, frame);
      }
    });

    ws.on('close', () => {
      const wasDriver = broker.isDriver(ws);
      const changed = broker.detach(ws);
      log(`client detached (${broker.clientCount} remain${wasDriver ? ', was driver' : ''})`);
      if (wasDriver) {
        // The driver owned any in-flight rpc dispatch — fail them so the
        // agent's curl doesn't hang for the full timeout.
        for (const [id, resolver] of pendingRpc) {
          pendingRpc.delete(id);
          resolver({ ok: false, error: 'driving client detached' });
        }
      }
      if (changed) broadcastControl();
      // Sessions are intentionally left running — they survive a detach and are
      // reattached later (the whole point of the always-on sandbox).
    });

    ws.on('error', (err) => log('client socket error:', err));
  });

  server.listen(WS_PORT, () => log(`shim WS+HTTP listening on :${WS_PORT}`));
}

// ─── Boot ───────────────────────────────────────────────────────────────────

function main(): void {
  log(`starting — events=${EVENTS_DIR} sock=${SOCK_PATH} port=${WS_PORT}`);
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  startHookSocket();
  startWsServer();
}

main();
