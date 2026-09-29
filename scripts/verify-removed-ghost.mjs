// #205 renderer half — drives the REAL src/renderer/store.ts (esbuild-bundled, stub `window.orchestra`
// bridge that captures the push handlers) through: update → removed → STALE update. The row must not
// come back. Prints one JSON line; ok:false on an unfixed store.ts.
//
// Run: node scripts/verify-removed-ghost.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadEsbuild() {
  for (const paths of [repoRoot + '/node_modules/vite', repoRoot + '/node_modules', repoRoot]) {
    try { return require_(require_.resolve('esbuild', { paths: [paths] })); } catch { /* next */ }
  }
  const hit = fs.globSync?.(repoRoot + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
  if (hit.length) return require_(hit[0]);
  throw new Error('esbuild not resolvable — run `pnpm install` first');
}
const { build } = loadEsbuild();

const outfile = path.join(repoRoot, 'node_modules', '.cache', 'removed-ghost-probe.mjs');
await build({
  entryPoints: [path.join(repoRoot, 'src/renderer/store.ts')],
  outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'error',
  loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// Bridge stub: every `on*` subscription is captured by name; every other call is an inert promise.
const handlers = {};
const noop = () => {};
globalThis.window = {
  orchestra: new Proxy({}, {
    get: (_t, name) => (name.startsWith('on')
      ? (cb) => { handlers[name] = cb; return noop; }
      : () => Promise.resolve(undefined)),
  }),
  addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }),
  localStorage: { getItem: () => null, setItem: noop },
  location: { search: '' },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.document = globalThis.document ?? { addEventListener: noop, documentElement: { style: {} }, querySelector: () => null };

const { useStore } = await import(outfile);
const ws = (id, extra = {}) => ({
  id, name: id, kind: 'scratch', repoPath: '', branch: id, worktreePath: `/x/${id}`,
  status: 'idle', createdAt: 1, hasInput: false, ...extra,
});
const ids = () => useStore.getState().workspaces.map((w) => w.id);
const needed = ['onWorkspaceUpdate', 'onWorkspaceRemoved', 'onWorkspacesRemoved'];
const wired = needed.every((n) => typeof handlers[n] === 'function');

const out = { probe: 'removed-ghost', wired };
if (wired) {
  handlers.onWorkspaceUpdate(ws('A'));
  handlers.onWorkspaceUpdate(ws('B'));
  handlers.onWorkspaceUpdate(ws('C'));
  out.before = ids();                                         // control: the update handler really inserts
  handlers.onWorkspaceRemoved('A');                           // single delete
  handlers.onWorkspacesRemoved(['B']);                        // bulk delete
  out.afterRemoved = ids();
  handlers.onWorkspaceUpdate(ws('A', { name: 'stale-ghost' })); // late stale update (the racing writer's broadcast)
  handlers.onWorkspaceUpdate(ws('B', { name: 'stale-ghost' }));
  handlers.onWorkspaceUpdate(ws('C', { name: 'live-update' })); // control: a live id still updates
  handlers.onWorkspaceUpdate(ws('D'));                          // control: a genuinely new id still appends
  out.afterStale = ids();
  out.cName = useStore.getState().workspaces.find((w) => w.id === 'C')?.name;
  out.ok = out.before.join() === 'A,B,C' && out.afterRemoved.join() === 'C' &&
    out.afterStale.join() === 'C,D' && out.cName === 'live-update';
} else out.ok = false;
console.log(JSON.stringify(out));
process.exit(0);
