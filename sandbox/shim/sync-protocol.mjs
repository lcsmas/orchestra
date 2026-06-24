// Copy the canonical wire-protocol module into the shim directory.
//
// The shim is built from `sandbox/` as its own self-contained Docker context
// (see sandbox/.dockerignore), so it can't import `src/shared/sandbox-protocol.ts`
// across the repo at image-build time. We instead vendor a copy here. This script
// keeps that copy byte-identical to the source — run it whenever the protocol
// changes; `npm run build` runs it automatically (prebuild). CI can run it with
// `--check` to fail if the vendored copy has drifted from source.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../src/shared/sandbox-protocol.ts');
const DEST = path.join(here, 'sandbox-protocol.ts');

const BANNER =
  '// AUTO-GENERATED — do not edit. Vendored copy of src/shared/sandbox-protocol.ts.\n' +
  '// Regenerate with `node sandbox/shim/sync-protocol.mjs` (or `npm run build` in this dir).\n\n';

const source = BANNER + readFileSync(SRC, 'utf8');

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(DEST, 'utf8');
  } catch {
    /* missing — treated as drift below */
  }
  if (current !== source) {
    console.error(
      'sandbox/shim/sandbox-protocol.ts is out of date with src/shared/sandbox-protocol.ts.\n' +
        'Run: node sandbox/shim/sync-protocol.mjs',
    );
    process.exit(1);
  }
  console.log('shim protocol copy is in sync.');
} else {
  writeFileSync(DEST, source);
  console.log(`synced ${path.relative(process.cwd(), DEST)}`);
}
