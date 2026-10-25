// Rig runtime-world ratchet (incident Q2, ledger #405). A rig child that is handed the human's REAL
// /run/user/<uid> can reach gnome-keyring's bus/keyring sockets, and a crashing rig Electron aborted the
// daemon twice. scripts/e2e-contained-rig.sh now owns a PRIVATE XDG_RUNTIME_DIR; this test keeps the
// drivers honest: (1) `privateRuntimeDir()` refuses anything but that dir, (2) NO script may hard-code the
// real runtime dir unless it is on the reviewed allowlist below. The list only shrinks: an entry that no
// longer matches fails the test too, so a fixed script must leave the list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helperUrl = pathToFileURL(path.join(repo, 'scripts', 'lib', 'rig-runtime.mjs')).href;
const { privateRuntimeDir } = (await import(helperUrl)) as { privateRuntimeDir: (env?: Record<string, string | undefined>) => string };

test('privateRuntimeDir: the rig dir passes; unset / real / foreign / bare all refuse', () => {
  const rig = '/var/tmp/avr-1000/e2e64c-42';
  assert.equal(privateRuntimeDir({ RIG_DIR: rig, XDG_RUNTIME_DIR: `${rig}/xdg` }), `${rig}/xdg`, 'control: the rig-exported dir');
  assert.throws(() => privateRuntimeDir({ XDG_RUNTIME_DIR: `${rig}/xdg` }), /RIG_DIR unset/, 'not run through the rig');
  assert.throws(() => privateRuntimeDir({ RIG_DIR: rig }), /XDG_RUNTIME_DIR unset/);
  assert.throws(() => privateRuntimeDir({ RIG_DIR: rig, XDG_RUNTIME_DIR: '/run/user/1000' }), /human's runtime dir/, 'the real dir');
  assert.throws(() => privateRuntimeDir({ RIG_DIR: rig, XDG_RUNTIME_DIR: '/run/user/1000/x' }), /human's runtime dir/, 'under the real dir');
  assert.throws(() => privateRuntimeDir({ RIG_DIR: rig, XDG_RUNTIME_DIR: '/var/tmp/other/xdg' }), /not the rig's private dir/, 'a foreign dir');
});

// Files that NAME the real path as hostile data or as the thing to refuse (not a child env).
const NAMES_IT_TO_REFUSE = new Set([
  'scripts/e2e-contained-rig.sh',
  'scripts/e2e-contained-rig-selftest.sh',
  'scripts/e2e-contained-rig-mutants.mjs',
  'scripts/lib/rig-runtime.mjs',
]);
// Reviewed bypasses, NOT yet migrated (each builds its own sway/env under the real runtime dir, or needs the
// real systemd user manager). A new entry needs a reason a reviewer accepts; the goal is an empty list.
const OWN_SWAY = 'standalone: builds its own sway + app env under the real /run/user/<uid> (not through the contained rig)';
const ALLOW: Record<string, string> = {
  'scripts/bus-pane-screenshot.mjs': OWN_SWAY,
  'scripts/bus-rows-screenshot.mjs': OWN_SWAY,
  'scripts/context-panel-scroll-screenshot.mjs': OWN_SWAY,
  'scripts/human-gates-screenshot.mjs': OWN_SWAY,
  'scripts/restart-row-screenshot.mjs': OWN_SWAY,
  'scripts/network-visibility-screenshot.mjs': OWN_SWAY,
  'scripts/verify-bus-pane.mjs': OWN_SWAY,
  'scripts/renderer-cpu-profile.mjs': OWN_SWAY,
  'scripts/verify-149-wake-latency.mjs': OWN_SWAY,
  'scripts/verify-disk-guard-ui.mjs': OWN_SWAY,
  'scripts/verify-history-synthetic-filter.mjs': OWN_SWAY,
  'scripts/verify-keeper-detach.mjs': OWN_SWAY,
  'scripts/verify-loop-badge-restore.mjs': OWN_SWAY,
  'scripts/verify-bus-packaged-boot.sh': OWN_SWAY,
  'scripts/e2e-usage-resume-rig.sh': OWN_SWAY,
  'scripts/e2e-usage-resume-drive.mjs': OWN_SWAY,
};

const REAL_RUNTIME = /\/run\/user\/(\d+|\$)/;
function scriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...scriptFiles(p));
    else if (/\.(sh|mjs|cjs|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no script hard-codes the human\'s /run/user/<uid> outside the reviewed allowlist (and the allowlist has no stale entry)', () => {
  const hits = scriptFiles(path.join(repo, 'scripts'))
    .map((f) => path.relative(repo, f))
    .filter((rel) => REAL_RUNTIME.test(fs.readFileSync(path.join(repo, rel), 'utf8')) && !NAMES_IT_TO_REFUSE.has(rel))
    .sort();
  const unexpected = hits.filter((h) => !(h in ALLOW));
  assert.deepEqual(unexpected, [], `a script hard-codes /run/user/<uid> — take XDG_RUNTIME_DIR from scripts/lib/rig-runtime.mjs (privateRuntimeDir) or run it through scripts/e2e-contained-rig.sh; if it genuinely cannot, add it to ALLOW with a reason: ${unexpected.join(', ')}`);
  const stale = Object.keys(ALLOW).filter((k) => !hits.includes(k));
  assert.deepEqual(stale, [], `ALLOW lists a script that no longer matches (fixed or removed) — delete the entry: ${stale.join(', ')}`);
});

test('the ratchet can fail: the pattern matches the real shapes seen in the tree, and not the placeholder', () => {
  for (const s of ["'/run/user/1000'", '`/run/user/${process.getuid()}`', '/run/user/$(id -u)', 'unix:path=/run/user/1000/bus']) assert.ok(REAL_RUNTIME.test(s), s);
  for (const s of ['/run/user/<uid>', 'XDG_RUNTIME_DIR', 'run/user']) assert.ok(!REAL_RUNTIME.test(s), s);
});

test('every migrated driver imports the helper and none of them keeps a literal fallback', () => {
  const migrated = [
    'scripts/e2e-agent-view-removal.mjs', 'scripts/e2e-former-branch-drive.mjs', 'scripts/e2e-inherit-empty-boot.mjs', 'scripts/e2e-pinned-node-app.mjs',
    'scripts/pause-canary/lib.mjs', 'scripts/browser-reliquats/chip-screenshot.mjs', 'scripts/container-memory-screenshot.mjs', 'scripts/memcap-screenshot.mjs',
    'scripts/memory-cap-row-screenshot.mjs', 'scripts/reliquats-screenshot.mjs',
  ];
  for (const rel of migrated) {
    const src = fs.readFileSync(path.join(repo, rel), 'utf8');
    assert.match(src, /import \{ privateRuntimeDir \} from '[./]+\/(lib\/)?rig-runtime\.mjs'/, `${rel} imports the helper`);
    assert.match(src, /privateRuntimeDir\(\)/, `${rel} calls it`);
    assert.doesNotMatch(src, REAL_RUNTIME, `${rel} has no hard-coded real runtime dir`);
  }
});
