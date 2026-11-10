// #415 — the Bloc HTML navigation guard, pinned structurally (index.ts needs Electron): a sub-frame navigation is refused in main, the one seam #416 extends is exported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { onBlocNavigationAttempt } from './bloc-html-guard.ts';

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

test('D5: the app window has its network back — no proxy, no WebRTC policy anywhere in main (a remote image in a reply loads, the spellcheck dictionary downloads)', () => {
  for (const f of fs.readdirSync(path.join(process.cwd(), 'src/main'), { recursive: true }).map(String).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    const s = code(`src/main/${f}`);
    assert.ok(!/BLOC_BLACKHOLE|blocProxyBypass/.test(s), `${f}: no black-hole proxy`);
    assert.ok(!/defaultSession\.setProxy|setWebRTCIPHandlingPolicy/.test(s), `${f}: no proxy / WebRTC policy on the app window's session`);
  }
});
