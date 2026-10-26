// Rig runtime-world ratchet (incident Q2, ledger #405). A rig child that is handed the human's REAL
// /run/user/<uid> can reach gnome-keyring's bus/keyring sockets, and a crashing rig Electron aborted the
// daemon twice. scripts/e2e-contained-rig.sh now owns a PRIVATE XDG_RUNTIME_DIR; this test keeps the
// drivers honest: (1) `privateRuntimeDir()` refuses anything but that dir, (2) NO script may hard-code the
// real runtime dir unless it is on the reviewed allowlist below. The list only shrinks: an entry that no
// longer matches fails the test too, so a fixed script must leave the list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helperUrl = pathToFileURL(path.join(repo, 'scripts', 'lib', 'rig-runtime.mjs')).href;
const { privateRuntimeDir, handedEnvProblems } = (await import(helperUrl)) as {
  privateRuntimeDir: (env?: Record<string, string | undefined>) => string;
  handedEnvProblems: (env: Record<string, string>, want: Record<string, string>) => string[];
};

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
  'scripts/refuse-real-runtime.mjs',
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

// `\b` after `user`: `/run/user/1000`, `/run/user/${uid}`, AND `'/run/user/' + uid` / `'/run/user' + '/' + uid` all keep the literal.
// Split/joined forms (`'/run/' + 'user/'`, `['run','user'].join('/')`) are NOT catchable by a regex: the hidden-world backstop (RIG_HIDE_REAL_RUNTIME) is the only net.
const REAL_RUNTIME = /\/run\/user\b/;
const OLD_REAL_RUNTIME = /\/run\/user\/(\d+|\$)/;   // the first version: kept only as the ratchet's own must-FAIL mutant
/** CODE lines only: a line that is wholly a `//` / `#` comment names the path to explain it (e.g. #393's rig), it does not hard-code it. */
const codeOnly = (src: string): string => src.split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
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
/** Files under `dir` (paths relative to it) whose CODE lines match `re`. */
function offenders(dir: string, re: RegExp): string[] {
  return scriptFiles(dir).map((f) => path.relative(dir, f)).filter((rel) => re.test(codeOnly(fs.readFileSync(path.join(dir, rel), 'utf8')))).sort();
}

test('no script hard-codes the human\'s /run/user/<uid> outside the reviewed allowlist (and the allowlist has no stale entry)', () => {
  const hits = offenders(path.join(repo, 'scripts'), REAL_RUNTIME).map((r) => `scripts/${r}`).filter((rel) => !NAMES_IT_TO_REFUSE.has(rel));
  const unexpected = hits.filter((h) => !(h in ALLOW));
  assert.deepEqual(unexpected, [], `a script hard-codes /run/user<…> — take XDG_RUNTIME_DIR from scripts/lib/rig-runtime.mjs (privateRuntimeDir) or run it through scripts/e2e-contained-rig.sh; if it genuinely cannot, add it to ALLOW with a reason: ${unexpected.join(', ')}`);
  const stale = Object.keys(ALLOW).filter((k) => !hits.includes(k));
  assert.deepEqual(stale, [], `ALLOW lists a script that no longer matches (fixed or removed) — delete the entry: ${stale.join(', ')}`);
});

