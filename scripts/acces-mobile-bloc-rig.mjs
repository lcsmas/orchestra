// #421 — Accès mobile bloc HTML, on a real headless Chromium in iPhone emulation against the REAL server entry (src/acces-mobile/index.ts,
// fd-3 channel played by this script) behind a `tailscale serve` stand-in that sets the identity on EVERY request (frames included).
// Fixed tree: the bloc renders (DOM + pixel), reaches neither the API nor an external listener, the route is identity + id only,
// the service worker holds nothing of it, regenerate / setting off / a re-render. Then each isolation clause is REMOVED in a scratch
// copy of the tree and must go RED through the SAME drive (policy → the listener is reached; sandbox → the token is read and the API
// answers; shell frame-src → the navigation reaches the listener). Prints CLEAN/DIRTY; exit 0 only on CLEAN.
// Usage: node --experimental-strip-types scripts/acces-mobile-bloc-rig.mjs [--out <dir>]   (via scripts/acces-mobile-bloc-rig.sh)
import { spawn } from 'node:child_process';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { GIF, PROBES, PROBES_BLOCKED, PROBES_HTTPS, blocReply } from './acces-mobile-bloc-probe.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const CHROMIUM = flag('--chromium', '/usr/bin/chromium-browser');
const SCRATCH = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'bloc-rig-'));
const OUT = flag('--out', path.join(SCRATCH, 'shots'));
fs.mkdirSync(OUT, { recursive: true });
const { serveRpc } = await import(path.join(REPO, 'src/shared/acces-mobile-rpc.ts'));

const LOGIN = 'rig.owner@example.invalid';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const clause = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); };
async function waitFor(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(150); } }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.method && this.on) this.on(m); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result.value; }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}


