/** PROTOTYPE-ONLY vite config — throwaway UI prototypes under
 *  src/renderer/prototypes/. Deliberately separate from vite.config.ts, which
 *  is Electron-coupled (vite-plugin-electron spawns main + preload builds);
 *  a prototype is a plain browser page and must not drag that in. */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer/prototypes/queued-messages'),
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'src/shared') },
  },
  plugins: [react()],
  server: { port: 5199, open: '/?variant=A' },
});
