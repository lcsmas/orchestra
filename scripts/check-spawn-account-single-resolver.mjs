#!/usr/bin/env node
// #480 gate: a child workspace's account is decided ONLY by `resolveChildAccount` (src/shared/spawn-account.ts), called exactly once, from
// `createWorkspace` in src/main/workspaces.ts (the funnel every child-creating path goes through). So: no other src file may call it, and the
// record build in workspaces.ts (and any other src/main file: the renderer only DISPLAYS a repo's account) must not read a repo's `.accountId` into a pin on its own.
//   node scripts/check-spawn-account-single-resolver.mjs [--root <repo>]   → CLEAN (RC 0) | DIRTY (RC 1)
//   node scripts/check-spawn-account-single-resolver.mjs --self-test       → positive + negative control
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FUNNEL = 'src/main/workspaces.ts';
const MODULE = 'src/shared/spawn-account.ts';
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));

export function check(root) {
  const bad = [];
  let calls = 0;
  for (const f of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8');
    const n = (text.match(/\bresolveChildAccount\(/g) ?? []).length;
    if (rel === MODULE) continue;
    if (rel === FUNNEL) { calls = n; continue; }
    if (n) bad.push(`${rel}: calls resolveChildAccount (only ${FUNNEL} may)`);
    if (rel.startsWith('src/main/') && /accountId:\s*[^,\n]*repos?\.find|\brepos\.find\([^\n]*\)\??\.accountId/.test(text)) bad.push(`${rel}: pins a repo's account on its own`);
  }
  if (calls !== 1) bad.push(`${FUNNEL}: resolveChildAccount called ${calls}× (want exactly 1)`);
  const funnel = fs.readFileSync(path.join(root, FUNNEL), 'utf8');
  if (/\brepos\.find\([^\n]*\)\??\.accountId/.test(funnel)) bad.push(`${FUNNEL}: reads a repo's .accountId outside the resolver`);
  return bad;
}

export function selfTest() {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'spawn-account-gate-'));
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), body); };
  put(MODULE, 'export function resolveChildAccount() {}\n');
  put(FUNNEL, 'const a = resolveChildAccount({});\n');
  put('src/main/other.ts', 'export const x = 1;\n');
  const clean = check(tmp);
  put('src/main/other.ts', 'const a = resolveChildAccount({});\n');
  const dirty1 = check(tmp);
  put('src/main/other.ts', 'export const x = 1;\n');
  put(FUNNEL, 'const a = resolveChildAccount({});\nconst p = store.repos.find((r) => r.path === p)?.accountId;\n');
  const dirty2 = check(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  const ok = clean.length === 0 && dirty1.length > 0 && dirty2.length > 0;
  return { ok, clean: clean.length, secondCaller: dirty1.length, repoPin: dirty2.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
if (process.argv.includes('--self-test')) {
  const r = selfTest();
  console.log(`self-test ${r.ok ? 'OK' : 'FAIL'}: clean=${r.clean} second-caller=${r.secondCaller} repo-pin=${r.repoPin}`);
  process.exit(r.ok ? 0 : 1);
}
const ri = process.argv.indexOf('--root');
const root = ri > -1 ? path.resolve(process.argv[ri + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bad = check(root);
console.log(bad.length ? `DIRTY\n${bad.join('\n')}` : 'CLEAN');
process.exit(bad.length ? 1 : 0);
}
