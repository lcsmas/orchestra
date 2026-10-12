import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Standalone build for the Accès mobile server process (src/acces-mobile/index.ts, #334, ADR 0006) — same shape as
// vite.keeper.config.ts: a plain Node program bundled to one CJS file, copied to $ORCHESTRA_HOME/bin/ at startup by
// src/main/acces-mobile-host.ts and run with ELECTRON_RUN_AS_NODE (never from inside the asar).
export default defineConfig({
  plugins: [
    {
      // The phone's QR decoder ships INSIDE the bundle (no node_modules next to it at runtime): src/acces-mobile/jsqr-src.ts.
      name: 'inline-jsqr',
      load(id) {
        if (!id.endsWith('/src/acces-mobile/jsqr-src.ts')) return null;
        const src = fs.readFileSync(path.resolve(__dirname, 'node_modules/jsqr/dist/jsQR.js'), 'utf8');
        return `export function jsqrSource() { return ${JSON.stringify(src)}; }`;
      },
    },
  ],
  build: {
    outDir: 'dist-electron',
    emptyOutDir: false, // share the dir with the electron main/preload build
    target: 'node18',
    minify: false,
    lib: {
      entry: path.resolve(__dirname, 'src/acces-mobile/index.ts'),
      formats: ['cjs'],
      fileName: () => 'acces-mobile.js',
    },
    rollupOptions: {
      // Node built-ins only — keep them external (bare forms listed alongside node:*, see vite.cli.config.ts).
      external: [/^node:/, 'fs', 'http', 'crypto', 'path', 'process', 'buffer'],
      output: {
        banner: '#!/usr/bin/env node',
      },
    },
  },
  resolve: {
    conditions: ['node'],
  },
});
