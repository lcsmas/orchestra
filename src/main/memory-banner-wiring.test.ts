import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #289 (D5 D-pick3) — structural pins of the Electron-bound / renderer seams of the memory banner (they cannot be imported under node --test): a silent un-wiring is a banner that is dead while every logic test stays green.
// The behaviour behind each seam is driven by src/main/memory-banner.test.ts + src/shared/memory-banner.test.ts and, in a BUILT app, by scripts/e2e-memory-banner.sh (state assertion + screenshot).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Source with line-leading block comments and full-line `//` comments removed: a call that was merely COMMENTED OUT must not satisfy a pin. */
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('CONTROL: the sources are the real files', () => {
  assert.match(read('src/main/memory-banner-host.ts'), /export function registerMemoryBannerIpc\(\): void \{/);
  assert.match(read('src/renderer/components/MemoryBanner.tsx'), /export function MemoryBanner\(\)/);
});

test('WIRING channels: the pull and the push names are the same string in the host and the preload (lockstep), and the pull is NOT in the generic served table', () => {
  const host = read('src/main/memory-banner-host.ts');
  const preload = read('src/preload/index.ts');
  assert.match(host, /export const MEMORY_BANNER_PULL_CHANNEL = 'memoryGuard:banner';/);
  assert.match(host, /export const MEMORY_BANNER_PUSH_CHANNEL = 'memoryGuard:bannerUpdate';/);
  assert.match(preload, /memoryBanner: \(\) => ipcRenderer\.invoke\('memoryGuard:banner'\),/);
  assert.match(preload, /ipcRenderer\.on\('memoryGuard:bannerUpdate', listener\);\s*return \(\) => ipcRenderer\.off\('memoryGuard:bannerUpdate', listener\);/);
  assert.match(read('src/main/api-handlers.ts'), /\| 'pauseRelease'[\s\S]*?\| 'memoryBanner'\s*>;/, 'registered by registerMemoryBannerIpc, not from the generic table');
  assert.match(read('src/shared/ipc.ts'), /memoryBanner: \(\) => Promise<MemoryBannerState>;/);
  assert.match(read('src/shared/ipc.ts'), /onMemoryBanner: \(cb: \(state: MemoryBannerState\) => void\) => \(\) => void;/);
});

test('WIRING host (FI-2.5): SUBSCRIBE to the guard FIRST, then refresh from the snapshot; every guard edge refreshes; the pull is a fresh read; the push goes to every renderer', () => {
  const host = read('src/main/memory-banner-host.ts');
  const start = host.slice(host.indexOf('export function startMemoryBanner(): void {'));
  const sub = start.indexOf('subscribeMemoryGuard(');
  const ref = start.indexOf('publisher.refresh();');
  assert.ok(sub > 0 && ref > sub, 'subscribe, then refresh');
  assert.match(start, /unsubscribe = subscribeMemoryGuard\(\(e\) => publisher\.onEdge\(e\)\);/);
  assert.match(host, /ipcMain\.handle\(MEMORY_BANNER_PULL_CHANNEL, \(\): MemoryBannerState => \{\s*publisher\.refresh\(\);[^\n]*\n\s*return publisher\.current\(\);/);
  assert.match(host, /push: \(state\) => platform\.broadcast\(MEMORY_BANNER_PUSH_CHANNEL, state\),/);
  assert.match(host, /heldStarts: \(\) => listHeldStarts\(\)\.length,/);
  assert.match(host, /return memoryPausedRuns\(db\)\.map\(/);
  assert.match(host, /h\.unref\?\.\(\);/, 'the refresh timer never keeps the process alive');
});

test('WIRING index.ts: the pull channel is registered ONCE at module scope; the banner starts after the memory alert (after the memory Pause: its runs are written on the same edge) and stops before it', () => {
  const s = read('src/main/index.ts');
  assert.equal(s.split('registerMemoryBannerIpc();').length - 1, 1, 'registered exactly once');
  assert.ok(s.indexOf('registerMemoryBannerIpc();') > s.indexOf('registerPauseUiIpc();'), 'module scope, beside the Pause UI registrar');
  const pause = s.indexOf('startMemoryPause();');
  const alert = s.indexOf('startMemoryAlert();');
  const banner = s.indexOf('startMemoryBanner();');
  assert.ok(pause > 0 && alert > pause && banner > alert, 'start order: memory Pause, alert, banner');
  assert.equal(s.split('startMemoryBanner();').length - 1, 1, 'started exactly once');
  const shut = s.slice(s.indexOf('function shutdownSubsystems(): void {'));
  const body = shut.slice(0, shut.indexOf('\n}\n'));
  assert.ok(body.indexOf('stopMemoryBanner();') > 0 && body.indexOf('stopMemoryBanner();') < body.indexOf('stopMemoryAlert();'), 'stopped inside shutdownSubsystems, before the alert');
});

test('WIRING memory-banner.ts is Electron-free (importable under node --test); only the host binding holds the real guard / bus / store / ipc', () => {
  const core = read('src/main/memory-banner.ts');
  for (const bad of ['./store', './platform', 'electron', './memory-guard', './logger', './admission', './bus']) {
    assert.ok(!new RegExp(`from '${bad.replace(/[./]/g, '\\$&')}(\\.ts)?'`).test(core), `memory-banner.ts must not import ${bad}`);
  }
  const host = read('src/main/memory-banner-host.ts');
  for (const need of ["from 'electron'", "from './store'", "from './memory-guard'", "from './admission'", "from './pause-memory'"]) assert.ok(host.includes(need), need);
});

test('WIRING renderer store: the initial pull and every push replace the banner WHOLESALE by revision; a banner that is gone forgets the dismissal; « Masquer » stores the key of the banner it hid', () => {
  const s = read('src/renderer/store.ts');
  assert.match(s, /orEmpty\('memoryBanner', window\.orchestra\.memoryBanner\(\), null as MemoryBannerState \| null\),/);
  assert.match(s, /memoryBanner: memoryBanner \? newerBanner\(get\(\)\.memoryBanner, memoryBanner\) : get\(\)\.memoryBanner,/);
  assert.match(s, /window\.orchestra\.onMemoryBanner\(\(banner\) => \{\s*useStore\.setState\(\(st\) => \(\{ memoryBanner: newerBanner\(st\.memoryBanner, banner\), \.\.\.\(banner\.kind === 'none' \? \{ memoryBannerDismissed: null \} : \{\}\) \}\)\);/);
  assert.match(s, /dismissMemoryBanner: \(\) => set\(\(st\) => \(\{ memoryBannerDismissed: st\.memoryBanner && st\.memoryBanner\.kind !== 'none' \? bannerKey\(st\.memoryBanner\) : st\.memoryBannerDismissed \}\)\),/);
});

test('WIRING component + mounts: the banner reads the store slice, hides on the pure visibility rule, offers « Masquer », and is mounted for EVERY screen — above the pane row with a workspace, on top of the Welcome screen without one', () => {
  const c = read('src/renderer/components/MemoryBanner.tsx');
  assert.match(c, /if \(!banner \|\| !bannerVisible\(banner, dismissed\)\) return null;/);
  assert.match(c, /const copy = bannerCopy\(banner\);/);
  assert.match(c, /onClick=\{dismiss\}/);
  assert.match(c, /role="status"/);
  assert.match(c, />\s*Masquer\s*</);
  const app = read('src/renderer/App.tsx');
  assert.match(app, /<MemoryBanner \/>\s*<SetupBanner key=\{`setup-\$\{active\.id\}`\} workspace=\{active\} \/>/, 'with an active workspace: above the pane row, before the other banners');
  assert.match(app, /\{loaded && !active && <MemoryBanner \/>\}/, 'without one: the same banner');
  assert.equal((app.match(/<MemoryBanner \/>/g) ?? []).length, 2);
  assert.match(app, /import \{ MemoryBanner \} from '\.\/components\/MemoryBanner';/);
});

test('WIRING css: the two tones use the existing status tokens with the 3 px accent bar the mockup drew', () => {
  const css = read('src/renderer/styles.css');
  assert.match(css, /\.memory-banner\.warn \{ background: rgba\(255, 200, 87, 0\.10\); box-shadow: inset 3px 0 0 var\(--yellow\); \}/);
  assert.match(css, /\.memory-banner\.crit \{ background: rgba\(255, 107, 107, 0\.12\); box-shadow: inset 3px 0 0 var\(--red\); \}/);
});
