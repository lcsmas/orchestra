const fs = require('node:fs'); const path = require('node:path'); const R = require('./rig.cjs'); const { SCR, assertScratch, put } = R;
(async () => {
  const mod = await R.bundle('cand');
  const t = path.join(SCR, 'run3'); const home = path.join(t, 'home'); const login = path.join(t, 'cfg'); const dot = path.join(t, 'dotfiles');
  for (const d of [home, login, dot]) { fs.mkdirSync(d, { recursive: true }); assertScratch(d); }
  // dotfiles-style: ~/.claude is a SYMLINK to a real dir
  R.makeFullSource(dot); fs.renameSync(path.join(dot, '.claude.json'), path.join(home, '.claude.json'));
  fs.symlinkSync(path.join(dot, '.claude'), path.join(home, '.claude'));
  const w = await R.runSync(mod, home, login, R.FULL);
  const s = R.state(login);
  console.log(`symlinked-source: warns=${w.length} links=${s.links.length} mcp=${JSON.stringify(s.mcp)}  (expect 0 warns, 7 links)`);
  // desired MCP empty + json missing + prevKeys non-empty (MB shape): candidate keeps
  fs.rmSync(path.join(home, '.claude.json'));
  const w2 = await R.runSync(mod, home, login, { settings: true });
  const s2 = R.state(login);
  console.log(`MB-shape (json missing, nothing desired, prevKeys=3): warns=${w2.length} mcp=${JSON.stringify(s2.mcp)} manifest.mcp=${JSON.stringify(s2.manifest.mcpServers)}`);
})().catch((e) => { console.error('RIG ERROR', e); process.exit(2); });
