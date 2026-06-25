import { defineConfig } from 'vite';
import path from 'node:path';

// Standalone build for the `orchestra` CLI client (src/cli/index.ts). It is a
// plain Node program (no Electron, no React), so it gets its own minimal vite
// config rather than riding on the electron/renderer build. Output is a single
// CJS file at dist-electron/cli.js with the shebang preserved via the banner so
// the published `bin` is directly runnable.
export default defineConfig({
  build: {
    outDir: 'dist-electron',
    emptyOutDir: false, // share the dir with the electron main/preload build
    target: 'node18',
    minify: false,
    lib: {
      entry: path.resolve(__dirname, 'src/cli/index.ts'),
      formats: ['cjs'],
      fileName: () => 'cli.js',
    },
    rollupOptions: {
      // Node built-ins only — keep them external so they aren't bundled. The
      // source imports them with the `node:` prefix (import x from 'node:http'),
      // so match both that and the bare form; otherwise vite's lib build, which
      // targets the browser by default, replaces them with empty shims (e.g.
      // `const process = {}`) and the CLI crashes at runtime.
      external: [/^node:/, 'http', 'fs', 'os', 'path', 'process', 'buffer'],
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
