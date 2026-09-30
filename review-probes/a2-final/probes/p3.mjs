// P3: can a crash mid-rename-aside wedge launches? MODE=leftover (aside file of a dead pid, no claim) | killmid (D1 SIGKILLed while the claim sits aside)
import fs from 'node:fs'; import net from 'node:net'; import { spawn } from 'node:child_process';
const MODE = process.argv[2];
const DIR = `/home/lmas/rf/p1/p3-${MODE}`; if (!DIR.startsWith('/home/lmas/rf/')) throw new Error('guard'); fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
const BIN = '/home/lmas/a2f-tip/dist-electron/keeper.js';
const sock = `${DIR}/w.sock`, pidp = `${DIR}/w.pid`, claim = `${pidp}.claim`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = await new Promise((res) => { const s = net.createServer(); s.listen(sock, () => res(s)); });
fs.linkSync(sock, sock + '.keep'); await new Promise((r) => srv.close(r)); fs.renameSync(sock + '.keep', sock);
const dead = spawn('true'); await new Promise((r) => dead.once('exit', r));
const mk = (tag, env = {}) => { const c = spawn(process.execPath, [BIN, 'ws-p3', sock, pidp, `${DIR}/${tag}.log`], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env } }); c.unref(); return c.pid; };
const keepers = () => { const out = []; for (const n of fs.readdirSync('/proc')) { if (!/^\d+$/.test(n)) continue; try { const a = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0'); if (a.includes(sock)) { const st = fs.readFileSync(`/proc/${n}/stat`, 'utf8').replace(/^.*\) /, '')[0]; if (st !== 'Z') out.push(Number(n)); } } catch {} } return out; };
const serving = () => new Promise((res) => { const c = net.connect(sock); const t = setTimeout(() => { c.destroy(); res(false); }, 800); c.once('connect', () => { clearTimeout(t); c.destroy(); res(true); }); c.once('error', () => { clearTimeout(t); res(false); }); });
let setup = {};
if (MODE === 'leftover') {
  fs.writeFileSync(`${claim}.stale.${dead.pid}`, String(dead.pid)); fs.writeFileSync(`${claim}.${dead.pid}.tmp`, String(dead.pid));
  setup = { asideLeftover: fs.existsSync(`${claim}.stale.${dead.pid}`), claimPresent: fs.existsSync(claim) };
} else {
  fs.writeFileSync(claim, String(dead.pid));
  const d1 = mk('D1', { NODE_OPTIONS: '--require /home/lmas/rf/p1/preload.cjs', P1_VERDICT_MS: '300', P1_WINDOW_MS: '60000' }); // stalls 60 s right after moving the claim aside
  const aside = `${claim}.stale.${d1}`;
  const t0 = Date.now(); while (!fs.existsSync(aside) && Date.now() - t0 < 10000) await sleep(5);
  setup = { asideExists: fs.existsSync(aside), claimPresent: fs.existsSync(claim), d1Alive: keepers().includes(d1) || (() => { try { process.kill(d1, 0); return true; } catch { return false; } })() };
  process.kill(d1, 'SIGKILL'); await sleep(200);
  setup.d1Dead = (() => { try { process.kill(d1, 0); return false; } catch { return true; } })();
}
const pids = []; for (let i = 0; i < 6; i++) pids.push(mk(`N${i}`));
const t1 = Date.now(); let got = false; while (Date.now() - t1 < 9000 && !got) { got = await serving(); if (!got) await sleep(50); }
const ms = Date.now() - t1; await sleep(1200);
const live = keepers().length;
console.log(JSON.stringify({ MODE, setup, servingAfterMs: got ? ms : null, keepersAlive: live, ok: setup && got && live === 1 }));
for (const n of fs.readdirSync('/proc')) { if (!/^\d+$/.test(n)) continue; try { if (fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').some((a) => a.startsWith(DIR + '/'))) process.kill(Number(n), 'SIGKILL'); } catch {} }
process.exit(0);
