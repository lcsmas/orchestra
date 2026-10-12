// The phone's « Nouveau workspace » screen (#375, design A picked by Lucas 2026-10-12 — ledger #377 D-Q1): the « + » of the list header
// routes to `#new`, a full-screen form — repo cards (every registered repo, every Compte), a REQUIRED prompt, a sticky « Lancer ».
// A separate static asset (like conversation.ts) so the shell only routes to it. textContent only: repo names and error texts are data.
// Class names the e2e rig reads are part of the contract: #launch, .nf-cancel, .nf-repo[data-path], .nf-task, .nf-go, .nf-err, [data-state].

import { mobileLaunchFailure } from '../shared/acces-mobile-launch.ts';

export const LAUNCH_JS = `(function () {
  'use strict';
  var KEY = 'orchestra.accesMobile.token';
  var LAST_REPO = 'orchestra.accesMobile.lastRepo';
  // shared/acces-mobile-launch.ts (unit-tested) — self-contained, so its source is injected as is.
  var failure = (${mobileLaunchFailure.toString()});
  function token() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function acct(name) { return el('span', 'acct a-' + String(name).replace(/[^a-z0-9-]/gi, '').toLowerCase(), name); }
  // State that outlives the screen: an accidental back-swipe must not lose a typed prompt (cleared only by a launch), and a request still in
  // flight when the human leaves must still land somewhere (st.busy / st.error), never in a detached form. st.ui = the screen open NOW.
  var st = { repos: null, sel: '', draft: '', busy: false, error: null, launched: null, ui: null };
  var root = null;

  function open() {
    root = document.getElementById('launch');
    if (!token()) { location.hash = ''; return; } // unpaired: the list shows the pairing panel
    root.textContent = '';
    var head = el('div', 'nf-h');
    var cancel = el('button', 'nf-cancel', '‹ Annuler'); cancel.type = 'button';
    cancel.addEventListener('click', function () { location.hash = ''; });
    head.appendChild(cancel); head.appendChild(el('b', null, 'Nouveau workspace'));
    var body = el('div', 'nf-body');
    body.appendChild(el('div', 'nf-lbl', 'Dépôt'));
    var repos = el('div', 'nf-repos'); body.appendChild(repos);
    body.appendChild(el('div', 'nf-lbl', 'Tâche'));
    var ta = el('textarea', 'nf-task'); ta.rows = 5; ta.placeholder = 'Que doit faire l’agent ?'; ta.value = st.draft;
    ta.setAttribute('autocapitalize', 'sentences'); ta.setAttribute('enterkeyhint', 'default');
    body.appendChild(ta);
    body.appendChild(el('div', 'nf-note', 'Branche générée (l’agent la renomme), modèle et effort par défaut, vue structurée. Comme un « + » sur le bureau.'));
    var err = el('div', 'nf-err'); err.setAttribute('role', 'alert'); err.hidden = true; body.appendChild(err);
    var bar = el('div', 'nf-bar');
    var go = el('button', 'nf-go', 'Lancer'); go.type = 'button'; go.disabled = true;
    bar.appendChild(go);
    root.appendChild(head); root.appendChild(body); root.appendChild(bar);
    root.dataset.state = '';
    root.hidden = false;

    function say(f) {
      st.error = f || null;
      err.textContent = ''; err.hidden = !f;
      if (!f) return;
      err.appendChild(document.createTextNode(f.text));
      if (f.open) {
        var a = el('button', 'nf-open', 'Ouvrir le workspace ›'); a.type = 'button';
        a.addEventListener('click', function () { location.hash = 'w=' + encodeURIComponent(f.open); });
        err.appendChild(a);
      }
    }
    function sync() {
      st.draft = ta.value;
      ta.disabled = st.busy;
      go.disabled = st.busy || !st.sel || !ta.value.trim();
      go.textContent = '';
      if (st.busy) { go.appendChild(el('i', 'nf-spin')); go.appendChild(document.createTextNode(' Création…')); } else go.textContent = 'Lancer';
    }
    function drawRepos() {
      repos.textContent = '';
      if (st.repos === null) { repos.appendChild(el('div', 'nf-hint', 'Chargement des dépôts…')); return; }
      if (st.repos === false) {
        var retry = el('button', 'nf-open', 'Dépôts indisponibles : réessayer'); retry.type = 'button';
        retry.addEventListener('click', function () { loadRepos(); });
        repos.appendChild(retry); return;
      }
      if (!st.repos.length) { repos.appendChild(el('div', 'nf-hint', 'Aucun dépôt enregistré : ajoutes-en un depuis Orchestra, sur le bureau.')); return; }
      st.repos.forEach(function (r) {
        var b = el('button', 'nf-repo' + (r.path === st.sel ? ' sel' : '')); b.type = 'button'; b.dataset.path = r.path;
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', r.path === st.sel ? 'true' : 'false');
        b.appendChild(el('span', 'rd'));
        var rn = el('span', 'rn'); rn.appendChild(el('b', null, r.name)); rn.appendChild(el('small', null, r.path)); b.appendChild(rn);
        b.appendChild(acct(r.account));
        b.addEventListener('click', function () {
          if (st.busy) return; // the launch in flight is for THIS repo
          st.sel = r.path; try { localStorage.setItem(LAST_REPO, r.path); } catch (e) {}
          say(null); drawRepos(); sync();
        });
        repos.appendChild(b);
      });
    }
    function loadRepos() {
      st.repos = null; drawRepos();
      fetch('/api/repos', { headers: { Authorization: 'Bearer ' + token() }, cache: 'no-store' })
        .then(function (r) { if (r.status === 401) { location.hash = ''; return null; } return r.ok ? r.json() : Promise.reject(new Error('status ' + r.status)); })
        .then(function (j) {
          if (!j) return;
          if (!j.ok || !Array.isArray(j.repos)) throw new Error('bad answer');
          st.repos = j.repos;
          var known = j.repos.some(function (r) { return r.path === st.sel; });
          if (!known) {
            var last = null; try { last = localStorage.getItem(LAST_REPO); } catch (e) {}
            st.sel = j.repos.some(function (r) { return r.path === last; }) ? last : (j.repos.length === 1 ? j.repos[0].path : '');
          }
          if (st.ui === ui) { drawRepos(); sync(); }
        })
        .catch(function () { st.repos = false; if (st.ui === ui) { drawRepos(); sync(); } });
    }
    var ui = { say: say, sync: sync, ta: ta };
    st.ui = ui;
    ta.addEventListener('input', function () { say(null); sync(); });

    go.addEventListener('click', function () {
      var prompt = ta.value.trim();
      if (st.busy || !st.sel || !prompt) return;
      var repo = (st.repos || []).filter(function (r) { return r.path === st.sel; })[0] || { name: '', account: '' };
      st.busy = true; root.dataset.state = 'sending'; say(null); sync();
      fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }, body: JSON.stringify({ repoPath: st.sel, prompt: prompt }) })
        .then(function (r) { return (r.status === 200 ? r.json().catch(function () { return null; }) : Promise.resolve(null)).then(function (j) { return { status: r.status, body: j }; }); })
        .catch(function () { return { status: null, body: null }; })
        .then(function (res) {
          st.busy = false;
          var u = st.ui; // the screen open NOW — null when the human left meanwhile (the result is then kept, never written into a detached form)
          var made = function (b) { return { id: String(b.id), name: b.branch || '', displayName: b.branch || '', group: repo.name, branch: b.branch || '', account: repo.account }; };
          if (res.status === 200 && res.body && res.body.ok === true && typeof res.body.id === 'string') {
            st.launched = made(res.body); st.draft = ''; st.error = null;
            if (u) {
              u.ta.value = ''; root.dataset.state = 'launched'; u.sync();
              location.hash = 'w=' + encodeURIComponent(res.body.id); // the conversation opens: the agent picks the task up
            }
            return;
          }
          var f = failure(res.status, res.body);
          if (f.open) { st.launched = made({ id: f.open, branch: res.body && res.body.branch }); st.draft = ''; } // the workspace EXISTS: its task is the draft — a second tap would duplicate it
          st.error = f;
          if (u) {
            if (f.open) u.ta.value = '';
            root.dataset.state = 'error'; u.say(f); u.sync();
            if (f.repair) { location.hash = ''; }
          }
        });
    });
    drawRepos();
    if (st.busy) root.dataset.state = 'sending'; // back on the screen while a launch is still in flight: it is shown as it is
    if (st.error) { say(st.error); root.dataset.state = 'error'; } // …or while its answer arrived behind our back
    sync();
    loadRepos();
    scrollToTop();
  }
  function scrollToTop() { var se = document.scrollingElement || document.documentElement; se.scrollTop = 0; }
  function close() { st.ui = null; if (root) { root.hidden = true; root.textContent = ''; } }
  // The row the conversation header shows right after a launch (the list has not refreshed yet): branch + repo + Compte.
  function meta(id) { return st.launched && st.launched.id === id ? st.launched : null; }
  window.OrchestraLaunch = { open: open, close: close, meta: meta };
})();
`;

