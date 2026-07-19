#!/usr/bin/env node
// Render the Orchestra brand icon (build/icon.svg — the same source of truth
// the Electron app packages) into the PNG sizes a Linux hicolor icon theme
// wants, for the native GTK app's .desktop entry.
//
// Uses @resvg/resvg-js (pure-Rust rasterizer, no system cairo/rsvg): the box
// this ships from is rootless and has no reliable system rasterizer, and CI
// containers shouldn't need one either. Invoked via `npx` so it needs no
// entry in package.json's dependencies.
//
//   node native/packaging/gen-icons.mjs [outDir]
//
// Writes <outDir>/<size>x<size>/apps/orchestra-gtk.png for each size plus a
// flat <outDir>/orchestra-gtk.png (512px) for electron-builder-style single
// icon consumers. Default outDir: native/packaging/icons.

import { Resvg } from '@resvg/resvg-js';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const svgPath = path.join(repoRoot, 'build', 'icon.svg');
const outDir = process.argv[2] || path.join(here, 'icons');

const SIZES = [16, 32, 48, 64, 128, 256, 512];
const svg = readFileSync(svgPath);

function render(size) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    // Transparent background — the icon's own tile provides its backdrop.
    background: 'rgba(0,0,0,0)',
  });
  return r.render().asPng();
}

// 512px flat icon (single-file consumers) …
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'orchestra-gtk.png'), render(512));

// … and the hicolor size tree for XDG icon installs.
for (const size of SIZES) {
  const dir = path.join(outDir, `${size}x${size}`, 'apps');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'orchestra-gtk.png'), render(size));
}

console.log(`wrote orchestra-gtk icons (${SIZES.join(', ')} + 512 flat) to ${outDir}`);
