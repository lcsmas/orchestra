#!/usr/bin/env node
// Measure the real process-tree numbers the #210 budgets are chosen from (D7: sequential, zero tokens).
//   node scripts/session-budget/measure-procs.mjs [--runs 8] [--arm normal] [--profile '{"mcpServers":4}']
// Prints one line per run (children by kind, total, RSS at first reply / settled end, delete timing when the
// arm deletes) and min/median/max — so a budget number is a printed spread, never a guess.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureBuilt, runSessionArm, detectContainment } from './harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const RUNS = Number(opt('runs', '8'));
const ARM = opt('arm', 'normal');
const teardown = opt('teardown', 'manual');
const profile = JSON.parse(opt('profile', '{}'));
const mutant = opt('mutant', null);

const avail = () => Number((fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/) ?? [])[1] ?? 0) / 1048576;
const load = () => Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
if (avail() < 4 || load() > 20) { console.error(`REFUSED (D7): MemAvailable=${avail().toFixed(1)} GB load=${load()}`); process.exit(2); }

ensureBuilt(REPO);
const containment = detectContainment();
const rows = [];
for (let i = 0; i < RUNS; i++) {
  const l0 = load();
  const res = await runSessionArm({ repo: REPO, arm: ARM, mutant, profile, containment, teardown });
  if (res.error || !res.report) { console.log(`run ${i + 1}: BROKE ${res.error}`); continue; }
  const p = res.report.processes;
  const d = res.report.delete;
  const row = {
    first: p.atFirstReply, end: p.atEnd, load: l0,
    surv: p.survivorsAfterTeardown, del: d ? { ms: d.elapsedMs, survivors: d.survivors?.length ?? null } : null,
  };
  rows.push(row);
  const k = (c) => `total=${c.total} cli=${c.byKind.cli} keeper=${c.byKind.keeper} mcp=${c.byKind.mcp} hook=${c.byKind.hook} other=${c.byKind.other} mem=${Math.round((c.rssKB + (c.swapKB ?? 0)) / 1024)}MB(swap ${Math.round((c.swapKB ?? 0) / 1024)})`;
  console.log(`run ${i + 1} (load ${l0}): first[${k(row.first)}] end[${k(row.end)}] survivors=${row.surv}${row.del ? ` deleteMs=${row.del.ms}` : ''}${res.report.error ? ` ERROR=${res.report.error.slice(0, 100)}` : ''}`);
  if (i === 0 && p.atFirstReply.procs) for (const q of p.atFirstReply.procs) console.log(`   ${q.pid} ${q.kind} rss=${q.rssKB ?? '?'}KB swap=${q.swapKB ?? '?'}KB ${q.cmd.slice(0, 110)}`);
}
const stat = (f) => { const v = rows.map(f).filter((x) => x != null).sort((a, b) => a - b); return v.length ? `min=${v[0]} med=${v[Math.floor(v.length / 2)]} max=${v[v.length - 1]} (n=${v.length})` : 'n=0'; };
console.log('--- spread');
for (const w of ['first', 'end']) {
  console.log(`${w}: total ${stat((r) => r[w].total)} · cli ${stat((r) => r[w].byKind.cli)} · keeper ${stat((r) => r[w].byKind.keeper)} · mcp ${stat((r) => r[w].byKind.mcp)} · hook ${stat((r) => r[w].byKind.hook)} · other ${stat((r) => r[w].byKind.other)} · zombies ${stat((r) => r[w].zombies)} · memMB ${stat((r) => Math.round((r[w].rssKB + (r[w].swapKB ?? 0)) / 1024))} · swapMB ${stat((r) => Math.round((r[w].swapKB ?? 0) / 1024))}`);
}
console.log(`survivorsAfterTeardown ${stat((r) => r.surv)}${rows[0]?.del ? ` · deleteMs ${stat((r) => r.del?.ms)}` : ''}`);
