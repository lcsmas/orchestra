// C2 #209 — a fake Anthropic API that can ask for TOOL CALLS (C1's fake only answers text). Reuses C1's request
// classifier and text-reply builders (import, not copy); adds a per-turn plan: a prompt containing `TOOLS=<k>` makes
// the fake answer with k sequential Bash tool_use blocks (one per model request), then a final text reply.
// Zero tokens (D6): nothing here ever leaves 127.0.0.1. Same egress-refusing proxy contract as C1 (recorded + 403).
import http from 'node:http';
import { classifyRequest, streamedTextReply, jsonTextReply } from '../session-budget/fake-anthropic-api.mjs';

const sse = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
function toolUseReply({ model, id, toolId, name, input }) {
  const u = { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  return [
    sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: u } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name, input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { ...u, output_tokens: 20 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('');
}

/** A text reply streamed as `deltas` separate text_delta events (~6 chars each) — the CLI's includePartialMessages path. */
function streamedDeltas({ model, id, deltas }) {
  const u = { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const ev = [
    sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: u } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (let i = 0; i < deltas; i++) ev.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${i % 10} ` } }));
  ev.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }), sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...u, output_tokens: deltas } }), sse('message_stop', { type: 'message_stop' }));
  return ev.join('');
}

/** The same delta stream, but PACED at `rate` deltas/second (a model streaming tokens), written as it goes. */
async function streamProgressive(res, { model, id, deltas, rate }) {
  const u = { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  res.write(sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: u } }));
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  const tickMs = 50, perTick = Math.max(1, Math.round((rate * tickMs) / 1000));
  for (let i = 0; i < deltas; i += perTick) {
    for (let j = i; j < Math.min(deltas, i + perTick); j++) res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${j % 10} ` } }));
    await new Promise((r) => setTimeout(r, tickMs));
  }
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
  res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...u, output_tokens: deltas } }));
  res.end(sse('message_stop', { type: 'message_stop' }));
}

/** Plan for this request from the message list: how many tool_results since the last human text turn, and k from `TOOLS=k`. */
export function planFor(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  let done = 0, k = 0, stream = 0, rate = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    const results = parts.filter((p) => p.type === 'tool_result').length;
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
    if (m.role === 'user' && results === 0 && /TOOLS=\d+/.test(text)) { k = Number(/TOOLS=(\d+)/.exec(text)[1]); stream = Number(/STREAM=(\d+)/.exec(text)?.[1] ?? 0); rate = Number(/RATE=(\d+)/.exec(text)?.[1] ?? 0); break; }
    if (m.role === 'user') done += results;
  }
  return { k, done, stream, rate };
}

export async function startFakeApiWithTools(opts = {}) {
  const t0 = process.hrtime.bigint();
  const now = () => Number(process.hrtime.bigint() - t0) / 1e6;
  const requests = [], egress = [];
  let seq = 0, modelSeq = 0;
  const server = http.createServer(async (req, res) => {
    req.socket.on('error', () => {});
    const u = new URL(req.url ?? '/', 'http://fake.invalid');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const type = classifyRequest(req.method ?? 'GET', u.pathname);
    let body = null;
    if (type === 'model' || type === 'count_tokens') { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
    const rec = { seq: ++seq, tMs: now(), method: req.method, path: u.pathname, type, bodyBytes: raw.length, model: body?.model ?? null, stream: body?.stream === true, tools: Array.isArray(body?.tools) ? body.tools.length : 0, messages: Array.isArray(body?.messages) ? body.messages.length : 0 };
    if (type === 'model' && rec.tools === 0) { const c = body?.messages?.[0]?.content; rec.preview = (typeof c === 'string' ? c : JSON.stringify(c ?? '')).replace(/\s+/g, ' ').slice(0, 110); }
    requests.push(rec);
    if (type === 'model') {
      const { k, done, stream, rate } = planFor(body);
      const id = `msg_fake_${++modelSeq}`;
      if (opts.replyDelayMs) await new Promise((r) => setTimeout(r, opts.replyDelayMs));
      const wantTool = done < k;
      rec.plan = wantTool ? `tool_use ${done + 1}/${k}` : 'text';
      if (rec.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_fake_${rec.seq}` });
        if (!wantTool && stream > 0 && rate > 0) { await streamProgressive(res, { model: rec.model ?? 'claude-fake', id, deltas: stream, rate }); return; }
        res.end(wantTool
          ? toolUseReply({ model: rec.model ?? 'claude-fake', id, toolId: `toolu_fake_${rec.seq}`, name: 'Bash', input: { command: 'true', description: 'hc tool call' } })
          : (stream > 0 ? streamedDeltas({ model: rec.model ?? 'claude-fake', id, deltas: stream }) : streamedTextReply({ model: rec.model ?? 'claude-fake', text: 'ok', id })));
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_fake_${rec.seq}` });
        res.end(JSON.stringify(jsonTextReply({ model: rec.model ?? 'claude-fake', text: 'ok', id })));
      }
      return;
    }
    if (type === 'count_tokens') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(raw.length / 4)) })); return; }
    if (type === 'models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [], has_more: false })); return; }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `fake api: no route ${req.method} ${u.pathname}` } }));
  });
  const proxy = http.createServer((req, res) => { egress.push({ tMs: now(), target: req.url }); res.writeHead(403); res.end('egress refused'); });
  proxy.on('connect', (req, sock) => { sock.on('error', () => {}); egress.push({ tMs: now(), target: req.url }); sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
  const listen = (s) => new Promise((ok, no) => { s.once('error', no); s.listen(0, '127.0.0.1', () => ok(s.address().port)); });
  const [port, proxyPort] = [await listen(server), await listen(proxy)];
  return {
    url: `http://127.0.0.1:${port}`, proxyUrl: `http://127.0.0.1:${proxyPort}`, requests, egress, now,
    async stop() { await Promise.all([server, proxy].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }))); },
  };
}
