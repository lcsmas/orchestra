// #285 follow-up (review m2) — the Settings modal's click handling, driven in a REAL browser engine (headless Chromium, no window) on the
// REAL component bundled by esbuild, with a STUBBED `window.orchestra` whose IPC latency is the variable (the real store save chain makes a
// slow IPC plausible). Arms:
//   toggle_alone — CONTROL (green on every build): the toggle pressed with NO pending edit reaches the backend — the instrument can see a click
//   slow_ipc   ★ a valid pending edit is typed in Admission, then the TOGGLE is pressed (the mousedown blurs the input → commit; the IPC takes 150 ms,
//                the press lasts 90 ms): BOTH patches must reach the backend, pair first, then the toggle — the toggle click must not be swallowed
//   fast_ipc   ★ the same gesture at 0 ms IPC / 20 ms press (the parent swallows it here too: the disable lands before the mouseup)
//   draft_kept ★ text typed in the OTHER field while the first commit is still in flight must survive that commit's echo (and commit as its own pair)
// Usage: node scripts/e2e-memory-guard-modal.mjs   (RIG_REPO=<other tree> bundles THAT tree's component — the must-FAIL run on the parent)
// SAFETY: scratch dir under ~/.cache, fresh Chromium profile, `--headless` (no window, no display), no network, nothing live touched.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(process.env.RIG_REPO ?? SELF_ROOT);
const require_ = createRequire(import.meta.url);
const BASE = path.join(os.homedir(), '.cache', 'e2e-memory-guard-modal');
if (!(BASE + path.sep).startsWith(path.join(os.homedir(), '.cache') + path.sep)) throw new Error('scratch must live under ~/.cache');
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(60); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

