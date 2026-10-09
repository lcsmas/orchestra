// Render smoke-test for the Plafond mémoire UI (#323, D-Q10 = A + A): the thin cap bar under a capped member's MEM figure (Resources page) and the « Plafond mémoire » section of the Memory guard window.
// `node --test` strips types but does NOT transform JSX, so the unit suite proves the numbers and the commit rules (memory-cap-view / memory-guard-view) but not that they REACH the HTML; scripts/memcap-screenshot.mjs
// + scripts/memcap-settings/ prove they reach PIXELS on the real stylesheet / the BUILT app. SELECTOR CONTRACT: assertions key on data-* hooks and rendered TEXT — never tag or DOM position.
import { createRequire } from 'node:module';
import { renderToString } from 'react-dom/server';
import React from 'react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try { return require_('esbuild'); } catch {
    const store = fs.globSync?.(process.cwd() + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
}
const { build } = loadEsbuild();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const outfile = path.join(cache, 'memcap-settings-smoke.mjs');
const entryFile = path.join(cache, 'memcap-settings-smoke-entry.tsx');
const shim = path.join(cache, 'memcap-portal-shim.mjs');
fs.writeFileSync(shim, 'export const createPortal = (node) => node;\n'); // a server render cannot render a portal: the window's body is what is under test
const C = (rel) => JSON.stringify(path.join(repoRoot, rel));
fs.writeFileSync(entryFile, `export { CapBar } from ${C('src/renderer/components/CapBar.tsx')};\nexport { AgentsTable } from ${C('src/renderer/components/ResourcesView.tsx')};\nexport { MemoryGuardSettings } from ${C('src/renderer/components/MemoryGuardSettings.tsx')};\n`);
await build({
  entryPoints: [entryFile], outfile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom/server', 'react/jsx-runtime'], loader: { '.css': 'empty' }, logLevel: 'silent',
  plugins: [{ name: 'portal-shim', setup(b) { b.onResolve({ filter: /^react-dom$/ }, () => ({ path: shim })); } }],
});
globalThis.self = globalThis;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, orchestra: new Proxy({}, { get: (_t, k) => (String(k).startsWith('on') ? () => () => {} : async () => []) }) };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {}, body: {}, hidden: false };
const { CapBar, AgentsTable, MemoryGuardSettings } = await import(`${outfile}?t=${Date.now()}`);

let failures = 0;
const check = (label, cond, detail = '') => { if (cond) console.log(`  ok   ${label}`); else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } };
const html = (el) => renderToString(el).replace(/<!-- -->/g, '');
const h = React.createElement;
const GB = 1024 ** 3;
const cap = (billGb, wsGb, hardGb = 6, peakGb = null) => ({ unit: 'u.scope', hardBytes: hardGb * GB, billBytes: billGb * GB, workingSetBytes: wsGb === null ? null : wsGb * GB, peakBytes: peakGb === null ? null : peakGb * GB });
const LV = { softGb: 3, hardGb: 6 };

