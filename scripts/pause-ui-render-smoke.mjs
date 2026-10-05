// Render smoke-test for the fleet-Pause UI components (#257): `node --test` strips types but does NOT transform JSX, so the unit suite proves the data layer and the pure helpers
// but says nothing about whether the states reach the HTML. This proves they do (string claims, over react-dom/server); scripts/pause-ui/e2e-pause-ui.sh proves they reach PIXELS
// on the BUILT app. SELECTOR CONTRACT: assertions key on data-pause-* hooks and rendered TEXT — never tag or DOM position.
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
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'pause-ui-smoke.mjs');
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'pause-ui-smoke-entry.tsx');
fs.mkdirSync(path.dirname(entryFile), { recursive: true });
const comps = fs.readdirSync(path.join(repoRoot, 'src/renderer/components/pause')).filter((f) => f.endsWith('.tsx')).map((f) => path.join(repoRoot, 'src/renderer/components/pause', f));
fs.writeFileSync(entryFile, comps.map((c, i) => `export * as m${i} from ${JSON.stringify(c)};`).join('\n') + '\n');
await build({ entryPoints: [entryFile], outfile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], loader: { '.css': 'empty' }, logLevel: 'silent' });
globalThis.self = globalThis;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, orchestra: {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
const mods = await import(`${outfile}?t=${Date.now()}`);
const all = Object.assign({}, ...Object.values(mods));

let failures = 0;
const check = (label, cond, detail = '') => { if (cond) console.log(`  ok   ${label}`); else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } };
const html = (el) => renderToString(el).replace(/<!-- -->/g, '');
const h = React.createElement;

console.log('\nPauseBlocks:');
for (const [ui, word, tone] of [['pausing', 'finit…', 'pausing'], ['paused', 'en pause', 'paused'], ['blocked', 'bloqué', 'paused'], ['released', 'libéré', 'resumed'], ['resumed', 'repris', 'resumed']]) {
  const out = html(h(all.PauseBadge, { wsId: 'w1', ui }));
  check(`badge ${ui}: word "${word}", tone ${tone}, hooks`, out.includes('data-pause-badge="w1"') && out.includes(`data-pause-state="${ui}"`) && out.includes(`${word}</span>`) && out.includes(`pause-t-${tone}`), out.slice(0, 240));
}
check('blocked badge carries is-blocked (dimmer than paused)', html(h(all.PauseBadge, { wsId: 'w', ui: 'blocked' })).includes('is-blocked') && !html(h(all.PauseBadge, { wsId: 'w', ui: 'paused' })).includes('is-blocked'));
check('glyph is icon-only with an accessible name', /data-pause-glyph="w1"/.test(html(h(all.PauseGlyph, { wsId: 'w1', ui: 'paused' }))) && html(h(all.PauseGlyph, { wsId: 'w1', ui: 'paused' })).includes('aria-label="en pause"'));
const bar = html(h(all.PauseBar, { fraction: 5 / 7, tone: 'pausing', done: 5, total: 7, kind: 'en-pause' }));
check('progress bar: 71 %, data hooks (done/total/kind), amber fill', bar.includes('width:71%') && bar.includes('data-done="5"') && bar.includes('data-total="7"') && bar.includes('data-kind="en-pause"') && bar.includes('pause-fill-pausing'), bar);
check('progress bar clamps (>1 → 100 %, <0 → 0 %)', html(h(all.PauseBar, { fraction: 3, tone: 'paused' })).includes('width:100%') && html(h(all.PauseBar, { fraction: -1, tone: 'paused' })).includes('width:0%'));
const ex = html(h(all.PauseExplain, { code: 'refused', explain: { tone: 'error', title: 'Pause refusée — worker-1 n\'est pas coordinateur de wave-ops', why: 'Rien n\'a été écrit.', fix: ['Mettre wave-ops en pause'] } }));
check('refusal block: alert role, tone, code hook, title, why, fix list', ex.includes('role="alert"') && ex.includes('data-pause-explain="error"') && ex.includes('data-pause-explain-code="refused"') && ex.includes('Pause refusée') && ex.includes('Rien n&#x27;a été écrit.') && ex.includes('<li>Mettre wave-ops en pause</li>'), ex);
check('info block is a status, not an alert', html(h(all.PauseExplain, { explain: { tone: 'info', title: 't', why: 'w', fix: [] } })).includes('role="status"'));
const on = html(h(all.PauseActionButton, { kind: 'hard', wsId: 'L', tone: 'primary', onClick: () => {} }, 'Pause dure'));
const off = html(h(all.PauseActionButton, { kind: 'hard', wsId: 'L', tone: 'primary', disabled: true, why: 'Pause désactivée sur cette vague', onClick: () => {} }, 'Pause dure'));
check('action button: data-pause-action / data-pause-for hooks', on.includes('data-pause-action="hard"') && on.includes('data-pause-for="L"') && !on.includes('aria-disabled'), on);
check('a disabled action is EXPLAINED (title) and marked', off.includes('aria-disabled="true"') && off.includes('title="Pause désactivée sur cette vague"') && off.includes('is-off'), off);

console.log(`\npause-ui-render-smoke: ${failures === 0 ? 'all checks passed' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
