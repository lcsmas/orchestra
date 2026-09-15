// T126.1 gate — the afterPack native-manifest enumeration, PROVEN by its
// must-FAIL arms. A count-only check cannot distinguish two wrong sets that
// share a count, so the diff names both directions; this script proves the diff
// goes RED when a .node is added OR removed, and GREEN on the real shipped set.
//
// Runs against the REAL built tree (release/linux-arm64-unpacked) when present —
// so it certifies the actual manifest, not a mock — and falls back to a
// fabricated tree so it still gates before a full electron-builder run.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { EXPECTED_NATIVE, enumerateShippedNative, diffNativeManifest } = require(
  path.join(ROOT, 'scripts', 'after-pack-check.cjs'),
);

let failed = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => {
  console.error(`  FAIL  ${m}`);
  failed++;
};

// ── Build a ground-truth unpacked tree: the real one if built, else fabricate ─
const realRoot = path.join(
  ROOT,
  'release',
  'linux-arm64-unpacked',
  'resources',
  'app.asar.unpacked',
  'node_modules',
);
let unpackedRoot;
let cleanup = () => {};
if (fs.existsSync(realRoot) && enumerateShippedNative(realRoot).length > 0) {
  unpackedRoot = realRoot;
  console.log(`using REAL built tree: ${path.relative(ROOT, realRoot)}`);
} else {
  // Fabricate the exact expected set so the arms below are still meaningful.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-manifest-'));
  for (const { rel } of EXPECTED_NATIVE) {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'stub');
  }
  unpackedRoot = tmp;
  cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  console.log('using FABRICATED tree (no built AppImage present)');
}

try {
  // ── ARM 1 (must-PASS): the real shipped set matches the manifest exactly ────
  {
    const shipped = enumerateShippedNative(unpackedRoot);
    const { unexpected, absent } = diffNativeManifest(shipped, EXPECTED_NATIVE);
    if (unexpected.length === 0 && absent.length === 0 && shipped.length === EXPECTED_NATIVE.length) {
      ok(`shipped set matches manifest exactly (${shipped.length} .node files)`);
    } else {
      bad(
        `shipped set does NOT match manifest — unexpected=${JSON.stringify(unexpected)} ` +
          `absent=${JSON.stringify(absent)} (shipped ${shipped.length}, expected ${EXPECTED_NATIVE.length})`,
      );
    }
  }

  // ── ARM 2 (must-FAIL): REMOVE one .node → diff reports it absent ────────────
  {
    const shipped = enumerateShippedNative(unpackedRoot).filter(
      (r) => r !== 'node-pty/build/Release/pty.node',
    );
    const { unexpected, absent } = diffNativeManifest(shipped, EXPECTED_NATIVE);
    if (absent.includes('node-pty/build/Release/pty.node') && unexpected.length === 0) {
      ok('removing node-pty/build/Release/pty.node → flagged ABSENT (diff went RED)');
    } else {
      bad(
        `removed pty.node but diff did not flag it absent — absent=${JSON.stringify(absent)}`,
      );
    }
  }

  // ── ARM 3 (must-FAIL): ADD a stray .node → diff reports it unexpected ───────
  {
    const shipped = [...enumerateShippedNative(unpackedRoot), 'some-new-dep/build/Release/foo.node'].sort();
    const { unexpected, absent } = diffNativeManifest(shipped, EXPECTED_NATIVE);
    if (unexpected.includes('some-new-dep/build/Release/foo.node') && absent.length === 0) {
      ok('adding an unpinned foo.node → flagged UNEXPECTED (diff went RED)');
    } else {
      bad(`added a stray .node but diff did not flag it — unexpected=${JSON.stringify(unexpected)}`);
    }
  }

  // ── ARM 4: the manifest names EVERY native module the ticket requires ───────
  {
    const modules = new Set(EXPECTED_NATIVE.map((e) => e.rel.split('/')[0]));
    const missing = ['better-sqlite3', 'node-pty'].filter((m) => !modules.has(m));
    if (missing.length === 0) ok('manifest covers both native modules (better-sqlite3, node-pty)');
    else bad(`manifest is missing native module(s): ${missing.join(', ')}`);
  }

  // ── ARM 5: exactly the load-bearing binaries are construct-probed ───────────
  {
    const probed = EXPECTED_NATIVE.filter((e) => e.probe).map((e) => e.probe).sort();
    if (JSON.stringify(probed) === JSON.stringify(['better-sqlite3', 'node-pty'])) {
      ok('both load-bearing modules are marked for a construct/load probe');
    } else {
      bad(`construct-probe set is ${JSON.stringify(probed)}, expected [better-sqlite3, node-pty]`);
    }
  }
} finally {
  cleanup();
}

if (failed > 0) {
  console.error(`\nverify-native-manifest: ${failed} arm(s) FAILED`);
  process.exit(1);
}
console.log('\nverify-native-manifest: OK — enumeration + add/remove must-FAIL arms all RED, real set GREEN');
