// #419 — what a live Bloc HTML costs, MEASURED in the BUILT app (contained rig, own headless sway, scratch world): memory of N live blocs (the frames process and the
// whole tree), idle vs busy-script, and whether ONE looping bloc freezes its SIBLING blocs. One run = one fresh Electron. Prior art: scripts/measure-hidden-views.mjs (#406).
//
//   node … measure-bloc-frames.mjs <app-dir> --live-home <home> --out <dir> --plan <runs.jsonl> [--evidence <file.jsonl>]   (run via scripts/measure-bloc-frames.sh)
//   node … measure-bloc-frames.mjs --summary <evidence.jsonl>                                                              (no rig: medians per cell)
// A plan line: {"id":"cell-idle-20-r0","mode":"cell","kind":"idle|busy|big|none","n":20,"rep":0}  or  {"id":"sib-r0","mode":"siblings","rep":0}. Resumable: ids already in --evidence are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { contain, launch, sleep, waitFor, sampleTree, pssKB, CLK_TCK, events, fence, md5, treeHash } from './lib/bloc-rig.mjs';

const argv = process.argv.slice(2);
const flagOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

// ── no-rig mode: medians per cell from the committed evidence ──
if (flagOf('--summary', null)) {
  const rows = fs.readFileSync(flagOf('--summary'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const cells = new Map();
  for (const r of rows.filter((x) => x.mode === 'cell' && x.valid)) { const k = `${r.kind}/${r.n}${r.bytes ? '/' + r.bytes / 1024 + 'K' : ''}${r.variant ? '/' + r.variant : ''}`; (cells.get(k) ?? cells.set(k, []).get(k)).push(r); }
  console.log('kind/N        runs  Δframes-proc RSS MB  /bloc MB   Δtotal RSS MB  Δwindow-renderer MB  frames procs  frames CPU %  allReported s  pongs');
  for (const [k, rs] of [...cells.entries()].sort()) {
    const f = (x, d = 1) => (x == null ? '-' : (x / 1024).toFixed(d));
    console.log(`${k.padEnd(12)} ${String(rs.length).padStart(4)}  ${f(med(rs.map((r) => r.framesRssKB)))}  ${f(med(rs.map((r) => r.perBlocKB)), 2)}  ${f(med(rs.map((r) => r.totalRssKB)))}  ${f(med(rs.map((r) => r.windowRssKB)))}  ${med(rs.map((r) => r.framesProcs))}  ${med(rs.map((r) => r.framesCpuPct))?.toFixed(1)}  ${med(rs.map((r) => r.allReportedS))?.toFixed(1)}  ${med(rs.map((r) => r.pongs))}  ${med(rs.map((r) => r.baselineRafHz))?.toFixed(0) ?? '-'}→${med(rs.map((r) => r.windowRafHz))?.toFixed(0) ?? '-'}  ${med(rs.map((r) => r.codeShownS))?.toFixed(1) ?? '-'}  ${med(rs.map((r) => r.maxEvalMs)) ?? '-'}`);
  }
  for (const r of rows.filter((x) => x.mode === 'siblings')) console.log(`siblings ${r.id}: ${r.verdict}  framesProcs=${r.framesProcs}  rates(before→during) ${JSON.stringify(r.rates)}  windowRoundTripMs=${r.windowMs} rAF ${r.rafBeforeHz?.toFixed(0) ?? '-'}→${r.rafDuringHz?.toFixed(0) ?? '-'}Hz`);
  process.exit(0);
}

const ctx = contain(argv);
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : ctx.refuse('no <app-dir>');
const PLAN = flagOf('--plan', null) ?? ctx.refuse('--plan missing');
const OUT = flagOf('--out', null) ?? path.join(ctx.RIG_DIR, 'out');
const EVID = flagOf('--evidence', path.join(OUT, 'evidence.jsonl'));
const SETTLE_S = Number(flagOf('--settle', 10)), WINDOW_S = Number(flagOf('--window', 20));
const MEM_FLOOR_KB = 6 * 1024 * 1024;
fs.mkdirSync(OUT, { recursive: true });
console.log(`[guard] ${ctx.selfTest}`);

// ── the blocs ──
const PONG = `addEventListener('message',function(){parent.postMessage({__pong:1},'*')});`;
const idleBloc = (i) => `<div style="display:flex;align-items:center;gap:8px;height:36px;color:var(--bloc-fg)"><svg width="120" height="28"><rect x="2" y="${20 - (i % 7)}" width="14" height="${8 + (i % 7)}" fill="var(--bloc-accent)"/><rect x="22" y="6" width="14" height="22" fill="var(--bloc-ok)"/><rect x="42" y="12" width="14" height="16" fill="var(--bloc-warn)"/></svg><button id="b" style="font:inherit">tab A</button><span id="t">bloc ${i}</span></div>
<script>document.getElementById('b').onclick=function(){this.textContent='tab B'};${PONG}</script>`;
const busyBloc = (i) => `<canvas id="c" width="300" height="30" style="display:block;height:36px"></canvas>
<script>var c=document.getElementById('c').getContext('2d'),t=${i},a=[];setInterval(function(){t++;var s=0;for(var k=0;k<400000;k++)s+=Math.sqrt(k+t);a.push(new Array(2000).fill(s));if(a.length>40)a.shift();c.clearRect(0,0,300,30);c.fillRect(t%300,0,10,30)},33);${PONG}</script>`;
const bigBloc = () => `<div style="height:36px">big</div><script>window.keep=new Uint8Array(40*1024*1024).fill(1);${PONG}</script>`;
/** A bloc of ~`bytes` of real DOM (one <span> per ~34 bytes) clipped to 36 px — what a big generated table costs in the frame. */
const srcBloc = (bytes) => { const row = (i) => `<span>row ${String(i).padStart(6, '0')} abcdefghijklmn</span>`; const per = row(0).length; const body = Array.from({ length: Math.max(1, Math.floor(bytes / per)) }, (_, i) => row(i)).join(''); return `<div style="height:36px;overflow:hidden">${body}</div><script>${PONG}</script>`; };
const mk = { idle: idleBloc, busy: busyBloc, big: bigBloc };
const reply = (kind, n, bytes) => 'MEASURE-INTRO\n' + (kind === 'src' || kind === 'codesrc' ? fence('html-render title="src"', srcBloc(bytes)) : Array.from({ length: n }, (_, i) => fence(`html-render title="bloc ${i}"`, mk[kind](i))).join('\n'));

const framesInfo = (cdp) => cdp.eval(`(() => { const fs = [...document.querySelectorAll('iframe.av-bloc-frame')]; return { n: fs.length, h36: fs.filter((f) => Math.round(f.getBoundingClientRect().height) === 36).length, live: document.querySelectorAll('.av-bloc-slot[data-live="1"]').length, slots: document.querySelectorAll('.av-bloc-slot').length }; })()`);
/** The app WINDOW's frame rate over `ms` (rAF count): does a busy bloc starve the window's RENDERING, not just its JS thread? */
const rafHz = (cdp, ms = 2000) => cdp.eval(`new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < ${ms}) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(f); })`, ms + 30000).catch(() => null);
const meanOf = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);


/** The app WINDOW's renderer = the one renderer whose CPU ticks climb while the page burns 1.5 s (Chromium keeps a spare renderer: a pid diff is not enough). */
async function windowPid(root, cdp) {
  const before = new Map(sampleTree(root).filter((p) => p.type === 'renderer').map((p) => [p.pid, p.ticks]));
  await cdp.eval('(() => { const t = Date.now(); while (Date.now() - t < 1500); return 1; })()');
  const d = sampleTree(root).filter((p) => p.type === 'renderer').map((p) => ({ pid: p.pid, d: p.ticks - (before.get(p.pid) ?? p.ticks) })).sort((a, b) => b.d - a.d);
  if (!d.length || d[0].d < 100 || (d[1] && d[1].d > 30)) throw new Error(`cannot identify the window renderer: ${JSON.stringify(d)} tree=${JSON.stringify(sampleTree(root).map((p) => [p.pid, p.type]))}`);
  return d[0].pid;
}

async function sampleWindow(root, winPid, framesPids, seconds) {
  const series = []; const t0 = Date.now(); let prev = null;
  while (Date.now() - t0 < seconds * 1000) {
    const s = sampleTree(root); const now = Date.now();
    const cls = { total: 0, frames: 0, otherRenderer: 0, window: 0, gpu: 0, browser: 0, other: 0, framesTicks: 0, totalTicks: 0 };
    for (const p of s) {
      cls.total += p.rssKB; cls.totalTicks += p.ticks;
      if (framesPids.has(p.pid)) { cls.frames += p.rssKB; cls.framesTicks += p.ticks; }
      else if (p.pid === winPid) cls.window += p.rssKB;
      else if (p.type === 'renderer') cls.otherRenderer += p.rssKB;
      else if (p.type === 'gpu-process') cls.gpu += p.rssKB;
      else if (p.type === 'browser') cls.browser += p.rssKB;
      else cls.other += p.rssKB;
    }
    series.push({ t: now, ...cls, procs: s.length });
    prev = s;
    await sleep(1000);
  }
  return series;
}

async function runCell(spec, armDir) {
  const row = { id: spec.id, mode: 'cell', kind: spec.kind, n: spec.n, bytes: spec.bytes ?? null, variant: spec.variant ?? null, rep: spec.rep, t: new Date().toISOString(), settleS: SETTLE_S, windowS: WINDOW_S, valid: false };
  const memAvail = () => Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]);
  row.memAvailStartKB = memAvail();
  if (row.memAvailStartKB < MEM_FLOOR_KB) { row.aborted = 'memavail-floor'; return row; }
  const h = await launch(ctx, { appDir: APP_DIR, armDir, tag: 'bf419', w: 1400, h: 2200 });
  try {
    const root = h.app.pid; const ev = events();
    await h.inject(ev.text('BASELINE-PROSE'));
    await sleep(8000);
    // baseline in the SAME boot: the window renderer's pids, the tree before any bloc
    const winPid = await windowPid(root, h.cdp);
    row.windowPid = winPid;
    const base = await sampleWindow(root, winPid, new Set(), 5);
    row.baselineRafHz = await rafHz(h.cdp);
    row.baseline = { totalKB: meanOf(base.map((s) => s.total)), windowKB: meanOf(base.map((s) => s.window)), gpuKB: meanOf(base.map((s) => s.gpu)), browserKB: meanOf(base.map((s) => s.browser)), procs: base.at(-1).procs, rendererPids: sampleTree(root).filter((p) => p.type === 'renderer').map((p) => ({ pid: p.pid, rssKB: p.rssKB })) };
    if (spec.kind === 'codesrc') {
      // an OVER-CAP source: the shared reader refuses it and the reply shows it as a code block — what that fallback costs the window
      await h.inject(ev.text(reply('codesrc', 1, spec.bytes)));
      const t1 = Date.now(); let maxEval = 0; const lat = [];
      const codeShown = () => h.cdp.eval(`!!document.querySelector('.av-code-lang') && !document.querySelector('iframe.av-bloc-frame')`, 60000);
      while (Date.now() - t1 < 90000) { const t = Date.now(); const ok = await codeShown().catch(() => null); const d = Date.now() - t; lat.push(d); maxEval = Math.max(maxEval, d); if (ok) break; await sleep(250); }
      row.codeShownS = (Date.now() - t1) / 1000; row.maxEvalMs = maxEval; row.srcBytes = spec.bytes;
      await sleep(SETTLE_S * 1000);
      row.windowRssKB = meanOf((await sampleWindow(root, winPid, new Set(), 5)).map((s) => s.window)) - row.baseline.windowKB;
      row.framesProcs = sampleTree(root).filter((p) => p.type === 'renderer' && p.pid !== winPid).length;
      row.frames = await framesInfo(h.cdp);
      const t0 = Date.now(); row.windowEvalOk = (await h.cdp.eval('1 + 1', 5000).catch(() => null)) === 2; row.windowEvalMs = Date.now() - t0;
      row.valid = row.windowEvalOk && row.frames.n === 0;
      return row;
    }
    if (spec.kind !== 'none') {
      await h.cdp.eval(`window.__pong = 0; window.addEventListener('message', (e) => { if (e.data && e.data.__pong) window.__pong++; }); 1`);
      const tInject = Date.now();
      await h.inject(ev.text(reply(spec.kind, spec.n, spec.bytes)));
      // every bloc reports its 36 px height (a live frame that never ran would stay at the 80 px placeholder)
      await waitFor(async () => { const f = await framesInfo(h.cdp); return f.n === spec.n && f.h36 === spec.n; }, 120000, `${spec.n} frames reporting`).catch((e) => { row.reportErr = String(e.message); });
      row.allReportedS = (Date.now() - tInject) / 1000;
    }
    row.frames = await framesInfo(h.cdp);
    await sleep(SETTLE_S * 1000);
    // "frames processes" = every renderer that is not the window's (a spare renderer is part of the baseline: Δ vs the same boot's N=0 reading is what counts)
    const framesPids = new Set(sampleTree(root).filter((p) => p.type === 'renderer' && p.pid !== winPid).map((p) => p.pid));
    row.framesProcs = framesPids.size;
    row.rendererPidsAfter = sampleTree(root).filter((p) => p.type === 'renderer').map((p) => ({ pid: p.pid, rssKB: p.rssKB }));
    const ser = await sampleWindow(root, winPid, framesPids, WINDOW_S);
    const dt = (ser.at(-1).t - ser[0].t) / 1000;
    row.windowSampledS = dt;
    row.framesRssKB = meanOf(ser.map((s) => s.frames));
    row.windowRssKB = meanOf(ser.map((s) => s.window)) - row.baseline.windowKB;
    row.gpuRssKB = meanOf(ser.map((s) => s.gpu)) - row.baseline.gpuKB;
    row.totalRssKB = meanOf(ser.map((s) => s.total)) - row.baseline.totalKB;
    row.baseline.otherRendererKB = meanOf(base.map((s) => s.otherRenderer));
    row.framesDeltaKB = row.framesRssKB - row.baseline.otherRendererKB; // the frames' cost net of the spare renderer present before any bloc
    row.perBlocKB = spec.n > 0 ? row.framesDeltaKB / spec.n : null;
    row.framesCpuPct = dt > 0 ? ((ser.at(-1).framesTicks - ser[0].framesTicks) / CLK_TCK / dt) * 100 : null;
    row.totalCpuPct = dt > 0 ? ((ser.at(-1).totalTicks - ser[0].totalTicks) / CLK_TCK / dt) * 100 : null;
    row.framesPssKB = [...framesPids].reduce((a, p) => a + (pssKB(p) ?? 0), 0);
        row.memAvailMinKB = Math.min(memAvail(), row.memAvailStartKB);
    // liveness: every live frame answers a ping (a frame that does not is hung or dead, not "cheap")
    if (spec.kind === 'codesrc') {
      // an OVER-CAP source: the shared reader refuses it and the reply shows it as a code block — what that fallback costs the window
      await h.inject(ev.text(reply('codesrc', 1, spec.bytes)));
      const t1 = Date.now(); let maxEval = 0; const lat = [];
      const codeShown = () => h.cdp.eval(`!!document.querySelector('.av-code-lang') && !document.querySelector('iframe.av-bloc-frame')`, 60000);
      while (Date.now() - t1 < 90000) { const t = Date.now(); const ok = await codeShown().catch(() => null); const d = Date.now() - t; lat.push(d); maxEval = Math.max(maxEval, d); if (ok) break; await sleep(250); }
      row.codeShownS = (Date.now() - t1) / 1000; row.maxEvalMs = maxEval; row.srcBytes = spec.bytes;
      await sleep(SETTLE_S * 1000);
      row.windowRssKB = meanOf((await sampleWindow(root, winPid, new Set(), 5)).map((s) => s.window)) - row.baseline.windowKB;
      row.framesProcs = sampleTree(root).filter((p) => p.type === 'renderer' && p.pid !== winPid).length;
      row.frames = await framesInfo(h.cdp);
      const t0 = Date.now(); row.windowEvalOk = (await h.cdp.eval('1 + 1', 5000).catch(() => null)) === 2; row.windowEvalMs = Date.now() - t0;
      row.valid = row.windowEvalOk && row.frames.n === 0;
      return row;
    }
    if (spec.kind !== 'none') {
      await h.cdp.eval(`window.__pong = 0; [...document.querySelectorAll('iframe.av-bloc-frame')].forEach((f) => f.contentWindow.postMessage('ping', '*')); 1`);
      await sleep(Math.min(20000, 3000 + spec.n * 200));
      row.pongs = await h.cdp.eval('window.__pong');
      row.livenessFail = spec.n - row.pongs;
    }
    row.windowRafHz = await rafHz(h.cdp);
    const t0 = Date.now(); row.windowEvalOk = (await h.cdp.eval('1 + 1', 5000).catch(() => null)) === 2; row.windowEvalMs = Date.now() - t0;
    row.valid = row.windowEvalOk && (spec.kind === 'none' || (row.frames.n === spec.n && row.frames.h36 === spec.n && row.framesProcs >= 1 && row.pongs === spec.n));
  } catch (e) { row.error = String(e.stack || e).slice(0, 600); }
  finally { row.survivors = (await h.stop()).length; }
  return row;
}

