import { defineConfig } from 'vite';
import path from 'node:path';

// Standalone build for the detached session keeper (src/keeper/index.ts) —
// same shape as vite.cli.config.ts: a plain Node program bundled to a single
// CJS file. The output is COPIED OUT of the install dir to
// $ORCHESTRA_HOME/bin/keeper.js at app startup (src/main/keeper-client.ts) so
// a running keeper never depends on the app install (asar, AppImage FUSE
// mount) staying around after quit.
export default defineConfig({
  build: {
    outDir: 'dist-electron',
    emptyOutDir: false, // share the dir with the electron main/preload build
    target: 'node18',
    minify: false,
    lib: {
      entry: path.resolve(__dirname, 'src/keeper/index.ts'),
      formats: ['cjs'],
      fileName: () => 'keeper.js',
    },
    rollupOptions: {
      // Node built-ins only — keep them external (see vite.cli.config.ts for
      // why the bare forms must be listed alongside node:*).
      external: [/^node:/, 'net', 'fs', 'os', 'path', 'process', 'buffer', 'child_process'],
      output: {
        banner: '#!/usr/bin/env node',
      },
    },
  },
  // Force Node resolution so built-ins resolve to the real modules instead of
  // vite's browser polyfills/stubs.
  resolve: {
    conditions: ['node'],
  },
});
