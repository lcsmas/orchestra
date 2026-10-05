// PROTOTYPE — throwaway (wayfinder #251, map #243). Never merge.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ root: __dirname, plugins: [react()], server: { host: '127.0.0.1' } });
