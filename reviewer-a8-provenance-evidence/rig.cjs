// reviewer-a8 attack rig — scratch-only. Bundles REAL account-inherit.ts (cand|master) with stubs, runs it
// against scratch mirrors of a live login dir under skeletal-source shapes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const SCR = fs.readFileSync('/home/lmas/rva8/scratch-path', 'utf8').trim();
const REPO = '/home/lmas/.orchestra/worktrees/orchestra-happy-canyon-c3282afc';
if (!SCR.startsWith('/home/lmas/rva8/scr')) throw new Error('ABORT bad scratch ' + SCR);
const REAL_HOME = os.userInfo().homedir;
function assertScratch(p) {
  const r = path.resolve(p);
  if (!r.startsWith(SCR + path.sep)) throw new Error('SAFETY: ' + r + ' outside scratch');
  const rel = path.relative(REAL_HOME, r);
  if (rel.split(path.sep)[0].startsWith('.claude')) throw new Error('SAFETY: live claude dir ' + r);
}
const esbuild = createRequire(REPO + '/package.json')(REPO + '/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild');

async function bundle(name) {
  const root = path.join(SCR, name);
  assertScratch(root);
  const out = path.join(SCR, `${name}.bundle.cjs`);
  const stubs = {
    store: 'export const store = { accounts: [] };',
    logger:
      "const rec = (level) => (msg) => { globalThis.__logs.push({ level, msg: String(msg) }); };\n" +
      "export const log = { warn: rec('warn'), info: rec('info'), error: rec('error'), debug: rec('debug') };",
  };
  await esbuild.build({
    entryPoints: [path.join(root, 'src/main/account-inherit.ts')],
    outfile: out, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^\.\/(store|logger)$/ }, (a) => ({ path: a.path.slice(2), namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'ts' }));
      },
    }],
  });
  return createRequire(out)(out);
}

const put = (p, b) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
function makeFullSource(home) {
  const g = path.join(home, '.claude');
  put(path.join(g, 'settings.json'), '{"model":"opus"}\n');
  put(path.join(g, 'CLAUDE.md'), '@RTK.md\n@LESSONS.md\n\n# global\n');
  put(path.join(g, 'RTK.md'), '# rtk\n');
  put(path.join(g, 'LESSONS.md'), '# lessons\n');
  put(path.join(g, 'statusline-command.sh'), '#!/bin/sh\necho hi\n');
  put(path.join(g, 'skills', 'frontend-design', 'SKILL.md'), '# fd\n');
  put(path.join(g, 'skills', 'handoff', 'SKILL.md'), '# handoff\n');
  put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh' }, 'linear-server': { url: 'u' }, 'chrome-devtools': { command: 'cd' } } }));
}
const FULL = { settings: true, statusline: true, skills: ['frontend-design', 'handoff'], mcpServers: ['github', 'linear-server', 'chrome-devtools'] };

function state(login) {
  const links = {};
  const walk = (d, rel) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name); const r = rel ? rel + '/' + e.name : e.name;
      if (fs.lstatSync(p).isSymbolicLink()) links[r] = fs.readlinkSync(p).replace(SCR, '<SCR>');
      else if (e.isDirectory()) walk(p, r);
    }
  };
  walk(login, '');
  let mcp = null; try { mcp = Object.keys(JSON.parse(fs.readFileSync(path.join(login, '.claude.json'), 'utf8')).mcpServers || {}).sort(); } catch {}
  let man = null; try { man = JSON.parse(fs.readFileSync(path.join(login, '.orchestra-inherited.json'), 'utf8')); } catch {}
  return { links: Object.keys(links).sort(), linkTargets: links, mcp, manifest: man && { symlinks: man.symlinks.slice().sort(), mcpServers: man.mcpServers } };
}

async function runSync(mod, home, login, inherit) {
  assertScratch(home); assertScratch(login);
  const prev = process.env.HOME; process.env.HOME = home;
  try {
    if (os.homedir() !== home) throw new Error('HOME redirect failed');
    globalThis.__logs = [];
    await mod.syncAccountInheritance({ id: 'a', label: 'mc', configDir: login, inherit });
    return globalThis.__logs.filter((l) => l.level === 'warn').map((l) => l.msg.replace(SCR, '<SCR>'));
  } finally { if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev; }
}

module.exports = { SCR, REPO, assertScratch, bundle, put, makeFullSource, FULL, state, runSync };
