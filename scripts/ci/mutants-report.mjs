#!/usr/bin/env node
// #623 — the verdict of a mutants.yml run: `mutants-report.mjs <result-dir>` prints the markdown body of the ci-mutants issue (failing rigs + the merge commit) and exits 1 when
// any mutant rig is red OR a part reported nothing (a missing result is red, never a silent green). Exit 0 = every mutant rig of every part green.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutantParts, readRigFile } from '../../src/shared/ci-rigs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = process.argv[2];
const file = readRigFile(root);
const want = mutantParts(file, 1)[0];
const results = new Map((fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((r) => r.id).map((r) => [r.id, r]));
const bad = want.flatMap((id) => { const r = results.get(id); return !r ? [`- \`${id}\` — NO RESULT (its job failed before reporting, or was cancelled)`] : r.ok ? [] : [`- \`${id}\` — ${r.why} (run=${r.counts.run} pass=${r.counts.pass} fail=${r.counts.fail})`]; });
const sha = process.env.GITHUB_SHA || 'unknown';
const run = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '(local)';
if (!bad.length) { console.log(`all ${want.length} mutant rigs green at ${sha}`); process.exit(0); }
console.log(`${bad.length} of ${want.length} mutant rig(s) red at \`${sha}\` (${process.env.GITHUB_EVENT_NAME || 'local'}).\n\n${bad.join('\n')}\n\nRun: ${run}\n\nMutant rigs do not block a pull_request (#623); a red one means a rig no longer catches a defect it used to catch, or a flake — rerun the failing job once before digging.`);
process.exit(1);
