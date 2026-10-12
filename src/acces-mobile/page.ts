// The phone shell (#334 tracer: the workspace list). Static strings, no data inside — data comes from /api/* with the token.
// Design V1 « Boîte de réception » (#335 pick, applied in #340): styles in conversation.ts (CONVERSATION_CSS, one stylesheet).

import { MANIFEST_ICONS } from './icons.ts';
import { pairingTokenFrom } from '../shared/acces-mobile.ts';

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
<div id="appUpdate" class="update" role="status" hidden></div>
</div>
<div id="state">Chargement…</div>
<div id="pair" class="pair" hidden>
<p id="pairWhy"></p>
<button type="button" id="pairScan" class="btn pair-scan">Scanner le QR code</button>
<form id="pairForm" class="pair-form"><input id="pairInput" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="…ou colle le lien d’appairage"><button type="submit" class="btn2">OK</button></form>
<div id="pairErr" class="pair-err" role="alert"></div>
</div>
<div id="scan" class="scan" hidden><video id="scanVideo" playsinline muted autoplay></video><p id="scanHint">Vise le QR code : Orchestra → Réglages → Accès mobile.</p><button type="button" id="scanClose" class="btn2">Annuler</button></div>
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
  // In-app pairing (Lucas 2026-10-12): an iOS home-screen app has ITS OWN storage — the pairing done in Safari never reaches it, and
  // it opens at start_url without the fragment. So an unpaired (or refused) page pairs itself: scan the QR with the camera, or paste.
  var tokenFrom = (${pairingTokenFrom.toString()});
  var pairEl = document.getElementById('pair'), pairWhy = document.getElementById('pairWhy'), pairErr = document.getElementById('pairErr');
  var pairInput = document.getElementById('pairInput'), scanEl = document.getElementById('scan'), scanVideo = document.getElementById('scanVideo');
  var scanHint = document.getElementById('scanHint');
  var standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  function showPair(on) {
    pairEl.hidden = !on;
    if (on) pairWhy.textContent = standalone
      ? 'L’app de l’écran d’accueil a son propre stockage : l’appairage fait dans Safari ne la suit pas. Scanne le QR code ici, une fois.'
      : 'Scanne le QR code : Orchestra → Réglages → Accès mobile.';
  }
  function adopt(tok) {
    try { localStorage.setItem(KEY, tok); } catch (e) {}
    token = tok; pairErr.textContent = ''; pairInput.value = ''; showPair(false);
    conv.connect(); route();
  }
  var decoder = null;
  function loadDecoder() {
    if (typeof window.jsQR === 'function') return Promise.resolve();
    if (!decoder) decoder = new Promise(function (ok, ko) {
      var sc = document.createElement('script'); sc.src = '/jsqr.js';
      sc.onload = function () { ok(); }; sc.onerror = function () { decoder = null; ko(new Error('decoder')); };
      document.head.appendChild(sc);
    });
    return decoder;
  }
  var scanStream = null, scanTimer = null;
  function stopScan() {
    if (scanTimer) clearInterval(scanTimer); scanTimer = null;
    if (scanStream) scanStream.getTracks().forEach(function (t) { t.stop(); });
    scanStream = null; scanVideo.srcObject = null; scanEl.hidden = true;
  }
  function startScan() {
    pairErr.textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { pairErr.textContent = 'Caméra indisponible ici : colle le lien d’appairage.'; return; }
    loadDecoder()
      .then(function () { return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); })
      .then(function (stream) {
        scanStream = stream; scanVideo.srcObject = stream; scanEl.hidden = false; scanHint.textContent = 'Vise le QR code : Orchestra → Réglages → Accès mobile.';
        var p = scanVideo.play(); if (p && p.catch) p.catch(function () {});
        var c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
        scanTimer = setInterval(function () {
          var w = scanVideo.videoWidth, h = scanVideo.videoHeight;
          if (!w || !h) return;
          var k = Math.min(1, 720 / Math.max(w, h)); c.width = Math.round(w * k); c.height = Math.round(h * k);
          g.drawImage(scanVideo, 0, 0, c.width, c.height);
          var hit = window.jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
          if (!hit) return;
          var tok = tokenFrom(hit.data);
          if (!tok) { scanHint.textContent = 'Ce QR code n’est pas un lien d’appairage Orchestra.'; return; }
          stopScan(); adopt(tok);
        }, 250);
      })
      .catch(function (e) {
        stopScan();
        pairErr.textContent = e && e.name === 'NotAllowedError' ? 'Accès à la caméra refusé : autorise-le, ou colle le lien d’appairage.' : 'Caméra indisponible : colle le lien d’appairage.';
      });
  }
  document.getElementById('pairScan').addEventListener('click', startScan);
  document.getElementById('scanClose').addEventListener('click', stopScan);
  document.getElementById('pairForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var tok = tokenFrom(pairInput.value);
    if (!tok) { pairErr.textContent = 'Ce n’est pas un lien d’appairage Orchestra.'; return; }
    adopt(tok);
  });
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
  // « À traiter » = blocked on the human only (en attente). A non lu row stays in its repo, bold with its glyph: a vague's workers
  // finishing one after another made a separate « Non lu » section pure noise (Lucas, 2026-10-12).
  function needs(w) { return w.status === 'waiting'; }
  var open = Object.create(null); // coordinator id -> its workers are unfolded

  function row(w, withRepo, child) {
    var waiting = w.status === 'waiting';
    var li = el('li', 'row ' + (waiting ? 'big waiting' : w.unread ? 'unread' : 'small') + (child ? ' child' : ''));
    li.dataset.id = w.id; li.dataset.status = w.status; if (w.unread) li.dataset.unread = '1';
    li.addEventListener('click', function () { location.hash = 'w=' + encodeURIComponent(w.id); });
    li.appendChild(el('div', 'g ' + (waiting ? 'g-wait' : w.unread ? 'g-unread' : (GLYPH[w.status] || 'g-idle'))));
    var rb = el('div', 'rb');
    var r1 = el('div', 'r1'); r1.appendChild(el('b', null, w.displayName || w.name)); r1.appendChild(el('time', null, ago(w.at))); rb.appendChild(r1);
    var r2 = el('div', 'r2');
    if (withRepo) r2.appendChild(el('span', 'repo', w.group));
    r2.appendChild(el('span', 'br', w.branch));
    if (!waiting) r2.appendChild(el('span', 'stl', w.unread ? 'non lu' : (LABEL[w.status] || w.status)));
    r2.appendChild(acct(w.account));
    rb.appendChild(r2);
    if (w.preview && (waiting || w.preview.kind === 'status')) {
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
  /** The fold line under a coordinator: « N agents » + how many are running / non lu; a tap unfolds them. */
  function fold(parentId, kids) {
    var li = el('li', 'fold' + (open[parentId] ? ' open' : '')); li.dataset.fold = parentId;
    var running = kids.filter(function (k) { return k.status === 'running'; }).length;
    var unread = kids.filter(function (k) { return k.unread; }).length;
    li.appendChild(el('span', 'fold-arrow', open[parentId] ? '▾' : '▸'));
    li.appendChild(el('span', 'fold-n', kids.length + ' agent' + (kids.length > 1 ? 's' : '')));
    if (running) li.appendChild(el('span', 'fold-run', running + ' en cours'));
    if (unread) li.appendChild(el('span', 'fold-unread', unread + ' non lu' + (unread > 1 ? 's' : '')));
    li.addEventListener('click', function () { open[parentId] = !open[parentId]; render(); });
    return li;
  }

  function render() {
    var me = last.filter(needs);
    cntAll.textContent = String(last.length); cntMe.textContent = String(me.length); cntMe.className = me.length ? 'hot' : '';
    segAll.className = needsMe.checked ? '' : 'on'; segMe.className = needsMe.checked ? 'on' : '';
    listEl.textContent = '';
    var rows = needsMe.checked ? me : last;
    if (!rows.length) { setState(needsMe.checked ? 'Rien ne t’attend.' : 'Aucun workspace.'); return; }
    setState('');
    // V1: what is blocked on the human first (any repo, repo shown); then repos like the desktop sidebar, a coordinator's
    // workers folded under it. A waiting worker is in « En attente » (never hidden by a fold) and not repeated below.
    var waiting = rows.filter(needs);
    if (waiting.length) {
      listEl.appendChild(section('sub w', 'En attente', waiting.length));
      var wl = el('ul'); waiting.forEach(function (w) { wl.appendChild(row(w, true, false)); }); listEl.appendChild(wl);
    }
    if (needsMe.checked) return;
    var byId = Object.create(null); last.forEach(function (w) { byId[w.id] = w; });
    var kidsOf = Object.create(null);
    var top = [];
    last.forEach(function (w) {
      if (needs(w)) return;
      if (w.parentId && byId[w.parentId]) (kidsOf[w.parentId] || (kidsOf[w.parentId] = [])).push(w);
      else top.push(w);
    });
    // a coordinator that is itself en attente still owns its fold: give it a header row-less fold in its repo group
    Object.keys(kidsOf).forEach(function (pid) { if (needs(byId[pid]) && top.indexOf(byId[pid]) < 0) top.push({ foldOnly: true, id: pid, group: byId[pid].group, name: byId[pid].displayName || byId[pid].name }); });
    var groups = Object.create(null); var order = [];
    top.forEach(function (w) { if (!groups[w.group]) { groups[w.group] = []; order.push(w.group); } groups[w.group].push(w); });
    order.forEach(function (g) {
      var n = 0; groups[g].forEach(function (w) { n += (w.foldOnly ? 0 : 1) + (kidsOf[w.id] ? kidsOf[w.id].length : 0); });
      listEl.appendChild(section('rh', g, n));
      var ul = el('ul', 'repo-g');
      groups[g].forEach(function (w) {
        if (w.foldOnly) { var lbl = el('li', 'fold-owner', w.name + ' (en attente, plus haut)'); ul.appendChild(lbl); }
        else ul.appendChild(row(w, false, false));
        var kids = kidsOf[w.id];
        if (kids) {
          ul.appendChild(fold(w.id, kids));
          if (open[w.id]) kids.forEach(function (k) { ul.appendChild(row(k, false, true)); });
        }
      });
      listEl.appendChild(ul);
    });
  }

  function load() {
    if (!token) { setState('Pas appairé.'); showPair(true); return; }
    showPair(false);
    fetch('/api/workspaces', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
      .then(function (r) {
        // A refused token (regenerated, or revoked) must not leave the last list on screen: the phone lost its access.
        if (r.status === 401) { last = []; listEl.textContent = ''; setState('Jeton refusé : re-scanne le QR code.'); showPair(true); return null; }
        if (!r.ok) { setState('Orchestra injoignable.'); return null; }
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.ok) return;
        // A newer Orchestra installed on the computer: say so (relaunching it is done there — a failed relaunch would cut this phone off).
        var upd = document.getElementById('appUpdate'), u = j.appUpdate;
        upd.hidden = !u;
        upd.textContent = u ? 'Nouvelle version d’Orchestra installée' + (u.version ? ' (v' + u.version + ')' : '') + ' : relance-la sur l’ordinateur pour l’avoir ici.' : '';
        last = j.workspaces; render();
      })
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
    if (m.t === 'down') { live(false); if (m.status === 401) load(); return; }
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
