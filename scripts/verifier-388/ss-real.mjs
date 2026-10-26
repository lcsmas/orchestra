// usage: node --experimental-strip-types ss-real.mjs <repo>   (scratch dir under $TMPDIR; real kernel /proc/net/unix + real `ss -xnaeH`; nothing connects to any host socket)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = path.resolve(process.argv[2]);
const W = await import(pathToFileURL(path.join(repo, 'src/shared/keyring-rig-world.ts')).href);
const base = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'ssreal-'));
const NAMES = ['plain', 'my sock', 'my 123 sock', 'x 1 /y 2 z', 'uni-ソケット', 'trail ', 'a --- b', 'a <-> b', 'a --> b', 'a <-- b', 'p 1 /q 2 --- zz', 'p 1 /q 2 <-> zz', 'k 3 * 4 --- w', 'q 1 /r 2 --> zz', 'd 5 /e 6 <-- w 7 * 8', 'm 9 /n 10 --- 11 * 12'];
const py = spawn('python3', ['-I', path.join(path.dirname(new URL(import.meta.url).pathname), 'ss-real.py'), base, JSON.stringify(NAMES)], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; py.stdout.on('data', (d) => (buf += d));
await new Promise((r) => { const t = setInterval(() => { if (buf.includes('\n')) { clearInterval(t); r(); } }, 50); });
const inos = JSON.parse(buf.trim());
const snap = () => ({ pn: fs.readFileSync('/proc/net/unix', 'utf8'), ss: spawnSync('ss', ['-xnaeH'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout });
const s = snap();
const { scan, unparsed } = W.buildSocketScan(s.pn, s.ss);
const L = path.join(base, 'listener sock');
let bad = 0;
for (const n of NAMES) {
  const ino = inos[n]; if (typeof ino !== 'number') { console.log(`SKIP  ${JSON.stringify(n)}  ${ino}`); continue; }
  const got = W.socketPaths([ino], scan); const want = [path.join(base, n), L].sort();
  const okv = JSON.stringify(got) === JSON.stringify(want);
  const row = s.ss.split('\n').find((l) => l.includes(` ${ino} `)) ?? '(no ss row)';
  if (!okv) bad++;
  console.log(`${okv ? 'OK    ' : 'WRONG '}${JSON.stringify(n).padEnd(36)} paths=${got.length === 2 ? 'own+listener' : JSON.stringify(got.map((p) => p.replace(base, '<B>')))}${okv ? '' : `\n        ss row: ${row.replace(base, '<B>')}`}`);
}
const mine = unparsed.filter((u) => u.includes(base));
console.log(`host-wide unparsed rows: ${unparsed.length} (mine: ${mine.length}); total ss rows ${s.ss.split('\n').filter(Boolean).length}, /proc/net/unix sockets ${scan.pathByIno.size} named`);
for (const u of unparsed.slice(0, 5)) console.log('  UNPARSED:', u.replace(base, '<B>'));
console.log(`RESULT wrong-or-missing=${bad}`);
py.stdin.end(); await new Promise((r) => setTimeout(r, 300)); fs.rmSync(base, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
