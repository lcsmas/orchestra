// Sidebar renderers — options A / B / C × states idle | douce | dure | resuming. Real rows, injected decoration.
(() => {
  const P = window.PM;
  const { I, esc, nm, rowOf, state, members, leftStr, ago, tone, word, icon } = P;
  const rect = (el) => el.getBoundingClientRect();
  const dropExtras = () => document.querySelectorAll('.pm-x').forEach((e) => e.remove());
  const add = (html, host = document.body) => { const t = document.createElement('div'); t.innerHTML = html.trim(); const el = t.firstElementChild; el.classList.add('pm-x'); host.appendChild(el); return el; };
  const SB_RIGHT = () => rect(document.querySelector('.sidebar') || document.body).right;

  // ── common row decoration ────────────────────────────────────────────────────────────────
  function decorateMembers(k, opt) {
    for (const m of members(k)) {
      const row = rowOf(m.name); if (!row) continue;
      const t = tone(m.ui);
      row.classList.add('pm-dim');
      const g = row.querySelector('.ws-glyph');
      if (g) { const span = document.createElement('span'); span.className = `pm-glyph pm-t-${t}`; span.innerHTML = icon[m.ui](12); g.replaceWith(span); }
      const nr = row.querySelector('.ws-name-row');
      if (opt === 'A') nr.insertAdjacentHTML('beforeend', `<span class="pm-badge pm-t-${t}">${icon[m.ui](9)}${word[m.ui]}</span>`);
      if (opt === 'B') { row.style.boxShadow = `inset 3px 0 0 ${t === 'resumed' || t === 'released' ? 'var(--green)' : t === 'pausing' ? 'var(--yellow)' : 'var(--accent)'}`; row.style.borderLeftColor = 'transparent'; nr.insertAdjacentHTML('beforeend', `<span class="pm-badge pm-t-${t}" style="border-radius:4px;text-transform:uppercase;letter-spacing:.06em">${word[m.ui]}</span>`); }
    }
  }
  const noteOf = (name) => rowOf(name)?.querySelector('.ws-status-note');
  function leadSummary(k) {
    const st = state(k).status; if (!st) return null;
    const rp = state(k).reprise, now = P.NOW(k), sum = st.summary;
    if (st.phase === 'pausing') return { t: 'pausing', text: `Pause douce · ${sum.done}/${sum.total} · dure dans ${leftStr(st.deadlineAt - now)}`, pct: sum.done / sum.total };
    if (st.phase === 'resuming') return { t: 'resumed', text: `Reprise · ${sum.done}/${sum.total} repris · ${rp ? rp.blocked.length : 0} bloqués`, pct: sum.done / sum.total };
    return { t: 'paused', text: `En pause${st.mode === 'soft' ? ' (douce → dure)' : ''} · ${sum.done}/${sum.total} · depuis ${ago(now - st.pausedAt)}`, pct: 1 };
  }
  const ink = { pausing: 'var(--yellow)', paused: 'var(--accent)', resumed: 'var(--green)' };

  // ── OPTION A — hover action + badges + progress in the row's own note line ──────────────
  function A(k) {
    dropExtras(); decorateMembers(k, 'A');
    const lead = rowOf('fleet-lead'), s = leadSummary(k);
    if (s) {
      const n = noteOf('fleet-lead'); if (n) { n.style.color = ink[s.t]; n.textContent = s.text; }
      lead.insertAdjacentHTML('beforeend', `<div class="pm-bar pm-rowbar"><i class="pm-fill-${s.t}" style="width:${Math.round(s.pct * 100)}%"></i></div>`);
    }
    lead.style.background = 'var(--bg-3)'; // hovered row
    const r = rect(lead), mid = r.top + r.height / 2, left = SB_RIGHT() + 6;
    const btns = { idle: [['pause', 'on'], ['archive']], douce: [['stop', 'warn'], ['play', 'go'], ['archive']], dure: [['play', 'go'], ['archive']], resuming: [['play', 'go'], ['pause'], ['archive']] }[k];
    const bhtml = btns.map(([ic, tn]) => `<button class="ws-icon-btn" style="${tn === 'on' ? 'background:var(--hover-bg);color:var(--text)' : tn === 'go' ? 'color:var(--green)' : tn === 'warn' ? 'color:var(--yellow)' : ''}">${I[ic](13)}</button>`).join('');
    const pop = add(`<div class="ws-row-actions-pop" style="left:${left}px;top:${mid}px;animation:none">${bhtml}</div>`);
    const tips = { idle: 'Mettre la vague en pause…', douce: 'Pause dure maintenant', dure: 'Reprendre la vague', resuming: 'Libérer tous les bloqués' }[k];
    const pr = rect(pop);
    add(`<div class="pm-tip" style="left:${pr.right + 8}px;top:${mid - 12}px">${tips}</div>`);
    if (k === 'idle') {
      add(`<div class="pm-menu" style="left:${left}px;top:${mid + 22}px"><div class="pm-menu-h">fleet-lead · 7 agents</div>
        <button class="new-menu-item"><span class="new-menu-item-icon" style="color:var(--yellow)">${I.clock(14)}</span><span class="new-menu-item-body"><span class="new-menu-item-title">Pause douce</span><span class="new-menu-item-sub">3 min pour finir, committer et pousser</span></span></button>
        <button class="new-menu-item"><span class="new-menu-item-icon" style="color:var(--accent)">${I.pause(14)}</span><span class="new-menu-item-body"><span class="new-menu-item-title">Pause dure</span><span class="new-menu-item-sub">snapshot, interruption, arrêt des outils — tout de suite</span></span></button></div>`);
    }
  }

  // ── OPTION B — persistent control strip under each orchestrator ─────────────────────────
  function strip(rowName, depth, html, extra = '') {
    const row = rowOf(rowName); if (!row) return null;
    const d = document.createElement('div'); d.className = 'pm-x pm-strip';
    d.style.cssText = `padding:2px 10px 7px calc(12px + ${depth} * 16px + 19px);display:flex;flex-direction:column;gap:5px;${extra}`;
    d.innerHTML = html; row.after(d); return d;
  }
  function B(k) {
    dropExtras(); decorateMembers(k, 'B');
    const st = state(k).status, sum = st?.summary, rp = state(k).reprise, now = P.NOW(k);
    if (k === 'idle') {
      const mk = (name, depth, n, open) => strip(name, depth, `<div style="display:flex;align-items:center;gap:8px"><button class="pm-btn pm-primary">${I.pause()}Pause${I.chev(9)}</button><span style="font-size:10.5px;color:var(--text-dim)">${n} agents · Pause ON</span></div>`);
      const s1 = mk('fleet-lead', 0, 7); mk('wave-f-ops', 1, 4);
      add(`<div class="pm-menu" style="left:${rect(s1).left + 22}px;top:${rect(s1).top + 26}px;width:250px"><button class="new-menu-item"><span class="new-menu-item-icon" style="color:var(--yellow)">${I.clock(14)}</span><span class="new-menu-item-body"><span class="new-menu-item-title">Pause douce</span><span class="new-menu-item-sub">3 min pour finir, committer, pousser</span></span></button><button class="new-menu-item"><span class="new-menu-item-icon" style="color:var(--accent)">${I.pause(14)}</span><span class="new-menu-item-body"><span class="new-menu-item-title">Pause dure</span><span class="new-menu-item-sub">snapshot + arrêt immédiat</span></span></button></div>`);
      strip('legacy-sweep', 0, `<div style="display:flex;align-items:center;gap:8px"><button class="pm-btn pm-primary pm-off">${I.pause()}Pause${I.chev(9)}</button><span style="font-size:10.5px;color:var(--text-dim)">Pause désactivée (switch OFF)</span></div>`);
      return;
    }
    const bar = (t, pct) => `<div class="pm-bar"><i class="pm-fill-${t}" style="width:${Math.round(pct * 100)}%"></i></div>`;
    if (k === 'douce') {
      strip('fleet-lead', 0, `<div style="display:flex;align-items:center;justify-content:space-between;color:var(--yellow);font-size:11.5px;font-weight:600"><span style="display:flex;gap:6px;align-items:center">${I.clock()}Pause douce · ${sum.done}/${sum.total} en pause</span><span style="font-weight:500;font-size:10.5px">dure dans ${leftStr(st.deadlineAt - now)}</span></div>${bar('pausing', sum.done / sum.total)}<div style="display:flex;gap:6px"><button class="pm-btn pm-warn">${I.stop()}Pause dure maintenant</button><button class="pm-btn pm-ghost">${I.play()}Reprendre</button></div><div style="font-size:10.5px;color:var(--text-dim)">manquent : pause-ui-f1, canary-f2</div>`, 'background:rgba(255,200,87,.04)');
    } else if (k === 'dure') {
      strip('fleet-lead', 0, `<div style="display:flex;align-items:center;justify-content:space-between;color:var(--accent);font-size:11.5px;font-weight:600"><span style="display:flex;gap:6px;align-items:center">${I.pause()}En pause · ${sum.done}/${sum.total}</span><span style="font-weight:500;font-size:10.5px;color:var(--text-dim)">depuis ${ago(now - st.pausedAt)}</span></div>${bar('paused', 1)}<div style="display:flex;gap:6px"><button class="pm-btn pm-go">${I.play()}Reprendre</button><button class="pm-btn pm-ghost">Bilan sur le Bus ›</button></div>`, 'background:rgba(110,168,255,.04)');
    } else {
      strip('fleet-lead', 0, `<div style="display:flex;align-items:center;justify-content:space-between;color:var(--green);font-size:11.5px;font-weight:600"><span style="display:flex;gap:6px;align-items:center">${I.play()}Reprise · ${sum.done}/${sum.total} repris</span><span style="font-weight:500;font-size:10.5px;color:var(--text-dim)">${rp.blocked.length} bloqués</span></div>${bar('resumed', sum.done / sum.total)}<div style="display:flex;gap:6px"><button class="pm-btn pm-go">${I.play()}Libérer les ${rp.blocked.length} bloqués</button><button class="pm-btn pm-ghost">${I.pause()}Re-pause</button></div>`, 'background:rgba(91,214,139,.04)');
    }
    strip('wave-f-ops', 1, `<div style="font-size:10.5px;color:var(--text-dim);display:flex;gap:5px;align-items:center">${I.pause(10)}couverte par la pause de fleet-lead</div>`);
    strip('legacy-sweep', 0, `<div style="display:flex;align-items:center;gap:8px"><button class="pm-btn pm-primary pm-off">${I.pause()}Pause${I.chev(9)}</button><span style="font-size:10.5px;color:var(--text-dim)">Pause désactivée (switch OFF)</span></div>`);
  }

  // ── OPTION C — status pill on the row, control + progress + roster in an anchored card ──
  function pillOf(k) {
    const st = state(k).status, s = leadSummary(k);
    if (!st) return { t: 'none', html: `${I.pause(10)}` };
    if (st.phase === 'pausing') return { t: 'pausing', html: `${I.clock(10)}${st.summary.done}/${st.summary.total}` };
    if (st.phase === 'resuming') return { t: 'resumed', html: `${I.play(10)}${st.summary.done}/${st.summary.total}` };
    return { t: 'paused', html: `${I.pause(10)}${st.summary.done}/${st.summary.total}` };
  }
  function C(k) {
    dropExtras(); decorateMembers(k, 'C');
    for (const nmz of ['fleet-lead', 'wave-f-ops', 'legacy-sweep']) {
      const row = rowOf(nmz); if (!row) continue;
      const nr = row.querySelector('.ws-name-row');
      const mine = nmz === 'fleet-lead';
      let p;
      if (mine) p = pillOf(k);
      else if (nmz === 'wave-f-ops') p = k === 'idle' ? { t: 'none', html: I.pause(10) } : { t: k === 'resuming' ? 'blocked' : 'paused', html: `${I.pause(10)}<span style="opacity:.8">via lead</span>` };
      else p = { t: 'none', html: `${I.ban(10)}` };
      const el = document.createElement('span'); el.className = `pm-badge pm-t-${p.t} pm-x`; el.style.cssText = `height:17px;padding:0 6px;font-size:10px;${p.t === 'none' ? 'border-style:dashed;' : ''}${nmz === 'legacy-sweep' ? 'opacity:.55' : ''}`; el.innerHTML = p.html;
      nr.appendChild(el);
    }
    const lead = rowOf('fleet-lead'), r = rect(lead);
    const showCard = k !== 'dure';
    if (!showCard) return;
    const st = state(k).status, sum = st?.summary, now = P.NOW(k), ms = members(k);
    let head, body, foot;
    if (k === 'idle') {
      head = `<div class="pm-card-h">${I.pause(15)}<div><b>Mettre fleet-lead en pause</b><small>7 agents : fleet-lead, wave-f-ops et 5 workers</small></div></div>`;
      body = `<button class="new-menu-item"><span class="new-menu-item-icon" style="color:var(--yellow)">${I.clock(15)}</span><span class="new-menu-item-body"><span class="new-menu-item-title">Pause douce</span><span class="new-menu-item-sub">chaque agent a 3 min pour finir sa commande, committer et pousser ; la dure prend les retardataires</span></span></button><button class="new-menu-item"><span class="new-menu-item-icon" style="color:var(--accent)">${I.pause(15)}</span><span class="new-menu-item-body"><span class="new-menu-item-title">Pause dure</span><span class="new-menu-item-sub">snapshot du worktree dans refs/orchestra/pause/…, interruption, arrêt des outils — maintenant</span></span></button>`;
      foot = `<div class="pm-card-f" style="color:var(--text-dim)">Reprise ensuite : coordinateurs d'abord, chaque worker reçoit sa consigne.</div>`;
    } else {
      const pt = k === 'douce' ? 'pausing' : 'resumed';
      const title = k === 'douce' ? 'Pause douce en cours' : 'Reprise en cours';
      const sub = k === 'douce' ? `fleet-lead · il y a ${ago(now - st.pausedAt)} · dure dans ${leftStr(st.deadlineAt - now)}` : `fleet-lead · ${state(k).reprise.released}/${sum.total} libérés · ${state(k).reprise.blocked.length} bloqués`;
      head = `<div class="pm-card-h" style="color:${ink[k === 'douce' ? 'pausing' : 'resumed']}">${k === 'douce' ? I.clock(15) : I.play(15)}<div><b style="color:var(--text)">${title}</b><small>${sub}</small></div></div><div style="padding:0 12px 8px"><div class="pm-bar"><i class="pm-fill-${pt}" style="width:${Math.round(sum.done / sum.total * 100)}%"></i></div><div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--text-dim);margin-top:3px"><span>${sum.done}/${sum.total} ${k === 'douce' ? 'en pause' : 'repris'}</span></div></div>`;
      body = `<div class="pm-roster">${ms.map((m) => `<div class="pm-rl"><span class="pm-glyph pm-t-${tone(m.ui)}" style="width:12px">${icon[m.ui](11)}</span><span class="pm-rn">${esc(m.name)}</span><span class="pm-rr">${m.role === 'coordinator' ? 'coord.' : ''}</span><span class="pm-badge pm-t-${tone(m.ui)}">${word[m.ui]}</span>${k === 'resuming' && m.ui === 'blocked' ? `<button class="pm-btn pm-go" style="padding:1px 6px;font-size:10px">Libérer</button>` : ''}</div>`).join('')}</div>`;
      foot = k === 'douce' ? `<div class="pm-card-f"><button class="pm-btn pm-warn">${I.stop()}Pause dure maintenant</button><button class="pm-btn pm-ghost">${I.play()}Reprendre</button></div>` : `<div class="pm-card-f"><button class="pm-btn pm-go">${I.play()}Libérer les ${state(k).reprise.blocked.length} bloqués</button><button class="pm-btn pm-ghost">${I.pause()}Re-pause</button></div>`;
    }
    add(`<div class="pm-card" style="left:14px;top:${r.bottom + 8}px">${head}${body}${foot}</div>`);
  }
  P.extraCss += `
  .pm-card{position:fixed;z-index:70;width:312px;background:var(--bg-3);border:1px solid var(--border-strong);border-radius:var(--radius);box-shadow:var(--shadow-md);overflow:hidden}
  .pm-card-h{display:flex;gap:9px;align-items:flex-start;padding:10px 12px 8px}.pm-card-h svg{margin-top:2px;flex:none}.pm-card-h b{display:block;font-size:12.5px}.pm-card-h small{display:block;color:var(--text-dim);font-size:10.5px;margin-top:1px}
  .pm-card-f{display:flex;gap:6px;padding:8px 12px 10px;border-top:1px solid var(--border);font-size:10.5px}
  .pm-roster{padding:0 6px 6px}.pm-rl{display:flex;align-items:center;gap:7px;padding:3px 6px;border-radius:5px;font-size:11.5px}.pm-rl:hover{background:var(--bg-4)}
  .pm-rn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pm-rr{font-size:9.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em}
  .pm-card .new-menu-item{width:100%}
  `;
  P.sidebar = { A, B, C, clear: dropExtras };
})();
