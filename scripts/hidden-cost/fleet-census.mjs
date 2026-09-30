#!/usr/bin/env node
// C2 #209 — FIELD census of the live machine: what the running Orchestra fleet actually costs, grouped by
// process class (read-only: /proc only, no signals, no writes). Reads /proc directly (no `ps`).
//   node scripts/hidden-cost/fleet-census.mjs [--json] [--top N]
import fs from 'node:fs';

const rows = [];
for (const d of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(d)) continue;
  try {
    const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
    const rp = stat.lastIndexOf(')');
    const f = stat.slice(rp + 2).split(' ');
    const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const rssKB = Number(/^VmRSS:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${d}/status`, 'utf8'))?.[1] ?? 0); // kB whatever the page size (statm*4 read 4x LOW on this 16 KB-page host)
    rows.push({ pid: Number(d), ppid: Number(f[1]), state: f[0], cpuS: (Number(f[11]) + Number(f[12])) / 100, startTicks: Number(f[19]), cmd, rssKB });
  } catch { /* exited */ }
}
const uptimeS = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
const byPid = new Map(rows.map((r) => [r.pid, r]));
function cls(r) {
  const line = r.cmd.join(' ');
  const a0 = r.cmd[0] ?? '';
  if (/keeper\.js/.test(line)) return 'orchestra-keeper';
  if (/\/claude\/versions\//.test(a0) || /(^|\/)claude$/.test(a0)) return 'claude-cli';
  if (/lazy-mcp\.mjs/.test(line)) return 'mcp-lazy-wrapper';
  if (/chrome-devtools-mcp|npx/.test(line)) return 'mcp-npx/chrome-devtools';
  if (/(^|\/)orchestra$/.test(a0) || /Orchestra\.AppImage|\.mount_Orche/.test(a0)) {
    const t = /--type=([a-z-]+)/.exec(line);
    return t ? `orchestra-electron-${t[1]}` : 'orchestra-electron-main';
  }
  if (/\/usr\/lib64\/chromium|chromium-browser/.test(line)) return 'chromium';
  if (/mcp/i.test(line)) return 'mcp-other';
  if (/(^|\/)(ba|z)?sh$/.test(a0)) return 'shell';
  return 'other';
}
const groups = new Map();
for (const r of rows) {
  if (r.state === 'Z') continue;
  const c = cls(r);
  const g = groups.get(c) ?? { n: 0, rssKB: 0, cpuS: 0, maxAgeS: 0 };
  g.n++; g.rssKB += r.rssKB; g.cpuS += r.cpuS; g.maxAgeS = Math.max(g.maxAgeS, uptimeS - r.startTicks / 100); groups.set(c, g);
}
const clis = rows.filter((r) => cls(r) === 'claude-cli' && r.state !== 'Z');
const descCount = (pid, filter) => { let n = 0; const stack = rows.filter((r) => r.ppid === pid); while (stack.length) { const p = stack.pop(); if (filter(p)) n++; stack.push(...rows.filter((r) => r.ppid === p.pid)); } return n; };
const perCli = clis.map((c) => ({ pid: c.pid, rssMB: Math.round(c.rssKB / 1024), children: descCount(c.pid, () => true), mcpChildren: descCount(c.pid, (p) => /mcp/i.test(p.cmd.join(' '))) }));
const out = {
  takenAt: new Date().toISOString(),
  memAvailableMB: Math.round(Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024),
  loadavg: fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' '),
  totalProcs: rows.length,
  classes: Object.fromEntries([...groups].sort((a, b) => b[1].rssKB - a[1].rssKB).map(([k, v]) => [k, { n: v.n, rssMB: Math.round(v.rssKB / 1024), cumulativeCpuS: Math.round(v.cpuS), oldestAgeH: Number((v.maxAgeS / 3600).toFixed(1)), lifetimeCpuPctOfOneCore: v.n === 1 ? Number((100 * v.cpuS / Math.max(1, v.maxAgeS)).toFixed(1)) : null }])),
  claudeCliCount: clis.length,
  perCliChildrenAvg: clis.length ? Number((perCli.reduce((a, x) => a + x.children, 0) / clis.length).toFixed(2)) : null,
  perCliMcpChildrenAvg: clis.length ? Number((perCli.reduce((a, x) => a + x.mcpChildren, 0) / clis.length).toFixed(2)) : null,
  perCliRssMBAvg: clis.length ? Math.round(perCli.reduce((a, x) => a + x.rssMB, 0) / clis.length) : null,
};
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`census @ ${out.takenAt} load=${out.loadavg} MemAvailable=${out.memAvailableMB} MB procs=${out.totalProcs}`);
  for (const [k, v] of Object.entries(out.classes)) console.log(`${String(v.n).padStart(5)}  ${String(v.rssMB).padStart(6)} MB  ${String(v.cumulativeCpuS).padStart(7)} cpu-s  age ${String(v.oldestAgeH).padStart(5)} h  ${v.lifetimeCpuPctOfOneCore === null ? '' : `(${v.lifetimeCpuPctOfOneCore}% of 1 core lifetime) `}${k}`);
  console.log(`claude CLIs: ${out.claudeCliCount}; avg children/CLI ${out.perCliChildrenAvg}; avg MCP children/CLI ${out.perCliMcpChildrenAvg}; avg CLI RSS ${out.perCliRssMBAvg} MB`);
}
