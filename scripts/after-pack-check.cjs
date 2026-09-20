// electron-builder afterPack hook: fail the build if a required bundle is
// missing from the packaged app.
//
// Why this exists: `keeper.js` is produced by its own vite pass
// (`build:keeper`), separate from the main `vite build`. CI's build step used
// to inline `vite build && electron-builder`, skipping that pass — so every
// published AppImage shipped WITHOUT the keeper, and the failure was silent
// until runtime: `installKeeper()` logs a warning and returns, then every
// structured (SDK) session dies with "keeper failed to start … connect ENOENT
// …/keepers/<wsId>.sock" (v0.5.221, user-reported).
//
// A missing entry point never fails a compile, a typecheck, or a test — only
// launching the packaged app reveals it. This turns that into a build error.

const path = require('node:path');
const fs = require('node:fs');

// Bundles the app cannot function without, each with the symptom you'd chase
// if it silently went missing.
const REQUIRED = [
  ['dist-electron/main.js', 'Electron main process'],
  ['dist-electron/preload.js', 'preload bridge'],
  ['dist-electron/cli.js', 'bundled `orchestra` CLI'],
  ['dist-electron/keeper.js', 'detached session keeper (structured SDK sessions)'],
];

// EXPECTED NATIVE MANIFEST (#126) — every .node this app may ship, keyed by its
// path relative to app.asar.unpacked/node_modules. Exported so
// verify-native-manifest.mjs can drive the add/remove must-FAIL arms without a
// full electron-builder run.
//
// TWO CLASSES (review F-MED, MEASURED against v0.5.267 vs v0.5.269):
//   STRICT   — part of the npm package / runtime-load-bearing; MUST be present
//              exactly. A STRICT entry missing = an unpack that stopped working;
//              a shipped .node matching no manifest entry = a new unpinned dep.
//   OPTIONAL — build-INCIDENTAL, ZERO runtime role, NOT stable across build envs
//              (present-OR-absent tolerated). Pinning these strict was the bug:
//              they were ABSENT from v0.5.267 (10 .node) and PRESENT in v0.5.269
//              (12), so an exact-set on them FATALLY FAILS a release whenever the
//              build env reverts or runs on another arch/ABI:
//                - node-pty bin/<platform>-<arch>-<abi>/node-pty.node: an
//                  @electron/rebuild output, NOT in the node-pty npm package,
//                  NEVER loaded (loadNativeModule checks only build/Release,
//                  build/Debug, prebuilds/<platform>-<arch>). Its name embeds
//                  arch+ABI, so it is matched by PATTERN, not a fixed path.
//                - better-sqlite3 build/Release/test_extension.node: a
//                  source-compile artifact, absent if a prebuilt is resolved.
//
// `probe` marks the one binary per module that actually LOADS on this platform
// (Linux) — construct/load-tested. Cross-platform prebuilds are part of the npm
// package (STRICT) but never load here, so enumerated, not probed.
//
// ABI note (measured #126): better-sqlite3 is a RAW V8 addon, NODE_MODULE_VERSION-
// pinned, and DEFERS its native load — only CONSTRUCTING a DB proves the ABI.
// node-pty is N-API (ABI-stable) and loads its native at IMPORT time — a
// successful require IS its proof.
const EXPECTED_NATIVE = [
  // ── STRICT: runtime-load-bearing / npm-package files (exact-set) ───────────
  { rel: 'better-sqlite3/build/Release/better_sqlite3.node', probe: 'better-sqlite3' },
  { rel: 'node-pty/build/Release/pty.node', probe: 'node-pty' },
  { rel: 'node-pty/prebuilds/darwin-arm64/pty.node', probe: null },
  { rel: 'node-pty/prebuilds/darwin-x64/pty.node', probe: null },
  { rel: 'node-pty/prebuilds/win32-arm64/conpty.node', probe: null },
  { rel: 'node-pty/prebuilds/win32-arm64/conpty_console_list.node', probe: null },
  { rel: 'node-pty/prebuilds/win32-arm64/pty.node', probe: null },
  { rel: 'node-pty/prebuilds/win32-x64/conpty.node', probe: null },
  { rel: 'node-pty/prebuilds/win32-x64/conpty_console_list.node', probe: null },
  { rel: 'node-pty/prebuilds/win32-x64/pty.node', probe: null },
];

