// LOCAL FAKE Anthropic API for the session-budget suite (#208, D6: zero tokens).
//
// Records EVERY request the real `claude` CLI makes to ANTHROPIC_BASE_URL and answers with a
// canned, wire-valid reply. Also runs an egress-recording forward proxy (HTTPS_PROXY target) that
// REFUSES everything, so a host the CLI reaches for outside the base URL is listed, never served.
//
//   const api = await startFakeApi();          // { url, proxyUrl, requests, egress, stop(), ... }
//   env.ANTHROPIC_BASE_URL = api.url; env.HTTPS_PROXY = env.HTTP_PROXY = api.proxyUrl;
//   ... run a session ...
//   api.summary();  // { byType: { model: 1, count_tokens: 0, ... }, egress: [...], total }
//
// Request `type` is the budget axis: `model` (POST /v1/messages), `count_tokens`
// (POST /v1/messages/count_tokens), `models`, `bootstrap`, `other`. Sub-typed by `model`/purpose
// where the body says so (`modelRequests[]` carries model + max_tokens + tools + stream).

import http from 'node:http';
import net from 'node:net';

const CANNED_TEXT = 'ok';

/** Classify one request into a budget axis. Pure — unit-tested via the self-test. */
export function classifyRequest(method, pathname) {
  const p = pathname.replace(/\/+$/, '');
  if (method === 'POST' && p === '/v1/messages') return 'model';
  if (method === 'POST' && p === '/v1/messages/count_tokens') return 'count_tokens';
  if (method === 'GET' && (p === '/v1/models' || p.startsWith('/v1/models/'))) return 'models';
  if (p.includes('bootstrap')) return 'bootstrap';
  return 'other';
}

function sseEvent(ev, data) {
  return `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A complete, wire-valid streamed assistant reply (text only, end_turn). */
export function streamedTextReply({ model = 'claude-fake', text = CANNED_TEXT, id = 'msg_fake_1', inputTokens = 12 } = {}) {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('ping', { type: 'ping' }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
}

/** The non-streamed variant of the same reply (a `stream:false` /v1/messages call). */
export function jsonTextReply({ model = 'claude-fake', text = CANNED_TEXT, id = 'msg_fake_1', inputTokens = 12 } = {}) {
  return {
    id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function summarizeModelBody(buf, markers = {}) {
  try {
    const text = buf.toString('utf8');
    const b = JSON.parse(text);
    const sysText = typeof b.system === 'string' ? b.system : Array.isArray(b.system) ? b.system.map((s) => s?.text ?? '').join('\n') : '';
    return {
      model: b.model ?? null,
      max_tokens: b.max_tokens ?? null,
      stream: b.stream === true,
      tools: Array.isArray(b.tools) ? b.tools.length : 0,
      messages: Array.isArray(b.messages) ? b.messages.length : 0,
      systemBytes: sysText.length,
      hasThinking: !!b.thinking,
      // Which planted sentinels (opts.markers name -> substring) this request body carries.
      marks: Object.keys(markers).filter((k) => text.includes(markers[k])),
    };
  } catch {
    return { model: null, unparsable: true };
  }
}

/**
 * Start the fake API + the refusing egress proxy on 127.0.0.1.
 * @param {object} [opts]
 * @param {(req: object) => ({text?: string}|undefined)} [opts.reply]   per-model-request override
 * @param {number} [opts.replyDelayMs]  delay before the first SSE byte of a /v1/messages reply
 * @param {Record<string,string>} [opts.markers]  sentinel name -> substring to look for in request bodies
 * @param {(rec: object) => void} [opts.onRequest]  observer, called for every recorded request
 */
export async function startFakeApi(opts = {}) {
  const t0 = process.hrtime.bigint();
  const now = () => Number(process.hrtime.bigint() - t0) / 1e6;
  /** @type {any[]} */ const requests = [];
  /** @type {any[]} */ const egress = [];
  let seq = 0;
  let modelSeq = 0;

  const server = http.createServer(async (req, res) => {
    req.socket.on('error', () => {});
    const u = new URL(req.url ?? '/', 'http://fake.invalid');
    const body = await readBody(req);
    const type = classifyRequest(req.method ?? 'GET', u.pathname);
    const rec = {
      seq: ++seq, tMs: now(), method: req.method, path: u.pathname, query: u.search, type,
      bodyBytes: body.length,
      auth: req.headers['x-api-key'] ? 'x-api-key' : req.headers.authorization ? 'bearer' : 'none',
      ua: String(req.headers['user-agent'] ?? '').slice(0, 60),
      beta: String(req.headers['anthropic-beta'] ?? ''),
    };
    if (type === 'model' || type === 'count_tokens') Object.assign(rec, summarizeModelBody(body, opts.markers));
    requests.push(rec);
    try { opts.onRequest?.(rec); } catch { /* observer errors never break the fake */ }

    if (type === 'model') {
      const override = opts.reply?.(rec);
      const text = override?.text ?? CANNED_TEXT;
      const id = `msg_fake_${++modelSeq}`;
      if (opts.replyDelayMs) await new Promise((r) => setTimeout(r, opts.replyDelayMs));
      if (rec.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': `req_fake_${rec.seq}` });
        res.end(streamedTextReply({ model: rec.model ?? 'claude-fake', text, id }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_fake_${rec.seq}` });
        res.end(JSON.stringify(jsonTextReply({ model: rec.model ?? 'claude-fake', text, id })));
      }
      return;
    }
    if (type === 'count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_fake_${rec.seq}` });
      res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(body.length / 4)) }));
      return;
    }
    if (type === 'models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }));
      return;
    }
    // Everything else: an honest, recorded 404 (the CLI must tolerate it — the spike proves it does).
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `fake api: no route ${req.method} ${u.pathname}` } }));
  });

  // Egress-recording proxy: a CONNECT (https) or absolute-URI (http) request is RECORDED and REFUSED.
  const proxy = http.createServer((req, res) => {
    egress.push({ tMs: now(), via: 'http', method: req.method, target: req.url });
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('egress refused by session-budget suite');
  });
  proxy.on('connect', (req, sock) => {
    sock.on('error', () => {}); // a refused client may RST — never crash the fake on it
    egress.push({ tMs: now(), via: 'connect', target: req.url });
    sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  proxy.on('clientError', (_e, sock) => { try { sock.destroy(); } catch { /* ignore */ } });

  const listen = (srv) => new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(opts.port ?? 0, '127.0.0.1', () => resolve(/** @type {net.AddressInfo} */ (srv.address()).port));
  });
  const [port, proxyPort] = [await listen(server), await listen(proxy)];

  const byType = () => {
    const out = {};
    for (const r of requests) out[r.type] = (out[r.type] ?? 0) + 1;
    return out;
  };
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    proxyPort,
    requests,
    egress,
    now,
    /** Counts by type since start; `since` (a tMs) restricts to requests at/after it. */
    counts(since = 0) {
      const out = {};
      for (const r of requests) if (r.tMs >= since) out[r.type] = (out[r.type] ?? 0) + 1;
      return out;
    },
    summary() {
      return { total: requests.length, byType: byType(), egress: egress.map((e) => e.target), paths: [...new Set(requests.map((r) => `${r.method} ${r.path}`))] };
    },
    async stop() {
      await Promise.all([server, proxy].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
    },
  };
}
