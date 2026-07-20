// Minimal dep-free CDP driver: eval + screenshot, every call timeout-raced.
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PORT = readFileSync('/tmp/claude-1000/-home-lmas--orchestra-worktrees-orchestra-noble-horizon-fe944aa2/f6402dd4-6588-472d-ab3e-dc39bec834ab/scratchpad/eport', 'utf8').trim();

const res = await fetch(`http://127.0.0.1:${PORT}/json`);
const page = (await res.json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('cdp ws failed')); });

let id = 1; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data); const p = pending.get(m.id);
  if (!p) return; pending.delete(m.id);
  m.error ? p.bad(new Error(JSON.stringify(m.error))) : p.ok(m.result);
};
export const send = (method, params = {}, ms = 20000) => {
  const i = id++; ws.send(JSON.stringify({ id: i, method, params }));
  return Promise.race([
    new Promise((ok, bad) => pending.set(i, { ok, bad })),
    new Promise((_, bad) => setTimeout(() => bad(new Error(`timeout ${method}`)), ms)),
  ]);
};
export const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
export const shot = async (path, selector) => {
  let clip;
  if (selector) {
    const b = await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
      if(!e) return null; const r=e.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
    if (!b) return { ok: false, error: `no element ${selector}`, bytes: 0 };
    clip = { ...b, scale: 1 };
  }
  const r = await send('Page.captureScreenshot', clip ? { clip } : {});
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(path, buf);
  return { ok: true, bytes: buf.length, md5: createHash('md5').update(buf).digest('hex') };
};
export const close = () => ws.close();
