// #595 — the files a rig can reach, found by WALKING its own command: package.json hops, script files, relative imports, repo-path mentions,
// the bundles it reads (dist/ → the vite entries). The recall check of src/shared/ci-paths.test.ts asserts every rig's declared `paths` ⊇ this closure.
// Pure over a `Tree` (a file listing + reader), so the test can feed fixtures; `repoTree(root)` is the real one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Tree {
  /** Every tracked file, repo-root-relative, `/`-separated. */
  files: string[];
  read(p: string): string;
}

export function repoTree(root: string): Tree {
  let files: string[];
  try { files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 26 }).toString().split('\0').filter(Boolean); }
  catch { files = []; }
  files = files.filter((f) => fs.existsSync(path.join(root, f)));
  return { files, read: (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } } };
}

// What a built artifact is made from: a rig reading one of these runs against the bundle, so the bundle's inputs are the rig's files.
const BUNDLE_BUILDS: { artifact: RegExp; script: string }[] = [
  { artifact: /dist-electron\/cli\.js/, script: 'build:cli' },
  { artifact: /dist-electron\/keeper\.js/, script: 'build:keeper' },
  { artifact: /dist-electron\/acces-mobile\.js/, script: 'build:acces-mobile' },
  { artifact: /dist-electron\/(?:main|preload)\.js|dist\/(?:index\.html|assets|electron)|\bdist\//, script: 'vite build' },
];
/** A directory a text names pulls in its files only when it is a small leaf-ish dir (`scripts/fixtures`); `src/`, `scripts/`, `src/shared` named in a message or an alias are not inputs. */
const MAX_DIR_FILES = 60;
const TEST_FILE = /\.test\.(?:ts|tsx|mjs|cjs|js)$/;
const CODE_FILE = /\.(?:sh|mjs|cjs|js|ts|tsx|py|html)$/;
const JS_FILE = /\.(?:mjs|cjs|js|ts|tsx)$/;
const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];
const PATH_TOKEN = /(?<![\w@.$-])((?:\.{1,2}\/)*(?:[\w.@-]+\/)*[\w@-][\w.@-]*\.(?:mjs|cjs|js|ts|tsx|sh|py|json|md|html|css|yml|yaml|txt|toml|svg|png))(?![\w-])/g;
const DIR_TOKEN = /(?<![\w@.-])((?:src|scripts|packages|docs|build|public|sandbox|\.github|\.claude)\/[\w.@/-]*)/g;
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

/** Comment-only lines carry names that reach nothing (a name in a comment must not widen a rig). */
const code = (t: string): string => t.split('\n').filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l)).join('\n');

export interface Closure { files: Set<string>; /** why each file is in: the file (or command) that reached it. */ via: Map<string, string> }

