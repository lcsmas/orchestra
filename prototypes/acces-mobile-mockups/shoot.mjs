// Screenshots every generated screen at 390×844 @3x with a purely headless
// Chromium driven over CDP (no window, no compositor, no display env).
// usage: node shoot.mjs [variant-dir ...]    (default: all variants)
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/usr/bin/chromium-browser';
const variants = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(ROOT).filter((d) => /^v\d/.test(d)).sort();

// Allow-list env: nothing from the human's session (DISPLAY / WAYLAND_DISPLAY) reaches Chromium.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };
const profile = mkdtempSync(join(tmpdir(), 'mockups-chrome-'));
const child = spawn(CHROME, [
  '--headless=new', '--ozone-platform=headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
  '--allow-file-access-from-files', 'about:blank',
], { env, stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('chromium did not announce a DevTools URL:\n' + buf)), 20000);
  child.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
  child.on('exit', (c) => reject(new Error('chromium exited early: ' + c + '\n' + buf)));
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map(); const listeners = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  else listeners.forEach((l) => l(m));
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cdp = (m, p) => send(m, p, sessionId);
await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

const ev = async (expression) => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
let bad = 0, total = 0;
try {
  for (const v of variants) {
    const outDir = join(ROOT, 'screenshots', v);
    mkdirSync(outDir, { recursive: true });
    for (const f of readdirSync(join(ROOT, v)).filter((x) => /^\d\d-.*\.html$/.test(x)).sort()) {
      const loaded = new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) r(); }; listeners.push(l); });
      await cdp('Page.navigate', { url: pathToFileURL(join(ROOT, v, f)).href });
      await loaded;
      await ev('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))');
      const probe = await ev(`JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
        sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
        fonts: [...document.fonts].reduce((a, f) => (a[f.status] = (a[f.status] || 0) + 1, a), {}),
        overflowX: [...document.querySelectorAll('.phone *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > 390.5) && getComputedStyle(e).position !== 'absolute'; }).slice(0, 3).map((e) => e.className || e.tagName) })`);
      const p = JSON.parse(probe);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const png = Buffer.from(data, 'base64');
      const W = png.readUInt32BE(16), H = png.readUInt32BE(20);
      const ok = p.w === 390 && p.h === 844 && p.dpr === 3 && W === 1170 && H === 2532 && !p.fonts.error && (p.fonts.loaded || 0) > 0 && p.sh <= 844 && p.sw <= 390 && p.overflowX.length === 0;
      total++; if (!ok) bad++;
      writeFileSync(join(outDir, f.replace(/\.html$/, '.png')), png);
      console.log(`${ok ? 'OK ' : 'BAD'} ${v}/${f}  png=${W}x${H} ${(png.length / 1024) | 0}KB  vp=${p.w}x${p.h}@${p.dpr}  fonts=${JSON.stringify(p.fonts)}${ok ? '' : '  ' + probe}`);
    }
  }
} finally {
  try { await send('Browser.close'); } catch {}
  const exited = new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  rmSync(profile, { recursive: true, force: true });
}
console.log(`${bad ? 'DIRTY' : 'CLEAN'}: ${total - bad}/${total} screens ok`);
process.exit(bad ? 1 : 0);
