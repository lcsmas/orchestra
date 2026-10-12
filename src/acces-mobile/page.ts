// The phone shell (#334 tracer: the workspace list). Static strings, no data inside — data comes from /api/* with the token.
// Design V1 « Boîte de réception » (#335 pick, applied in #340): styles in conversation.ts (CONVERSATION_CSS, one stylesheet).

import { MANIFEST_ICONS } from './icons.ts';

export const INDEX_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Orchestra">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#1a1f26">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/conversation.css">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<title>Orchestra</title>
</head>
<body class="v1">
<div id="home" class="col">
<div class="top">
<div class="tt"><h1>Workspaces</h1><span id="live" class="live off" data-live="off"><i></i><span id="liveText">hors ligne</span></span></div>
<div class="seg"><button type="button" id="segAll" class="on">Tout <b id="cntAll">0</b></button><button type="button" id="segMe">À traiter <b id="cntMe">0</b></button></div>
<input type="checkbox" id="needsMe" hidden>
</div>
<div id="state">Chargement…</div>
<div id="list" class="scroll"></div>
</div>
<div id="conv" class="col" hidden></div>
<script src="/conversation.js"></script>
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
  var segAll = document.getElementById('segAll'), segMe = document.getElementById('segMe');
  var cntAll = document.getElementById('cntAll'), cntMe = document.getElementById('cntMe');
  var liveEl = document.getElementById('live'), liveText = document.getElementById('liveText');
  var last = [];
  var LABEL = { waiting: 'en attente', running: 'en cours', idle: 'inactif', error: 'erreur', stopped: 'arrêté' };
  var GLYPH = { waiting: 'g-wait', running: 'g-run', idle: 'g-idle', error: 'g-err', stopped: 'g-stop' };
  var PV = { question: 'Question', desktop: 'Bureau', status: 'Note' };

  function setState(t) {
    stateEl.textContent = t; stateEl.hidden = !t;
    // « injoignable » / a refused token is an alert card (V1); a neutral hint stays plain.
    stateEl.className = /injoignable|refusé/.test(t) ? 'offline' : (t ? 'hint-state' : '');
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function ago(at) {
    if (!at) return '';
    var s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 60) return 'à l’instant';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    return Math.floor(s / 86400) + ' j';
  }
  function acct(name) { return el('span', 'acct a-' + String(name).replace(/[^a-z0-9-]/gi, '').toLowerCase(), name); }
  function needs(w) { return w.status === 'waiting' || w.unread; }

  function row(w, withRepo) {
    var waiting = w.status === 'waiting';
    var li = el('li', 'row ' + (waiting ? 'big waiting' : w.unread ? 'big unread' : 'small'));
    li.dataset.id = w.id; li.dataset.status = w.status; if (w.unread) li.dataset.unread = '1';
    li.addEventListener('click', function () { location.hash = 'w=' + encodeURIComponent(w.id); });
    li.appendChild(el('div', 'g ' + (waiting ? 'g-wait' : w.unread ? 'g-unread' : (GLYPH[w.status] || 'g-idle'))));
    var rb = el('div', 'rb');
    var r1 = el('div', 'r1'); r1.appendChild(el('b', null, w.name)); r1.appendChild(el('time', null, ago(w.at))); rb.appendChild(r1);
    var r2 = el('div', 'r2');
    if (withRepo) r2.appendChild(el('span', 'repo', w.group));
    r2.appendChild(el('span', 'br', w.branch));
    if (!withRepo && !waiting && !w.unread) r2.appendChild(el('span', 'stl', LABEL[w.status] || w.status));
    r2.appendChild(acct(w.account));
    rb.appendChild(r2);
    if (w.preview && (withRepo || w.preview.kind === 'status')) {
      var pv = el('div', 'pv'); pv.appendChild(el('em', null, PV[w.preview.kind] || '')); pv.appendChild(el('span', null, w.preview.text)); rb.appendChild(pv);
    }
    li.appendChild(rb);
    return li;
  }
  function section(cls, label, n) {
    var h = el('h2', cls); h.dataset.group = label;
    if (cls === 'sub w') h.appendChild(el('span', 'd'));
    h.appendChild(el('span', null, label)); h.appendChild(el('b', null, String(n)));
    return h;
  }

  function render() {
    var me = last.filter(needs);
    cntAll.textContent = String(last.length); cntMe.textContent = String(me.length); cntMe.className = me.length ? 'hot' : '';
    segAll.className = needsMe.checked ? '' : 'on'; segMe.className = needsMe.checked ? 'on' : '';
    var rows = needsMe.checked ? me : last;
    listEl.textContent = '';
    if (!rows.length) { setState(needsMe.checked ? 'Rien ne t’attend.' : 'Aucun workspace.'); return; }
    setState('');
    // V1 « Boîte de réception »: attention beats grouping — en attente, then non lu (any repo, rows arrive attention-sorted),
    // then the rest by repo like the desktop sidebar.
    var waiting = rows.filter(function (w) { return w.status === 'waiting'; });
    var unread = rows.filter(function (w) { return w.status !== 'waiting' && w.unread; });
    var rest = rows.filter(function (w) { return !needs(w); });
    function block(cls, label, ws, withRepo) {
      if (!ws.length) return;
      listEl.appendChild(section(cls, label, ws.length));
      var ul = el('ul', cls === 'rh' ? 'repo-g' : null);
      ws.forEach(function (w) { ul.appendChild(row(w, withRepo)); });
      listEl.appendChild(ul);
    }
    block('sub w', 'En attente', waiting, true);
    block('sub un', 'Non lu', unread, true); // not 'u': that is the user-bubble class (conversation.css)
    var groups = {}; var order = [];
    rest.forEach(function (w) { if (!groups[w.group]) { groups[w.group] = []; order.push(w.group); } groups[w.group].push(w); });
    order.forEach(function (g) { block('rh', g, groups[g], false); });
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
  // The V1 segmented filter drives the (hidden) « M'attend » checkbox — one state, one render.
  function pick(me) { if (needsMe.checked !== me) { needsMe.checked = me; render(); } }
  segAll.addEventListener('click', function () { pick(false); });
  segMe.addEventListener('click', function () { pick(true); });
  function live(on) { liveEl.className = on ? 'live' : 'live off'; liveEl.dataset.live = on ? 'on' : 'off'; liveText.textContent = on ? 'en ligne' : 'hors ligne'; }
  // #337: hash routing to the conversation screen (conversation.js); the list refreshes on the live stream, with a slow poll
  // as the fallback when the stream is down. #336: a re-scan over an open page is a hashchange too (same document) — re-pair,
  // then reopen the stream with the new token.
  var conv = window.OrchestraConversation;
  function route() {
    var m2 = /^#w=([A-Za-z0-9-]{1,64})$/.exec(location.hash);
    var home = document.getElementById('home');
    if (m2) {
      var w = last.filter(function (x) { return x.id === m2[1]; })[0];
      home.hidden = true; conv.open(m2[1], w || { name: m2[1] }, last.filter(function (x) { return x.status === 'waiting' && x.id !== m2[1]; }).length);
    } else { conv.close(); home.hidden = false; load(); }
  }
  window.addEventListener('hashchange', function () {
    if (pairFromHash()) {
      try { token = localStorage.getItem(KEY); } catch (e) {}
      conv.connect();
      route();
      return;
    }
    route();
  });
  conv.onStream(function (m) {
    if (m.t === 'down') return live(false);
    live(true);
    if (m.t === 'workspaces' || m.t === 'resume') load();
  });
  conv.connect();
  route(); // loads the list (home) or opens #w=<id> — exactly one fetch at boot
  setInterval(load, 30000);
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
