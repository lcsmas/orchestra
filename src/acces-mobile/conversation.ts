// The phone's conversation screen + the live stream (#337), in design V1 « Boîte de réception » (#335 pick, #340). A separate
// static asset so the shell (page.ts) only routes to it. Rendering is textContent-only: agent and user text can contain anything,
// it must never become markup. The stream is read with fetch() (EventSource cannot send the bearer header, and the token must
// never travel in a URL). Class names the e2e rig and tests read (conv-lines, [data-kind], ask-opt[data-label], ask-submit,
// conv-input, conv-send, conv-compose[data-state], conv-send-error) are part of the contract — the V1 classes ride beside them.

import { parseMarkdown } from '../shared/mini-markdown.ts';
import { MOBILE_ATTACH_MAX_BODY, MOBILE_ATTACH_MAX_COUNT } from '../shared/acces-mobile-conversation.ts';
import { TOOL_GLYPH } from '../shared/tool-line.ts';

export const CONVERSATION_JS = `(function () {
  'use strict';
  // The Markdown parser (shared/mini-markdown.ts, unit-tested) — self-contained, so its source can be injected as is.
  var mdParse = (${parseMarkdown.toString()});
  var KEY = 'orchestra.accesMobile.token';
  function token() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function auth() { return { Authorization: 'Bearer ' + token() }; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // ---- live stream: one per page, shared by the list and the conversation ----
  var handlers = [];
  var backoff = 1000;
  var ctrl = null;
  // A stream that stops delivering bytes without ending (a half-open connection, a proxy that lost its upstream) would leave the page
  // « en ligne » on a dead feed: main pings every 25 s, so 60 s of silence = dead — drop it and reconnect.
  var STALL_MS = 60000;
  function onStream(fn) { handlers.push(fn); }
  function emit(m) { handlers.forEach(function (h) { h(m); }); }
  function connect() {
    if (!token()) return;
    if (ctrl) ctrl.abort();
    var c = new AbortController(); ctrl = c;
    var lastByte = Date.now(), stalled = false;
    var dog = setInterval(function () {
      if (ctrl !== c) { clearInterval(dog); return; }
      if (Date.now() - lastByte > STALL_MS) { clearInterval(dog); stalled = true; c.abort(); }
    }, 5000);
    fetch('/api/stream', { headers: auth(), cache: 'no-store', signal: c.signal }).then(function (r) {
      if (!r.ok || !r.body) { var er = new Error('status ' + r.status); er.status = r.status; throw er; }
      var healthy = false;
      var reader = r.body.getReader(); var dec = new TextDecoder(); var buf = '';
      function pump() {
        return reader.read().then(function (x) {
          if (x.done) throw new Error('ended');
          lastByte = Date.now();
          buf += dec.decode(x.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\\n\\n')) >= 0) {
            var block = buf.slice(0, i); buf = buf.slice(i + 2);
            // Only a REAL message proves main is behind the stream (the server answers 200 even when main is gone): reset the
            // backoff then, and catch up — on EVERY healthy (re)connect, the first one too (a page loaded during an outage).
            if (!healthy && block !== ': open') {
              healthy = true; backoff = 1000;
              emit({ t: 'resume' });
            }
            if (block.indexOf('data: ') === 0) {
              try { emit(JSON.parse(block.slice(6))); } catch (e) {}
            }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      clearInterval(dog);
      if (c.signal.aborted && !stalled) return; // replaced by a newer connect()
      // a refused token (401) is told at once — the list then says « Jeton refusé » and offers pairing (not at the next 30 s poll)
      emit({ t: 'down', status: e && e.status });
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000);
    });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { backoff = 1000; connect(); emit({ t: 'resume' }); } });

  // ---- conversation screen ----
  var root = null, current = null, meta = null, version = -1, inflight = false, again = false, lastFetch = 0, lastConv = null;
  var STATE = ${JSON.stringify(TOOL_GLYPH)}; // the desktop's tool lines read the same map (shared/tool-line.ts)
  // Markdown → DOM, textContent only (the parser returns plain strings; nothing becomes markup). Links: http(s) only.
  function spansInto(parent, spans) {
    spans.forEach(function (s) {
      var n;
      if (s.t === 'b') n = el('strong', null, s.text);
      else if (s.t === 'i') n = el('em', null, s.text);
      else if (s.t === 'code') n = el('code', null, s.text);
      else if (s.t === 'a' && /^https?:\\/\\//.test(s.href)) { n = el('a', null, s.text); n.href = s.href; n.target = '_blank'; n.rel = 'noopener noreferrer'; }
      else n = document.createTextNode(s.text);
      parent.appendChild(n);
    });
    return parent;
  }
  function md(text) {
    var frag = document.createDocumentFragment();
    var blocks;
    try { blocks = mdParse(text); } catch (e) { blocks = [{ t: 'p', spans: [{ t: 'text', text: text }] }]; }
    blocks.forEach(function (b) {
      var n;
      if (b.t === 'p') n = spansInto(el('p'), b.spans);
      else if (b.t === 'h') n = spansInto(el('p', 'mdh mdh' + Math.min(b.level, 4)), b.spans);
      else if (b.t === 'code') { n = el('pre'); n.appendChild(el('code', null, b.text)); }
      else if (b.t === 'ul' || b.t === 'ol') { n = el(b.t); b.items.forEach(function (it) { n.appendChild(spansInto(el('li'), it)); }); }
      else if (b.t === 'quote') n = spansInto(el('blockquote'), b.spans);
      else if (b.t === 'table') { var wrap = el('div', 'mdt'); var t = el('table'); b.rows.forEach(function (r, ri) { var tr = el('tr'); r.forEach(function (c) { tr.appendChild(spansInto(el(ri === 0 ? 'th' : 'td'), c)); }); t.appendChild(tr); }); wrap.appendChild(t); n = wrap; }
      else if (b.t === 'hr') n = el('hr');
      if (n) frag.appendChild(n);
    });
    return frag;
  }
  function acct(name) { return el('span', 'acct a-' + String(name).replace(/[^a-z0-9-]/gi, '').toLowerCase(), name); }

  function render(c) {
    lastConv = c;
    var list = root.querySelector('.conv-lines');
    // The PAGE scrolls (not the list): open at the END — the latest messages and the question are what matter (Lucas,
    // 2026-10-12) — and follow new messages only while the reader is already near the bottom.
    var se = document.scrollingElement || document.documentElement;
    var nearBottom = se.scrollHeight - se.scrollTop - se.clientHeight < 120;
    list.textContent = '';
    if (c.truncated) list.appendChild(el('div', 'conv-more', c.truncated + ' messages plus anciens sur le bureau'));
    var tools = null; // consecutive tool lines share one compact block (V1)
    c.lines.forEach(function (l) {
      var row;
      if (l.kind === 'tool' || l.kind === 'command') {
        if (!tools) { tools = el('div', 'tools'); list.appendChild(tools); }
        row = el('div', 'tool tl ' + l.state);
        row.appendChild(el('span', 'tg', STATE[l.state]));
        row.appendChild(document.createTextNode(' ' + l.label));
        row.dataset.kind = l.kind; row.dataset.id = l.id;
        tools.appendChild(row);
        return;
      }
      tools = null;
      if (l.kind === 'user') { row = el('div', 'msg user u', l.text); if (l.attachments && l.attachments.length) row.appendChild(el('div', 'msg-atts', attLabel(l.attachments))); }
      else if (l.kind === 'assistant') { row = el('div', 'msg assistant a md' + (l.streaming ? ' streaming' : '')); row.appendChild(md(l.text)); }
      else row = el('div', 'notice' + (l.error ? ' error' : ''), l.text);
      row.dataset.kind = l.kind; row.dataset.id = l.id;
      list.appendChild(row);
    });
    var asks = root.querySelector('.conv-asks'); asks.textContent = '';
    c.asks.forEach(function (a) {
      var box = el('div', a.kind === 'askUser' ? 'ask' : 'ask elic'); box.dataset.kind = a.kind;
      if (a.kind === 'askUser') renderAskUser(box, a);
      else {
        box.appendChild(el('div', 'elic-h', 'Demande d’un serveur MCP'));
        box.appendChild(el('p', 'ask-q', a.title));
        box.appendChild(el('div', 'desk', 'À traiter sur le bureau'));
      }
      asks.appendChild(box);
    });
    var running = root.querySelector('.conv-running'); running.hidden = !c.running;
    var pill = root.querySelector('.pill');
    var waiting = c.asks.length > 0;
    pill.className = 'pill ' + (waiting ? 'wait' : c.running ? 'run' : 'idle');
    pill.textContent = waiting ? 'en attente' : c.running ? 'en cours' : 'inactif';
    root.dataset.version = String(c.version);
    if (nearBottom || version < 0) se.scrollTop = se.scrollHeight;
    version = c.version;
  }

  // #339: answering an AskUserQuestion. The selection survives re-renders (every stream announcement redraws the screen).
  var picks = Object.create(null); // requestId -> question -> { labels: [], other: '' } — no prototype: a question may be named anything
  var status = Object.create(null); // requestId -> { text, sending }
  function renderAskUser(box, a) {
    var st = picks[a.requestId] || (picks[a.requestId] = Object.create(null));
    var ss = status[a.requestId] || (status[a.requestId] = { text: '', sending: false });
    box.appendChild(el('div', 'ask-h', a.questions.length > 1 ? a.questions.length + ' questions' : 'Question'));
    var syncs = [];
    a.questions.forEach(function (q) {
      var cur = st[q.question] || (st[q.question] = { labels: [], other: '' });
      if (q.header && a.questions.length > 1) box.appendChild(el('div', 'ask-hd', q.header));
      box.appendChild(el('h3', 'ask-q', q.question));
      var opts = el('div', 'ask-opts');
      q.options.forEach(function (o, i) {
        var b = el('button', 'ask-opt opt'); b.type = 'button'; b.dataset.label = o.label;
        b.appendChild(el('span', 'n', String(i + 1)));
        var ot = el('span', 'ot'); ot.appendChild(el('b', null, o.label)); if (o.description) ot.appendChild(el('small', null, o.description));
        b.appendChild(ot);
        if (cur.labels.indexOf(o.label) >= 0) b.className += ' picked';
        b.addEventListener('click', function () {
          var k = cur.labels.indexOf(o.label);
          if (q.multiSelect) { if (k >= 0) cur.labels.splice(k, 1); else cur.labels.push(o.label); }
          else { cur.labels = k >= 0 ? [] : [o.label]; cur.other = ''; }
          if (lastConv) render(lastConv);
        });
        opts.appendChild(b);
      });
      box.appendChild(opts);
      var other = el('input', 'ask-other other'); other.placeholder = 'Autre réponse…'; other.value = cur.other; other.maxLength = 2000;
      other.addEventListener('input', function () {
        cur.other = other.value;
        if (!q.multiSelect && other.value.trim() && cur.labels.length) { cur.labels = []; opts.querySelectorAll('.picked').forEach(function (p) { p.className = p.className.replace(' picked', ''); }); }
        syncs.forEach(function (f) { f(); });
      });
      box.appendChild(other);
    });
    var submit = el('button', 'ask-submit btn', 'Répondre'); submit.type = 'button';
    var said = el('div', 'ask-status', ss.text); said.setAttribute('role', 'status');
    function answers() {
      var out = Object.create(null); var complete = true;
      a.questions.forEach(function (q) {
        var cur = st[q.question]; var l = cur.labels.slice();
        if (cur.other.trim()) { if (q.multiSelect) l.push(cur.other.trim()); else l = [cur.other.trim()]; }
        if (!l.length) complete = false;
        out[q.question] = l;
      });
      return complete ? out : null;
    }
    function sync() { submit.disabled = !answers() || ss.sending; }
    syncs.push(sync);
    submit.addEventListener('click', function () {
      var ans = answers(); if (!ans) return;
      ss.sending = true; sync(); said.textContent = 'Envoi…';
      fetch('/api/answer?id=' + encodeURIComponent(current) + '&request=' + encodeURIComponent(a.requestId), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth()), body: JSON.stringify({ answers: ans }) })
        .then(function (r) { return r.ok ? r.json() : { ok: false, error: r.status === 401 ? 'Jeton refusé.' : r.status === 429 ? 'Trop d’envois en cours, réessaie.' : 'Orchestra injoignable : la réponse n’est peut-être pas partie.' }; })
        .then(function (res) { ss.text = res && res.ok ? 'Réponse envoyée.' : ((res && res.error) || 'Échec.'); box.dataset.state = res && res.ok ? 'answered' : 'error'; said.textContent = ss.text; fetchConv(); })
        .catch(function () { ss.text = 'Réseau coupé : la réponse n’est peut-être pas partie.'; said.textContent = ss.text; })
        .then(function () { ss.sending = false; sync(); });
    });
    sync();
    box.appendChild(submit); box.appendChild(said);
  }

  function fetchConv() {
    if (!current) return;
    if (inflight) { again = true; return; }
    var wait = Math.max(0, 1000 - (Date.now() - lastFetch));
    inflight = true;
    setTimeout(function () {
      var id = current; lastFetch = Date.now();
      fetch('/api/conversation?id=' + encodeURIComponent(id), { headers: auth(), cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (c) {
          if (id !== current) return;
          var stEl = root.querySelector('.conv-state');
          if (c && c.ok) { stEl.textContent = ''; stEl.className = 'conv-state'; render(c); }
          else { stEl.textContent = c ? 'Workspace introuvable.' : 'Orchestra injoignable.'; stEl.className = 'conv-state offline'; }
        })
        .catch(function () { var stEl = root.querySelector('.conv-state'); stEl.textContent = 'Orchestra injoignable.'; stEl.className = 'conv-state offline'; })
        .then(function () { inflight = false; if (again) { again = false; fetchConv(); } });
    }, wait);
  }
  onStream(function (m) {
    if (!current) return;
    if ((m.t === 'conv' && m.id === current && m.v !== version) || m.t === 'resume') fetchConv();
  });

  // Files attached on the phone (Lucas 2026-10-12): images + PDFs, sent as the desktop composer's paste/drop attachments.
  var ATTACH_MAX = ${MOBILE_ATTACH_MAX_COUNT}, ATTACH_BODY = ${MOBILE_ATTACH_MAX_BODY}, IMG_EDGE = 1568;
  var API_IMG = { 'image/png': 1, 'image/jpeg': 1, 'image/gif': 1, 'image/webp': 1 };
  function attLabel(kinds) {
    var i = kinds.filter(function (k) { return k === 'image'; }).length, p = kinds.length - i, out = [];
    if (i) out.push('🖼 ' + i + ' image' + (i > 1 ? 's' : ''));
    if (p) out.push('📄 ' + p + ' PDF');
    return out.join(' · ');
  }
  function readDataUrl(file) { return new Promise(function (ok, ko) { var r = new FileReader(); r.onload = function () { ok(String(r.result || '')); }; r.onerror = function () { ko(r.error); }; r.readAsDataURL(file); }); }
  function splitDataUrl(u) { var m = /^data:([^;,]+)[^,]*;base64,(.*)$/.exec(u); return m ? { mediaType: m[1], dataBase64: m[2] } : null; }
  // One phone file → an attachment. A picture is redrawn to ≤ IMG_EDGE px as JPEG (the API scales anything bigger down anyway,
  // and a phone photo would cost megabytes on the uplink); one already small and in an API type goes as is; a PDF goes as is.
  function prepareFile(file) {
    var type = file.type || '';
    if (type === 'application/pdf') return readDataUrl(file).then(function (u) { var d = splitDataUrl(u); if (!d) throw new Error('read'); return { mediaType: 'application/pdf', dataBase64: d.dataBase64, url: '', name: file.name || 'document.pdf', kind: 'pdf' }; });
    if (type.indexOf('image/') !== 0) return Promise.reject(new Error('type'));
    return readDataUrl(file).then(function (u) {
      return new Promise(function (ok, ko) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, IMG_EDGE / Math.max(w, h)), d = splitDataUrl(u);
          if (k === 1 && API_IMG[type] && file.size <= 3500000 && d) return ok({ mediaType: type, dataBase64: d.dataBase64, url: u, name: file.name || 'image', kind: 'image' });
          var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
          var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
          var out = c.toDataURL('image/jpeg', 0.88), o = splitDataUrl(out);
          if (!o) return ko(new Error('encode'));
          ok({ mediaType: 'image/jpeg', dataBase64: o.dataBase64, url: out, name: file.name || 'image', kind: 'image' });
        };
        img.onerror = function () { ko(new Error('decode')); };
        img.src = u;
      });
    });
  }

  // #338: the composer — the message goes the desktop composer's way (queued if mid-turn). Never claims « sent » on a doubt.
  function composer(id) {
    var form = el('form', 'conv-compose cmp');
    var err = el('div', 'conv-send-error toast', ''); err.setAttribute('role', 'alert');
    var tray = el('div', 'conv-atts atts'); tray.hidden = true;
    var fld = el('div', 'fld');
    var file = el('input', 'conv-file'); file.type = 'file'; file.multiple = true; file.accept = 'image/*,application/pdf'; file.hidden = true;
    var add = el('button', 'conv-attach att', '+'); add.type = 'button'; add.setAttribute('aria-label', 'Joindre une image ou un PDF');
    var ta = el('textarea', 'conv-input'); ta.rows = 1; ta.placeholder = 'Message à l’agent…'; ta.maxLength = 32000;
    var btn = el('button', 'conv-send send', '↑'); btn.type = 'submit'; btn.setAttribute('aria-label', 'Envoyer');
    var atts = [];
    function canSend() { return !!ta.value.trim() || atts.length > 0; }
    function syncBtn() { btn.className = 'conv-send send' + (canSend() ? ' on' : ''); }
    function drawTray() {
      tray.textContent = ''; tray.hidden = !atts.length;
      atts.forEach(function (a, i) {
        var t = el('div', 'conv-att att-' + a.kind); t.dataset.kind = a.kind;
        if (a.kind === 'image') { var im = el('img'); im.src = a.url; im.alt = a.name; t.appendChild(im); }
        else t.appendChild(el('span', 'att-pdf', 'PDF · ' + a.name));
        var x = el('button', 'conv-att-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Retirer ' + a.name);
        x.addEventListener('click', function () { atts.splice(i, 1); drawTray(); syncBtn(); });
        t.appendChild(x); tray.appendChild(t);
      });
    }
    function addFiles(list) {
      var files = Array.prototype.slice.call(list || []);
      if (!files.length) return;
      err.textContent = '';
      var room = Math.max(0, ATTACH_MAX - atts.length);
      if (files.length > room) { err.textContent = 'Au plus ' + ATTACH_MAX + ' pièces jointes.'; files = files.slice(0, room); }
      if (!files.length) return;
      form.dataset.attaching = '1';
      Promise.all(files.map(function (f) {
        return prepareFile(f).then(null, function (e) { return { error: e && e.message === 'type' ? 'Seuls les images et les PDF passent.' : 'Fichier illisible : ' + (f.name || '?') }; });
      })).then(function (res) {
        res.forEach(function (r) { if (r.error) err.textContent = r.error; else if (atts.length < ATTACH_MAX) atts.push(r); });
        delete form.dataset.attaching; drawTray(); syncBtn();
      });
    }
    add.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () { addFiles(file.files); file.value = ''; });
    // A picture pasted into the field (a screenshot copied on the phone) is attached; pasted text stays text.
    ta.addEventListener('paste', function (ev) {
      var cd = ev.clipboardData; if (!cd) return;
      var files = Array.prototype.slice.call(cd.files || []);
      if (!files.length && cd.items) Array.prototype.forEach.call(cd.items, function (it) { if (it.kind === 'file') { var f = it.getAsFile(); if (f) files.push(f); } });
      if (!files.length) return;
      if (!cd.getData('text/plain')) ev.preventDefault();
      addFiles(files);
    });
    ta.addEventListener('input', function () { syncBtn(); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; });
    fld.appendChild(add); fld.appendChild(ta); fld.appendChild(btn);
    form.appendChild(err); form.appendChild(tray); form.appendChild(fld); form.appendChild(file);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = ta.value.trim();
      if (!canSend() || btn.disabled || form.dataset.attaching) return;
      var payload = { text: text };
      if (atts.length) payload.attachments = atts.map(function (a) { return { mediaType: a.mediaType, dataBase64: a.dataBase64 }; });
      var body = JSON.stringify(payload);
      if (body.length > ATTACH_BODY) { err.textContent = 'Pièces jointes trop lourdes (20 Mo max).'; form.dataset.state = 'error'; return; }
      btn.disabled = true; ta.disabled = true; add.disabled = true; err.textContent = ''; form.dataset.state = 'sending';
      fetch('/api/send?id=' + encodeURIComponent(id), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth()), body: body })
        .then(function (r) {
          if (r.status === 401) return { ok: false, error: 'Jeton refusé : re-scanne le QR code.' };
          if (r.status === 413) return { ok: false, error: 'Pièces jointes trop lourdes (20 Mo max).' };
          if (r.status === 429) return { ok: false, error: 'Trop d’envois en cours, réessaie dans un instant.' };
          if (r.status === 502) return { ok: false, error: 'Orchestra injoignable : le message n’est peut-être pas parti, vérifie la conversation.' };
          if (!r.ok) return { ok: false, error: 'Refusé (' + r.status + ').' };
          return r.json();
        })
        .then(function (res) {
          if (res && res.ok) { ta.value = ''; atts = []; drawTray(); syncBtn(); form.dataset.state = 'sent'; fetchConv(); }
          else { err.textContent = (res && res.error) || 'Échec de l’envoi.'; form.dataset.state = 'error'; }
        })
        .catch(function () { err.textContent = 'Réseau coupé : le message n’est peut-être pas parti, vérifie la conversation.'; form.dataset.state = 'error'; })
        .then(function () { btn.disabled = false; ta.disabled = false; add.disabled = false; });
    });
    return form;
  }

  function open(id, row, othersWaiting) {
    current = id; meta = row || { name: id }; version = -1;
    root = document.getElementById('conv');
    root.textContent = '';
    var head = el('div', 'ch');
    var back = el('button', 'conv-back back', '‹'); back.type = 'button'; back.setAttribute('aria-label', 'Workspaces');
    back.addEventListener('click', function () { location.hash = ''; });
    head.appendChild(back);
    if (othersWaiting) head.appendChild(el('span', 'bk', String(othersWaiting)));
    var ct = el('div', 'ct'); ct.appendChild(el('b', 'conv-title', meta.displayName || meta.name || id));
    var cs = el('div', 'cs');
    if (meta.group) cs.appendChild(el('span', null, meta.group + (meta.branch ? ' · ' + meta.branch : '')));
    if (meta.account) cs.appendChild(acct(meta.account));
    ct.appendChild(cs); head.appendChild(ct);
    head.appendChild(el('span', 'pill idle', 'inactif'));
    root.appendChild(head);
    root.appendChild(el('div', 'conv-state', ''));
    var lines = el('div', 'conv-lines stream'); root.appendChild(lines);
    var running = el('div', 'conv-running working', 'L’agent travaille…'); running.hidden = true; root.appendChild(running);
    root.appendChild(el('div', 'conv-asks'));
    root.appendChild(composer(id));
    root.dataset.id = id;
    root.hidden = false;
    fetch('/api/seen?id=' + encodeURIComponent(id), { method: 'POST', headers: auth() }).catch(function () {});
    fetchConv();
  }
  function close() { current = null; lastConv = null; version = -1; if (root) { root.hidden = true; root.textContent = ''; } }

  window.OrchestraConversation = { open: open, close: close, onStream: onStream, connect: connect };
})();
`;

