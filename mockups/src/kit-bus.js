// Bus page + refusal renderers — options A / B / C. Real Bus pane (real runs/messages), injected "Pause de flotte" section.
(() => {
  const P = window.PM;
  const { I, esc, nm, rowOf, state, members, leftStr, ago, tone, word, icon } = P;
  const rect = (el) => el.getBoundingClientRect();
  const dropExtras = () => document.querySelectorAll('.pm-x').forEach((e) => e.remove());
  const add = (html, host = document.body) => { const t = document.createElement('div'); t.innerHTML = html.trim(); const el = t.firstElementChild; el.classList.add('pm-x'); host.appendChild(el); return el; };
  const ink = { pausing: 'var(--yellow)', paused: 'var(--accent)', resumed: 'var(--green)', none: 'var(--text-dim)' };
  const fmtT = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const refShort = (r) => (r ? r.replace(/^refs\/orchestra\/pause\//, '…/').replace(/\/(\w{8})\w*-[\w-]*\/(\d+)$/, '/$1…/$2') : null);
  const facts = (m) => {
    const b = m.bilan, a = b?.activity || {};
    return {
      none: !b,
      ref: b?.snapshotRef ? b.snapshotRef.replace(/([0-9a-f]{8})-[0-9a-f-]{27}/g, '$1…') : null,
      dirty: b?.dirty, ch: a.changed, killed: Array.isArray(b?.killed) ? b.killed : [], doing: !b ? 'Bilan à l\'escalade' : a.turnRunning ? (a.inFlightTools?.[0]?.input || (a.bgTasks?.[0]?.description) || 'un tour en cours') : 'au repos', exempt: a.interrupt === 'exempt', intr: a.interrupt,
    };
  };
  const chText = (ch) => (!ch ? '—' : `${ch.modified} mod · ${ch.added} ajout`);
  const header = (k) => {
    const st = state(k).status, rp = state(k).reprise, now = P.NOW(k);
    if (!st) return null;
    const sum = st.summary;
    if (st.phase === 'resuming') return { t: 'resumed', ic: I.play(14), title: 'Reprise en cours', sub: `déclenchée par ${nm(st.pausedBy) === st.pausedBy.slice(0, 8) ? 'fleet-lead' : nm(st.pausedBy)} · ${rp.released}/${sum.total} libérés · ${sum.done}/${sum.total} repris`, count: `${sum.done}/${sum.total} repris`, pct: sum.done / sum.total };
    if (st.phase === 'pausing') return { t: 'pausing', ic: I.clock(14), title: 'Pause douce en cours', sub: `posée par fleet-lead il y a ${ago(now - st.pausedAt)} · Pause dure à ${fmtT(st.deadlineAt)} (dans ${leftStr(st.deadlineAt - now)}) pour les retardataires`, count: `${sum.done}/${sum.total} en pause`, pct: sum.done / sum.total };
    return { t: 'paused', ic: I.pause(14), title: st.mode === 'soft' ? 'Pause douce → dure (escaladée)' : 'Pause dure', sub: `posée par fleet-lead il y a ${ago(now - st.pausedAt)} · ${fmtT(st.pausedAt)} · trap terminé ${fmtT(st.trapAt || st.pausedAt)}`, count: `${sum.done}/${sum.total} en pause`, pct: 1 };
  };
  const actionsHtml = (k) => {
    if (k === 'douce') return `<button class="pm-btn pm-warn">${I.stop()}Pause dure maintenant</button><button class="pm-btn pm-ghost">${I.play()}Reprendre</button>`;
    if (k === 'dure') return `<button class="pm-btn pm-go">${I.play()}Reprendre</button>`;
    if (k === 'resuming') return `<button class="pm-btn pm-go">${I.play()}Libérer les ${state(k).reprise.blocked.length} bloqués</button><button class="pm-btn pm-ghost">${I.pause()}Re-pause</button>`;
    return `<button class="pm-btn pm-primary">${I.pause()}Pause ${I.chev(9)}</button>`;
  };

  // ── common: put the section after the live-switch summary ───────────────────────────────
  function mount(html) {
    const pane = document.querySelector('.bus-pane'); const sw = pane.querySelector('.bus-switches');
    const sec = document.createElement('section'); sec.className = 'bus-section pm-x'; sec.dataset.section = 'pause'; sec.innerHTML = html; sw.after(sec);
    pane.querySelectorAll('[data-section="members"], [data-section="gates"], [data-section="counters"]').forEach((s) => (s.style.display = 'none')); // keep the frame short: sections unrelated to Pause
    return sec;
  }
  const bilanRow = (m, cols) => { const f = facts(m); return { f }; };

  // ── A: compact — one header card + one table (Bilan) ────────────────────────────────────
  function busA(k) {
    dropExtras(); const h = header(k), ms = members(k);
    const th = (t, w) => `<th style="text-align:left;font-weight:500;color:var(--text-dim);padding:4px 8px 4px 0;${w ? `width:${w}` : ''}">${t}</th>`;
    const rows = ms.map((m) => { const f = facts(m); const t = tone(m.ui); return `<tr style="border-top:1px solid var(--border)"><td style="padding:5px 8px 5px 0;white-space:nowrap"><span class="pm-glyph pm-t-${t}" style="vertical-align:-2px;margin-right:5px">${icon[m.ui](11)}</span>${esc(m.name)}</td><td style="color:var(--text-dim);padding-right:8px">${m.role === 'coordinator' ? 'coord.' : 'worker'}</td><td style="padding-right:8px"><span class="pm-badge pm-t-${t}">${word[m.ui]}</span></td><td style="padding-right:8px;color:var(--text-dim);font-size:11px">${m.pauseConfirmVia === 'member' ? 'accusé' : m.pauseConfirmVia === 'host-idle' ? 'au repos' : m.pauseConfirmVia === 'trap' ? 'trap hôte' : '—'}</td><td style="padding-right:8px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-dim)">${f.ref ? esc(f.ref) : '—'}</td><td style="padding-right:8px;font-size:11px">${f.none ? '—' : f.dirty ? esc(chText(f.ch)) : 'propre'}</td><td style="font-size:11px;color:var(--text-dim)">${f.none ? 'après l\'escalade' : f.killed.length ? `${f.killed.length} tué${f.killed.length > 1 ? 's' : ''} · <span style="font-family:var(--font-mono)">${esc(f.killed[0].cmd.slice(0, 26))}</span>` : f.exempt ? 'exempté (pauseur)' : '—'}</td>${k === 'resuming' ? `<td style="text-align:right">${m.ui === 'blocked' ? '<button class="pm-btn pm-go" style="padding:1px 7px;font-size:10.5px">Libérer</button>' : ''}</td>` : ''}</tr>`; }).join('');
    mount(`<h3>Pause de flotte</h3>
      ${h ? `<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;border-left:3px solid ${ink[h.t]}"><span style="color:${ink[h.t]};display:flex">${h.ic}</span><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:12.5px">${h.title}</div><div style="color:var(--text-dim);font-size:11px;margin-top:1px">${h.sub}</div></div><div style="width:150px"><div class="pm-bar"><i class="pm-fill-${h.t}" style="width:${Math.round(h.pct * 100)}%"></i></div><div style="font-size:10.5px;color:var(--text-dim);margin-top:3px;text-align:right">${h.count}</div></div><div style="display:flex;gap:6px">${actionsHtml(k)}</div></div>` : ''}
      <h3 style="margin-top:14px">Bilan de pause</h3>
      <table style="width:100%;border-collapse:collapse;font-size:11.5px;font-variant-numeric:tabular-nums"><thead><tr>${th('Agent')}${th('Rôle')}${th('État')}${th('Accusé')}${th('Snapshot (git diff &lt;head&gt; &lt;ref&gt;)')}${th('Arbre')}${th('Outils')}${k === 'resuming' ? th('') : ''}</tr></thead><tbody>${rows}</tbody></table>
      ${k === 'resuming' ? `<div style="margin-top:8px;font-size:11px;color:var(--text-dim)">Bloqués : ${state(k).reprise.blocked.map(nm).join(', ')} — leur coordinateur les libère (<span style="font-family:var(--font-mono)">orchestra run release</span>) ; vous pouvez aussi les libérer ici.</div>` : ''}`);
  }

  // ── B: stepper + banner + Bilan grouped by run with expandable details ──────────────────
  function busB(k) {
    dropExtras(); const h = header(k), ms = members(k), st = state(k).status;
    const step = (label, sub, on, done) => `<div style="display:flex;align-items:center;gap:8px;flex:1"><span style="width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;${done ? 'background:var(--accent);color:var(--accent-ink)' : on ? 'border:2px solid var(--accent);color:var(--accent)' : 'border:1px solid var(--border-strong);color:var(--text-dim)'}">${done ? I.check(11) : ''}</span><div><div style="font-size:12px;font-weight:600;color:${on || done ? 'var(--text)' : 'var(--text-dim)'}">${label}</div><div style="font-size:10.5px;color:var(--text-dim)">${sub}</div></div></div><span style="flex:0 0 28px;height:1px;background:var(--border-strong)"></span>`;
    const pausing = k === 'douce', resum = k === 'resuming', paused = k === 'dure';
    const stepper = `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:6px">${step('Pause', pausing ? `douce · ${st.summary.done}/${st.summary.total}` : fmtT(st.pausedAt), pausing, paused || resum)}${step('Bilan', paused || resum ? `snapshots ${st.summary.total}/${st.summary.total}` : 'à venir', paused, resum)}${step('Reprise', resum ? `${st.summary.done}/${st.summary.total} repris` : 'à venir', resum, false).replace(/<span[^>]*flex:0 0 28px[^>]*><\/span>$/, '')}</div>`;
    const byRun = [['fleet-lead — vague F (carrier)', ms.filter((m) => m.memberRun === st.carrierRunId && (m.role === 'coordinator' || m.name === 'docs-sweep'))], ['wave-f-ops — F1/F2', ms.filter((m) => !(m.memberRun === st.carrierRunId))]];
    const mrow = (m, open) => { const f = facts(m), t = tone(m.ui); return `<div style="border-top:1px solid var(--border);padding:6px 4px"><div style="display:flex;align-items:center;gap:8px"><span class="pm-glyph pm-t-${t}">${icon[m.ui](11)}</span><b style="font-weight:500;min-width:110px">${esc(m.name)}</b><span class="pm-badge pm-t-${t}" style="border-radius:4px;text-transform:uppercase;letter-spacing:.06em">${word[m.ui]}</span><span style="color:var(--text-dim);font-size:11px;flex:1">${f.doing === 'au repos' || f.none ? (f.none ? '—' : 'au repos') : `faisait : <span style="font-family:var(--font-mono)">${esc(String(f.doing).slice(0, 40))}</span>`}</span>${k === 'resuming' && m.ui === 'blocked' ? `<button class="pm-btn pm-go" style="padding:2px 8px">Libérer</button>` : ''}<span style="color:var(--text-dim);display:flex;transform:${open ? 'none' : 'rotate(-90deg)'}">${I.chev()}</span></div>${open ? `<div style="margin:6px 0 2px 24px;padding:6px 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;font-size:11px;display:grid;grid-template-columns:90px 1fr;gap:3px 10px"><span style="color:var(--text-dim)">snapshot</span><span style="font-family:var(--font-mono);font-size:10.5px">${f.ref ? esc(f.ref) : '—'} <span style="color:var(--text-dim)">· ${f.none ? 'pas encore de Bilan' : f.dirty ? esc(chText(f.ch)) : 'arbre propre'}</span></span><span style="color:var(--text-dim)">outils tués</span><span>${f.none ? 'pris à l\'escalade' : f.killed.length ? f.killed.map((c) => `<div><span style="font-family:var(--font-mono)">${esc(c.cmd.slice(0, 60))}</span> <span style="color:var(--text-dim)">· ${esc(c.cwd || '')}</span></div>`).join('') : f.exempt ? 'aucun (pauseur : son tour continue)' : 'aucun'}</span></div>` : ''}</div>`; };
    let opened = 0;
    mount(`<h3>Pause de flotte</h3>${stepper}
      <div style="display:flex;align-items:center;gap:12px;margin:10px 0 4px;padding:9px 12px;border-radius:6px;background:${h.t === 'pausing' ? 'rgba(255,200,87,.06)' : h.t === 'resumed' ? 'rgba(91,214,139,.06)' : 'rgba(110,168,255,.06)'};border:1px solid ${h.t === 'pausing' ? 'rgba(255,200,87,.28)' : h.t === 'resumed' ? 'rgba(91,214,139,.28)' : 'rgba(110,168,255,.28)'}"><span style="color:${ink[h.t]};display:flex">${h.ic}</span><div style="flex:1"><b style="font-size:12.5px">${h.title}</b> <span style="color:var(--text-dim);font-size:11px">— ${h.count}</span><div style="color:var(--text-dim);font-size:11px">${h.sub}</div></div><div style="display:flex;gap:6px">${actionsHtml(k)}</div></div>
      <h3 style="margin-top:14px">Bilan de pause</h3>
      ${byRun.map(([title, list]) => `<div style="margin-bottom:10px"><div style="font-size:11px;color:var(--text-dim);margin-bottom:2px">${title} — ${list.length} agents</div>${list.map((m) => mrow(m, opened++ < 2 && m.role !== 'coordinator')).join('')}</div>`).join('')}`);
  }

  // ── C: control-center — summary card + member cards with the Bilan facts ────────────────
  function busC(k) {
    dropExtras(); const h = header(k), ms = members(k), st = state(k).status, now = P.NOW(k);
    const ev = [[st.pausedAt, st.mode === 'soft' ? 'Pause douce posée' : 'Pause dure posée', 'paused'], ...(st.mode === 'soft' && st.phase !== 'pausing' ? [[st.escalatedAt, 'Escalade vers la dure', 'pausing']] : []), ...(st.trapAt ? [[st.trapAt, 'Bilan terminé — 7/7 snapshots', 'paused']] : []), ...(k === 'resuming' ? [[state(k).cols.resume_started_at, 'Reprise démarrée — coordinateurs libérés', 'resumed']] : [])].filter((e) => e[0]);
    const card = (m) => { const f = facts(m), t = tone(m.ui); return `<div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:9px 11px;display:flex;flex-direction:column;gap:5px;min-width:0"><div style="display:flex;align-items:center;gap:6px"><span class="pm-glyph pm-t-${t}">${icon[m.ui](11)}</span><b style="font-weight:600">${esc(m.name)}</b><span style="font-size:9.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em">${m.role === 'coordinator' ? 'coord.' : ''}</span><span class="pm-badge pm-t-${t}" style="margin-left:auto">${word[m.ui]}</span></div><div style="font-size:10.5px;color:var(--text-dim)">${f.none ? '—' : f.doing === 'au repos' ? 'au repos' : `faisait <span style="font-family:var(--font-mono)">${esc(String(f.doing).slice(0, 32))}</span>`}</div><div style="display:flex;gap:6px;align-items:center;font-family:var(--font-mono);font-size:10px;color:var(--text-dim)">${I.camera()}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.ref ? esc(f.ref) : '—'}</span></div><div style="display:flex;gap:10px;font-size:10.5px"><span>${f.none ? 'Bilan à l\'escalade' : f.dirty ? esc(chText(f.ch)) : 'arbre propre'}</span><span style="color:var(--text-dim)">${f.none ? '' : f.killed.length ? `${f.killed.length} outil${f.killed.length > 1 ? 's' : ''} tué${f.killed.length > 1 ? 's' : ''}` : f.exempt ? 'pauseur exempté' : '0 outil tué'}</span></div>${k === 'resuming' && m.ui === 'blocked' ? `<button class="pm-btn pm-go" style="align-self:flex-start;padding:2px 8px;font-size:10.5px">Libérer</button>` : ''}</div>`; };
    mount(`<h3>Pause de flotte</h3>
      <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start">
        <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;border-top:3px solid ${ink[h.t]}">
          <div style="display:flex;gap:9px;align-items:center;color:${ink[h.t]}">${h.ic}<b style="font-size:14px;color:var(--text)">${h.title}</b></div>
          <div style="font-size:30px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums">${state(k).status.summary.done}<span style="color:var(--text-dim);font-size:18px">/${state(k).status.summary.total}</span> <span style="font-size:12px;color:var(--text-dim);font-weight:400;letter-spacing:0">${k === 'resuming' ? 'repris' : 'en pause'}</span></div>
          <div class="pm-bar" style="height:5px"><i class="pm-fill-${h.t}" style="width:${Math.round(h.pct * 100)}%"></i></div>
          <div style="font-size:11px;color:var(--text-dim);line-height:1.5">${h.sub}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${actionsHtml(k)}</div>
          <div style="border-top:1px solid var(--border);padding-top:8px;display:flex;flex-direction:column;gap:5px">${ev.map(([t0, lab, tn]) => `<div style="display:flex;gap:8px;font-size:11px"><span style="width:7px;height:7px;border-radius:50%;background:${ink[tn]};margin-top:5px"></span><span style="color:var(--text-dim);font-variant-numeric:tabular-nums;width:56px">${fmtT(t0)}</span><span>${lab}</span></div>`).join('')}</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">${ms.map(card).join('')}</div>
      </div>`);
  }

  // ── refusals ────────────────────────────────────────────────────────────────────────────
  const refuse = (o) => `<div class="pm-refuse ${o.kind === 'info' ? 'pm-info' : ''}" ${o.kind === 'warn' ? 'style="border-color:rgba(255,200,87,.34);border-left-color:var(--yellow);background:rgba(255,200,87,.07)"' : ''}>${o.kind === 'info' ? I.info(13) : o.kind === 'warn' ? I.info(13).replace('currentColor', 'currentColor') : I.ban(13)}<div><b>${o.title}</b><span class="pm-why">${o.why}</span>${o.fix ? `<div class="pm-fix">${o.fix}</div>` : ''}</div></div>`;
  const RF = {
    worker: { title: 'Pause refusée — pause-ui-f1 est un worker', why: 'La pause se pose sur une vague, pas sur un agent seul : seul son coordinateur (<code>wave-f-ops</code>) ou un orchestrateur au-dessus (<code>fleet-lead</code>) la décide.', fix: `<button class="pm-btn pm-primary">${I.pause()}Mettre wave-f-ops en pause…</button><button class="pm-btn pm-ghost">Voir wave-f-ops</button>` },
    off: { title: 'Pause désactivée sur cette vague', why: 'Le switch « Pause » était OFF quand <code>legacy-sweep</code> a démarré (il est figé au démarrage de la vague) : rien n\'a été écrit, aucun agent touché.', fix: `<button class="pm-btn pm-ghost">Réglages › Fleet bus switches</button><span style="color:var(--text-dim);font-size:10.5px">puis nouvelle vague · ou <code>orchestra run refreeze</code></span>` },
    covered: { kind: 'info', title: 'fleet-lead tient déjà cette vague en pause', why: '<code>wave-f-ops</code> n\'a pas de pause propre : c\'est celle de <code>fleet-lead</code> (posée il y a 8 min). Reprenez depuis fleet-lead.', fix: `<button class="pm-btn pm-go">${I.play()}Reprendre fleet-lead…</button>` },
    bus: { title: 'Bus de flotte indisponible', why: 'L\'état de pause ne peut être ni lu ni écrit — rien n\'a été changé. Le bus ne bloque pas le démarrage ; voir le journal (<code>bus.sqlite</code>).', fix: `<button class="pm-btn pm-ghost">Page Bus</button>` },
    below: { kind: 'warn', title: 'Libérer tout : 3 agents laissés à leur coordinateur', why: '<code>pause-ui-f1</code>, <code>canary-f2</code> appartiennent à la vague <code>wave-f-ops</code> : « tout libérer » ne libère que les membres de la vague de fleet-lead (docs-sweep ✓). Libérez-les un par un, ou depuis wave-f-ops.', fix: `<button class="pm-btn pm-go">Libérer pause-ui-f1</button><button class="pm-btn pm-go">Libérer canary-f2</button>` },
  };
  const hoverPop = (rowName, k, btns) => {
    const row = rowOf(rowName), r = rect(row), mid = r.top + r.height / 2, left = rect(document.querySelector('.sidebar')).right + 6;
    row.style.background = 'var(--bg-3)';
    const pop = add(`<div class="ws-row-actions-pop" style="left:${left}px;top:${mid}px;animation:none">${btns.map(([ic, tn]) => `<button class="ws-icon-btn" style="${tn === 'on' ? 'background:var(--hover-bg);color:var(--text)' : tn === 'go' ? 'color:var(--green)' : ''}">${I[ic](13)}</button>`).join('')}</div>`);
    return { left, mid, row, r };
  };
  function refusalA(kind) {
    dropExtras();
    const spec = { worker: ['pause-ui-f1', 'idle', [['pause', 'on'], ['archive']]], off: ['legacy-sweep', 'idle', [['pause', 'on'], ['archive']]], covered: ['wave-f-ops', 'dure', [['play', 'go'], ['archive']]], bus: ['fleet-lead', 'idle', [['pause', 'on'], ['archive']]], below: ['fleet-lead', 'resuming', [['play', 'go'], ['pause'], ['archive']]] }[kind];
    P.sidebar.A(spec[1]); document.querySelectorAll('.ws-row-actions-pop,.pm-tip,.pm-menu').forEach((e) => e.remove());
    const { left, mid } = hoverPop(spec[0], spec[1], spec[2]);
    add(`<div class="pm-menu" style="left:${left}px;top:${mid + 22}px;width:300px;padding:6px">${refuse(RF[kind])}</div>`);
    return { y: Math.max(112, mid - 150), h: 400, w: 660 };
  }
  function refusalB(kind) {
    dropExtras(); P.sidebar.B(kind === 'covered' ? 'dure' : kind === 'below' ? 'resuming' : 'idle'); document.querySelectorAll('.pm-menu').forEach((e) => e.remove());
    const mk = (afterRow, html, depth) => { const d = document.createElement('div'); d.className = 'pm-x'; d.style.cssText = `padding:2px 10px 8px calc(12px + ${depth} * 16px + 19px)`; d.innerHTML = html; rowOf(afterRow).after(d); return d; };
    const strips = [...document.querySelectorAll('.pm-strip')];
    const stripFor = (name) => rowOf(name).nextElementSibling;
    let anchor;
    if (kind === 'worker') { const row = rowOf('pause-ui-f1'); row.style.background = 'var(--bg-3)'; const d = mk('pause-ui-f1', refuse(RF.worker), 2); anchor = d; }
    if (kind === 'off') { const s = stripFor('legacy-sweep'); s.innerHTML = refuse(RF.off); anchor = s; }
    if (kind === 'covered') { const s = stripFor('wave-f-ops'); s.innerHTML = refuse(RF.covered); anchor = s; }
    if (kind === 'bus') { const s = stripFor('fleet-lead'); s.innerHTML = refuse(RF.bus); anchor = s; }
    if (kind === 'below') { const s = stripFor('fleet-lead'); s.insertAdjacentHTML('beforeend', refuse(RF.below)); anchor = s; }
    const r = rect(anchor); return { y: Math.max(112, r.top - 130), h: 420, w: 345 };
  }
  function refusalC(kind) {
    dropExtras(); P.sidebar.C(kind === 'covered' ? 'dure' : kind === 'below' ? 'resuming' : 'idle'); document.querySelectorAll('.pm-card').forEach((e) => e.remove());
    const rowName = { worker: 'pause-ui-f1', off: 'legacy-sweep', covered: 'wave-f-ops', bus: 'fleet-lead', below: 'fleet-lead' }[kind];
    const row = rowOf(rowName), r = rect(row);
    row.style.background = 'var(--bg-3)';
    const sub = { worker: 'worker de wave-f-ops', off: 'Pause : OFF sur cette vague', covered: 'en pause via fleet-lead', bus: '—', below: 'Reprise · 3/7 repris' }[kind];
    const title = { worker: 'pause-ui-f1', off: 'Mettre legacy-sweep en pause', covered: 'wave-f-ops', bus: 'Mettre fleet-lead en pause', below: 'Reprise en cours' }[kind];
    const dis = (kind === 'off' || kind === 'bus') ? `<div style="padding:0 8px 8px;display:flex;flex-direction:column;gap:2px;opacity:.4"><div class="new-menu-item"><span class="new-menu-item-icon" style="color:var(--yellow)">${I.clock(15)}</span><span class="new-menu-item-body"><span class="new-menu-item-title">Pause douce</span></span></div><div class="new-menu-item"><span class="new-menu-item-icon" style="color:var(--accent)">${I.pause(15)}</span><span class="new-menu-item-body"><span class="new-menu-item-title">Pause dure</span></span></div></div>` : '';
    add(`<div class="pm-card" style="left:14px;top:${r.bottom + 8}px;width:316px"><div class="pm-card-h">${I.pause(15)}<div><b>${title}</b><small>${sub}</small></div></div>${dis}<div style="padding:0 10px 10px">${refuse(RF[kind])}</div></div>`);
    return { y: Math.max(112, r.top - 30), h: 420, w: 345 };
  }
  P.bus = { A: busA, B: busB, C: busC };
  P.refusal = { A: refusalA, B: refusalB, C: refusalC };
})();