console.log('\nCapBar (Resources, D-Q10 A):');
const ok = html(h(CapBar, { cap: cap(2.1, 1.6, 6, 2.4), levels: LV }));
check('comfortable member: 35 % of the hard level, tone ok, hooks', ok.includes('data-res-cap="35"') && ok.includes('data-res-cap-tone="ok"') && ok.includes('tone-ok'), ok);
check('fill = bill / hard (35 %), the darker inner part = working set / hard (26.7 %), the tick = the soft level (50 %)', ok.includes('res-capbar-fill" style="width:35.0%') && ok.includes('res-capbar-ws" style="width:26.7%') && ok.includes('res-capbar-soft" style="left:50.0%'), ok);
check('the tooltip names BOTH figures with what each is compared to, the kernel-held hard level and the soft level of the settings', /title="2\.1 GB kernel bill \(what the hard level compares\) · 1\.6 GB working set \(what the soft level compares\) · peak 2\.4 GB · soft 3 GB \(settings now\), hard 6 GB \(held by the kernel for this session\)"/.test(ok), ok);
check('working set at/over the soft level ⇒ AMBER', html(h(CapBar, { cap: cap(3.4, 3.1), levels: LV })).includes('data-res-cap-tone="warn"'));
check('bill ≥ 90 % of the hard level ⇒ RED (wins over amber)', html(h(CapBar, { cap: cap(5.6, 4.0), levels: LV })).includes('data-res-cap-tone="crit"'));
check('a big page cache alone (bill 4.5 GB, working set 1.2 GB) is NOT a soft warning', html(h(CapBar, { cap: cap(4.5, 1.2), levels: LV })).includes('data-res-cap-tone="ok"'));
check('the bar never draws past its track (bill 6.4 of 6 GB ⇒ 100 %), while the percentage stays honest', (() => { const o = html(h(CapBar, { cap: cap(6.4, 5.0), levels: LV })); return o.includes('res-capbar-fill" style="width:100.0%') && o.includes('data-res-cap="107"'); })());
const noWs = html(h(CapBar, { cap: cap(2.1, null), levels: LV }));
check('working set unreadable ⇒ no inner part and no « working set » in the tooltip (never a fabricated figure)', !noWs.includes('res-capbar-ws') && !noWs.includes('working set'), noWs);
const noLv = html(h(CapBar, { cap: cap(2.1, 1.6), levels: null }));
check('an older main that sends no levels ⇒ no tick, no tone from the soft level, the tooltip says only what the kernel holds', !noLv.includes('res-capbar-soft') && !noLv.includes('settings now') && noLv.includes('held by the kernel'), noLv);
check('levels changed since the member started ⇒ the tooltip says so (hard 8 now, 6 held)', html(h(CapBar, { cap: cap(2.1, 1.6, 6), levels: { softGb: 4, hardGb: 8 } })).includes('settings now say hard 8 GB'));

