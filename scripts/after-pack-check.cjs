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

  // ── The fleet bus native binding (#114) ───────────────────────────────────
  //
  // better-sqlite3 is a NATIVE module: a `.node` cannot be dlopen'd from inside
  // an asar archive, so package.json's `asarUnpack` must place it in
  // app.asar.unpacked. If that ever silently stops working, main throws at boot
  // and every launch dies — a failure no compile, typecheck or unit test can see.
  //
  // AND THE CHECK CONSTRUCTS A DATABASE, it does not merely look for the file.
  // Spike #109's headline trap: better-sqlite3 defers loading its binding until
  // the first `new Database()`, so `require()` SUCCEEDS under the WRONG ABI and
  // returns a confident false pass. A build that shipped a node-ABI (127) binary
  // instead of the Electron-ABI (130) one would pass a presence check and a
  // require check, and fail only on the user's machine. So: find it, then RUN it
  // under Electron's own ABI.
  const unpackedGlobDir = path.join(resources, 'app.asar.unpacked', 'node_modules');
  const found = [];
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
      else if (e.name === 'better_sqlite3.node') found.push(full);
    }
  })(unpackedGlobDir);

  // Print every path found, unconditionally. A count assertion whose inputs are
  // invisible is hard to diagnose when it fires.
  for (const f of found) console.log(`  • afterPack: bus binding present — ${path.relative(resources, f)}`);

  if (found.length === 0) {
    throw new Error(
      'afterPack: better_sqlite3.node is NOT in app.asar.unpacked — the fleet bus (#114) cannot ' +
        'open at boot, because a native .node cannot be loaded from inside app.asar.\n' +
        "Check package.json build.asarUnpack contains '**/node_modules/better-sqlite3/build/Release/*.node' " +
        "and that vite.config.ts keeps 'better-sqlite3' external."
    );
  }

  // EXACTLY ONE. Probing found[0] while tolerating N was a real gap: the walk
  // order is readdirSync's, not a guarantee, so a package shipping BOTH a
  // 130 and a stray 127 binding would pass whenever the good one happened to
  // come first — and the two-ABI decision (build/bus-abi/ holds an ABI-127 copy
  // for the test suite) is precisely what makes a second binding plausible.
  // Which one main would then load is undefined, so refuse the ambiguity.
  if (found.length > 1) {
    throw new Error(
      `afterPack: ${found.length} better_sqlite3.node files are unpacked, expected exactly 1:\n` +
        found.map((f) => `  - ${path.relative(resources, f)}`).join('\n') +
        '\n\nWhich one the main process loads is resolution-order dependent, and only the ' +
        'Electron-ABI (130) build works. A stray ABI-127 copy (e.g. build/bus-abi/) must not be packaged.'
    );
  }

  // Construct a real DB with this exact binary, under the packaged Electron
  // binary running as node — which is ABI 130, the same ABI main uses.
  const { execFileSync } = require('node:child_process');
  const electronBin = path.join(context.appOutDir, 'orchestra');
  const binding = found[0];
  const probe =
    'const D=require(' +
    JSON.stringify(path.join(path.dirname(path.dirname(path.dirname(binding))), 'lib', 'database.js')) +
    ');' +
    'const db=new D(":memory:",{nativeBinding:' + JSON.stringify(binding) + '});' +
    'db.exec("CREATE TABLE t(x)");db.prepare("INSERT INTO t VALUES (?)").run(1);' +
    'if(db.prepare("SELECT x FROM t").get().x!==1)throw new Error("readback");' +
    'console.log("BUS_ABI_OK abi="+process.versions.modules);';
  let out = '';
  try {
    out = execFileSync(electronBin, ['-e', probe], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 60000,
    });
  } catch (e) {
    throw new Error(
      'afterPack: the packaged better_sqlite3.node could not CONSTRUCT a database under the ' +
        'packaged Electron runtime — the shipped binary is built for the wrong ABI.\n' +
        'Run `pnpm run build:bus-abi` (which rebuilds for Electron 33.4.11 = ABI 130) and rebuild.\n' +
        String((e.stderr || e.message) || '').split('\n').slice(0, 5).join('\n')
    );
  }
  if (!out.includes('BUS_ABI_OK')) {
    throw new Error(`afterPack: bus ABI probe produced no BUS_ABI_OK line (got: ${out.trim()})`);
  }
  console.log(
    `  • afterPack: bus native binding unpacked and CONSTRUCTS a DB — ${out.trim().replace('BUS_ABI_OK ', '')}`
  );
};
