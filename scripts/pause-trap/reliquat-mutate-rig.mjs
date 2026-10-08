#!/usr/bin/env node
// In-place mutants of the Reliquat kill driven through the REAL-PATH rig (#325): each edits ONE clause of the shipped source (byte-exact backup, restored + `cmp`ed), runs the rig arm that can see it
// (real keeper in a real scope, the production trap, the built CLI — the rig's parent REBUILDS the bundles every run, so a CLI-side mutant is real) and requires the NAMED check(s) to go RED.
// A clean control run gates the harness; every anchor must match EXACTLY ONCE (else PATTERN-GONE). Heavy (real keepers, scopes ≤ 300 MB): hold the heavy-rig token.
//   node scripts/pause-trap/reliquat-mutate-rig.mjs [--only <id>[,<id>…]]   →  last line: RELIQUAT-RIG-MUTANTS: PASS|FAIL (n/N caught)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RIG = path.join(REPO, 'scripts', 'pause-trap', 'reliquat-rig.mjs');
const ONLY = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null;
const PURE = 'src/shared/pause-reliquats.ts', IO = 'src/main/pause-reliquats.ts', SCOPE = 'src/main/pause-reliquats-scope.ts', TRAP = 'src/main/pause-trap.ts', CONS = 'src/shared/pause-consigne.ts', STATUS = 'src/cli/run-status.ts';
const MEMSCOPE = 'src/shared/memory-scope.ts';

/** `arm`: the rig arm that sees the clause; `red`: check ids (the text before the first `:` of the rig's check name) that must ALL go red. */
const M = [
  { id: 'rig-step-removed', file: TRAP, find: "  if (deps.killReliquats && (target === null || !('error' in target))) {", rep: "  if (false && deps.killReliquats && (target === null || !('error' in target))) {", arm: 'reliquat_killed', red: ['env_i_reliquat_killed', 'bilan_lists_the_killed_reliquat', 'run_status_lists_it', 'consigne_shows_it'] },
  { id: 'rig-kills-the-session-too', file: IO, edits: [
    { find: "        if (m.role !== 'reliquat') continue;\n", rep: '' },
    { find: "        const v = judgeReliquat(m.pid, null, scope, listing, protect, kill.read);\n        if (!v.ok) {", rep: "        const v = { ok: true as const, evidence: 'mutant', proc: kill.read(m.pid) as never };\n        if (!v.ok) {" },
    { find: "    const v = judgeReliquat(t.pid, t.startTicks, t.scope, scopeDeps.list(t.scope), protect, kill.read);\n    if (!v.ok) {", rep: "    const v = { ok: true as const, evidence: 'mutant', proc: undefined as never };\n    if (!v.ok) {" },
  ], arm: 'reliquat_killed', red: ['keeper SURVIVES (same pid + start-time)', 'CLI SURVIVES (same pid + start-time)'] },
  { id: 'rig-other-workspace-scope', file: MEMSCOPE, find: '  return p && p.wsId === wsId ? p.gen : null;', rep: '  return p ? p.gen : null;', arm: 'reliquat_killed', red: ['ANOTHER workspace (b, another run): keeper, CLI AND its Reliquat are untouched'] },
  { id: 'rig-only-newest-generation', file: SCOPE, find: '    scopes: (): ScopeRef[] => memberScopes(wsId, e).map(', rep: '    scopes: (): ScopeRef[] => memberScopes(wsId, e).slice(-1).map(', arm: 'old_generation', red: ['old_generation_reliquat_killed'] },
  { id: 'rig-no-scope-still-recorded', file: IO, find: '  if (scopes.length === 0) return null;\n', rep: '', arm: 'no_scope_unchanged', red: ['the Bilan row carries NO `reliquats` key at all (byte-identical to before #325)'] },
  { id: 'rig-status-section-dropped', file: STATUS, find: '    if (a?.reliquats) {\n', rep: '    if (false) {\n', arm: 'reliquat_killed', red: ['run_status_lists_it'] },
  { id: 'rig-consigne-section-dropped', file: CONS, find: '  for (const l of reliquatConsigneLines(c.reliquats, stripControl)) out.push(l);\n', rep: '', arm: 'reliquat_killed', red: ['consigne_shows_it'] },
  { id: 'rig-reliquat-not-in-the-bilan', file: TRAP, find: '        activity.reliquats = mergeReliquats(prior?.reliquats, rep);\n        if (rep.aborted', rep: '        delete activity.reliquats;\n        if (rep.aborted', arm: 'reliquat_killed', red: ['bilan_lists_the_killed_reliquat'] },
];

