// #415 — the Bloc HTML navigation guard, pinned structurally (index.ts needs Electron): a sub-frame navigation is refused in main, the one seam #416 extends is exported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { onBlocNavigationAttempt, BLOC_BLACKHOLE_PROXY_RULES, blocProxyBypass } from './bloc-html-guard.ts';

const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('onBlocNavigationAttempt reports the full target (truncated at 200) and the frame', () => {
  const line = onBlocNavigationAttempt('https://evil.example/x?s=1', { processId: 7, routingId: 3 });
  assert.match(line, /https:\/\/evil\.example\/x\?s=1/);
  assert.match(line, /process 7, frame 3/);
  assert.ok(onBlocNavigationAttempt('http://a/' + 'x'.repeat(500), { processId: 1, routingId: 1 }).length < 330);
});

test('index.ts refuses a SUB-frame navigation on the app window and reports it through the guard; the main frame and about:srcdoc are untouched', () => {
  const s = code('src/main/index.ts');
  const i = s.indexOf("mainWindow.webContents.on('will-frame-navigate'");
  assert.ok(i > 0, 'the will-frame-navigate listener is registered on the app window');
  const body = s.slice(i, s.indexOf('});', i));
  assert.ok(/if \(event\.isMainFrame \|\| event\.url === 'about:srcdoc'\) return;/.test(body), 'main frame + srcdoc load pass');
  assert.ok(body.indexOf('event.preventDefault()') > 0 && body.indexOf('event.preventDefault()') < body.indexOf('onBlocNavigationAttempt('), 'refuse first, then report');
});

test('index.ts forbids non-proxied UDP on the app window (a frame\'s CSP does not cover WebRTC/STUN — rig arm I6)', () => {
  assert.ok(/mainWindow\.webContents\.setWebRTCIPHandlingPolicy\('disable_non_proxied_udp'\);/.test(code('src/main/index.ts')));
});

test('the app window\'s session sends every scheme to a closed port BEFORE the window exists; loopback is proxied too, only the dev origin is let through', () => {
  const s = code('src/main/index.ts');
  const i = s.indexOf('session.defaultSession.setProxy({ proxyRules: BLOC_BLACKHOLE_PROXY_RULES, proxyBypassRules: blocProxyBypass(VITE_DEV_SERVER_URL) })');
  assert.ok(i > 0 && i < s.indexOf('mainWindow = new BrowserWindow('), 'setProxy precedes the window');
  for (const sch of ['http', 'https', 'ftp', 'socks']) assert.ok(BLOC_BLACKHOLE_PROXY_RULES.includes(`${sch}=127.0.0.1:9`), sch);
  assert.equal(blocProxyBypass(undefined), '<-loopback>');
  assert.equal(blocProxyBypass('http://localhost:5173/'), '<-loopback>,localhost:5173');
  assert.equal(blocProxyBypass('not a url'), '<-loopback>');
});
