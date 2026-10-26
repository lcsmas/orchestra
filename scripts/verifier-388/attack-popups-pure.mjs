// Verifier adversarial table for the #396 popup policy (seat 1): PURE modules only — decidePopup, popupNeedsOpener, featuresSmuggleWebContents, buildChildWindowOptions, popupWindowTitle, popupOrigin.
// usage: node --no-warnings --experimental-strip-types attack-popups-pure.mjs <repo-root>. Expectation codes: refuse:<reason> | tab | window | external | GAP:<what passes although hostile>. Exit 1 on an unexpected outcome.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] ?? '.');
const P = await import(pathToFileURL(path.join(root, 'src/shared/browser-tab-policy.ts')).href);
const WIN = await import(pathToFileURL(path.join(root, 'src/shared/browser-popup-window.ts')).href);
let ok = 0, bad = 0, gaps = 0;
const line = (id, verdict, label, extra = '') => console.log(`${id.padEnd(5)} ${verdict.padEnd(7)} ${label}${extra ? ` | ${extra}` : ''}`);
const route = (d) => (d.route === 'refuse' ? `refuse:${d.reason}` : d.route === 'new-tab' ? 'tab' : d.route === 'child-window' ? 'window' : d.route);
const req = (o) => ({ url: 'https://a.example/x', frameName: '', disposition: 'foreground-tab', features: '', userGesture: false, ...o });
const ctx = (o = {}) => ({ openTabs: 1, openWindows: 0, pageInitiatedOpen: 0, recentPageInitiated: 0, ...o });
const dec = (id, expect, label, r, c = {}) => { const got = route(P.decidePopup(req(r), ctx(c))); const gap = expect.startsWith('GAP:'); const want = gap ? expect.slice(4) : expect; const v = got === want ? (gap ? 'GAP' : 'OK') : 'BYPASS'; if (v === 'OK') ok++; else if (v === 'GAP') gaps++; else bad++; line(id, v, label, `got=${got}${v === 'BYPASS' ? ` want=${want}` : ''}`); };

