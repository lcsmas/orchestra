// The phone's conversation screen + the live stream (#337). A separate static asset so the shell (page.ts) only routes to it.
// Rendering is textContent-only: agent and user text can contain anything, it must never become markup.
// The stream is read with fetch() (EventSource cannot send the bearer header, and the token must never travel in a URL).

export const CONVERSATION_JS = `(function () {
  'use strict';
  var KEY = 'orchestra.accesMobile.token';
  function token() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function auth() { return { Authorization: 'Bearer ' + token() }; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // ---- live stream: one per page, shared by the list and the conversation ----
  var handlers = [];
  var backoff = 1000;
  var ctrl = null;
  function onStream(fn) { handlers.push(fn); }
  function connect() {
    if (!token()) return;
    if (ctrl) ctrl.abort();
    var c = new AbortController(); ctrl = c;
    fetch('/api/stream', { headers: auth(), cache: 'no-store', signal: c.signal }).then(function (r) {
      if (!r.ok || !r.body) throw new Error('status ' + r.status);
      var healthy = false;
      var reader = r.body.getReader(); var dec = new TextDecoder(); var buf = '';
      function pump() {
        return reader.read().then(function (x) {
          if (x.done) throw new Error('ended');
          buf += dec.decode(x.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\\n\\n')) >= 0) {
            var block = buf.slice(0, i); buf = buf.slice(i + 2);
            // Only a REAL message proves main is behind the stream (the server answers 200 even when main is gone): reset the
            // backoff then, and catch up on whatever was announced while we were away (#337 review m1/m2).
            if (!healthy && block !== ': open') {
              // Every healthy (re)connect catches up — the FIRST one too: a page loaded during an outage never had data.
              healthy = true; backoff = 1000;
              handlers.forEach(function (h) { h({ t: 'resume' }); });
            }
            if (block.indexOf('data: ') === 0) {
              try { var m = JSON.parse(block.slice(6)); handlers.forEach(function (h) { h(m); }); } catch (e) {}
            }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      if (c.signal.aborted) return;
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000);
    });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { backoff = 1000; connect(); handlers.forEach(function (h) { h({ t: 'resume' }); }); } });

  // ---- conversation screen ----
  var root = null, current = null, version = -1, inflight = false, again = false, lastFetch = 0;
  var STATE = { running: '…', ok: '✓', error: '✗' };
  function render(c) {
    var list = root.querySelector('.conv-lines');
    var nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.textContent = '';
    if (c.truncated) list.appendChild(el('div', 'conv-more', c.truncated + ' messages plus anciens sur le bureau'));
    c.lines.forEach(function (l) {
      var row;
      if (l.kind === 'user') row = el('div', 'msg user', l.text);
      else if (l.kind === 'assistant') { row = el('div', 'msg assistant', l.text); if (l.streaming) row.classList.add('streaming'); }
      else if (l.kind === 'tool' || l.kind === 'command') { row = el('div', 'tool ' + l.state, STATE[l.state] + ' ' + l.label); }
      else row = el('div', 'notice' + (l.error ? ' error' : ''), l.text);
      row.dataset.kind = l.kind; row.dataset.id = l.id;
      list.appendChild(row);
    });
    var asks = root.querySelector('.conv-asks'); asks.textContent = '';
    c.asks.forEach(function (a) {
      var box = el('div', 'ask'); box.dataset.kind = a.kind;
      if (a.kind === 'askUser') {
        renderAskUser(box, a);
      } else {
        box.appendChild(el('div', 'ask-q', a.title));
        box.appendChild(el('div', 'ask-hint', 'À traiter sur le bureau.'));
      }
      asks.appendChild(box);
    });
    root.querySelector('.conv-running').hidden = !c.running;
    root.dataset.version = String(c.version);
    lastConv = c;
    if (nearBottom || version < 0) list.scrollTop = list.scrollHeight;
    version = c.version;
  }
  // #339: answering an AskUserQuestion. The selection survives re-renders (every stream announcement redraws the screen).
  var picks = Object.create(null); // requestId -> question -> { labels: [], other: '' } — no prototype: a question may be named anything
  function renderAskUser(box, a) {
    var st = picks[a.requestId] || (picks[a.requestId] = Object.create(null));
    a.questions.forEach(function (q) {
      var cur = st[q.question] || (st[q.question] = { labels: [], other: '' });
      if (q.header) box.appendChild(el('div', 'ask-h', q.header));
      box.appendChild(el('div', 'ask-q', q.question));
      var opts = el('div', 'ask-opts');
      q.options.forEach(function (o) {
        var b = el('button', 'ask-opt', o.label); b.type = 'button'; b.title = o.description || '';
        if (cur.labels.indexOf(o.label) >= 0) b.classList.add('picked');
        b.addEventListener('click', function () {
          var i = cur.labels.indexOf(o.label);
          if (q.multiSelect) { if (i >= 0) cur.labels.splice(i, 1); else cur.labels.push(o.label); }
          else { cur.labels = i >= 0 ? [] : [o.label]; cur.other = ''; }
          rerenderAsks();
        });
        opts.appendChild(b);
      });
      box.appendChild(opts);
      var other = el('input', 'ask-other'); other.placeholder = 'Autre réponse…'; other.value = cur.other; other.maxLength = 2000;
      other.addEventListener('input', function () { cur.other = other.value; if (!q.multiSelect && other.value.trim()) { cur.labels = []; opts.querySelectorAll('.picked').forEach(function (p) { p.classList.remove('picked'); }); } syncSubmit(); });
      box.appendChild(other);
    });
    var submit = el('button', 'ask-submit', 'Répondre'); submit.type = 'button';
    var status = el('div', 'ask-status', st.__status || ''); status.setAttribute('role', 'status');
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
    function syncSubmit() { submit.disabled = !answers() || st.__sending === true; }
    submit.addEventListener('click', function () {
      var ans = answers(); if (!ans) return;
      st.__sending = true; syncSubmit(); status.textContent = 'Envoi…';
      fetch('/api/answer?id=' + encodeURIComponent(current) + '&request=' + encodeURIComponent(a.requestId), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth()), body: JSON.stringify({ answers: ans }) })
        .then(function (r) { return r.ok ? r.json() : { ok: false, error: r.status === 401 ? 'Jeton refusé.' : 'Orchestra injoignable : la réponse n’est peut-être pas partie.' }; })
        .then(function (res) { st.__status = res && res.ok ? 'Réponse envoyée.' : ((res && res.error) || 'Échec.'); box.dataset.state = res && res.ok ? 'answered' : 'error'; status.textContent = st.__status; fetchConv(); })
        .catch(function () { st.__status = 'Réseau coupé : la réponse n’est peut-être pas partie.'; status.textContent = st.__status; })
        .then(function () { st.__sending = false; syncSubmit(); });
    });
    syncSubmit();
    box.appendChild(submit); box.appendChild(status);
  }
  var lastConv = null;
  function rerenderAsks() { if (lastConv) render(lastConv); }
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
          if (c && c.ok) { root.querySelector('.conv-state').textContent = ''; render(c); }
          else root.querySelector('.conv-state').textContent = c ? 'Workspace introuvable.' : 'Orchestra injoignable.';
        })
        .catch(function () { root.querySelector('.conv-state').textContent = 'Orchestra injoignable.'; })
        .then(function () { inflight = false; if (again) { again = false; fetchConv(); } });
    }, wait);
  }
  onStream(function (m) {
    if (!current) return;
    if ((m.t === 'conv' && m.id === current && m.v !== version) || m.t === 'resume') fetchConv();
  });

  function open(id, name) {
    current = id; version = -1;
    root = document.getElementById('conv');
    root.textContent = '';
    var head = el('div', 'conv-head');
    var back = el('button', 'conv-back', '‹ Workspaces'); back.addEventListener('click', function () { location.hash = ''; });
    head.appendChild(back); head.appendChild(el('div', 'conv-title', name || id));
    root.appendChild(head);
    root.appendChild(el('div', 'conv-state', ''));
    root.appendChild(el('div', 'conv-lines'));
    var running = el('div', 'conv-running', '● en cours…'); running.hidden = true; root.appendChild(running);
    root.appendChild(el('div', 'conv-asks'));
    root.appendChild(composer(id));
    root.dataset.id = id;
    root.hidden = false;
    fetch('/api/seen?id=' + encodeURIComponent(id), { method: 'POST', headers: auth() }).catch(function () {});
    fetchConv();
  }
  // #338: the composer — the message goes the desktop composer's way (queued if mid-turn). Never claims « sent » on a doubt.
  function composer(id) {
    var form = el('form', 'conv-compose');
    var ta = el('textarea', 'conv-input'); ta.rows = 2; ta.placeholder = 'Message à l’agent…'; ta.maxLength = 32000;
    var btn = el('button', 'conv-send', 'Envoyer'); btn.type = 'submit';
    var err = el('div', 'conv-send-error', ''); err.setAttribute('role', 'alert');
    form.appendChild(ta); form.appendChild(btn); form.appendChild(err);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = ta.value.trim();
      if (!text || btn.disabled) return;
      btn.disabled = true; ta.disabled = true; err.textContent = ''; form.dataset.state = 'sending';
      fetch('/api/send?id=' + encodeURIComponent(id), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth()), body: JSON.stringify({ text: text }) })
        .then(function (r) {
          if (r.status === 401) return { ok: false, error: 'Jeton refusé : re-scanne le QR code.' };
          if (r.status === 502) return { ok: false, error: 'Orchestra injoignable : le message n’est peut-être pas parti, vérifie la conversation.' };
          if (!r.ok) return { ok: false, error: 'Refusé (' + r.status + ').' };
          return r.json();
        })
        .then(function (res) {
          if (res && res.ok) { ta.value = ''; form.dataset.state = 'sent'; fetchConv(); }
          else { err.textContent = (res && res.error) || 'Échec de l’envoi.'; form.dataset.state = 'error'; }
        })
        .catch(function () { err.textContent = 'Réseau coupé : le message n’est peut-être pas parti, vérifie la conversation.'; form.dataset.state = 'error'; })
        .then(function () { btn.disabled = false; ta.disabled = false; });
    });
    return form;
  }
  function close() { current = null; version = -1; if (root) { root.hidden = true; root.textContent = ''; } }

  window.OrchestraConversation = { open: open, close: close, onStream: onStream, connect: connect };
})();
`;

