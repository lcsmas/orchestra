import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// #389 — the production wiring the pure tests cannot see: the switch is applied BEFORE `ready` and never in CLI mode,
// re-encryption runs once the window exists, and the state reaches the renderer on its own channel. The built-app rig
// (scripts/e2e-keyring.sh) is the end-to-end proof; this pins the call order so a reorder fails in the unit suite.

const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '../..', p), 'utf8');

test('index.ts: selectLinuxPasswordStore runs at module scope BEFORE app.whenReady, and not in CLI mode', () => {
  const index = read('src/main/index.ts');
  const sel = index.search(/selectLinuxPasswordStore\(\{/);
  const ready = index.search(/app\.whenReady\(\)\.then/);
  assert.ok(sel > 0 && ready > 0 && sel < ready, `selection @${sel} must precede whenReady @${ready}`);
  assert.match(index, /const keyringDecision = ORCHESTRA_CLI_MODE\s*\?\s*null\s*:\s*selectLinuxPasswordStore\(/);
  assert.match(index, /appendSwitch: \(name, value\) => app\.commandLine\.appendSwitch\(name, value\)/);
});

test('index.ts: the decision is logged after initLogger; startup re-encryption runs after the window and ONLY after our own unlocked-probe libsecret selection', () => {
  const index = read('src/main/index.ts');
  const ready = index.slice(index.search(/app\.whenReady\(\)\.then/));
  const init = ready.indexOf('initLogger();');
  const logLine = ready.indexOf('[secrets] password-store:');
  const win = ready.indexOf('await createMainWindow();');
  const reenc = ready.indexOf("reencryptInBackground('startup')");
  assert.ok(init >= 0 && init < logLine && logLine < win && win < reenc, JSON.stringify({ init, logLine, win, reenc }));
  assert.match(ready, /if \(keyringDecision\?\.store === 'gnome-libsecret'\) reencryptInBackground\('startup'\);/, 'a locked/recognised keyring is never touched at startup');
  assert.doesNotMatch(index, /reencryptPlaintextSecrets\(\)/, 'index.ts never calls the unguarded re-encryption directly');
});

test('the lazy re-encryption runs when Settings asks for the state with a working keyring and plaintext on disk', () => {
  const h = read('src/main/api-handlers.ts');
  assert.match(h, /if \(state\.encrypted && state\.plaintextEntries > 0\) reencryptInBackground\('settings'\);/);
});

test('the secrets state is served on its own channel, in lockstep across handlers / preload / ipc types', () => {
  assert.match(read('src/main/api-handlers.ts'), /getSecretsState: 'secrets:state'/);
  assert.match(read('src/main/api-handlers.ts'), /getSecretsState: async \(\) => \{\s*const state = await getSecretsState\(\);/);
  assert.match(read('src/preload/index.ts'), /getSecretsState: \(\) => ipcRenderer\.invoke\('secrets:state'\)/);
  assert.match(read('src/shared/ipc.ts'), /getSecretsState: \(\) => Promise<SecretsState>;/);
});

test('both secret-holding Settings dialogs render the notice; the Linear dialog no longer claims encryption unconditionally', () => {
  assert.match(read('src/renderer/components/AccountsSettings.tsx'), /<SecretsNotice \/>/);
  const linear = read('src/renderer/components/LinearSettings.tsx');
  assert.match(linear, /<SecretsNotice state=\{secrets\} \/>/);
  assert.match(linear, /secrets\?\.encrypted === true && secrets\.plaintextEntries === 0 && 'It’s stored encrypted on this machine\.'/);
  assert.doesNotMatch(linear, /\(separate from the Linear MCP login\)\. It’s stored encrypted/);
});

test('F3: both consumers of the stored key go through the fail-closed pair accessor — never the raw key/URL getters', () => {
  for (const f of ['src/main/agent-sdk.ts', 'src/main/account-usage.ts']) {
    const src = read(f);
    assert.match(src, /getAccountApiCredentials/, `${f} uses the pair accessor`);
    assert.doesNotMatch(src, /\bgetAccountApiKey\b|\bgetAccountBaseUrl\b/, `${f} must not read the key and URL separately`);
  }
  assert.match(read('src/main/account-usage.ts'), /accountKeyMissingMessage\(withheld\)/, 'the usage text distinguishes stored-but-unreadable from absent');
});