/** The network track's rig-only cert (scripts/fixtures/bloc-html-rig.*.pem, SAN 127.0.0.1): the stand-in and the https listener serve it, Chromium trusts ONLY its SPKI. */
function makeCert() {
  const FIX = path.join(REPO, 'scripts/fixtures');
  const cert = fs.readFileSync(path.join(FIX, 'bloc-html-rig.cert.pem'));
  return { key: fs.readFileSync(path.join(FIX, 'bloc-html-rig.key.pem')), cert, spki: crypto.createHash('sha256').update(new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64') };
}
const insecure = new https.Agent({ rejectUnauthorized: false }); // the rig's own requests to its own stand-in

/** The stand-in for `tailscale serve`: TCP → the server's unix socket, the identity set on EVERY request (the bloc's frame included). */
function serveProxy(getSock, lines, cred) {
  const srv = https.createServer(cred, (inReq, inRes) => {
    const headers = Object.fromEntries(Object.entries(inReq.headers).filter(([k]) => !k.toLowerCase().startsWith('tailscale-user-')));
    headers['tailscale-user-login'] = LOGIN;
    const line = { method: inReq.method, url: inReq.url, auth: !!inReq.headers.authorization, ref: inReq.headers.referer ?? '', dest: String(inReq.headers['sec-fetch-dest'] ?? ''), status: null };
    lines.push(line);
    const out = http.request({ socketPath: getSock(), path: inReq.url, method: inReq.method, headers }, (r) => { line.status = r.statusCode; inRes.writeHead(r.statusCode, r.headers); r.pipe(inRes); r.on('close', () => { if (!r.complete) inRes.destroy(); }); });
    out.on('error', () => { line.status = 502; inRes.writeHead(502); inRes.end(); });
    inReq.pipe(out);
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}
/** The listener a leak would reach: logs every hit (HTTP and WebSocket upgrade). */
function listener(cred) {
  const hits = [], hitsS = [];
  const handler = (log) => (req, res) => { log.push(req.url); res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': req.url.includes('.gif') ? 'image/gif' : 'text/html' }); res.end(req.url.includes('.gif') ? GIF : '<title>external</title>ok'); };
  const srv = http.createServer(handler(hits)), srvS = https.createServer(cred, handler(hitsS));
  srv.on('upgrade', (req, sock) => { hits.push(req.url); sock.destroy(); });
  srvS.on('upgrade', (req, sock) => { hitsS.push(req.url); sock.destroy(); });
  return Promise.all([new Promise((res) => srv.listen(0, '127.0.0.1', res)), new Promise((res) => srvS.listen(0, '127.0.0.1', res))]).then(() => ({ srv, srvS, port: srv.address().port, portS: srvS.address().port, hits, hitsS }));
}

/** A scratch copy of the code under test (the entry runs from TS), with `mut` applied to a file — the unfixed arm of one clause. */
function treeFor(name, mut) {
  if (!mut) return REPO;
  const dir = path.join(SCRATCH, 'tree-' + name);
  for (const d of ['src/acces-mobile', 'src/shared']) fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  for (const [file, from, to] of mut) {
    const p = path.join(dir, file); const s = fs.readFileSync(p, 'utf8');
    if (!s.includes(from)) throw new Error(`mutant ${name}: string not found in ${file}: ${from}`); // the mutant string is verified live
    fs.writeFileSync(p, s.replace(from, to));
  }
  return dir;
}

async function drive(label, tree, opts = {}) {
  const dir = path.join(SCRATCH, 'run-' + label); fs.mkdirSync(dir, { mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const sock = path.join(dir, 'am.sock'), tokenFile = path.join(dir, 'token');
  const TOKEN = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  const cred = makeCert();
  const ext = await listener(cred);
  const state = { enabled: true, version: 1, text: blocReply(`http://127.0.0.1:${ext.port}`, `https://127.0.0.1:${ext.portS}`), pushers: [] };
  const lines = [];
  const proxy = await serveProxy(() => sock, lines, cred);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(tree, 'src/acces-mobile/index.ts')], { env: { PATH: process.env.PATH ?? '', ACCES_MOBILE_SOCKET: sock, ACCES_MOBILE_LOGIN: LOGIN, ACCES_MOBILE_TOKEN_FILE: tokenFile }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (err += c));
  const ch = child.stdio[3]; ch.on('error', () => {});
  const conversation = () => ({ ok: true, id: 'w1', version: state.version, running: false, truncated: 0, asks: [], blocHtml: state.enabled, lines: [{ id: 'u1', kind: 'user', text: 'montre-moi une courbe' }, { id: 'a1', kind: 'assistant', text: state.text, streaming: false }] });
  serveRpc(ch, {
    call: async (route) => {
      if (route === '/mobile/workspaces') return { ok: true, app: { version: '0', startedAt: 1 }, workspaces: [{ id: 'w1', name: 'rig · bloc', displayName: 'bloc', branch: 'main', group: 'rig', account: 'perso', status: 'idle', unread: false, at: Date.now(), preview: null }] };
      if (route === '/mobile/conversation') return conversation();
      if (route === '/mobile/bloc-enabled') return { ok: true, enabled: state.enabled };
      return { ok: true };
    },
    stream: (route, push) => { if (route !== '/mobile/stream') return null; state.pushers.push(push); push({ t: 'ping' }); return () => state.pushers.splice(state.pushers.indexOf(push), 1); },
  });
  await waitFor(() => out.includes('listening '), 15000, `server (${err})`);
  const chromeDir = path.join(dir, 'chromium'); fs.mkdirSync(chromeDir);
  const cport = 20000 + Math.floor(Math.random() * 20000);
  const chrome = spawn(CHROMIUM, ['--headless=new', `--remote-debugging-port=${cport}`, `--user-data-dir=${chromeDir}`, '--no-first-run', '--no-default-browser-check', `--ignore-certificate-errors-spki-list=${cred.spki}`, 'about:blank'], { env: { PATH: process.env.PATH ?? '', HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'xdg'), XDG_CACHE_HOME: path.join(dir, 'xdgc') }, stdio: 'ignore', detached: true });
  const ev = { label };
  let phone;
  try {
    const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${cport}/json`)).json()).find((x) => x.type === 'page') || null, 30000, 'chromium page');
    phone = await Cdp.connect(target.webSocketDebuggerUrl);
    const ctxs = new Map(); // frameId → main-world execution context (a same-origin frame has no target of its own)
    phone.on = (m) => { if (m.method === 'Runtime.executionContextCreated' && m.params.context.auxData?.isDefault) ctxs.set(m.params.context.auxData.frameId, m.params.context.id); };
    await phone.send('Page.enable'); await phone.send('Runtime.enable');
    await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await phone.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    await phone.send('Page.navigate', { url: `https://127.0.0.1:${proxy.port}/#t=${TOKEN}` });
    await waitFor(() => phone.eval(`document.querySelectorAll('li[data-id]').length >= 1`), 20000, 'the list');
    await phone.eval(`location.hash = 'w=w1'; 0`);
    await waitFor(() => phone.eval(`!!document.querySelector('#conv .conv-lines [data-kind="assistant"]')`), 20000, 'the conversation');
    ev.hasFrame = await waitFor(() => phone.eval(`!!document.querySelector('#conv iframe.bloc-frame')`).catch(() => false), opts.noFrame ? 4000 : 20000, 'the bloc frame').catch(() => false);
    if (ev.hasFrame) {
      // the frame is its own target when Chromium isolates it (opaque origin): read it there
      // the frame is its own target when Chromium isolates it (opaque origin): read it there. A same-origin frame (the no-sandbox mutant)
      // has no target of its own — it is read through the shell's DOM, which is itself the hole that arm measures.
      const ftarget = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${cport}/json`)).json()).find((x) => x.type === 'iframe' && x.url.includes('/bloc/')) || null, 3500, 'the frame target').catch(() => null); // the delayed navigations fire at 5 s, so the reads below must finish before
      const childFrame = async () => (await phone.send('Page.getFrameTree')).frameTree.childFrames?.[0]?.frame.id;
      const fr = ftarget ? await Cdp.connect(ftarget.webSocketDebuggerUrl) : { eval: async (x) => { const r = await phone.send('Runtime.evaluate', { expression: x, contextId: ctxs.get(await childFrame()), returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval threw'); return r.result.value; }, close() {} };
      ev.isolatedTarget = !!ftarget;
      try {
        ev.probes = await waitFor(async () => { const p = await fr.eval(`window.__probe ? JSON.stringify(window.__probe) : null`).catch(() => null); const o = p && JSON.parse(p); return o && PROBES.every((k) => k in o) ? o : null; }, 15000, 'the probes settled').catch(() => null);
        ev.inFrame = await fr.eval(`(() => { const c = document.getElementById('card'), b = document.getElementById('bar'); const br = b.getBoundingClientRect(); return { text: document.getElementById('v').textContent, bg: getComputedStyle(c).backgroundColor, bar: { x: br.left + br.width / 2, y: br.top + br.height / 2 }, docH: Math.ceil(document.documentElement.getBoundingClientRect().height), scheme: getComputedStyle(document.documentElement).colorScheme } })()`).catch(() => null);
      } finally { fr.close(); }
    ev.page = await phone.eval(`(() => { const f = document.querySelector('#conv iframe.bloc-frame'), r = f.getBoundingClientRect(); const ps = [...document.querySelectorAll('#conv .msg.assistant p')]; const before = ps.find((p) => p.textContent.includes('Voici')), after = ps.find((p) => p.textContent.includes('Voilà')); return { src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox'), title: f.getAttribute('title'), rect: { x: r.left, y: r.top, w: r.width, h: r.height }, styleH: f.style.height, state: f.parentNode.dataset.state, beforeBottom: before && before.getBoundingClientRect().bottom, afterTop: after && after.getBoundingClientRect().top, vw: innerWidth, scrollY } })()`);
      // an assertion on the image: the accent bar's pixel in the screenshot (device px = css px × 3)
      await phone.eval(`document.querySelector('#conv iframe.bloc-frame').scrollIntoView({block:'center'}); 0`); await sleep(400);
      const shotRect = await phone.eval(`(() => { const r = document.querySelector('#conv iframe.bloc-frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
      const png = await phone.shot();
      fs.writeFileSync(path.join(OUT, `phone-bloc-${label}.png`), png);
      if (ev.inFrame) { const img = PNG.sync.read(png); const px = Math.round((shotRect.x + ev.inFrame.bar.x) * 3), py = Math.round((shotRect.y + ev.inFrame.bar.y) * 3); const i = (img.width * py + px) * 4; ev.pixel = [img.data[i], img.data[i + 1], img.data[i + 2]]; }
    }
    await sleep(opts.settleMs ?? 6500); // the delayed navigations (5 s / 5.2 s) have fired
    ev.extHits = [...ext.hits]; ev.extsHits = [...ext.hitsS];
    ev.proxyProbeLines = lines.filter((l) => l.url.includes('probe=bloc')).map((l) => `${l.method} ${l.url} → ${l.status}`);
    ev.proxyProbeRaw = lines.filter((l) => l.url.includes('probe=bloc'));
    ev.shellUrl = await phone.eval(`location.href`).catch(() => null);
    ev.frameLines = lines.filter((l) => l.url.startsWith('/bloc/'));
    ev.tokenLeaked = lines.some((l) => l.url.includes(TOKEN));
    ev.ctx = { TOKEN, tokenFile, sock, proxy, lines, state, phone, ext, child, dir };
    return ev;
  } catch (e) { ev.error = String(e.message ?? e); ev.ctx = { TOKEN, tokenFile, sock, proxy, lines, state, phone, ext, child, dir }; return ev; }
  finally { ev.close = () => { phone?.close(); try { process.kill(-chrome.pid, 'SIGKILL'); } catch {} try { child.kill('SIGKILL'); } catch {} proxy.srv.closeAllConnections?.(); proxy.srv.close(); for (const x of [ext.srv, ext.srvS]) { x.closeAllConnections?.(); x.close(); } }; }
}
const get = (port, p, headers = {}) => new Promise((resolve, reject) => { https.get({ host: '127.0.0.1', port, path: p, headers, agent: insecure }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, body: b })); }).on('error', reject); });
const allBlocked = (p) => p && PROBES_BLOCKED.filter((k) => k !== 'beacon-ext').every((k) => /^(blocked:|no-token|empty|null$)/.test(p[k] ?? 'missing'));
const near = (a, b, t = 6) => a && a.every((v, i) => Math.abs(v - b[i]) <= t);
const ACCENT = [110, 168, 255], SURFACE = 'rgb(26, 31, 38)';

let completed = false;
try {
  // ── fixed tree ──
  console.log('== fixed tree ==');
  const F = await drive('fixed', REPO);
  if (F.error) console.log(`  ERROR ${F.error}`);
  clause('bloc/rendered-between-prose', F.hasFrame && F.page?.state === 'ready' && F.inFrame?.text === 'bloc-ran' && F.page.beforeBottom <= F.page.rect.y + 1 && F.page.rect.y + F.page.rect.h <= F.page.afterTop + 1, `iframe ${F.page?.src} state ${F.page?.state}, script ran « ${F.inFrame?.text} », prose ends ${F.page?.beforeBottom} ≤ frame top ${F.page?.rect.y}, frame bottom ${F.page && F.page.rect.y + F.page.rect.h} ≤ next prose ${F.page?.afterTop}`);
  clause('bloc/sized-to-content-on-phone', F.page && F.inFrame && F.page.rect.w >= 300 && F.page.rect.w <= F.page.vw && F.page.rect.h >= 40 && F.page.rect.h < 600 && Math.abs(F.page.rect.h - F.inFrame.docH) <= 2, `390 px phone: frame ${F.page?.rect.w}×${F.page?.rect.h}, its document is ${F.inFrame?.docH} high`);
  clause('bloc/themed-and-painted', F.inFrame?.bg === SURFACE && near(F.pixel, ACCENT) && !F.inFrame?.scheme?.includes('dark'), `var(--bloc-surface) ⇒ ${F.inFrame?.bg}; the accent bar's PIXEL in the screenshot ${JSON.stringify(F.pixel)} vs ${JSON.stringify(ACCENT)}; frame color-scheme « ${F.inFrame?.scheme} » (never declared)`);
  clause('bloc/frame-attrs', F.page?.sandbox === 'allow-scripts' && F.page?.title === 'Courbe' && /^\/bloc\/[A-Za-z0-9_-]{32}$/.test(F.page?.src ?? ''), `sandbox="${F.page?.sandbox}" title="${F.page?.title}" src ${F.page?.src}`);
  const apiLines = F.proxyProbeRaw ?? [];
  clause('bloc/http-refused-isolated-api-needs-token', allBlocked(F.probes) && F.extHits.length === 0 && apiLines.length >= 1 && apiLines.every((l) => l.status === 401 && l.auth === false) && !F.tokenLeaked, `plain http / ws / parent DOM / cookie / localStorage / popup all refused: ${JSON.stringify(F.probes)}; http listener hits ${JSON.stringify(F.extHits)}; the https same-origin request to the API REACHED the server (policy v2) and was answered ${JSON.stringify(apiLines.map((l) => `${l.status}${l.auth ? ' +Authorization' : ' no Authorization'}`))} — nothing without the token; token in any request line ${F.tokenLeaked}`);
  clause('bloc/https-network-works', F.probes?.['fetch-https'] === 'reached' && F.probes?.['img-https'] === 'reached' && ['/fetch-https', '/img-https.gif', '/wss-https'].every((u) => F.extsHits.includes(u)), `https fetch + image ⇒ ${F.probes?.['fetch-https']} / ${F.probes?.['img-https']}; the https listener saw ${JSON.stringify(F.extsHits)} (wss upgrade included)`);
  clause('bloc/navigation-and-popups-stay-inside', F.extHits.every((h) => !/nav-ext|top-nav|popup/.test(h)) && F.shellUrl?.startsWith(`https://127.0.0.1:${F.ctx.proxy.port}/`), `no hit for nav / top-nav / popup; the shell is still ${F.shellUrl}`);
  clause('bloc/route-identity-and-id-only', F.frameLines.length === 1 && F.frameLines[0].status === 200 && F.frameLines[0].auth === false && F.frameLines[0].dest === 'iframe', `${F.frameLines.length} request(s) for the bloc: ${JSON.stringify(F.frameLines)} — one load, no Authorization header, Sec-Fetch-Dest iframe`);
  const id = F.page?.src?.slice('/bloc/'.length);
  const px = F.ctx.proxy.port;
  // headers on the wire: the route's own, the shell's unchanged
  const route = await new Promise((res) => https.get({ host: '127.0.0.1', port: px, path: F.page?.src, agent: insecure }, (r) => { r.resume(); r.on('end', () => res(r.headers)); }));
  const shell = await new Promise((res) => https.get({ host: '127.0.0.1', port: px, path: '/', agent: insecure }, (r) => { r.resume(); r.on('end', () => res(r.headers)); }));
  clause('bloc/route-own-headers-shell-unchanged', /^sandbox allow-scripts;/.test(route['content-security-policy'] ?? '') && route['x-frame-options'] === undefined && route['cache-control'] === 'no-store' && shell['content-security-policy'] === "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" && shell['x-frame-options'] === 'DENY', `route CSP « ${route['content-security-policy']} »; shell CSP + X-Frame-Options ${shell['x-frame-options']} as before`);
  const sw = await F.ctx.phone.eval(`(async () => { await navigator.serviceWorker.ready.catch(() => 0); const keys = await caches.keys(); const paths = []; for (const k of keys) for (const r of await (await caches.open(k)).keys()) paths.push(new URL(r.url).pathname); return { controlled: !!navigator.serviceWorker.controller, paths, hit: !!(await caches.match(${JSON.stringify(F.page?.src)})) }; })()`).catch((e) => ({ err: String(e) }));
  clause('bloc/service-worker-does-not-cache-route', sw.paths && sw.paths.length > 0 && !sw.paths.some((p) => p.startsWith('/bloc/')) && sw.hit === false, `Cache Storage ${JSON.stringify(sw.paths)} (control: the shell IS cached), caches.match(route) ${sw.hit}`);
  // a re-render (the stream announces a new version) does not reload the frame
  const mark = await F.ctx.phone.eval(`(() => { document.querySelector('#conv iframe.bloc-frame').__mark = 'same'; return true; })()`);
  F.ctx.state.version = 2; F.ctx.state.text += '\n\nEt encore une phrase.';
  F.ctx.state.pushers.forEach((p) => p({ t: 'conv', id: 'w1', v: 2 }));
  await waitFor(() => F.ctx.phone.eval(`document.querySelector('#conv .conv-lines').textContent.includes('Et encore une phrase')`), 15000, 're-render');
  const kept = await F.ctx.phone.eval(`({ same: document.querySelector('#conv iframe.bloc-frame')?.__mark === 'same', frames: document.querySelectorAll('#conv iframe').length })`);
  const loads = F.ctx.lines.filter((l) => l.url.startsWith('/bloc/') && l.dest === 'iframe').length;
  clause('bloc/rerender-keeps-the-frame', mark && kept.same && kept.frames === 1 && loads === 1, `after a new version with more prose: same iframe element ${kept.same}, ${kept.frames} frame, ${loads} browser load of the route in all (a reload would make 2)`);
  // setting off: the live id serves nothing, and the page draws a code block; on again ⇒ the frame is back (control)
  F.ctx.state.enabled = false;
  const offRoute = await get(px, `/bloc/${id}`);
  await F.ctx.phone.eval(`location.reload(); 0`);
  await waitFor(() => F.ctx.phone.eval(`!!document.querySelector('#conv .bloc-code')`), 20000, 'the code block').catch(() => 0);
  const off = await F.ctx.phone.eval(`({ frames: document.querySelectorAll('#conv iframe').length, code: !!document.querySelector('#conv .bloc-code pre'), text: ((document.querySelector('#conv .bloc-code pre') || {}).textContent || '').includes('bloc-ran') })`).catch((e) => ({ err: String(e) }));
  fs.writeFileSync(path.join(OUT, 'phone-bloc-setting-off.png'), await F.ctx.phone.shot());
  F.ctx.state.enabled = true;
  await F.ctx.phone.eval(`location.reload(); 0`);
  const backSrc = await waitFor(() => F.ctx.phone.eval(`(document.querySelector('#conv iframe.bloc-frame') || {}).src || null`), 20000, 'the frame again').catch(() => null);
  clause('bloc/setting-off-code-block', offRoute.status === 404 && off.frames === 0 && off.code && off.text && !!backSrc, `live id with the setting off ⇒ ${offRoute.status}; page: ${off.frames} frame, code block ${off.code} holding the source ${off.text}; control: setting on again ⇒ frame ${backSrc ? 'back' : 'MISSING'}`);
  // regenerate the token: the live id dies at once
  const id2 = new URL(backSrc ?? 'http://x/').pathname.slice('/bloc/'.length);
  const aliveBefore = await get(px, `/bloc/${id2}`);
  fs.writeFileSync(F.ctx.tokenFile, crypto.randomBytes(32).toString('base64url') + '\n');
  const afterRegen = await get(px, `/bloc/${id2}`);
  clause('bloc/refused-after-token-regenerated', aliveBefore.status === 200 && afterRegen.status === 404 && afterRegen.body === '', `before ${aliveBefore.status}, after the token file changed ${afterRegen.status} (empty body)`);
  // no identity / unknown id, straight at the socket (what serve would not forward)
  const rawGet = (p, headers) => new Promise((resolve, reject) => { http.get({ socketPath: F.ctx.sock, path: p, headers }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).on('error', reject); });
  const fresh = await new Promise((res) => { const tok = fs.readFileSync(F.ctx.tokenFile, 'utf8').trim(); const rq = http.request({ socketPath: F.ctx.sock, path: '/api/bloc', method: 'POST', headers: { 'Tailscale-User-Login': LOGIN, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b).id)); }); rq.end(JSON.stringify({ source: '<p>x</p>' })); });
  const noId = await rawGet(`/bloc/${fresh}`, {}), unknown = await rawGet(`/bloc/${'A'.repeat(32)}`, { 'Tailscale-User-Login': LOGIN }), ok = await rawGet(`/bloc/${fresh}`, { 'Tailscale-User-Login': LOGIN });
  clause('bloc/refused-no-identity-unknown-id', noId === 403 && unknown === 404 && ok === 200, `no identity ⇒ ${noId}, unknown id ⇒ ${unknown}; control (identity + a fresh id) ⇒ ${ok}`);
  F.close();

  // ── must-FAIL arms: remove one clause in a scratch copy, same drive ──
  console.log('== must-FAIL arms (the clause removed) ==');
  const ARMS = [
    // the route header and the document's <meta> both derive from BLOC_HTML_POLICY: replace that one constant by an allow-everything policy
    { name: 'policy-http', mut: [['src/shared/bloc-html-document.ts', 'export const BLOC_HTML_POLICY =', "export const BLOC_HTML_POLICY = \"default-src * 'unsafe-inline' data: blob:; base-uri 'none'; form-action 'none'\"; const _original ="]],
      check: (e) => e.extHits.some((h) => /fetch-ext|img-ext|xhr-ext|ws-ext/.test(h)), what: 'a policy that allows http reaches the plain-http listener' },
    { name: 'policy-nohttps', mut: [['src/shared/bloc-html-document.ts', 'connect-src https: wss: data: blob:', 'connect-src data: blob:'], ['src/shared/bloc-html-document.ts', 'img-src https: data: blob:', 'img-src data: blob:']],
      check: (e) => e.extsHits.length === 0 && /^blocked/.test(e.probes?.['fetch-https'] ?? 'x') && /^blocked/.test(e.probes?.['img-https'] ?? 'x'), what: 'a policy WITHOUT https: stops the https request the must-PASS clause needs (that clause would go red)' },
    { name: 'sandbox', mut: [['src/acces-mobile/bloc-route.ts', 'sandbox allow-scripts; ${BLOC_HTML_POLICY}', '${BLOC_HTML_POLICY}'], ['src/acces-mobile/conversation.ts', "f.setAttribute('sandbox', 'allow-scripts'); ", '']],
      check: (e) => /^read:/.test(e.probes?.storage ?? '') && /^\d+$/.test(e.probes?.['parent-doc'] ?? '') && e.proxyProbeLines.some((l) => l.includes('probe=bloc-token') && l.endsWith('→ 200')), what: 'a SAME-ORIGIN frame (no sandbox) reads the shell\'s token and DOM, and the API ANSWERS 200 to it' },
    { name: 'shell-frame-src', mut: [['src/acces-mobile/server.ts', "form-action 'none'\",\n};", "form-action 'none'; frame-src *\",\n};"]],
      check: (e) => e.extHits.some((h) => /nav-ext/.test(h)), what: 'a shell that admits frames to any origin lets the bloc navigate out to the listener' },
  ];
  for (const a of ARMS) {
    const tree = treeFor(a.name, a.mut);
    const E = await drive('mut-' + a.name, tree, { settleMs: 6500 });
    if (E.error) console.log(`  ERROR ${E.error}`);
    clause(`must-FAIL/${a.name}`, E.hasFrame && a.check(E), `${a.what}: probes ${JSON.stringify(E.probes)}; listener hits ${JSON.stringify(E.extHits)} / https ${JSON.stringify(E.extsHits)}; API lines ${JSON.stringify(E.proxyProbeLines)}`);
    E.close();
  }
  completed = true;
} finally {
  const bad = results.filter((r) => !r.ok);
  if (!results.length || !completed) bad.push({ name: 'rig-did-not-run-to-the-end' }); // an empty or aborted run is never CLEAN
  console.log(`${bad.length ? 'DIRTY' : 'CLEAN'}: ${results.length - bad.length}/${results.length} clauses PASS${bad.length ? ' — FAIL: ' + bad.map((b) => b.name).join(', ') : ''}; shots in ${OUT}`);
  process.exitCode = bad.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 500).unref();
}
