// PROTOTYPE — throwaway. A plain browser page (no Electron) that mounts the real agent-view components.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import os from 'node:os';

const repo = path.resolve(__dirname, '../../../../..');

export default defineConfig({
  root: __dirname,
  cacheDir: path.join(os.tmpdir(), 'vite-proto-bloc-html'),
  resolve: { alias: { '@shared': path.join(repo, 'src/shared') } },
  plugins: [react()],
  server: { host: '127.0.0.1', fs: { allow: [repo] } },
});
