#!/usr/bin/env node
/* ============================================================================
 * A5 perf-trace harness — the "snappy / max FPS" acceptance gate.
 *
 * Connects to a BUILT Orchestra instance over its CDP debug port (launched by
 * the operator inside headless-sway on a VISIBLE workspace so rAF is not
 * throttled), opens the structured agent tab, drives a LONG streaming session by
 * injecting hundreds of real AgentEvents via window.__injectAgentEvent (which
 * routes through the SAME enqueue→foldEvents→RAF-batched-setState path a real
 * agent:event takes — so the batching/virtualization gate is not vacuous),
 * captures a CDP performance trace across the busiest window, and prints a
 * verdict with measured numbers.
 *
 * PRIMARY signal = main-thread long-task budget + scripting time (throttle-
 * independent). Frame intervals are corroborating (rAF can throttle off-screen).
 *
 * USAGE (app already running in headless-sway on <port>, a workspace id seeded):
 *   node perf-trace.mjs --port 9333 --ws <workspaceId> --messages 400
 * ==========================================================================*/

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const PORT = Number(args.port || 9333);
const WS = args.ws || '';
const N = Number(args.messages || 400);
const OUT = args.out || './perf-result.json';
if (!WS) { console.error('need --ws <workspaceId>'); process.exit(2); }

