// Shared HTML helpers: escaping, SVG icons, iPhone chrome (status bar, home
// indicator, AZERTY keyboard) and the page shell.

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const P = {
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  wifiOff: '<path d="m2 2 20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 13a10 10 0 0 1 5.24-2.76"/><path d="M12 20h.01"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54Z"/>',
  return: '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
};
export const icon = (n, size = 18, cls = '') =>
  `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;

export const toolIcon = (kind, size = 14) => icon({ search: 'search', file: 'file', edit: 'edit', bash: 'terminal' }[kind] || 'terminal', size);

// Spinner ring (a frozen 3/4 arc — screenshots are static).
export const ring = (size = 16, w = 2.2) =>
  `<svg class="ic ring" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w * 24 / size}" stroke-linecap="round"><circle cx="12" cy="12" r="9" stroke-opacity=".22"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>`;

export function statusBar() {
  return `<div class="sb"><span class="sb-time">9:41</span><span class="sb-island"></span><span class="sb-right">
    <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>
    <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.3c2.3 0 4.4.9 6 2.4l1.1-1.2A10.4 10.4 0 0 0 8.5.6C5.8.6 3.3 1.6 1.4 3.5l1.1 1.2a8.7 8.7 0 0 1 6-2.4Zm0 3.4c1.4 0 2.6.5 3.6 1.4l1.1-1.2a7 7 0 0 0-9.4 0l1.1 1.2c1-.9 2.2-1.4 3.6-1.4Zm0 3.3c-.6 0-1.2.2-1.6.7L8.5 11.4 10.1 9.7A2.3 2.3 0 0 0 8.5 9Z"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x=".5" y=".5" width="22" height="12" rx="3.6" stroke="currentColor" opacity=".45"/><rect x="2" y="2" width="19" height="9" rx="2.4" fill="currentColor"/><path d="M24 4.4v4.2c.9-.3 1.6-1.2 1.6-2.1s-.7-1.8-1.6-2.1Z" fill="currentColor" opacity=".5"/></svg>
  </span></div>`;
}
export const homeBar = () => '<div class="home"></div>';

// iOS AZERTY keyboard (theme via .kb-dark / .kb-light, styled in base.css).
export function keyboard(theme = 'dark') {
  const row = (letters) => letters.split('').map((k) => `<i>${k}</i>`).join('');
  return `<div class="kb kb-${theme}">
    <div class="kb-pred"><span>ensuite</span><span>et</span><span>la</span></div>
    <div class="kb-keys">
      <div class="kb-row">${row('azertyuiop')}</div>
      <div class="kb-row">${row('qsdfghjklm')}</div>
      <div class="kb-row"><i class="fn w">⇧</i>${row('wxcvbn')}<i class="fn w">⌫</i></div>
      <div class="kb-row b"><i class="fn big">123</i><i class="space">espace</i><i class="fn big">retour</i></div>
    </div>
  </div>`;
}

export function page({ title, cls, body }) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=390, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="stylesheet" href="../shared/base.css">
<link rel="stylesheet" href="style.css">
</head><body><div class="phone ${cls}">${statusBar()}${body}${homeBar()}</div></body></html>
`;
}

// Consecutive tool turns become one { role: 'tools', items } group (each item stays ONE line).
export function groupTools(turns) {
  const out = [];
  for (const t of turns) {
    if (t.role === 'tool') {
      const last = out[out.length - 1];
      if (last && last.role === 'tools') last.items.push(t); else out.push({ role: 'tools', items: [t] });
    } else out.push(t);
  }
  return out;
}
