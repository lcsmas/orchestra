// MOCKUP KIT (F1 #257) — injected into the REAL renderer of the packaged app; uses the app's own CSS tokens/classes.
// Everything it draws is prefixed pm-; nothing here is shipped (branch pause-ui-mockups-257, never merged).
window.PM = (() => {
  const D = window.__PM_DATA;
  const names = D.names;
  const nm = (id) => names[id] || id.slice(0, 8);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = (inner, w = 12, h = 12, vb = '0 0 16 16', extra = '') => `<svg viewBox="${vb}" width="${w}" height="${h}" aria-hidden="true" ${extra}>${inner}</svg>`;
  const I = {
    pause: (s = 12) => svg('<rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/>', s, s),
    play: (s = 12) => svg('<path d="M4.5 2.5v11l9-5.5z" fill="currentColor"/>', s, s),
    stop: (s = 12) => svg('<rect x="3" y="3" width="10" height="10" rx="1.6" fill="currentColor"/>', s, s),
    check: (s = 12) => svg('<path d="M3.5 8.6l3 3 6-7.2" stroke="currentColor" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>', s, s),
    clock: (s = 12) => svg('<circle cx="8" cy="8" r="6" stroke="currentColor" fill="none" stroke-width="1.5"/><path d="M8 4.6V8l2.3 1.5" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>', s, s),
    info: (s = 12) => svg('<circle cx="8" cy="8" r="6.2" stroke="currentColor" fill="none" stroke-width="1.5"/><path d="M8 7.2v4M8 4.9v.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>', s, s),
    ban: (s = 12) => svg('<circle cx="8" cy="8" r="6.2" stroke="currentColor" fill="none" stroke-width="1.5"/><path d="M3.9 12.1l8.2-8.2" stroke="currentColor" stroke-width="1.5"/>', s, s),
    chev: (s = 10) => svg('<path d="M4 6l4 4 4-4" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>', s, s),
    archive: (s = 13) => svg('<rect x="2" y="3" width="12" height="3" rx="1" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M3 6v6.2c0 .5.4.8.8.8h8.4c.4 0 .8-.3.8-.8V6M6.5 9h3" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round"/>', s, s),
    flag: (s = 12) => svg('<path d="M4 14V2.5M4 3h8l-2 3 2 3H4" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linejoin="round"/>', s, s),
    camera: (s = 11) => svg('<rect x="2" y="4.5" width="12" height="8.5" rx="1.6" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="8" cy="8.7" r="2.3" stroke="currentColor" fill="none" stroke-width="1.3"/>', s, s),
  };
  const state = (k) => D.states[k];
  const leftStr = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const ago = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? '<1 min' : `${m} min`; };

  /** per-member UI state — derived ONLY from what the real readers return (phase + roster row). */
  function members(k) {
    const st = state(k).status, rp = state(k).reprise;
    if (!st) return [];
    return st.rows.map((r) => {
      let s;
      if (st.phase === 'resuming') s = r.releasedAt ? (r.repriseConfirmedAt ? 'resumed' : 'released') : 'blocked';
      else if (st.phase === 'pausing') s = r.pauseConfirmedAt ? 'paused' : 'pausing';
      else s = 'paused';
      const bil = state(k).bilan.find((b) => b.wsId === r.wsId) || null;
      return { ...r, name: nm(r.wsId), ui: s, bilan: bil };
    });
  }
  const NOW = (k) => { const st = state(k).status; if (!st) return Date.now(); return k === 'douce' ? st.pausedAt + 70_000 : st.pausedAt + 8 * 60_000 + 20_000; };
  const rowOf = (name) => [...document.querySelectorAll('.ws-item')].find((r) => (r.querySelector('.ws-name')?.textContent || '') === name);
  const css = `
  .pm-badge{display:inline-flex;align-items:center;gap:3px;flex:none;height:15px;padding:0 5px;border-radius:999px;font-size:9px;font-weight:600;letter-spacing:.03em;line-height:1;border:1px solid transparent;white-space:nowrap}
  .pm-badge svg{width:9px;height:9px}
  .pm-t-paused{color:var(--accent);background:rgba(110,168,255,.10);border-color:rgba(110,168,255,.30)}
  .pm-t-pausing{color:var(--yellow);background:rgba(255,200,87,.10);border-color:rgba(255,200,87,.32)}
  .pm-t-blocked{color:var(--accent);background:rgba(110,168,255,.06);border-color:rgba(110,168,255,.22);opacity:.9}
  .pm-t-released{color:var(--green);background:rgba(91,214,139,.08);border-color:rgba(91,214,139,.30)}
  .pm-t-resumed{color:var(--green);background:rgba(91,214,139,.14);border-color:rgba(91,214,139,.40)}
  .pm-t-none{color:var(--text-dim);background:transparent;border-color:var(--border)}
  .pm-dim .ws-name{color:var(--text-dim)!important}
  .ws-boot-stall-badge,.ws-stall-badge{display:none!important}
  .pm-glyph{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;flex:none}
  .pm-glyph.pm-t-paused,.pm-glyph.pm-t-blocked{color:var(--accent);background:none;border:none}
  .pm-glyph.pm-t-pausing{color:var(--yellow);background:none;border:none}
  .pm-glyph.pm-t-released,.pm-glyph.pm-t-resumed{color:var(--green);background:none;border:none}
  .pm-bar{height:3px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden}
  .pm-bar>i{display:block;height:100%;border-radius:2px}
  .pm-fill-paused{background:var(--accent)}.pm-fill-pausing{background:var(--yellow)}.pm-fill-resumed{background:var(--green)}
  .pm-rowbar{position:absolute;left:12px;right:8px;bottom:0;height:2px}
  .pm-tip{position:fixed;z-index:80;padding:4px 8px;border-radius:6px;background:#000;border:1px solid var(--border-strong);font-size:11px;color:var(--text);white-space:nowrap;box-shadow:var(--shadow-md);pointer-events:none}
  .pm-menu{position:fixed;z-index:70;width:262px;display:flex;flex-direction:column;gap:2px;padding:var(--space-1);background:var(--bg-3);border:1px solid var(--border-strong);border-radius:var(--radius);box-shadow:var(--shadow-md)}
  .pm-menu .pm-menu-h{padding:6px 9px 4px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)}
  .pm-menu .new-menu-item.is-off{opacity:.45}
  .pm-btn{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:var(--radius-sm);font-size:11.5px;font-weight:600;white-space:nowrap;border:1px solid var(--border-strong);background:var(--bg-3);color:var(--text);box-shadow:none}
  .pm-btn.pm-primary{background:rgba(110,168,255,.10);border-color:rgba(110,168,255,.35);color:var(--accent)}
  .pm-btn.pm-go{background:rgba(91,214,139,.10);border-color:rgba(91,214,139,.38);color:var(--green)}
  .pm-btn.pm-warn{background:rgba(255,200,87,.09);border-color:rgba(255,200,87,.34);color:var(--yellow)}
  .pm-btn.pm-ghost{background:transparent;border-color:var(--border);color:var(--text-dim)}
  .pm-btn.pm-off{opacity:.45}
  .pm-btn svg{width:11px;height:11px}
  .pm-refuse{display:flex;gap:9px;padding:9px 11px;border:1px solid rgba(255,107,107,.32);border-left:3px solid var(--red);border-radius:var(--radius-sm);background:rgba(255,107,107,.07);font-size:11.5px;line-height:1.4}
  .pm-refuse>svg{flex:none;margin-top:1px;color:var(--red);width:13px;height:13px}
  .pm-refuse b{display:block;font-size:12px;margin-bottom:2px}
  .pm-refuse .pm-why{color:var(--text-dim)}
  .pm-refuse .pm-fix{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .pm-refuse code{font-family:var(--font-mono);font-size:10.5px;background:rgba(255,255,255,.06);padding:0 4px;border-radius:4px}
  .pm-info{border-color:rgba(110,168,255,.30);border-left-color:var(--accent);background:rgba(110,168,255,.06)}
  .pm-info>svg{color:var(--accent)}
  .pm-cap{position:absolute;top:0;left:0;right:0;padding:8px 12px;background:#000;color:var(--text);font-size:12px;font-weight:600;letter-spacing:.02em;border-bottom:1px solid var(--border-strong);z-index:90}
  .pm-cap small{display:block;font-weight:400;color:var(--text-dim);font-size:10.5px;margin-top:1px}
  `;
  function install() { let s = document.getElementById('pm-css'); if (!s) { s = document.createElement('style'); s.id = 'pm-css'; document.head.appendChild(s); } s.textContent = css + (PM.extraCss || ''); }
  const tone = (u) => ({ paused: 'paused', pausing: 'pausing', blocked: 'blocked', released: 'released', resumed: 'resumed' }[u] || 'none');
  const word = { paused: 'en pause', pausing: 'finit…', blocked: 'bloqué', released: 'libéré', resumed: 'repris' };
  const icon = { paused: I.pause, pausing: I.clock, blocked: I.pause, released: I.play, resumed: I.check };
  return { D, nm, esc, svg, I, state, leftStr, ago, members, NOW, rowOf, install, tone, word, icon, extraCss: '' };
})();
