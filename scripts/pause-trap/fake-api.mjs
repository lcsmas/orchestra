// Scripted fake Anthropic API for the pause-trap rig (#252 D1b): like the session-budget fake, but the
// main (tool-carrying) request can answer with a `tool_use` so the REAL `claude` CLI spawns REAL tool
// processes. Zero tokens: nothing leaves loopback inside the rig's net namespace.
//
// A turn's scenario is named by a `SCN:<name>` token in the user prompt. Step = how many assistant
// messages already follow that prompt; steps are `{tool:{name,input}}` (tool_use, stop_reason tool_use)
// or `{text}` (end_turn). Past the last step the reply is text `ok`.
import http from 'node:http';

const sse = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
const usage = (n = 12) => ({ input_tokens: n, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

function streamReply({ model, id, step }) {
  const head = sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: usage() } });
  if (step.tool) {
    const toolId = `toolu_${id.slice(-8)}`;
    return [head,
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: step.tool.name, input: {} } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input) } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: usage() }),
      sse('message_stop', { type: 'message_stop' })].join('');
  }
  return [head,
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text ?? 'ok' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usage() }),
    sse('message_stop', { type: 'message_stop' })].join('');
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n') : '');

/** Which scenario + step does this request continue? */
export function locateStep(messages, scenarios) {
  let scn = null, from = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const hit = /SCN:([a-z0-9_-]+)/i.exec(textOf(m.content));
    if (hit) { scn = hit[1]; from = i; break; }
  }
  if (!scn || !scenarios[scn]) return { scn, step: { text: 'ok' }, idx: -1 };
  const idx = messages.slice(from + 1).filter((m) => m.role === 'assistant').length;
  return { scn, step: scenarios[scn][idx] ?? { text: 'ok' }, idx };
}

export async function startScriptedApi({ apiPort, scenarios, onRequest }) {
  const requests = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    req.socket.on('error', () => {});
    const u = new URL(req.url ?? '/', 'http://fake.invalid');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const p = u.pathname.replace(/\/+$/, '');
    if (req.method === 'POST' && p === '/v1/messages') {
      let b = {};
      try { b = JSON.parse(body.toString('utf8')); } catch { /* keep {} */ }
      const tools = Array.isArray(b.tools) ? b.tools.length : 0;
      const located = tools > 0 ? locateStep(b.messages ?? [], scenarios) : { scn: null, step: { text: 'ok' }, idx: -1 };
      const rec = { seq: ++n, t: Date.now(), model: b.model, tools, stream: b.stream === true, scn: located.scn, idx: located.idx, tool: located.step.tool?.name ?? null };
      requests.push(rec);
      try { onRequest?.(rec); } catch { /* observer errors never break the fake */ }
      const id = `msg_fake_${n}`;
      if (rec.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${n}` });
        res.end(streamReply({ model: b.model ?? 'claude-fake', id, step: located.step }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${n}` });
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: b.model ?? 'claude-fake', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: usage() }));
      }
      return;
    }
    if (req.method === 'POST' && p === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(body.length / 4)) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `no route ${req.method} ${u.pathname}` } }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(apiPort ?? 0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    async stop() { await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }); },
  };
}