// OPTIONAL build-incidental .node — present-OR-absent tolerated. `match` is a
// RegExp on the rel path (the bin/ name embeds arch+ABI, so it cannot be a fixed
// string). A shipped .node matching one of these is NEITHER unexpected NOR
// required.
const OPTIONAL_NATIVE = [
  { match: /^node-pty\/bin\/[^/]+\/node-pty\.node$/, what: '@electron/rebuild output (not in npm package, never loaded)' },
  { match: /^better-sqlite3\/build\/Release\/test_extension\.node$/, what: 'better-sqlite3 source-compile artifact' },
];

/** Enumerate every .node under an app.asar.unpacked/node_modules dir, sorted. */
function enumerateShippedNative(unpackedRoot) {
  const shipped = [];
  (function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.node')) shipped.push(path.relative(unpackedRoot, full));
    }
  })(unpackedRoot);
  return shipped.sort();
}

function isOptionalNative(rel, optional = OPTIONAL_NATIVE) {
  return optional.some((o) => o.match.test(rel));
}

/**
 * Diff the shipped .node set against the manifest with two classes:
 *   - STRICT entries (`expected`) must be present exactly.
 *   - OPTIONAL entries (`optional`, matched by RegExp) are tolerated present-or-
 *     absent and never flagged.
 * Returns { unexpected, absent } (sorted). `unexpected` = a shipped .node that is
 * neither a STRICT entry nor an OPTIONAL match (= a new unpinned dep). `absent` =
 * a STRICT entry not shipped (= an unpack that stopped working). Naming both
 * directions makes a mismatch diagnosable (two wrong sets can share a count).
 */
function diffNativeManifest(shipped, expected = EXPECTED_NATIVE, optional = OPTIONAL_NATIVE) {
  const expectedSet = new Set(expected.map((e) => e.rel));
  const shippedSet = new Set(shipped);
  return {
    unexpected: shipped.filter((r) => !expectedSet.has(r) && !isOptionalNative(r, optional)),
    absent: expected.map((e) => e.rel).filter((r) => !shippedSet.has(r)),
  };
}

exports.EXPECTED_NATIVE = EXPECTED_NATIVE;
exports.OPTIONAL_NATIVE = OPTIONAL_NATIVE;
exports.enumerateShippedNative = enumerateShippedNative;
exports.isOptionalNative = isOptionalNative;
exports.diffNativeManifest = diffNativeManifest;

