// Reviewer probe: hung (SIGSTOPped) live keeper K_old + a second daemon K_new started for the same workspace.
// Clean guard: K_new must REFUSE (fail closed on a probe that never answers) and leave K_old's files. KEEPER_JS selects the bundle.
import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
const REPO = '/home/lmas/a2r-probe';
const KEEPER_JS = process.env.KEEPER_JS ?? path.join(REPO, 'dist-electron', 'keeper.js');
const TAG = process.argv[2] ?? 'x';
const base = `/home/lmas/a2r-attack/arms/hungprobe-${TAG}`;
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home'); fs.mkdirSync(path.join(home, 'keepers'), { recursive: true });
const ws = `wshp-${TAG}-${process.pid}`;
const sock = path.join(home, 'keepers', `${ws}.sock`), pidf = path.join(home, 'keepers', `${ws}.pid`), logf = path.join(home, 'keepers', `${ws}.log`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = (pid) => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0]; } catch { return null; } };
const alive = (pid) => { const s = st(pid); return s !== null && s !== 'Z'; };
const pidFilePid = () => { try { return JSON.parse(fs.readFileSync(pidf, 'utf8')).pid; } catch { return null; } };
const launch = () => { const c = spawn(process.execPath, [KEEPER_JS, ws, sock, pidf, logf], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: home } }); c.unref(); return c.pid; };
const out = { tag: TAG, bundle: KEEPER_JS, refusesString: fs.readFileSync(KEEPER_JS, 'utf8').includes('refusing to start') };
const mine = [];
try {
  const kOld = launch(); mine.push(kOld);
  for (let i = 0; i < 100 && !(pidFilePid() === kOld && fs.existsSync(sock)); i++) await sleep(50);
  out.kOld = kOld; out.pidBefore = pidFilePid();
  process.kill(kOld, 'SIGSTOP'); // hung: accepts at kernel level (backlog), never answers
  const kNew = launch(); mine.push(kNew); out.kNew = kNew;
  const t0 = Date.now();
  for (let i = 0; i < 200 && alive(kNew); i++) await sleep(50);
  out.kNewExitedAfterMs = alive(kNew) ? null : Date.now() - t0;
  await sleep(300);
  out.after = { kNewAlive: alive(kNew), kOldAlive: alive(kOld), pidFilePid: pidFilePid(), pidFileIsOld: pidFilePid() === kOld, pidFileIsNew: pidFilePid() === kNew };
  out.keepersAlive = mine.filter(alive).length;
} catch (e) { out.error = String(e?.stack ?? e); }
finally { for (const p of mine) { try { process.kill(p, 'SIGCONT'); process.kill(p, 'SIGKILL'); } catch { /* gone */ } } await sleep(200); out.leftovers = mine.filter(alive); }
console.log(JSON.stringify(out)); process.exit(0);
