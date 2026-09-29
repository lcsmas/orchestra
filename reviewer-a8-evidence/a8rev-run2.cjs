// Real incident geometry: the live login dir's links point into REAL home's .claude; the sync runs under a FAKE home.
const fs = require('node:fs');
const path = require('node:path');
const R = require('./a8rev-rig.cjs');
const { SCR, assertScratch, put } = R;

const shapes = {
  'S0 fake HOME with NO ~/.claude (the literal incident; control: guard must fire)': () => {},
  'S1 CLI-created skeleton (MEASURED: bare `claude -p` under fake HOME) .claude/{backups,sessions,projects}+.claude.json': (fh) => {
    fs.cpSync(path.join(SCR, 'home', '.claude'), path.join(fh, '.claude'), { recursive: true });
    fs.copyFileSync(path.join(SCR, 'home', '.claude.json'), path.join(fh, '.claude.json'));
  },
  'S2 self-tune ensureFoldTargets shape: .claude/{usage-data/,LESSONS.md,CLAUDE.md}': (fh) => {
    const g = path.join(fh, '.claude'); fs.mkdirSync(path.join(g, 'usage-data'), { recursive: true });
    put(path.join(g, 'LESSONS.md'), '# Lessons\n'); put(path.join(g, 'CLAUDE.md'), '@LESSONS.md\n');
  },
  'S3 empty ~/.claude dir': (fh) => { fs.mkdirSync(path.join(fh, '.claude'), { recursive: true }); },
  'S4 partial: only CLAUDE.md (no skills dir, no settings)': (fh) => { put(path.join(fh, '.claude', 'CLAUDE.md'), '# memory only\n'); },
  'S5 partial: all files present but skills/ dir missing': (fh) => {
    R.makeFullSource(fh); fs.rmSync(path.join(fh, '.claude', 'skills'), { recursive: true });
  },
};

(async () => {
  const mods = { cand: await R.bundle('cand'), master: await R.bundle('master') };
  let n = 0;
  for (const [sname, mk] of Object.entries(shapes)) {
    console.log('\n=== ' + sname);
    for (const [vname, mod] of Object.entries(mods)) {
      const t = path.join(SCR, 'run2', `t${++n}`);
      const realHome = path.join(t, 'realhome'); const fakeHome = path.join(t, 'fakehome');
      const login = path.join(t, 'livecfg'); // absolute configDir, OUTSIDE both homes (like ~/.claude-mc pinned by absolute path)
      for (const d of [realHome, fakeHome, login]) { fs.mkdirSync(d, { recursive: true }); assertScratch(d); }
      R.makeFullSource(realHome);
      put(path.join(login, '.credentials.json'), '{"scratch":true}');
      await R.runSync(mod, realHome, login, R.FULL); // mirror built under the REAL home
      const cj = path.join(login, '.claude.json'); const d = JSON.parse(fs.readFileSync(cj, 'utf8')); d.mcpServers['my-own'] = { command: 'mine' }; d.projects = { '/p': { t: 1 } }; fs.writeFileSync(cj, JSON.stringify(d));
      const before = R.state(login);
      mk(fakeHome);
      const warns = await R.runSync(mod, fakeHome, login, R.FULL); // sync under the FAKE home
      const after = R.state(login);
      const hij = Object.entries(after.linkTargets).filter(([k, v]) => before.linkTargets[k] !== v).map(([k, v]) => `${k}=>${v.replace(/^.*run2\//, 'run2/')}`);
      console.log(`  [${vname}] links ${before.links.length} -> ${after.links.length} kept=${JSON.stringify(after.links)} REPOINTED-into-fake-home=${JSON.stringify(hij)}`);
      console.log(`      mcp ${JSON.stringify(before.mcp)} -> ${JSON.stringify(after.mcp)}; manifest.links ${before.manifest.symlinks.length}->${after.manifest.symlinks.length} manifest.mcp ${before.manifest.mcpServers.length}->${after.manifest.mcpServers.length}; warns=${warns.length}`);
    }
  }
})().catch((e) => { console.error('RIG ERROR', e); process.exit(2); });
