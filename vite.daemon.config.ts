import { defineConfig } from 'vite';
import path from 'node:path';
import { builtinModules } from 'node:module';

// Standalone build for the headless backend (src/main/daemon.ts) and the
// rpc-fixture dump tool (scripts/dump-rpc-fixtures.ts). Both are plain Node
// programs riding the platform seam's headless implementation, so — like the
// CLI build — they get a minimal Node-targeted config instead of the
// electron/renderer pipeline. Outputs land next to main.js/cli.js:
//   dist-electron/daemon.js             (node daemon.js / AppImage daemon)
//   dist-electron/dump-rpc-fixtures.js  (node dump-rpc-fixtures.js)
//
// `electron` stays external ON PURPOSE: nothing in the daemon's import graph
// may reach it (the headless platform is the only implementation bundled), so
// a stray electron import fails loudly at require-time under plain Node
// instead of silently bloating the bundle.
export default defineConfig({
  build: {
    outDir: 'dist-electron',
    emptyOutDir: false, // share the dir with the electron main/preload/cli builds
    target: 'node18',
    minify: false,
    lib: {
      entry: {
        daemon: path.resolve(__dirname, 'src/main/daemon.ts'),
        'dump-rpc-fixtures': path.resolve(__dirname, 'scripts/dump-rpc-fixtures.ts'),
      },
      formats: ['cjs'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      // EVERY Node built-in external (bare + node: prefix — a missed bare
      // import, e.g. ws's `require('stream')`, otherwise gets replaced by
      // vite's empty browser shim and crashes at runtime; see
      // vite.cli.config.ts), native/heavy deps external exactly as the main
      // build does, plus electron itself (see header). `ws` and `shell-env`
      // are pure JS and bundle fine.
      external: [
        /^node:/,
        ...builtinModules,
        'electron',
        'node-pty',
        'simple-git',
        'bufferutil',
        'utf-8-validate',
      ],
    },
  },
  // Force Node resolution so built-ins resolve to the real modules instead of
  // vite's browser polyfills/stubs.
  resolve: {
    conditions: ['node'],
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
