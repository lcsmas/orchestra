#!/usr/bin/env node
/* Gates "a tool run carries NO status dot, in any state".
 *
 * The collapsed run row used to end in a small dot on the far right — pulsing
 * while a tool was still going, red when one had failed — and every individual
 * tool card inside an expanded run carried its own. Both are gone; state now
 * lives in the `.av-sr-only` word (and, for a card, the "failed" pill + the
 * accent-tinted border on a running card).
 *
 * Seeds THREE runs — all-success (done), containing a failure, and one still
 * RUNNING (a tool_use with no tool-result) — so the assertion covers every
 * branch that used to paint a dot, not just the finished one. Then expands the
 * failing run and asserts the cards inside carry no dot either.
 *
 * Guards against a vacuous pass in both directions: the CONTROLs assert the
 * states really are in the folded session (pending + errored), that the rows
 * really rendered (labels present, non-zero rects), and that the things which
 * MUST survive still do — the "failed" pill, its stderr, and the sr-only word.
 * "0 dots" from an empty transcript would otherwise look identical to success.
 *
 * Usage: node scripts/verify-no-tool-status-dots.mjs --port 9377 --ws ws-dots
 *        [--shot-dir /tmp/orch-verify-dots]
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] ?? '1']);
    return acc;
  }, []),
);
const PORT = Number(args.port || 9377);
const WS = args.ws || '';
const SHOT_DIR = args['shot-dir'] || '/tmp/orch-verify-dots';
if (!WS) { console.error('need --ws <workspaceId>'); process.exit(2); }

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

async function findTarget(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && /dist\/index\.html|app\.asar/i.test(t.url));
  if (!page) throw new Error(`no renderer target on :${port}`);
  console.error(`[cdp] target: ${page.url}`);
  if (/app\.asar/.test(page.url)) {
    console.error('[cdp] ABORT: that is the packaged app, not the worktree build.');
    process.exit(2);
  }
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
  const r = await client.send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result?.value;
};
const settle = (n = 6) => ev(
  `new Promise(r=>{let i=${n};const t=()=>--i<=0?setTimeout(()=>r(1),120):requestAnimationFrame(t);requestAnimationFrame(t)})`,
);

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};

mkdirSync(SHOT_DIR, { recursive: true });
const shotHashes = new Map();
async function shot(file) {
  const r = await Promise.race([
    client.send('Page.captureScreenshot', { format: 'png' }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timed out — window produces no frames')), 15000)),
  ]);
  const buf = Buffer.from(r.data, 'base64');
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const path = `${SHOT_DIR}/${file}`;
  writeFileSync(path, buf);
  const dup = shotHashes.get(hash);
  shotHashes.set(hash, path);
  console.log(`[shot] ${path}  ${buf.length}B  sha=${hash}${dup ? `  !! BYTE-IDENTICAL to ${dup}` : ''}`);
  return { path, hash, dup: dup || null };
}

// Fresh renderer session, so a re-run doesn't stack a second copy of the seed.
await client.send('Page.reload');
await new Promise((r) => setTimeout(r, 4000));
await client.send('Runtime.enable');
await settle(8);

await ev(`window.__orchestraSetState(${JSON.stringify({ activeId: WS, view: 'structured' })}); 1`);
await settle();

// ── Seed: a done run, a run with a failure, and a run still RUNNING ──────────
let seq = 1; let blockIdx = 0;
const events = [];
const at = () => 1754300000000 + seq;
const text = (t) => {
  const index = blockIdx++;
  events.push({ type: 'block-start', seq: seq++, at: at(), index, kind: 'text' });
  events.push({ type: 'text-delta', seq: seq++, at: at(), index, text: t });
  events.push({ type: 'block-stop', seq: seq++, at: at(), index });
};
// `settled: false` leaves the block OPEN — no block-stop, no tool-result. That
// is what the fold calls pending: `block-stop` sets done:true
// (agent-events.ts:1087) regardless of whether a result ever lands, so a tool
// that is merely awaiting its result is NOT the pending branch — an open block
// is. Get this wrong and the pending assertions pass against a `done` message.
const bash = (id, command, { fail = false, settled = true } = {}) => {
  const index = blockIdx++;
  events.push({ type: 'block-start', seq: seq++, at: at(), index, kind: 'tool_use', toolUseId: id, name: 'Bash' });
  events.push({ type: 'tool-use', seq: seq++, at: at(), index, toolUseId: id, name: 'Bash', input: { command, description: command } });
  if (!settled) return;
  events.push({ type: 'block-stop', seq: seq++, at: at(), index });
  events.push({
    type: 'tool-result', seq: seq++, at: at(), toolUseId: id,
    content: fail ? 'grep: no matches found\nexit status 1' : 'ok',
    isError: !!fail,
  });
};
text('Checking the tree, then the login code.');
bash('toolu_ok_1', 'git status --short');
bash('toolu_ok_2', 'git log --oneline -5');
text('Now searching the login code.');
bash('toolu_ok_3', 'ls src');
bash('toolu_fail_1', 'grep -rn "loginz" src', { fail: true });
text('One more, still going.');
bash('toolu_pending_1', 'pnpm test', { settled: false });
// NO turn-end: the turn is live, so the pending tool stays pending.

await ev(`(() => {
  const evs = ${JSON.stringify(events)};
  for (const e of evs) window.__injectAgentEvent(${JSON.stringify(WS)}, e);
  return evs.length;
})()`);
await settle(10);

// ── CONTROL: both interesting states really are in the folded session ────────
const state = await ev(`(() => {
  const s = window.__readAgentSession(${JSON.stringify(WS)});
  if (!s) return { error: 'no session' };
  const tools = s.messages.filter((m) => m.role === 'tool');
  return {
    tools: tools.length,
    errored: tools.filter((m) => m.toolResult && m.toolResult.isError === true).map((m) => m.id),
    pending: tools.filter((m) => !m.toolResult && !m.done).map((m) => m.id),
    ok: tools.filter((m) => m.toolResult && m.toolResult.isError !== true).length,
  };
})()`);
console.log('[state] ' + JSON.stringify(state));
const seededOk = state.errored?.length === 1 && state.pending?.length === 1 && state.ok === 3;
check('CONTROL: an errored AND a still-pending tool are in the folded session',
  seededOk, JSON.stringify(state));
if (!seededOk) {
  console.error('ABORT: the dot-bearing states are not in state — every check below would be vacuous.');
  client.close(); process.exit(1);
}

// Park the cursor: a previous drive's pointer leaves a row :hover-ed.
await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
await settle(4);

const rows = await ev(`(() => {
  const runs = [...document.querySelectorAll('.av-tool-run')];
  const view = document.querySelector('.av-view') || document.body;
  return {
    // Dots ANYWHERE in the view, by every class the two components ever used.
    runStatus: view.querySelectorAll('.av-tool-run-status').length,
    runDots: view.querySelectorAll('.av-tool-run-status-dot').length,
    cardDots: view.querySelectorAll('.av-tool-status-dot').length,
    anyDotClass: view.querySelectorAll('[class*="status-dot"]').length,
    runs: runs.map((r) => {
      const h = r.querySelector('.av-tool-run-header');
      const rect = h.getBoundingClientRect();
      return {
        classes: r.className,
        label: h.querySelector('.av-tool-run-label').textContent,
        srOnly: [...h.querySelectorAll('.av-sr-only')].map((s) => s.textContent).join(','),
        color: getComputedStyle(h).color,
        rect: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
                left: Math.round(rect.left), right: Math.round(rect.right),
                w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    }),
  };
})()`);
console.log('[rows] ' + JSON.stringify(rows, null, 1));

const doneRun = rows.runs.find((r) => r.label === 'Ran 2 commands');
const failRun = rows.runs.find((r) => r.label === 'Ran 2 commands' && r !== doneRun)
  || rows.runs.filter((r) => r.label === 'Ran 2 commands')[1];
const pendRun = rows.runs.find((r) => /av-tool-run-pending/.test(r.classes));
check('CONTROL: three runs rendered, one of them still pending',
  rows.runs.length === 3 && !!doneRun && !!pendRun && doneRun.rect.w > 40,
  `runs=${rows.runs.length} labels=${JSON.stringify(rows.runs.map((r) => r.label))} pendingClasses="${pendRun?.classes}"`);
if (rows.runs.length !== 3 || !pendRun) { client.close(); process.exit(1); }

check('NO status dot on any collapsed run row — done, failed, or running',
  rows.runStatus === 0 && rows.runDots === 0 && rows.anyDotClass === 0,
  `av-tool-run-status=${rows.runStatus} run-dots=${rows.runDots} any[class*=status-dot]=${rows.anyDotClass}`);
check('CONTROL: the running run still says "running" for screen readers',
  /running/.test(pendRun.srOnly),
  `srOnly=${JSON.stringify(pendRun.srOnly)} classes="${pendRun.classes}"`);
check('every collapsed row is fully inside the viewport',
  rows.runs.every((r) => r.rect.left >= 0 && r.rect.right <= 1600 && r.rect.w > 40),
  JSON.stringify(rows.runs.map((r) => r.rect)));

const shotCollapsed = await shot('01-collapsed-runs-no-dots.png');

// ── Expand the failing run: its CARDS must carry no dot either ───────────────
const target = rows.runs.filter((r) => r.label === 'Ran 2 commands')[1] || rows.runs[1];
await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.rect.x, y: target.rect.y, button: 'left', clickCount: 1 });
await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.rect.x, y: target.rect.y, button: 'left', clickCount: 1 });
await settle(8);

const expanded = await ev(`(() => {
  const view = document.querySelector('.av-view') || document.body;
  const open = [...document.querySelectorAll('.av-tool-run')].filter((r) => r.className.includes('av-open'));
  const cards = open.flatMap((r) => [...r.querySelectorAll('.av-tool-card')]);
  const pill = view.querySelector('.av-tool-status-error');
  const errOut = view.querySelector('.av-tool-out-error');
  return {
    openRuns: open.length,
    cards: cards.length,
    erroredCards: cards.filter((c) => c.className.includes('av-tool-errored')).length,
    // Scoped to the CARDS, not the whole view: a dot on some collapsed row
    // elsewhere is the other check's job, and counting it here would make this
    // one fail for a defect it doesn't name.
    cardDots: cards.reduce((n, c) => n + c.querySelectorAll('.av-tool-status-dot').length, 0),
    anyDotClass: cards.reduce((n, c) => n + c.querySelectorAll('[class*="status-dot"]').length, 0),
    statusSlots: cards.reduce((n, c) => n + c.querySelectorAll('.av-tool-status').length, 0),
    pillText: pill ? pill.textContent.trim() : null,
    errOutText: errOut ? errOut.textContent.trim().slice(0, 60) : null,
  };
})()`);
console.log('[expanded] ' + JSON.stringify(expanded));
check('CONTROL: the trusted click expanded a run (state CHANGED: 0 cards → n)',
  expanded.openRuns === 1 && expanded.cards >= 2,
  `openRuns=${expanded.openRuns} cards=${expanded.cards} (pre-state: no .av-open, 0 cards)`);
check('NO status dot on any expanded tool card either',
  expanded.cardDots === 0 && expanded.anyDotClass === 0,
  `card-dots=${expanded.cardDots} any[class*=status-dot]=${expanded.anyDotClass} statusSlots=${expanded.statusSlots}`);
check('CONTROL: the failure is still surfaced in words on the card',
  expanded.erroredCards === 1 && expanded.pillText === 'failed' && /exit status 1/.test(expanded.errOutText || ''),
  `erroredCards=${expanded.erroredCards} pill=${JSON.stringify(expanded.pillText)} out=${JSON.stringify(expanded.errOutText)}`);

const shotExpanded = await shot('02-expanded-cards-no-dots.png');
check('the two screenshots are not byte-identical (the drive changed pixels)',
  shotExpanded.dup === null && shotCollapsed.hash !== shotExpanded.hash,
  `collapsed=${shotCollapsed.hash} expanded=${shotExpanded.hash}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${shotCollapsed.path}, ${shotExpanded.path}`);
client.close();
process.exit(failed.length ? 1 : 0);
