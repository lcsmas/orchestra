import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Accès mobile (#334, ADR 0006). index.ts / hooks-server.ts / acces-mobile-host.ts cannot be imported under `node --test`
// (Electron host), so the WIRING is pinned on source text; the server's behaviour is tested in src/acces-mobile/server.test.ts
// and the projection in src/shared/acces-mobile.test.ts.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const index = read('src/main/index.ts');
const hooks = read('src/main/hooks-server.ts');
const host = read('src/main/acces-mobile-host.ts');
const entry = read('src/acces-mobile/index.ts');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

test('CONTROL: sources are the real files', () => {
  assert.match(index, /await startHooksServer\(\);/);
  assert.match(host, /export function applyAccesMobile\(/);
});

test('boot starts the host right after the hooks socket is bound; shutdown stops it before the socket', () => {
  assert.match(index, /await startHooksServer\(\);\n(?:\s*\/\/.*\n)*\s*startAccesMobileHost\(\);/);
  assert.match(index, /stopAccesMobileHost\(\);[^\n]*\n\s*stopHooksServer\(\);/);
});

test('the socket route serves the projection (every account, archived dropped)', () => {
  assert.match(hooks, /route === '\/mobile\/workspaces'/);
  assert.match(hooks, /projectMobileWorkspaces\(store\.workspaces, store\.repos, store\.accounts\)/);
});

test('main opens no port: the host spawns a process and never listens', () => {
  assert.doesNotMatch(host, /\.listen\(|createServer\(/);
  assert.match(host, /spawn\('\/bin\/bash', \['-c', CLOSE_INHERITED_FDS, 'orchestra-acces-mobile', process\.execPath, script\]/);
  assert.match(host, /import \{\n  CLOSE_INHERITED_FDS,/, 'the wrapper is the shared, unit-tested one');
  assert.match(host, /const viaBash = process\.platform === 'linux' && fs\.existsSync\('\/bin\/bash'\);/, 'the wrapper is used on every Linux host with bash');
});

test('the network-facing process gets an ALLOWLISTED env, never main\'s', () => {
  const envBlock = /const env: NodeJS\.ProcessEnv = \{([\s\S]*?)\};/.exec(host)?.[1] ?? '';
  assert.ok(envBlock.includes('ELECTRON_RUN_AS_NODE'), 'control: found the env block');
  assert.doesNotMatch(envBlock, /\.\.\.process\.env/);
  assert.deepEqual(
    [...envBlock.matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]).sort(),
    ['ACCES_MOBILE_LOGIN', 'ACCES_MOBILE_SOCKET', 'ACCES_MOBILE_TOKEN_FILE', 'ELECTRON_RUN_AS_NODE', 'ORCHESTRA_SOCK', 'PATH'],
  );
});

test('the server listens on its Unix socket only, created 0600 (umask before bind) — no TCP port at all', () => {
  const code = entry.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(code, /process\.umask\(0o177\);\nserver\.listen\(sockPath,/);
  assert.equal([...code.matchAll(/\.listen\(/g)].length, 1, 'exactly one listen');
  assert.doesNotMatch(code, /127\.0\.0\.1|0\.0\.0\.0|'::'|ACCES_MOBILE_PORT/);
});

test('a failure of the optional feature never stops main\'s boot', () => {
  assert.match(host, /export function startAccesMobileHost\(\): void \{\n  try \{\n    applyAccesMobile/);
  assert.match(host, /function startChildSafe\(s: AccesMobileSettings\): void \{\n  try \{\n    startChild\(s\);/);
  assert.match(host, /function startChildSafe[\s\S]*?\} catch \(e\) \{[\s\S]*?scheduleRetry\(msg\);/, 'a thrown start becomes a retry');
  assert.doesNotMatch(host.replace(/function startChildSafe[\s\S]*?\n\}\n/, ''), /[^e]startChild\(desired\)|  startChild\(s\);/, 'every other start goes through startChildSafe');
});

test('the token file is written by the Electron-free module (modes + atomicity are tested there: acces-mobile-token.test.ts); the host only delegates', () => {
  assert.match(host, /return writeFreshTokenIn\(accesMobileDir\(\)\);/);
  assert.match(host, /return readTokenIn\(accesMobileDir\(\)\);/);
  assert.doesNotMatch(host, /randomBytes|writeFileSync\(tmp, token/, 'no second token writer in the host');
});

test('« Regenerate token »: the Settings button → IPC → host.regenerateAccesMobileToken → a fresh token file; the token is never logged (#336)', () => {
  const preload = read('src/preload/index.ts');
  const handlers = read('src/main/api-handlers.ts');
  const ui = read('src/renderer/components/AccesMobileSettings.tsx');
  assert.match(preload, /regenerateAccesMobileToken: \(\) => ipcRenderer\.invoke\('settings:regenerateAccesMobileToken'\)/);
  assert.match(handlers, /regenerateAccesMobileToken: 'settings:regenerateAccesMobileToken'/);
  assert.match(handlers, /regenerateAccesMobileToken: async \(\) => regenerateAccesMobileToken\(\)/);
  assert.match(ui, /data-am-regenerate(?!d)/, 'the button (not just its confirmation note)');
  assert.match(ui, /window\.orchestra\.regenerateAccesMobileToken\(\)/);
  const fn = /export function regenerateAccesMobileToken\(\): AccesMobileView \{([\s\S]*?)\n\}/.exec(host)?.[1] ?? '';
  assert.match(fn, /generateAccesMobileToken\(\);/, 'control: found the function and it writes a new token');
  assert.doesNotMatch(fn, /log\.\w+\([^)]*(token|Token)[^)]*\$\{|log\.\w+\([^)]*readAccesMobileToken/, 'the token never reaches a log line');
});

test('the pairing URL (QR) comes from main\'s view; the QR is drawn in the renderer from it (token in the fragment only)', () => {
  assert.match(host, /pairingUrl: pairingUrl\(settings\.tailnetHost, settings\.servePort, token\),/);
  const ui = read('src/renderer/components/AccesMobileSettings.tsx');
  assert.match(ui, /<AccesMobileQr text=\{view\.pairingUrl\} \/>/);
  assert.match(ui, /data-am-url/);
  assert.doesNotMatch(read('src/shared/acces-mobile.ts') + entry, /from 'qrcode'/, 'the shared settings module and the server process never import the QR library');
});

test('Orchestra never runs `tailscale` (ADR 0006): no spawn/exec of it anywhere in the feature', () => {
  for (const f of ['src/main/acces-mobile-host.ts', 'src/main/acces-mobile-token.ts', 'src/acces-mobile/index.ts', 'src/acces-mobile/server.ts', 'src/acces-mobile/sw.ts', 'src/renderer/components/AccesMobileSettings.tsx', 'src/shared/acces-mobile.ts']) {
    const code = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /(?:spawn|exec|execFile|execSync|execFileSync|fork)\w*\(\s*['"`][^'"`]*tailscale/i, f);
  }
  const spawns = [...host.matchAll(/spawn\(([^,]+),/g)].map((m) => m[1].trim());
  assert.deepEqual(spawns, ["'/bin/bash'", 'process.execPath'], 'control: the host spawns only the bash wrapper / the server runtime');
});

test('the bundle ships with every build (CI uses build:bundles)', () => {
  assert.match(pkg.scripts['build:bundles'], /pnpm run build:acces-mobile/);
  assert.match(pkg.scripts['build:acces-mobile'], /vite\.acces-mobile\.config\.ts/);
});
