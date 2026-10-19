// Accès mobile private channel (#338 review M1): main ⇄ the phone server talk over the socketpair main hands the server as fd 3
// at spawn — NOT over the hooks socket, which every local agent can reach (`$ORCHESTRA_SOCK`). The `/mobile/*` operations exist
// only here, so only the process main spawned can make a phone send (origin 'human', a pause bypass by decision).
// Newline-delimited JSON; pure (any Duplex-like), so node --test drives both ends.
//   client → main : {id, route, body}            a call   |  {id, route, stream: true}  a stream  |  {id, cancel: true}
//   main → client : {id, result}                 a reply  |  {id, msg}  a stream item  |  {id, end: true}

export interface RpcWire {
  write(chunk: string): unknown;
  on(event: 'data', cb: (chunk: Buffer | string) => void): unknown;
  on(event: 'close' | 'end', cb: () => void): unknown;
}

import { StringDecoder } from 'node:string_decoder';

/** A conversation projection is ≤ MAX_PHONE_CHARS (1.5 M) chars of text before JSON escaping (≤ 6× worst case): room to spare. */
export const MAX_LINE = 24 * 1_048_576; // above MOBILE_ATTACH_MAX_BODY: a send with attachments is ONE line
/** Main answers at most this many calls of one server at once; beyond, `{ok:false, error:'busy'}` (final review m3). */
export const MAX_CALLS_IN_FLIGHT = 32;

function lineReader(onLine: (v: unknown) => void, onOverflow: () => void): (chunk: Buffer | string) => void {
  let buf = '';
  // A multi-byte character split across two reads must not become U+FFFD (accents in a message, emoji) — final review m2.
  const decoder = new StringDecoder('utf8');
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        /* a torn / foreign line is dropped, never fatal */
      }
    }
    if (buf.length > MAX_LINE) {
      buf = '';
      onOverflow();
    }
  };
}

// ---------- the phone server's side ----------

export interface RpcClient {
  call(route: string, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  stream(route: string, onMsg: (m: unknown) => void, onEnd: () => void): () => void;
}

/** `onDead` fires once when the channel is unusable (closed, or a line over MAX_LINE): the server process should then exit so main
 *  restarts it — a client that stays dead while the process lives answers 502 forever (final review m1). */
export function createRpcClient(wire: RpcWire, defaultTimeoutMs = 5000, onDead?: () => void): RpcClient {
  let next = 1;
  const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const streams = new Map<number, { onMsg: (m: unknown) => void; onEnd: () => void }>();
  let dead = false;
  const die = (): void => {
    if (dead) return;
    dead = true;
    for (const [, c] of calls) {
      clearTimeout(c.timer);
      c.reject(new Error('main channel closed'));
    }
    calls.clear();
    for (const [, s] of streams) s.onEnd();
    streams.clear();
    onDead?.();
  };
  wire.on(
    'data',
    lineReader((v) => {
      if (!v || typeof v !== 'object') return;
      const m = v as { id?: unknown; result?: unknown; msg?: unknown; end?: unknown };
      if (typeof m.id !== 'number') return;
      const c = calls.get(m.id);
      if (c && 'result' in m) {
        calls.delete(m.id);
        clearTimeout(c.timer);
        c.resolve(m.result);
        return;
      }
      const s = streams.get(m.id);
      if (!s) return;
      if (m.end === true) {
        streams.delete(m.id);
        s.onEnd();
      } else if ('msg' in m) s.onMsg(m.msg);
    }, die),
  );
  wire.on('close', die);
  wire.on('end', die);
  return {
    call(route, body, timeoutMs = defaultTimeoutMs) {
      if (dead) return Promise.reject(new Error('main channel closed'));
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          reject(new Error('main channel timeout'));
        }, timeoutMs);
        calls.set(id, { resolve, reject, timer });
        wire.write(JSON.stringify({ id, route, body }) + '\n');
      });
    },
    stream(route, onMsg, onEnd) {
      if (dead) {
        onEnd();
        return () => {};
      }
      const id = next++;
      streams.set(id, { onMsg, onEnd });
      wire.write(JSON.stringify({ id, route, stream: true }) + '\n');
      return () => {
        if (!streams.delete(id) || dead) return;
        wire.write(JSON.stringify({ id, cancel: true }) + '\n');
      };
    },
  };
}

// ---------- main's side ----------

export interface RpcHandlers {
  call(route: string, body: Record<string, unknown>): Promise<unknown>;
  /** Subscribe; returns the unsubscribe. */
  stream(route: string, push: (msg: unknown) => void): (() => void) | null;
}

/** Serve one phone server. Returns a disposer (unsubscribes every open stream). */
export function serveRpc(wire: RpcWire, handlers: RpcHandlers, onError?: (e: unknown) => void): () => void {
  const subs = new Map<number, () => void>();
  let closed = false;
  let inFlight = 0;
  const send = (obj: unknown): void => {
    if (!closed) wire.write(JSON.stringify(obj) + '\n');
  };
  const dispose = (): void => {
    closed = true;
    for (const [, off] of subs) off();
    subs.clear();
  };
  wire.on(
    'data',
    lineReader(
      (v) => {
        if (!v || typeof v !== 'object') return;
        const m = v as { id?: unknown; route?: unknown; body?: unknown; stream?: unknown; cancel?: unknown };
        if (typeof m.id !== 'number') return;
        const id = m.id;
        if (m.cancel === true) {
          subs.get(id)?.();
          subs.delete(id);
          return;
        }
        if (typeof m.route !== 'string') return;
        if (m.stream === true) {
          if (subs.has(id)) return;
          const off = handlers.stream(m.route, (msg) => send({ id, msg }));
          if (off) subs.set(id, off);
          else send({ id, end: true });
          return;
        }
        const body = m.body && typeof m.body === 'object' && !Array.isArray(m.body) ? (m.body as Record<string, unknown>) : {};
        if (inFlight >= MAX_CALLS_IN_FLIGHT) return send({ id, result: { ok: false, error: 'busy' } });
        inFlight++;
        handlers
          .call(m.route, body)
          .then(
            (result) => send({ id, result }),
            (e: unknown) => {
              onError?.(e);
              send({ id, result: { ok: false, error: e instanceof Error ? e.message : String(e) } });
            },
          )
          .finally(() => {
            inFlight--;
          });
      },
      () => onError?.(new Error('rpc line overflow')),
    ),
  );
  wire.on('close', dispose);
  wire.on('end', dispose);
  return dispose;
}
