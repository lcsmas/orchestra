// reviewer-a8-provenance in-place mutants on MY worktree copy of account-inherit.ts (byte-exact backup + cmp restore).
const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
const W = '/home/lmas/.orchestra/worktrees/orchestra-happy-canyon-c3282afc';
const SRC = W + '/src/main/account-inherit.ts'; const BAK = '/home/lmas/rva8/tip-src.bak';
if (!fs.readFileSync(SRC).equals(fs.readFileSync(BAK))) throw new Error('src != backup at start');
const orig = fs.readFileSync(SRC, 'utf8');
const M = [
  ['M1 sameDir catch fail-open (unresolvable stamped source == ours)', "return fs.realpathSync(a) === fs.realpathSync(b);\n  } catch {\n    return false;", "return fs.realpathSync(a) === fs.realpathSync(b);\n  } catch {\n    return true;"],
  ['M2 isInside lexical check = naive string prefix (.claude-x counts inside .claude)', "return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);\n  };\n  if (within(p, dir)) return true;", "return x.startsWith(d);\n  };\n  if (within(p, dir)) return true;"],
  ['M3 isInside realpath fallback fail-open', "return within(fs.realpathSync(p), fs.realpathSync(dir));\n  } catch {\n    return false;", "return within(fs.realpathSync(p), fs.realpathSync(dir));\n  } catch {\n    return true;"],
  ['M14 legacy link target NOT resolved against the link dir (relative symlinks)', "const target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));", "const target = fs.readlinkSync(linkPath);"],
  ['M15 legacy: dangling links skipped (existsSync) instead of judged by target', "if (!isSymlink(linkPath)) continue;", "if (!isSymlink(linkPath) || !fs.existsSync(linkPath)) continue;"],
  ['M16 stamp compared by realpath only when path differs -> compare basename only', "if (prev.source !== undefined) return sameDir(prev.source, globalDir) ? null : prev.source;", "if (prev.source !== undefined) return path.basename(prev.source) === path.basename(globalDir) ? null : prev.source;"],
  ['M17 refuse only when manifest lists >0 links (MCP-only stamped passes)', "if (from !== null) {", "if (from !== null && prev.symlinks.length > 0) {"],
  ['M18 legacy check ignores links whose rel is a skill (skills/*)', "for (const rel of prev.symlinks) {\n    const linkPath = path.join(loginDir, rel);\n    if (!isSymlink(linkPath)) continue;", "for (const rel of prev.symlinks) {\n    if (rel.startsWith('skills/')) continue;\n    const linkPath = path.join(loginDir, rel);\n    if (!isSymlink(linkPath)) continue;"],
  ['M19 stamped: refuse iff stamped source path string differs (no realpath, no alias)', "return sameDir(prev.source, globalDir) ? null : prev.source;", "return path.resolve(prev.source) === path.resolve(globalDir) ? null : prev.source;"],
  ['M20 writeManifest stamp = realpath(globalDir) instead of literal', "writeManifest(loginDir, { source: globalDir,", "writeManifest(loginDir, { source: fs.realpathSync(globalDir),"],
  ['M21 readManifest ignores non-string source (always legacy)', "source: typeof parsed.source === 'string' ? parsed.source : undefined,", "source: undefined,"],
];
const run = () => { const r = spawnSync('node', ['--test', '--experimental-strip-types', 'src/main/account-inherit.test.ts'], { cwd: W, encoding: 'utf8', timeout: 240000 }); const o = r.stdout + r.stderr; const g = (k) => (o.match(new RegExp('^# ' + k + ' (\\d+)', 'm')) || [])[1]; const fails = [...o.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1].replace(/\s+\(.*$/, '').slice(0, 110)); return { pass: g('pass'), fail: g('fail'), skipped: g('skipped'), fails }; };
const log = (s) => process.stdout.write(s + '\n');
let base = run(); log(`CONTROL clean: pass=${base.pass} fail=${base.fail} skipped=${base.skipped}`);
for (const [name, find, rep] of M) {
  const cnt = orig.split(find).length - 1; if (cnt !== 1) { log(`${name}: PATTERN COUNT ${cnt} (skip)`); continue; }
  fs.writeFileSync(SRC, orig.replace(find, () => rep));
  let res; try { res = run(); } finally { fs.writeFileSync(SRC, orig); }
  const restored = fs.readFileSync(SRC).equals(fs.readFileSync(BAK));
  log(`${name}: pass=${res.pass} fail=${res.fail} skipped=${res.skipped} restored=${restored} ${res.fail === '0' ? '**SURVIVOR**' : ''}`);
  for (const f of res.fails.slice(0, 6)) log('     red: ' + f);
}
base = run(); log(`CONTROL clean after: pass=${base.pass} fail=${base.fail} skipped=${base.skipped}; src==backup: ${fs.readFileSync(SRC).equals(fs.readFileSync(BAK))}`);
