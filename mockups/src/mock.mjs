// mock.mjs <areas> <opts> — render the F1 #257 mockups on the REAL packaged app (scratch fleet), one PNG sheet per (option, area).
import { buildWorld, seedBus, launchApp, preflight, sleep, say, SCRATCH, IDS, NAMES, FLEET } from './world.mjs';
import path from 'node:path';
import fs from 'node:fs';
preflight();
const areas = (process.argv[2] ?? 'sidebar').split(',');
const opts = (process.argv[3] ?? 'A,B,C').split(',');
const OUT = path.join(SCRATCH, 'shots'); fs.mkdirSync(OUT, { recursive: true });
const w = buildWorld('mock');
say('SEED', JSON.stringify(seedBus(w.H, 'idle')));
const a = await launchApp(w, { size: [1440, 900] });
const cdp = a.cdp;
const data = fs.readFileSync(path.join(SCRATCH, 'states.json'), 'utf8');
const kit = ['kit-common.js', 'kit-sidebar.js', 'kit-bus.js'].filter((f) => fs.existsSync(path.join(SCRATCH, f))).map((f) => fs.readFileSync(path.join(SCRATCH, f), 'utf8'));
const STATUS = Object.fromEntries(FLEET.map(([k, , , status]) => [IDS[k], status]));
async function reset() {
  await cdp.eval('location.reload()').catch(() => {});
  await sleep(2500);
  for (let i = 0; i < 40; i++) { if (await cdp.eval(`document.querySelectorAll('.ws-item').length`) >= 10) break; await sleep(250); }
  await cdp.eval(`(async () => { const l = await window.orchestra.listWorkspaces(); const st = ${JSON.stringify(STATUS)}; window.__orchestraSetState({ workspaces: l.map((x) => ({ ...x, status: st[x.id] ?? x.status })) }); })()`);
  await cdp.eval(`window.__PM_DATA = ${data}; ${kit.join('\n')}; PM.install(); true`);
  await sleep(400);
}
const shotB64 = async (clip) => (await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: true })).result.data;
async function showSheet(html, W, H, file) {
  // a CLEAN document (the app's html/body are overflow:hidden + height:100%): the sheet is plain flow content
  const css = await cdp.eval(`[...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href)`);
  await cdp.eval(`(() => { const keep = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.outerHTML).join(''); document.open(); document.write('<!doctype html><html><head><meta charset=utf-8>' + keep + '<style>html,body{height:auto!important;overflow:visible!important;margin:0;background:#0a0b0d}</style></head><body></body></html>'); document.close(); return true; })()`);
  await sleep(600);
  await cdp.eval(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html.replace('position:fixed;inset:0;', ''))}); document.fonts.ready.then(() => true)`);
  await sleep(600);
  const png = (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } })).result.data;
  fs.writeFileSync(path.join(OUT, file), Buffer.from(png, 'base64'));
  say('wrote', file, `${W}x${H}`);
}
async function sheetAuto(file, items, cellW) {
  const html = `<div id="pm-sheet" style="position:fixed;inset:0;z-index:99999;background:#0a0b0d;padding:14px;display:flex;flex-direction:column;gap:12px;font-family:Geist,Inter,sans-serif;color:#eef1f5">${items.map((it) => `<figure style="margin:0;width:${cellW}px"><div style="font-size:12px;font-weight:600;margin:0 0 5px"><span style="color:#6ea8ff">${it.tag}</span> ${it.title}</div><div style="border:1px solid #23272f;border-radius:8px;overflow:hidden;height:${it.h}px;background:#0a0b0d"><img src="data:image/png;base64,${it.b64}" style="display:block"></div></figure>`).join('')}</div>`;
  const W = cellW + 28, H = items.reduce((n, it) => n + it.h + 12 + 24, 0) + 28;
  await showSheet(html, W, H, file);
  say('wrote', file, `${W}x${H}`);
}
async function sheet(file, items, { cols = 2, cellW, cellH, title }) {
  const html = `<div id="pm-sheet" style="position:fixed;inset:0;z-index:99999;background:#0a0b0d;padding:14px;display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:14px;align-content:start;justify-content:start;font-family:Geist,Inter,sans-serif;color:#eef1f5">${items.map((it) => `<figure style="margin:0;width:${cellW}px"><div style="font-size:12px;font-weight:600;margin:0 0 5px;color:#eef1f5"><span style="color:#6ea8ff">${it.tag}</span> ${it.title}</div><div style="border:1px solid #23272f;border-radius:8px;overflow:hidden;height:${cellH}px;background:#101215"><img src="data:image/png;base64,${it.b64}" style="display:block"></div></figure>`).join('')}</div>`;
  const rows = Math.ceil(items.length / cols), W = cols * cellW + (cols - 1) * 14 + 28, H = rows * (cellH + 14 + 24) + 28 + (title ? 0 : 0);
  await showSheet(html, W, H, file);
  say('wrote', file, `${W}x${H}`);
}
try {
  await sleep(3000);
  const TITLES = { idle: 'Fleet active — ouvrir le contrôle', douce: 'Pause douce en cours (5/7)', dure: 'Pause dure — tout est en pause (7/7)', resuming: 'Reprise en cours (3/7 repris, 3 bloqués)' };
  if (areas.includes('sidebar')) {
    for (const o of opts) {
      const items = [];
      for (const [i, k] of ['idle', 'douce', 'dure', 'resuming'].entries()) {
        await reset();
        await cdp.eval(`PM.sidebar.${o}(${JSON.stringify(k)}); true`);
        await sleep(450);
        const cw = o === 'A' ? 640 : 345;
        items.push({ tag: `${o}${i + 1}`, title: TITLES[k], b64: await shotB64({ x: 0, y: 112, width: cw, height: o === 'C' ? 470 : 440 }) });
      }
      const cw = o === 'A' ? 640 : 345;
      await sheet(`${o}-1-sidebar.png`, items, { cols: o === 'A' ? 2 : 4, cellW: cw, cellH: o === 'C' ? 470 : 440 });
    }
  }
  const openBus = async () => {
    const btn = await cdp.eval(`(() => { const b = document.querySelector('[aria-label="Open the fleet bus page"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await cdp.click(btn.x, btn.y);
    for (let i = 0; i < 40; i++) { if (await cdp.eval(`!!document.querySelector('.bus-pane[data-bus-state="available"] .bus-run-row')`)) break; await sleep(250); }
    // select the wave run (real data: its messages are the seeded ones)
    const run = await cdp.eval(`(() => { const rows = [...document.querySelectorAll('.bus-run-row')]; const r = rows.find((x) => /F1\\/F2/.test(x.textContent)); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 80, y: b.top + b.height / 2 }; })()`);
    if (run) { await cdp.click(run.x, run.y); await sleep(1200); }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 890 });
  };
  if (areas.includes('bus')) {
    for (const o of opts) {
      const items = [];
      for (const [i, k] of ['douce', 'dure', 'resuming'].entries()) {
        await reset(); await openBus();
        await cdp.eval(`PM.bus.${o}(${JSON.stringify(k)}); true`);
        await sleep(450);
        const box = await cdp.eval(`(() => { const r = document.querySelector('.pm-x[data-section="pause"]').getBoundingClientRect(); return { top: r.top, h: r.height }; })()`);
        items.push({ tag: `${o}${i + 1}`, title: { douce: 'Page Bus — Pause douce en cours', dure: 'Page Bus — Pause dure + Bilan de pause', resuming: 'Page Bus — Reprise en cours' }[k], b64: await shotB64({ x: 340, y: Math.max(0, box.top - 40), width: 1090, height: Math.min(880, box.h + 80) }), h: Math.min(880, box.h + 80) });
      }
      // stacked: 1 column, per-cell heights differ → render with auto height
      await sheetAuto(`${o}-2-bus.png`, items, 1090);
    }
  }
  if (areas.includes('refusals')) {
    for (const o of opts) {
      const items = [];
      const names = { worker: 'Clic Pause sur un worker', off: 'Switch « Pause » OFF sur la vague', covered: 'Reprendre une vague couverte par un parent', bus: 'Bus indisponible', below: 'Libérer tout : membres d\'une vague plus bas' };
      for (const [i, kd] of ['worker', 'off', 'covered', 'bus', 'below'].entries()) {
        await reset();
        const hint = await cdp.eval(`(() => { const h = PM.refusal.${o}(${JSON.stringify(kd)}); return h; })()`);
        await sleep(450);
        items.push({ tag: `${o}R${i + 1}`, title: names[kd], b64: await shotB64({ x: 0, y: hint.y, width: hint.w, height: hint.h }), h: hint.h, w: hint.w });
      }
      await sheet(`${o}-3-refusals.png`, items, { cols: o === 'A' ? 2 : 3, cellW: items[0].w, cellH: items[0].h });
    }
  }
} finally { cdp.close(); a.kill(); await sleep(1500); }