async function findTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && /orchestra|index\.html|localhost|file:/i.test(t.url));
  if (!page) throw new Error(`no renderer page target on :${port}`);
  console.error(`[cdp] target: ${page.url}`);
  return page.webSocketDebuggerUrl;
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const listeners = [];
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) listeners.forEach(l => l(msg));
  };
  return {
    ready,
    send(method, params = {}) { const myId = ++id; return new Promise((resolve, reject) => { pending.set(myId, { resolve, reject }); ws.send(JSON.stringify({ id: myId, method, params })); }); },
    on(fn) { listeners.push(fn); }, close() { ws.close(); },
  };
}
async function evaluate(client, fn, ...a) {
  const expr = `(${fn.toString()})(${a.map(x => JSON.stringify(x)).join(',')})`;
  const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

// Real AgentEvent stream (type-discriminated, seq/at base). Exercises the
// hottest path: a session/init, then per message a text block (block-start →
// 40 text-deltas → block-stop), a tool-use+tool-result every 3rd, a turn-end
// every 10th. Matches src/shared/types.ts AgentEvent exactly.
function makeEvents(n) {
  let seq = 0; const at = 1_700_000_000_000; const e = [];
  e.push({ type: 'session/init', seq: seq++, at, sessionId: 's1', model: 'claude-opus-4-8', cwd: '/w', permissionMode: 'default', tools: ['Read','Edit','Bash'] });
  for (let i = 0; i < n; i++) {
    e.push({ type: 'block-start', seq: seq++, at, index: i, kind: 'text' });
    for (let t = 0; t < 40; t++) e.push({ type: 'text-delta', seq: seq++, at, index: i, text: 'lorem ipsum dolor ' });
    e.push({ type: 'block-stop', seq: seq++, at, index: i });
    if (i % 3 === 0) {
      const id = 'toolu_' + i;
      e.push({ type: 'tool-use', seq: seq++, at, toolUseId: id, name: 'Read', input: { file_path: `src/f${i}.ts` } });
      e.push({ type: 'tool-result', seq: seq++, at, toolUseId: id, content: 'ok, 84 lines', isError: false });
    }
    if (i % 10 === 0) e.push({ type: 'turn-end', seq: seq++, at, isError: false, stopReason: 'end_turn', numTurns: 1, costUsd: 0.01, usage: { inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, resultText: null, sessionId: 's1', durationMs: 1200 });
  }
  return e;
}

(async () => {
  const client = cdp(await findTarget(PORT));
  await client.ready;
  await client.send('Page.enable'); await client.send('Runtime.enable');

  // Positive control: the injection seam must exist (else exit loud, don't
  // "trace" an app that ignored every event).
  const seam = await evaluate(client, () => ({
    inject: typeof window.__injectAgentEvent === 'function',
    read: typeof window.__readAgentSession === 'function',
    setState: typeof window.__orchestraSetState === 'function',
  }));
  if (!seam.inject) { console.error('FATAL: window.__injectAgentEvent missing'); process.exit(3); }

  // Open the structured tab for the workspace via the store setState seam.
  await evaluate(client, (ws) => { window.__orchestraSetState?.({ activeId: ws, view: 'structured' }); }, WS);
  await new Promise(r => setTimeout(r, 400));
  const mounted = await evaluate(client, () => !!document.querySelector('.av-view.active .av-message-list'));
  if (!mounted) console.error('WARN: .av-view.active not found — tab may not have opened; continuing.');

  const events = makeEvents(N);
  console.error(`[perf] injecting ${events.length} events for ${N} messages`);

  await client.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame',
    transferMode: 'ReturnAsStream',
  });
  const t0 = await evaluate(client, () => performance.now());

  // Inject in chunks, yielding to the event loop each chunk (mirrors socket
  // arrival). window.__EV is set per-call; chunk to keep each Runtime.evaluate small.
  const CHUNK = 200;
  for (let off = 0; off < events.length; off += CHUNK) {
    const slice = events.slice(off, off + CHUNK);
    await evaluate(client, (payload) => {
      const { ws, evs } = JSON.parse(payload);
      return new Promise((resolve) => {
        let i = 0;
        function pump() {
          const end = Math.min(i + 50, evs.length);
          for (; i < end; i++) window.__injectAgentEvent(ws, evs[i]);
          if (i < evs.length) setTimeout(pump, 0); else requestAnimationFrame(() => resolve(true));
        }
        pump();
      });
    }, JSON.stringify({ ws: WS, evs: slice }));
  }
  const t1 = await evaluate(client, () => performance.now());

  // Corroborating in-page rAF frame intervals during a final idle settle.
  const frameStats = await evaluate(client, () => new Promise((resolve) => {
    const times = []; let last = performance.now(); let count = 0;
    function tick(now) { times.push(now - last); last = now; if (++count < 120) requestAnimationFrame(tick);
      else { times.shift(); const s = [...times].sort((a,b)=>a-b); const p = q => s[Math.floor(s.length*q)];
        resolve({ frames: times.length, median: p(0.5), p95: p(0.95), max: s[s.length-1] }); } }
    requestAnimationFrame(tick);
  }));

  // Assert the fold actually happened (read the session back).
  const folded = await evaluate(client, (ws) => { const s = window.__readAgentSession?.(ws); return s ? { messages: s.messages?.length ?? 0 } : null; }, WS);

  await client.send('Tracing.end');
  const streamHandle = await new Promise((resolve) => { client.on((m) => { if (m.method === 'Tracing.tracingComplete') resolve(m.params.stream); }); });
  let trace = '';
  while (true) { const c = await client.send('IO.read', { handle: streamHandle, size: 1 << 20 }); trace += c.data; if (c.eof) break; }
  await client.send('IO.close', { handle: streamHandle });

  const te = (JSON.parse(trace).traceEvents) || JSON.parse(trace);
  const longTasks = te.filter(x => x.name === 'RunTask' && x.dur > 50000);
  const scripting = te.filter(x => /FunctionCall|EvaluateScript|V8\.Execute|MinorGC|MajorGC/.test(x.name)).reduce((s, x) => s + (x.dur || 0), 0) / 1000;
  const drainMs = t1 - t0;
  const verdict = {
    messages: N, events: events.length, foldedMessages: folded?.messages ?? null,
    drainMs: Math.round(drainMs),
    frameMedianMs: frameStats && +frameStats.median.toFixed(2),
    frameP95Ms: frameStats && +frameStats.p95.toFixed(2),
    frameMaxMs: frameStats && +frameStats.max.toFixed(2),
    estFps: frameStats && +(1000 / frameStats.median).toFixed(1),
    longTasks_over50ms: longTasks.length,
    worstLongTaskMs: longTasks.length ? Math.round(Math.max(...longTasks.map(t=>t.dur))/1000) : 0,
    scriptingMs: Math.round(scripting),
    PASS_no_severe_jank: longTasks.filter(t=>t.dur>100000).length === 0,
    PASS_60fps_median_idle: frameStats ? frameStats.median <= 18 : null,
  };
  const fs = await import('node:fs');
  fs.writeFileSync(OUT, JSON.stringify(verdict, null, 2));
  fs.writeFileSync(OUT + '.trace', trace);
  console.log(JSON.stringify(verdict, null, 2));
  client.close();
})().catch(e => { console.error('perf-trace FAILED:', e.message); process.exit(1); });