export const CONVERSATION_CSS = `
#conv{display:flex;flex-direction:column;min-height:100vh}
#conv[hidden]{display:none}
.conv-head{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:8px 12px;background:Canvas;border-bottom:1px solid #8883}
.conv-back{font:inherit;border:0;background:none;color:LinkText;padding:4px 0}
.conv-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conv-state{margin:8px 12px;opacity:.7}
.conv-lines{display:flex;flex-direction:column;gap:6px;padding:8px 12px;overflow-y:auto}
.msg{white-space:pre-wrap;word-break:break-word;padding:8px 10px;border-radius:12px;max-width:92%}
.msg.user{align-self:flex-end;background:#3478f6;color:#fff}
.msg.assistant{align-self:flex-start;background:#8882}
.msg.streaming{opacity:.85}
.tool,.notice{font-size:13px;opacity:.7;font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool.error,.notice.error{color:#d33;opacity:1}
.conv-more{font-size:12px;opacity:.6;text-align:center}
.conv-running{margin:4px 12px;font-size:13px;opacity:.7}
.ask{margin:8px 12px;padding:10px;border:1px solid #e9a400;border-radius:10px}
.ask-q{font-weight:600;margin-bottom:6px}
.ask-opts{display:flex;flex-wrap:wrap;gap:6px}
.ask-opt{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid #8886;background:none}
.ask-opt.picked{background:#3478f6;color:#fff;border-color:#3478f6}
.ask-h{font-size:12px;text-transform:uppercase;opacity:.6}
.ask-other{display:block;width:100%;box-sizing:border-box;margin-top:6px;font:inherit;padding:6px;border-radius:8px;border:1px solid #8886}
.ask-submit{margin-top:8px;font:inherit;padding:8px 14px;border-radius:10px;border:0;background:#e9a400;color:#000}
.ask-submit:disabled{opacity:.4}
.ask-status{font-size:13px;margin-top:4px}
.ask-status:empty{display:none}
.ask-hint{font-size:12px;opacity:.7;margin-top:6px}
.conv-compose{position:sticky;bottom:0;display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:Canvas;border-top:1px solid #8883;margin-top:auto}
.conv-input{flex:1;font:inherit;padding:8px;border-radius:10px;border:1px solid #8886;resize:none;min-width:0}
.conv-send{font:inherit;padding:8px 14px;border-radius:10px;border:0;background:#3478f6;color:#fff}
.conv-send:disabled{opacity:.5}
.conv-send-error{flex-basis:100%;font-size:13px;color:#d33}
.conv-send-error:empty{display:none}
`;
