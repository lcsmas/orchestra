import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'src/main/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            lib: {
              entry: 'src/main/index.ts',
              formats: ['cjs'],
              fileName: () => 'main.js',
            },
            rollupOptions: {
              // `bufferutil` / `utf-8-validate` are OPTIONAL native speedups for
              // `ws`; it works without them (pure-JS fallback). They aren't
              // installed, so externalize them rather than letting rollup fail
              // trying to bundle them. `ws` itself is pure JS and bundles fine.
              external: [
                'electron',
                'node-pty',
                'simple-git',
                'bufferutil',
                'utf-8-validate',
              ],
            },
          },
        },
      },
      preload: {
        input: 'src/preload/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
              output: {
                entryFileNames: 'preload.js',
                format: 'cjs',
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: 'dist',
  },
});
