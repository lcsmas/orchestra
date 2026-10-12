// The QR DECODER the phone loads (/jsqr.js) to pair from inside the home-screen app (Lucas 2026-10-12: an iOS home-screen app
// has its own storage, so the Safari pairing never reaches it). jsQR (Apache-2.0) is sent as-is to the phone; the server never runs it.
// Under node (tests) it is read from node_modules; vite.acces-mobile.config.ts replaces this module with the file inlined.
import fs from 'node:fs';
import { createRequire } from 'node:module';

export function jsqrSource(): string {
  return fs.readFileSync(createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js'), 'utf8');
}