// ── bundle the REAL component with a stub IPC ────────────────────────────────────────────────────────────────────────
const esbuild = (() => { try { return require_('esbuild'); } catch { const g = fs.globSync?.(path.join(SELF_ROOT, 'node_modules/.pnpm/esbuild@*/node_modules/esbuild')) ?? []; if (!g.length) throw new Error('esbuild not resolvable'); return require_(g[0]); } })();
const component = path.join(REPO, 'src/renderer/components/MemoryGuardSettings.tsx');
if (!fs.existsSync(component)) throw new Error(`no component at ${component}`);
const entry = path.join(BASE, 'entry.tsx');
fs.writeFileSync(entry, `
import { createRoot } from 'react-dom/client';
import { MemoryGuardSettings } from ${JSON.stringify(component)};
const GIB = 1024 ** 3;
const q = new URLSearchParams(location.search);
const IPC_MS = Number(q.get('ipc') ?? 0);
let settings = { admissionGb: 6, criticalGb: 3, admissionEnabled: true };
const calls: any[] = [];
(window as any).__calls = calls;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const view = () => ({
  settings: { ...settings },
  snapshot: { sampled: true, measured: true, availBytes: 12 * GIB, readAt: 1, admission: 'open', admissionEnabled: settings.admissionEnabled, pause: 'none', episode: 0, pauseCycle: 0, mayReleaseOneStart: true,
    heldSince: null, pauseSince: null, admissionBytes: settings.admissionGb * GIB, criticalBytes: settings.criticalGb * GIB, releaseMarginBytes: GIB, sampleIntervalMs: 60000 },
  liveAvailBytes: 12 * GIB, totalBytes: 32 * GIB,
});
(window as any).orchestra = {
  memoryGuard: async () => view(),
  setMemoryGuard: async (patch: any) => {
    calls.push({ patch, at: Math.round(performance.now()) });
    await sleep(IPC_MS);
    const merged = { ...settings, ...patch };
    if (!(merged.criticalGb < merged.admissionGb)) return { ok: false, error: 'the critical threshold must be below the Admission threshold', view: view() };
    settings = merged;
    return { ok: true, view: view() };
  },
};
createRoot(document.getElementById('root')!).render(<MemoryGuardSettings onClose={() => {}} />);
`);
const bundle = path.join(BASE, 'bundle.js');
await esbuild.build({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(SELF_ROOT, 'node_modules')], absWorkingDir: SELF_ROOT, logLevel: 'silent', loader: { '.css': 'empty' } });
const css = fs.readFileSync(path.join(REPO, 'src/renderer/styles.css'), 'utf8');
const html = path.join(BASE, 'page.html');
fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script>${fs.readFileSync(bundle, 'utf8').replace(/<\/script>/g, '<\\/script>')}</script></body>`);

// ── headless Chromium over CDP ───────────────────────────────────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 15000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result.value; }
}
const port = await freePort();
const profile = path.join(BASE, 'profile');
const chromium = spawn('chromium-browser', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-allow-origins=*', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1000,900', 'about:blank'],
  { env: { PATH: process.env.PATH, HOME: BASE, XDG_CONFIG_HOME: path.join(BASE, 'xdg-config'), XDG_CACHE_HOME: path.join(BASE, 'xdg-cache') }, stdio: 'ignore', detached: true });
const results = [];
const clause = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); };
let cdp;
try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page') ?? null, 30000, 'a Chromium page target');
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  const SEL = { dialog: '[aria-label="Memory guard"]', adm: '[data-mg-admission]', crit: '[data-mg-critical]', toggle: '[data-mg-toggle]', title: '[aria-label="Memory guard"] h2' };
  const center = (sel) => cdp.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  const click = async (sel, holdMs = 40) => { const c = await center(sel); await mouse('mouseMoved', c.x, c.y); await mouse('mousePressed', c.x, c.y); await sleep(holdMs); await mouse('mouseReleased', c.x, c.y); };
  const typeInto = async (sel, text) => { await click(sel, 20); await cdp.eval(`document.querySelector(${JSON.stringify(sel)}).select()`); await cdp.send('Input.insertText', { text }); };
  const open = async (arm, ipc) => {
    await cdp.send('Page.navigate', { url: `${pathToFileURL(html).href}?ipc=${ipc}&arm=${arm}` });
    await waitFor(() => cdp.eval(`!!document.querySelector(${JSON.stringify(SEL.dialog)}) && !document.querySelector(${JSON.stringify(SEL.adm)}).disabled && Array.isArray(window.__calls)`), 20000, `the dialog (${arm})`);
    await sleep(200);
  };
  const J = JSON.stringify;
  const state = () => cdp.eval(`({ calls: window.__calls.map((c) => c.patch), adm: document.querySelector(${JSON.stringify(SEL.adm)}).value, crit: document.querySelector(${JSON.stringify(SEL.crit)}).value, toggle: document.querySelector(${JSON.stringify(SEL.toggle)}).checked, toggleDisabled: document.querySelector(${JSON.stringify(SEL.toggle)}).disabled, error: !!document.querySelector('[data-mg-error]') })`);

  // ── control: the toggle alone ──
  await open('toggle_alone', 0);
  { const c = await center(SEL.toggle); await mouse('mouseMoved', c.x, c.y); await mouse('mousePressed', c.x, c.y); await sleep(40); await mouse('mouseReleased', c.x, c.y); await sleep(500); const s = await state();
    clause('ctl/toggle_alone/the-toggle-click-reaches-the-backend', J(s.calls) === J([{ admissionEnabled: false }]) && s.toggle === false, `IPC calls ${J(s.calls)}, toggle ${s.toggle}`); }

  // ── slow_ipc ★ and fast_ipc ★: pending edit + toggle press ──
  for (const [arm, ipc, hold] of [['fast_ipc', 0, 20], ['slow_ipc', 150, 90]]) {
    await open(arm, ipc);
    const pre = await state();
    clause(`ctl/${arm}/dialog-is-up-with-the-defaults`, pre.adm === '6' && pre.crit === '3' && pre.toggle === true && pre.calls.length === 0, `inputs ${pre.adm}/${pre.crit}, toggle ${pre.toggle}, ${pre.calls.length} IPC calls before the gesture`);
    await typeInto(SEL.adm, '8');                    // a valid pending edit (8 / 3)
    const c = await center(SEL.toggle);              // the press that blurs the input (→ commit) and then lands on the toggle
    await mouse('mouseMoved', c.x, c.y); await mouse('mousePressed', c.x, c.y); await sleep(hold); await mouse('mouseReleased', c.x, c.y);
    await sleep(ipc * 2 + 700);
    const post = await state();
    clause(`${arm}/both-patches-reach-the-backend-in-order`, J(post.calls) === J([{ admissionGb: 8, criticalGb: 3 }, { admissionEnabled: false }]), `IPC calls: ${J(post.calls)}`);
    clause(`${arm}/toggle-ends-off-and-inputs-keep-the-pair`, post.toggle === false && post.adm === '8' && post.crit === '3' && !post.error, `toggle ${post.toggle}, inputs ${post.adm}/${post.crit}, error row ${post.error}`);
  }

  // ── draft_kept ★: typing in the OTHER field while the first commit is in flight ──
  await open('draft_kept', 300);
  await typeInto(SEL.adm, '8');
  await click(SEL.title, 20);                        // blur → commit #1 (8/3), 300 ms in flight
  await sleep(80);
  await typeInto(SEL.crit, '2.5');                   // typed while #1 is still in flight
  await sleep(700);                                  // #1's echo has arrived
  const mid = await state();
  clause('draft_kept/typed-text-survives-the-echo', mid.crit === '2.5' && mid.adm === '8', `after the first echo the inputs read ${mid.adm}/${mid.crit} (typed 8 then 2.5)`);
  await click(SEL.title, 20);                        // blur → commit #2 (8/2.5)
  await sleep(900);
  const end = await state();
  clause('draft_kept/second-pair-commits-as-its-own-patch', J(end.calls) === J([{ admissionGb: 8, criticalGb: 3 }, { admissionGb: 8, criticalGb: 2.5 }]) && end.crit === '2.5', `IPC calls ${J(end.calls)}; inputs ${end.adm}/${end.crit}`);
} catch (e) {
  clause('rig/completed', false, `ABORTED: ${e.stack || e}`);
} finally {
  try { cdp?.ws.close(); } catch {}
  try { process.kill(-chromium.pid, 'SIGKILL'); } catch {}
}
const red = results.filter((r) => !r.ok);
console.log(`\nMODAL RIG: ${red.length === 0 ? `ALL GREEN (${results.length} clauses)` : `RED ${red.map((r) => r.name).join(', ')}`} · tree ${REPO}`);
process.exit(red.length === 0 ? 0 : 1);
