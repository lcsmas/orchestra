#!/usr/bin/env node
/* Gates the "a failed tool must NOT paint the collapsed run row red" behaviour.
 *
 * Seeds TWO adjacent tool runs in the structured view — one all-success, one
 * containing a Bash tool whose result carries isError:true — and asserts the
 * two collapsed rows are pixel-identical in treatment: same computed text
 * colour, no `av-tool-run-error` class, no error status dot. The all-success
 * run is the CONTROL: comparing the failing row against it (rather than
 * against a hardcoded rgb) is what makes the check survive a theme change.
 *
 * It also asserts the failure is still REACHABLE — expanding the failing run
 * must reveal a `.av-tool-errored` card with the "failed" pill — so this can't
 * be satisfied by deleting error rendering outright.
 *
 * Usage: node scripts/verify-failed-tool-not-red.mjs --port 9376 --ws ws-redcheck
 *        [--shot-dir /tmp/orch-verify-red]
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] ?? '1']);
    return acc;
  }, []),
);
const PORT = Number(args.port || 9376);
const WS = args.ws || '';
const SHOT_DIR = args['shot-dir'] || '/tmp/orch-verify-red';
if (!WS) { console.error('need --ws <workspaceId>'); process.exit(2); }

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

async function findTarget(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && /dist\/index\.html|app\.asar/i.test(t.url));
  if (!page) throw new Error(`no renderer target on :${port}`);
  console.error(`[cdp] target: ${page.url}`);
  if (/app\.asar/.test(page.url)) {
    // The installed AppImage, not this worktree — an inherited APPIMAGE env var
    // makes src/main/index.ts relaunch the INSTALLED build (ozone relaunch).
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

// Reload so the injected transcript starts from an empty renderer session —
// otherwise a re-run stacks a second copy of the seed and the run-count control
// fails for the wrong reason. (Workspace records live in the main-process store
// and survive the reload.)
await client.send('Page.reload');
await new Promise((r) => setTimeout(r, 4000));
await client.send('Runtime.enable');
await settle(8);

// ── Open the structured tab ──────────────────────────────────────────────────
await ev(`window.__orchestraSetState(${JSON.stringify({ activeId: WS, view: 'structured' })}); 1`);
await settle();

// ── Seed: text, an ALL-SUCCESS run (control), text, a run WITH A FAILURE ─────
let seq = 1; let blockIdx = 0;
const events = [];
const at = () => 1754300000000 + seq;
const text = (t) => {
  const index = blockIdx++;
  events.push({ type: 'block-start', seq: seq++, at: at(), index, kind: 'text' });
  events.push({ type: 'text-delta', seq: seq++, at: at(), index, text: t });
  events.push({ type: 'block-stop', seq: seq++, at: at(), index });
};
const bash = (id, command, fail) => {
  const index = blockIdx++;
  events.push({ type: 'block-start', seq: seq++, at: at(), index, kind: 'tool_use', toolUseId: id, name: 'Bash' });
  events.push({ type: 'tool-use', seq: seq++, at: at(), index, toolUseId: id, name: 'Bash', input: { command, description: command } });
  events.push({ type: 'block-stop', seq: seq++, at: at(), index });
  events.push({
    type: 'tool-result', seq: seq++, at: at(), toolUseId: id,
    content: fail ? "grep: no matches found\nexit status 1" : 'ok',
    isError: !!fail,
  });
};
text('I’ll rename the branch first, then dig into the login feature.');
bash('toolu_ok_1', 'git status --short', false);
bash('toolu_ok_2', 'git log --oneline -5', false);
text('Now searching the login code.');
bash('toolu_ok_3', 'ls src', false);
bash('toolu_fail_1', 'grep -rn "loginz" src', true); // non-zero exit: routine
bash('toolu_ok_4', 'rg login src', false);
events.push({ type: 'turn-end', seq: seq++, at: at(), isError: false, stopReason: 'end_turn', numTurns: 1, costUsd: null, usage: null, resultText: null, sessionId: 's-red', durationMs: null });

await ev(`(() => {
  const evs = ${JSON.stringify(events)};
  for (const e of evs) window.__injectAgentEvent(${JSON.stringify(WS)}, e);
  return evs.length;
})()`);
await settle(10);

// ── CONTROL: the failure really IS in state (else every check below is vacuous) ─
const state = await ev(`(() => {
  const s = window.__readAgentSession(${JSON.stringify(WS)});
  if (!s) return { error: 'no session' };
  const tools = s.messages.filter((m) => m.role === 'tool');
  return {
    messages: s.messages.length,
    tools: tools.length,
    errored: tools.filter((m) => m.toolResult && m.toolResult.isError === true).map((m) => m.id),
    ok: tools.filter((m) => m.toolResult && m.toolResult.isError !== true).length,
  };
})()`);
check('CONTROL: a tool result with isError:true is in the folded session',
  state.errored && state.errored.length === 1 && state.errored[0] === 'toolu_fail_1' && state.ok === 4,
  JSON.stringify(state));
if (!(state.errored && state.errored.length === 1)) {
  console.error('ABORT: no errored tool in state — every later check would be vacuous.');
  client.close(); process.exit(1);
}

// ── The oracle: compare the two collapsed rows ───────────────────────────────
// Park the cursor off the transcript first. CDP's pointer position PERSISTS
// across script runs, so a previous drive's click leaves a row :hover-ed —
// which brightens `--av-text-faint` to `--av-text-dim` and makes the two rows
// differ for a reason that has nothing to do with the change under test.
await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
await settle(4);
const rows = await ev(`(() => {
  const runs = [...document.querySelectorAll('.av-tool-run')];
  // Resolve --av-error to the rgb() form getComputedStyle returns. It is NOT
  // declared on :root — it lives on the agent-view scope — so the probe must be
  // parented INSIDE a run, or it resolves to nothing and the "not red" check
  // silently compares against the inherited colour (i.e. passes vacuously).
  const scope = runs[0] || document.body;
  const errVar = getComputedStyle(scope).getPropertyValue('--av-error').trim();
  const probe = document.createElement('span');
  probe.style.color = 'var(--av-error)';
  scope.appendChild(probe);
  const errRgb = getComputedStyle(probe).color;
  probe.remove();
  if (!errVar || !/^rgb/.test(errRgb)) return { fatal: 'could not resolve --av-error: ' + errVar + ' / ' + errRgb };
  return {
    errVar, errRgb,
    runs: runs.map((r) => {
      const h = r.querySelector('.av-tool-run-header');
      const rect = h.getBoundingClientRect();
      return {
        classes: r.className,
        label: h.querySelector('.av-tool-run-label').textContent,
        color: getComputedStyle(h).color,
        statusDots: r.querySelectorAll('.av-tool-run-status').length,
        errorDots: r.querySelectorAll('.av-tool-run-status-error').length,
        rect: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
                left: Math.round(rect.left), right: Math.round(rect.right), w: Math.round(rect.width) },
      };
    }),
  };
})()`);
console.log('[rows] ' + JSON.stringify(rows, null, 1));
if (rows.fatal) { console.error('ABORT: ' + rows.fatal); client.close(); process.exit(1); }

const okRun = rows.runs.find((r) => r.label === 'Ran 2 commands');
const failRun = rows.runs.find((r) => r.label === 'Ran 3 commands');
check('CONTROL: both a clean run and the failing run are on screen',
  !!okRun && !!failRun && rows.runs.length === 2,
  `runs=${rows.runs.length} labels=${JSON.stringify(rows.runs.map((r) => r.label))}`);
if (!okRun || !failRun) { client.close(); process.exit(1); }

check('failing run carries NO av-tool-run-error class',
  !/av-tool-run-error/.test(failRun.classes),
  `classes="${failRun.classes}"`);
check('failing run shows NO error status dot',
  failRun.errorDots === 0 && failRun.statusDots === 0,
  `errorDots=${failRun.errorDots} statusDots=${failRun.statusDots}`);
check('failing run’s label colour is NOT the error colour',
  failRun.color !== rows.errRgb,
  `header=${failRun.color} --av-error=${rows.errVar} (${rows.errRgb})`);
check('failing run’s label colour is IDENTICAL to the clean run’s',
  failRun.color === okRun.color,
  `fail=${failRun.color} clean=${okRun.color}`);
check('collapsed rows are fully inside the viewport',
  failRun.rect.left >= 0 && failRun.rect.right <= 1600 && failRun.rect.w > 40,
  JSON.stringify(failRun.rect));

const shotCollapsed = await shot('01-collapsed-failing-run-not-red.png');

// ── The failure is still REACHABLE: expand via TRUSTED click ─────────────────
await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: failRun.rect.x, y: failRun.rect.y, button: 'left', clickCount: 1 });
await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: failRun.rect.x, y: failRun.rect.y, button: 'left', clickCount: 1 });
await settle(8);

const expanded = await ev(`(() => {
  const run = [...document.querySelectorAll('.av-tool-run')]
    .find((r) => r.querySelector('.av-tool-run-label').textContent === 'Ran 3 commands');
  const cards = [...run.querySelectorAll('.av-tool-card')];
  const errored = cards.filter((c) => c.className.includes('av-tool-errored'));
  const pill = run.querySelector('.av-tool-status-error');
  const errOut = run.querySelector('.av-tool-out-error');
  return {
    open: run.className.includes('av-open'),
    cards: cards.length,
    erroredCards: errored.length,
    pillText: pill ? pill.textContent.trim() : null,
    pillColor: pill ? getComputedStyle(pill).color : null,
    errOutText: errOut ? errOut.textContent.trim().slice(0, 60) : null,
    headerColorStillNeutral: getComputedStyle(run.querySelector('.av-tool-run-header')).color,
  };
})()`);
console.log('[expanded] ' + JSON.stringify(expanded));
check('CONTROL: the trusted click actually expanded the run (state CHANGED)',
  expanded.open === true && expanded.cards === 3,
  `open=${expanded.open} cards=${expanded.cards} (pre-state was closed, 0 cards)`);
check('expanded card still surfaces the failure (tint + "failed" pill + stderr)',
  expanded.erroredCards === 1 && expanded.pillText === 'failed' && /exit status 1/.test(expanded.errOutText || ''),
  `erroredCards=${expanded.erroredCards} pill=${JSON.stringify(expanded.pillText)} out=${JSON.stringify(expanded.errOutText)}`);
// Cross-check that `errRgb` names the colour the app ACTUALLY paints failures
// in — otherwise the "not the error colour" assertions above are comparing the
// header against a value nothing uses, and pass vacuously.
check('CONTROL: the error colour oracle matches the real "failed" pill colour',
  rows.errRgb === expanded.pillColor,
  `--av-error=${rows.errRgb} pill=${expanded.pillColor}`);
check('the run HEADER stays neutral even while expanded',
  expanded.headerColorStillNeutral !== rows.errRgb,
  `header=${expanded.headerColorStillNeutral} error=${rows.errRgb}`);

const shotExpanded = await shot('02-expanded-failure-still-visible.png');
check('the two screenshots are not byte-identical (the drive changed pixels)',
  shotExpanded.dup === null && shotCollapsed.hash !== shotExpanded.hash,
  `collapsed=${shotCollapsed.hash} expanded=${shotExpanded.hash}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${shotCollapsed.path}, ${shotExpanded.path}`);
client.close();
process.exit(failed.length ? 1 : 0);
