#!/usr/bin/env node
/* Drives the REAL StructuredView in a built Orchestra instance to verify
 * follow-mode. Asserts, against the actual component (not a model of it):
 *   1. Streaming keeps the viewport pinned (gap ~0) as tall tool rows land.
 *   2. The follow pill is HIDDEN while following.
 *   3. A real user scroll-up releases follow AND reveals the pill.
 *   4. Clicking the pill re-pins and re-engages follow.
 *   5. A composer clientHeight clamp does NOT release follow (the shipped bug).
 *
 * Usage: node scripts/verify-followmode.mjs --port <cdp> --ws <workspaceId>
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const PORT = Number(args.port || 9333);
const WS = args.ws || '';
if (!WS) { console.error('need --ws <workspaceId>'); process.exit(2); }

async function findTarget(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && /orchestra|index\.html|file:|app\.asar/i.test(t.url));
  if (!page) throw new Error(`no renderer target on :${port}`);
  console.error(`[cdp] target: ${page.url}`);
  return page.webSocketDebuggerUrl;
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  return { ready,
    send(method, params = {}) { const my = ++id; return new Promise((resolve, reject) => { pending.set(my, { resolve, reject }); ws.send(JSON.stringify({ id: my, method, params })); }); },
    close() { ws.close(); } };
}
const client = cdp(await findTarget(PORT));
await client.ready;
await client.send('Runtime.enable');
const ev = async (expr) => {
  const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result?.value;
};
const settle = (n = 3) => ev(`new Promise(r=>{let i=${n};const t=()=>--i<=0?setTimeout(()=>r(1),60):requestAnimationFrame(t);requestAnimationFrame(t)})`);

// Open the structured tab for the seeded workspace.
await ev(`window.__orchestraSetState(${JSON.stringify({ activeId: WS, view: 'structured' })}); 1`);
await settle();

let seq = 1;
const inject = async (event) =>
  ev(`window.__injectAgentEvent(${JSON.stringify(WS)}, ${JSON.stringify(event)}); 1`);

// Helper: read the live scroll geometry + pill presence from the REAL DOM.
const STATE = `(() => {
  const list = document.querySelector('.av-view.active .av-message-list')
            || document.querySelector('.av-message-list');
  const pill = document.querySelector('.av-view.active .av-follow-pill')
            || document.querySelector('.av-follow-pill');
  if (!list) return { error: 'no .av-message-list' };
  return { gap: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight),
           scrollTop: Math.round(list.scrollTop), scrollHeight: list.scrollHeight,
           clientHeight: list.clientHeight, pill: !!pill, rows: document.querySelectorAll('.av-row').length };
})()`;

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};

// ── 1. Stream a session with TALL tool rows and assert follow keeps up ──────
// Real AgentEvent shapes (src/shared/types.ts): text blocks are
// block-start/text-delta/block-stop; tools are block-start(tool_use)/tool-use.
let blockIdx = 0;
const textBlock = async (text) => {
  const index = blockIdx++;
  await inject({ type: 'block-start', seq: seq++, at: Date.now(), index, kind: 'text' });
  await inject({ type: 'text-delta', seq: seq++, at: Date.now(), index, text });
  await inject({ type: 'block-stop', seq: seq++, at: Date.now(), index });
};
const toolBlock = async (i) => {
  const index = blockIdx++;
  const toolUseId = `toolu_fm_${i}`;
  await inject({ type: 'block-start', seq: seq++, at: Date.now(), index, kind: 'tool_use', toolUseId, name: 'Bash' });
  await inject({ type: 'tool-use', seq: seq++, at: Date.now(), index, toolUseId, name: 'Bash',
    input: { command: Array.from({ length: 25 }, (_, k) => `echo line ${k}`).join('\n') } });
  await inject({ type: 'block-stop', seq: seq++, at: Date.now(), index });
};

// Enough content to OVERFLOW any reasonable viewport — consecutive tools fold
// into ONE collapsed group row, so interleave text between tool blocks to keep
// the transcript tall. (On a 1000px-tall rig the original 8+4 seed fit entirely
// in the viewport: scroll-up was a no-op at scrollTop 0, the release check
// could never be exercised, and "stays pinned" gap=0 passed VACUOUSLY.)
for (let i = 0; i < 14; i++) {
  await textBlock(`Streaming paragraph ${i}. ` + 'lorem ipsum dolor sit amet '.repeat(10));
  if (i % 2 === 0) await toolBlock(i);
}
await settle(6);
let s = await ev(STATE);

// POSITIVE CONTROL: the fold+render must have actually produced rows, and the
// list must actually be SCROLLABLE. Without this, an empty (or fully-visible)
// list trivially reports gap 0 and every check below is vacuous.
const folded = await ev(`(()=>{const s=window.__readAgentSession(${JSON.stringify(WS)});return s?s.messages.length:-1})()`);
check('CONTROL: events folded, rows rendered, list scrollable',
  folded > 0 && s.rows > 0 && s.scrollHeight > s.clientHeight + 500,
  `foldedMessages=${folded} domRows=${s.rows} scrollH=${s.scrollHeight} clientH=${s.clientHeight}`);
if (!(folded > 0 && s.rows > 0 && s.scrollHeight > s.clientHeight + 500)) {
  console.error('\nABORT: nothing rendered or nothing scrollable — remaining checks would be vacuous.');
  client.close(); process.exit(1);
}
check('streaming stays pinned (tool rows land)', s.gap <= 2, JSON.stringify(s));
check('pill hidden while following', s.pill === false, `pill=${s.pill}`);

// ── 2. Real user scroll-up must release follow and SHOW the pill ────────────
await ev(`(()=>{const l=document.querySelector('.av-view.active .av-message-list')||document.querySelector('.av-message-list');
  l.scrollTo({top:l.scrollTop-400,behavior:'instant'});return 1})()`);
await settle(4);
s = await ev(STATE);
check('user scroll-up releases follow (pill appears)', s.pill === true, `gap=${s.gap} pill=${s.pill}`);

// New output while released must NOT yank the viewport back.
const beforeTop = s.scrollTop;
await textBlock('More output after release. ' + 'filler text '.repeat(20));
await settle(4);
s = await ev(STATE);
check('released: new output does not yank viewport', Math.abs(s.scrollTop - beforeTop) < 8,
  `top ${beforeTop} -> ${s.scrollTop}`);

// ── 3. Clicking the pill re-pins and re-engages ─────────────────────────────
const clicked = await ev(`(()=>{const p=document.querySelector('.av-view.active .av-follow-pill')||document.querySelector('.av-follow-pill');if(!p)return 0;p.click();return 1})()`);
check('pill was present to click', clicked === 1, `clicked=${clicked}`);
await settle(4);
s = await ev(STATE);
check('pill click re-pins to bottom', s.gap <= 2, `gap=${s.gap}`);
check('pill hides after re-engaging', s.pill === false, `pill=${s.pill}`);

// Streaming after resume must follow again.
await textBlock('Resumed streaming. ' + 'filler text '.repeat(25));
await settle(4);
s = await ev(STATE);
check('follow works again after resume', s.gap <= 2, `gap=${s.gap}`);

// ── 4. THE SHIPPED BUG: composer growth/shrink clamps scrollTop ─────────────
// Type a long draft (composer auto-grows -> list clientHeight shrinks), then
// clear it (list clientHeight grows -> browser clamps scrollTop DOWN).
await ev(`(()=>{const ta=document.querySelector('.av-view.active textarea')||document.querySelector('.av-composer textarea')||document.querySelector('textarea');
  if(!ta) return 0;
  const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  set.call(ta,Array.from({length:12},(_,i)=>'draft line '+i).join('\\n'));
  ta.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
await settle(4);
const mid = await ev(STATE);
await ev(`(()=>{const ta=document.querySelector('.av-view.active textarea')||document.querySelector('.av-composer textarea')||document.querySelector('textarea');
  if(!ta) return 0;
  const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  set.call(ta,''); ta.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
await settle(5);
s = await ev(STATE);
check('composer clear does NOT release follow (regression guard)',
  s.pill === false, `pill=${s.pill} gap=${s.gap} clientH ${mid.clientHeight}->${s.clientHeight}`);

// Streaming still followed after the clamp.
await textBlock('Post clamp output. ' + 'filler text '.repeat(25));
await settle(4);
s = await ev(STATE);
check('still following after composer clamp', s.gap <= 2, `gap=${s.gap} pill=${s.pill}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
client.close();
process.exit(failed.length ? 1 : 0);
