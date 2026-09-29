import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { open, MIGRATIONS } from '/home/lmas/.orchestra/worktrees/orchestra-happy-river-03b66340/src/main/bus.ts';
const startV = Number(process.argv[2] ?? 7), iters = Number(process.argv[3] ?? 10), N = Number(process.argv[4] ?? 6);
let errs = 0, oks = 0, iterWithErr = 0;
for (let i = 0; i < iters; i++) {
  const dir = fs.mkdtempSync(path.join('/home/lmas/rev-a4-scratch/', 'db-'));
  const file = path.join(dir, 'bus.sqlite');
  const db = open(file);
  for (let v = 1; v <= startV; v++) db.exec(`BEGIN IMMEDIATE; ${MIGRATIONS[v]}; PRAGMA user_version = ${v}; COMMIT;`);
  db.close();
  const t0 = Date.now() + 700;
  const outs: string[] = [];
  await Promise.all(Array.from({ length: N }, () => new Promise<void>((res) => {
    const c = spawn('node', ['--experimental-strip-types', '--no-warnings', '/home/lmas/rev-a4-scratch/race-child.mts', file, String(t0)]);
    let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => { outs.push(o.trim()); res(); });
  })));
  const e = outs.filter((o) => o.startsWith('ERR')).length; errs += e; oks += outs.length - e; if (e) iterWithErr++;
  if (i === 0) console.log(outs.join(' | '));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`startV=${startV} iters=${iters} N=${N} ok=${oks} err=${errs} itersWithErr=${iterWithErr}`);
