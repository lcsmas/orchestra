import { defineConfig } from 'vite';
import path from 'node:path';
import { builtinModules } from 'node:module';

// The session-budget RUNNER as one CJS file (C4 #211) — dist-electron/session-budget.js, shipped in the
// packaged app so it can re-run the suite when the installed `claude` changes (no src/ tree there, and Electron
// 33's Node 20 has no --experimental-strip-types). Same externals as the main build (they resolve from
// app.asar/node_modules when the file runs in place); `electron` is aliased to the headless stub the source
// runner's resolve hook already uses — the runner drives the real agent-sdk session path with no window.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      electron: path.resolve(__dirname, 'scripts/.r2-electron-stub.mjs'),
    },
    conditions: ['node'],
  },
  build: {
    outDir: 'dist-electron',
    emptyOutDir: false, // shared with the main / preload / cli / keeper builds
    target: 'node20',
    minify: false,
    lib: {
      entry: path.resolve(__dirname, 'scripts/session-budget/bundle-entry.mjs'),
      formats: ['cjs'],
      fileName: () => 'session-budget.js',
    },
    rollupOptions: {
      external: [
        /^node:/,
        ...builtinModules,
        'node-pty',
        'better-sqlite3',
        'simple-git',
        '@anthropic-ai/claude-agent-sdk',
        'bufferutil',
        'utf-8-validate',
      ],
      output: { banner: '#!/usr/bin/env node' },
    },
  },
});
