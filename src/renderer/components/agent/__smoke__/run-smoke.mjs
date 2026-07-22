// Bundles smoke-entry.tsx with esbuild (JSX transform) and
// runs it under node, asserting every A3 component mounts without throwing.
// Run: node src/renderer/components/agent/__smoke__/run-smoke.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// esbuild is a transitive (vite) dep under .pnpm, not resolvable by bare name
// here — locate its main entry relative to the repo root.
const repoRoot = resolve(here, '../../../../..');
const esbuildMain = [
  resolve(repoRoot, 'node_modules/esbuild/lib/main.js'),
  resolve(repoRoot, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'),
].find(existsSync);
if (!esbuildMain) {
  console.error('esbuild not found — cannot run smoke harness');
  process.exit(2);
}
const { build } = await import(pathToFileURL(esbuildMain).href);
const entry = resolve(here, 'smoke-entry.tsx');
// Output beside the repo's node_modules so bundled deps resolve; bundle React in
// (nothing external) so the temp module is self-contained.
const outfile = resolve(repoRoot, `av-smoke-${process.pid}.mjs`);

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  // React/react-dom stay external so their CJS internals (require('util')) work
  // — resolved from the repo node_modules since outfile sits in repoRoot.
  packages: 'external',
  logLevel: 'warning',
});

// smoke-entry calls process.exit(1) on failure, which skips a finally block, so
// register the cleanup on exit too.
process.on('exit', () => rmSync(outfile, { force: true }));
await import(pathToFileURL(outfile).href);
rmSync(outfile, { force: true });
