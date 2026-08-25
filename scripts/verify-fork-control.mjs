// E2E geometry gate for "Resume from here" (#18), driven over CDP against a
// REAL built Orchestra.
//
// WHY BOTH THIS AND THE __smoke__ FORK CHECKS: the render smokes assert the
// fork control's MARKUP (renderToString), and are structurally blind to the bug
// that actually shipped — the button rendered perfectly and was PERMANENTLY
// UNCLICKABLE. `.av-message-actions` had no explicit row layout, so the second
// control WRAPPED, doubling the row height (28 -> 54.6) and pushing the fork
// button's centre outside the box that `.av-message-user:hover` reveals. A
// control outside that box can never be hovered, so `pointer-events` stayed
// `none` forever. renderToString has no layout engine and cannot see any of it.
//
// So this file asserts GEOMETRY and HIT-TESTABILITY, the two properties the
// smokes cannot reach:
//   - the action row uses an explicit row layout (display:flex, direction row)
//   - both controls sit on ONE line (no wrap)
//   - the row is single-line height
//   - the row stays CONTIGUOUS with the bubble (no positive dead-zone gap;
//     a NEGATIVE gap is overlap, which is fine — the row is `position:absolute;
//     top:100%`, so it legitimately sits BELOW the bubble's own box)
//   - after a REAL cursor hover, the fork button is hit-testable AT ITS OWN
//     CENTRE and `pointer-events` is enabled
//
// Two traps this file is deliberately built around, both of which fabricate
// failures against working code:
//   1. A synthetic `new MouseEvent('mouseover')` fails `isTrusted` and never
//      sets CSS `:hover`, so the button reads `pointer-events:none` and looks
//      broken. Hover is driven with `Input.dispatchMouseEvent` (a real cursor).
//   2. The rig gives a fresh isolated ORCHESTRA_HOME, so no workspace exists;
//      selecting a bare id renders the "No agents running" empty state and
//      every assertion below goes vacuous. A scratch workspace is seeded first
//      and `.av-view` is asserted MOUNTED as a precondition.
//
// PROVEN NON-VACUOUS: reverting the `display:flex` block in
// `.av-message-actions`, rebuilding, and re-running takes this gate from 8/8 to
// 3/8 — reproducing the original numbers (rowHeight 54.6; fork centre y=332
// against a bubble ending at y=298; the hit-test landing on a DIFFERENT
// element). Verified 2026-08-25 against the built AppImage under headless sway.
//
// Prereqs: `pnpm run build`, then launch the built artifact with
// ORCHESTRA_DEBUG_PORT=9419 inside a contained headless compositor
// (scripts/e2e-contained-rig.sh — never the human's display). Then:
//   node scripts/verify-fork-control.mjs
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.ORCHESTRA_DEBUG_PORT || 9419);
const OUT = process.env.FORK_VERIFY_OUT || '/tmp/fork-control-verify';
const WS_ID = 'fork-verify-ws';

let nextId = 1;
const pending = new Map();
let sock;

function send(method, params = {}) {
  const id = nextId++;
  sock.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(
      () => pending.has(id) && (pending.delete(id), rej(new Error(`${method} timed out`))),
      20000,
    );
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result?.value;
}

