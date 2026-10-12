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
    ['ACCES_MOBILE_LOGIN', 'ACCES_MOBILE_SOCKET', 'ACCES_MOBILE_TOKEN_FILE', 'ELECTRON_RUN_AS_NODE', 'PATH'],
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




const routes = read('src/main/acces-mobile-routes.ts');

test('#338 review M1: the phone\'s operations are NOT on the hooks socket any local agent can reach — only on the private fd-3 channel', () => {
  assert.match(hooks, /route === '\/accounts'/, 'control: the hooks routes are there');
  assert.doesNotMatch(hooks, /\/mobile\//, 'no /mobile/* route on the hooks socket');
  assert.doesNotMatch(host, /ORCHESTRA_SOCK|getHookSocketPath/, 'the server is not even told where the hooks socket is');
  assert.match(host, /stdio: \['pipe', 'pipe', 'pipe', 'pipe'\]/g, 'fd 3 handed at spawn');
  assert.match(host, /serveRpc\(channel, mobileRpcHandlers,/, 'main serves the phone operations on that channel');
  assert.match(entry, /new net\.Socket\(\{ fd: 3, readable: true, writable: true \}\)/, 'the server talks to main over fd 3');
  assert.match(read('src/shared/acces-mobile.ts'), /if \[ "\$n" -gt 3 \]; then eval "exec \$n>&-"/, 'the exec wrapper keeps fd 3 and only fd 3');
});

test('the routes: list, conversation (archived refused), seen (the ONE mark-seen), stream (the feed)', () => {
  assert.match(routes, /case '\/mobile\/workspaces':[\s\S]*?projectMobileWorkspaces\(store\.workspaces, store\.repos, store\.accounts\)/);
  assert.match(routes, /function liveWorkspace[\s\S]*?return ws && !ws\.archived \? ws : undefined;/);
  assert.match(routes, /case '\/mobile\/conversation': \{\n[^\n]*\n\s*const ws = liveWorkspace\(msg\.id\);\n\s*return ws \? getMobileConversation\(ws\.id\)/);
  assert.match(routes, /case '\/mobile\/seen':[\s\S]*?await markWorkspaceSeen\(ws\.id\)/);
  assert.match(routes, /if \(route !== '\/mobile\/stream'\) return null;\n\s*const off = subscribeMobileFeed\(push\);[\s\S]*?push\(\{ t: 'ping' \}\);\n\s*return off;/, 'a stream opens with an immediate ping');
  assert.match(read('src/main/api-handlers.ts'), /markSeen: async \(id\) => markWorkspaceSeen\(id\)/, 'the desktop uses the same mark-seen');
  const feed = read('src/main/acces-mobile-feed.ts');
  assert.match(feed, /createMobileFeed\(\{\n\s*loadHistory: sdkHistory,\n\s*onBroadcast,\n\s*liveAsks: sdkLiveAnswerables,\n\s*isRunning: \(id\) => store\.getWorkspace\(id\)\?\.status === 'running',/);
  const platform = read('src/main/platform/index.ts');
  assert.match(platform, /current\(\)\.broadcast\(channel, \.\.\.args\);\n\s*if \(taps\.size\) \{\n\s*for \(const t of taps\) \{\n\s*try \{\n\s*t\(channel, args\);\n\s*\} catch \{/, 'every UI push reaches the taps, after the window; a throwing tap is contained');
  const conv = read('src/acces-mobile/conversation.ts');
  assert.ok(conv.includes('textContent'), 'control: the phone JS renders with textContent');
  assert.doesNotMatch(conv, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'agent text never becomes markup');
});

test('#338: a phone message takes the HUMAN composer path, never the agent-message gate; #339 answers through the desktop builder', () => {
  const send = /case '\/mobile\/send': \{[\s\S]*?\n {6}\}/.exec(routes)?.[0] ?? '';
  assert.ok(send.includes('liveWorkspace(msg.id)'), 'control: found the send case (archived refused)');
  assert.match(send, /await sdkSend\(ws\.id, text, undefined, undefined, undefined, false, false, 'human'\)/);
  assert.match(read('src/main/api-handlers.ts'), /agentSdkSend: async \(wsId, text, images\) => \{[\s\S]*?await sdkSend\(wsId, text, images, undefined, undefined, false, false, 'human'\)/, 'identical to the desktop composer call');
  const code = send.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /dispatchMessageRequest|decideMessageChannel|sdkDeliver/, 'not the agent-to-agent path');
  assert.match(routes, /case '\/mobile\/answer':[\s\S]*?return sdkAnswerAskUserQuestion\(ws\.id, msg\.requestId, answers as Record<string, string\[\]>\);/);
  const sdk = read('src/main/agent-sdk.ts');
  assert.match(sdk, /updatedInput: buildAskUserQuestionReply\(input, parsed\.questions, selections\)/, 'the desktop card\'s builder on the ORIGINAL input');
  assert.match(sdk, /if \(!resolve\) return false; \/\/ already answered/, 'never applied twice');
  assert.match(sdk, /emitAnswerableResolved\(session, 'permission', requestId\);\n\s*return true;/, 'every surface is told');
});