async function runSiblings(spec, armDir) {
  const row = { id: spec.id, mode: 'siblings', rep: spec.rep, t: new Date().toISOString(), valid: false };
  const h = await launch(ctx, { appDir: APP_DIR, armDir, tag: 'bf419', w: 1400, h: 2200 });
  try {
    const root = h.app.pid; const ev = events();
    await h.inject(ev.text('BASELINE-PROSE'));
    await sleep(6000);
    const winPid = await windowPid(root, h.cdp);
    const hb = (i, loop) => `<div style="height:36px">sib ${i}</div><script>var n=0;setInterval(function(){parent.postMessage({__hb:${i},n:++n},'*')},100);${loop ? `addEventListener('message',function(e){if(e.data==='go'){for(;;){}}});` : ''}</script>`;
    // 0 = the looper, 1–3 same reply (siblings), 4 a LATER reply (a sibling in another message)
    await h.cdp.eval(`window.__hb = {}; window.addEventListener('message', (e) => { const d = e.data; if (d && typeof d.__hb === 'number') window.__hb[d.__hb] = (window.__hb[d.__hb] || 0) + 1; }); 1`);
    await h.inject(ev.text('SIB-A\n' + [0, 1, 2, 3].map((i) => fence(`html-render title="sib ${i}"`, hb(i, i === 0))).join('\n')));
    await h.inject(ev.text('SIB-B\n' + fence('html-render title="sib 4"', hb(4, false))));
    await waitFor(async () => (await framesInfo(h.cdp)).h36 === 5, 60000, '5 sibling frames reporting');
    await sleep(2000);
    const tk0 = new Map(sampleTree(root).filter((p) => p.type === 'renderer').map((p) => [p.pid, p.ticks]));
    const count = () => h.cdp.eval('JSON.stringify(window.__hb)').then(JSON.parse);
    const rate = async (s) => { const a = await count(); await sleep(s * 1000); const b = await count(); return [0, 1, 2, 3, 4].map((i) => ((b[i] ?? 0) - (a[i] ?? 0)) / s); };
    row.rafBeforeHz = await rafHz(h.cdp);
    const before = await rate(3);
    await h.cdp.eval(`document.querySelectorAll('iframe.av-bloc-frame')[0].contentWindow.postMessage('go', '*'); 1`);
    await sleep(1500); // the loop is on
    const during = await rate(6);
    row.rafDuringHz = await rafHz(h.cdp); // the loop is still on
    // the process the loop burns: renderer pids whose CPU climbed (≈ 6+ s of ticks) — the frames process; is it the window's?
    const burned = sampleTree(root).filter((p) => p.type === 'renderer').map((p) => ({ pid: p.pid, ticks: p.ticks - (tk0.get(p.pid) ?? p.ticks), isWindow: p.pid === winPid })).filter((x) => x.ticks > 300);
    row.burnedRenderers = burned;
    row.framesProcs = burned.filter((b) => !b.isWindow).length;
    row.loopProcessIsWindow = burned.some((b) => b.isWindow);
    const t0 = Date.now(); const ok = await h.cdp.eval('1 + 1', 5000).catch(() => null); row.windowMs = ok === 2 ? Date.now() - t0 : null;
    row.rates = before.map((b, i) => [Number(b.toFixed(1)), Number(during[i].toFixed(1))]);
    const alive = (i) => before[i] > 5; // the instrument can say "ticking" before the loop
    const dead = (i) => during[i] < before[i] * 0.1;
    row.controlLooperDeadAfter = dead(0); // the looper itself must read FROZEN, or the instrument cannot say frozen
    row.siblingsFrozen = [1, 2, 3, 4].map(dead);
    row.verdict = !([0, 1, 2, 3, 4].every(alive) && row.controlLooperDeadAfter) ? 'INSTRUMENT-INVALID' : row.siblingsFrozen.every(Boolean) ? 'SIBLINGS-FROZEN' : row.siblingsFrozen.some(Boolean) ? 'SOME-SIBLINGS-FROZEN' : 'SIBLINGS-RUN';
    row.valid = row.verdict !== 'INSTRUMENT-INVALID' && row.windowMs != null && row.framesProcs === 1 && !row.loopProcessIsWindow;
  } catch (e) { row.error = String(e.stack || e).slice(0, 600); }
  finally { row.survivors = (await h.stop()).length; }
  return row;
}

