// Module-resolution hook for the R1/R2 reproduction harnesses.
//
// src/main/agent-sdk.ts cannot be imported by plain node for three reasons that
// are all bundler-only concerns, none of which touch the logic under test:
//   1. `./platform` is a DIRECTORY import (vite resolves it; node does not);
//   2. relative imports are extensionless;
//   3. `electron` and `transport/local-pty` are not loadable here — the latter
//      uses a TS parameter property that strip-only mode refuses to parse.
// This hook redirects exactly those, so the harnesses drive the REAL modules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function resolve(spec, ctx, next) {
  if (spec === 'electron')
    return { url: pathToFileURL(path.join(HERE, '.r2-electron-stub.mjs')).href, shortCircuit: true };
  if (spec.includes('transport/local-pty'))
    return { url: pathToFileURL(path.join(HERE, '.r2-localpty-stub.mjs')).href, shortCircuit: true };
  if (spec.startsWith('.') && ctx.parentURL?.startsWith('file:')) {
    const base = path.dirname(fileURLToPath(ctx.parentURL));
    const abs = path.resolve(base, spec);
    for (const cand of [abs, abs + '.ts', path.join(abs, 'index.ts')]) {
      try { if (fs.statSync(cand).isFile()) return { url: pathToFileURL(cand).href, shortCircuit: true }; } catch { /* next */ }
    }
  }
  return next(spec, ctx);
}
