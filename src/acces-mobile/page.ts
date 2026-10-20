// The phone shell (#334 tracer: the workspace list). Static strings, no data inside — data comes from /api/* with the token.
// Design V1 « Boîte de réception » (#335 pick, applied in #340): styles in conversation.ts (CONVERSATION_CSS, one stylesheet).

import { MANIFEST_ICONS } from './icons.ts';
import { pairingTokenFrom } from '../shared/acces-mobile.ts';
import { buildPhoneTree } from '../shared/acces-mobile-tree.ts';

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
<link rel="stylesheet" href="/launch.css">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<title>Orchestra</title>
</head>
<body class="v1">
<div id="home" class="col">
<div class="top">
<div class="tt"><h1>Workspaces</h1><span id="live" class="live off" data-live="off"><i></i><span id="liveText">hors ligne</span></span><button type="button" id="relaunchBtn" class="rl-btn" aria-label="Relancer Orchestra">↻</button><button type="button" id="newBtn" class="new-btn" aria-label="Nouveau workspace">+</button></div>
<div class="seg"><button type="button" id="segAll" class="on">Tout <b id="cntAll">0</b></button><button type="button" id="segMe">À traiter <b id="cntMe">0</b></button></div>
<input type="checkbox" id="needsMe" hidden>
<div id="appUpdate" class="update" role="status" hidden></div>
<div id="relaunch" class="rl" data-state="idle" role="status" hidden><p id="rlMsg"></p><div class="rl-acts"><button type="button" id="rlGo" class="btn">Relancer</button><button type="button" id="rlCancel" class="btn2">Annuler</button></div></div>
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
<div id="launch" class="col" hidden></div>
<script src="/conversation.js"></script>
<script src="/launch.js"></script>
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
  // #373: the list as a tree — ONE pure function (src/shared/acces-mobile-tree.ts); this page only draws what it returns.
  var buildTree = (${buildPhoneTree.toString()});
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
  var open = Object.create(null); // node id -> its fold is open (kept across list refreshes: render() never resets it)
  // Swipe left on a row ⇒ « Archiver » (the header button's archive, without its confirmation: the swipe + the tap ARE the two steps).
  // One row open at a time; the open row, a request in flight and a refusal survive render() like the folds.
  var SWIPE_W = 92, swiped = null, swBusy = Object.create(null), swErr = Object.create(null), swTapGuard = 0, swDrag = false, swLate = false;
  function swClose() { if (swiped === null) return false; swiped = null; render(); return true; }
  function archiveRow(id) {
    if (swBusy[id]) return;
    swBusy[id] = true; delete swErr[id]; render();
    fetch('/api/archive?id=' + encodeURIComponent(id), { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) {
        if (r.status === 401) return { ok: false, error: 'Jeton refusé : re-scanne le QR code.' };
        if (r.status === 429) return { ok: false, error: 'Trop d’actions en cours, réessaie dans un instant.' };
        if (!r.ok) return { ok: false, error: 'Orchestra injoignable : le workspace est peut-être archivé.' };
        return r.json();
      })
      .then(null, function () { return { ok: false, error: 'Réseau coupé : le workspace est peut-être archivé.' }; })
      .then(function (res) {
        delete swBusy[id];
        if (res && res.ok) {
          if (swiped === id) swiped = null;
          last = last.filter(function (x) { return x.id !== id; }); // gone at once; the refetch brings its archived subtree out too
          render(); load(); return;
        }
        swErr[id] = (res && res.error) || 'Échec de l’archivage.'; render();
      });
  }
  /** Touch tracking on one row: horizontal ⇒ the row follows the finger (0…-SWIPE_W); vertical ⇒ the page scrolls, nothing moves. */
  function swipeable(li, id) {
    var x0 = 0, y0 = 0, base = 0, dx = 0, mode = null; // null = undecided, 'x' = swiping, 'y' = scrolling
    li.addEventListener('touchstart', function (e) {
      var t = e.touches && e.touches[0]; if (!t) return;
      x0 = t.clientX; y0 = t.clientY; dx = 0; mode = null; base = swiped === id ? -SWIPE_W : 0;
    }, { passive: true });
    li.addEventListener('touchmove', function (e) {
      var t = e.touches && e.touches[0]; if (!t || mode === 'y') return;
      var mx = t.clientX - x0, my = t.clientY - y0;
      if (mode === null) {
        if (Math.abs(my) > 10 && Math.abs(my) >= Math.abs(mx)) { mode = 'y'; return; }
        if (Math.abs(mx) < 10) return;
        if (swiped !== null && swiped !== id) { swiped = null; render(); } // opening this one closes the other (BEFORE the drag holds renders)
        mode = 'x'; swDrag = true;
      }
      if (e.cancelable) e.preventDefault();
      dx = mx;
      li.style.transition = 'none';
      li.style.transform = 'translateX(' + Math.max(-SWIPE_W - 24, Math.min(0, base + dx)) + 'px)';
    }, { passive: false });
    function end() {
      if (mode !== 'x') return;
      mode = null; swDrag = false; swLate = false; swTapGuard = Date.now();
      li.style.transition = ''; li.style.transform = '';
      swiped = base + dx < -SWIPE_W / 2 ? id : null;
      render();
    }
    li.addEventListener('touchend', end);
    li.addEventListener('touchcancel', end);
  }

  /** Indentation = one step per tree level: data-depth for the tests, --depth for the stylesheet (any depth). */
  function level(li, depth) { li.dataset.depth = String(depth); li.style.setProperty('--depth', String(depth)); return li; }
  function row(w, withRepo, depth) {
    var waiting = w.status === 'waiting';
    var li = level(el('li', 'row ' + (waiting ? 'big waiting' : w.unread ? 'unread' : 'small') + (depth ? ' child' : '')), depth);
    li.dataset.id = w.id; li.dataset.status = w.status; if (w.unread) li.dataset.unread = '1';
    li.addEventListener('click', function () {
      if (Date.now() - swTapGuard < 400) return; // the click a swipe can leave behind
      if (swClose()) return; // a tap while a row is open closes it (iOS) — it does not open a conversation
      location.hash = 'w=' + encodeURIComponent(w.id);
    });
    if (swiped === w.id) li.className += ' swiped';
    swipeable(li, w.id);
    var sw = el('button', 'sw-archive'); sw.type = 'button'; sw.dataset.id = w.id; sw.disabled = !!swBusy[w.id];
    sw.setAttribute('aria-label', 'Archiver ' + (w.displayName || w.name));
    sw.appendChild(el('span', 'sw-t', swBusy[w.id] ? 'Archivage…' : swErr[w.id] ? 'Réessayer' : 'Archiver'));
    var nb = below(w.id); if (nb > 0) sw.appendChild(el('span', 'sw-n', '+' + nb + ' agent' + (nb > 1 ? 's' : '')));
    sw.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); archiveRow(w.id); });
    li.appendChild(sw);
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
    if (swErr[w.id]) rb.appendChild(el('div', 'sw-err', swErr[w.id]));
    li.appendChild(rb);
    return li;
  }
  function section(cls, label, n) {
    var h = el('h2', cls); h.dataset.group = label;
    if (cls === 'sub w') h.appendChild(el('span', 'd'));
    h.appendChild(el('span', null, label)); h.appendChild(el('b', null, String(n)));
    return h;
  }
  /** The fold line under a coordinator: « N agents » + how many are running / non lu — over its WHOLE subtree; a tap unfolds it. */
  function fold(n) {
    var id = n.row.id;
    var li = level(el('li', 'fold' + (open[id] ? ' open' : '')), n.depth); li.dataset.fold = id;
    li.appendChild(el('span', 'fold-arrow', open[id] ? '▾' : '▸'));
    li.appendChild(el('span', 'fold-n', n.agents + ' agent' + (n.agents > 1 ? 's' : '')));
    if (n.running) li.appendChild(el('span', 'fold-run', n.running + ' en cours'));
    if (n.unread) li.appendChild(el('span', 'fold-unread', n.unread + ' non lu' + (n.unread > 1 ? 's' : '')));
    li.addEventListener('click', function () { open[id] = !open[id]; render(); });
    return li;
  }
  /** An en attente coordinator with live agents below it: it is listed in « En attente », this line only holds its place. */
  function standIn(n) {
    var li = level(el('li', 'fold-owner stand'), n.depth); li.dataset.standIn = n.row.id;
    li.appendChild(el('span', 'so-g'));
    li.appendChild(document.createTextNode((n.row.displayName || n.row.name) + ' '));
    li.appendChild(el('em', null, '(en attente, plus haut)'));
    return li;
  }
  /** One node: its row (or its stand-in), then its fold and — open — its kids one level deeper. */
  function drawNode(ul, n) {
    ul.appendChild(n.standIn ? standIn(n) : row(n.row, false, n.depth));
    if (!n.kids.length) return;
    ul.appendChild(fold(n));
    if (open[n.row.id]) n.kids.forEach(function (k) { drawNode(ul, k); });
  }

  function render() {
    if (swDrag) { swLate = true; return; } // a refresh mid-swipe would replace the row under the finger: drawn at touchend
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
      var wl = el('ul'); waiting.forEach(function (w) { wl.appendChild(row(w, true, 0)); }); listEl.appendChild(wl);
    }
    if (needsMe.checked) return;
    buildTree(last).groups.forEach(function (g) {
      listEl.appendChild(section('rh', g.group, g.count));
      var ul = el('ul', 'repo-g');
      g.roots.forEach(function (n) { drawNode(ul, n); });
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
        // A newer Orchestra installed on the computer: say so, with « Relancer » (the same confirmation as the header's ↻).
        var upd = document.getElementById('appUpdate'), u = j.appUpdate;
        upd.hidden = !u; upd.textContent = ''; update = u || null;
        if (u) {
          upd.appendChild(el('span', null, 'Nouvelle version d’Orchestra installée' + (u.version ? ' (v' + u.version + ')' : '') + '.'));
          var go = el('button', 'btn2 upd-go', 'Relancer'); go.type = 'button'; go.addEventListener('click', rlOpen); upd.appendChild(go);
        }
        rlSeen(j.app);
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
  var launch = window.OrchestraLaunch; // #375: the « Nouveau workspace » screen (launch.js) — absent in a shell without it
  function route() {
    var m2 = /^#w=([A-Za-z0-9-]{1,64})$/.exec(location.hash);
    var home = document.getElementById('home');
    if (m2) {
      // right after a launch the list has not refreshed yet: the launch screen knows the row it just made
      var w = last.filter(function (x) { return x.id === m2[1]; })[0] || (launch && launch.meta(m2[1]));
      if (launch) launch.close();
      home.hidden = true; conv.open(m2[1], w || { name: m2[1] }, last.filter(function (x) { return x.status === 'waiting' && x.id !== m2[1]; }).length, below(m2[1]));
    } else if (location.hash === '#new' && launch) { conv.close(); home.hidden = true; launch.open(); }
    else { conv.close(); if (launch) launch.close(); home.hidden = false; load(); }
  }
  // The listed rows under \`id\` (parentId = nearest listed ancestor): what an archive takes with it. Cycle-safe (a walk stops at a repeat).
  function below(id) {
    var by = {}; last.forEach(function (x) { by[x.id] = x; });
    return last.filter(function (x) {
      if (x.id === id) return false;
      var seen = {}, p = x.parentId;
      while (p && by[p] && !seen[p]) { if (p === id) return true; seen[p] = 1; p = by[p].parentId; }
      return false;
    }).length;
  }
  // « Relancer Orchestra » (Lucas 2026-10-20): the desktop banner's quit + exec of the installed app. Confirmed first (the phone is cut
  // off while it restarts, and cannot restart an app that fails to start); then « relancé » only once a NEW app answers — its
  // \`app.startedAt\` differs from the one seen before the tap (a stream blip is not a relaunch); past 2 min it says so, still waiting.
  var rlEl = document.getElementById('relaunch'), rlMsg = document.getElementById('rlMsg');
  var rlGo = document.getElementById('rlGo'), rlCancel = document.getElementById('rlCancel');
  var update = null, appNow = null, rl = { state: 'idle', from: null, at: 0, poll: null, hide: null };
  function rlShow(state, msg) {
    rl.state = state; rlEl.dataset.state = state; rlEl.hidden = state === 'idle'; rlMsg.textContent = msg || '';
    rlGo.hidden = !(state === 'confirm' || state === 'error'); rlGo.disabled = false; rlGo.textContent = state === 'error' ? 'Réessayer' : 'Relancer';
    rlCancel.hidden = state === 'busy'; rlCancel.textContent = state === 'confirm' || state === 'error' ? 'Annuler' : 'OK';
  }
  function rlStop() { if (rl.poll) clearInterval(rl.poll); if (rl.hide) clearTimeout(rl.hide); rl.poll = null; rl.hide = null; }
  function rlOpen() {
    if (rl.state === 'busy' || rl.state === 'wait' || rl.state === 'late') return;
    rlStop();
    rlShow('confirm', 'Relancer Orchestra' + (update && update.version ? ' en v' + update.version : '') + ' ? L’app quitte puis redémarre : le téléphone perd la connexion une trentaine de secondes, les agents continuent. Si elle ne redémarre pas, seul l’ordinateur pourra la relancer.');
  }
  function rlWait(lost) {
    rl.at = Date.now();
    rlShow('wait', (lost ? 'Réponse perdue : Orchestra redémarre peut-être. ' : 'Orchestra redémarre… ') + 'Le téléphone se reconnecte tout seul.');
    rl.poll = setInterval(function () {
      if (rl.state === 'wait' && Date.now() - rl.at > 120000) rlShow('late', 'Orchestra n’a pas répondu depuis 2 min : la relance a peut-être échoué. Vérifie sur l’ordinateur — le téléphone continue d’attendre.');
      load();
    }, 3000);
  }
  /** Every list answer: a NEW app (another startedAt than before the tap) ends the wait. */
  function rlSeen(a) {
    if (a && typeof a.startedAt === 'number') appNow = a;
    if ((rl.state !== 'wait' && rl.state !== 'late') || !appNow || appNow.startedAt === rl.from) return;
    rlStop();
    rlShow('done', 'Orchestra relancé (v' + appNow.version + ').');
    rl.hide = setTimeout(function () { if (rl.state === 'done') rlShow('idle'); }, 8000);
  }
  function rlRun() {
    if (rl.state !== 'confirm' && rl.state !== 'error') return;
    rl.from = appNow ? appNow.startedAt : null;
    rlShow('busy', 'Relance…');
    fetch('/api/relaunch', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { rlShow('idle'); load(); return null; }
        if (r.status === 429) { rlShow('error', 'Trop de demandes en cours : réessaie dans un instant.'); return null; }
        if (r.status === 502) { rlWait(true); return null; } // main's channel closed: maybe the quit
        if (!r.ok) { rlShow('error', 'Relance refusée (' + r.status + ') : rien n’a été relancé.'); return null; }
        return r.json();
      })
      .then(function (j) {
        if (!j) return;
        if (j.ok) rlWait(false);
        else rlShow('error', 'Relance impossible : ' + (j.error || 'refusée') + '. Orchestra tourne toujours.');
      })
      .catch(function () { if (rl.state === 'busy') rlWait(true); });
  }
  rlShow('idle');
  document.getElementById('relaunchBtn').addEventListener('click', rlOpen);
  rlGo.addEventListener('click', rlRun);
  rlCancel.addEventListener('click', function () { rlStop(); rlShow('idle'); });
  document.getElementById('newBtn').addEventListener('click', function () { location.hash = 'new'; });
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
