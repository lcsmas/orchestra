#!/usr/bin/env node
/* Reproduces / gates the StructuredView scroll-UP jump: while the user wheel-
 * scrolls up through history, first-mount measurements of rows entering the
 * overscan replace their 72px estimates, shifting every offset below them —
 * the content the user is reading moves under a fixed scrollTop ("random
 * jumps down", non-fluid scroll).
 *
 * Method: seed a long transcript of varied-height rows, pin to bottom, then
 * dispatch TRUSTED Input.dispatchMouseEvent mouseWheel ticks upward while an
 * in-page rAF recorder tracks, per frame, the CONTENT-SPACE position of the
 * row nearest the viewport middle (rect.top - listRect.top + scrollTop).
 * For consecutive frames tracking the SAME row, that value is constant unless
 * the virtualizer's offsets moved — every |delta| > threshold is an
 * uncommanded content shift, i.e. the jump. Wheel scrolling itself never
 * changes a row's content-space position, so this is immune to the scroll
 * motion; it isolates exactly the defect.
 *
 * Usage: node scripts/verify-scroll-anchoring.mjs --port 9377 --ws ws-scrolljump
 *        [--expect-bug]   # repro mode: exit 0 when the jump IS observed
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] ?? '1']);
    return acc;
  }, []),
);
const PORT = Number(args.port || 9377);
const WS = args.ws || '';
const EXPECT_BUG = 'expect-bug' in args;
if (!WS) { console.error('need --ws <workspaceId>'); process.exit(2); }

async function findTarget(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find(
    (t) => t.type === 'page' && /dist\/index\.html|app\.asar/i.test(t.url),
  );
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
const ev = async (expr) => {
  const r = await client.send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  }
  return r.result?.value;
};
const settle = (n = 4) => ev(
  `new Promise(r=>{let i=${n};const t=()=>--i<=0?setTimeout(()=>r(1),80):requestAnimationFrame(t);requestAnimationFrame(t)})`,
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};

// ── Open the structured tab, seed a LONG varied-height transcript ────────────
await ev(`window.__orchestraSetState(${JSON.stringify({ activeId: WS, view: 'structured' })}); 1`);
await settle();

// Build ALL events in node, inject them in ONE evaluate (single synchronous
// loop → one enqueue batch → as few RAF-fold commits as possible). This is the
// state a real HISTORY BACKFILL produces: rows above the final window never
// mount, so they carry the 72px estimate. Injecting one event per CDP call
// (like verify-followmode does) instead streams each row through the pinned
// window, measuring everything — which is exactly why that mode can't repro
// the scroll-up jump.
let seq = 1; let blockIdx = 0; let tool = 0;
const events = [];
const textBlock = (text) => {
  const index = blockIdx++;
  events.push({ type: 'block-start', seq: seq++, at: Date.now(), index, kind: 'text' });
  events.push({ type: 'text-delta', seq: seq++, at: Date.now(), index, text });
  events.push({ type: 'block-stop', seq: seq++, at: Date.now(), index });
};
const toolBlock = (i, lines) => {
  const index = blockIdx++;
  const toolUseId = `toolu_sa_${i}`;
  events.push({ type: 'block-start', seq: seq++, at: Date.now(), index, kind: 'tool_use', toolUseId, name: 'Bash' });
  events.push({ type: 'tool-use', seq: seq++, at: Date.now(), index, toolUseId, name: 'Bash',
    input: { command: Array.from({ length: lines }, (_, k) => `echo line ${k}`).join('\n') } });
  events.push({ type: 'block-stop', seq: seq++, at: Date.now(), index });
};
// A block-start with NO text delta: MessageBubble renders null (no text, no
// thinking, no images), so the row is genuinely 0px. These are what exposed the
// v0.5.190 phantom-height regression — a guard that refused to cache their zero
// left them on the 72px estimate forever, reserving blank scrollable space.
const emptyBlock = () => {
  const index = blockIdx++;
  events.push({ type: 'block-start', seq: seq++, at: Date.now(), index, kind: 'text' });
  events.push({ type: 'block-stop', seq: seq++, at: Date.now(), index });
};
// Varied heights: short texts (<72px), long paragraphs (>72px), tool runs of
// varying group size — so estimates err in BOTH directions, like a real session.
for (let i = 0; i < 60; i++) {
  const mode = i % 4;
  if (mode === 0) textBlock(`Short answer ${i}.`);
  else if (mode === 1) textBlock(`Paragraph ${i}. ` + 'lorem ipsum dolor sit amet consectetur '.repeat(3 + (i % 5) * 3));
  else if (mode === 2) { const n = 1 + (i % 3); for (let k = 0; k < n; k++) toolBlock(tool++, 5 + (i % 4) * 6); }
  else textBlock(`Wrap-up ${i}. ` + 'done and verified '.repeat(1 + (i % 6) * 4));
  if (i % 7 === 3) emptyBlock();
}
await ev(`(() => {
  const evs = ${JSON.stringify(events)};
  for (const e of evs) window.__injectAgentEvent(${JSON.stringify(WS)}, e);
  return evs.length;
})()`);
await settle(8);

// POSITIVE CONTROL: rows rendered, list is genuinely scrollable, and we start
// pinned at the bottom (so the upward drive traverses unmeasured rows).
const pre = await ev(`(() => {
  const list = document.querySelector('.av-message-list');
  if (!list) return { error: 'no list' };
  const s = window.__readAgentSession(${JSON.stringify(WS)});
  return { folded: s ? s.messages.length : -1,
           rows: document.querySelectorAll('.av-row').length,
           scrollTop: Math.round(list.scrollTop), scrollHeight: list.scrollHeight,
           clientHeight: list.clientHeight,
           gap: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) };
})()`);
check('CONTROL: rows rendered + scrollable + pinned',
  pre.folded > 0 && pre.rows > 0 && pre.scrollHeight > pre.clientHeight * 3 && pre.gap <= 2,
  JSON.stringify(pre));
if (!(pre.folded > 0 && pre.rows > 0)) {
  console.error('ABORT: nothing rendered — every later check would be vacuous.');
  client.close(); process.exit(1);
}

// ── In-page recorder: per-frame content-space position of the mid-viewport row ──
await ev(`(() => {
  const list = document.querySelector('.av-message-list');
  const rec = { frames: [], wheels: 0 };
  window.__scrollRec = rec;
  list.addEventListener('wheel', () => { rec.wheels++; }, { passive: true, capture: true });
  const tick = () => {
    if (rec.stop) return;
    const lr = list.getBoundingClientRect();
    const mid = lr.top + lr.height / 2;
    let best = null;
    for (const r of document.querySelectorAll('.av-row')) {
      const rr = r.getBoundingClientRect();
      if (rr.top <= mid && rr.bottom >= mid) { best = { r, rr }; break; }
      if (!best || Math.abs(rr.top - mid) < Math.abs(best.rr.top - mid)) best = { r, rr };
    }
    const inner = document.querySelector('.av-message-list-inner');
    rec.frames.push({
      t: performance.now(),
      st: list.scrollTop,
      idx: best ? Number(best.r.dataset.index) : -1,
      cy: best ? best.rr.top - lr.top + list.scrollTop : -1,
      th: inner ? parseFloat(inner.style.height) : -1,
      wheels: rec.wheels,
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 1;
})()`);

// ── Drive: trusted wheel ticks upward over the list center ───────────────────
const listRect = await ev(`(() => {
  const r = document.querySelector('.av-message-list').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
const TICKS = 90;
for (let i = 0; i < TICKS; i++) {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: listRect.x, y: listRect.y,
    deltaX: 0, deltaY: -120,
  });
  await sleep(70);
}
await settle(4);
const rec = await ev(`(() => { window.__scrollRec.stop = 1; return window.__scrollRec; })()`);

// ── Analysis: uncommanded SCREEN-SPACE shifts of the tracked row ─────────────
// What the user sees is the row's viewport position rect.top = cy - st (+ a
// constant). A measurement correction legitimately moves cy (content-space);
// the fix moves st by the same amount in the same pre-paint pass, so the row
// stays put on screen. Jump = Δ(cy - st) over consecutive same-row frames with
// NO wheel event in between (wheel pairs carry commanded motion). On the
// UNFIXED build these shifts show up as cy moving while st is frozen.
const JUMP_PX = 4; // sub-4px settles are invisible; the reported jumps are tens of px
let shifts = 0; let maxShift = 0; let totalShift = 0; const examples = [];
let quietStDrift = 0; // wheel-animation confound detector: st moving in no-wheel pairs w/o cy motion
for (let i = 1; i < rec.frames.length; i++) {
  const a = rec.frames[i - 1]; const b = rec.frames[i];
  if (a.idx !== b.idx || a.idx < 0) continue;
  if (a.wheels !== b.wheels) continue; // commanded motion in this pair — skip
  const d = Math.abs((b.cy - b.st) - (a.cy - a.st));
  if (Math.abs(b.st - a.st) > 1 && Math.abs(b.cy - a.cy) <= 1) quietStDrift++;
  if (d > JUMP_PX) {
    shifts++; totalShift += d; maxShift = Math.max(maxShift, d);
    if (examples.length < 5) {
      examples.push(`row#${a.idx} screen-moved ${Math.round(d)}px (cy ${Math.round(a.cy)}->${Math.round(b.cy)}, scrollTop ${Math.round(a.st)}->${Math.round(b.st)}, totalH ${Math.round(a.th)}->${Math.round(b.th)})`);
    }
  }
}
console.log(`[diag] no-wheel pairs with scrollTop drift but static content: ${quietStDrift} (nonzero would mean Chromium wheel animation pollutes the metric)`);
const scrolled = rec.frames.length ? rec.frames[0].st - rec.frames[rec.frames.length - 1].st : 0;
// CONTROL for the recorder itself: the drive must have actually scrolled and
// the wheel listener must have seen trusted events — else "0 shifts" is vacuous.
check('CONTROL: drive scrolled up with trusted wheels',
  rec.wheels >= TICKS * 0.8 && scrolled > 500,
  `wheels=${rec.wheels} scrolledUp=${Math.round(scrolled)}px frames=${rec.frames.length}`);

const detail = `shifts=${shifts} maxShift=${Math.round(maxShift)}px total=${Math.round(totalShift)}px\n  ${examples.join('\n  ')}`;
if (EXPECT_BUG) {
  check('REPRO: content shifts under viewport while wheel-scrolling up', shifts > 0, detail);
} else {
  check('scroll-up is anchored (no uncommanded content shifts)', shifts === 0, detail);
}

// ── PHANTOM SPACE: space RESERVED for the mounted window vs space it OCCUPIES ─
// The virtualizer reserves `totalHeight` on the sized wrapper from cached-or-
// ESTIMATED (72px) row heights; the mounted rows report what they really
// occupy. Rows that legitimately render 0px (a block-start whose delta never
// landed — MessageBubble returns null) must be CACHED at 0. A guard that
// refuses to cache their zero leaves them on the 72px estimate forever, so the
// wrapper reserves 72px of blank scrollable space per empty row (v0.5.190:
// 2 empty rows × 72px = 144px of void, and crossing one during a scroll threw
// the viewport by exactly 72px).
//
// WHERE THE DEFECT IS OBSERVABLE — and where it is NOT. Measured on the buggy
// build: inside the MOUNTED WINDOW the rows are perfectly flush (row container
// 1024px == sum of real row heights, empty rows' successors start at the same
// y). The stale 72px estimates survive ONLY for rows OUTSIDE the window, in the
// sized wrapper's `totalHeight` (declared 3994 against ~3378 of real content).
// So every DOM-geometry check over mounted rows is structurally blind to this
// bug. THREE such checks passed on the buggy build before I stopped guessing —
// recorded so nobody re-derives them:
//   • flush neighbours (next.top === prev.bottom) — PASSED buggy: 0px gaps.
//   • per-empty-row slot (next.top − this.top) — PASSED buggy: slot=0px.
//   • the row container's own height — derived from rendered rows, so it can
//     never reveal a stale CACHE.
// (A fourth, scrollHeight − sumOfMountedRealHeights, FAILS on a CORRECT build:
// it compares the whole list against only the mounted window.)
//
// A FOURTH static check also passed on the buggy build (declaredTotal vs
// scrollHeight after walking the whole list: 3994 vs 4026, excess −32px) —
// because scrollHeight is itself max(wrapper, overflowing content), so the
// inflated wrapper never exceeds it. Conclusion, after four attempts: the
// phantom reserve is NOT observable as a static geometry property. Do not add
// a fifth static check here; a guard that cannot be made to fail is worse than
// no guard, because it reads as coverage.
//
// The observable signature — and the one this script already gates on above —
// is DYNAMIC: when an unmeasured empty row scrolls into the window its estimate
// collapses 72px → 0px and throws the viewport by exactly ESTIMATED_ROW_H.
// Verified to discriminate, repeatably and with the same row and magnitude:
//   buggy build  → shifts=1, maxShift=72px (row#33, scrollTop frozen)
//   fixed build  → shifts=0
// So the empty-row seeding above (`emptyBlock`) is load-bearing for THIS gate:
// it is what puts an unmeasured 0px row in the scroll path.
const emptyRowCheck = await ev(`(() => {
  const rows = [...document.querySelectorAll('.av-row')];
  return { emptyMounted: rows.filter((r) => r.getBoundingClientRect().height === 0).length };
})()`);
// CONTROL for the seeding, not a defect check: if the transcript contains no
// genuinely-empty rows, the anchoring assertion above never exercises the
// empty-row estimate path and this gate silently narrows to the generic case.
check('CONTROL: seed produced genuinely empty (0px) rows in the window',
  emptyRowCheck.emptyMounted > 0,
  `emptyRowsInWindow=${emptyRowCheck.emptyMounted} (0 ⇒ the 72px-estimate path went untested)`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
client.close();
process.exit(failed.length ? 1 : 0);
