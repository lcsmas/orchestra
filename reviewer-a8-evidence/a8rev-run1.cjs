const fs = require('node:fs');
const path = require('node:path');
const R = require('./a8rev-rig.cjs');
const { SCR, assertScratch, put } = R;

const shapes = {
  // measured: what a bare `claude -p` (CLAUDE_CONFIG_DIR unset) left under a fake HOME (copied verbatim below)
  'S1 CLI-created skeleton (.claude/{backups,sessions,projects} + .claude.json w/o mcpServers)': (home) => {
    fs.cpSync(path.join(SCR, 'home', '.claude'), path.join(home, '.claude'), { recursive: true });
    fs.copyFileSync(path.join(SCR, 'home', '.claude.json'), path.join(home, '.claude.json'));
  },
  // self-tune fold's ensureFoldTargets(os.homedir()) output shape (usage-data dir + LESSONS.md + CLAUDE.md with @LESSONS.md)
  'S2 self-tune ensureFoldTargets shape (usage-data/, LESSONS.md, CLAUDE.md)': (home) => {
    const g = path.join(home, '.claude');
    fs.mkdirSync(path.join(g, 'usage-data'), { recursive: true });
    put(path.join(g, 'LESSONS.md'), '# Lessons\n');
    put(path.join(g, 'CLAUDE.md'), '@LESSONS.md\n');
  },
  'S3 empty ~/.claude dir, no ~/.claude.json': (home) => { fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); },
  'S4 partial: CLAUDE.md only (no settings/skills/statusline/imports), ~/.claude.json kept': (home) => {
    const g = path.join(home, '.claude'); put(path.join(g, 'CLAUDE.md'), '# just memory, no imports\n');
  },
  'S5 partial: everything but skills/ dir (skills dir missing), ~/.claude.json kept': (home) => {
    const g = path.join(home, '.claude'); fs.rmSync(path.join(g, 'skills'), { recursive: true });
  },
};

(async () => {
  const mods = { cand: await R.bundle('cand'), master: await R.bundle('master') };
  let n = 0;
  for (const [sname, mk] of Object.entries(shapes)) {
    console.log('\n=== ' + sname);
    for (const [vname, mod] of Object.entries(mods)) {
      const t = path.join(SCR, 'run1', `t${++n}`); const home = path.join(t, 'home'); const login = path.join(home, '.claude-mc');
      fs.mkdirSync(home, { recursive: true }); assertScratch(home);
      R.makeFullSource(home);
      put(path.join(login, '.credentials.json'), '{"scratch":true}');
      const w0 = await R.runSync(mod, home, login, R.FULL); // build mirror with the full source
      const cj = path.join(login, '.claude.json'); const d = JSON.parse(fs.readFileSync(cj, 'utf8')); d.mcpServers['my-own'] = { command: 'mine' }; d.projects = { '/p': { t: 1 } }; fs.writeFileSync(cj, JSON.stringify(d));
      const before = R.state(login);
      // swap the source for the skeletal shape
      fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
      if (sname.startsWith('S1') || sname.startsWith('S2') || sname.startsWith('S3')) fs.rmSync(path.join(home, '.claude.json'), { force: true });
      mk(home);
      const warns = await R.runSync(mod, home, login, R.FULL);
      const after = R.state(login);
      console.log(`  [${vname}] build-warns=${w0.length} links ${before.links.length} -> ${after.links.length}  mcp ${JSON.stringify(before.mcp)} -> ${JSON.stringify(after.mcp)}  manifest.links ${before.manifest.symlinks.length} -> ${after.manifest.symlinks.length}  manifest.mcp ${before.manifest.mcpServers.length} -> ${after.manifest.mcpServers.length}  warns=${JSON.stringify(warns)}`);
      if (vname === 'cand') {
        const repointed = Object.entries(after.linkTargets).filter(([k, v]) => before.linkTargets[k] !== v).map(([k, v]) => `${k}=>${v}`);
        console.log(`     cand links kept: ${JSON.stringify(after.links)}  repointed-vs-before: ${JSON.stringify(repointed)}`);
      }
    }
  }
})().catch((e) => { console.error('RIG ERROR', e); process.exit(2); });
