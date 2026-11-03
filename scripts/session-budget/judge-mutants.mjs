#!/usr/bin/env node
// Clause mutants of the #210 process + memory budgets:  node scripts/session-budget/judge-mutants.mjs
// Each mutant edits ONE clause of a COPY of src/shared/session-budget.ts (the repo file is never touched) and runs the unit tests against
// the copy: KILLED = they fail. The unmutated copy is the positive control (must pass), every anchor must match exactly once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(REPO, 'src/shared/session-budget.ts'), 'utf8');
const TEST = fs.readFileSync(path.join(REPO, 'src/shared/session-budget.test.ts'), 'utf8');

/** [name, exact text of the clause, its mutation] */
const MUTANTS = [
  // the numbers
  ['budget keeper 1→2', "    keeper: 1,\n    cli: 1,", "    keeper: 2,\n    cli: 1,"],
  ['budget cli 1→2', "    cli: 1,\n    mcpPerConfiguredServer: 1,", "    cli: 2,\n    mcpPerConfiguredServer: 1,"],
  ['budget mcp-per-server 1→2', "    mcpPerConfiguredServer: 1,", "    mcpPerConfiguredServer: 2,"],
  ['budget hook 0→1', "    hook: 0,\n    other: 0,", "    hook: 1,\n    other: 0,"],
  ['budget other 0→1', "    other: 0,\n    memoryMB", "    other: 1,\n    memoryMB"],
  ['budget memory base 400→401', "base: 400,", "base: 401,"],
  ['budget memory per-server 65→66', "perMcpServer: 65 }", "perMcpServer: 66 }"],
  // the judge
  ['processVerdicts never called', "  processVerdicts(report, budgets.processes, verdicts);\n", ""],
  ['keeper limit +1', "['keeper', b.keeper]", "['keeper', b.keeper + 1]"],
  ['cli limit +1', "['cli', b.cli]", "['cli', b.cli + 1]"],
  ['mcp limit hardcodes 4 servers', "['mcp', b.mcpPerConfiguredServer * nMcp]", "['mcp', b.mcpPerConfiguredServer * 4]"],
  ['mcp limit +1', "['mcp', b.mcpPerConfiguredServer * nMcp]", "['mcp', b.mcpPerConfiguredServer * nMcp + 1]"],
  ['hook limit +1', "['hook', b.hook]", "['hook', b.hook + 1]"],
  ['other limit +1', "['other', b.other]", "['other', b.other + 1]"],
  ['memory ceiling base dropped', "b.memoryMB.base + b.memoryMB.perMcpServer * nMcp, mbOf(kb)", "b.memoryMB.perMcpServer * nMcp, mbOf(kb)"],
  ['memory ceiling hardcodes 4 servers', "b.memoryMB.base + b.memoryMB.perMcpServer * nMcp, mbOf(kb)", "b.memoryMB.base + b.memoryMB.perMcpServer * 4, mbOf(kb)"],
  ['memory ceiling +1 MB', "b.memoryMB.base + b.memoryMB.perMcpServer * nMcp, mbOf(kb)", "b.memoryMB.base + b.memoryMB.perMcpServer * nMcp + 1, mbOf(kb)"],
  ['swap not counted', "const kb = c.rssKB + (c.swapKB ?? 0);", "const kb = c.rssKB;"],
  ['MB rounds down', "const mbOf = (kb: number): number => Math.round(kb / 1024);", "const mbOf = (kb: number): number => Math.floor(kb / 1024);"],
  ['memory compared for equality', "'max', b.memoryMB.base + b.memoryMB.perMcpServer * nMcp, mbOf(kb)", "'exact', b.memoryMB.base + b.memoryMB.perMcpServer * nMcp, mbOf(kb)"],
  ['settled-end window dropped', "    ['atEnd', report.processes?.atEnd, 'the settled end'],\n", ""],
  ['first-reply window dropped', "    ['atFirstReply', report.processes?.atFirstReply, 'the first reply'],\n", ""],
  ['broken verdict does not name the tree', "(v.ok ? v : { ...v, tree })", "v"],
  ['vacuous census passes (min 2+n → 0)', "c?.total ?? null, 2 + nMcp,", "c?.total ?? null, 0,"],
  ['unread RSS passes', "c.procs.filter((p) => (p.rssKB ?? 0) > 0).length", "c.procs.length"],
  ['tree children not indented', "walk(c, depth + 1)", "walk(c, depth)"],
  ['tree omits swap', "const footprintKB = (p: { rssKB?: number; swapKB?: number }): number => (p.rssKB ?? 0) + (p.swapKB ?? 0);", "const footprintKB = (p: { rssKB?: number; swapKB?: number }): number => (p.rssKB ?? 0);"],
];

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'sb-judge-mutants-'));
fs.writeFileSync(path.join(dir, 'session-budget.test.ts'), TEST);
const run = (src) => {
  fs.writeFileSync(path.join(dir, 'session-budget.ts'), src);
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(dir, 'session-budget.test.ts')], { encoding: 'utf8', timeout: 120_000 });
  const failed = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1].slice(0, 90));
  return { rc: r.status, failed, pass: Number(/^# pass (\d+)/m.exec(r.stdout)?.[1] ?? 0), skipped: Number(/^# skipped (\d+)/m.exec(r.stdout)?.[1] ?? -1) };
};
let survived = 0;
try {
  const control = run(SRC);
  console.log(`control (unmutated copy): rc=${control.rc} pass=${control.pass} skipped=${control.skipped} — ${control.rc === 0 && control.pass > 0 && control.skipped === 0 ? 'ok' : 'BROKEN CONTROL'}`);
  if (control.rc !== 0 || control.pass === 0 || control.skipped !== 0) process.exit(2);
  for (const [name, from, to] of MUTANTS) {
    const hits = SRC.split(from).length - 1;
    if (hits !== 1) { console.log(`ANCHOR-GONE  ${name}: matched ${hits}×`); survived++; continue; }
    const r = run(SRC.replace(from, () => to));
    const killed = r.rc !== 0 && r.failed.length > 0;
    if (!killed) survived++;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${name}${killed ? `  ← ${r.failed.length} test(s): ${r.failed[0]}` : ''}`);
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`JUDGE-MUTANTS: ${survived === 0 ? `ALL ${MUTANTS.length} KILLED` : `${survived} SURVIVED/GONE of ${MUTANTS.length}`}`);
process.exit(survived === 0 ? 0 : 1);