/** Appended to the phone's one stylesheet by the server (`/launch.css` rides after `/conversation.css`): the « + » of the list header and the
 *  launch screen — V1 tokens only (they are defined by CONVERSATION_CSS). */
export const LAUNCH_CSS = `
.v1 .live{margin-left:auto}
.v1 .new-btn{width:36px;height:36px;margin-left:12px;border-radius:50%;display:grid;place-items:center;background:var(--accent);color:var(--ink);font:400 26px/1 var(--mono);flex:none}
.v1 .nf-h{position:sticky;top:env(safe-area-inset-top);z-index:2;display:flex;align-items:center;gap:6px;padding:4px 16px 10px 8px;border-bottom:1px solid var(--hair);min-height:58px;background:var(--surface)}
.v1 .nf-cancel{color:var(--accent);font-size:16px;padding:0 8px;white-space:nowrap}
.v1 .nf-h b{flex:1;text-align:center;font-size:17px;font-weight:650;letter-spacing:-.015em;margin-right:56px}
.v1 .nf-body{flex:1;padding:4px 0 24px}
.v1 .nf-lbl{padding:14px 20px 8px;font:700 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.v1 .nf-hint{margin:0 16px;padding:12px 4px;color:var(--dim);font-size:14.5px}
.v1 .nf-repo{display:grid;grid-template-columns:22px 1fr auto;align-items:center;gap:12px;width:calc(100% - 32px);margin:0 16px 8px;padding:12px 14px;text-align:left;border:1px solid var(--hair2);border-radius:14px;background:var(--raised)}
.v1 .nf-repo .rd{width:20px;height:20px;border-radius:50%;border:2px solid var(--hair2)}
.v1 .nf-repo.sel{border-color:var(--accent);background:rgba(110,168,255,.09)}
.v1 .nf-repo.sel .rd{border-color:var(--accent);background:radial-gradient(circle,var(--accent) 0 38%,transparent 42%)}
.v1 .nf-repo .rn{min-width:0;display:flex;flex-direction:column;gap:2px}
.v1 .nf-repo .rn b{font-size:16px;font-weight:620;letter-spacing:-.01em}
.v1 .nf-repo .rn small{font:11.5px var(--mono);color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v1 .nf-task{display:block;width:calc(100% - 32px);min-height:132px;margin:0 16px;resize:none;padding:12px 14px;border-radius:14px;background:var(--raised);border:1px solid var(--hair2);font-size:16px;line-height:1.4;outline:none}
.v1 .nf-task:focus{border-color:var(--accent)}
.v1 .nf-task::placeholder{color:var(--faint)}
.v1 .nf-task:disabled{opacity:.6}
.v1 .nf-note{margin:10px 20px 0;font-size:12.5px;color:var(--faint);line-height:1.4}
.v1 .nf-err{margin:12px 16px 0;padding:12px 14px;border:1px solid rgba(255,107,107,.45);background:rgba(255,107,107,.09);border-radius:14px;color:var(--red);font-weight:600;font-size:14.5px;line-height:1.35}
.v1 .nf-open{display:block;margin-top:8px;color:var(--accent);font-weight:650;font-size:14.5px}
.v1 .nf-bar{position:sticky;bottom:0;padding:10px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--hair);background:var(--surface)}
.v1 .nf-go{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:48px;border-radius:14px;background:var(--accent);color:var(--ink);font-weight:680;font-size:16px}
.v1 .nf-go:disabled{background:var(--hair2);color:var(--faint)}
.v1 .nf-spin{width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;display:inline-block;animation:nfspin .8s linear infinite}
@keyframes nfspin{to{transform:rotate(360deg)}}
`;