console.log('\nAgentsTable (Resources page):');
const sess = (id) => ({ ptyId: `${id}:sdk`, workspaceId: id, kind: 'sdk', remote: false, cpuPct: 5, memBytes: 100 * 1024 ** 2, procCount: 3, processes: [] });
const row = (key, capView) => ({ key, sessions: [sess(key)], cpuPct: 5, memBytes: capView ? capView.billBytes : 100 * 1024 ** 2, procCount: 3, remote: false, containers: null, containerOnly: false, reliquats: null, scopeOnly: false, cap: capView, ws: null, fallbackName: key });
const table = (rows, extra = {}) => html(h(AgentsTable, { rows, loginSessions: [], traceOf: () => [], diskOf: () => undefined, ctxOf: () => undefined, accountLabelFor: () => null, warning: null, ...extra }));
const t1 = table([row('feat-x', cap(2.1, 1.6)), row('big-job', cap(5.6, 4)), row('human-ws', null)], { capLevels: LV, capLine: '2 capped members · closest: big-job 93 % of 6.0 GB' });
check('a capped member\'s MEM cell carries the bar (3 rows, 2 bars); the uncapped member\'s cell is today\'s plain figure', (t1.match(/data-res-cap="/g) ?? []).length === 2 && (t1.match(/res-cell res-mem/g) ?? []).length === 2, t1.slice(0, 200));
check('the bar sits INSIDE the memory cell, after the figure', /<span class="res-cell res-mem">[^<]*GB<span class="res-capbar/.test(t1), t1.slice(t1.indexOf('res-mem') - 20, t1.indexOf('res-mem') + 260));
check('the dim summary line under the table (information, role=note)', t1.includes('data-res-cap-note=""') && t1.includes('2 capped members · closest: big-job 93 % of 6.0 GB') && /role="note"[^>]*data-res-cap-note/.test(t1), t1.slice(-300));
const t0 = table([row('feat-y', null), row('human-ws', null)], { capLevels: LV, capLine: null });
check('CONTROL — a fleet with no capped member: no bar, no summary line, byte-for-byte today\'s rows', !t0.includes('data-res-cap') && !t0.includes('res-capbar') && !t0.includes('res-mem'), t0.slice(0, 200));
check('a capped member of an older main (no levels): the bar is still drawn from what the kernel holds', table([row('feat-x', cap(2.1, 1.6))]).includes('data-res-cap="35"'));

console.log('\nMemory guard window — Plafond mémoire section (D-Q10 A):');
const settings = { admissionGb: 6, criticalGb: 3, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 };
const snapshot = { sampled: true, measured: true, availBytes: 11.4 * GB, readAt: 1, admission: 'open', admissionEnabled: true, pause: 'none', episode: 0, pauseCycle: 0, mayReleaseOneStart: true, heldSince: null, pauseSince: null, admissionBytes: 6 * GB, criticalBytes: 3 * GB, releaseMarginBytes: GB, sampleIntervalMs: 60000 };
const view = { settings, snapshot, liveAvailBytes: 11.4 * GB, totalBytes: 32 * GB };
const sw = (liveOn, runsOn, runsOpen) => ({ liveOn, runsOn, runsOpen, text: `Cap is ${liveOn ? 'ON' : 'OFF'} for new runs · ON on ${runsOn} of ${runsOpen} open runs` });
const w = html(h(MemoryGuardSettings, { onClose: () => {}, initial: { view, capSwitch: sw(false, 0, 3) } }));
check('the section is there, titled « Plafond mémoire », under the existing thresholds and toggle', w.includes('data-mg-cap-section') && w.includes('Plafond mémoire') && w.indexOf('data-mg-toggle') < w.indexOf('data-mg-cap-section') && w.indexOf('data-mg-critical') < w.indexOf('data-mg-cap-section'), w.slice(w.indexOf('data-mg-cap-section') - 200, w.indexOf('data-mg-cap-section') + 100));
check('soft and hard inputs hold the stored levels (3 / 6 GB), labelled for assistive tech', /aria-label="Memory cap soft level \(GB\)"[^>]*data-mg-cap-soft[^>]*value="3"/.test(w) && /aria-label="Memory cap hard level \(GB\)"[^>]*data-mg-cap-hard[^>]*value="6"/.test(w), w.slice(w.indexOf('data-mg-cap-soft') - 120, w.indexOf('data-mg-cap-soft') + 120));
check('the activation is SHOWN read-only (D-Q1): the live default + the open runs that froze it ON — and there is no control for it', w.includes('Cap is OFF for new runs · ON on 0 of 3 open runs') && w.includes('data-mg-cap-switch="off"') && (w.match(/type="checkbox"/g) ?? []).length === 1, `${(w.match(/type="checkbox"/g) ?? []).length} checkbox(es)`);
check('it says where the switch IS set, and that levels apply to members started from now on', w.includes('set it on the Bus page, not here') && w.includes('Applies to members started from now on; running sessions keep what they started with.'));
check('what each level does is stated (soft: warns the member and its coordinator, no slowdown; hard: the kernel kills the heaviest tool process)', w.includes('Warns the member and its coordinator when its working set crosses it. No slowdown.') && w.includes('beyond it the heaviest tool process of the member is killed'));
check('the ON state reads ON', html(h(MemoryGuardSettings, { onClose: () => {}, initial: { view, capSwitch: sw(true, 2, 2) } })).includes('data-mg-cap-switch="on"'));
check('nothing is refused at rest: no error line', !w.includes('data-mg-error'));
const loading = html(h(MemoryGuardSettings, { onClose: () => {} }));
check('before the first read the cap inputs are DISABLED and empty (never a number the backend did not give); the switch line is a placeholder', /data-mg-cap-soft[^>]*disabled/.test(loading) && /data-mg-cap-hard[^>]*disabled/.test(loading) && loading.includes('data-mg-cap-switch=""'), loading.slice(loading.indexOf('data-mg-cap-section'), loading.indexOf('data-mg-cap-section') + 300));
check('the existing threshold fields are untouched (admission 6, critical 3)', /data-mg-admission[^>]*value="6"/.test(w) && /data-mg-critical[^>]*value="3"/.test(w));

console.log(`\nmemcap-settings-render-smoke: ${failures === 0 ? 'all checks passed' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
