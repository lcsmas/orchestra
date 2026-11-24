#!/usr/bin/env node
// #559 — the DEFAULT-rendered verified-fanout skill (SKILL.md + every installed reference) vs the text of tag v0.5.375, as `diff -ru` (exit 0 always; the diff IS the output).
// usage: node --experimental-strip-types scripts/diff-fanout-skill-vs-375.mjs [--tag v0.5.375] [--switches acceptance=on,minorPolicy=spec] [--keep]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const tag = arg('--tag', 'v0.5.375');
const assign = Object.fromEntries((arg('--switches', '') || '').split(',').filter(Boolean).map((p) => p.split('=')));
const work = mkdtempSync(path.join(tmpdir(), 'skill-diff-'));

// the tag's own sources, extracted (its imports resolve inside the extracted tree)
const old = path.join(work, 'src-old'); mkdirSync(old, { recursive: true });
execFileSync('sh', ['-c', `git -C ${JSON.stringify(root)} archive ${JSON.stringify(tag)} src/shared | tar -x -C ${JSON.stringify(old)}`]);

const files = async (shared, render) => {
  const skill = await import(pathToFileURL(path.join(shared, 'verified-fanout-skill.ts')).href);
  const fl = await import(pathToFileURL(path.join(shared, 'verified-fanout-files.ts')).href);
  const out = { 'SKILL.md': render(skill) };
  for (const f of [...fl.VERIFIED_FANOUT_FILES, ...(fl.VERIFIED_FANOUT_V2_REFERENCES ?? [])]) out[f.path] = f.content;
  return { out, skill };
};
const oldSet = await files(path.join(old, 'src/shared'), (s) => s.VERIFIED_FANOUT_SKILL);
{ // a tag that already renders per switch (>= v0.5.378): its references are rendered with ITS OWN defaults, the way its installer writes them
  const rend = path.join(old, 'src/shared/fanout-switch-render.ts');
  if (existsSync(rend)) {
    const { renderSwitchBlocks: oldRender } = await import(pathToFileURL(rend).href);
    const { switchesOf: oldSwitchesOf } = await import(pathToFileURL(path.join(old, 'src/shared/fanout-state.ts')).href);
    const oldSw = oldSwitchesOf({});
    for (const p of Object.keys(oldSet.out)) {
      if (p.endsWith('.md') && p !== 'SKILL.md') oldSet.out[p] = oldRender(oldSet.out[p], oldSw);
      if (!oldSet.skill.verifiedFanoutReferenceWanted(p, oldSw)) delete oldSet.out[p];
    }
  }
}
const newShared = path.join(root, 'src/shared');
const { renderSwitchBlocks } = await import(pathToFileURL(path.join(newShared, 'fanout-switch-render.ts')).href);
const { switchesOf } = await import(pathToFileURL(path.join(newShared, 'fanout-state.ts')).href);
const sw = switchesOf({ switches: assign }); // the default set (+ any --switches) exactly as an install resolves it
const newSet = await files(newShared, (s) => s.renderVerifiedFanoutSkill(sw));
for (const p of Object.keys(newSet.out)) {
  if (p.endsWith('.md') && p !== 'SKILL.md') newSet.out[p] = renderSwitchBlocks(newSet.out[p], sw);
  if (!newSet.skill.verifiedFanoutReferenceWanted(p, sw)) delete newSet.out[p]; // an off feature ships none of its reference
}
for (const [dir, set] of [['a', oldSet.out], ['b', newSet.out]]) for (const [p, c] of Object.entries(set)) { const d = path.join(work, dir, p); mkdirSync(path.dirname(d), { recursive: true }); writeFileSync(d, c); }
console.log(`# default switches: ${JSON.stringify(sw)}\n# a = ${tag}   b = HEAD render`);
const r = spawnSync('diff', ['-ru', 'a', 'b'], { cwd: work, encoding: 'utf8' });
process.stdout.write(r.stdout || '(no difference)\n');
if (!process.argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
