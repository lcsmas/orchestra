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
};
