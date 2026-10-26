// DEV harness (not a gate): the real CdpProxyCore + loopback server over a HEADLESS CHROMIUM page, so the
// real `agent-browser` can be pointed at the faked Target.* surface without Electron or a compositor.
// usage: node --experimental-strip-types scripts/dev/cdp-proxy-chromium.mjs <fixture-url> [chromium-path]
// prints `PROXY <ws-url>`; stays up until killed. Scratch under $TMPDIR only.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startCdpProxy } from '../../src/main/browser-cdp-proxy.ts';

const startUrl = process.argv[2] ?? 'about:blank';
const chromium = process.argv[3] ?? '/usr/lib64/chromium-browser/chromium-browser';
const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'cdp-dev-'));
const chrome = spawn(chromium, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, startUrl], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]); });
  chrome.on('exit', (c) => reject(new Error('chromium exited ' + c)));
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.once('open', r));
let nextId = 0;
const pending = new Map();
const listeners = new Set();
ws.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
  for (const l of listeners) l(m);
});
const call = (method, params, sessionId) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

const { targetInfos } = await call('Target.getTargets');
const page = targetInfos.find((t) => t.type === 'page');
const tab = { id: 't1', url: page.url, title: page.title, active: true, openedBy: 'human' };
const tabSubs = new Set();
await call('Target.setDiscoverTargets', { discover: true });
listeners.add((m) => { if (m.method === 'Target.targetInfoChanged' && m.params.targetInfo.targetId === page.targetId) { tab.url = m.params.targetInfo.url; tab.title = m.params.targetInfo.title; for (const l of tabSubs) l({ kind: 'changed', tab }); } });
let pageSession = null;
const panel = {
  listTabs: () => [tab],
  subscribeTabs: (l) => { tabSubs.add(l); return () => tabSubs.delete(l); },
  acquire: async () => {
    if (!pageSession) pageSession = (await call('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
    return {
      send: (method, params, sid) => call(method, params, sid ?? pageSession),
      subscribe: (l) => { const f = (m) => { if (!m.method) return; if (m.sessionId === pageSession) l(m.method, m.params, undefined); else if (m.sessionId) l(m.method, m.params, m.sessionId); }; listeners.add(f); return () => listeners.delete(f); },
      onDetach: () => () => {},
    };
  },
  release: () => {},
  activateTab: () => { void call('Target.activateTarget', { targetId: page.targetId }); },
  userAgent: () => 'dev-harness',
  invalidate: () => {},
  captureFallback: async () => { throw new Error('no fallback in the dev harness'); },
  framesError: () => null,
};
const proxy = await startCdpProxy(panel);
console.log('PROXY ' + proxy.wsUrl);
process.on('SIGTERM', () => { chrome.kill(); process.exit(0); });