/** One walker per tree: the direct edges of a file are computed once and shared by every rig's walk. */
export function createWalker(tree: Tree, pkgScripts: Record<string, string>): { closure(command: string): Closure } {
  const have = new Set(tree.files);
  const dirs = new Set<string>();
  for (const f of tree.files) { let d = path.posix.dirname(f); while (d !== '.' && !dirs.has(d)) { dirs.add(d); d = path.posix.dirname(d); } }
  const byBase = new Map<string, string[]>();
  for (const f of tree.files) if (f.startsWith('scripts/')) { const b = path.posix.basename(f); byBase.set(b, [...(byBase.get(b) ?? []), f]); }
  const underDir = (d: string): string[] => { const pre = d.replace(/\/+$/, '') + '/'; return tree.files.filter((f) => f.startsWith(pre)); };
  const resolveRel = (base: string, spec: string): string | null => {
    const joined = path.posix.normalize(path.posix.join(base, spec));
    const stem = joined.replace(/\.(?:js|mjs)$/, '');
    for (const cand of [joined, ...EXTS.map((e) => joined + e), ...(stem !== joined ? ['.ts', '.tsx'].map((e) => stem + e) : [])]) if (have.has(cand)) return cand;
    return null;
  };
  /** Built artifacts a text reads → the build that makes them (a rig reading dist-electron/cli.js runs against src/cli's import graph). */
  const buildSeeds = (c: string): string[] => {
    const out: string[] = [];
    if (/\bvite build\b(?!\s+(?:--config|-c)\b)/.test(c)) out.push('vite.config.ts', 'index.html');
    for (const b of BUNDLE_BUILDS) if (b.artifact.test(c)) out.push(...(b.script === 'vite build' ? ['vite.config.ts', 'index.html'] : buildEntry(b.script)));
    return out;
  };
  const buildEntry = (name: string): string[] => [...(pkgScripts[name] ?? '').matchAll(PATH_TOKEN)].map((m) => m[1]).filter((f) => have.has(f));
  /** Repo files a text names. `run` = this text EXECUTES `pnpm run x` (a command line or a .sh file); a string in a .mjs is a message, not a call. */
  const mentions = (t: string, fromFile: string | null, o: { run: boolean; dirs: boolean }): string[] => {
    const c = code(t); const out: string[] = [];
    if (o.run) for (const m of c.matchAll(/\b(?:pnpm|npm)\s+(?:run\s+)?([\w:.-]+)/g)) if (pkgScripts[m[1]] !== undefined) out.push(`pnpm:${m[1]}`);
    out.push(...buildSeeds(c));
    // `pnpm --dir packages/x run test`: the sub-package IS the rig's code — its whole directory.
    if (o.run) for (const m of c.matchAll(/\bpnpm\s+(?:--dir|-C)\s+(\S+)/g)) { const d = m[1].replace(/^\.\//, '').replace(/\/+$/, ''); if (dirs.has(d)) out.push(...underDir(d)); }
    for (const m of c.matchAll(PATH_TOKEN)) {
      const tok = m[1];
      const plain = tok.replace(/^\.\//, '');
      const rel = tok.startsWith('.') && fromFile ? resolveRel(path.posix.dirname(fromFile), tok) : null;
      if (rel) out.push(rel);
      else if (have.has(plain)) out.push(plain);
      else if (!tok.includes('/')) { const cands = byBase.get(tok); if (cands?.length === 1) out.push(cands[0]); }
    }
    if (o.dirs) for (const m of c.matchAll(DIR_TOKEN)) {
      const tok = m[1].replace(/[/.]+$/, '');
      if (have.has(tok)) out.push(tok); else if (dirs.has(tok) && tok.includes('/')) { const u = underDir(tok); if (u.length <= MAX_DIR_FILES) out.push(...u); }
    }
    return out;
  };
  const memo = new Map<string, string[]>();
  /** Direct edges of one node: a file, or `pnpm:<script>`. */
  const edges = (n: string): string[] => {
    const hit = memo.get(n); if (hit) return hit;
    let out: string[] = [];
    if (n.startsWith('pnpm:')) out = mentions(pkgScripts[n.slice(5)] ?? '', null, { run: true, dirs: true });
    else {
      const t = tree.read(n); const inSrc = n.startsWith('src/'); const js = JS_FILE.test(n);
      if (js) {
        for (const m of code(t).matchAll(IMPORT_SPEC)) {
          const spec = m[2].replace(/[?#].*$/, ''); const r = spec.startsWith('@shared/') ? resolveRel('src/shared', spec.slice(8)) : spec.startsWith('.') ? resolveRel(path.posix.dirname(n), spec) : null;
          if (r) out.push(r);
        }
      }
      // production code (src/) is followed by imports only; a build config names its entries but its dir aliases are not inputs; scripts/shell name what they run.
      // A test file names `src/…` paths to assert about them (no-orchestra-imports.test.ts): its src mentions are not inputs (its imports are, above).
      if (!inSrc) out.push(...mentions(t, n, { run: n.endsWith('.sh'), dirs: !/(?:^|\/)vite[\w.-]*\.config\.ts$/.test(n) }).filter((x) => !(TEST_FILE.test(n) && x.startsWith('src/'))));
    }
    out = [...new Set(out)].filter((x) => x.startsWith('pnpm:') || (have.has(x) && CODE_FILE.test(x)) || have.has(x));
    memo.set(n, out); return out;
  };
  /** Does an edge out of this node hand its src/ targets a transitive walk? Only the build configs / index.html do: a bundle IS its entries' whole import graph. */
  const isBundleRoot = (n: string): boolean => n === 'index.html' || /(?:^|\/)vite[\w.-]*\.config\.ts$/.test(n);
  return {
    // Reach rule (#595): harness code (scripts/, packages/, configs, package.json hops) is followed fully; a src/ file a script imports or names is IN, and its own imports are
    // followed only when it sits in a built bundle's graph (the bundle's entries, via vite config / index.html). A rig linked to a module through a god-module's
    // transitive imports would otherwise claim the whole backend; the full suite unit-tests those deep edges, the release gate runs every rig.
    closure(command: string): Closure {
      const files = new Set<string>(); const via = new Map<string, string>(); const deep = new Set<string>(); const seen = new Set<string>(); const queue: string[] = [];
      const reach = (e: string, from: string, isDeep: boolean): void => {
        const upgrade = isDeep && e.startsWith('src/') && !deep.has(e);
        if (upgrade) deep.add(e);
        if (seen.has(e) && !upgrade) return;
        seen.add(e); if (!via.has(e)) via.set(e, from);
        if (CODE_FILE.test(e) || e.startsWith('pnpm:')) queue.push(e); else files.add(e);
      };
      for (const n of mentions(command, null, { run: true, dirs: true })) reach(n, 'command', false);
      while (queue.length) {
        const n = queue.shift() as string;
        if (!n.startsWith('pnpm:')) files.add(n);
        if (n.startsWith('src/') && !deep.has(n)) continue; // a shallow src file: in the set, not expanded
        const grant = n.startsWith('src/') ? true : isBundleRoot(n);
        for (const e of edges(n)) reach(e, n, e.startsWith('src/') ? grant : false);
      }
      return { files, via };
    },
  };
}

export function rigClosure(tree: Tree, command: string, pkgScripts: Record<string, string>): Closure { return createWalker(tree, pkgScripts).closure(command); }