exports.default = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources');
  const asar = path.join(resources, 'app.asar');

  let read;
  if (fs.existsSync(asar)) {
    // @electron/asar ships as an electron-builder dependency (verified
    // resolvable; the bare `asar` name does NOT resolve here). The read API is
    // `extractFile` — there is no readFileSync.
    const { extractFile } = require('@electron/asar');
    read = (rel) => extractFile(asar, rel);
  } else {
    // asar: false — the app ships as a plain directory tree.
    const unpacked = path.join(resources, 'app');
    read = (rel) => fs.readFileSync(path.join(unpacked, rel));
  }

  const missing = [];
  for (const [rel, what] of REQUIRED) {
    let size = 0;
    try {
      size = read(rel).length;
    } catch {
      /* unreadable → missing */
    }
    if (size === 0) missing.push(`  - ${rel} (${what})`);
  }

  if (missing.length > 0) {
    throw new Error(
      `afterPack: required bundle(s) absent from the packaged app:\n${missing.join('\n')}\n\n` +
        'Build via `pnpm run build` (vite → build:cli → build:keeper → electron-builder); ' +
        'running `vite build && electron-builder` alone skips the CLI and keeper passes.'
    );
  }

  console.log(`  • afterPack: verified ${REQUIRED.length} required bundles in the package`);

  // ── Renderer purity: no Node builtins in the browser bundle (#93 fallout) ──
  //
  // WHY. `src/shared/*` is imported by BOTH main and the renderer. A
  // `node:fs/promises` import added to src/shared/inbox-blocks.ts for the #93
  // inbox-append fix therefore landed in the RENDERER bundle, where Vite emitted
  // a bare `require(...)`. The renderer has no `require`, so the entry module
  // threw `ReferenceError: require is not defined` at load, React never mounted
  // and v0.5.275 launched to a BLACK WINDOW.
  //
  // It shipped green: tsc passes (the types are real), all unit tests pass (they
  // run under Node, where `require` and `node:fs` both exist), and the bundle
  // builds without warning. ONLY loading the packaged renderer reveals it —
  // exactly the class this hook exists to catch.
  const rendererBundles = [];
  try {
    const indexHtml = read('dist/index.html').toString('utf8');
    for (const m of indexHtml.matchAll(/(?:src|href)="\.\/(assets\/[^"]+\.js)"/g)) {
      rendererBundles.push('dist/' + m[1]);
    }
  } catch {
    throw new Error('afterPack: dist/index.html unreadable — cannot verify renderer purity.');
  }
  if (rendererBundles.length === 0) {
    throw new Error(
      'afterPack: dist/index.html referenced NO entry script — the purity scan would ' +
        'pass vacuously. Check the Vite HTML output.'
    );
  }
  const impure = [];
  for (const rel of rendererBundles) {
    let code = '';
    try {
      code = read(rel).toString('utf8');
    } catch {
      throw new Error(`afterPack: renderer entry ${rel} is referenced by index.html but unreadable.`);
    }
    // A bare `require(` or a literal `node:`-prefixed specifier in the browser
    // bundle is the tell. Vite emits `const X=require,Y=X("fs/promises")` for a
    // leaked builtin, so match the aliasing form too.
    const hits = [];
    if (/[^.\w]require\s*\(/.test(code)) hits.push('a bare require(...) call');
    if (/=\s*require\s*[,;)]/.test(code)) hits.push('an aliased `= require` reference');
    if (/["'`]node:[a-z_/]+["'`]/.test(code)) hits.push('a literal "node:*" specifier');
    if (hits.length > 0) impure.push(`  - ${rel}: ${hits.join(', ')}`);
  }
  if (impure.length > 0) {
    throw new Error(
      'afterPack: Node-only code leaked into the RENDERER bundle — the packaged app ' +
        'will boot to a black window (ReferenceError: require is not defined):\n' +
        impure.join('\n') +
        '\n\nUsual cause: a file in src/shared/ imported a `node:*` builtin and a ' +
        'renderer component imports a VALUE from that same file (a type-only import ' +
        'is erased and is safe). Move the Node-only code into src/main/ and import it ' +
        'there — see src/main/inbox-write.ts.'
    );
  }
  console.log(
    `  • afterPack: renderer bundle(s) free of Node builtins (${rendererBundles.length} entry: ` +
      `${rendererBundles.join(', ')})`
  );

  // ── Native modules: EVERY shipped .node, enumerated and pinned (#114, #126) ─
  //
  // A native `.node` cannot be dlopen'd from inside an asar archive, so every
  // native module's binary must be placed in app.asar.unpacked. If that ever
  // silently stops working, main (or a PTY spawn) throws at runtime and the
  // failure is invisible to any compile, typecheck or unit test.
  //
  // #126 GENERALISED the #114 bus-only check: enumerate EVERY unpacked .node and
  // diff against a manifest with two classes — STRICT entries must be present
  // exactly, OPTIONAL build-incidental entries are tolerated present-or-absent
  // (review F-MED: pinning @electron/rebuild + source-compile artifacts strict
  // fatally failed a release whenever the build env varied). The must-FAIL arm is
  // an added or MISSING STRICT .node — a new native dependency, or an unpack that
  // stopped working, that would otherwise fail only on a user's machine. A
  // count-only check is not enough: two wrong sets can share a count, so we name
  // every unexpected/missing path.
  //
  // ABI note (measured #126): better-sqlite3 is a RAW V8 addon, NODE_MODULE_VERSION-
  // pinned (127 node / 130 Electron), and DEFERS its native load — so `require()`
  // is a false green under the wrong ABI and only CONSTRUCTING a DB proves it.
  // node-pty is N-API (ABI-stable) and loads its native at IMPORT time — so a
  // successful require IS its ABI/construct proof. We probe each accordingly,
  // under the packaged Electron binary's own ABI (ELECTRON_RUN_AS_NODE = 130).
  const { execFileSync } = require('node:child_process');
  const electronBin = path.join(context.appOutDir, 'orchestra');
  const unpackedRoot = path.join(resources, 'app.asar.unpacked', 'node_modules');
  const EXPECTED = EXPECTED_NATIVE;

  // ENUMERATE what actually shipped.
  const shipped = enumerateShippedNative(unpackedRoot);

  for (const rel of shipped) console.log(`  • afterPack: native .node unpacked — node_modules/${rel}`);

  // TWO-CLASS DIFF — STRICT exact-set + OPTIONAL tolerated; name both directions
  // so a mismatch is diagnosable. An unexpected .node = a new native dep nobody
  // pinned (and not an OPTIONAL build-incidental match); a missing one = a STRICT
  // entry whose unpack silently stopped working.
  const { unexpected, absent } = diffNativeManifest(shipped, EXPECTED, OPTIONAL_NATIVE);
  const optionalPresent = shipped.filter((r) => isOptionalNative(r, OPTIONAL_NATIVE));
  if (unexpected.length > 0 || absent.length > 0) {
    const parts = [];
    if (unexpected.length)
      parts.push(
        `UNEXPECTED .node (${unexpected.length}) — a native module nobody pinned; add it to ` +
          `EXPECTED_NATIVE (or OPTIONAL_NATIVE if build-incidental) in scripts/after-pack-check.cjs ` +
          `AND to package.json build.asarUnpack, and route its load through native-pin.ts (#126):\n` +
          unexpected.map((r) => `  + node_modules/${r}`).join('\n')
      );
    if (absent.length)
      parts.push(
        `MISSING strict .node (${absent.length}) — expected but not unpacked; the module cannot ` +
          `load at runtime. Check package.json build.asarUnpack still unpacks it:\n` +
          absent.map((r) => `  - node_modules/${r}`).join('\n')
      );
    throw new Error(
      `afterPack: shipped native .node set does not match the manifest ` +
        `(shipped ${shipped.length}, strict ${EXPECTED.length}, optional-present ${optionalPresent.length}):\n` +
        parts.join('\n\n')
    );
  }
  console.log(
    `  • afterPack: native .node manifest OK — ${EXPECTED.length} strict present, ` +
      `${optionalPresent.length} optional build-incidental tolerated (${shipped.length} total)`
  );

  // CONSTRUCT/LOAD each module that loads on this platform, under the packaged
  // Electron binary running as node (ABI 130, the same ABI main uses).
  for (const { rel, probe } of EXPECTED) {
    if (!probe) continue;
    const binding = path.join(unpackedRoot, rel);
    let script;
    if (probe === 'better-sqlite3') {
      // Deferred loader: require() alone is a false green under the wrong ABI, so
      // CONSTRUCT a real DB and read a row back (spike #109 trap).
      const dbLib = path.join(
        path.dirname(path.dirname(path.dirname(binding))),
        'lib',
        'database.js'
      );
      script =
        'const D=require(' + JSON.stringify(dbLib) + ');' +
        'const db=new D(":memory:",{nativeBinding:' + JSON.stringify(binding) + '});' +
        'db.exec("CREATE TABLE t(x)");db.prepare("INSERT INTO t VALUES (?)").run(1);' +
        'if(db.prepare("SELECT x FROM t").get().x!==1)throw new Error("readback");' +
        'console.log("NATIVE_OK better-sqlite3 abi="+process.versions.modules);';
    } else if (probe === 'node-pty') {
      // N-API, loads its native at IMPORT time — requiring the package IS the
      // construct/ABI proof. Require the UNPACKED package dir (same pin as
      // native-pin.ts) and assert the native handle and spawn API are present.
      const pkgDir = path.join(unpackedRoot, 'node-pty');
      script =
        'const pty=require(' + JSON.stringify(pkgDir) + ');' +
        'if(process.platform!=="win32" && !pty.native)throw new Error("native handle absent");' +
        'if(typeof pty.spawn!=="function")throw new Error("spawn missing");' +
        'console.log("NATIVE_OK node-pty abi="+process.versions.modules);';
    }
    let out = '';
    try {
      out = execFileSync(electronBin, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 60000,
      });
    } catch (e) {
      throw new Error(
        `afterPack: the packaged native module '${probe}' (${rel}) could not LOAD/CONSTRUCT ` +
          `under the packaged Electron runtime — wrong ABI or a broken binary.\n` +
          (probe === 'better-sqlite3'
            ? 'Run `pnpm run build:bus-abi` (rebuilds for Electron 33.4.11 = ABI 130) and rebuild.\n'
            : 'Check @electron/rebuild ran for node-pty during the build.\n') +
          String((e.stderr || e.message) || '').split('\n').slice(0, 5).join('\n')
      );
    }
    if (!out.includes('NATIVE_OK')) {
      throw new Error(`afterPack: ${probe} probe produced no NATIVE_OK line (got: ${out.trim()})`);
    }
    console.log(`  • afterPack: native module CONSTRUCTS — ${out.trim().replace('NATIVE_OK ', '')}`);
  }
};