test('scratch-tree arms: concatenated literal fails, commented mention passes, slash-less form fails — and the OLD pattern misses the concatenations (mutant)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-'));
  try {
    fs.writeFileSync(path.join(dir, 'concat.mjs'), "const d = '/run/user/' + process.getuid();\n");
    fs.writeFileSync(path.join(dir, 'slashless.mjs'), "const d = '/run/user' + '/' + String(process.getuid());\n");
    fs.writeFileSync(path.join(dir, 'commented.mjs'), "// never '/run/user/' + uid\n# /run/user/1000\nconst ok = 1;\n");
    fs.writeFileSync(path.join(dir, 'clean.mjs'), "const d = process.env.XDG_RUNTIME_DIR;\n");
    assert.deepEqual(offenders(dir, REAL_RUNTIME), ['concat.mjs', 'slashless.mjs'], 'concat + slash-less are caught, the commented mention and the clean file are not');
    // the mutant: the first-version pattern lets both concatenations through — so these arms distinguish the two patterns
    assert.deepEqual(offenders(dir, OLD_REAL_RUNTIME), [], 'the old pattern misses both (this is the gap the arms pin)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the ratchet can fail: the pattern matches the real shapes seen in the tree, and not the placeholder', () => {
  for (const s of ["'/run/user/1000'", '`/run/user/${process.getuid()}`', '/run/user/$(id -u)', 'unix:path=/run/user/1000/bus', "'/run/user/' + uid", '/run/user/<uid>']) assert.ok(REAL_RUNTIME.test(s), s);
  for (const s of ['XDG_RUNTIME_DIR', 'run/user', '/run/users']) assert.ok(!REAL_RUNTIME.test(s), s);
  assert.ok(!REAL_RUNTIME.test(codeOnly('  // never /run/user/1000/bus\n# /run/user/1000')), 'a wholly-commented mention is not a hard-code');
  assert.ok(REAL_RUNTIME.test(codeOnly('const x = 1; // fine\nconst d = `/run/user/${uid}`;')), 'a code line still counts');
});

test('every migrated driver TOP-LEVEL-imports the helper (resolvable), calls it, and keeps no literal fallback', () => {
  const migrated = [
    'scripts/e2e-agent-view-removal.mjs', 'scripts/e2e-former-branch-drive.mjs', 'scripts/e2e-inherit-empty-boot.mjs', 'scripts/e2e-pinned-node-app.mjs',
    'scripts/pause-canary/lib.mjs', 'scripts/browser-reliquats/chip-screenshot.mjs', 'scripts/container-memory-screenshot.mjs', 'scripts/memcap-screenshot.mjs',
    'scripts/memory-cap-row-screenshot.mjs', 'scripts/reliquats-screenshot.mjs', 'scripts/e2e-browser-tabs.mjs',
  ];
  for (const rel of migrated) {
    const file = path.join(repo, rel);
    const src = fs.readFileSync(file, 'utf8');
    // AST, not a regex: the screenshot drivers embed an esbuild entry in a template literal, and an `import` line
    // inside that literal is NOT a binding of the outer script (the call site would throw ReferenceError at run time).
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const spec = sf.statements
      .filter(ts.isImportDeclaration)
      .map((d) => ({ from: (d.moduleSpecifier as ts.StringLiteral).text, names: d.importClause?.namedBindings && ts.isNamedImports(d.importClause.namedBindings) ? d.importClause.namedBindings.elements.map((e) => e.name.text) : [] }))
      .find((i) => i.names.includes('privateRuntimeDir'));
    assert.ok(spec, `${rel}: no TOP-LEVEL import binding privateRuntimeDir`);
    assert.ok(fs.existsSync(path.resolve(path.dirname(file), spec.from)), `${rel}: import '${spec.from}' does not resolve`);
    assert.equal(path.resolve(path.dirname(file), spec.from), path.join(repo, 'scripts', 'lib', 'rig-runtime.mjs'), `${rel}: imports the wrong module`);
    assert.match(src, /privateRuntimeDir\(\)/, `${rel} calls it`);
    assert.doesNotMatch(codeOnly(src), REAL_RUNTIME, `${rel} has no hard-coded real runtime dir`);
  }
});

// An ALLOW-listed script must not be one `pnpm run test:*` away: package.json routes it through the refusal shim instead.
function directRefs(pkgScripts: Record<string, string>, rels: string[]): string[] {
  return Object.entries(pkgScripts).filter(([, cmd]) => rels.some((r) => cmd.includes(r))).map(([name]) => name).sort();
}
test('no package.json script runs an ALLOW-listed (real-runtime) script directly; the refusal shim exits 3 naming why', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.deepEqual(directRefs(pkg.scripts, Object.keys(ALLOW)), [], 'a pnpm script reaches a real-runtime script — route it through scripts/refuse-real-runtime.mjs');
  const shimmed = Object.entries(pkg.scripts).filter(([, c]) => c.includes('scripts/refuse-real-runtime.mjs')).map(([n]) => n).sort();
  assert.deepEqual(shimmed, ['test:bus-pane', 'test:ctx-scroll-shot', 'test:disk-guard-ui', 'test:human-gates-shot', 'test:network-visibility-shot', 'test:renderer-cpu', 'test:restart-row-shot'], 'the seven one-command-away scripts are refused');
  // must-FAIL arm: the detector does flag a direct reference
  assert.deepEqual(directRefs({ 'test:x': 'node scripts/verify-bus-pane.mjs', 'test:y': 'node scripts/other.mjs' }, ['scripts/verify-bus-pane.mjs']), ['test:x']);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'refuse-real-runtime.mjs'), 'test:x'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /REFUSED: `pnpm run test:x`/);
  assert.match(r.stderr, /Nothing was run/);
});

test('handedEnvProblems: what a driver handed the app (the instrument that replaces the blind /proc/<pid>/environ read) passes the good env and names each bad one', () => {
  const rig = '/var/tmp/avr-1000/e2e64c-42';
  const want = { ohome: '/w/oh', cfg: '/w/cfg', home: '/w/home', wayland: 'wayland-rig', xdg: `${rig}/xdg`, noBusPath: `${rig}/no-session-bus` };
  const good: Record<string, string> = { ORCHESTRA_HOME: '/w/oh', CLAUDE_CONFIG_DIR: '/w/cfg', HOME: '/w/home', WAYLAND_DISPLAY: 'wayland-rig', XDG_RUNTIME_DIR: `${rig}/xdg`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${rig}/no-session-bus`, PATH: '/usr/bin' };
  assert.deepEqual(handedEnvProblems(good, want), [], 'control: the good env');
  const cases: [string, Record<string, string>, RegExp][] = [
    ['wrong ORCHESTRA_HOME', { ...good, ORCHESTRA_HOME: '/live/.orchestra' }, /ORCHESTRA_HOME=\/live/],
    ['wrong CLAUDE_CONFIG_DIR', { ...good, CLAUDE_CONFIG_DIR: '/home/u/.claude' }, /CLAUDE_CONFIG_DIR=/],
    ['wrong HOME', { ...good, HOME: '/home/u' }, /HOME=\/home\/u/],
    ['human wayland name', { ...good, WAYLAND_DISPLAY: 'wayland-1' }, /WAYLAND_DISPLAY=wayland-1/],
    ['real XDG_RUNTIME_DIR', { ...good, XDG_RUNTIME_DIR: '/run/user/1000' }, /XDG_RUNTIME_DIR=\/run\/user\/1000/],
    ['DISPLAY set', { ...good, DISPLAY: ':0' }, /DISPLAY=:0 is set/],
    ['DBUS unset', Object.fromEntries(Object.entries(good).filter(([k]) => k !== 'DBUS_SESSION_BUS_ADDRESS')), /DBUS_SESSION_BUS_ADDRESS=<unset>/],
    ['DBUS the human\'s bus', { ...good, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }, /DBUS_SESSION_BUS_ADDRESS=unix:path=\/run\/user\/1000\/bus/],
    ['a /run/user value anywhere', { ...good, GNOME_KEYRING_CONTROL: '/run/user/1000/keyring' }, /GNOME_KEYRING_CONTROL contains \/run\/user\//],
  ];
  for (const [label, env, re] of cases) assert.match(handedEnvProblems(env, want).join(' | '), re, label);
});
