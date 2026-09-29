// reviewer-a8-provenance attack rig — scratch-only (assertScratch in rig.cjs). Real account-inherit.ts (cand|master) bundled with stubs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('./rig.cjs');
const { SCR, assertScratch, put } = R;

let n = 0;
const T = () => { const t = path.join(SCR, 'run4', `t${++n}`); fs.mkdirSync(t, { recursive: true }); assertScratch(t); return t; };
const manifestP = (login) => path.join(login, '.orchestra-inherited.json');
const readM = (login) => { try { return JSON.parse(fs.readFileSync(manifestP(login), 'utf8')); } catch { return null; } };
const unstamp = (login) => { const m = readM(login); delete m.source; fs.writeFileSync(manifestP(login), JSON.stringify(m, null, 2)); };

async function liveMirror(mod, t, { legacy } = {}) {
  const realHome = path.join(t, 'realhome'); const login = path.join(t, 'livecfg');
  fs.mkdirSync(realHome, { recursive: true }); fs.mkdirSync(login, { recursive: true });
  R.makeFullSource(realHome); put(path.join(login, '.credentials.json'), '{"scratch":true}');
  await R.runSync(mod, realHome, login, R.FULL);
  const cj = path.join(login, '.claude.json'); const d = JSON.parse(fs.readFileSync(cj, 'utf8'));
  d.mcpServers['my-own'] = { command: 'mine' }; d.projects = { '/p': { t: 1 } }; fs.writeFileSync(cj, JSON.stringify(d));
  if (legacy) unstamp(login);
  return { realHome, login };
}

const SHAPES = {
  S0: () => {},
  S1: (fh) => { for (const d of ['backups', 'sessions', 'projects']) fs.mkdirSync(path.join(fh, '.claude', d), { recursive: true }); put(path.join(fh, '.claude.json'), '{"numStartups":1}'); },
  S2: (fh) => { const g = path.join(fh, '.claude'); fs.mkdirSync(path.join(g, 'usage-data'), { recursive: true }); put(path.join(g, 'LESSONS.md'), '# L\n'); put(path.join(g, 'CLAUDE.md'), '@LESSONS.md\n'); put(path.join(fh, '.claude.json'), '{"numStartups":1}'); },
  S3: (fh) => fs.mkdirSync(path.join(fh, '.claude'), { recursive: true }),
  S4: (fh) => put(path.join(fh, '.claude', 'CLAUDE.md'), '# memory only\n'),
  S5: (fh) => { R.makeFullSource(fh); fs.rmSync(path.join(fh, '.claude', 'skills'), { recursive: true }); },
};

// ---- write spy + fingerprint ------------------------------------------------
const fsm = require('node:fs');
const SYNC_W = ['writeFileSync', 'mkdirSync', 'symlinkSync', 'unlinkSync', 'renameSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'appendFileSync', 'chmodSync', 'utimesSync', 'linkSync', 'truncateSync'];
const PROM_W = ['mkdir', 'writeFile', 'rm', 'rename', 'unlink', 'symlink', 'appendFile', 'copyFile', 'chmod', 'rmdir'];
async function spy(fn) {
  const calls = []; const savedS = {}; const savedP = {};
  for (const k of SYNC_W) { savedS[k] = fsm[k]; fsm[k] = function (...a) { calls.push(`${k} ${String(a[0])}`); return savedS[k].apply(this, a); }; }
  for (const k of PROM_W) { savedP[k] = fsm.promises[k]; fsm.promises[k] = function (...a) { calls.push(`promises.${k} ${String(a[0])}`); return savedP[k].apply(this, a); }; }
  try { await fn(); } finally { for (const k of SYNC_W) fsm[k] = savedS[k]; for (const k of PROM_W) fsm.promises[k] = savedP[k]; }
  return calls.map((c) => c.replace(SCR, '<SCR>'));
}
function fp(root) {
  const out = {};
  const one = (p, rel) => {
    const st = fs.lstatSync(p);
    let extra = '';
    if (st.isSymbolicLink()) extra = fs.readlinkSync(p);
    else if (st.isFile()) extra = require('node:crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    out[rel || '.'] = `${st.mode.toString(8)}|${st.size}|${st.mtimeMs}|${st.ino}|${extra}`;
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) one(path.join(p, e), (rel ? rel + '/' : '') + e);
  };
  if (fs.existsSync(root)) one(root, '');
  return out;
}
const diffFp = (a, b) => { const keys = new Set([...Object.keys(a), ...Object.keys(b)]); return [...keys].filter((k) => a[k] !== b[k]); };

const okLinks = (login) => R.state(login).links.length;
const brief = (login) => { const s = R.state(login); const bak = fs.readdirSync(login).filter((f) => f.endsWith('.orchestra-bak')).length; return { links: s.links.length, mcp: s.mcp && s.mcp.length, man: s.manifest && `${s.manifest.symlinks.length}/${s.manifest.mcpServers.length}`, src: (readM(login) || {}).source && (readM(login).source).replace(SCR, '<SCR>'), bak, live: s.links.filter((l) => fs.existsSync(path.join(login, l))).length }; };
const line = (...a) => console.log(a.join(' '));

(async () => {
  const mods = { cand: await R.bundle('cand'), proto: await R.bundle('proto') };
  // ---------- C. links present but manifest empty / absent / torn ----------
  console.log('\n##C live-like links present, manifest NOT listing them (master-reset / deleted / torn) -> fake-HOME sync');
  const MANS = { 'emptied (what master writes after its strip)': (l) => fs.writeFileSync(manifestP(l), JSON.stringify({ symlinks: [], mcpServers: [] }, null, 2)), 'absent': (l) => fs.rmSync(manifestP(l)), 'torn (truncated mid-write)': (l) => { const s = fs.readFileSync(manifestP(l), 'utf8'); fs.writeFileSync(manifestP(l), s.slice(0, Math.floor(s.length / 2))); } };
  for (const [mn, mk] of Object.entries(MANS)) for (const sn of ['S1', 'S2', 'S4', 'S5']) for (const vn of ['cand','proto']) {
    const t = T(); const { login } = await liveMirror(mods[vn], t); mk(login);
    const fake = path.join(t, 'fakehome'); fs.mkdirSync(fake); SHAPES[sn](fake);
    const b = R.state(login); const bb = brief(login); const w = await R.runSync(mods[vn], fake, login, R.FULL); const a = R.state(login);
    const repointed = Object.keys(a.linkTargets).filter((k) => b.linkTargets[k] !== undefined && b.linkTargets[k] !== a.linkTargets[k]).length;
    line(`  manifest ${mn} / ${sn} [${vn}]: links ${b.links.length}->${a.links.length} repointed-into-fake=${repointed} dropped=${b.links.filter((l) => !a.links.includes(l)).length} bak=${brief(login).bak} mcp ${b.mcp.length}->${a.mcp.length} warns=${w.length} stamped-now=${(readM(login) || {}).source ? 'FAKE' : 'none'}`);
  }
})().catch((e) => { console.error('RIG ERROR', e); process.exit(2); });