// ── A. URL classification (click and no click) ──────────────────────────────────────────────────────────────────────────
for (const [id, url] of [['A1', 'javascript:alert(1)'], ['A2', 'JaVaScRiPt:alert(1)'], ['A3', '\u0001javascript:alert(1)'], ['A4', ' \tjavascript:alert(1)'], ['A5', 'java\nscript:alert(1)'], ['A6', 'data:text/html,<script>1</script>'], ['A7', 'file:///etc/passwd'],
  ['A8', 'blob:https://a.example/uuid'], ['A9', 'filesystem:https://a.example/temporary/x'], ['A10', 'view-source:https://a.example'], ['A11', 'chrome://gpu'], ['A12', 'devtools://devtools/bundled/inspector.html'], ['A13', 'chrome-untrusted://x'],
  ['A14', 'ssh://user@host'], ['A15', 'smb://host/share'], ['A16', 'zoommtg://zoom.us/join?confno=1'], ['A17', 'steam://run/1'], ['A18', 'vscode://file/etc/passwd:1'], ['A19', 'ms-msdt:/id'], ['A20', 'about:srcdoc'], ['A21', 'about:blank#x'], ['A22', 'about:blank?x'],
  ['A23', 'ma\nilto:x@y.z'], ['A24', 'mail​to:x@y.z'], ['A25', '//a.example/x'], ['A26', '/relative'], ['A27', 'ftp://host/f'], ['A28', 'ws://host/'], ['A29', 'httpx://a.example'], ['A30', 'http:a.example'], ['A31', 'https:/a.example'], ['A32', 'tel\t:123'], ['A33', 'sms:+123'], ['A34', 'intent://x#Intent;end']]) {
  dec(id, 'refuse:unsafe-url', `no click, ${JSON.stringify(url)}`, { url, userGesture: false }); dec(`${id}c`, 'refuse:unsafe-url', `CLICKED, ${JSON.stringify(url)}`, { url, userGesture: true });
}
dec('B1', 'refuse:no-gesture-external', 'mailto: without a click', { url: 'mailto:a@b.c', userGesture: false }); dec('B2', 'external', 'mailto: WITH a click (allowlisted by design)', { url: 'mailto:a@b.c', userGesture: true });
dec('B3', 'external', 'MAILTO: upper case, click', { url: 'MAILTO:a@b.c', userGesture: true }); dec('B4', 'refuse:no-gesture-external', 'tel: without a click', { url: 'tel:123', userGesture: false }); dec('B5', 'external', 'tel: with a click', { url: 'tel:123', userGesture: true });
dec('B6', 'GAP:external', 'mailto: URL carrying a header/body payload on a click (handler gets attacker text)', { url: 'mailto:a@b.c?subject=x&body=y&attach=/etc/passwd', userGesture: true });
dec('B7', 'tab', 'plain https, no click, unnamed', { url: 'https://a.example/' }); dec('B8', 'window', 'about:blank + name (OAuth shape), click', { url: 'about:blank', frameName: 'oauth', userGesture: true });
dec('B9', 'GAP:tab', 'HTTP:// upper-case scheme (accepted as web: correct)', { url: 'HTTP://a.example/' });
// ── C. features / routing ─────────────────────────────────────────────────────────────────────────────────────────────────────
dec('C1', 'refuse:unsafe-features', 'webContents feature', { features: 'webContents=x' }); dec('C2', 'refuse:unsafe-features', 'webContents among others', { features: 'width=1,webContents=1,height=2' });
dec('C3', 'refuse:unsafe-features', 'webContents with spaces', { features: 'width=1, webContents = 1' }); dec('C4', 'GAP:tab', 'WEBCONTENTS upper-case (Electron parser is case-sensitive: harmless)', { features: 'WEBCONTENTS=1' });
dec('C5', 'GAP:tab', 'webContents separated by a space not a comma (Electron splits on commas only)', { features: 'width=1 webContents=1' });
dec('C6', 'window', 'named popup', { frameName: 'oauth', disposition: 'new-window', features: 'width=500,height=600' }); dec('C7', 'tab', 'noopener named popup', { frameName: 'x', features: 'noopener' });
dec('C8', 'window', 'noopener=0 keeps the opener', { frameName: 'x', features: 'noopener=0' }); dec('C9', 'tab', 'NoOpener mixed case', { frameName: 'x', features: 'NoOpener' }); dec('C10', 'tab', '_blank named', { frameName: '_blank' });
dec('C11', 'tab', ' _BLANK ', { frameName: ' _BLANK ' }); dec('C12', 'window', 'new-window with features and no name', { disposition: 'new-window', features: 'popup' }); dec('C13', 'tab', 'new-window WITHOUT features (shift-click)', { disposition: 'new-window', features: '' });
// ── D. caps, budget, rate, names ────────────────────────────────────────────────────────────────────────────────────────────
dec('D1', 'refuse:cap', 'tabs+windows at the cap (8)', {}, { openTabs: 5, openWindows: 3 }); dec('D2', 'tab', '7 held → one more allowed', {}, { openTabs: 4, openWindows: 3, pageInitiatedOpen: 0 }); dec('D3', 'refuse:cap', 'cap applies to a CLICKED popup too', { userGesture: true }, { openTabs: 8 });
dec('D4', 'refuse:budget', 'page-initiated budget (3 open)', {}, { pageInitiatedOpen: 3 }); dec('D5', 'tab', 'clicked popup ignores the budget', { userGesture: true }, { pageInitiatedOpen: 3 }); dec('D6', 'refuse:rate', '6 opened in the last minute', {}, { recentPageInitiated: 6 });
dec('D7', 'tab', '5 opened in the last minute', {}, { recentPageInitiated: 5 }); dec('D8', 'tab', 'a clicked popup ignores the rate', { userGesture: true }, { recentPageInitiated: 99 }); dec('D9', 'refuse:name-in-use', 'named popup, name held by another opener', { frameName: 'x', disposition: 'new-window', features: 'width=300' }, { nameHeldByOtherOpener: true });
dec('D10', 'tab', 'UNnamed (tab) when the name flag is set (not applicable)', {}, { nameHeldByOtherOpener: true }); dec('D11', 'refuse:name-in-use', 'name held, clicked', { frameName: 'x', userGesture: true }, { nameHeldByOtherOpener: true });
dec('D12', 'refuse:cap', 'cap beats budget order (cap first)', {}, { openTabs: 8, pageInitiatedOpen: 3 }); dec('D13', 'refuse:unsafe-url', 'url check comes before the cap', { url: 'javascript:1' }, { openTabs: 8 });
dec('D14', 'GAP:tab', 'NaN counts (junk ctx) are not a refusal', {}, { openTabs: NaN, openWindows: NaN });
// ── E. window options allowlist ───────────────────────────────────────────────────────────────────────────────────────────────
const bo = (given, c) => WIN.buildChildWindowOptions(given, { parent: 'P', ...c });
const optsRow = (id, label, got, test, expectOk = true) => { const t = test(got); const v = t === expectOk ? 'OK' : 'BYPASS'; if (v === 'OK') ok++; else bad++; line(id, v, label, JSON.stringify(got).slice(0, 150)); };
const HOSTILE = { alwaysOnTop: true, frame: false, transparent: true, fullscreen: true, kiosk: true, modal: true, closable: false, focusable: false, skipTaskbar: true, x: -5000, y: 99999, titleBarStyle: 'hidden', show: true, resizable: true, movable: false, hasShadow: false, type: 'toolbar', vibrancy: 'x', webPreferences: { nodeIntegration: true, sandbox: false, contextIsolation: false }, parent: 'EVIL', width: 4000, height: 9999 };
const hostileOut = bo(HOSTILE, { parentSize: { width: 1400, height: 900 } });
optsRow('E1', 'hostile bag: only the allowlist survives', hostileOut, (o) => Object.keys(o).sort().join() === 'autoHideMenuBar,height,parent,resizable,show,webPreferences,width');
optsRow('E2', 'hostile bag: size clamped to 90% of the parent', hostileOut, (o) => o.width === 1260 && o.height === 810); optsRow('E3', 'hostile bag: parent is OURS, show:false, resizable:false', hostileOut, (o) => o.parent === 'P' && o.show === false && o.resizable === false);
optsRow('E4', 'hostile bag: webPreferences forced', hostileOut, (o) => o.webPreferences.sandbox === true && o.webPreferences.contextIsolation === true && o.webPreferences.nodeIntegration === false && Object.keys(o.webPreferences).length === 3);
optsRow('E5', 'string webContents smuggled is dropped', bo({ webContents: 'x' }, {}), (o) => !('webContents' in o)); optsRow('E6', 'object webContents is kept', bo({ webContents: { id: 1 } }, {}), (o) => o.webContents?.id === 1);
optsRow('E7', 'null webContents dropped', bo({ webContents: null }, {}), (o) => !('webContents' in o)); optsRow('E8', 'NaN / negative / Infinity size → default or min', bo({ width: NaN, height: -50 }, { parentSize: { width: 1400, height: 900 } }), (o) => o.width === 480 && o.height === 520);
optsRow('E9', '1x1 popup → minimum 200x150', bo({ width: 1, height: 1 }, { parentSize: { width: 1400, height: 900 } }), (o) => o.width === 200 && o.height === 150); optsRow('E10', 'Infinity', bo({ width: Infinity, height: Infinity }, { parentSize: { width: 1400, height: 900 } }), (o) => o.width === 480 && o.height === 520);
optsRow('E11', 'tiny parent (100x80) never yields a window smaller than the min', bo({ width: 4000, height: 4000 }, { parentSize: { width: 100, height: 80 } }), (o) => o.width >= 200 && o.height >= 150);
optsRow('E12', 'parent size unknown: ceiling 8192 (NOT screen-bound)', bo({ width: 99999, height: 99999 }, {}), (o) => o.width === 8192 && o.height === 8192, true);
optsRow('E13', 'prototype pollution: inherited width is ignored', bo(Object.create({ width: 7777, webContents: { id: 9 } }), { parentSize: { width: 1400, height: 900 } }), (o) => o.width === 480 && !('webContents' in o));
optsRow('E14', 'string size "600" is not a number → default', bo({ width: '600', height: '600' }, { parentSize: { width: 1400, height: 900 } }), (o) => o.width === 480);
optsRow('E15', 'fractional 300.9 → 300', bo({ width: 300.9, height: 250.5 }, { parentSize: { width: 1400, height: 900 } }), (o) => o.width === 300 && o.height === 250);
optsRow('E16', 'position keys never emitted', hostileOut, (o) => !('x' in o) && !('y' in o) && !('center' in o));
// ── F. features smuggling, titles, origins ───────────────────────────────────────────────────────────────────────────────────
const sm = (id, expect, label, f) => { const g = WIN.featuresSmuggleWebContents(f); const v = g === expect ? 'OK' : 'BYPASS'; if (v === 'OK') ok++; else bad++; line(id, v, label, `got=${g}`); };
sm('F1', true, 'plain', 'webContents=1'); sm('F2', true, 'spaces around the key', ' webContents =1'); sm('F3', true, 'no value', 'webContents'); sm('F4', true, 'middle', 'a=1,webContents=2,b=3'); sm('F5', false, 'prefix lookalike', 'webContentsX=1'); sm('F6', false, 'case differs (Electron case-sensitive)', 'WebContents=1');
sm('F7', false, 'value text only', 'x=webContents'); sm('F8', true, 'tab char around the key', '\twebContents\t=1'); sm('F9', false, 'semicolon separated (not a separator for Electron)', 'a=1;webContents=2'); sm('F10', true, 'empty items around', ',,webContents=1,,');
const tt = (id, label, url, title, test) => { const g = WIN.popupWindowTitle(url, title); const v = test(g) ? 'OK' : 'BYPASS'; if (v === 'OK') ok++; else bad++; line(id, v, label, JSON.stringify(g)); };
tt('T1', 'origin first', 'https://accounts.example/o', 'Sign in', (g) => g.startsWith('https://accounts.example — ')); tt('T2', 'spoofed origin in the page title cannot push the real one out', 'https://evil.example/', 'https://accounts.google.com — Sign in', (g) => g.startsWith('https://evil.example — '));
tt('T3', 'bidi override stripped', 'https://evil.example/', '‮google.com', (g) => !/[‪-‮⁦-⁩]/.test(g)); tt('T4', 'control chars stripped', 'https://a.example/', 'a\u0000b\u001fc\u007fd', (g) => !/[\u0000-\u001f\u007f]/.test(g));
tt('T5', 'long title cut to 80', 'https://a.example/', 'x'.repeat(5000), (g) => g.length <= 'https://a.example — '.length + 80); tt('T6', 'newline folded', 'https://a.example/', 'line1\nline2\r\nline3', (g) => !/[\r\n]/.test(g));
tt('T7', 'blank page origin', 'about:blank', 'Title', (g) => g.startsWith('about:blank')); tt('T8', 'javascript: url never leaks as an origin', 'javascript:alert(1)', 't', (g) => g.startsWith('unknown origin')); tt('T9', 'data: origin is "unknown origin"', 'data:text/html,x', 't', (g) => g.startsWith('unknown origin'));
tt('T10', 'userinfo spoof (https://google.com@evil.example) shows the REAL origin', 'https://google.com@evil.example/', 'x', (g) => g.startsWith('https://evil.example')); tt('T11', 'IDN / punycode shown as parsed (not homograph-decoded)', 'https://xn--pple-43d.example/', 'x', (g) => g.startsWith('https://xn--pple-43d.example'));
tt('T12', 'zero-width / RTL isolate marks in the title', 'https://a.example/', 'a‎b‏c⁦d⁩', (g) => !/[‎‏⁦⁩]/.test(g)); tt('T13', 'GAP: zero-width space (U+200B) and BOM (U+FEFF) are NOT stripped', 'https://a.example/', 'pay​pal﻿', (g) => /[​﻿]/.test(g) ? false : true);
console.log(`SUMMARY: ok=${ok} declared-gaps=${gaps} bypass=${bad}`);
process.exit(bad ? 1 : 0);
