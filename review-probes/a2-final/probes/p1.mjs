// P1: can a LIVE, FRESH claim be displaced by breakStaleClaim's rename-aside window? (D5 / M44 "not drivable")
// Rig-owned daemons only, scratch dir under /home/lmas/rf. MODE=control (no widening) | mutant-window (widened).
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path'; import { spawn } from 'node:child_process';
const MODE = process.argv[2] ?? 'widened';
const DIR = `/home/lmas/rf/p1/${MODE}-${process.env.TAG ?? 'tip'}`; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
const BIN = process.env.BIN ?? '/home/lmas/a2f-tip/dist-electron/keeper.js'; const TAG = process.env.TAG ?? 'tip'; if (!DIR.startsWith('/home/lmas/rf/')) throw new Error('scratch guard');
const sock = `${DIR}/w.sock`, pidp = `${DIR}/w.pid`, claim = `${pidp}.claim`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now(); const T = () => Date.now() - t0;
// stale socket file
const srv = await new Promise((res) => { const s = net.createServer(); s.listen(sock, () => res(s)); });
fs.linkSync(sock, sock + '.keep'); await new Promise((r) => srv.close(r)); fs.renameSync(sock + '.keep', sock);
const dead = spawn('true'); await new Promise((r) => dead.once('exit', r));
fs.writeFileSync(claim, String(dead.pid)); // S: stale (dead holder), fresh mtime
const mk = (tag, env = {}) => { const log = `${DIR}/${tag}.log`; const c = spawn(process.execPath, [BIN, 'ws-p1', sock, pidp, log], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env } }); c.unref(); return { pid: c.pid, log, tag }; };
const has = (d, s) => { try { return fs.readFileSync(d.log, 'utf8').includes(s); } catch { return false; } };
const waitLog = async (d, s, ms) => { const a = Date.now(); while (Date.now() - a < ms) { if (has(d, s)) return true; await sleep(5); } return false; };
const ev = [];
let D1 = null;
if (MODE === 'widened' || MODE === 'verdict') D1 = mk('D1', { NODE_OPTIONS: '--require /home/lmas/rf/p1/preload.cjs', P1_VERDICT_MS: '800', P1_WINDOW_MS: MODE === 'widened' ? '1500' : '0' });
else D1 = mk('D1'); // control: D1 unwidened
if (MODE === 'widened' || MODE === 'verdict') {
  ev.push({ t: T(), e: 'D1 spawned (verdict delay 800, window 1500)' });
  const saw = await waitLog(D1, 'claiming the takeover', 8000); ev.push({ t: T(), e: `D1 log 'claiming the takeover' seen=${saw}` });
  await sleep(200);
  // swap S -> F: a FRESH claim naming a LIVE holder (this rig), atomically over the path
  fs.writeFileSync(claim + '.F', String(process.pid)); fs.renameSync(claim + '.F', claim); const tF = T(); ev.push({ t: tF, e: 'F installed (live holder = rig, fresh)' });
  var D3;
  await sleep(500); D3 = mk('D3'); ev.push({ t: T(), e: 'D3 spawned (normal daemon)' });
  const acq = await waitLog(D3, 'takeover claim acquired', 7500); const tAcq = T(); ev.push({ t: tAcq, e: `D3 'takeover claim acquired' seen=${acq}` });
  const claimNow = (() => { try { return fs.readFileSync(claim, 'utf8'); } catch { return null; } })();
  ev.push({ t: T(), e: `claim content now=${claimNow} (rig pid=${process.pid}, D3 pid=${D3.pid})` });
  const displaced = acq && tAcq < tF + 4000; // the rig still "holds" F; a live FRESH claim (age < 5 s) must not be acquired over
  await sleep(300);
  const finalClaim = (() => { try { return fs.readFileSync(claim, 'utf8'); } catch { return null; } })();
  console.log(JSON.stringify({ MODE, displacedLiveFreshClaim: displaced, tF, tAcq, deltaMs: tAcq - tF, finalClaim, ev }));
} else {
  // CONTROL: rig holds a FRESH live claim F from the start (no stale S); a plain daemon must WAIT and not acquire early.
  fs.writeFileSync(claim + '.F', String(process.pid)); fs.renameSync(claim + '.F', claim); const tF = T();
  const acq = await waitLog(D1, 'takeover claim acquired', 2500); // hold F 2.5 s (< the 5 s stale age)
  const acquiredWhileHeld = acq; const reachedClaimStage = has(D1, 'claiming the takeover');
  console.log(JSON.stringify({ MODE, tF, acquiredWhileHeld, reachedClaimStage, ok: !acquiredWhileHeld && reachedClaimStage }));
}
for (const d of [D1, typeof D3 !== 'undefined' ? D3 : null]) if (d) try { process.kill(d.pid, 'SIGKILL'); } catch {}
// reap any keeper of this scratch dir
for (const n of fs.readdirSync('/proc')) { if (!/^\d+$/.test(n)) continue; try { if (fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').some((a) => a.startsWith(DIR + '/'))) process.kill(Number(n), 'SIGKILL'); } catch {} }
process.exit(0);