const shots = new Map();
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  const hash = createHash('md5').update(buf).digest('hex');
  writeFileSync(`${OUT}/${name}.png`, buf);
  // A byte-identical capture means the drive step silently no-opped.
  if (shots.has(hash)) throw new Error(`DUPLICATE screenshot: ${name} == ${shots.get(hash)}`);
  shots.set(hash, name);
  console.log(`  shot ${OUT}/${name}.png (${buf.length}b md5=${hash.slice(0, 8)})`);
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url));
  if (!page) throw new Error(`no page target on port ${PORT}`);
  console.log(`target: ${page.url}`);

  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    sock.onopen = res;
    sock.onerror = () => rej(new Error('ws failed'));
  });
  sock.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');

  // The viewport is a PRECONDITION of every geometry number below and it drifts
  // between steps, so print it beside the measurements rather than assuming it.
  console.log(`  precondition: viewport width = ${await evaluate('window.innerWidth')}`);

  // Seed a scratch workspace, then select it. See trap 2 in the header.
  await evaluate(`(() => {
    window.__orchestraSetState({
      workspaces: [{
        id: '${WS_ID}', name: 'Fork control gate', kind: 'scratch',
        repoPath: '', baseBranch: '', branch: 'probe',
        worktreePath: '/tmp', status: 'running', createdAt: Date.now(),
      }],
      activeId: '${WS_ID}',
      view: 'structured',
    });
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const mounted = await evaluate(`!!document.querySelector('.av-view')`);
  check('structured view MOUNTED (precondition for every measurement below)', mounted === true);
  if (!mounted) throw new Error('structured view never mounted — rig precondition unmet');

  // TWO user turns: the fork affordance is gated on having a PREDECESSOR.
  // Event shapes come from the producer contract in src/shared/agent-events.ts
  // ('user-message' carries the rewindId; assistant text is a
  // block-start/text-delta/block-stop triple) — never hand-invented.
  await evaluate(`(() => {
    let seq = 1, index = 0;
    const at = () => Date.now();
    const ev = (e) => window.__injectAgentEvent('${WS_ID}', e);
    const say = (t) => { const i = index++;
      ev({ type:'block-start', seq: seq++, at: at(), index: i, kind: 'text' });
      ev({ type:'text-delta',  seq: seq++, at: at(), index: i, text: t });
      ev({ type:'block-stop',  seq: seq++, at: at(), index: i });
    };
    ev({ type:'user-message', seq: seq++, at: at(), text: 'first prompt',  rewindId: 'uuid-1' });
    say('reply one');
    ev({ type:'user-message', seq: seq++, at: at(), text: 'second prompt', rewindId: 'uuid-2' });
    say('reply two');
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  await shot('01-seeded');

  const bubbles = await evaluate(`document.querySelectorAll('.av-message-user').length`);
  check('user bubbles rendered (the fixture reached the view)', bubbles >= 2, `count=${bubbles}`);

  const geo = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.av-message-user')].pop();
    if (!b) return { err: 'no user bubble' };
    const bb = b.getBoundingClientRect();
    const row = b.querySelector('.av-message-actions');
    if (!row) return { err: 'no .av-message-actions row' };
    const rr = row.getBoundingClientRect();
    const fork = b.querySelector('.av-fork-btn');
    if (!fork) return { err: 'no .av-fork-btn' };
    const fr = fork.getBoundingClientRect();
    const rew = b.querySelector('.av-rewind-btn');
    const rwr = rew ? rew.getBoundingClientRect() : null;
    const cs = getComputedStyle(row);
    return {
      bubbleTop: bb.top, bubbleBottom: bb.bottom,
      rowHeight: rr.height, rowTop: rr.top,
      forkCx: fr.left + fr.width / 2, forkCy: fr.top + fr.height / 2,
      rewindCy: rwr ? rwr.top + rwr.height / 2 : null,
      sameLine: rwr ? Math.abs((fr.top + fr.height / 2) - (rwr.top + rwr.height / 2)) < 4 : null,
      display: cs.display, flexDirection: cs.flexDirection,
    };
  })()`);
  if (geo.err) throw new Error(`geometry probe failed: ${geo.err}`);
  console.log(`  geometry: ${JSON.stringify(geo)}`);

  check('action row uses an explicit row layout', geo.display === 'flex' && geo.flexDirection === 'row',
        `display=${geo.display} flex-direction=${geo.flexDirection}`);
  check('both controls sit on ONE line (no wrap)', geo.sameLine === true,
        `forkCy=${geo.forkCy.toFixed(1)} rewindCy=${geo.rewindCy?.toFixed(1)}`);
  check('row height is single-line (54.6 when wrapped)', geo.rowHeight < 40,
        `rowHeight=${geo.rowHeight.toFixed(1)}`);
  // A NEGATIVE gap is overlap and is fine; only a POSITIVE gap is a dead zone.
  const rowGap = geo.rowTop - geo.bubbleBottom;
  check('action row is contiguous with the bubble (no positive dead-zone gap)', rowGap < 4,
        `rowTop-bubbleBottom=${rowGap.toFixed(1)}`);

  // REAL cursor — see trap 1. Bubble first (that is what reveals the row), then
  // onto the button itself.
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: Math.round(geo.forkCx),
    y: Math.round((geo.bubbleTop + geo.bubbleBottom) / 2), buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 250));
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: Math.round(geo.forkCx), y: Math.round(geo.forkCy), buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 400));

  const hit = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.av-message-user')].pop();
    const f = b.querySelector('.av-fork-btn');
    const r = f.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      pe: getComputedStyle(f).pointerEvents,
      opacity: getComputedStyle(f.closest('.av-message-actions')).opacity,
      topEl: el ? String(el.className || el.tagName) : null,
      isForkOrChild: !!(el && (el === f || f.contains(el))),
    };
  })()`);
  console.log(`  hit-test: ${JSON.stringify(hit)}`);
  check('fork button is HIT-TESTABLE at its own centre', hit.isForkOrChild === true, `topEl=${hit.topEl}`);
  check('pointer-events enabled on hover (was "none" forever)', hit.pe !== 'none', `pointerEvents=${hit.pe}`);
  await shot('02-hovered');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? '✘ FORK CONTROL GATE FAILED' : '✔ FORK CONTROL GATE PASSED'} — ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    failed.forEach((f) => console.log(`   - ${f.label}`));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(`DRIVER ERROR: ${e.message}`);
    // NAME the precondition rather than leaving a bare "fetch failed". This gate
    // needs a compositor AND a built artifact, so it is deliberately NOT part of
    // `pnpm run test` (it would fail on headless CI, and a self-skip is the
    // wave-6 vacuous-green shape this repo already got burned by). It fails
    // CLOSED with rc=2 — never a silent pass — but rc=2 is only useful if the
    // reader knows what to start.
    if (/fetch failed|ECONNREFUSED|ws failed/i.test(e.message)) {
      console.error(
        `PRECONDITION NOT MET: no CDP endpoint on port ${PORT}.\n` +
          '  This gate drives a REAL built Orchestra inside a contained headless\n' +
          '  compositor. It does not launch one for you. Required first:\n' +
          '    1. pnpm run build\n' +
          '    2. launch the built artifact under scripts/e2e-contained-rig.sh\n' +
          `       with ORCHESTRA_DEBUG_PORT=${PORT} (NEVER the human's display)\n` +
          '    3. pnpm run test:fork-control',
      );
    }
    process.exitCode = 2;
  })
  .finally(() => {
    try { sock?.close(); } catch { /* already closed */ }
  });
