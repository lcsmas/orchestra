// Unit tests for the generalised pinned native-module resolver (#126).
//
// These assert the PACKAGED branch — which is unreachable when the suite runs
// from src/main/ (not inside an app.asar) — by driving the parameterised core
// `requirePinnedNativeFrom(here, require, …)` with a fabricated `here` that
// looks packaged, plus a fixture tree standing in for app.asar.unpacked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  isPackagedHere,
  computeAppRootUnpacked,
  computeUnpackedNativePath,
  requirePinnedNativeFrom,
} from './native-pin.ts';

test('isPackagedHere: recognises an app.asar path, rejects a plain one', () => {
  assert.equal(isPackagedHere('/opt/Orchestra/resources/app.asar/dist-electron'), true);
  assert.equal(isPackagedHere('/home/x/src/main'), false);
});

test('computeAppRootUnpacked maps app.asar/dist-electron → app.asar.unpacked root', () => {
  const here = '/opt/Orchestra/resources/app.asar/dist-electron';
  assert.equal(
    computeAppRootUnpacked(here),
    '/opt/Orchestra/resources/app.asar.unpacked',
  );
  assert.equal(computeAppRootUnpacked('/home/x/src/main'), null);
});

test('computeUnpackedNativePath resolves under node_modules of the unpacked root', () => {
  const here = '/opt/Orchestra/resources/app.asar/dist-electron';
  assert.equal(
    computeUnpackedNativePath(here, 'node-pty', 'build/Release/pty.node'),
    '/opt/Orchestra/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node',
  );
  assert.equal(
    computeUnpackedNativePath('/dev/src/main', 'node-pty', 'build/Release/pty.node'),
    null,
  );
});

// The must-FAIL arm of T126.2: a packaged load with the pinned binary MISSING
// must REFUSE with a diagnostic, never silently fall back to the in-asar copy.
test('requirePinnedNativeFrom REFUSES when the unpacked binary is missing (packaged)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-pin-refuse-'));
  try {
    // Build a fabricated packaged layout WITHOUT the .node present.
    const here = path.join(tmp, 'resources', 'app.asar', 'dist-electron');
    const pkgDir = path.join(
      tmp,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
    );
    fs.mkdirSync(pkgDir, { recursive: true }); // pkg dir exists, binary does NOT

    let called = false;
    assert.throws(
      () =>
        requirePinnedNativeFrom(
          here,
          () => {
            called = true;
            return {};
          },
          'node-pty',
          'build/Release/pty.node',
        ),
      /unpacked native module 'node-pty' is missing[\s\S]*refusing to fall back/,
    );
    // It must refuse BEFORE requiring anything — never a silent asar fallback.
    assert.equal(called, false, 'require was called despite the missing binary');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The positive arm: with the pinned binary present, it requires the UNPACKED
// package dir (not a bare specifier), so node-pty's own relative `.node` require
// resolves the unpacked copy.
test('requirePinnedNativeFrom requires the UNPACKED package dir when present (packaged)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-pin-ok-'));
  try {
    const here = path.join(tmp, 'resources', 'app.asar', 'dist-electron');
    const pkgDir = path.join(
      tmp,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
    );
    const nodeFile = path.join(pkgDir, 'build', 'Release', 'pty.node');
    fs.mkdirSync(path.dirname(nodeFile), { recursive: true });
    fs.writeFileSync(nodeFile, 'stub'); // presence is all the resolver checks

    let requestedId = '';
    const sentinel = { ok: true };
    const got = requirePinnedNativeFrom(
      here,
      (id) => {
        requestedId = id;
        return sentinel;
      },
      'node-pty',
      'build/Release/pty.node',
    );
    assert.equal(got, sentinel);
    assert.equal(requestedId, pkgDir, 'must require the unpacked package dir, not the bare name');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// T126.2 RESOLUTION-CONTRAST (LEAD sharpening, ledger #131): the CORE of #126 is
// RESOLUTION, not ABI. With a module present in BOTH app.asar AND app.asar.unpacked
// (asarUnpack COPIES, does not move), a BARE require silently resolves the
// IN-ARCHIVE copy — "correct only by coincidence". The pinned loader must resolve
// the UNPACKED copy and REFUSE loudly when it is absent, NEVER falling back. This
// proves BOTH sides of the contrast with a two-copy fixture. The "native module"
// is a plain CJS file that reports WHICH copy loaded (the property under test is
// path resolution, not dlopen), so a bare require returning the asar marker IS the
// silent-fallback defect made visible.
test('T126.2 resolution contrast: bare require loads in-asar copy; pinned loader refuses when unpacked gone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-pin-resolution-'));
  try {
    const asarNm = path.join(tmp, 'resources', 'app.asar', 'node_modules');
    const unpackedNm = path.join(tmp, 'resources', 'app.asar.unpacked', 'node_modules');
    const here = path.join(tmp, 'resources', 'app.asar', 'dist-electron');

    const mkmod = (nmRoot: string, marker: string) => {
      const dir = path.join(nmRoot, 'fake-native');
      fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'fake-native', main: 'index.js' }),
      );
      fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { copy: ${JSON.stringify(marker)} };`);
      fs.writeFileSync(path.join(dir, 'build', 'Release', 'fake.node'), 'stub-binary');
      return dir;
    };
    mkmod(asarNm, 'IN_ASAR');
    const unpackedCopy = mkmod(unpackedNm, 'UNPACKED');

    fs.mkdirSync(here, { recursive: true });
    fs.writeFileSync(path.join(here, 'main.js'), '');
    const asarReq = createRequire(path.join(here, 'main.js'));

    // The DEFECT made visible: a bare require resolves the IN-ASAR copy.
    assert.equal((asarReq('fake-native') as { copy: string }).copy, 'IN_ASAR');

    // The FIX: the pinned loader resolves the UNPACKED copy, not the asar one.
    const pinned = requirePinnedNativeFrom<{ copy: string }>(
      here,
      asarReq as (id: string) => unknown,
      'fake-native',
      'build/Release/fake.node',
    );
    assert.equal(pinned.copy, 'UNPACKED');

    // The CONTRAST: delete the unpacked binary. Bare require STILL succeeds off
    // the in-asar copy (silent, wrong); the pinned loader REFUSES loudly.
    fs.rmSync(path.join(unpackedCopy, 'build', 'Release', 'fake.node'), { force: true });
    assert.equal(
      (asarReq('fake-native') as { copy: string }).copy,
      'IN_ASAR',
      'bare require should still silently load the in-asar copy',
    );
    assert.throws(
      () =>
        requirePinnedNativeFrom(
          here,
          asarReq as (id: string) => unknown,
          'fake-native',
          'build/Release/fake.node',
        ),
      /refusing to fall back/,
      'pinned loader must refuse rather than fall back to the in-asar copy',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Non-packaged (dev/test): resolve the bare specifier, untouched.
test('requirePinnedNativeFrom resolves the bare specifier when not packaged', () => {
  let requestedId = '';
  const sentinel = { dev: true };
  const got = requirePinnedNativeFrom(
    '/home/dev/orchestra/src/main',
    (id) => {
      requestedId = id;
      return sentinel;
    },
    'node-pty',
    'build/Release/pty.node',
  );
  assert.equal(got, sentinel);
  assert.equal(requestedId, 'node-pty');
});
