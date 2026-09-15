// The ONE place that decides WHERE a native module's `.node` is loaded from in
// a packaged app — generalised from the bus binding (#114) to EVERY native
// module the app ships (#126).
//
// THE TRAP THIS FILE EXISTS FOR. electron-builder's asarUnpack (and its
// implicit "any module containing a .node gets its whole moduleRoot unpacked"
// heuristic, app-builder-lib unpackDetector.js) COPIES a native module out of
// the archive — it does not MOVE it. So a packaged app can carry the same
// `.node` in BOTH `app.asar` and `app.asar.unpacked`. A `.node` cannot be
// dlopen'd from inside an asar, yet an unpinned `require` can resolve the
// in-archive copy anyway via Electron's asar fs shim (documented as
// unsupported) — so today's "it works" is correct only by coincidence, and it
// makes "which binary am I actually running" unanswerable at exactly the moment
// an ABI or resolution problem needs diagnosing. #114 proved this live: renaming
// the unpacked better_sqlite3.node away still booted the bus, off the asar copy.
//
// The fix, applied uniformly: name the UNPACKED path explicitly and load from
// it, refusing to fall back to the in-archive copy.
//
// PER-MODULE ABI NOTE (measured #126, quoted so nobody re-derives it):
//   - better-sqlite3 is a RAW V8 addon: `strings` shows `node_register_module_v127`,
//     no napi symbols. It is NODE_MODULE_VERSION-pinned (127 on node, 130 on
//     Electron 33) — a wrong-ABI binary is a real failure, and it DEFERS its
//     native load until `new Database()`, so `require()` passes a false green
//     under the wrong ABI. Constructing is the only ABI proof (see bus.ts open()).
//   - node-pty@1.1.0 is an N-API addon: `strings` shows `napi_*`/`Napi::`, no
//     `node_register_module_vNNN`. N-API is ABI-stable, so its node-abi(127)
//     binary loads under Electron abi(130) too — there is NO wrong-ABI to refuse.
//     It loads its native at IMPORT time (index.js top-level), not deferred, so
//     a successful import IS the construction proof. What still applies to it is
//     the asar-duplicate pin above.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// This module is consumed TWO ways with different module semantics: bundled to
// CJS in dist-electron/main.js (where `__dirname` exists and `import.meta` does
// not), and loaded as ESM by node's type-stripping test runner (the reverse).
// Resolve the directory under whichever one is actually present.
declare const __dirname: string | undefined;
const HERE: string =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

/** The directory this module resolves from (dist-electron/ bundled, src/main/ under tests). */
export function moduleDir(): string {
  return HERE;
}

/** A require() rooted at this module, so bare specifiers resolve as main does. */
export const pinnedRequire = createRequire(
  typeof __dirname !== 'undefined' ? path.join(HERE, 'index.js') : import.meta.url,
);

/** ABI of the runtime we are executing under: '127' on system node, '130' on Electron. */
export function currentAbi(): string {
  return process.versions.modules;
}

// ── Pure path logic (parameterised on `here` so it is testable without being ──
// ── packaged — the packaged branch is otherwise unreachable from a unit test) ─

/** Whether a given module directory sits inside a packaged app.asar. */
export function isPackagedHere(here: string): boolean {
  return here.includes(`app.asar${path.sep}`) || here.includes('app.asar/');
}

/**
 * The unpacked app root for a module resolving from `here`, or null when `here`
 * is not inside app.asar. `.../app.asar/dist-electron` → `.../app.asar.unpacked`.
 */
export function computeAppRootUnpacked(here: string): string | null {
  if (!isPackagedHere(here)) return null;
  const root = here
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    .replace('app.asar/', 'app.asar.unpacked/');
  // this module sits in dist-electron/ (bundled) → one level up is the app root.
  return path.resolve(root, '..');
}

/** Absolute path to a native module's UNPACKED `.node` given `here`, or null. */
export function computeUnpackedNativePath(
  here: string,
  moduleName: string,
  relFromModuleRoot: string,
): string | null {
  const appRoot = computeAppRootUnpacked(here);
  if (!appRoot) return null;
  return path.join(appRoot, 'node_modules', moduleName, ...relFromModuleRoot.split('/'));
}

/** True when this module is running from inside a packaged app.asar. */
export function isPackaged(): boolean {
  return isPackagedHere(HERE);
}

/**
 * The app root when packaged: `.../resources/app.asar.unpacked`. Returns null
 * when not packaged. Every unpacked native module lives under
 * `<appRootUnpacked>/node_modules/<module>/…`.
 */
export function appRootUnpacked(): string | null {
  return computeAppRootUnpacked(HERE);
}

/**
 * Absolute path to a native module's UNPACKED `.node`, or null when not packaged.
 * `relFromModuleRoot` is the path of the binary INSIDE the module (e.g.
 * `build/Release/better_sqlite3.node`).
 */
export function unpackedNativePath(moduleName: string, relFromModuleRoot: string): string | null {
  return computeUnpackedNativePath(HERE, moduleName, relFromModuleRoot);
}

/**
 * Load a native module by requiring it from its UNPACKED location when packaged,
 * refusing the in-archive copy. When NOT packaged, resolves the bare specifier
 * (dev/test node_modules). `probeRelPath` names a `.node` that MUST exist unpacked
 * for the module to be usable — its absence is FATAL and diagnosable.
 *
 * This is for modules that load their native at import time (node-pty). A module
 * that DEFERS its native load (better-sqlite3) must additionally CONSTRUCT to
 * prove the ABI — see loadDatabaseCtor in bus-binding.ts, which composes this
 * file's helpers.
 */
export function requirePinnedNative<T = unknown>(moduleName: string, probeRelPath: string): T {
  return requirePinnedNativeFrom<T>(HERE, pinnedRequire, moduleName, probeRelPath);
}

/**
 * Testable core of {@link requirePinnedNative}: parameterised on the module dir
 * `here` and the `require` used, so a unit test can drive the packaged branch
 * (unreachable otherwise) and assert the refusal message and the resolved dir.
 */
export function requirePinnedNativeFrom<T = unknown>(
  here: string,
  req: (id: string) => unknown,
  moduleName: string,
  probeRelPath: string,
): T {
  if (isPackagedHere(here)) {
    const appRoot = computeAppRootUnpacked(here);
    const pkgDir = appRoot ? path.join(appRoot, 'node_modules', moduleName) : null;
    const probe = computeUnpackedNativePath(here, moduleName, probeRelPath);
    if (!pkgDir || !fs.existsSync(pkgDir) || !probe || !fs.existsSync(probe)) {
      throw new Error(
        `native-pin: the unpacked native module '${moduleName}' is missing ` +
          `(package dir ${pkgDir ?? '<unresolved>'}, binary ${probe ?? '<unresolved>'}) — ` +
          'refusing to fall back to the copy inside app.asar (a .node cannot be dlopen\'d from ' +
          'an asar; loading one hides which binary is actually in use). Check package.json ' +
          `build.asarUnpack still unpacks '**/node_modules/${moduleName}/**/*.node'.`,
      );
    }
    // Require the module BY its unpacked package dir, so its own internal
    // relative `require('../build/Release/…')` resolves the unpacked copy, not
    // the in-asar one. Requiring node_modules/<mod> resolves its package "main".
    return req(pkgDir) as T;
  }
  return req(moduleName) as T;
}
