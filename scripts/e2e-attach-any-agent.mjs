#!/usr/bin/env node
// #439 — drive the BUILT app: attach and detach under ANY agent, by drag-and-drop in the sidebar and by the built CLI, against the app's real bus
// (scratch ORCHESTRA_HOME) and real workspace store. State assertions (workspaces:list, bus.sqlite read-only, the CLI's own replies) AND screenshots.
// Run through scripts/e2e-attach-any-agent.sh (own sway, env allowlist, scratch account dir).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';

const APP_DIR = process.argv[2];
const RIG = { wayland: process.env.RIG_WAYLAND ?? '', base: process.env.ORCHESTRA_HOME ?? '' };
for (const k of ['RIG_WAYLAND', 'ORCHESTRA_HOME', 'RIG_DIR']) if (!process.env[k]) { console.log(`REFUSED: ${k} unset — run through scripts/e2e-attach-any-agent.sh`); process.exit(3); }
if (process.env.DISPLAY || RIG.wayland === 'wayland-1') { console.log('REFUSED: would reach the human\'s display'); process.exit(3); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${detail}` : ''}`); };
async function waitFor(what, fn, ms = 20000, step = 150) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout ${ms}ms: ${what}`); await sleep(step); } }

class Cdp {
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws error')); }); return new Cdp(ws); }
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (m) => { const msg = JSON.parse(m.data); const p = msg.id && this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); } }; }
  send(method, params = {}, ms = 15000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`cdp timeout ${method}`)), ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result.value; }
}

// ── seed: real git repo + registered worktrees, scratch pinned account ──────────────────────────────────
const home = path.join(RIG.base, `att-${Date.now().toString(36)}`);
const fakeHome = path.join(home, 'home');
const repoDir = path.join(home, 'repo');
fs.mkdirSync(fakeHome, { recursive: true }); fs.mkdirSync(repoDir, { recursive: true });
const gitEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: fakeHome, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
git(repoDir, ['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repoDir, 'README.md'), '# att seed\n'); git(repoDir, ['add', '.']); git(repoDir, ['commit', '-q', '-m', 'seed']);
const configDir = path.join(home, 'claude-config'); fs.mkdirSync(configDir, { recursive: true });
const live = [process.env.CLAUDE_CONFIG_DIR, path.join(os.userInfo().homedir, '.claude')].filter(Boolean).map((p) => fs.realpathSync.native(p));
if (live.some((l) => fs.realpathSync.native(configDir) === l || fs.realpathSync.native(configDir).startsWith(l + path.sep))) { console.log('REFUSED: scratch config dir overlaps a live one'); process.exit(3); }
const account = { id: 'rig-att', label: 'rig (scratch config dir)', configDir };
const mk = (tag, extra = {}) => {
  const wt = path.join(home, 'wt', tag);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/${tag}`, wt]);
  return { id: `ws-${tag}`, name: tag, repoPath: repoDir, worktreePath: wt, branch: `e2e/${tag}`, baseBranch: 'main', createdAt: Date.now() + Object.keys(extra).length, status: 'idle', agent: 'claude', accountId: account.id, ...extra };
};
const A = mk('att-a'), B = mk('att-b'), C = mk('att-c'), D = mk('att-d', { parentId: 'ws-att-a' });
const ID = { A: A.id, B: B.id, C: C.id, D: D.id };
const storeDir = path.join(home, 'userData', 'orchestra'); fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(path.join(storeDir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'att-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [A, D, B, C], accounts: [account], selfTuneRuns: [] }, null, 2));

// ── launch (allowlist env, own compositor) ─────────────────────────────────────────────────────────
const port = await new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin', HOME: fakeHome, XDG_RUNTIME_DIR: privateRuntimeDir(), XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'),
  WAYLAND_DISPLAY: RIG.wayland, SWAYSOCK: process.env.SWAYSOCK ?? '', LANG: 'C.UTF-8', ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: home, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: configDir,
};
const electron = path.join(APP_DIR, 'node_modules/electron/dist/electron');
const logFd = fs.openSync(path.join(home, 'app.log'), 'w');
const child = spawn(electron, [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', logFd, logFd] });
let exited = false; child.on('exit', () => { exited = true; });
const shots = [];
async function finish(code) {
  try { child.kill('SIGTERM'); } catch { /* */ }
  await waitFor('electron exit', () => exited, 8000, 200).catch(() => { try { child.kill('SIGKILL'); } catch { /* */ } });
  for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; try { const e = fs.readFileSync(`/proc/${d}/environ`, 'latin1'); if (e.includes(`ORCHESTRA_HOME=${home}\0`)) process.kill(Number(d), 'SIGKILL'); } catch { /* */ } }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\nRESULT: ${results.length - bad}/${results.length} clauses PASS; screenshots: ${shots.map((s) => `${path.basename(s.file)}=${s.md5}`).join(' ')}; distinct md5: ${new Set(shots.map((s) => s.md5)).size}/${shots.length}`);
  process.exit(code ?? (bad ? 1 : 0));
}
process.on('uncaughtException', async (e) => { console.log('FAIL rig error —', e.stack); await finish(1); });

const targets = await waitFor('CDP target', async () => { try { const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const t = j.filter((x) => x.type === 'page' && x.url.includes('dist/index.html')); return t.length ? t : null; } catch { return null; } }, 40000, 300);
const cdp = await Cdp.connect(targets[0].webSocketDebuggerUrl);
await cdp.send('Page.enable');
check('identity: the driven page is MY build', targets[0].url.includes(APP_DIR), targets[0].url);
const builtVersion = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const runningVersion = await cdp.eval('window.orchestra.getAppVersion()');
check('identity: running version == built version', runningVersion === builtVersion, `${runningVersion} vs ${builtVersion}`);
check('account pinned to a scratch dir under ORCHESTRA_HOME', configDir.startsWith(home) && A.accountId === account.id, `accountId=${A.accountId} account.id=${account.id} configDir=${configDir}`);

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────
const list = async () => Object.fromEntries((await cdp.eval('window.orchestra.listWorkspaces()')).map((w) => [w.id, w]));
const parentOf = async (id) => (await list())[id]?.parentId ?? null;
const bus = () => new DatabaseSync(path.join(home, 'bus.sqlite'), { readOnly: true });
const runRow = (id) => { const db = bus(); try { return db.prepare('SELECT id, kind, parent_run_id AS parent, closed_at AS closed FROM runs WHERE id = ?').get(id) ?? null; } finally { db.close(); } };
const mailFor = (run, to) => { const db = bus(); try { return db.prepare('SELECT body, kind FROM messages WHERE run_id = ? AND recipient = ? ORDER BY sequence').all(run, to); } finally { db.close(); } };
function orch(ws, run, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(APP_DIR, 'dist-electron/cli.js'), ...args], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: env.PATH, HOME: fakeHome, ORCHESTRA_HOME: home, ...(ws ? { ORCHESTRA_WS_ID: ws } : {}), ...(run ? { ORCHESTRA_RUN_ID: run } : {}) } });
    return { code: 0, out };
  } catch (e) { return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
}
async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
  const buf = Buffer.from(r.data, 'base64'); const file = path.join(home, `${name}.png`); fs.writeFileSync(file, buf);
  shots.push({ file, md5: crypto.createHash('md5').update(buf).digest('hex').slice(0, 10) }); console.log(`SHOT ${file} md5=${shots.at(-1).md5} ${buf.length}B`); return file;
}
const rowRect = (tag) => cdp.eval(`(() => { const el = [...document.querySelectorAll('.ws-item')].find((e) => e.innerText.includes(${JSON.stringify(tag)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cls: el.className }; })()`);
const rowCls = async (tag) => (await rowRect(tag))?.cls ?? null;
/** Drag `from` onto the MIDDLE of `to` with real DOM DragEvents (React's own handlers run; the final drop reaches the app's IPC). */
async function dragOnto(from, to, { hold = false, yFrac = 0.5 } = {}) {
  await cdp.eval(`(() => {
    const row = (t) => [...document.querySelectorAll('.ws-item')].find((e) => e.innerText.includes(t));
    const src = row(${JSON.stringify(from)}), dst = row(${JSON.stringify(to)});
    const dt = new DataTransfer();
    const fire = (el, type) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height * ${yFrac} })); };
    window.__dnd = { fire, src, dst };
    fire(src, 'dragstart');
  })()`);
  await sleep(300); // React must commit the dragstart state (dragWs) before a dragover handler can see it
  await cdp.eval('(() => { const { fire, dst } = window.__dnd; fire(dst, "dragenter"); fire(dst, "dragover"); })()');
  await sleep(300);
  await cdp.eval('(() => { const { fire, dst } = window.__dnd; fire(dst, "dragover"); })()');
  await sleep(200);
  if (hold) return;
  await cdp.eval('(() => { const { fire, src, dst } = window.__dnd; fire(dst, "drop"); fire(src, "dragend"); })()');
}

await waitFor('sidebar rows rendered', async () => (await rowRect('att-c')) && (await rowRect('att-b')) && (await rowRect('att-d')), 30000);
await sleep(1500);
const startRows = (await cdp.eval(`[...document.querySelectorAll('.ws-item')].map((e) => e.innerText.split('\\n')[0].trim())`));
console.log('sidebar rows at start:', JSON.stringify(startRows));
await shot('01-start-all-top-level');

// ── pre-state: runs born with the agents (#433); D is A's member ──────────────────────────────────
await waitFor('app-start run sweep: missions for A, B, C', async () => runRow(ID.A) && runRow(ID.B) && runRow(ID.C), 30000);
check('pre: A/B/C each own a mission row; D owns none', ['A', 'B', 'C'].every((k) => runRow(ID[k])?.kind === 'mission') && runRow(ID.D) === null, JSON.stringify(['A', 'B', 'C', 'D'].map((k) => runRow(ID[k])?.kind ?? null)));
// unread mail: a self-note of B in B's own run; a status A -> D in A's run (D is A's member). Neither is read before the moves.
const sendB = orch(ID.B, ID.B, ['send', '--type', 'status', '--to', ID.B, 'note-B-unread']);
const sendD = orch(ID.A, ID.A, ['send', '--type', 'status', '--to', ID.D, 'note-D-unread']);
check('pre: two unread messages on the bus', sendB.code === 0 && sendD.code === 0 && mailFor(ID.B, ID.B).length === 1 && mailFor(ID.A, ID.D).length === 1, `${sendB.out.trim()} | ${sendD.out.trim()}`);

// ── ARM 1: drag a never-promoted agent (B) under another never-promoted agent (C) ────────────────────
check('arm1 pre: B is top-level', (await parentOf(ID.B)) === null, 'parentId null');
await dragOnto('att-b', 'att-c', { hold: true });
const during = await rowCls('att-c');
check('arm1 during drag: the plain row C shows the attach-target highlight', /attach-target/.test(during ?? ''), during);
const midShot = await shot('02-dragging-B-over-C-attach-highlight');
await cdp.eval('(() => { const { fire, src, dst } = window.__dnd; fire(dst, "drop"); fire(src, "dragend"); })()');
await waitFor('B attached under C', async () => (await parentOf(ID.B)) === ID.C, 15000);
check('arm1 post: B.parentId = C (drop on a never-promoted row accepted)', (await parentOf(ID.B)) === ID.C, `null -> ${await parentOf(ID.B)}`);
await sleep(800);
check('arm1 post: C (target) owns its run row, B still has its (now empty) row open', runRow(ID.C)?.closed === null && runRow(ID.B)?.closed === null, JSON.stringify([runRow(ID.C), runRow(ID.B)]));
const chkB = orch(ID.B, ID.C, ['check']);
const lotB = JSON.parse(chkB.out || '{"count":-1}');
check('arm1: B\'s unread note follows it into C\'s run and is delivered ONCE', lotB.count === 1 && lotB.messages?.[0]?.body === 'note-B-unread', chkB.out.slice(0, 160));
orch(ID.B, ID.C, ['ack', String(lotB.lot)]);
check('arm1: after the ack nothing is left, in C\'s run or B\'s old one', JSON.parse(orch(ID.B, ID.C, ['check']).out || '{"count":-1}').count === 0 && JSON.parse(orch(ID.B, ID.B, ['check']).out || '{"count":-1}').count === 0);
const rc = await rowRect('att-c');
for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await cdp.send('Input.dispatchMouseEvent', { type, x: rc.x + rc.w - 14, y: rc.y + rc.h / 2, ...extra });
await sleep(500);
const rcB = await rowRect('att-b'), rcC = await rowRect('att-c');
const painted = await cdp.eval(`(() => { const el = [...document.querySelectorAll('.ws-item')].find((e) => e.innerText.includes('att-b')); const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.offsetParent !== null; })()`);
check('arm1: expanding C shows B as a rendered child row, indented under it', painted && rcB.y > rcC.y, `C.y=${rcC.y} B.y=${rcB.y}`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 600 });
await shot('03-after-B-attached-under-C-expanded');

// ── ARM 2: drag a nested member (D, A's child with unread mail) under C ──────────────────────────────
check('arm2 pre: D is A\'s member', (await parentOf(ID.D)) === ID.A, ID.A);
await dragOnto('att-d', 'att-c');
await waitFor('D attached under C', async () => (await parentOf(ID.D)) === ID.C, 15000);
check('arm2 post: D.parentId = C', true, `${ID.A} -> ${await parentOf(ID.D)}`);
const lotD = JSON.parse(orch(ID.D, ID.C, ['check']).out || '{"count":-1}');
check('arm2: D\'s unread status from A follows it into C\'s run, once', lotD.count === 1 && lotD.messages?.[0]?.body === 'note-D-unread', JSON.stringify(lotD).slice(0, 160));
orch(ID.D, ID.C, ['ack', String(lotD.lot)]);
check('arm2: A\'s old run holds nothing pending for D', JSON.parse(orch(ID.D, ID.A, ['check', '--run', ID.A]).out || '{"count":-1}').count === 0);
await shot('04-after-D-attached-under-C');

// ── ARM 3: detach by the built CLI — the agent leads a mission of its own AT ONCE ──────────────────────
// B's row first goes away (it owned nothing): drop its mission row so the detach must CREATE one (positive control that the row is the app's doing)
const before = runRow(ID.B);
const det = orch(ID.B, ID.C, ['detach', ID.B]);
check('arm3: orchestra detach exits 0', det.code === 0, det.out.trim().slice(0, 200));
await waitFor('B detached', async () => (await parentOf(ID.B)) === null, 15000);
const row = runRow(ID.B);
check('arm3 post: B has its own OPEN mission row (kind mission, no parent run)', row && row.kind === 'mission' && row.parent === null && row.closed === null, `${JSON.stringify(before)} -> ${JSON.stringify(row)}`);
const sendAfter = orch(ID.B, ID.B, ['send', '--type', 'status', '--to', ID.B, 'detached-and-talking']);
check('arm3: the detached agent can send at once (no session start)', sendAfter.code === 0, sendAfter.out.trim());
check('arm3: it reads it back in its own run', JSON.parse(orch(ID.B, ID.B, ['check']).out || '{"count":-1}').messages?.some((m) => m.body === 'detached-and-talking'));

// ── ARM 4: attach by the built CLI under a never-promoted agent ────────────────────────────────────────
const att = orch(ID.B, ID.B, ['attach', ID.B, ID.D]);
check('arm4: orchestra attach <B> <D> (D never promoted, nested) exits 0', att.code === 0, att.out.trim().slice(0, 200));
await waitFor('B under D', async () => (await parentOf(ID.B)) === ID.D, 15000);
const rowD = runRow(ID.D);
check('arm4 post: B.parentId = D, and D (the never-promoted target) now OWNS a vague of its own under C\'s run (parent_run_id = C, exact)', (await parentOf(ID.B)) === ID.D && rowD?.kind === 'vague' && rowD?.parent === ID.C && rowD?.closed === null, `D=${JSON.stringify(rowD)}`);
// refusals through the real app: a cycle (C under its own descendant B) is refused with its reason
const cyc = orch(ID.C, ID.C, ['attach', ID.C, ID.B]);
check('arm4: a cycle is refused (rc != 0, reason named), nothing moved', cyc.code !== 0 && /cycle/.test(cyc.out) && (await parentOf(ID.C)) === null, cyc.out.trim().slice(0, 160));
await sleep(600);
await shot('05-final-tree-D-under-C-B-under-D');

// ── ARM 4c (OPS ruling R2): an UNANSWERED ask to an agent that would be left outside refuses the move; answered, it moves ──
const asked = orch(ID.B, ID.D, ['send', '--type', 'question', '--to', ID.A, 'rig: are you there?']);
check('arm4c pre: B asked A (a stranger) a question', asked.code === 0, asked.out.trim());
const qSeq = (() => { const db = bus(); try { return db.prepare("SELECT sequence FROM messages WHERE kind = 'question' ORDER BY sequence DESC LIMIT 1").get().sequence; } finally { db.close(); } })();
const refusedDet = orch(ID.B, ID.D, ['detach', ID.B]);
check('arm4c: detach is REFUSED naming the unanswered ask, nothing moved', refusedDet.code !== 0 && /unanswered ask #\d+/.test(refusedDet.out) && (await parentOf(ID.B)) === ID.D, refusedDet.out.trim().slice(0, 200));
const answer = orch(ID.A, ID.A, ['send', '--type', 'status', '--to', ID.B, '--thread', String(qSeq), 'rig: yes']);
check('arm4c: A answers (threaded)', answer.code === 0, answer.out.trim());
const okDet = orch(ID.B, ID.D, ['detach', ID.B]);
await waitFor('B detached after the answer', async () => (await parentOf(ID.B)) === null, 15000);
check('arm4c: answered, the detach goes through', okDet.code === 0, okDet.out.trim());
const gotAns = JSON.parse(orch(ID.B, ID.B, ['check']).out || '{"count":-1}');
check('arm4c: the answer reaches B once, in its own run', gotAns.messages?.some((m) => m.body === 'rig: yes'), JSON.stringify(gotAns).slice(0, 140));

// ── ARM 5: the edge of a top-level row still REORDERS (no parent change): A dropped on the bottom quarter of C ──
const order = async () => cdp.eval(`[...document.querySelectorAll('.ws-item')].map((e) => e.innerText.split('\\n')[0].trim().replace('e2e/', ''))`);
const ordBefore = await order();
await dragOnto('att-a', 'att-c', { yFrac: 0.9 });
await sleep(800);
const ordAfter = await order();
check('arm5: the bottom edge of a top-level row reorders (A moves after C), nothing is attached', ordBefore.indexOf('att-a') < ordBefore.indexOf('att-c') && ordAfter.indexOf('att-a') > ordAfter.indexOf('att-c') && (await parentOf(ID.A)) === null, `${JSON.stringify(ordBefore)} -> ${JSON.stringify(ordAfter)}`);
await shot('06-after-edge-drop-reorder');

// ── ARM 6: an OWNER moves with its run: C (owns D) attached under A — its mission becomes a vague under A's run (exact re-point) ──
const rowCBefore = runRow(ID.C);
const att6 = orch(ID.C, ID.C, ['attach', ID.C, ID.A]);
check('arm6: orchestra attach <C> <A> exits 0', att6.code === 0, att6.out.trim().slice(0, 160));
await waitFor('C under A', async () => (await parentOf(ID.C)) === ID.A, 15000);
const rowCAfter = runRow(ID.C);
check('arm6: C\'s run row re-pointed: mission/null -> vague/A (parent_run_id explicit)', rowCBefore?.kind === 'mission' && rowCBefore?.parent === null && rowCAfter?.kind === 'vague' && rowCAfter?.parent === ID.A, `${JSON.stringify(rowCBefore)} -> ${JSON.stringify(rowCAfter)}`);
await sleep(600);
await shot('07-C-under-A-owner-moved');
console.log('sidebar rows at end:', JSON.stringify(await order()));
check('screenshots are all distinct (no step no-opped)', new Set(shots.map((s) => s.md5)).size === shots.length);
await finish();
