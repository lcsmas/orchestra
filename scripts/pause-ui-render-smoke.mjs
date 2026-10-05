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
fs.writeFileSync(entryFile, comps.filter((c) => !c.endsWith('PauseMenu.tsx')).map((c, i) => `export * as m${i} from ${JSON.stringify(c)};`).join('\n') + `\nexport { useStore } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/store.ts'))};\nexport * as actions from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/pause/pause-actions.ts'))};\n`); // PauseMenu.tsx portals to <body>: react-dom/server cannot render a portal — the G3 drive covers it
await build({ entryPoints: [entryFile], outfile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], loader: { '.css': 'empty' }, logLevel: 'silent' });
globalThis.self = globalThis;
// the store subscribes to window.orchestra at import: a stub whose every member is a no-op (subscriptions return an unsubscribe fn)
const calls = [];
const api = { pauseRelease: async (...a) => { calls.push(['pauseRelease', ...a]); return { result: { released: a[1], refused: [], below: [], unknown: [], already: [], error: null, finished: false }, explain: [], overview: null }; }, pausePause: async (...a) => { calls.push(['pausePause', ...a]); return { outcome: 'refused', runId: 'O', actor: a[0], explain: { tone: 'error', title: 'Pause refusée', why: 'x', fix: [] }, cover: null, overview: null }; }, pauseResume: async (...a) => { calls.push(['pauseResume', ...a]); return { outcome: 'resuming', runId: 'L', actor: a[0], explain: null, cover: null, overview: null }; } };
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, orchestra: new Proxy(api, { get: (t, k) => (k in t ? t[k] : () => () => {}) }) };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
const mods = await import(`${outfile}?t=${Date.now()}`);
const { useStore, actions } = mods;
// zustand's SERVER snapshot is `getInitialState()` (a mutable object, not the live state): seed THAT so renderToString sees the fixture
const initialState = useStore.getInitialState();
const setPause = (pauseOverview) => { initialState.pauseOverview = pauseOverview; useStore.setState({ pauseOverview }); };
const all = Object.assign({}, ...Object.entries(mods).filter(([k]) => /^m\d+$/.test(k)).map(([, v]) => v));

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

// ── the row parts + the Bus section over a seeded store (the SAME slice the app fills from `pause:update`) ─────────────────────────────────
const members = [
  ['L', 'fleet-lead', 'coordinator', 'L'], ['O', 'wave-ops', 'coordinator', 'O'], ['w1', 'worker-1', 'worker', 'O'], ['w2', 'worker-2', 'worker', 'O'],
].map(([wsId, label, role, memberRun]) => ({ wsId, label, role, memberRun, ui: 'paused', confirmVia: 'trap', confirmedAt: 1, releasedAt: null, releasedBy: null, repriseConfirmedAt: null,
  bilan: wsId === 'w1' ? { snapshotRef: 'refs/orchestra/pause/L/w1/1', branch: 'b', head: 'h', dirty: true, changed: { modified: 3, added: 1, deleted: 0 }, snapshotIncomplete: null, wasDoing: { turnRunning: true, inFlight: ['npx tsc --noEmit'], bgTasks: [], lastTask: null }, interrupt: 'interrupted', exempt: false, killed: [{ cmd: 'tsc --noEmit', cwd: '/w', outcome: 'exited' }], killedCount: 1, notes: [], error: null } : null }));
const can = (over = {}) => ({ pauseSoft: { ok: true }, pauseHard: { ok: true }, resume: { ok: false, code: 'not-paused' }, release: { ok: false, code: 'not-resuming' }, ...over });
const ctl = (wsId, runId, phase, extra = {}) => ({ wsId, runId, anchored: true, switchOn: true, phase, coveredBy: null, can: can(), ...extra });
const mkRun = (over = {}) => ({ carrierRunId: 'L', carrierLabel: 'fleet-lead', title: null, phase: 'paused', mode: 'hard', pausedAt: Date.now() - 8 * 60_000, pausedBy: 'L', pausedByLabel: 'fleet-lead', deadlineAt: null, escalatedAt: null, trapAt: Date.now(), resumeStartedAt: null, auto: false, progress: { kind: 'en-pause', done: 4, total: 4, missing: [] }, blocked: [], members, ...over });
const seed = (o) => setPause({ available: true, error: null, at: 0, runs: [], controls: {}, byWorkspace: {}, ...o });
const acts = (out) => [...out.matchAll(/data-pause-action="([a-z-]+)"/g)].map((m) => m[1]);

