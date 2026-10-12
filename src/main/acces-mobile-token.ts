// The Accès mobile pairing token file (#334/#336). Electron-free so node --test drives the REAL file ops: main writes it, the server
// process reads it at EVERY request — a regenerated token therefore refuses the old one at once, with no message to the server.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function tokenFileIn(dir: string): string {
  return path.join(dir, 'token');
}

/** The current token, or null when none was ever generated. */
export function readTokenIn(dir: string): string | null {
  try {
    const t = fs.readFileSync(tokenFileIn(dir), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Write a fresh 256-bit token atomically, 0600 in a 0700 dir; the previous one is gone the moment the rename lands. */
export function writeFreshTokenIn(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const token = crypto.randomBytes(32).toString('base64url');
  const tmp = path.join(dir, `.token.${process.pid}.tmp`);
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.renameSync(tmp, tokenFileIn(dir));
  return token;
}
