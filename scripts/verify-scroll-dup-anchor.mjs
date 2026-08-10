#!/usr/bin/env node
/* Gates the "scrolling up a notch from the bottom teleports to the beginning of
 * the transcript" bug (reported against a hibernated workspace).
 *
 * ROOT CAUSE it guards: RenderMessage ids are derived from `event.seq`, and the
 * seq counter used to restart at 0 whenever a Session object was re-created —
 * which is exactly what waking a hibernated workspace does, while the RENDERER's
 * folded transcript survives. The transcript then held `user:0` at the very top
 * AND at the very bottom. StructuredView's scroll-anchoring effect resolved the
 * anchor with `ids.indexOf(id)`, so the moment the viewport top passed over the
 * BOTTOM `user:0` it scrolled to the TOP one — and re-anchored there, stranding
 * the user at the start of the transcript.
 *
 * Method: seed that exact transcript shape (a duplicate-id user row near the
 * end), pin to bottom, then drive TRUSTED upward mouseWheel ticks while an
 * in-page rAF recorder samples scrollTop per frame. A wheel tick moves ~120px;
 * a teleport is a single-frame drop of thousands. So the oracle is the largest
 * one-frame DOWNWARD jump in scrollTop, which is immune to wheel speed,
 * momentum and row heights.
 *
 * Usage: node scripts/verify-scroll-dup-anchor.mjs --port 9381 --ws ws-dupanchor
 *        [--expect-bug]   # mutation mode: exit 0 only when the teleport IS seen
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] ?? '1']);
    return acc;
  }, []),
);
const PORT = Number(args.port || 9381);
const WS = args.ws || '';
const EXPECT_BUG = 'expect-bug' in args;
const SHOT = args.shot || '';
if (!WS) { console.error('need --ws <workspaceId>'); process.exit(2); }

async function findTarget(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && /dist\/index\.html|app\.asar/i.test(t.url));
  if (!page) throw new Error(`no renderer target on :${port}`);
  if (/app\.asar/.test(page.url)) throw new Error(`ABORT: driving the INSTALLED build (${page.url})`);
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
  return {
    ready,
    send(method, params = {}) {
      const my = ++id;
      return new Promise((resolve, reject) => {
        pending.set(my, { resolve, reject });
        ws.send(JSON.stringify({ id: my, method, params }));
      });
    },
    close() { ws.close(); },
  };
}
const client = cdp(await findTarget(PORT));
await client.ready;
await client.send('Runtime.enable');
await client.send('Page.enable');
const ev = async (expr) => {
  const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result?.value;
};
const settle = (n = 4) => ev(`new Promise(r=>{let i=${n};const t=()=>--i<=0?setTimeout(()=>r(1),80):requestAnimationFrame(t);requestAnimationFrame(t)})`);

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};

// Reload first so every run starts from a COLD renderer. The store is in-memory
// and StructuredView's scroll refs (`initialPin`, `stickBottom`, the height
// cache) are component-local, so a second drive against a warm page inherits the
// previous one's released follow-mode and its already-folded messages — the
// bottom pin never happens and the drive measures nothing.
await client.send('Page.reload', { ignoreCache: false });
await new Promise((r) => setTimeout(r, 4000));
await client.send('Runtime.enable');
console.error(`[impl] window.__anchorImpl = ${JSON.stringify(await ev('window.__anchorImpl ?? null'))}`);
await ev(`window.__orchestraSetState(${JSON.stringify({ activeId: WS, view: 'structured' })}); 1`);
await settle();

// ── Seed the hibernation-wake transcript shape ───────────────────────────────
// One event list, injected in a single evaluate, so it lands like a history
// backfill (rows above the final window never mount → they keep the 72px
// estimate, which is what makes the anchoring effect matter at all).
let seq = 1; let blockIdx = 0; let tool = 0;
const events = [];
const now = Date.now();
const textBlock = (text) => {
  const index = blockIdx++;
  events.push({ type: 'block-start', seq: seq++, at: now, index, kind: 'text' });
  events.push({ type: 'text-delta', seq: seq++, at: now, index, text });
  events.push({ type: 'block-stop', seq: seq++, at: now, index });
};
const toolBlock = (i, lines) => {
  const index = blockIdx++;
  const toolUseId = `toolu_dup_${i}`;
  events.push({ type: 'block-start', seq: seq++, at: now, index, kind: 'tool_use', toolUseId, name: 'Bash' });
  events.push({ type: 'tool-use', seq: seq++, at: now, index, toolUseId, name: 'Bash',
    input: { command: Array.from({ length: lines }, (_, k) => `echo line ${k}`).join('\n') } });
  events.push({ type: 'block-stop', seq: seq++, at: now, index });
};
// THE COLLISION: `user-message` ids are `user:<seq>`. Pre-hibernation the
// session's cursor started at 0; the wake minted a NEW cursor that also started
// at 0 — so both turns claim `user:0`.
const dupUser = (text) => events.push({ type: 'user-message', seq: 0, at: now, text });

dupUser('The very first turn of this conversation, before hibernation.');
// A LONG pre-hibernation history: the upward drive must be able to cross the
// duplicate row without ever reaching the top of the list, or 'we hit scrollTop
// 0' becomes ambiguous between an honest scroll and the teleport.
for (let i = 0; i < 220; i++) {
  const mode = i % 4;
  if (mode === 0) textBlock(`Short answer ${i}.`);
  else if (mode === 1) textBlock(`Paragraph ${i}. ` + 'lorem ipsum dolor sit amet consectetur '.repeat(3 + (i % 5) * 3));
  else if (mode === 2) { const n = 1 + (i % 3); for (let k = 0; k < n; k++) toolBlock(tool++, 5 + (i % 4) * 6); }
  else textBlock(`Wrap-up ${i}. ` + 'done and verified '.repeat(1 + (i % 6) * 4));
}
// TALL on purpose. The anchor is only re-derived on scroll events, and the
// anchoring effect only acts on the anchor it holds at commit time — a
// one-line bubble is ~50px, i.e. narrower than a single 120px wheel tick, so
// the viewport top can skip straight over the duplicate row and the teleport
// never gets a chance to fire. A multi-paragraph turn guarantees several
// commits with the duplicate row under the viewport top. (Real transcripts hit
// this constantly: the post-wake turn is usually a real, long prompt.)
dupUser('A prompt sent AFTER waking the hibernated session.\n\n' +
  ('Here is a long multi-paragraph prompt so this bubble is tall. '.repeat(12) + '\n\n').repeat(6));
for (let i = 0; i < 8; i++) textBlock(`Post-wake reply ${i}. ` + 'still going '.repeat(2 + i * 3));

await ev(`(() => {
  const evs = ${JSON.stringify(events)};
  for (const e of evs) window.__injectAgentEvent(${JSON.stringify(WS)}, e);
  return evs.length;
})()`);
await settle(10);

// ── CONTROL: the duplicate really is in the folded transcript ────────────────
const ids = await ev(`(() => {
  const s = window.__readAgentSession(${JSON.stringify(WS)});
  if (!s) return { error: 'no session' };
  const ids = s.messages.map(m => m.id);
  const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
  return { count: ids.length, dups, firstDupAt: dups.length ? ids.indexOf(dups[0]) : -1,
           lastDupAt: dups.length ? ids.lastIndexOf(dups[0]) : -1 };
})()`);
check('CONTROL: duplicate-id transcript seeded (the hibernation-wake shape)',
  ids.dups && ids.dups.length > 0 && ids.lastDupAt - ids.firstDupAt > 50, JSON.stringify(ids));

const pre = await ev(`(() => {
  const list = document.querySelector('.av-message-list');
  if (!list) return { error: 'no list' };
  return { rows: document.querySelectorAll('.av-row').length,
           scrollTop: Math.round(list.scrollTop), scrollHeight: list.scrollHeight,
           clientHeight: list.clientHeight,
           gap: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) };
})()`);
check('CONTROL: rendered, scrollable and pinned at the bottom',
  pre.rows > 0 && pre.scrollHeight > pre.clientHeight * 3 && pre.gap <= 2, JSON.stringify(pre));
if (!(pre.rows > 0)) { console.error('ABORT: nothing rendered.'); client.close(); process.exit(1); }

// ── Per-frame scrollTop recorder ─────────────────────────────────────────────
await ev(`(() => {
  const list = document.querySelector('.av-message-list');
  const rec = { frames: [] };
  window.__dupRec = rec;
  const tick = () => { if (rec.stop) return; rec.frames.push(list.scrollTop); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return 1;
})()`);

// ── Drive: trusted upward wheel ticks over the list centre ───────────────────
const listRect = await ev(`(() => { const r = document.querySelector('.av-message-list').getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
const TICKS = 45;
for (let i = 0; i < TICKS; i++) {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: listRect.x, y: listRect.y, deltaX: 0, deltaY: -120, pointerType: 'mouse',
  });
  await ev(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
}
await settle(6);

const rec = await ev(`(() => {
  const rec = window.__dupRec; rec.stop = true;
  const f = rec.frames;
  let worstDrop = 0, worstAt = -1;
  for (let i = 1; i < f.length; i++) {
    const drop = f[i-1] - f[i];
    if (drop > worstDrop) { worstDrop = drop; worstAt = i; }
  }
  const list = document.querySelector('.av-message-list');
  return { frames: f.length, first: Math.round(f[0]), last: Math.round(f[f.length-1]),
           worstDrop: Math.round(worstDrop), worstAt,
           beforeWorst: worstAt > 0 ? Math.round(f[worstAt-1]) : -1,
           afterWorst: worstAt > 0 ? Math.round(f[worstAt]) : -1,
           finalTop: Math.round(list.scrollTop) };
})()`);

// A wheel tick is ~120px; two frames of momentum is still a few hundred. A
// teleport to the top of a ~15000px transcript is thousands in ONE frame.
const TELEPORT_PX = 1000;
const teleported = rec.worstDrop >= TELEPORT_PX;
console.log(`[rec] ${JSON.stringify(rec)}`);

if (EXPECT_BUG) {
  check('MUTATION: the teleport IS observed (harness can see the bug)', teleported,
    `worstDrop=${rec.worstDrop}px (${rec.beforeWorst} -> ${rec.afterWorst})`);
} else {
  check('no uncommanded teleport while scrolling up through a duplicate-id row',
    !teleported, `worstDrop=${rec.worstDrop}px over ${rec.frames} frames (threshold ${TELEPORT_PX})`);
  check('the upward scroll travelled smoothly and never bottomed out at the top',
    rec.first - rec.finalTop > 1500 && rec.finalTop > 500,
    `from ${rec.first}px to ${rec.finalTop}px`);
}

if (SHOT) {
  const shot = await Promise.race([
    client.send('Page.captureScreenshot', { format: 'png' }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout')), 15000)),
  ]);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log(`[shot] ${SHOT}`);
}

client.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
