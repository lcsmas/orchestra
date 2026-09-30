// P2 flipper: S (dead-pid claim) -> break+acquire F (live pid = this process) like a daemon would; nobody but the sweeper removes F.
import fs from 'node:fs'; import { spawn } from 'node:child_process';
const HOME = process.env.HOME; const home = `${HOME}/p2home`; const dir = `${home}/keepers`; const claim = `${dir}/ws-p2.pid.claim`;
const dead = spawn('true'); await new Promise((r) => dead.once('exit', r));
const tmpD = `${claim}.${dead.pid}.tmp`, tmpL = `${claim}.${process.pid}.tmp`, aside = `${claim}.stale.${process.pid}`;
while (!fs.existsSync(`${home}/READY`)) await new Promise((r) => setTimeout(r, 20));
fs.writeFileSync(tmpL, String(process.pid));
const dur = Number(process.argv[2] ?? 15000); const t0 = Date.now(); let flips = 0, vanished = 0;
const spin = (us) => { const e = process.hrtime.bigint() + BigInt(us * 1000); while (process.hrtime.bigint() < e); };
while (Date.now() - t0 < dur) {
  try { fs.writeFileSync(claim, String(dead.pid), { flag: 'wx' }); } catch { try { fs.unlinkSync(claim); } catch {} continue; }   // S in place (dead holder)
  spin(Math.floor(Math.random() * 120));
  try { fs.renameSync(claim, aside); } catch {} try { fs.unlinkSync(aside); } catch {}           // break S (rename-aside, as the daemon does)
  try { fs.linkSync(tmpL, claim); } catch { continue; }                                            // acquire F (live, fresh)
  flips++;
  spin(2500);                                                                                       // hold F 2.5 ms
  let ok = false; try { ok = fs.readFileSync(claim, 'utf8') === String(process.pid); } catch {}
  if (!ok) vanished++;
  try { fs.unlinkSync(claim); } catch {}                                                            // release
}
fs.writeFileSync(`${home}/STOP`, '1');
await new Promise((r) => setTimeout(r, 500));
console.log(JSON.stringify({ flips, liveClaimVanishedWhileHeld: vanished, sweeps: Number(fs.readFileSync(`${home}/sweeps`, 'utf8')) }));
try { fs.unlinkSync(tmpL); } catch {}
process.exit(0);
