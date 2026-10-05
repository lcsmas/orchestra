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
const exA = html(h(all.PauseExplain, { onAction: () => {}, explain: { tone: 'warn', title: 't', why: 'w', fix: [], actions: [{ kind: 'release', wsId: 'L', carrierRunId: 'L', ids: ['w1', 'w2'], label: 'Libérer aussi ces 2 : worker-1, worker-2' }] } }));
check('the ONE follow-up an explanation may carry (« libérer aussi ces N ») renders as a button attributed to the acting row, carrying the explicit ids', exA.includes('data-pause-fix="release"') && exA.includes('data-pause-for="L"') && exA.includes('data-pause-ids="w1,w2"') && exA.includes('Libérer aussi ces 2') && !exA.includes('<li>'), exA);
const exG = html(h(all.PauseExplain, { onAction: () => {}, explain: { tone: 'error', title: 'Pause refusée — worker-1 est un agent, pas une vague', why: 'w', fix: [], actions: [{ kind: 'goto', wsId: 'O', label: 'Aller à wave-ops' }] } }));
check('a worker refusal LINKS to its orchestrator (spec Q5): a navigation link, not a button that acts — no release button, no ids', exG.includes('data-pause-fix="goto"') && exG.includes('data-pause-for="O"') && exG.includes('Aller à wave-ops →') && exG.includes('class="pause-link"') && !exG.includes('pause-btn') && !exG.includes('data-pause-ids') && !exG.includes('data-pause-fix="release"'), exG);
const exB = html(h(all.PauseExplain, { explain: { tone: 'error', title: 't', why: 'w', fix: ['Pour worker : mettre en pause sa vague wave-ops'] } }));
check('a refusal NAMES the run to act on as text (no button that pauses / resumes another row for the human — spec Q5)', exB.includes('<li>Pour worker : mettre en pause sa vague wave-ops</li>') && !exB.includes('data-pause-fix'), exB);
check('info block is a status, not an alert', html(h(all.PauseExplain, { explain: { tone: 'info', title: 't', why: 'w', fix: [] } })).includes('role="status"'));
const on = html(h(all.PauseActionButton, { kind: 'hard', wsId: 'L', tone: 'primary', onClick: () => {} }, 'Pause dure'));
const off = html(h(all.PauseActionButton, { kind: 'hard', wsId: 'L', tone: 'primary', disabled: true, why: 'Pause désactivée sur cette vague', onClick: () => {} }, 'Pause dure'));
check('action button: data-pause-action / data-pause-for hooks', on.includes('data-pause-action="hard"') && on.includes('data-pause-for="L"') && !on.includes('aria-disabled'), on);
check('a disabled action is EXPLAINED (title) and marked', off.includes('aria-disabled="true"') && off.includes('title="Pause désactivée sur cette vague"') && off.includes('is-off'), off);

// ── the row parts + the Bus section over a seeded store (the SAME slice the app fills from `pause:update`) ─────────────────────────────────
const members = [
  ['L', 'fleet-lead', 'coordinator', 'L'], ['O', 'wave-ops', 'coordinator', 'O'], ['w1', 'worker-1', 'worker', 'O'], ['w2', 'worker-2', 'worker', 'O'],
].map(([wsId, label, role, memberRun]) => ({ wsId, label, role, memberRun, ui: 'paused', confirmVia: 'trap', confirmedAt: 1, releasedAt: null, releasedBy: null, repriseConfirmedAt: null,
  bilan: wsId === 'w1' ? { snapshotRef: 'refs/orchestra/pause/L/w1/1', branch: 'b', head: 'h', dirty: true, changed: { modified: 3, added: 1, deleted: 0 }, snapshotIncomplete: null, wasDoing: { turnRunning: true, inFlight: ['npx tsc --noEmit'], bgTasks: [], lastTask: null }, interrupt: 'interrupted', exempt: false, killed: [{ cmd: 'tsc --noEmit', cwd: '/w', outcome: 'exited' }], killedCount: 1, trap: 'done', skipped: null, survivors: [], refused: [], warnings: [], notCaptured: [], notCapturedCount: 0, snapshotNotes: [], submodules: [], notes: [], error: null } : wsId === 'L' ? { snapshotRef: null, branch: null, head: null, dirty: null, changed: null, snapshotIncomplete: null, wasDoing: { turnRunning: false, inFlight: [], bgTasks: [], lastTask: null }, interrupt: 'idle', exempt: false, killed: [], killedCount: 0, trap: 'done', skipped: null, survivors: [], refused: [], warnings: [], notCaptured: [], notCapturedCount: 0, snapshotNotes: [], submodules: [], notes: [], error: 'snapshot: git rev-parse failed: fatal: not a git repository (or any parent up to mount point /)' } : wsId === 'w2' ? { snapshotRef: null, branch: 'b', head: 'h', dirty: true, changed: { modified: 1, added: 0, deleted: 0 }, snapshotIncomplete: 'timeout', wasDoing: { turnRunning: false, inFlight: [], bgTasks: [], lastTask: null }, interrupt: 'unresponsive', exempt: false, killed: [], killedCount: 0, trap: 'pending', skipped: null, survivors: [{ cmd: 'sleep 600', pid: 7, reason: 'same identity after SIGKILL' }], refused: [], warnings: ['a.bin'], notCaptured: [{ path: 'data/huge.bin', bytes: 3 * 1024 ** 3, files: null, reason: 'file-cap' }], notCapturedCount: 1, snapshotNotes: [], submodules: [{ path: 'vendor/lib', ref: null, dirty: true, error: 'git add failed' }], notes: [], error: 'kill: 1 tool process(es) still alive after the trap' } : null }));
