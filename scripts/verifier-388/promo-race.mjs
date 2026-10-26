// Verifier (seat 1, #400 node half): MY OWN interleavings of the session-cookie promotion (persistSignIns in src/main/browser-panel.ts) over the member's own electron stub
// (extracted from src/main/browser-panel-profiles.test.ts at run time so the stub cannot drift from the repo). The stub cannot model the network service: these arms pin what the
// PRODUCT LOGIC does for a given delivery order, not what Chromium does. usage: node --no-warnings --experimental-strip-types promo-race.mjs <repo>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2]);
const src = fs.readFileSync(path.join(root, 'src/main/browser-panel-profiles.test.ts'), 'utf8');
const a = src.indexOf('const STUB = `'), b = src.indexOf('const bp = await import');
if (a < 0 || b < 0) throw new Error('cannot extract the stub from the member test');
const gen = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'promo-')), 'harness.mjs');
fs.writeFileSync(gen, `import { register } from 'node:module';\nimport { pathToFileURL } from 'node:url';\n${src.slice(a, b)}\nexport const bp = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/browser-panel.ts')).href)});\nexport const sessions = () => globalThis.__bpSessions;\n`);
const H = await import(pathToFileURL(gen).href);
const bp = H.bp;
const attached = new Set(); const saved = new Map();
bp.initBrowserPanels(() => ({ contentView: { addChildView: (v) => attached.add(v), removeChildView: (v) => attached.delete(v) } }), { load: (ws) => saved.get(ws) ?? null, save: (ws, t) => void (t === null ? saved.delete(ws) : saved.set(ws, t)), flush() {} });
const PR = new Map(); bp.setBrowserProfileResolver((ws) => PR.get(ws));
const P = (n) => `bp-${String(n).padStart(12, '0')}`;
const PART = (id) => `persist:orchestra-profile-${id}`;
let bad = 0, ok = 0, info = 0;
const row = (id, pass, label, detail = '') => { if (pass === null) { info++; console.log(`${id.padEnd(4)} INFO ${label}${detail ? ` | ${detail}` : ''}`); return; } if (pass) ok++; else bad++; console.log(`${id.padEnd(4)} ${pass ? 'OK  ' : 'BAD '} ${label}${detail ? ` | ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unhandled = []; process.on('unhandledRejection', (e) => unhandled.push(String(e)));
let wsn = 0;
const open = (profile) => { const ws = `ws-race-${++wsn}`; PR.set(ws, profile); bp.ensurePanel(ws); const ses = H.sessions().get(PART(profile)); ses.cookieSets = undefined; ses.cookieGets = undefined; ses.liveCookies = undefined; ses.getGate = undefined; ses.cookieRemoves = undefined; ses.cookies.remove = (u, n) => { (ses.cookieRemoves ??= []).push([u, n]); return Promise.resolve(); }; return { ws, ses }; };
const ev = (ses, cookie, removed = false) => { for (const [, fn] of [...ses.cookieListeners]) fn({}, cookie, 'explicit', removed); };
const C = (over = {}) => ({ name: 'sid', value: 'v0', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: false, session: true, sameSite: 'unspecified', ...over });
const gate = (ses) => { let rel; ses.getGate = new Promise((r) => (rel = r)); return () => { ses.getGate = undefined; rel(); }; };

// R1 control
{ const { ses } = open(P(1)); ses.liveCookies = [C({ value: 'live' })]; ev(ses, C()); await sleep(450); row('R1', ses.cookieSets?.length === 1 && ses.cookieSets[0].value === 'live', 'CONTROL: one promotion of the LIVE value after the debounce', JSON.stringify(ses.cookieSets?.map((d) => d.value))); }
// R2 a removal DELIVERED after the write was issued: the product has no way to know, and no compensating remove
{ const { ses } = open(P(2)); ses.liveCookies = [C()]; const rel = gate(ses); ev(ses, C()); await sleep(300); ev(ses, C(), true); /* removal while the read is in flight: cancels (member F4B) */ rel(); await sleep(300);
  const cancelled = ses.cookieSets === undefined;
  // now the order the product cannot see: read returns, the write is ISSUED, and only THEN the removal event is delivered
  const q = open(P(3)); q.ses.liveCookies = [C({ name: 'late' })]; const rel2 = gate(q.ses); ev(q.ses, C({ name: 'late' })); await sleep(300); rel2(); await sleep(50);
  const wrote = q.ses.cookieSets?.length === 1; ev(q.ses, C({ name: 'late' }), true); await sleep(300);
  row('R2', cancelled && wrote && q.ses.cookieRemoves === undefined, 'a removal delivered AFTER the write was issued is never compensated (no post-write check, no remove): the read→write window is a TOCTOU the main process cannot close', `event-before-write cancelled=${cancelled}; removal-after-write: wrote=${wrote} removes=${JSON.stringify(q.ses.cookieRemoves ?? null)}`); }
// R3 rotation storm: values written must never go BACKWARDS
{ const { ses } = open(P(4)); const seen = []; ses.cookies.set = (d) => { seen.push(d.value); (ses.cookieSets ??= []).push(d); return Promise.resolve(); };
  for (let i = 0; i < 300; i++) { ses.liveCookies = [C({ value: `n${String(i).padStart(4, '0')}` })]; ev(ses, C({ value: `n${String(i).padStart(4, '0')}` })); if (i % 7 === 0) await sleep(40); }
  await sleep(900); const mono = seen.every((v, i) => i === 0 || seen[i - 1] <= v); row('R3', seen.length > 0 && mono && seen[seen.length - 1] === 'n0299', 'rotation storm of 300 values: promoted values are monotone and the LAST one wins', `sets=${seen.length} first=${seen[0]} last=${seen[seen.length - 1]}`); }
// R4 independent keys do not cancel each other while a read is in flight; two profiles are isolated
{ const { ses } = open(P(5)); ses.liveCookies = [C({ name: 'A' }), C({ name: 'B' })]; const rel = gate(ses); ev(ses, C({ name: 'A' })); await sleep(300); ev(ses, C({ name: 'B' })); rel(); await sleep(700);
  const names = (ses.cookieSets ?? []).map((d) => d.name).sort(); const o = open(P(6)); ev(o.ses, C({ name: 'Z' })); o.ses.liveCookies = [C({ name: 'Z' })]; await sleep(450);
  row('R4', JSON.stringify(names) === '["A","B"]' && (ses.cookieSets ?? []).every((d) => d.name !== 'Z') && o.ses.cookieSets?.length === 1, 'an event for ANOTHER cookie does not cancel an in-flight promotion; another profile\'s session never promotes into this one', `P5 sets=${JSON.stringify(names)} P6 sets=${o.ses.cookieSets?.length}`); }
// R5 logout then login again within the debounce: the NEW value is promoted
{ const { ses } = open(P(7)); ev(ses, C({ value: 'old' })); await sleep(60); ev(ses, C({ value: 'old' }), true); await sleep(60); ses.liveCookies = [C({ value: 'new-login' })]; ev(ses, C({ value: 'new-login' })); await sleep(700); row('R5', JSON.stringify((ses.cookieSets ?? []).map((d) => d.value)) === '["new-login"]', 'logout then a fresh login inside the debounce: only the new value is promoted', JSON.stringify((ses.cookieSets ?? []).map((d) => d.value))); }
// R6 a read that REJECTS / a write that REJECTS: no unhandled rejection, the next event still works
{ const { ses } = open(P(8)); ses.getGate = { then: (f, g) => Promise.reject(new Error('get-boom')).then(f, g) }; /* lazy: rejects only when the product awaits it */ ev(ses, C({ name: 'r1' })); await sleep(450); ses.getGate = undefined; ses.cookies.set = () => Promise.reject(new Error('set-boom')); ses.liveCookies = [C({ name: 'r2' })]; ev(ses, C({ name: 'r2' })); await sleep(450);
  ses.cookies.set = (d) => { (ses.cookieSets ??= []).push(d); return Promise.resolve(); }; ses.liveCookies = [C({ name: 'r3' })]; ev(ses, C({ name: 'r3' })); await sleep(450);
  row('R6', unhandled.length === 0 && ses.cookieSets?.length === 1 && ses.cookieSets[0].name === 'r3', 'a rejected read and a rejected write are swallowed (no unhandled rejection) and the next cookie is still promoted', `unhandled=${JSON.stringify(unhandled)} sets=${ses.cookieSets?.length}`); }
// R7 listener hygiene: many panels on one profile → ONE listener; stop + re-attach → ONE again
{ const { ses } = open(P(9)); for (let i = 0; i < 5; i++) { const ws = `ws-race-x${i}`; PR.set(ws, P(9)); bp.ensurePanel(ws); } const n1 = ses.cookieListeners.length; bp.stopSignInPersistence(PART(P(9))); const n2 = ses.cookieListeners.length; const ws = 'ws-race-again'; PR.set(ws, P(9)); bp.ensurePanel(ws); bp.createTab(ws, { openedBy: 'agent' }); const n3 = ses.cookieListeners.length;
  row('R7', n1 === 1 && n2 === 0 && n3 <= 1, 'one listener per profile session (not per panel/tab); stop removes it; a later panel re-attaches exactly one', `after 6 panels=${n1}, after stop=${n2}, after re-attach=${n3}`); }
// R8 distinct-cookie flood: every session cookie is promoted (no cap), bookkeeping grows
{ const { ses } = open(P(10)); const N = 3000; ses.liveCookies = undefined; const live = []; for (let i = 0; i < N; i++) live.push(C({ name: `c${i}` })); ses.cookies.get = (f) => { (ses.cookieGets ??= []).push(f); return Promise.resolve(live.filter((c) => c.name === f.name)); }; const t0 = Date.now(); const h0 = process.memoryUsage().heapUsed; for (let i = 0; i < N; i++) ev(ses, live[i]); await sleep(300);
  // each get filters N live cookies: O(N^2) in this stub only; the point here is the COUNT of operations the product issues
  await sleep(2000); row('R8', null, `${N} distinct session cookies in one burst: gets=${ses.cookieGets?.length ?? 0} sets=${ses.cookieSets?.length ?? 0} (no cap / no batching), ${Date.now() - t0} ms, heap +${Math.round((process.memoryUsage().heapUsed - h0) / 1e6)} MB`); }
console.log(`SUMMARY ok=${ok} bad=${bad} info=${info}`);
fs.rmSync(path.dirname(gen), { recursive: true, force: true });
process.exit(bad ? 1 : 0);
