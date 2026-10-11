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
  assert.match(host, /eval "exec \$n>&-"/, 'every inherited fd above stderr is closed before the server runs');
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
  assert.doesNotMatch(host.replace(/function startChildSafe[\s\S]*?\n\}\n/, ''), /[^e]startChild\(desired\)|  startChild\(s\);/, 'every other start goes through startChildSafe');
});

test('the token file is written 0600 in a 0700 dir, atomically', () => {
  assert.match(host, /mkdirSync\(dir, \{ recursive: true, mode: 0o700 \}\);\n  fs\.chmodSync\(dir, 0o700\);/);
  assert.match(host, /writeFileSync\(tmp, token \+ '\\n', \{ mode: 0o600 \}\)/);
  assert.match(host, /renameSync\(tmp, accesMobileTokenPath\(\)\)/);
});

test('the bundle ships with every build (CI uses build:bundles)', () => {
  assert.match(pkg.scripts['build:bundles'], /pnpm run build:acces-mobile/);
  assert.match(pkg.scripts['build:acces-mobile'], /vite\.acces-mobile\.config\.ts/);
});
