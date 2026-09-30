#!/usr/bin/env node
// C2 #209 — what does the turn-end getContextUsage() burst SCALE WITH? One session-budget arm per fixture
// profile (C1 harness, fake API, zero tokens). Prints requests after the first reply for each profile.
//   node scripts/hidden-cost/turn-end-scaling.mjs [--json]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBuilt, runSessionArm, detectContainment } from '../session-budget/harness.mjs';
import { HEAVY_PROFILE } from '../session-budget/fixture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROFILES = [
  ['heavy (default)', {}],
  ['memoryFiles=0', { memoryFiles: 0 }],
  ['memoryFiles=25', { memoryFiles: 25 }],
  ['skills=0', { skills: 0 }],
  ['skills=30', { skills: 30 }],
  ['mcpServers=0', { mcpServers: 0 }],
  ['toolsPerServer=5', { toolsPerServer: 5 }],
  ['bare (0 rules, 0 skills, 0 mcp)', { memoryFiles: 0, skills: 0, mcpServers: 0 }],
];
ensureBuilt(REPO);
const containment = detectContainment();
const rows = [];
for (const [label, profile] of PROFILES) {
  const res = await runSessionArm({ repo: REPO, arm: 'scale', profile, containment });
  if (res.error || !res.report) { rows.push({ label, error: res.error }); continue; }
  const r = res.report;
  rows.push({
    label, profile: { ...HEAVY_PROFILE, ...profile },
    before: r.requests.beforeFirstReply, after: r.requests.afterFirstReply,
    void: res.judgement.void,
    voidWhy: res.judgement.verdicts.filter((v) => v.kind === 'instrument' && !v.ok).map((v) => v.id),
    firstModelBytes: r.subject.firstModelRequestBytes, tools: r.subject.firstModelRequestTools,
  });
}
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
else for (const x of rows) console.log(x.error ? `${x.label}: ERROR ${x.error}` : `${x.label.padEnd(34)} after-first-reply count_tokens=${x.after.count_tokens} model=${x.after.model} other=${x.after.other} | before: model=${x.before.model} ct=${x.before.count_tokens} | instrument-void=${x.void}${x.void ? ' ' + x.voidWhy.join(',') : ''}`);