/** The ONE stylesheet of the phone (V1 « Boîte de réception »): tokens from Orchestra's desktop agent view, dark; system fonts
 *  (no font files shipped). Ported from prototypes/acces-mobile-mockups/v1-boite/style.css (branch acces-mobile-mockups). */
export const CONVERSATION_CSS = `
.v1{--surface:#1a1f26;--raised:#1f242c;--sunken:#14181e;--hair:#262d37;--hair2:#353b45;--hairf:rgba(255,255,255,.055);--text:#eef1f5;--dim:#8f99a9;--faint:#737e92;--accent:#6ea8ff;--ink:#081022;--amber:#ffb62e;--yellow:#ffc857;--green:#5bd68b;--red:#ff6b6b;--violet:#9d8fff;--teal:#4fd1c5;--work:#f0b90b;--mono:ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box}
html,body{margin:0;background:#1a1f26}
/* the app draws under the iOS status bar (black-translucent): this strip keeps scrolled content (and the sticky header) out of it */
body.v1::before{content:"";position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top);background:var(--surface);z-index:40;pointer-events:none}
body.v1{background:var(--surface);color:var(--text);font:15px/1.4 -apple-system,system-ui,"Inter",sans-serif;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
.v1 button,.v1 input,.v1 textarea{font:inherit;color:inherit;background:none;border:0}
.v1 button{cursor:pointer}
.v1 [hidden]{display:none!important}
.v1 .col{min-height:100vh;display:flex;flex-direction:column;padding-top:env(safe-area-inset-top)}
.v1 ul{list-style:none;margin:0;padding:0}
.v1 h1,.v1 h2,.v1 h3,.v1 p{margin:0}
.v1 .top{padding:6px 20px 0}
.v1 .tt{display:flex;align-items:center;justify-content:space-between;height:42px}
.v1 h1{font-size:28px;font-weight:650;letter-spacing:-.025em}
.v1 .live{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dim)}
.v1 .live i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 8px rgba(91,214,139,.7)}
.v1 .live.off{color:var(--red)} .v1 .live.off i{background:var(--red);box-shadow:0 0 8px rgba(255,107,107,.7)}
.v1 .seg{display:flex;gap:8px;padding:10px 0 12px}
.v1 .seg button{display:flex;align-items:center;gap:7px;height:36px;padding:0 15px;border-radius:18px;border:1px solid var(--hair2);font-size:14.5px;font-weight:500;color:var(--dim)}
.v1 .seg button b{font-family:var(--mono);font-weight:500;font-size:12.5px;color:var(--faint)}
.v1 .seg button.on{background:#eef1f5;border-color:#eef1f5;color:#0a0b0d}
.v1 .seg button.on b{color:#3b4350}
.v1 .seg button b.hot{background:var(--amber);color:#1a1100;border-radius:9px;padding:1px 6px;font-weight:700}
.v1 .scroll{flex:1;border-top:1px solid var(--hair);padding-bottom:calc(20px + env(safe-area-inset-bottom))}
#state.hint-state{padding:30px 40px;text-align:center;color:var(--dim)}
.v1 .offline{margin:0 16px 12px;padding:14px;border:1px solid rgba(255,107,107,.45);background:rgba(255,107,107,.09);border-radius:14px;color:var(--red);font-weight:600}
.v1 h2.sub{display:flex;align-items:center;gap:7px;padding:14px 20px 7px;font:700 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.v1 h2 b{font-weight:500;color:var(--faint)}
.v1 h2.sub.w{color:var(--amber)} .v1 h2.sub.w .d{width:8px;height:8px;border-radius:50%;background:var(--yellow);box-shadow:0 0 8px rgba(255,200,87,.6)}
.v1 h2.sub.w b{color:rgba(255,182,46,.65)}
.v1 h2.sub.un{color:var(--accent)} .v1 h2.sub.un b{color:rgba(110,168,255,.6)}
.v1 h2.rh{display:flex;align-items:center;gap:7px;padding:16px 20px 6px;font:700 11.5px var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--dim);border-top:1px solid var(--hairf)}
.v1 .row{display:grid;grid-template-columns:22px 1fr;gap:12px;padding:12px 20px;border-bottom:1px solid var(--hairf);cursor:pointer}
.v1 .row.small{padding:10px 20px}
.v1 .row.waiting{background:rgba(255,200,87,.055);box-shadow:inset 3px 0 0 var(--amber)}
.v1 .rb{min-width:0}
.v1 .r1{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.v1 .r1 b{font-size:16px;font-weight:620;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v1 .row.small .r1 b{font-size:15.5px;font-weight:500}
.v1 .row.unread .r1 b,.v1 .row.waiting .r1 b{font-weight:680}
.v1 time{font:11px var(--mono);color:var(--faint);white-space:nowrap;flex:none}
.v1 .r2{display:flex;align-items:center;gap:8px;margin-top:3px;font-size:11.5px;color:var(--dim);min-width:0}
.v1 .r2 .repo{flex:none;color:var(--text);opacity:.75;font:500 11.5px var(--mono)}
.v1 .r2 .br{font-family:var(--mono);color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}
.v1 .r2 .stl{font-family:var(--mono);color:var(--dim);flex:none}
.v1 .r2 .acct{margin-left:auto}
.v1 .pv{margin-top:6px;font-size:14px;line-height:1.38;color:#c3cad6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.v1 .pv em{font:700 10.5px var(--mono);font-style:normal;letter-spacing:.06em;text-transform:uppercase;margin-right:6px;color:var(--accent)}
.v1 .row.waiting .pv{color:var(--text)} .v1 .row.waiting .pv em{color:var(--amber)}
.v1 .acct{font:10.5px/1 var(--mono);padding:3px 6px;border-radius:5px;border:1px solid var(--hair2);color:var(--dim);flex:none}
.v1 .a-perso{color:var(--teal);border-color:rgba(79,209,197,.4);background:rgba(79,209,197,.08)}
.v1 .a-mc{color:var(--violet);border-color:rgba(157,143,255,.42);background:rgba(157,143,255,.09)}
.v1 .row.child{padding-left:42px;background:rgba(255,255,255,.015)}
.v1 .row.unread .stl{color:var(--accent)}
.v1 .fold{display:flex;align-items:center;gap:10px;padding:8px 20px 8px 54px;font:12px var(--mono);color:var(--dim);border-bottom:1px solid var(--hairf);cursor:pointer}
.v1 .fold-arrow{width:10px;color:var(--faint)} .v1 .fold-run{color:var(--work)} .v1 .fold-unread{color:var(--accent)}
.v1 .fold-owner{padding:10px 20px;font-size:13px;color:var(--faint)}
.v1 .g{width:22px;height:22px;display:grid;place-items:center;margin-top:1px}
.v1 .g::before{content:"";display:block}
.v1 .g-wait::before{width:12px;height:12px;border-radius:50%;background:var(--yellow);box-shadow:0 0 10px rgba(255,200,87,.65)}
.v1 .g-unread::before{width:10px;height:10px;border-radius:50%;border:2px solid var(--accent)}
.v1 .g-run::before{width:12px;height:12px;border-radius:50%;border:2px solid var(--work);border-right-color:transparent}
.v1 .g-idle::before{width:9px;height:9px;border-radius:50%;background:var(--dim);opacity:.55}
.v1 .g-err::before{content:"×";color:var(--red);font-weight:700;font-size:18px;line-height:1}
.v1 .g-stop::before{width:8px;height:8px;border-radius:2px;background:#5b6370}
.v1 .ch{position:sticky;top:env(safe-area-inset-top);z-index:2;display:flex;align-items:center;gap:6px;padding:4px 16px 10px 8px;border-bottom:1px solid var(--hair);min-height:58px;background:var(--surface)}
.v1 .back{color:var(--accent);font-size:30px;line-height:1;padding:0 8px}
.v1 .bk{min-width:19px;height:19px;margin-left:-6px;border-radius:10px;background:var(--amber);color:#1a1100;font:700 11.5px/19px var(--mono);text-align:center}
.v1 .ct{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.v1 .ct b{font-size:17px;font-weight:650;letter-spacing:-.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v1 .cs{display:flex;align-items:center;gap:6px;font:11.5px var(--mono);color:var(--faint);min-width:0}
.v1 .cs>span:not(.acct){white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v1 .pill{flex:none;font:600 11.5px/1 var(--mono);padding:6px 9px;border-radius:8px;border:1px solid}
.v1 .pill.wait{color:var(--amber);border-color:rgba(255,182,46,.5);background:rgba(255,182,46,.1)}
.v1 .pill.run{color:var(--work);border-color:rgba(240,185,11,.45);background:rgba(240,185,11,.09)}
.v1 .pill.idle{color:var(--dim);border-color:var(--hair2)}
.v1 .conv-state:empty{display:none}
.v1 .stream{flex:1;display:flex;flex-direction:column;gap:14px;padding:14px 20px}
.v1 .conv-more{font:12px var(--mono);color:var(--faint);text-align:center}
.v1 .msg{white-space:pre-wrap;word-break:break-word}
.v1 .msg.u{align-self:flex-end;max-width:84%;background:#272e38;border-radius:18px 18px 5px 18px;padding:10px 14px;font-size:15.5px;line-height:1.42}
.v1 .md{white-space:normal}
.v1 .md>*+*{margin-top:8px}
.v1 .md p{white-space:pre-wrap}
.v1 .md .mdh{font-weight:680;letter-spacing:-.01em;color:var(--text)} .v1 .md .mdh1{font-size:19px} .v1 .md .mdh2{font-size:17.5px} .v1 .md .mdh3,.v1 .md .mdh4{font-size:16px}
.v1 .md ul,.v1 .md ol{margin:0;padding-left:22px} .v1 .md li+li{margin-top:3px}
.v1 .md code{font:13px var(--mono);padding:1.5px 5px;border-radius:5px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.07)}
.v1 .md pre{margin:0;padding:10px 12px;border-radius:10px;background:var(--sunken);border:1px solid var(--hair);overflow-x:auto}
.v1 .md pre code{padding:0;border:0;background:none;font-size:12.5px;white-space:pre}
.v1 .md blockquote{margin:0;padding-left:12px;border-left:3px solid var(--hair2);color:var(--dim);white-space:pre-wrap}
.v1 .md a{color:var(--accent)}
.v1 .md hr{border:0;border-top:1px solid var(--hair2)}
.v1 .mdt{overflow-x:auto} .v1 .md table{border-collapse:collapse;font-size:13.5px} .v1 .md th,.v1 .md td{border:1px solid var(--hair2);padding:4px 8px;text-align:left} .v1 .md th{color:var(--dim)}
.v1 .msg.a{font-size:16px;line-height:1.55;color:#e6e9ef}
.v1 .msg.a.streaming::after{content:"";display:inline-block;width:8px;height:17px;margin-left:2px;vertical-align:-3px;background:var(--accent);border-radius:1px}
.v1 .tools{display:flex;flex-direction:column;gap:1px;margin:-4px 0}
.v1 .tl{display:flex;align-items:center;gap:8px;min-height:27px;font:12.5px var(--mono);color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v1 .tl .tg{width:14px;text-align:center;flex:none}
.v1 .tl.ok .tg{color:var(--green)} .v1 .tl.running .tg,.v1 .tl.running{color:var(--work)} .v1 .tl.error,.v1 .tl.error .tg{color:var(--red)}
.v1 .notice{font:12.5px var(--mono);color:var(--faint)} .v1 .notice.error{color:var(--red)}
.v1 .working{margin:0 20px 8px;font-size:13.5px;color:var(--work)}
.v1 .conv-asks:empty{display:none}
.v1 .conv-asks{padding:0 20px 12px;display:flex;flex-direction:column;gap:12px}
.v1 .ask{border:1px solid rgba(255,182,46,.55);background:rgba(255,200,87,.06);border-radius:16px;padding:14px}
.v1 .ask-h{color:var(--amber);font:700 11px var(--mono);letter-spacing:.07em;text-transform:uppercase}
.v1 .ask-hd{margin-top:10px;font:700 10.5px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.v1 .ask h3{margin:9px 0 12px;font-size:17px;line-height:1.3;font-weight:640;letter-spacing:-.012em;white-space:pre-wrap;word-break:break-word}
.v1 .opt{display:flex;align-items:center;gap:12px;width:100%;margin-bottom:8px;padding:11px 14px 11px 12px;text-align:left;background:var(--raised);border:1px solid var(--hair2);border-radius:12px}
.v1 .opt.picked{border-color:var(--amber);background:rgba(255,182,46,.12)}
.v1 .opt .n{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:rgba(255,182,46,.14);color:var(--amber);font:700 13px var(--mono);flex:none}
.v1 .opt.picked .n{background:var(--amber);color:#1a1100}
.v1 .opt .ot{display:flex;flex-direction:column;gap:2px;min-width:0}
.v1 .opt b{font-size:15.5px;font-weight:620;word-break:break-word}
.v1 .opt small{font-size:12.5px;color:var(--dim)}
.v1 .other{display:block;width:100%;height:46px;padding:0 15px;border-radius:23px;border:1px solid var(--hair2);background:var(--sunken);font-size:15px}
.v1 .other::placeholder{color:var(--faint)}
.v1 .btn{margin-top:10px;height:40px;padding:0 18px;border-radius:10px;background:var(--accent);color:var(--ink);font-weight:650;font-size:14.5px}
.v1 .btn:disabled{opacity:.35}
.v1 .ask-status{margin-top:8px;font-size:13px;color:var(--dim)} .v1 .ask-status:empty{display:none}
.v1 .elic{border:1px dashed var(--hair2);background:var(--sunken)}
.v1 .elic-h{color:var(--dim);font:700 11px var(--mono);letter-spacing:.07em;text-transform:uppercase}
.v1 .elic p{margin:9px 0 13px;font-size:16px;line-height:1.4;font-weight:560}
.v1 .desk{display:flex;align-items:center;justify-content:center;height:46px;border-radius:12px;background:rgba(255,182,46,.12);color:var(--amber);font-weight:650;font-size:15px;border:1px solid rgba(255,182,46,.4)}
.v1 .cmp{position:sticky;bottom:0;padding:8px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--hair);background:var(--surface)}
.v1 .fld{display:flex;align-items:flex-end;gap:8px;min-height:44px;padding:5px 5px 5px 16px;border-radius:22px;background:var(--raised);border:1px solid var(--hair2)}
.v1 .conv-input{flex:1;min-width:0;resize:none;font-size:16px;line-height:1.35;padding:6px 0;max-height:140px;outline:none}
.v1 .conv-input::placeholder{color:var(--faint)}
.v1 .send{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--hair2);color:var(--faint);flex:none;font-weight:700}
.v1 .send.on{background:var(--accent);color:var(--ink)}
.v1 .send:disabled{opacity:.5}
.v1 .atts{display:flex;gap:8px;overflow-x:auto;padding:0 0 8px}
.v1 .conv-att{position:relative;flex:none;height:64px;min-width:64px;border-radius:12px;overflow:hidden;background:var(--raised);border:1px solid var(--hair2);display:grid;place-items:center}
.v1 .conv-att img{height:64px;width:auto;max-width:128px;object-fit:cover;display:block}
.v1 .att-pdf{font-size:12px;padding:0 30px 0 10px;color:var(--dim);max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v1 .conv-att-x{position:absolute;top:3px;right:3px;width:24px;height:24px;border-radius:50%;background:rgba(0,0,0,.65);color:#fff;font-size:15px;line-height:24px;text-align:center}
.v1 .att{width:32px;height:32px;margin-left:-11px;border-radius:50%;display:grid;place-items:center;flex:none;color:var(--dim);font-size:24px;line-height:1}
.v1 .att:disabled{opacity:.5}
.v1 .msg-atts{font-size:13px;color:var(--dim);margin-top:4px}
.v1 .pair{padding:4px 20px 24px;display:flex;flex-direction:column;gap:12px}
.v1 .pair p{color:var(--dim);font-size:14px;line-height:1.45;text-align:center}
.v1 .pair-scan{width:100%;height:48px;margin-top:0;border-radius:14px;font-size:16px;font-weight:600}
.v1 .pair-form{display:flex;gap:8px}
.v1 .pair-form input{flex:1;min-width:0;min-height:44px;padding:0 14px;border-radius:12px;background:var(--raised);border:1px solid var(--hair2);font-size:16px;color:var(--text)}
.v1 .pair-form .btn2,.v1 .scan .btn2{min-height:44px;padding:0 16px;border-radius:12px;background:var(--raised);border:1px solid var(--hair2);color:var(--text);font-weight:600}
.v1 .pair-err{color:var(--red);font-size:14px;text-align:center;min-height:1em}
.v1 .scan{position:fixed;inset:0;z-index:50;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:env(safe-area-inset-top) 16px calc(16px + env(safe-area-inset-bottom))}
.v1 .scan[hidden]{display:none}
.v1 .pair[hidden]{display:none}
.v1 .update{margin:10px 0 2px;padding:9px 12px;border-radius:12px;background:rgba(110,168,255,.10);box-shadow:inset 3px 0 0 var(--accent);color:var(--text);font-size:13.5px;line-height:1.4}
.v1 .update[hidden]{display:none}
.v1 .scan video{width:100%;max-height:70vh;object-fit:cover;border-radius:16px}
.v1 .scan p{color:#ddd;font-size:15px;text-align:center}
.v1 .toast{margin:0 0 8px;padding:10px 13px;border-radius:12px;background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.45);color:#f1c9c9;font-size:13.5px;line-height:1.3}
.v1 .toast:empty{display:none}
`;
