import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHROMIUM_CANDIDATES,
  chromiumLoginArgv,
  isLaunchableUrl,
  loginProfileDirName,
} from './login-chromium.ts';

test('loginProfileDirName is stable and per-account', () => {
  assert.equal(loginProfileDirName('539d0a16-03ae-4149-91a6-30a46c189074'), 'login-539d0a16-03ae-4149-91a6-30a46c189074');
  // Distinct accounts must never share a profile — that would share the cookie
  // jar and reintroduce the "logged in as the wrong account" bug.
  assert.notEqual(loginProfileDirName('a'), loginProfileDirName('b'));
});

test('loginProfileDirName cannot escape the profiles root', () => {
  // The result is joined onto a directory, so separators/traversal must not survive.
  for (const evil of ['../../etc', 'a/b', 'a\\b', '..']) {
    const got = loginProfileDirName(evil);
    assert.ok(!got.includes('/'), `${got} contains /`);
    assert.ok(!got.includes('\\'), `${got} contains backslash`);
    assert.ok(!got.includes('..'), `${got} contains ..`);
  }
  assert.equal(loginProfileDirName(''), 'login-unknown');
});

test('chromiumLoginArgv isolates the cookie jar via --user-data-dir', () => {
  const argv = chromiumLoginArgv('/tmp/p', 'https://claude.com/cai/oauth/authorize');
  // --user-data-dir is the load-bearing flag: --profile-directory would attach
  // to the user's RUNNING browser and inherit the main account's session.
  assert.ok(argv.includes('--user-data-dir=/tmp/p'));
  assert.ok(!argv.some((a) => a.startsWith('--profile-directory')));
  // URL goes last, so it is never parsed as the value of a preceding flag.
  assert.equal(argv.at(-1), 'https://claude.com/cai/oauth/authorize');
});

test('isLaunchableUrl rejects argv injection and non-web schemes', () => {
  assert.equal(isLaunchableUrl('https://claude.com/cai/oauth/authorize'), true);
  assert.equal(isLaunchableUrl('http://localhost:1455/callback'), true);
  // A leading dash would be read as a Chromium switch, not a URL.
  assert.equal(isLaunchableUrl('--headless=new'), false);
  assert.equal(isLaunchableUrl('-anything'), false);
  assert.equal(isLaunchableUrl('file:///etc/passwd'), false);
  assert.equal(isLaunchableUrl('javascript:alert(1)'), false);
  assert.equal(isLaunchableUrl('not a url'), false);
});

test('chromium candidates prefer the real Fedora binary over the alias', () => {
  // `chromium` on Fedora is a shell alias with no executable behind it; the
  // real binary is chromium-browser, so it must be tried first.
  const list = [...CHROMIUM_CANDIDATES];
  assert.ok(list.indexOf('chromium-browser') < list.indexOf('chromium'));
});
