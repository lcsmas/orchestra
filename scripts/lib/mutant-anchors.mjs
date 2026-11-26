// #665 — read a mutant rig's list WITHOUT running the rig, and check each anchor (the exact string a mutant replaces) still occurs exactly once in its file.
// The rigs' own "REFUSED as stale" check is inline in every runner (`orig.split(from).length - 1 !== 1`), so there is nothing to import: this is the same test, `occurrences()`, in ONE place.
// How the list is read: the script is parsed (TypeScript AST), only the top-level declarations the list depends on are kept (transitively), and those run as a module — the rig's
// own file constants, `T` test tables, helper `const`s — never its runner. Each entry is then normalised by `anchorsOf` (the shapes the rigs use); an entry whose shape is not
// recognised throws, so a new rig can never be skipped silently.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** How many times `find` (a string, or a RegExp such as the keyring rig's) occurs in `text` (non-overlapping), the same count the runners make. An empty `find` never matches. */
export function occurrences(text, find) {
  if (find instanceof RegExp) return (text.match(new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g')) ?? []).length;
  if (typeof find !== 'string' || find === '') return 0;
  return text.split(find).length - 1;
}

const PATHLIKE = /^[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]+$/;

/** The declarations of `file` that `names` need, as a runnable module body (original order). */
export function closureSource(ts, file, text, names) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const declared = new Map(); // top-level name → statement
  const bind = (n, st) => { if (!declared.has(n)) declared.set(n, st); };
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) { if (ts.isIdentifier(d.name)) bind(d.name.text, st); else for (const e of d.name.elements ?? []) if (e.name && ts.isIdentifier(e.name)) bind(e.name.text, st); }
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) bind(st.name.text, st);
    else if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause;
      if (c.name) bind(c.name.text, st);
      if (c.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) bind(c.namedBindings.name.text, st); else for (const e of c.namedBindings.elements) bind(e.name.text, st); }
    }
  }
  const missing = names.filter((n) => !declared.has(n));
  if (missing.length) throw new Error(`${file}: no top-level declaration of ${missing.join(', ')}`);
  const need = new Set(); const queue = [...names];
  const refs = (node, out) => {
    if (ts.isIdentifier(node)) out.add(node.text);
    node.forEachChild((c) => {
      if (ts.isPropertyAccessExpression(node) && c === node.name) return; // `x.name` names a property, not a binding
      if (ts.isPropertyAssignment(node) && c === node.name) return;
      refs(c, out);
    });
  };
  while (queue.length) {
    const n = queue.pop(); const st = declared.get(n);
    if (!st || need.has(st)) continue;
    need.add(st);
    const out = new Set(); refs(st, out);
    for (const r of out) if (declared.has(r) && !need.has(declared.get(r))) queue.push(r);
  }
  const url = pathToFileURL(file).href;
  const parts = [];
  for (const st of sf.statements) {
    if (!need.has(st)) continue;
    let code = st.getText(sf);
    if (ts.isImportDeclaration(st)) {
      const spec = st.moduleSpecifier.text;
      if (spec.startsWith('.')) code = code.replace(st.moduleSpecifier.getText(sf), JSON.stringify(pathToFileURL(path.resolve(path.dirname(file), spec)).href));
    }
    parts.push(code.split('import.meta.url').join(JSON.stringify(url)).split('import.meta.dirname').join(JSON.stringify(path.dirname(file))));
  }
  const ex = names.map((n) => `${JSON.stringify(n)}: ${n}`).join(', ');
  return `${parts.join('\n')}\nexport const __lists = { ${ex} };\n`;
}

