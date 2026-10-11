// The phone shell (#334 tracer: the workspace list). Static strings, no data inside — data comes from /api/* with the token.
// Unstyled on purpose: the visual design comes from the mockups (#335) and lands in #340.

import { MANIFEST_ICONS } from './icons.ts';

export const INDEX_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Orchestra">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="theme-color" content="#111111">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<title>Orchestra</title>
<style>
body{font:16px -apple-system,system-ui,sans-serif;margin:0;padding:12px env(safe-area-inset-right) 24px env(safe-area-inset-left)}
h1{font-size:20px;margin:4px 12px 8px}
h2{font-size:13px;text-transform:uppercase;opacity:.6;margin:16px 12px 4px}
#state{margin:8px 12px;opacity:.7}
label{display:block;margin:4px 12px}
ul{list-style:none;margin:0;padding:0}
li{padding:10px 12px;border-bottom:1px solid #8883}
.st{font-size:12px;padding:1px 6px;border-radius:8px;border:1px solid currentColor;margin-left:6px}
.meta{font-size:13px;opacity:.65}
</style>
</head>
<body>
<h1>Orchestra</h1>
<label><input type="checkbox" id="needsMe"> M'attend seulement</label>
<div id="state">Chargement…</div>
<div id="list"></div>
<script src="/app.js"></script>
</body>
</html>
`;

export const APP_JS = `(function () {
  'use strict';
  var KEY = 'orchestra.accesMobile.token';
  // Pairing: the token rides in the fragment (never in a request line); store it and strip it from the address. Also on hashchange — a
  // re-scan of the QR (new token) opened over an already-open page is a same-document navigation: the script does not re-run.
  function pairFromHash() {
    var m = /[#&]t=([A-Za-z0-9_-]{16,256})/.exec(location.hash);
    if (!m) return false;
    try { localStorage.setItem(KEY, m[1]); } catch (e) {}
    history.replaceState(null, '', location.pathname);
    return true;
  }
  pairFromHash();
  var token = null;
  try { token = localStorage.getItem(KEY); } catch (e) {}
  var stateEl = document.getElementById('state');
  var listEl = document.getElementById('list');
  var needsMe = document.getElementById('needsMe');
  var last = [];
  var LABEL = { waiting: 'en attente', running: 'en cours', idle: 'inactif', error: 'erreur', stopped: 'arrêté' };

  function setState(t) { stateEl.textContent = t; stateEl.hidden = !t; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function render() {
    var rows = last.filter(function (w) { return !needsMe.checked || w.status === 'waiting' || w.unread; });
    listEl.textContent = '';
    if (!rows.length) { setState(needsMe.checked ? 'Rien ne t\\'attend.' : 'Aucun workspace.'); return; }
    setState('');
    // Attention beats grouping: everything en attente / non lu first in one section (rows arrive attention-sorted), then the
    // rest by repo like the desktop sidebar.
    var FOR_YOU = 'Pour toi';
    var groups = {}; var order = [];
    rows.forEach(function (w) {
      var g = (w.status === 'waiting' || w.unread) ? FOR_YOU : w.group;
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(w);
    });
    order.forEach(function (g) {
      listEl.appendChild(el('h2', null, g));
      var ul = el('ul');
      groups[g].forEach(function (w) {
        var li = el('li'); li.dataset.id = w.id; li.dataset.status = w.status; if (w.unread) li.dataset.unread = '1';
        var top = el('div'); top.appendChild(el('strong', null, w.name));
        top.appendChild(el('span', 'st', LABEL[w.status] || w.status));
        if (w.unread) top.appendChild(el('span', 'st', 'non lu'));
        li.appendChild(top);
        li.appendChild(el('div', 'meta', (g === FOR_YOU ? w.group + ' · ' : '') + w.branch + ' · ' + w.account));
        if (w.statusText) li.appendChild(el('div', 'meta', w.statusText));
        ul.appendChild(li);
      });
      listEl.appendChild(ul);
    });
  }

  function load() {
    if (!token) { setState('Pas appairé : scanne le QR code dans Orchestra → Réglages → Accès mobile.'); return; }
    fetch('/api/workspaces', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
      .then(function (r) {
        // A refused token (regenerated, or revoked) must not leave the last list on screen: the phone lost its access.
        if (r.status === 401) { last = []; listEl.textContent = ''; setState('Jeton refusé : re-scanne le QR code.'); return null; }
        if (!r.ok) { setState('Orchestra injoignable.'); return null; }
        return r.json();
      })
      .then(function (j) { if (j && j.ok) { last = j.workspaces; render(); } })
      .catch(function () { setState('Orchestra injoignable.'); });
  }
  needsMe.addEventListener('change', render);
  window.addEventListener('hashchange', function () {
    if (!pairFromHash()) return;
    try { token = localStorage.getItem(KEY); } catch (e) {}
    load();
  });
  load();
  setInterval(load, 5000);
  // Home-screen install + the offline shell (sw.js caches the static shell only, never /api). A failed registration changes nothing.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
})();
`;

export const MANIFEST_JSON = JSON.stringify({
  name: 'Orchestra',
  short_name: 'Orchestra',
  lang: 'fr',
  start_url: '/',
  scope: '/',
  icons: MANIFEST_ICONS,
  display: 'standalone',
  background_color: '#111111',
  theme_color: '#111111',
});
