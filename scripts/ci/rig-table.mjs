#!/usr/bin/env node
// #568 — the classification table, rendered from .github/ci-rigs.json (the ONE source): `node --experimental-strip-types scripts/ci/rig-table.mjs [--local-only]`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRigFile } from '../../src/shared/ci-rigs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rigs = readRigFile(root).rigs;
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const only = process.argv.includes('--local-only');
const ci = rigs.filter((r) => r.class === 'RUNS_IN_CI');
const local = rigs.filter((r) => r.class === 'LOCAL_ONLY');
const out = [];
if (!only) {
  out.push(`### RUNS_IN_CI (${ci.length})`, '', '| rig | wall (s) | command |', '|---|---|---|', ...ci.map((r) => `| \`${r.id}\` | ${r.wallSec ?? ''} | \`${esc(r.command)}\` |`), '');
}
out.push(`### LOCAL_ONLY (${local.length})`, '', '| rig | reason seen on the runner | command |', '|---|---|---|', ...local.map((r) => `| \`${r.id}\` | ${esc(r.reason)} | \`${esc(r.command)}\` |`));
console.log(out.join('\n'));
