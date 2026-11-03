import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CHILD_ONLY_STRIPPED_ENV_VARS, PROCESS_LOCAL_ENV_VARS, childEnv, stripProcessLocalEnv } from './child-env.ts';

test('stripProcessLocalEnv removes the AppImage/ozone bootstrap vars', () => {
  const env: Record<string, string | undefined> = {
    APPIMAGE: '/home/u/.local/bin/Orchestra.AppImage',
    APPDIR: '/tmp/.mount_Orchesabc',
    ARGV0: 'orchestra',
    OWD: '/home/u',
    ORCHESTRA_OZONE_RELAUNCHED: '1',
  };
  const removed = stripProcessLocalEnv(env);
  assert.deepEqual(removed.sort(), [...PROCESS_LOCAL_ENV_VARS].sort());
  assert.deepEqual(env, {});
});

test('stripProcessLocalEnv keeps everything a child legitimately inherits', () => {
  const env: Record<string, string | undefined> = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    SHELL: '/bin/zsh',
    // The user's explicit platform choice survives: a dev build launched from a
    // workspace should pick the same ozone platform as the installed app.
    ORCHESTRA_OZONE: 'x11',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    ORCHESTRA_WS_ID: 'ws-1',
    APPIMAGE: '/home/u/.local/bin/Orchestra.AppImage',
  };
  const removed = stripProcessLocalEnv(env);
  assert.deepEqual(removed, ['APPIMAGE']);
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/u',
    SHELL: '/bin/zsh',
    ORCHESTRA_OZONE: 'x11',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    ORCHESTRA_WS_ID: 'ws-1',
  });
});

test('stripProcessLocalEnv is a no-op on an already-clean env', () => {
  const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
  assert.deepEqual(stripProcessLocalEnv(env), []);
  assert.deepEqual(env, { PATH: '/usr/bin' });
});

test('childEnv drops CHROME_DESKTOP (a child Chromium would take Orchestra\'s desktop identity) and keeps the rest', () => {
  const base = { CHROME_DESKTOP: 'orchestra.desktop', PATH: '/usr/bin', HOME: '/home/u', UNSET: undefined };
  const env = childEnv(base);
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/u' });
  assert.equal(base.CHROME_DESKTOP, 'orchestra.desktop', 'a copy: the main process keeps its own (Electron re-reads it)');
  assert.deepEqual([...CHILD_ONLY_STRIPPED_ENV_VARS], ['CHROME_DESKTOP']);
});

test('every user-facing child env is built from childEnv(), never a raw process.env copy', () => {
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '../..', p), 'utf8');
  const sites: Array<[string, RegExp, RegExp]> = [
    ['src/main/agent-sdk.ts', /const env = childEnv\(\);\s*delete env\.CLAUDE_CONFIG_DIR;/, /for \(const \[k, v\] of Object\.entries\(process\.env\)\) \{\s*if \(typeof v === 'string'\) env\[k\] = v;/],
    ['src/main/pty.ts', /: \{\s*\.\.\.childEnv\(\),\s*\.\.\.\(opts\.extraEnv/, /\.\.\.\(process\.env as Record<string, string>\)/],
    ['src/main/scripts.ts', /env: \{ \.\.\.childEnv\(\), \.\.\.opts\.env \}/, /env: \{ \.\.\.process\.env, \.\.\.opts\.env \}/],
    ['src/main/keeper-client.ts', /const env: NodeJS\.ProcessEnv = childEnv\(\);\s*if \(pick\.electronRunAsNode\)/, /const env: NodeJS\.ProcessEnv = \{ \.\.\.process\.env \};/],
  ];
  for (const [file, mustUse, mustNot] of sites) {
    const src = read(file);
    assert.match(src, mustUse, `${file} builds its child env from childEnv()`);
    assert.doesNotMatch(src, mustNot, `${file} no longer copies process.env raw`);
  }
});
