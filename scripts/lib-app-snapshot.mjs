#!/usr/bin/env node
// #612 rig — a PRIVATE snapshot of the built app (package.json, dist, dist-electron, build/ = both better-sqlite3 ABI bindings; node_modules symlinked) so a rig that runs for hours is
// immune to a sibling `pnpm test` / `build:bus-abi` / rebuild flipping the shared tree under it (ABI flips make every bus verb fail; a rebuild swaps the chunks the app reloads at a relaunch).
// Usage: node scripts/lib-app-snapshot.mjs <app-dir> <dest-dir>   → prints <dest-dir>. Also: import { snapshotApp }.
import fs from 'node:fs';
import path from 'node:path';

export function snapshotApp(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(src, 'package.json'), path.join(dest, 'package.json'));
  for (const d of ['dist', 'dist-electron', 'build']) fs.cpSync(path.join(src, d), path.join(dest, d), { recursive: true });
  fs.symlinkSync(path.join(src, 'node_modules'), path.join(dest, 'node_modules'));
  return dest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) { console.error('usage: lib-app-snapshot.mjs <app-dir> <dest-dir>'); process.exit(2); }
  process.stdout.write(`${snapshotApp(fs.realpathSync(src), path.resolve(dest))}\n`);
}
