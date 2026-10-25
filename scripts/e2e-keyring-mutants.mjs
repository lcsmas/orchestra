#!/usr/bin/env node
// #389 — built-app mutants for scripts/e2e-keyring.sh. Each mutant is applied to a COPY of the built app (dist/ + dist-electron/ copied, everything
// else symlinked), never to the original, so "restore byte-exact" is a hash proof that the ORIGINAL bundles are untouched before/after, plus a
// `cmp` that the copy differs from the original in exactly the mutated bundle. The mutant's regex must match EXACTLY ONCE (verified live). The arm that
// must catch it is run through the SAME rig on the mutant and must go RED naming the expected clause; an UNMUTATED copy is run first (must be GREEN),
// so the copy mechanism itself is not what reddens the arm.
//
// Usage: node scripts/e2e-keyring-mutants.mjs <built-app-dir> [--only E1,E5]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const APP = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
if (!APP) { console.log('usage: node scripts/e2e-keyring-mutants.mjs <built-app-dir> [--only E1,E5]'); process.exit(2); }
const only = (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const BASE = process.env.E2E_RIG_BASE || path.join(process.env.HOME, '.cache/e2e-keyring-389');
fs.mkdirSync(path.join(BASE, 'mutants'), { recursive: true });

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const mainBundle = () => fs.readFileSync(path.join(APP, 'dist-electron/main.js'), 'utf8').match(/require\("\.\/(index-[^"]+\.js)"\)/)[1];
const rendererBundle = () => fs.readdirSync(path.join(APP, 'dist/assets')).filter((f) => /^index-.*\.js$/.test(f) && fs.readFileSync(path.join(APP, 'dist/assets', f), 'utf8').includes('data-secrets-notice'))[0];
const MAIN = () => `dist-electron/${mainBundle()}`;
const REND = () => `dist/assets/${rendererBundle()}`;

/** [id, bundle(), regex, replacement, arm, clause that must go RED, what the mutant removes] */
const MUTANTS = [
  ['E1', MAIN, /(\w+)==="unlocked"\?\{store:"gnome-libsecret"/, '($1==="unlocked"||$1==="locked")?{store:"gnome-libsecret"', 'locked', 'locked/decision-logged', 'selects libsecret on a LOCKED collection'],
  ['E2', MAIN, /(\w+)==="unlocked"\?\{store:"gnome-libsecret"/, 'false?{store:"gnome-libsecret"', 'unlocked', 'unlocked/state-encrypted', 'never selects libsecret'],
  ['E3', MAIN, /if\(\w+\(e\.env\)\)return\{store:null,reason:"recognised-desktop"\};/, '', 'recognised', 'recognised/decision-logged', 'overrides a recognised desktop\'s own choice'],
  ['E4', MAIN, /(\w+)\(\)\.then\((\w)=>\{\2\.reencrypted\|\|/, 'Promise.resolve({reencrypted:0,failed:0,skipped:null}).then($2=>{$2.reencrypted||', 'unlocked', 'unlocked/file-re-encrypted', 'no re-encryption at all (startup or Settings)'],
  ['E12', MAIN, /if\(\w+\(e\.env\)\)return\{store:null,reason:"isolated-instance"\};/, '', 'isolated', 'isolated/decision-logged', 'an ORCHESTRA_HOME instance binds to a reachable keyring (the human\'s, in a real rig) — runs only against the PRIVATE world'],
  ['E13', MAIN, /\(\((\w)=(\w)\.ORCHESTRA_KEYRING\)==null\?void 0:\1\.trim\(\)\)!=="probe"/, 'true', 'unlocked', 'unlocked/decision-logged', 'ORCHESTRA_KEYRING=probe no longer opts a rig in'],
  ['E10', MAIN, /return (\w+)\.encrypted&&\1\.plaintextEntries>0&&\w+\("settings"\),\1/, 'return $1', 'gnome', 'gnome/file-re-encrypted', 'Settings never re-attempts the re-encryption'],
  ['E11', MAIN, /\(\w+==null\?void 0:\w+\.store\)==="gnome-libsecret"&&(\w+\("startup"\))/, '$1', 'gnome', 'gnome/startup-did-not-touch-secrets', 'startup re-encryption without our own unlocked probe (touches a recognised desktop\'s keyring)'],
  ['E5', MAIN, /\w+&&e\.exportBusAddress\([^;]*\);/, '', 'unlocked', 'unlocked/state-encrypted', 'does not hand libsecret the probed bus (Electron\'s `disabled:` stays)'],
  ['E6', MAIN, /timeout:e\.timeoutMs\?\?\w+,killSignal:"SIGKILL"/, 'killSignal:"SIGKILL"', 'hung', 'hung/decision-logged', 'the probe has no timeout (a hung Secret Service stalls startup)'],
  ['E7', REND, /if\(!(\w+)\|\|\1\.encrypted\)return null;const (\w+)="Secrets are stored/, 'if(true)return null;const $2="Secrets are stored', 'nosvc', 'nosvc/linear-warning', 'the warning is never shown'],
  ['E8', REND, /if\(!(\w+)\|\|\1\.encrypted\)return null;const (\w+)="Secrets are stored/, 'if(!$1)return null;const $2="Secrets are stored', 'unlocked', 'unlocked/linear-no-warning', 'the warning is shown even when encryption works'],
  ['E9', MAIN, /encrypted:(\w+)\.isEncryptionAvailable\(\)/, 'encrypted:true', 'nosvc', 'nosvc/state-not-encrypted', 'the state always claims encrypted'],
];

function makeCopy(id) {
  const dst = path.join(BASE, 'mutants', id);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(APP)) {
    if (['.git', '.orchestra', '.claude'].includes(name)) continue;
    const src = path.join(APP, name), to = path.join(dst, name);
    if (name === 'dist' || name === 'dist-electron') fs.cpSync(src, to, { recursive: true });
    else fs.symlinkSync(src, to);
  }
  return dst;
}
function runRig(dir, arm, label) {
  const r = spawnSync(path.join(HERE, 'e2e-keyring.sh'), [dir, '--arms', arm, '--label', label], { encoding: 'utf8', timeout: 420000, cwd: path.join(HERE, '..') });
  const out = `${r.stdout}\n${r.stderr}`;
  const verdict = /^VERDICT: (.*)$/m.exec(out)?.[1] ?? `(no VERDICT line; rc ${r.status})`;
  const red = /^RED: (.*)$/.exec(verdict)?.[1]?.split(', ') ?? [];
  return { verdict, red, out, rc: r.status };
}

const origHashes = () => Object.fromEntries([`dist-electron/main.js`, MAIN(), REND()].map((p) => [p, sha(path.join(APP, p))]));
const before = origHashes();
let bad = 0;
const rows = [];

if (!only.length || only.includes('CTL')) {
  const dir = makeCopy('CTL');
  const r = runRig(dir, 'unlocked,nosvc', 'M-CTL');
  const ok = r.verdict.startsWith('ALL GREEN');
  console.log(`CTL (unmutated COPY, arms unlocked+nosvc) → ${r.verdict}`);
  if (!ok) { bad++; console.log(r.out.split('\n').filter((l) => /FAIL|REFUSED|ABORT/.test(l)).slice(0, 10).join('\n')); }
  rows.push(['CTL', ok ? 'GREEN (as required)' : 'NOT GREEN', 'the copy mechanism does not by itself redden an arm']);
  fs.rmSync(dir, { recursive: true, force: true });
}

for (const [id, bundle, re, rep, arm, clauseName, what] of MUTANTS) {
  if (only.length && !only.includes(id)) continue;
  const rel = bundle();
  const dir = makeCopy(id);
  const target = path.join(dir, rel);
  const txt = fs.readFileSync(target, 'utf8');
  const matches = [...txt.matchAll(new RegExp(re.source, re.flags + (re.flags.includes('g') ? '' : 'g')))];
  if (matches.length !== 1) { console.log(`${id}: VOID — the pattern matches ${matches.length}× in ${rel} (must be exactly 1)`); bad++; rows.push([id, 'VOID', what]); fs.rmSync(dir, { recursive: true, force: true }); continue; }
  const matched = matches[0][0];
  fs.writeFileSync(target, txt.replace(re, rep));
  const differs = !fs.readFileSync(target).equals(fs.readFileSync(path.join(APP, rel)));
  if (!differs) { console.log(`${id}: VOID — the mutation changed nothing`); bad++; rows.push([id, 'VOID', what]); fs.rmSync(dir, { recursive: true, force: true }); continue; }
  console.log(`${id}: mutating ${rel}: "${matched.slice(0, 90)}" → "${txt.replace(re, rep).slice(matches[0].index, matches[0].index + rep.length + 10).slice(0, 90)}" · arm ${arm}`);
  const r = runRig(dir, arm, `M-${id}`);
  const killed = r.verdict.startsWith('RED') && r.red.includes(clauseName);
  const wrongReason = r.verdict.startsWith('RED') && !r.red.includes(clauseName);
  if (!killed) bad++;
  console.log(`${id}: ${killed ? 'KILLED' : wrongReason ? 'RED BUT NOT THE EXPECTED CLAUSE' : 'SURVIVED'} — wanted ${clauseName}; ${r.verdict.slice(0, 400)}`);
  rows.push([id, killed ? `KILLED (${r.red.length} red: ${r.red.slice(0, 4).join(', ')})` : r.verdict.slice(0, 120), what]);
  fs.rmSync(dir, { recursive: true, force: true });
}

const after = origHashes();
const same = JSON.stringify(before) === JSON.stringify(after);
console.log(`ORIGINAL bundles sha256 before/after the whole mutation run: ${same ? 'IDENTICAL' : 'CHANGED'} ${JSON.stringify(Object.fromEntries(Object.entries(after).map(([k, v]) => [path.basename(k), v.slice(0, 12)])))}`);
if (!same) bad++;
console.log(`\n${rows.filter((r) => /^KILLED|GREEN/.test(r[1])).length}/${rows.length} as required; ${bad ? `${bad} PROBLEM(S)` : 'no survivors, no voids'}`);
process.exit(bad ? 1 : 0);