console.log('\nRow parts (option A) over a seeded store:');
seed({});
check('nothing paused: badge, glyph swap, note and bar render NOTHING (an ordinary row is untouched)', html(h(all.PauseRowBadge, { wsId: 'w1' })) === '' && html(h(all.PauseRowBar, { wsId: 'L' })) === '' && html(h(all.PauseAwareGlyph, { wsId: 'w1' }, h('i', { id: 'orig' }))) === '<i id="orig"></i>' && html(h(all.PauseRowNote, { wsId: 'L' }, h('i', { id: 'orig' }))) === '<i id="orig"></i>');
seed({ runs: [mkRun()], controls: { L: ctl('L', 'L', 'paused', { can: can({ resume: { ok: true } }) }), O: ctl('O', 'O', 'active', { coveredBy: { runId: 'L', label: 'fleet-lead' }, can: can({ resume: { ok: false, code: 'covered' } }) }) }, byWorkspace: { w1: { wsId: 'w1', carrierRunId: 'L', phase: 'paused', ui: 'paused', role: 'worker', via: 'trap' }, w2: { wsId: 'w2', carrierRunId: 'L', phase: 'paused', ui: 'pausing', role: 'worker', via: null } } });
check('a member under the pause: its badge ("en pause" / "finit…") and its glyph replace the status glyph', html(h(all.PauseRowBadge, { wsId: 'w1' })).includes('data-pause-state="paused"') && html(h(all.PauseRowBadge, { wsId: 'w2' })).includes('data-pause-state="pausing"') && html(h(all.PauseAwareGlyph, { wsId: 'w1' }, h('i', { id: 'orig' }))).includes('data-pause-glyph="w1"') && !html(h(all.PauseAwareGlyph, { wsId: 'w1' }, h('i', { id: 'orig' }))).includes('id="orig"'));
check('an agent NOT under the pause keeps its own glyph and has no badge', html(h(all.PauseRowBadge, { wsId: 'zz' })) === '' && html(h(all.PauseAwareGlyph, { wsId: 'zz' }, h('i', { id: 'orig' }))).includes('id="orig"'));
const note = html(h(all.PauseRowNote, { wsId: 'L' }, h('i', { id: 'orig' })));
check('the orchestrator holding the pause: its note line is the progress ("En pause · 4/4 · depuis 8 min"), not its status note', note.includes('data-pause-note="L"') && note.includes('En pause · 4/4 · depuis 8 min') && !note.includes('id="orig"'), note);
check('a covered orchestrator (no pause of its own) keeps its own status note; a worker too', html(h(all.PauseRowNote, { wsId: 'O' }, h('i', { id: 'orig' }))).includes('id="orig"') && html(h(all.PauseRowNote, { wsId: 'w1' }, h('i', { id: 'orig' }))).includes('id="orig"'));
const rb = html(h(all.PauseRowBar, { wsId: 'L' }));
check('the thin bar under the holding orchestrator: 100 %, data hooks', rb.includes('pause-rowbar') && rb.includes('width:100%') && rb.includes('data-done="4"') && rb.includes('data-kind="en-pause"'), rb);
seed({ runs: [mkRun({ phase: 'active', progress: { kind: 'repris', done: 0, total: 4, missing: ['L'] } })], controls: { L: ctl('L', 'L', 'active') } });
check('a CLOSED Reprise (phase active, accusés pending) does not take over the note line or draw a bar', html(h(all.PauseRowNote, { wsId: 'L' }, h('i', { id: 'orig' }))).includes('id="orig"') && html(h(all.PauseRowBar, { wsId: 'L' })) === '');
const A = (wsId) => acts(html(h(all.PauseRowActions, { wsId, rect: { top: 0, bottom: 20, right: 300 } })));
seed({ controls: { L: ctl('L', 'L', 'active'), W: ctl('W', 'W', 'pausing'), P: ctl('P', 'P', 'paused', { can: can({ resume: { ok: true } }) }), R: ctl('R', 'R', 'resuming', { can: can({ release: { ok: true } }) }), C: ctl('C', 'C', 'active', { coveredBy: { runId: 'L', label: 'fleet-lead' } }), Z: ctl('Z', 'Z', 'active', { switchOn: false, can: can({ pauseSoft: { ok: false, code: 'switch-off' }, pauseHard: { ok: false, code: 'switch-off' } }) }) }, runs: [mkRun({ carrierRunId: 'R', phase: 'resuming', progress: { kind: 'repris', done: 1, total: 3, missing: [] }, members: members.map((m, i) => ({ ...m, ui: i < 1 ? 'resumed' : 'blocked' })), blocked: ['O', 'w1'] })], byWorkspace: { wp: { wsId: 'wp', carrierRunId: 'P', phase: 'paused', ui: 'paused', role: 'worker', via: 'trap' } } });
check('hover actions follow the phase: active → ⏸ ; pausing → ■ dure maintenant + ▶ ; paused → ▶ ; resuming → ▶ libérer + ⏸ re-pause ; covered → ▶ (explained) ; switch OFF → ⏸ (explained on click)', JSON.stringify([A('L'), A('W'), A('P'), A('R'), A('C'), A('Z')]) === JSON.stringify([['soft'], ['hard', 'resume'], ['resume'], ['release-all', 'repause'], ['resume'], ['soft']]), JSON.stringify([A('L'), A('W'), A('P'), A('R'), A('C'), A('Z')]));
check('a WORKER row not under a pause gets ⏸ (the writer\'s own refusal explains it); a worker UNDER a pause gets none', JSON.stringify([A('w9'), A('wp')]) === JSON.stringify([['soft'], []]), JSON.stringify([A('w9'), A('wp')]));
check('release-all names the blocked count in its tooltip', html(h(all.PauseRowActions, { wsId: 'R', rect: { top: 0, bottom: 1, right: 2 } })).includes('title="Libérer les 3 bloqués"'));

