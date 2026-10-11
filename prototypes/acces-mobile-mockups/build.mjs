// Generates the static HTML of every screen of every variant (fake data from
// shared/data.mjs). usage: node build.mjs     then: node shoot.mjs
import { readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { page } from './shared/chrome.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const dirs = readdirSync(ROOT).filter((d) => /^v\d/.test(d) && existsSync(join(ROOT, d, 'render.mjs'))).sort();
for (const d of dirs) {
  const mod = await import(pathToFileURL(join(ROOT, d, 'render.mjs')).href);
  for (const f of readdirSync(join(ROOT, d)).filter((x) => /^\d\d-.*\.html$/.test(x))) rmSync(join(ROOT, d, f));
  const screens = mod.screens();
  for (const s of screens) writeFileSync(join(ROOT, d, `${s.file}.html`), page({ title: `${mod.meta.name} — ${s.title}`, cls: mod.meta.cls, body: s.body }));
  console.log(`${d}: ${screens.length} screens`);
}
