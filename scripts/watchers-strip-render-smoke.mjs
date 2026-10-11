// Render smoke-test for the degraded-watchers sidebar strip (#330, D-Q8 = A): `node --test` strips types but does NOT transform JSX, so the unit suite proves the words (src/shared/watcher-status.test.ts) and the store
// wiring (src/main/watchers-wiring.test.ts) but not that the strip REACHES the HTML — and, above all, that it is ABSENT while healthy and GONE once the last watcher is back. scripts/watchers-app/e2e-watchers-app.sh proves
// it reaches PIXELS on the BUILT app. SELECTOR CONTRACT: assertions key on data-watchers-chip and rendered TEXT — never tag or DOM position.
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
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'watchers-strip-smoke.mjs');
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'watchers-strip-smoke-entry.tsx');
fs.mkdirSync(path.dirname(entryFile), { recursive: true });
fs.writeFileSync(entryFile, `export { WatchersStrip } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/WatchersStrip.tsx'))};\nexport { useStore } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/store.ts'))};\n`);
await build({ entryPoints: [entryFile], outfile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], loader: { '.css': 'empty' }, logLevel: 'silent' });
globalThis.self = globalThis;
// the store subscribes to window.orchestra at import: a stub whose every member is a no-op (subscriptions return an unsubscribe fn, reads resolve to an empty list); the pull + push are captured so the wiring is exercised, not assumed
const pushes = [];
const api = { watchersStatus: async () => pulled, onWatchersUpdate: (cb) => { pushes.push(cb); return () => {}; } };
let pulled = null;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, orchestra: new Proxy(api, { get: (t, k) => (k in t ? t[k] : String(k).startsWith('on') ? () => () => {} : async () => []) }) };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
const { WatchersStrip, useStore } = await import(`${outfile}?t=${Date.now()}`);
const initialState = useStore.getInitialState();
const setWatchers = (watchers) => { initialState.watchers = watchers; useStore.setState({ watchers }); }; // zustand's server snapshot is the INITIAL state object: seed that so renderToString sees the fixture

let failures = 0;
const check = (label, cond, detail = '') => { if (cond) console.log(`  ok   ${label}`); else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } };
const html = (el) => renderToString(el).replace(/<!-- -->/g, '');
const h = React.createElement;
const T0 = Date.parse('2026-10-08T12:53:48Z');
const snap = (name, label, over = {}) => ({ name, label, dir: `/d/${name}`, state: 'ok', since: T0, lastError: null, attempts: 0, recoveries: 0, fallback: '60 s sweep', ...over });
const down = (name, label, code = 'EMFILE') => snap(name, label, { state: 'degraded', lastError: { code, message: `${code}: too many open files` }, attempts: 3 });

console.log('\nWatchersStrip (D-Q8 A):');
setWatchers(null);
check('before the first reading (null) the strip renders NOTHING', html(h(WatchersStrip)) === '');
setWatchers({ at: 1, rev: 1, watchers: [snap('bus-wake', 'Réveils'), snap('pause-ui', 'Vue Pause')] });
check('every watcher ok ⇒ NOTHING (a healthy app shows no chrome)', html(h(WatchersStrip)) === '');
setWatchers({ at: 2, rev: 2, watchers: [] });
check('no watcher armed ⇒ NOTHING', html(h(WatchersStrip)) === '');
setWatchers({ at: 3, rev: 3, watchers: [down('bus-wake', 'Réveils'), down('pause-ui', 'Vue Pause'), snap('inbox-tray', 'Inbox')] });
const on = html(h(WatchersStrip));
check('two degraded ⇒ the strip: hook, status role (non-blocking), Pause-unreadable class (same slot/style)', on.includes('data-watchers-chip=""') && on.includes('role="status"') && on.includes('aria-live="polite"') && on.includes('pause-unreadable'), on.slice(0, 260));
check('it names what lags in plain words — only the degraded ones — and that it retries by itself', on.includes('Mises à jour en retard') && on.includes('Réveils, Vue Pause') && !on.includes('Inbox') && on.includes('Nouvel essai automatique'), on);
check('EMFILE ⇒ « limite de surveillance de fichiers atteinte »', on.includes('limite de surveillance de fichiers atteinte'));
check('the tooltip carries one line per degraded watcher with the cause and the fallback', /title="Réveils · depuis [^"]*system watch limit reached \(EMFILE\)[^"]*en attendant : 60 s sweep\nVue Pause · depuis/.test(on), on.slice(0, 500));
check('NO button, link or dismissal (it goes away by itself, D-Q8)', !/<button|<a |onclick/i.test(on));
setWatchers({ at: 4, rev: 4, watchers: [down('inbox-tray', 'Inbox', 'ENOENT')] });
check('a non-limit cause does not claim the system limit', !html(h(WatchersStrip)).includes('limite de surveillance') && html(h(WatchersStrip)).includes('surveillance de fichiers interrompue'));
setWatchers({ at: 5, rev: 5, watchers: [snap('inbox-tray', 'Inbox'), snap('bus-wake', 'Réveils')] });
check('the last watcher back ⇒ the strip is GONE (disappears on its own)', html(h(WatchersStrip)) === '');

console.log('\nStore wiring (boot pull + push):');
check('the store subscribed to `watchers:update` at import', pushes.length === 1, `${pushes.length} subscription(s)`);
useStore.setState({ watchers: null });
pushes[0]({ at: 10, rev: 10, watchers: [down('bus-wake', 'Réveils')] });
check('a push replaces the slice', useStore.getState().watchers?.watchers[0].state === 'degraded' && useStore.getState().watchers.rev === 10);
pushes[0]({ at: 5, rev: 5, watchers: [] });
check('an OLDER push (or a late-answered pull) never rolls it back', useStore.getState().watchers.rev === 10);
pushes[0]({ at: 1, rev: 11, watchers: [snap('bus-wake', 'Réveils')] });
check('a CLOCK STEPPED BACK (at 1 < 10) with a later rev still wins — the order is the registry\'s rev, never the wall clock (review M1)', useStore.getState().watchers.rev === 11 && useStore.getState().watchers.at === 1);
check('the all-clear push empties the degraded set', useStore.getState().watchers.watchers.every((w) => w.state === 'ok'));
pulled = { at: 20, rev: 20, watchers: [down('pause-ui', 'Vue Pause')] };
useStore.setState({ watchers: null, loaded: false });
await useStore.getState().load();
check('the boot PULL fills the slice (a boot-time degradation is only ever seen through it — the page loads after main armed its watchers)', useStore.getState().watchers?.rev === 20 && useStore.getState().watchers.watchers[0].name === 'pause-ui', JSON.stringify(useStore.getState().watchers));

pulled = { at: 30, rev: 30, watchers: [snap('pause-ui', 'Vue Pause')] };
api.watchersStatus = async () => { pushes[0]({ at: 31, rev: 31, watchers: [down('pause-ui', 'Vue Pause')] }); return pulled; }; // the page asked at rev 30; a degradation (rev 31) is pushed before the answer lands
useStore.setState({ watchers: null, loaded: false });
await useStore.getState().load();
check('a push that lands WHILE the boot pull is in flight is kept (the late-answered older pull does not roll the strip back to all-clear)', useStore.getState().watchers?.rev === 31 && useStore.getState().watchers.watchers[0].state === 'degraded', JSON.stringify(useStore.getState().watchers));

console.log(`\nwatchers-strip-render-smoke: ${failures === 0 ? 'all checks passed' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