console.log('\nBus page section (option A):');
seed({});
check('no run holds a pause: the section renders NOTHING', html(h(all.BusPauseSection)) === '');
setPause({ available: false, error: 'bus down', at: 0, runs: [mkRun()], controls: {}, byWorkspace: {} });
check('overview unavailable: nothing (the pane\'s own bus-unavailable block speaks)', html(h(all.BusPauseSection)) === '');
seed({ runs: [mkRun()] });
const bus1 = html(h(all.BusPauseSection));
check('paused run: header, 4/4 count, one Bilan row per member with the shipped facts', bus1.includes('data-pause-section="L"') && bus1.includes('data-pause-phase="paused"') && bus1.includes('data-pause-count="L"') && bus1.includes('4/4 en pause') && (bus1.match(/data-pause-bilan="/g) || []).length === 4 && bus1.includes('refs/orchestra/pause/L/w1/1') && bus1.includes('3 modifiés · 1 ajouté') && bus1.includes('1 outil tué'), bus1.slice(0, 300));
check('paused run: the only action is Reprendre (a hook, attributed to the carrier)', JSON.stringify(acts(bus1)) === JSON.stringify(['resume']) && bus1.includes('data-pause-for="L"'));
seed({ runs: [mkRun({ phase: 'pausing', mode: 'soft', deadlineAt: Date.now() + 110_000, progress: { kind: 'en-pause', done: 2, total: 4, missing: ['w1', 'w2'] }, members: members.map((m, i) => ({ ...m, ui: i < 2 ? 'paused' : 'pausing', bilan: null })) })] });
const bus2 = html(h(all.BusPauseSection));
check('douce waiting: "Pause douce en cours", 2/4, who is missing, the deadline, ■ dure maintenant + Reprendre, no Bilan yet', bus2.includes('Pause douce en cours') && bus2.includes('2/4 en pause') && bus2.includes('manquent : worker-1, worker-2') && /Pause dure dans 1:(4|5)\d/.test(bus2) && JSON.stringify(acts(bus2)) === JSON.stringify(['hard', 'resume']) && bus2.includes('après l&#x27;escalade'), bus2.slice(0, 400));
seed({ runs: [mkRun({ phase: 'resuming', progress: { kind: 'repris', done: 1, total: 4, missing: ['O', 'w1', 'w2'] }, members: members.map((m, i) => ({ ...m, ui: i < 2 ? 'resumed' : 'blocked' })), blocked: ['w1', 'w2'] })] });
const bus3 = html(h(all.BusPauseSection));
check('Reprise: "N/M repris", the blocked list, Libérer par membre (2) + Libérer les 2 bloqués + Re-pause', bus3.includes('1/4 repris') && bus3.includes('Bloqués : worker-1, worker-2') && (bus3.match(/data-pause-action="release"/g) || []).length === 2 && bus3.includes('Libérer les 2 bloqués') && acts(bus3).includes('repause'), acts(bus3).join(','));
seed({ runs: [mkRun({ phase: 'active', progress: { kind: 'repris', done: 0, total: 4, missing: ['L', 'O', 'w1', 'w2'] }, members: members.map((m) => ({ ...m, ui: 'released' })) })] });
check('a closed Reprise still collecting accusés: its progress shows, NO action offered', html(h(all.BusPauseSection)).includes('0/4 repris') && acts(html(h(all.BusPauseSection))).length === 0);

console.log('\nClick handlers (the store actions → the preload API; the panel store):');
{
  seed({});
  // the store actions set `pauseOverview` from the reply's overview: give the stubs a real one
  const ov = { available: true, error: null, at: 0, runs: [], controls: {}, byWorkspace: {} };
  const run = mkRun({ phase: 'resuming', members: members.map((m, i) => ({ ...m, ui: i < 1 ? 'resumed' : 'blocked' })), blocked: ['O', 'w1', 'w2'] });
  window.orchestra.pauseRelease = async (...a) => { calls.push(['pauseRelease', ...a]); return { result: { released: a[1], refused: [], below: [], unknown: [], already: [], error: null, finished: false }, explain: [], overview: ov }; };
  window.orchestra.pausePause = async (...a) => { calls.push(['pausePause', ...a]); return { outcome: 'refused', runId: 'O', actor: a[0], explain: { tone: 'error', title: 'Pause refusée', why: 'x', fix: [] }, cover: null, overview: ov }; };
  window.orchestra.pauseResume = async (...a) => { calls.push(['pauseResume', ...a]); return { outcome: 'resuming', runId: 'L', actor: a[0], explain: null, cover: null, overview: ov }; };
  calls.length = 0;
  await actions.runReleaseAll('L', run, null);
  check('"Libérer les N bloqués" sends EXPLICIT ids of the blocked members (never \'all\'), for the carrier', JSON.stringify(calls[0]) === JSON.stringify(['pauseRelease', 'L', ['O', 'w1', 'w2'], 'L']), JSON.stringify(calls[0]));
  calls.length = 0;
  await actions.runRelease('L', 'w1', 'L', null);
  check('Libérer par membre: that one id, attributed to the carrier row', JSON.stringify(calls[0]) === JSON.stringify(['pauseRelease', 'L', ['w1'], 'L']), JSON.stringify(calls[0]));
  calls.length = 0;
  const ex = await actions.runPause('w1', 'soft', { top: 0, bottom: 20, right: 300 });
  check('a refusal comes back EXPLAINED and the floating panel shows it (nothing swallowed)', ex.length === 1 && ex[0].title === 'Pause refusée' && mods.actions.usePausePanel.getState().panel?.kind === 'explain' && mods.actions.usePausePanel.getState().panel.wsId === 'w1' && JSON.stringify(calls[0]) === JSON.stringify(['pausePause', 'w1', 'soft']), JSON.stringify(calls[0]));
  const ok = await actions.runResume('L', { top: 0, bottom: 20, right: 300 });
  check('a success closes the panel and explains nothing', ok.length === 0 && mods.actions.usePausePanel.getState().panel === null && JSON.stringify(calls[1]) === JSON.stringify(['pauseResume', 'L']));
  calls.length = 0;
  const bus = await actions.runPause('L', 'hard', null);
  check('a Bus-page click (no anchor) returns the explanation to the caller instead of opening a panel', bus.length === 1 && mods.actions.usePausePanel.getState().panel === null);
}

console.log(`\npause-ui-render-smoke: ${failures === 0 ? 'all checks passed' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