// ── main ──
const plan = fs.readFileSync(PLAN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const done = new Set(fs.existsSync(EVID) ? fs.readFileSync(EVID, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
const before = ctx.liveCanary();
const appHash = treeHash([path.join(APP_DIR, 'dist'), path.join(APP_DIR, 'dist-electron')]);
const meta = { app: APP_DIR, appHash, electron: JSON.parse(fs.readFileSync(path.join(APP_DIR, 'node_modules/electron/package.json'), 'utf8')).version, pageKB: null, load1: fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0] };
console.log(`[rig] ${plan.length} planned, ${done.size} already in ${EVID}; app ${APP_DIR} (${appHash}) electron ${meta.electron}`);
for (const spec of plan) {
  if (done.has(spec.id)) continue;
  const armDir = path.join(ctx.RIG_DIR, `run-${spec.id}`);
  fs.mkdirSync(armDir, { recursive: true });
  const row = spec.mode === 'siblings' ? await runSiblings(spec, armDir) : await runCell(spec, armDir);
  row.appHash = appHash; row.load1 = fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0];
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n');
  console.log(`${row.valid ? 'OK ' : 'BAD'} ${spec.id}: ${row.mode === 'siblings' ? `${row.verdict} procs=${row.framesProcs} rates=${JSON.stringify(row.rates)} windowRaf ${row.rafBeforeHz?.toFixed(0)}→${row.rafDuringHz?.toFixed(0)}Hz` : `framesRSS=${((row.framesRssKB ?? 0) / 1024).toFixed(0)}MB procs=${row.framesProcs} perBloc=${((row.perBlocKB ?? 0) / 1024).toFixed(2)}MB totalΔ=${((row.totalRssKB ?? 0) / 1024).toFixed(0)}MB cpu=${row.framesCpuPct?.toFixed(0)}% reported=${row.allReportedS?.toFixed(1)}s pongs=${row.pongs}/${row.n} windowRaf ${row.baselineRafHz?.toFixed(0)}→${row.windowRafHz?.toFixed(0)}Hz`}${row.error ? ' ERR ' + row.error.split('\n')[0] : ''}${row.survivors ? ` SURVIVORS=${row.survivors}` : ''}`);
}
const after = ctx.liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
const appSame = treeHash([path.join(APP_DIR, 'dist'), path.join(APP_DIR, 'dist-electron')]) === appHash;
console.log(`[rig] live ~/.claude* canary ${same ? 'unchanged' : 'CHANGED'}; built app dir ${appSame ? 'untouched' : 'CHANGED'}`);
process.exit(same && appSame ? 0 : 1);
