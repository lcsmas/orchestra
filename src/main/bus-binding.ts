// Which better-sqlite3 native binding to load, and the ONE place that decides.
//
// THE TRAP THIS FILE EXISTS FOR (spike #109's headline finding, reproduced live
// while implementing #114): better-sqlite3 defers loading its `.node` until the
// first `new Database()`. So `require('better-sqlite3')` SUCCEEDS under the
// WRONG ABI and returns a plausible false pass. Any ABI check — build gate,
// preflight, or test — must CONSTRUCT a database. Measured here:
//   node   -e "require('better-sqlite3')"                  → prints OK
//   node   -e "new (require('better-sqlite3'))(':memory:')" → NODE_MODULE_VERSION 130 … requires 127
//   ELECTRON_RUN_AS_NODE=1 electron -e "…new Database…"     → abi 130, construct OK
//
// WHY TWO BUILDS EXIST IN A TREE THAT SHIPS ONE. node and Electron have
// different ABIs (127 vs 130 for electron 33.4.11) and a `.node` built for one
// is unusable under the other. The AppImage ships ONLY the ABI-130 build — main
// and the packaged CLI both run it, because ELECTRON_RUN_AS_NODE is also 130
// (spike condition 5). The ABI-127 build is a DEV/TEST artifact: `pnpm run test`
// runs on system node, and without it the bus unit tests could not construct a
// real database at all (Electron-as-node cannot host the suite — it bundles node
// 20.18.3, which has no --experimental-strip-types).
//
// `scripts/build-bus-abi.mjs` produces both into build/bus-abi/ (gitignored).

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

const require_ = createRequire(
  typeof __dirname !== 'undefined' ? path.join(HERE, 'index.js') : import.meta.url,
);

/** ABI of the runtime we are executing under: '127' on system node, '130' on Electron. */
export function currentAbi(): string {
  return process.versions.modules;
}

/**
 * Absolute path to a per-ABI binding built by scripts/build-bus-abi.mjs, or null
 * when none exists for this runtime (the packaged app: it ships the binding in
 * node_modules at the right ABI already, so no override is wanted).
 */
export function abiBindingPath(): string | null {
  // dist-electron/main.js sits one level under the app root; this module's
  // source sits two (src/main/). Probe both so the same code works from the
  // TypeScript source (tests) and from the bundle.
  const roots = [
    path.resolve(HERE, '..', '..'),
    path.resolve(HERE, '..'),
    process.cwd(),
  ];
  for (const root of roots) {
    const p = path.join(root, 'build', 'bus-abi', `better_sqlite3-abi${currentAbi()}.node`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

type DatabaseCtor = new (file: string, opts?: Record<string, unknown>) => unknown;

/**
 * The better-sqlite3 Database constructor, bound to the binding that matches
 * this runtime's ABI.
 *
 * Note this only RESOLVES the module — it deliberately does not construct
 * anything, because constructing is the caller's gate (see bus.ts `open()`).
 */
export function loadDatabaseCtor(): DatabaseCtor {
  const Base = require_('better-sqlite3') as DatabaseCtor;
  const binding = abiBindingPath();
  if (!binding) return Base;
  // Hand the wrapper our per-ABI binding instead of letting `bindings` resolve
  // whatever is in node_modules. Never mutate the installed copy: the suite and
  // an Electron process can run concurrently under different ABIs.
  const Bound = function (this: unknown, file: string, opts?: Record<string, unknown>) {
    return new Base(file, { ...(opts ?? {}), nativeBinding: binding });
  } as unknown as DatabaseCtor;
  Bound.prototype = Base.prototype;
  return Bound;
}
