// Scripted fake Anthropic API for the pause-trap rig (#252 D1b): like the session-budget fake, but the
// main (tool-carrying) request can answer with a `tool_use` so the REAL `claude` CLI spawns REAL tool
// processes. Zero tokens: nothing leaves loopback inside the rig's net namespace.
//
// A turn's scenario is named by a `SCN:<name>` token in the user prompt. Step = how many assistant
// messages already follow that prompt; steps are `{tool:{name,input}}` (tool_use, stop_reason tool_use)
// or `{text}` (end_turn). Past the last step the reply is text `ok`.
import http from 'node:http';
import fs from 'node:fs';

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
/** EVERYTHING a message shows the model — text blocks AND tool_result contents (a hook's additionalContext rides there). */
const allTextOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (!b ? '' : b.type === 'text' ? b.text : b.type === 'tool_result' ? allTextOf(b.content) : '')).join('\n') : '');
/** #254: the Pause-douce order text the host injects at a tool-result boundary (src/shared/pause-douce.ts renderPauseOrder). */
export const ORDER_RE = /PAUSE DOUCE — run /;

/** Which scenario + step does this request continue? A scenario is an ARRAY of steps (by index) or a FUNCTION `ctx => step`
 *  (ctx = { idx, assistant (the assistant messages since the prompt), order (the request's tail — after the last assistant message — shows the pause order), orderEver (it showed it in some request still in the history), flags }). */
export function locateStep(messages, scenarios, flags = {}) {
  let scn = null, from = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const hit = /SCN:([a-z0-9_-]+)/i.exec(textOf(m.content));
    if (hit) { scn = hit[1]; from = i; break; }
  }
  if (!scn || !scenarios[scn]) return { scn, step: { text: 'ok' }, idx: -1, order: false };
  const after = messages.slice(from + 1);
  const assistant = after.filter((m) => m.role === 'assistant');
  const idx = assistant.length;
  // The CLI attaches a hook's additionalContext as a trailing role:'system' message ("PostToolUse:Bash hook additional context: …") AFTER the tool_result
  // user message, for ONE request only — so `order` = anything after the last assistant message shows it (any role), not just the last user message.
  let lastAsst = -1;
  after.forEach((m, i) => { if (m.role === 'assistant') lastAsst = i; });
  const order = after.slice(lastAsst + 1).some((m) => ORDER_RE.test(allTextOf(m.content)));
  const orderEver = after.some((m) => ORDER_RE.test(allTextOf(m.content)));
  const sc = scenarios[scn];
  const step = typeof sc === 'function' ? sc({ idx, assistant, order, orderEver, flags }) : (sc[idx] ?? { text: 'ok' });
  return { scn, step, idx, order, orderEver };
}

export async function startScriptedApi({ apiPort, scenarios, onRequest }) {
  const requests = [];
  const flags = {}; // the driver flips these mid-run (e.g. flags.quota = true: the `loopquota` member's next request is refused like an exhausted plan)
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
      const located = tools > 0 ? locateStep(b.messages ?? [], scenarios, flags) : { scn: null, step: { text: 'ok' }, idx: -1, order: false };
      const rec = { seq: ++n, t: Date.now(), model: b.model, tools, stream: b.stream === true, scn: located.scn, idx: located.idx, tool: located.step.tool?.name ?? null, order: !!located.order, orderEver: !!located.orderEver };
      requests.push(rec);
      // debug aid (PT_DUMP_API=<file>): the tail of every main request's conversation, to see what a hook's additionalContext looks like on the wire
      if (process.env.PT_DUMP_API && tools > 0) { try { fs.appendFileSync(process.env.PT_DUMP_API, `${JSON.stringify({ seq: rec.seq, t: rec.t, scn: rec.scn, order: rec.order, tail: (b.messages ?? []).slice(-3) })}\n`); } catch { /* debug only */ } }
      try { onRequest?.(rec); } catch { /* observer errors never break the fake */ }
      const id = `msg_fake_${n}`;
      if (located.step.http) {
        // an API ERROR reply (e.g. 429: the plan is exhausted) — `x-should-retry: false` so the CLI ends the turn instead of backing off for minutes
        res.writeHead(located.step.http.status, { 'content-type': 'application/json', 'request-id': `req_${n}`, 'x-should-retry': 'false' });
        res.end(JSON.stringify(located.step.http.body));
        return;
      }
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
    flags,
    async stop() { await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }); },
  };
}
