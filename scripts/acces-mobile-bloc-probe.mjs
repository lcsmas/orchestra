// #421 — the model's bloc HTML used by the phone rigs: themed, scripted, and a battery of attempts to reach out of the frame.
// `blocProbeSource(extUrl)` is the HTML between the fence lines; the rig reads `window.__probe` from inside the frame.
export const TOKEN_KEY = 'orchestra.accesMobile.token';
// plain http (and ws:) is refused by the policy; the rest is isolation. PROBES_HTTPS go to an https listener: policy v2 (D5) ALLOWS them.
export const PROBES_BLOCKED = ['fetch-ext', 'img-ext', 'xhr-ext', 'ws-ext', 'beacon-ext', 'img-api', 'parent-doc', 'cookie', 'storage', 'popup', 'api-with-token'];
export const PROBES_HTTPS = ['fetch-https', 'img-https', 'wss-https'];
export const PROBES = [...PROBES_BLOCKED, 'fetch-api', ...PROBES_HTTPS];
export const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
export const blocReply = (extUrl, extsUrl = 'https://127.0.0.1:9') => 'Voici le résultat :\n\n```html-render title="Courbe"\n' + blocProbeSource(extUrl, extsUrl) + '\n```\n\nVoilà pour la suite.';
export const blocProbeSource = (extUrl, extsUrl = 'https://127.0.0.1:9') => `<div id="card" style="background:var(--bloc-surface);border:1px solid var(--bloc-border);border-radius:10px;padding:12px;color:var(--bloc-fg)"><b>Courbe</b> <span id="v">…</span><div id="bar" style="margin-top:8px;height:16px;width:140px;background:var(--bloc-accent);border-radius:4px"></div></div>
<script>
document.getElementById('v').textContent = 'bloc-ran';
var EXT = '__EXT__', EXTS = '__EXTS__', R = window.__probe = {};
function img(u) { return new Promise(function (res, rej) { var i = new Image(); i.onload = res; i.onerror = function () { rej({ name: 'ImgError' }); }; i.src = u; }); }
function xhr(u) { return new Promise(function (res, rej) { var x = new XMLHttpRequest(); x.onload = res; x.onerror = function () { rej({ name: 'XhrError' }); }; try { x.open('GET', u); x.send(); } catch (e) { rej(e); } }); }
function ws(u) { return new Promise(function (res, rej) { var w = new WebSocket(u); w.onopen = res; w.onerror = function () { rej({ name: 'WsError' }); }; }); }
function attempt(k, f) { try { var r = f(); if (r && r.then) r.then(function () { R[k] = 'reached'; }, function (e) { R[k] = 'blocked:' + (e && e.name); }); else R[k] = r; } catch (e) { R[k] = 'blocked:' + (e && e.name); } }
attempt('fetch-ext', function () { return fetch(EXT + '/fetch-ext'); });
attempt('fetch-https', function () { return fetch(EXTS + '/fetch-https'); });
attempt('img-https', function () { return img(EXTS + '/img-https.gif'); });
attempt('wss-https', function () { return ws(EXTS.replace('https', 'wss') + '/wss-https'); });
attempt('img-ext', function () { return img(EXT + '/img-ext.gif'); });
attempt('xhr-ext', function () { return xhr(EXT + '/xhr-ext'); });
attempt('ws-ext', function () { return ws(EXT.replace('http', 'ws') + '/ws-ext'); });
attempt('beacon-ext', function () { return navigator.sendBeacon(EXT + '/beacon-ext', 'x') ? 'queued' : 'refused'; });
attempt('fetch-api', function () { return fetch('/api/workspaces?probe=bloc-fetch'); });
attempt('img-api', function () { return img('/api/workspaces?probe=bloc-img'); });
attempt('parent-doc', function () { return String(parent.document.title.length); });
attempt('cookie', function () { return 'read:' + document.cookie.length; });
attempt('storage', function () { var t = localStorage.getItem('__KEY__'); return t ? 'read:' + t.length : 'empty'; });
attempt('popup', function () { return window.open(EXT + '/popup') ? 'opened' : 'null'; });
attempt('api-with-token', function () { var t; try { t = localStorage.getItem('__KEY__'); } catch (e) { return 'no-token'; } return t ? fetch('/api/workspaces?probe=bloc-token', { headers: { Authorization: 'Bearer ' + t } }).then(function (r) { if (r.status !== 200) throw { name: 'Status' + r.status }; }) : 'no-token'; });
setTimeout(function () { try { location.href = EXT + '/nav-ext'; } catch (e) { R['nav-ext'] = 'blocked:' + e.name; } }, 5000);
setTimeout(function () { try { top.location.href = EXT + '/top-nav'; R['top-nav'] = 'assigned'; } catch (e) { R['top-nav'] = 'blocked:' + e.name; } }, 5200);
</script>`.replaceAll('__EXT__', extUrl).replaceAll('__EXTS__', extsUrl).replaceAll('__KEY__', TOKEN_KEY);