function runRig(arm) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), RIG, arm], { cwd: REPO, encoding: 'utf8', timeout: 600_000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const red = [...out.matchAll(/^ {2}FAIL (.+?)(?:  \[|$)/gm)].map((m) => m[1]);
  const surv = /SURVIVORS arm=\S+ procs=(\d+) scopes=(\d+)/.exec(out);
  return { out, red, survivors: surv ? Number(surv[1]) + Number(surv[2]) : NaN, pass: /^PASS /m.test(out) };
}
const idOf = (name) => name.split(':')[0];

// Gate 0: a clean control — the rig is green on the unmutated tree (or the mutants prove nothing).
const arms = [...new Set(M.filter((m) => !ONLY || ONLY.has(m.id)).map((m) => m.arm))];
for (const arm of arms) {
  const c = runRig(arm);
  console.log(`control ${arm}: ${c.pass ? 'PASS' : 'RED'} survivors=${c.survivors}`);
  if (!c.pass || c.survivors !== 0) { console.log(`RELIQUAT-RIG-MUTANTS: FAIL — the clean control of ${arm} is not green (${c.red.join(' | ')})\n${c.out.slice(-800)}`); process.exit(1); }
}
const bak = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-rig-mutate-'));
let activeRestore = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { activeRestore?.(); } catch { /* best effort */ } process.exit(130); });
let caught = 0, total = 0;
for (const m of M) {
  if (ONLY && !ONLY.has(m.id)) continue;
  total++;
  const abs = path.join(REPO, m.file);
  const backup = path.join(bak, `${m.id}.bak`);
  fs.copyFileSync(abs, backup);
  const src = fs.readFileSync(abs, 'utf8');
  const edits = m.edits ?? [{ find: m.find, rep: m.rep }];
  const bad = edits.map((e) => ({ e, hits: src.split(e.find).length - 1 })).find((x) => x.hits !== 1);
  if (bad) { console.log(`✗ ${m.id}: PATTERN-GONE — anchor matched ${bad.hits}× in ${m.file}: ${bad.e.find.slice(0, 70)}`); continue; }
  let res;
  activeRestore = () => fs.copyFileSync(backup, abs);
  try {
    fs.writeFileSync(abs, edits.reduce((acc, e) => acc.replace(e.find, () => e.rep), src));
    res = runRig(m.arm);
  } finally {
    fs.copyFileSync(backup, abs); // byte-exact restore
    activeRestore = null;
  }
  const restored = spawnSync('cmp', [abs, backup]).status === 0;
  const want = m.red.filter((r) => !res.red.some((x) => x === r || idOf(x) === r));
  const ok = restored && want.length === 0 && res.survivors === 0;
  if (ok) caught++;
  console.log(`${ok ? '✓' : '✗'} ${m.id} [${m.arm}]: ${res.red.length} red${want.length ? ` — NOT RED: ${want.join(' | ')}` : ` — named checks RED: ${m.red.length}`}${res.survivors === 0 ? '' : ` — SURVIVORS=${res.survivors}`}${restored ? '' : ' — RESTORE FAILED'}`);
}
fs.rmSync(bak, { recursive: true, force: true });
const post = runRig('reliquat_killed');
console.log(`post-restore control: ${post.pass ? 'PASS' : 'RED'} survivors=${post.survivors}`);
const ok = caught === total && post.pass;
console.log(`RELIQUAT-RIG-MUTANTS: ${ok ? 'PASS' : 'FAIL'} (${caught}/${total} caught)`);
process.exit(ok ? 0 : 1);
