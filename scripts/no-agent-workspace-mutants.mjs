#!/usr/bin/env node
// #612 — mutants of the no-agent workspace: each patches ONE decision in a COPY of the built bundles, runs the whole built-app rig on the copy, and requires the clause(s) that pin that
// decision to go RED (and the copy to differ from the original). The unmutated rig is the baseline (scripts/e2e-no-agent-workspace.sh <app-dir> must be 100% green first).
// Usage: node scripts/no-agent-workspace-mutants.mjs <app-dir> [--only <name>[,<name>]] [--base <dir>]     (build first: pnpm run build:bundles && pnpm run build:bus-abi)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotApp } from './lib-app-snapshot.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP = fs.realpathSync(argv[0] ?? '');
const only = flag('--only', '')?.split(',').filter(Boolean);
const BASE = flag('--base', path.join(os.homedir(), '.cache', 'e2e-no-agent-612'));
const HERE = path.dirname(new URL(import.meta.url).pathname);

/** Each: where the text lives (`chunk` = the main-process chunk main.js requires; `cli` = dist-electron/cli.js), the exact text, its replacement, and the clauses that must fail. */
const MUTANTS = [
  { name: 'no-key-registered', why: 'the host stops registering the command\'s session key → /identity cannot vouch it (C1)', file: 'chunk', from: /\b\w+\.registerKey\(\w+,\w+\)/, to: '0', red: ['c1/command-vouched-by-identity'] },
  { name: 'agent-skip-removed', why: 'a no-agent workspace is no longer refused by the start funnels / wake roster (C2)', file: 'chunk', from: /(\((\w+)==null\?void 0:\2\.noAgent\))===!0\?/, to: '$1===!1?', red: ['c2/zero-agent-turns'] },
  { name: 'pause-not-read', why: 'deliver / open / gate stop reading the run\'s Pause (C5)', file: 'cli', from: '  if (!text) return null;\n  const r = pausedVerbResult', to: '  return null;\n  const r = pausedVerbResult', red: ['c5/paused/open-refused', 'c5/paused/gate-refused', 'c5/paused/deliver-refused'] },
  { name: 'merged-open-to-all', why: '`state set --status merged` loses its caller check', file: 'cli', from: '      if (refused) throw new SeatRefusal(refused.name, refused.detail);\n    }\n    const repo = before', to: '    }\n    const repo = before', red: ['caller/stranger-merged-refused-state-unchanged', 'caller/stranger-merged-via-json-refused'] },
  { name: 'live-command-re-keyed', why: 'a start of an already-live command mints a new key (it would supersede the running command)', file: 'chunk', from: /if\((\w+)&&(\w+)\(\1\)\)return\{ok:!0,pid:\1\.pid,reused:!0/, to: 'if(!1)return{ok:!0,pid:$1.pid,reused:!0', red: ['c3/term/start-again-is-idempotent-never-re-keys-a-live-command'] },
  { name: 'not-detached', why: 'the command stays in the app\'s process group (no setsid) → dies with it', file: 'chunk', from: /(env:\w+,)detached:!0(,stdio:\["ignore",)/, to: '$1detached:!1$2', red: ['c3/kill9/command-survives'] },
  { name: 'display-not-checked', why: 'the CLI stops naming a missing display', file: 'cli', from: 'const nd = noAgent ? noDisplayRefusal(process$1.env) : null;', to: 'const nd = null;', red: ['display/app-down-no-display-clear-refusal'] },
];

const results = [];
for (const m of MUTANTS) {
  if (only?.length && !only.includes(m.name)) continue;
  const dir = path.join(BASE, `mut-${m.name}`);
  snapshotApp(APP, dir); // a private copy (incl. build/bus-abi): the mutant patches ITS bundles; a sibling's rebuild / ABI flip cannot reach it
  fs.writeFileSync(path.join(dir, '.na-snapshot'), '');
  const chunk = /require\("\.\/(index-[^"]+\.js)"\)/.exec(fs.readFileSync(path.join(dir, 'dist-electron/main.js'), 'utf8'))?.[1];
  const target = path.join(dir, 'dist-electron', m.file === 'cli' ? 'cli.js' : chunk ?? 'MISSING');
  const src = fs.readFileSync(target, 'utf8');
  const hits = m.from instanceof RegExp ? (src.match(new RegExp(m.from.source, 'g')) ?? []).length : src.split(m.from).length - 1;
  if (hits !== 1) { results.push({ name: m.name, verdict: `STALE (pattern found ${hits}× in ${path.basename(target)} — the mutant would not mutate; fix the pattern)` }); console.log(`MUTANT ${m.name}: STALE pattern (${hits} hits)`); continue; }
  fs.writeFileSync(target, m.from instanceof RegExp ? src.replace(m.from, m.to) : src.replace(m.from, () => m.to));
  const differs = fs.readFileSync(target, 'utf8') !== src;
  console.log(`MUTANT ${m.name}: ${m.why} — patched ${path.basename(target)}; running the rig on ${dir}`);
  const r = spawnSync(path.join(HERE, 'e2e-no-agent-workspace.sh'), [dir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env } });
  const out = `${r.stdout}\n${r.stderr}`;
  const red = [...out.matchAll(/^\s+FAIL\s+(\S+)/gm)].map((x) => x[1]);
  const summary = /(\d+)\/(\d+) clauses PASS/.exec(out)?.[0] ?? (/DRIVE ERROR/.test(out) ? 'drive stopped at the first unjudgeable step (DRIVE ERROR after the red clause)' : 'NO SUMMARY (the rig did not finish)');
  const expectedRed = m.red.every((c) => red.includes(c));
  results.push({ name: m.name, verdict: differs && expectedRed ? 'KILLED' : 'SURVIVED', red, summary, expected: m.red });
  console.log(`  → ${differs && expectedRed ? 'KILLED' : 'SURVIVED'}: red clauses [${red.join(', ')}] (expected ⊇ [${m.red.join(', ')}]); ${summary}`);
  fs.writeFileSync(path.join(BASE, `mut-${m.name}.log`), out);
}
console.log('\n=== MUTANTS ===');
for (const r of results) console.log(`${r.verdict.startsWith('KILLED') ? 'KILLED  ' : 'NOT-KILLED'} ${r.name}${r.verdict.startsWith('KILLED') ? '' : ` — ${r.verdict}`}`);
process.exit(results.every((r) => r.verdict === 'KILLED') ? 0 : 1);
