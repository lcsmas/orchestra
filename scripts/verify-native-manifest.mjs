// T126.1 gate — the afterPack native-manifest diff, PROVEN by its must-FAIL arms.
// A count-only check cannot distinguish two wrong sets sharing a count, so the
// diff names both directions; this script proves it goes RED when a STRICT
// (load-bearing) .node is removed OR an unpinned one is added, GREEN on the real
// shipped set, AND — review F-MED — that build-INCIDENTAL files being absent or
// present does NOT fail the gate (they are OPTIONAL, present-or-absent).
//
// Runs against the REAL built tree (release/linux-arm64-unpacked) when present —
// so it certifies the actual manifest — and falls back to a fabricated tree so
// it still gates before a full electron-builder run.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { EXPECTED_NATIVE, OPTIONAL_NATIVE, enumerateShippedNative, diffNativeManifest, isOptionalNative } =
  require(path.join(ROOT, 'scripts', 'after-pack-check.cjs'));

let failed = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => {
  console.error(`  FAIL  ${m}`);
  failed++;
};

const STRICT_LOAD_BEARING = 'node-pty/build/Release/pty.node';
const OPTIONAL_SAMPLES = [
  'node-pty/bin/linux-arm64-130/node-pty.node',
  'better-sqlite3/build/Release/test_extension.node',
];

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
  // Fabricate the STRICT set + the optional samples so the arms are meaningful.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-manifest-'));
  for (const { rel } of EXPECTED_NATIVE) {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'stub');
  }
  for (const rel of OPTIONAL_SAMPLES) {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'stub');
  }
  unpackedRoot = tmp;
  cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  console.log('using FABRICATED tree (no built AppImage present)');
}

const clean = () => diffNativeManifest(enumerateShippedNative(unpackedRoot), EXPECTED_NATIVE, OPTIONAL_NATIVE);

try {
  // ── ARM 1 (must-PASS): the real shipped set matches (strict exact + optional) ─
  {
    const shipped = enumerateShippedNative(unpackedRoot);
    const { unexpected, absent } = diffNativeManifest(shipped, EXPECTED_NATIVE, OPTIONAL_NATIVE);
    if (unexpected.length === 0 && absent.length === 0) {
      ok(`shipped set matches manifest (${shipped.length} .node, ${EXPECTED_NATIVE.length} strict + optionals)`);
    } else {
      bad(`shipped set mismatch — unexpected=${JSON.stringify(unexpected)} absent=${JSON.stringify(absent)}`);
    }
  }

  // ── ARM 2 (must-FAIL): REMOVE a STRICT load-bearing .node → flagged absent ──
  {
    const shipped = enumerateShippedNative(unpackedRoot).filter((r) => r !== STRICT_LOAD_BEARING);
    const { unexpected, absent } = diffNativeManifest(shipped, EXPECTED_NATIVE, OPTIONAL_NATIVE);
    if (absent.includes(STRICT_LOAD_BEARING) && unexpected.length === 0) {
      ok(`removing STRICT ${STRICT_LOAD_BEARING} → flagged ABSENT (RED)`);
    } else {
      bad(`removed a strict binary but diff did not flag it — absent=${JSON.stringify(absent)}`);
    }
  }

  // ── ARM 3 (must-FAIL): ADD an unpinned stray .node → flagged unexpected ─────
  {
    const shipped = [...enumerateShippedNative(unpackedRoot), 'some-new-dep/build/Release/foo.node'].sort();
    const { unexpected, absent } = diffNativeManifest(shipped, EXPECTED_NATIVE, OPTIONAL_NATIVE);
    if (unexpected.includes('some-new-dep/build/Release/foo.node') && absent.length === 0) {
      ok('adding an unpinned foo.node → flagged UNEXPECTED (RED)');
    } else {
      bad(`added a stray .node but diff did not flag it — unexpected=${JSON.stringify(unexpected)}`);
    }
  }

  // ── ARM 4 (F-MED, must-PASS): a v0.5.267-style tree MISSING BOTH build- ─────
  //    incidental .node still PASSES (they are OPTIONAL, present-or-absent). This
  //    is the exact false-positive the reviewer measured against 267 (10 .node).
  {
    const shipped = enumerateShippedNative(unpackedRoot).filter((r) => !isOptionalNative(r, OPTIONAL_NATIVE));
    const { unexpected, absent } = diffNativeManifest(shipped, EXPECTED_NATIVE, OPTIONAL_NATIVE);
    if (unexpected.length === 0 && absent.length === 0) {
      ok('267-style tree (both build-incidental .node ABSENT) → PASSES (no false positive)');
    } else {
      bad(`267-style tree wrongly failed — unexpected=${JSON.stringify(unexpected)} absent=${JSON.stringify(absent)}`);
    }
  }

  // ── ARM 5 (must-PASS): an optional present under a DIFFERENT arch/abi name ──
  //    (the bin/<platform>-<arch>-<abi>/ pattern) is tolerated, not unexpected.
  {
    const shipped = [
      ...enumerateShippedNative(unpackedRoot).filter((r) => !isOptionalNative(r, OPTIONAL_NATIVE)),
      'node-pty/bin/linux-x64-115/node-pty.node', // a DIFFERENT arch+abi than we built
    ].sort();
    const { unexpected, absent } = diffNativeManifest(shipped, EXPECTED_NATIVE, OPTIONAL_NATIVE);
    if (unexpected.length === 0 && absent.length === 0) {
      ok('a bin/<other-arch-abi>/node-pty.node → tolerated by PATTERN (not unexpected)');
    } else {
      bad(`optional pattern not tolerated — unexpected=${JSON.stringify(unexpected)}`);
    }
  }

  // ── ARM 6: manifest names EVERY native module the ticket requires ───────────
  {
    const modules = new Set(EXPECTED_NATIVE.map((e) => e.rel.split('/')[0]));
    const missing = ['better-sqlite3', 'node-pty'].filter((m) => !modules.has(m));
    if (missing.length === 0) ok('manifest covers both native modules (better-sqlite3, node-pty)');
    else bad(`manifest is missing native module(s): ${missing.join(', ')}`);
  }

  // ── ARM 7: exactly the load-bearing binaries are construct-probed ───────────
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
console.log(
  '\nverify-native-manifest: OK — strict exact-set RED on add/remove; 267-style (optionals absent) GREEN',
);
