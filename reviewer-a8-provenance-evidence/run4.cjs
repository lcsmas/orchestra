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
  const mods = { cand: await R.bundle('cand'), master: await R.bundle('master') };

  // ---------- D. a refused (foreign) sync writes NOTHING (spy + full fingerprint incl. mtime/ino) ----------
  console.log('\n##D foreign sync writes nothing: fs-write spy + fingerprint(login tree + fake home tree), incl mtime/ino');
  for (const legacy of [false, true]) for (const [sn, mk] of Object.entries(SHAPES)) {
    const t = T(); const { login } = await liveMirror(mods.cand, t, { legacy });
    const fake = path.join(t, 'fakehome'); fs.mkdirSync(fake); mk(fake);
    const before = { l: fp(login), f: fp(fake), p: fs.readdirSync(path.dirname(login)).sort() };
    let warns; const calls = await spy(async () => { warns = await R.runSync(mods.cand, fake, login, R.FULL); });
    const after = { l: fp(login), f: fp(fake), p: fs.readdirSync(path.dirname(login)).sort() };
    const dl = diffFp(before.l, after.l); const df = diffFp(before.f, after.f);
    line(`  ${legacy ? 'legacy ' : 'stamped'} ${sn}: fs-writes=${calls.length} loginDiff=${dl.length} fakeHomeDiff=${df.length} parentListingSame=${JSON.stringify(before.p) === JSON.stringify(after.p)} warns=${warns.length}`, calls.length ? JSON.stringify(calls.slice(0, 4)) : '');
  }
  { // positive controls for the instruments: master strips (writes recorded, fp differs); cand fresh account writes
    const t = T(); const { login } = await liveMirror(mods.master, t);
    const fake = path.join(t, 'fakehome'); fs.mkdirSync(fake); SHAPES.S1(fake);
    const b = fp(login); let w; const calls = await spy(async () => { w = await R.runSync(mods.master, fake, login, R.FULL); });
    line(`  CONTROL master S1 (strips): fs-writes=${calls.length} loginDiff=${diffFp(b, fp(login)).length}`);
    const t2 = T(); const home = path.join(t2, 'h'); fs.mkdirSync(home); R.makeFullSource(home); const l2 = path.join(t2, 'fresh');
    const c2 = await spy(async () => { await R.runSync(mods.cand, home, l2, R.FULL); });
    line(`  CONTROL cand fresh account (must write): fs-writes=${c2.length} links=${okLinks(l2)}`);
  }

  // ---------- A. legitimate sync refused? ----------
  console.log('\n##A legitimate sync refused forever?');
  for (const legacy of [false, true]) for (const [vn, spell] of [['trailing-slash HOME', (h) => h + '/'], ['double-slash HOME', (h) => h + '//'], ['dot-dot HOME', (h) => h + '/sub/..']]) {
    const t = T(); const { realHome, login } = await liveMirror(mods.cand, t, { legacy });
    fs.mkdirSync(path.join(realHome, 'sub'), { recursive: true });
    const w = await R.runSync(mods.cand, spell(realHome), login, { settings: true });
    line(`  ${legacy ? 'legacy ' : 'stamped'} ${vn}: warns=${w.length} links=${okLinks(login)} (expect 4 = de-selection pruned)`, w.length ? w[0].slice(0, 120) : '');
  }
  for (const legacy of [false, true]) { // HOME renamed/moved: login dir lives inside HOME (~/.claude-mc), links go dangling
    for (const [vn, mod] of Object.entries(mods)) {
      const t = T(); const h1 = path.join(t, 'h1'); const h2 = path.join(t, 'h2'); fs.mkdirSync(h1);
      R.makeFullSource(h1); const l1 = path.join(h1, '.claude-mc'); put(path.join(l1, '.credentials.json'), '{}');
      await R.runSync(mod, h1, l1, R.FULL); if (legacy && vn === 'cand') unstamp(l1);
      fs.renameSync(h1, h2); const l2 = path.join(h2, '.claude-mc');
      const before = brief(l2);
      const w = await R.runSync(mod, h2, l2, R.FULL);
      line(`  HOME RENAMED h1->h2 ${legacy ? 'legacy ' : 'stamped'} [${vn}]: warns=${w.length} before=${JSON.stringify(before)} after=${JSON.stringify(brief(l2))}`, w.length ? '\n      WARN: ' + w[0].slice(0, 200).replace(SCR, '<SCR>') : '');
    }
  }
  { // poisoned stamp: never-synced live dir first synced by a fake-HOME app, fake home later deleted, real app syncs
    for (const [vn, mod] of Object.entries(mods)) {
      const t = T(); const realHome = path.join(t, 'realhome'); const fake = path.join(t, 'fakehome'); const login = path.join(t, 'livecfg');
      for (const d of [realHome, fake, login]) fs.mkdirSync(d); R.makeFullSource(realHome); put(path.join(login, '.credentials.json'), '{}');
      SHAPES.S2(fake); await R.runSync(mod, fake, login, R.FULL); const afterFake = brief(login);
      fs.rmSync(fake, { recursive: true, force: true });
      const w = await R.runSync(mod, realHome, login, R.FULL);
      line(`  POISONED STAMP [${vn}]: after fake sync=${JSON.stringify(afterFake)}; fake home deleted; REAL sync warns=${w.length} -> ${JSON.stringify(brief(login))}`, w.length ? '\n      WARN: ' + w[0].slice(0, 160).replace(SCR, '<SCR>') : '');
    }
  }

  // ---------- B. legacy manifest + alias + dangling link ----------
  console.log('\n##B legacy manifest, HOME alias, one link dangling (a skill/import deleted from the source)');
  for (const [vn, mod] of Object.entries(mods)) for (const alias of [true, false]) for (const legacy of [true, false]) {
    if (vn === 'master' && legacy === false) continue;
    const t = T(); const { realHome, login } = await liveMirror(mod, t, { legacy: legacy && vn === 'cand' });
    fs.rmSync(path.join(realHome, '.claude', 'RTK.md'));
    let home = realHome; if (alias) { home = path.join(t, 'homealias'); fs.symlinkSync(realHome, home); }
    const b = brief(login); const w = await R.runSync(mod, home, login, R.FULL);
    line(`  [${vn}] ${alias ? 'ALIAS' : 'same-path'} ${legacy ? 'legacy' : 'stamped'}: warns=${w.length} links ${b.links}->${brief(login).links} (RTK.md dangling link ${fs.existsSync(path.join(login, 'RTK.md')) || fs.lstatSync(path.join(login, 'RTK.md'), { throwIfNoEntry: false }) ? 'still present' : 'dropped'})`, w.length ? '\n      WARN: ' + w[0].slice(0, 170).replace(SCR, '<SCR>') : '');
  }

  // ---------- C. links present but manifest empty / absent / torn ----------
  console.log('\n##C live-like links present, manifest NOT listing them (master-reset / deleted / torn) -> fake-HOME sync');
  const MANS = { 'emptied (what master writes after its strip)': (l) => fs.writeFileSync(manifestP(l), JSON.stringify({ symlinks: [], mcpServers: [] }, null, 2)), 'absent': (l) => fs.rmSync(manifestP(l)), 'torn (truncated mid-write)': (l) => { const s = fs.readFileSync(manifestP(l), 'utf8'); fs.writeFileSync(manifestP(l), s.slice(0, Math.floor(s.length / 2))); } };
  for (const [mn, mk] of Object.entries(MANS)) for (const sn of ['S1', 'S2', 'S4', 'S5']) for (const vn of ['cand']) {
    const t = T(); const { login } = await liveMirror(mods[vn], t); mk(login);
    const fake = path.join(t, 'fakehome'); fs.mkdirSync(fake); SHAPES[sn](fake);
    const b = R.state(login); const bb = brief(login); const w = await R.runSync(mods[vn], fake, login, R.FULL); const a = R.state(login);
    const repointed = Object.keys(a.linkTargets).filter((k) => b.linkTargets[k] !== undefined && b.linkTargets[k] !== a.linkTargets[k]).length;
    line(`  manifest ${mn} / ${sn} [${vn}]: links ${b.links.length}->${a.links.length} repointed-into-fake=${repointed} dropped=${b.links.filter((l) => !a.links.includes(l)).length} bak=${brief(login).bak} mcp ${b.mcp.length}->${a.mcp.length} warns=${w.length} stamped-now=${(readM(login) || {}).source ? 'FAKE' : 'none'}`);
  }
  { const t = T(); const { login } = await liveMirror(mods.master, t); const fake = path.join(t, 'fakehome'); fs.mkdirSync(fake); SHAPES.S1(fake); fs.writeFileSync(manifestP(login), JSON.stringify({ symlinks: [], mcpServers: [] }));
    const b = R.state(login); await R.runSync(mods.master, fake, login, R.FULL); const a = R.state(login); line(`  (master, same emptied manifest / S1): links ${b.links.length}->${a.links.length}  mcp ${b.mcp.length}->${a.mcp.length}`); }

  // ---------- E. provenance keyed on ~/.claude only; MCP source is ~/.claude.json ----------
  console.log('\n##E fake HOME whose ~/.claude is a SYMLINK to the live source (sameDir true) but has its own skeleton ~/.claude.json');
  for (const [vn, mod] of Object.entries(mods)) {
    const t = T(); const { realHome, login } = await liveMirror(mod, t); const fake = path.join(t, 'fakehome'); fs.mkdirSync(fake);
    fs.symlinkSync(path.join(realHome, '.claude'), path.join(fake, '.claude')); put(path.join(fake, '.claude.json'), '{"numStartups":1}');
    const b = R.state(login); const w = await R.runSync(mod, fake, login, R.FULL); const a = R.state(login);
    line(`  [${vn}] links ${b.links.length}->${a.links.length} mcp ${JSON.stringify(b.mcp)} -> ${JSON.stringify(a.mcp)} warns=${w.length}`);
  }

  // ---------- F. fresh account ----------
  console.log('\n##F first sync on a fresh account');
  { const t = T(); const home = path.join(t, 'h'); fs.mkdirSync(home); R.makeFullSource(home); const login = path.join(t, 'brand-new');
    const w = await R.runSync(mods.cand, home, login, R.FULL); line(`  absent login dir: warns=${w.length} ${JSON.stringify(brief(login))}`); }
  { const t = T(); const home = path.join(t, 'h'); fs.mkdirSync(home); R.makeFullSource(home); const login = path.join(t, 'brand-new');
    const w = await R.runSync(mods.cand, home, login, undefined); line(`  inherit undefined: warns=${w.length} ${JSON.stringify(brief(login))}`); }
})().catch((e) => { console.error('RIG ERROR', e); process.exit(2); });
