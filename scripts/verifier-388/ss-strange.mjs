// REAL-kernel replay: ss snapshot while the stranger socket is alive, /proc/net/unix read AFTER it closed (the driver's own order, with the race made deterministic). usage: node --experimental-strip-types ss-strange.mjs <repo>
import { spawn, spawnSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const W = await import(pathToFileURL(path.join(path.resolve(process.argv[2]), 'src/shared/keyring-rig-world.ts')).href);
const base = fs.mkdtempSync(path.join(process.env.TMPDIR, 'ssstr-'));
const py = spawn('python3', ['-I', path.join(path.dirname(new URL(import.meta.url).pathname), 'ss-strange.py'), base], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; py.stdout.on('data', (d) => (buf += d));
const waitLine = async (n) => { for (let i = 0; i < 200 && buf.split('\n').length <= n; i++) await new Promise((r) => setTimeout(r, 50)); return buf.split('\n')[n - 1]; };
const info = JSON.parse(await waitLine(1)); const H = path.join(base, 'human bus');
const ss = spawnSync('ss', ['-xnaeH'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout;     // snapshot 1 (stranger alive)
const mine = ss.split('\n').filter((l) => l.includes(`${info.c} `) || l.includes(`${info.s} `)).map((l) => l.replace(base, '<B>').replace(/\s+/g, ' ').slice(0, 170));
py.stdin.write('close-stranger\n'); await waitLine(2);                                       // the stranger's local inode vanishes between the two reads
const pn = fs.readFileSync('/proc/net/unix', 'utf8');                                         // snapshot 2
const { scan, unparsed } = W.buildSocketScan(pn, ss);
const got = W.socketPaths([info.c], scan); const sees = got.includes(H); const about = W.unparsedAbout(unparsed, new Set([info.c]));
console.log('rows naming our client / the stranger:'); for (const m of mine) console.log('   ', m);
console.log(`our client inode ${info.c} is connected to the stand-in human bus; stranger S=${info.s} (closed before snapshot 2)`);
console.log(`socketPaths([${info.c}]) = ${JSON.stringify(got.map((p) => p.replace(base, '<B>')))} ; sees human bus = ${sees} ; unparsed rows about our inode = ${about.length}`);
console.log(sees || about.length ? 'RESULT OK (seen or aborted)' : 'RESULT HIDDEN: a stranger row replaced our pair silently');
py.stdin.end(); await new Promise((r) => setTimeout(r, 300)); fs.rmSync(base, { recursive: true, force: true });
process.exit(sees || about.length ? 0 : 1);
