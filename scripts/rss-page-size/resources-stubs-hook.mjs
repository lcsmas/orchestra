// Resolution hook for the Resources-page sampler arm (#214 finding, review F4): src/main/resources.ts is imported for REAL
// (real /proc parsing, real page size); only its four heavy collaborators are stubbed — the PTY registry, the events dir,
// statfs and the platform metrics — and everything else falls through to the shared R2 hook (`./platform` dir, .ts ext).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R2 = await import(pathToFileURL(path.join(HERE, '..', '.r2-resolve-hook.mjs')).href);
const STUBS = { './pty': 'pty.mjs', './events-spool': 'events-spool.mjs', './disk-space': 'disk-space.mjs', './platform': 'platform.mjs' };

export async function resolve(spec, ctx, next) {
  if (ctx.parentURL?.endsWith('/src/main/resources.ts') && STUBS[spec]) {
    return { url: pathToFileURL(path.join(HERE, 'stubs', STUBS[spec])).href, shortCircuit: true };
  }
  return R2.resolve(spec, ctx, next);
}
