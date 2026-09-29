import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const { open, MIGRATIONS } = await import(process.env.RV_W + '/src/main/bus.ts');
const startV = Number(process.argv[2] ?? 7), iters = Number(process.argv[3] ?? 10), N = Number(process.argv[4] ?? 6);
let errs = 0, oks = 0, iterWithErr = 0; const kinds = new Set<string>();
for (let i = 0; i < iters; i++) {
  const dir = fs.mkdtempSync(path.join('/home/lmas/rv-a4d/scratch/', 'db-'));
  const file = path.join(dir, 'bus.sqlite');
  const db = open(file);
  for (let v = 1; v <= startV; v++) db.exec(`BEGIN IMMEDIATE; ${MIGRATIONS[v]}; PRAGMA user_version = ${v}; COMMIT;`);
  db.close();
  const t0 = Date.now() + 700;
  const outs: string[] = [];
  await Promise.all(Array.from({ length: N }, () => new Promise<void>((res) => {
    const c = spawn('node', ['--experimental-strip-types', '--no-warnings', '/home/lmas/rv-a4d/probes/race-child2.mts', file, String(t0)], { env: { PATH: process.env.PATH!, RV_W: process.env.RV_W! } });
    let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => { outs.push(o.trim()); res(); });
  })));
  const e = outs.filter((o) => !o.startsWith('OK v8')).length; errs += e; oks += outs.length - e; if (e) iterWithErr++;
  outs.filter((o) => !o.startsWith('OK v8')).forEach((o) => kinds.add(o.slice(0, 90)));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`startV=${startV} iters=${iters} N=${N} ok(v8)=${oks} notOk=${errs} itersWithErr=${iterWithErr} kinds=${JSON.stringify([...kinds])}`);