members[1] = { ...members[1], bilan: { ...members[0].bilan } }; // every member has a Bilan row once the trap is done (an orchestrator's is the info-only "not a git repository")
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
check('release-all names ITS scope in its tooltip (1 of its own run, +2 below left to their coordinator), never the workers it will not release', html(h(all.PauseRowActions, { wsId: 'R', rect: { top: 0, bottom: 1, right: 2 } })).includes('title="Libérer 1 bloqué (+2 plus bas, à part)"'));

check('the Bus header says a HUMAN paused it (Q1): « posée par un humain », never the coordinator', (() => { seed({ runs: [mkRun({ pausedBy: 'humain', pausedByLabel: 'un humain' })] }); const b = html(h(all.BusPauseSection)); return b.includes('posée par un humain') && !b.includes('posée par fleet-lead'); })());

console.log('\nBus page section (option A):');
seed({});
check('no run holds a pause: the section renders NOTHING', html(h(all.BusPauseSection)) === '');
setPause({ available: false, error: 'bus down', at: 0, runs: [mkRun()], controls: {}, byWorkspace: {} });
const unreadableBus = html(h(all.BusPauseSection));
check('overview UNREADABLE: the Bus section says so (alert, the reason) — never an empty "nothing is paused"', unreadableBus.includes('data-section="pause"') && unreadableBus.includes('data-pause-unreadable') && unreadableBus.includes('role="alert"') && unreadableBus.includes('bus down') && !unreadableBus.includes('data-pause-section='), unreadableBus.slice(0, 300));
const unreadableSide = html(h(all.PauseUnreadableStrip));
check('overview UNREADABLE: the sidebar strip says so too; an unavailable overview with NO error text still renders the strip', unreadableSide.includes('data-pause-unreadable') && unreadableSide.includes('état illisible') && unreadableSide.includes('bus down'), unreadableSide.slice(0, 300));
seed({ runs: [mkRun()] });
check('a READABLE overview shows no unreadable strip anywhere (the sidebar strip renders nothing)', html(h(all.PauseUnreadableStrip)) === '');
{
  const noBilan = (over) => seed({ runs: [mkRun({ ...over, members: members.map((m, i) => (i === 2 ? { ...m, bilan: null, ui: over.phase === 'resuming' ? 'blocked' : 'paused' } : { ...m, ui: over.phase === 'resuming' ? 'resumed' : 'paused' })) })] });
  noBilan({ phase: 'paused', trapAt: null });
  const pend = html(h(all.BusPauseSection));
  check('no Bilan row while the trap is still owed: "après l\'escalade", no alarm', pend.includes('après l&#x27;escalade') && !pend.includes('aucun Bilan'), pend.slice(0, 200));
  noBilan({ phase: 'paused', trapAt: Date.now() });
  const gone = html(h(all.BusPauseSection));
  check('no Bilan row once the trap is DONE: "aucun Bilan" + the worktree-is-the-only-copy line (never "après l\'escalade" forever)', gone.includes('aucun Bilan') && /data-pause-bilan-detail="w1".{0,400}aucun Bilan pour cet agent/.test(gone) && !gone.includes('après l&#x27;escalade'), gone.slice(0, 200));
  noBilan({ phase: 'resuming', trapAt: Date.now(), progress: { kind: 'repris', done: 1, total: 4, missing: ['w1'] }, blocked: ['w1'] });
  check('no Bilan row during a Reprise AFTER a trap: absent, said so', html(h(all.BusPauseSection)).includes('aucun Bilan'));
  noBilan({ phase: 'resuming', trapAt: null, mode: 'soft', escalatedAt: null, progress: { kind: 'repris', done: 1, total: 4, missing: ['w1'] }, blocked: ['w1'] });
  const cancelled = html(h(all.BusPauseSection));
  noBilan({ phase: 'resuming', trapAt: null, mode: 'hard', progress: { kind: 'repris', done: 1, total: 4, missing: ['w1'] }, blocked: ['w1'] });
  check('a Reprise of a dure whose trap never finished (trapAt null, trap OWED): the missing Bilan still warns (pre-review r2)', /data-pause-bilan-detail="w1".{0,400}aucun Bilan pour cet agent/.test(html(h(all.BusPauseSection))));
  check('a Reprise of a douce CANCELLED before it escalated (no trap ever ran): no "aucun Bilan", no worktree alarm — a harmless gesture is not an alert (R2-2)', !cancelled.includes('aucun Bilan') && !cancelled.includes('data-pause-bilan-detail="w1"') && !cancelled.includes('après l&#x27;escalade'), cancelled.slice(0, 200));
}
seed({ runs: [mkRun()] });
const bus1 = html(h(all.BusPauseSection));
check('paused run: header, 4/4 count, one Bilan row per member with the shipped facts', bus1.includes('data-pause-section="L"') && bus1.includes('data-pause-phase="paused"') && bus1.includes('data-pause-count="L"') && bus1.includes('4/4 en pause') && (bus1.match(/data-pause-bilan="/g) || []).length === 4 && bus1.includes('refs/orchestra/pause/L/w1/1') && bus1.includes('3 modifiés · 1 ajouté') && bus1.includes('1 outil tué'), bus1.slice(0, 300));
check('a member with a problem SHOWS it: error, survivor, unconfirmed interrupt, incomplete snapshot, unreadable file, trap still owed — never "aucun outil tué"', bus1.includes('data-pause-bilan-detail="w2"') && bus1.includes('erreur : kill: 1 tool process(es) still alive after the trap') && bus1.includes('encore vivant après la pause : sleep 600 (pid 7)') && bus1.includes('interruption non confirmée (unresponsive)') && bus1.includes('snapshot incomplet') && bus1.includes('absent du snapshot (illisible) : a.bin') && bus1.includes('trap en cours') && bus1.includes('NON capturé dans le snapshot (trop volumineux, 1) : data/huge.bin (3,0 Go)') && bus1.includes('submodule vendor/lib : snapshot échoué (git add failed)') && (bus1.match(/data-pause-attention="error"/g) || []).length === 2, bus1.slice(bus1.indexOf('data-pause-bilan-detail="w2"'), bus1.indexOf('data-pause-bilan-detail="w2"') + 500));
const idleOnly = html(h(all.BusPauseSection));
check('info-only lines do not open a detail row on their own (an orchestrator without a git worktree, a remote member): no row of lead / O is expanded for them', !idleOnly.includes('data-pause-bilan-detail="L"') && !idleOnly.includes('data-pause-bilan-detail="O"') && idleOnly.includes('data-pause-bilan-detail="w1"'), idleOnly.slice(0, 200));
check('what it was doing and what was killed are listed under the row (tué : <cmd>, faisait : <cmd>)', bus1.includes('tué : <code>tsc --noEmit</code>') && bus1.includes('faisait : <code>npx tsc --noEmit</code>'));
check('paused run: the only action is Reprendre (a hook, attributed to the carrier)', JSON.stringify(acts(bus1)) === JSON.stringify(['resume']) && bus1.includes('data-pause-for="L"'));
seed({ runs: [mkRun({ phase: 'pausing', mode: 'soft', trapAt: null, deadlineAt: Date.now() + 110_000, progress: { kind: 'en-pause', done: 2, total: 4, missing: ['w1', 'w2'] }, members: members.map((m, i) => ({ ...m, ui: i < 2 ? 'paused' : 'pausing', bilan: null })) })] });
const bus2 = html(h(all.BusPauseSection));
check('douce waiting: "Pause douce en cours", 2/4, who is missing, the deadline, ■ dure maintenant + Reprendre, no Bilan yet', bus2.includes('Pause douce en cours') && bus2.includes('2/4 en pause') && bus2.includes('manquent : worker-1, worker-2') && /Pause dure dans 1:(4|5)\d/.test(bus2) && JSON.stringify(acts(bus2)) === JSON.stringify(['hard', 'resume']) && bus2.includes('après l&#x27;escalade'), bus2.slice(0, 400));
seed({ runs: [mkRun({ phase: 'resuming', progress: { kind: 'repris', done: 1, total: 4, missing: ['O', 'w1', 'w2'] }, members: members.map((m, i) => ({ ...m, ui: i < 2 ? 'resumed' : 'blocked' })), blocked: ['w1', 'w2'] })] });
const bus3 = html(h(all.BusPauseSection));
check('Reprise: "N/M repris", the blocked list, Libérer par membre (2) + Libérer les 2 bloqués + Re-pause', !bus3.includes('manquent :') && bus3.includes('1/4 repris') && bus3.includes('Bloqués : worker-1, worker-2') && (bus3.match(/data-pause-action="release"/g) || []).length === 2 && bus3.includes('Libérer… (2 plus bas, à part)') && acts(bus3).includes('repause'), acts(bus3).join(','));
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
  check('« Libérer tout » sends \'all\' for the carrier (= `release --all`: the acting row\'s OWN run) — NEVER the explicit ids of a nested wave\'s workers', JSON.stringify(calls[0]) === JSON.stringify(['pauseRelease', 'L', 'all', 'L']), JSON.stringify(calls[0]));
  calls.length = 0;
  await actions.runReleaseMany('L', ['w1', 'w2'], 'L', null);
  check('the second gesture (« libérer aussi ces N ») sends those EXPLICIT ids, attributed to the carrier row', JSON.stringify(calls[0]) === JSON.stringify(['pauseRelease', 'L', ['w1', 'w2'], 'L']), JSON.stringify(calls[0]));
  calls.length = 0;
  await actions.runRelease('L', 'w1', 'L', null);
  check('Libérer par membre: that one id, attributed to the carrier row', JSON.stringify(calls[0]) === JSON.stringify(['pauseRelease', 'L', ['w1'], 'L']), JSON.stringify(calls[0]));
  calls.length = 0;
  const ex = await actions.runPause('w1', 'soft', { top: 0, bottom: 20, right: 300 });
  check('a refusal comes back EXPLAINED and the floating panel shows it (nothing swallowed)', ex.length === 1 && ex[0].title === 'Pause refusée' && mods.actions.usePausePanel.getState().panel?.kind === 'explain' && mods.actions.usePausePanel.getState().panel.wsId === 'w1' && JSON.stringify(calls[0]) === JSON.stringify(['pausePause', 'w1', 'soft']), JSON.stringify(calls[0]));
  {
    // NAVIGATION (Q5): the link selects the orchestrator row, closes the panel, and writes NOTHING
    const st = useStore;
    const setActiveCalls = [];
    st.setState({ workspaces: [{ id: 'O', name: 'wave-ops', branch: 'wave-ops' }, { id: 'gone', name: 'x', archived: true }], setActive: (id) => setActiveCalls.push(id) });
    mods.actions.usePausePanel.getState().show({ kind: 'explain', wsId: 'w1', anchor: { top: 0, bottom: 1, right: 2 }, explains: [], codes: [] });
    const nCalls = calls.length;
    const went = actions.gotoWorkspace('O');
    check('« Aller à wave-ops »: selects that row and closes the panel — no write of any kind', went === true && JSON.stringify(setActiveCalls) === '["O"]' && mods.actions.usePausePanel.getState().panel === null && calls.length === nCalls, JSON.stringify([went, setActiveCalls, calls]));
    mods.actions.usePausePanel.getState().show({ kind: 'explain', wsId: 'w1', anchor: { top: 0, bottom: 1, right: 2 }, explains: [], codes: [] });
    const missing = actions.gotoWorkspace('nope') === false;
    const goneP = mods.actions.usePausePanel.getState().panel;
    check('a link to a workspace that no longer exists (or is archived) selects nothing AND says so — never a silent dead link', missing && actions.gotoWorkspace('gone') === false && setActiveCalls.length === 1 && goneP?.kind === 'explain' && goneP.explains[0]?.title === "Cette ligne n'existe plus" && goneP.codes[0] === 'gone', JSON.stringify(goneP));
    mods.actions.usePausePanel.getState().show({ kind: 'explain', wsId: 'w1', anchor: { top: 0, bottom: 1, right: 2 }, explains: [{ tone: 'error', title: 'Pause refusée', why: 'x', fix: [] }], codes: ['refused'] });
  }
  const ok = await actions.runResume('L', { top: 0, bottom: 20, right: 300 });
  check('a success closes the panel and explains nothing', ok.length === 0 && mods.actions.usePausePanel.getState().panel === null && JSON.stringify(calls[1]) === JSON.stringify(['pauseResume', 'L']));
  // a double-click: ONE write; a rejected invoke is explained, never an unhandled rejection
  calls.length = 0;
  const [d1, d2] = await Promise.all([actions.runPause('L', 'soft', { top: 0, bottom: 1, right: 2 }), actions.runPause('L', 'soft', { top: 0, bottom: 1, right: 2 })]);
  check('a double-click sends ONE write (the second is ignored while the first is in flight)', calls.filter((c) => c[0] === 'pausePause').length === 1 && d1.length + d2.length === 1, JSON.stringify(calls));
  const rejects = async (fn) => { try { return await fn(); } catch (e) { return `THROWN: ${e.message}`; } }; // an unhandled rejection must FAIL a check, not crash the smoke
  window.orchestra.pauseResume = async () => { throw new Error('Error invoking remote method: the main process went away'); };
  const down = await rejects(() => actions.runResume('L', { top: 0, bottom: 1, right: 2 }));
  check('a rejected invoke is EXPLAINED ("La commande n\'a pas atteint l\'hôte" + the reason), the panel shows it (resume)', Array.isArray(down) && down.length === 1 && /n'a pas atteint l'hôte/.test(down[0].title) && /main process went away/.test(down[0].why) && mods.actions.usePausePanel.getState().panel?.kind === 'explain', String(down));
  mods.actions.usePausePanel.getState().close();
  window.orchestra.pausePause = async () => { throw new Error('ipc closed'); };
  const downP = await rejects(() => actions.runPause('L', 'hard', { top: 0, bottom: 1, right: 2 }));
  check('a rejected invoke is EXPLAINED too for a pause', Array.isArray(downP) && downP.length === 1 && /ipc closed/.test(downP[0].why), String(downP));
  window.orchestra.pauseRelease = async () => { throw new Error('release ipc closed'); };
  const downR = await rejects(() => actions.runReleaseAll('L', run, null));
  const downR1 = await rejects(() => actions.runRelease('L', 'w1', 'L', null));
  check('a rejected invoke is EXPLAINED for both Libérer paths', Array.isArray(downR) && downR.length === 1 && /release ipc closed/.test(downR[0].why) && Array.isArray(downR1) && downR1.length === 1, `${String(downR)} / ${String(downR1)}`);
  window.orchestra.pauseRelease = async (...a) => { calls.push(['pauseRelease', ...a]); return { result: { released: a[1], refused: [], below: [], unknown: [], already: [], error: null, finished: false }, explain: [], overview: ov }; };
  window.orchestra.pausePause = async (...a) => { calls.push(['pausePause', ...a]); return { outcome: 'refused', runId: 'O', actor: a[0], explain: { tone: 'error', title: 'Pause refusée', why: 'x', fix: [] }, cover: null, overview: ov }; };
  mods.actions.usePausePanel.getState().close();
  window.orchestra.pauseResume = async (...a) => { calls.push(['pauseResume', ...a]); return { outcome: 'resuming', runId: 'L', actor: a[0], explain: null, cover: null, overview: ov }; };
  calls.length = 0;
  const bus = await actions.runPause('L', 'hard', null);
  check('a Bus-page click (no anchor) returns the explanation to the caller instead of opening a panel', bus.length === 1 && mods.actions.usePausePanel.getState().panel === null);
}

console.log(`\npause-ui-render-smoke: ${failures === 0 ? 'all checks passed' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
