const fs = require('node:fs'); const path = require('node:path'); const R = require('./rig.cjs'); const { SCR, assertScratch, put } = R;
let n = 0; const T = () => { const t = path.join(SCR, 'run5', `t${++n}`); fs.mkdirSync(t, { recursive: true }); assertScratch(t); return t; };
const manifestP = (l) => path.join(l, '.orchestra-inherited.json'); const readM = (l) => JSON.parse(fs.readFileSync(manifestP(l), 'utf8'));
const unstamp = (l) => { const m = readM(l); delete m.source; fs.writeFileSync(manifestP(l), JSON.stringify(m, null, 2)); };
const line = (...a) => console.log(a.join(' '));
async function mirror(mod, t, inherit) { const realHome = path.join(t, 'realhome'); const login = path.join(t, 'livecfg'); fs.mkdirSync(realHome); fs.mkdirSync(login); R.makeFullSource(realHome); put(path.join(login, '.credentials.json'), '{}'); await R.runSync(mod, realHome, login, inherit); return { realHome, login }; }
const S1 = (fh) => { for (const d of ['backups', 'sessions', 'projects']) fs.mkdirSync(path.join(fh, '.claude', d), { recursive: true }); put(path.join(fh, '.claude.json'), '{"numStartups":1}'); };
(async () => {
  const cand = await R.bundle('cand');
  { // (1) legacy manifest, links restored by hand as RELATIVE symlinks -> same-home legit sync must not be refused
    const t = T(); const { realHome, login } = await mirror(cand, t, R.FULL); unstamp(login);
    for (const l of R.state(login).links) { const p = path.join(login, l); const abs = fs.readlinkSync(p); fs.unlinkSync(p); fs.symlinkSync(path.relative(path.dirname(p), abs), p); }
    const rel = R.state(login).linkTargets; const w = await R.runSync(cand, realHome, login, { settings: true });
    line(`(1) legacy + RELATIVE links, same HOME, de-select skills+statusline: warns=${w.length} links=${R.state(login).links.length} (expect 0 warns, 4 links); sample link before: ${JSON.stringify(Object.entries(rel)[0]).replace(SCR, '<SCR>')}`);
    const t2 = T(); const m2 = await mirror(cand, t2, R.FULL); unstamp(m2.login); for (const l of R.state(m2.login).links) { const p = path.join(m2.login, l); const abs = fs.readlinkSync(p); fs.unlinkSync(p); fs.symlinkSync(path.relative(path.dirname(p), abs), p); }
    const fake = path.join(t2, 'fakehome'); fs.mkdirSync(fake); S1(fake); const b = R.state(m2.login).links.length; const w2 = await R.runSync(cand, fake, m2.login, R.FULL);
    line(`(1b) legacy + RELATIVE links, FAKE HOME S1: warns=${w2.length} links ${b}->${R.state(m2.login).links.length} (expect 7->7 refused)`);
  }
  { // (2) login dir is itself a symlink (dotfiles-style ~/.claude-mc -> dir)
    for (const legacy of [false, true]) {
      const t = T(); const { realHome, login } = await mirror(cand, t, R.FULL); const dot = path.join(t, 'dotfiles-cfg'); fs.renameSync(login, dot); fs.symlinkSync(dot, login); if (legacy) unstamp(login);
      const w = await R.runSync(cand, realHome, login, { settings: true }); line(`(2) login dir is a symlink, ${legacy ? 'legacy' : 'stamped'}, same HOME: warns=${w.length} links=${R.state(login).links.length} (expect 0 warns, 4)`);
      const fake = path.join(t, 'fakehome'); fs.mkdirSync(fake); S1(fake); const w3 = await R.runSync(cand, fake, login, R.FULL); line(`(2b)   ...then FAKE HOME S1: warns=${w3.length} links=${R.state(login).links.length} (expect 4 kept)`);
    }
  }
  { // (3) skills-only account (legacy manifest lists only skills/*), fake home skeleton
    const t = T(); const SK = { skills: ['frontend-design', 'handoff'] }; const { login } = await mirror(cand, t, SK); unstamp(login);
    const fake = path.join(t, 'fakehome'); fs.mkdirSync(fake); S1(fake); fs.mkdirSync(path.join(fake, '.claude', 'skills', 'handoff'), { recursive: true }); put(path.join(fake, '.claude', 'skills', 'handoff', 'SKILL.md'), '# skeleton handoff\n');
    const b = R.state(login); const w = await R.runSync(cand, fake, login, SK); const a = R.state(login);
    line(`(3) legacy skills-only account, fake HOME with a skills/handoff dir: warns=${w.length} links ${b.links.length}->${a.links.length} repointed=${Object.keys(a.linkTargets).filter((k) => a.linkTargets[k] !== b.linkTargets[k]).length} (expect 2->2, 0 repointed)`);
  }
  { // (4) concurrent real + fake sync on a stamped dir
    const t = T(); const { realHome, login } = await mirror(cand, t, R.FULL); const fake = path.join(t, 'fakehome'); fs.mkdirSync(fake); S1(fake);
    const wF = await R.runSync(cand, fake, login, R.FULL), wR = await R.runSync(cand, realHome, login, R.FULL); line(`(4) sequential fake then real: fakeWarns=${wF.length} realWarns=${wR.length} links=${R.state(login).links.length}`);
  }
})().catch((e) => { console.error('RIG ERROR', e); process.exit(2); });
