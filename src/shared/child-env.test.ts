import test from 'node:test';
import assert from 'node:assert/strict';
import { PROCESS_LOCAL_ENV_VARS, stripProcessLocalEnv } from './child-env.ts';

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