let loads = 0;
/** Evaluate `names` (top-level consts of the rig script at `file`) and return their values, keyed by name. */
export async function loadLists(toolRoot, root, scriptRel, names) {
  const require = createRequire(path.join(toolRoot, "package.json"));
  const ts = require('typescript');
  const file = path.join(root, scriptRel);
  const src = closureSource(ts, file, fs.readFileSync(file, 'utf8'), names);
  const dir = path.join(toolRoot, "node_modules", ".cache", "mutant-anchors");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${scriptRel.replace(/[^\w.-]+/g, '_')}.${process.pid}.${++loads}.mjs`); // unique per load: an import() of the same URL is cached
  fs.writeFileSync(tmp, src);
  try { return (await import(pathToFileURL(tmp).href)).__lists; }
  finally { fs.rmSync(tmp, { force: true }); }
}

const isStr = (x) => typeof x === 'string';
const joinDir = (dir, f) => (dir && !f.includes('/') ? `${dir}/${f}` : f);
/** A path inside the tree (an absolute one is a `path.join(ROOT, …)` result); a code string that merely starts with `/` is not. */
const treePath = (root, f) => isStr(f) && (PATHLIKE.test(f) || (!!root && path.isAbsolute(f) && f.startsWith(`${root}/`) && !/\s/.test(f)));
const isFind = (x) => (isStr(x) && x !== '') || x instanceof RegExp;

/** One mutant entry → its anchors `[{ id, file, find }]`; throws on a shape it does not know. `o.dir`: directory of bare file names; `o.file`: the file every entry edits. */
export function anchorsOf(entry, index, o = {}) {
  const fail = (why) => { throw new Error(`mutant #${index}: unrecognised shape (${why}): ${JSON.stringify(entry, (k, v) => (typeof v === 'function' ? '[fn]' : isStr(v) && v.length > 60 ? v.slice(0, 60) + '…' : v)).slice(0, 300)}`); };
  const out = [];
  const fileOf = (f) => joinDir(o.dir, o.root && f.startsWith(`${o.root}/`) ? path.relative(o.root, f) : f);
  const push = (id, file, find, min = null) => {
    if (!treePath(o.root, file)) fail(`file ${JSON.stringify(file)}`);
    if (!isFind(find)) fail('empty or non-string anchor');
    out.push({ id, file: fileOf(file), find, ...(min ? { min } : {}) });
  };
  if (Array.isArray(entry)) {
    const id = isStr(entry[0]) ? entry[0] : `#${index}`;
    if (treePath(o.root, entry[1])) {
      // [id, FILE, from, to…]  |  [id, FILE, [[from, to], …], …]
      if (isStr(entry[2])) push(id, entry[1], entry[2]);
      else if (Array.isArray(entry[2]) && entry[2].length && entry[2].every((e) => Array.isArray(e) && isStr(e[0]))) for (const e of entry[2]) push(id, entry[1], e[0]);
      else fail('array entry with a file but no anchor');
    } else if (Array.isArray(entry[1]) && entry[1].length && entry[1].every(Array.isArray)) {
      // [name, [[FILE, from, to], …]]  |  [name, [[from, to], …]] of the list's file
      for (const e of entry[1]) { if (e.length >= 3 && isStr(e[0]) && isFind(e[1])) push(id, e[0], e[1]); else if (o.file && isFind(e[0])) push(id, o.file, e[0]); else fail('edit array'); }
    } else if (o.file && isFind(entry[1])) {
      // [name, from, to, file?] — the file is the list's (or the 4th element, relative to `dir`)
      push(id, isStr(entry[3]) ? entry[3] : o.file, entry[1]);
    } else fail('array entry');
    return out;
  }
  if (entry && typeof entry === 'object') {
    const id = entry.id ?? entry.name ?? `#${index}`;
    const edits = entry.edits ?? entry.mutations;
    const one = (e, dflt) => {
      if (Array.isArray(e)) {
        if (e.length >= 3 && treePath(o.root, e[0]) && isFind(e[1])) push(id, e[0], e[1]); // [FILE, from, to]
        else if (dflt && isFind(e[0])) push(id, dflt, e[0]); // [from, to] of the entry's file
        else fail('edit array');
      } else if (e && typeof e === 'object') push(id, e.file ?? dflt ?? o.file, e.find ?? e.from ?? e.anchor);
      else fail('edit');
    };
    if (Array.isArray(edits)) { if (!edits.length) fail('no edits'); for (const e of edits) one(e, entry.file ?? o.file); }
    else push(id, entry.file ?? o.file, entry.find ?? entry.from ?? entry.anchor, entry.nth);
    for (const x of [...(Array.isArray(entry.extra) ? entry.extra.filter((x) => x && typeof x === 'object') : []), ...(entry.also ? [entry.also] : [])]) one(x, entry.file ?? o.file); // further steps of the same mutant (`extra: [{ find, put }]`, `also: { find }`)
    return out;
  }
  return fail('neither array nor object');
}

/** Every anchor of `entries` that does not occur exactly once: `[{ id, file, n }]` (`n` = 0 when the file is missing). `read(file)` → text or null. */
export function staleAnchors(anchors, read) {
  const cache = new Map(); const stale = [];
  for (const a of anchors) {
    if (!cache.has(a.file)) cache.set(a.file, read(a.file));
    const text = cache.get(a.file);
    const n = text === null ? 0 : occurrences(text, a.find);
    if (a.min ? n < a.min : n !== 1) stale.push({ id: a.id, file: a.file, n, missing: text === null, find: a.find });
  }
  return stale;
}
