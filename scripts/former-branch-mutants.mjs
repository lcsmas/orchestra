// #384 G3 — mutate every changed clause once, IN PLACE, and require RED. Per mutant: the needle must occur EXACTLY once (the
// mutant string is verified live), the file is backed up byte-exact, the 4 gating test files run, and the file is restored from
// the backup and compared with `cmp` (a failed restore aborts the whole run). A baseline GREEN of the unmutated tree runs first.
// Run: node scripts/former-branch-mutants.mjs            (≈10-15 min; never run it while another test run reads the tree)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = ['src/shared/former-branch.test.ts', 'src/main/former-branch-rig.test.ts', 'src/renderer/former-branch-wiring.test.ts', 'src/cli/peers-former-branch.test.ts'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const buildCli = () => execFileSync('pnpm', ['run', 'build:cli'], { cwd: ROOT, stdio: 'ignore' });
function runTests() {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', '--no-warnings', ...TESTS], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
  return { rc: r.status, pass: num('pass'), fail: num('fail'), skipped: num('skipped'), failing: [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]) };
}

const FB = 'src/shared/former-branch.ts', WS = 'src/main/workspaces.ts', AC = 'src/main/activity.ts', CLI = 'src/cli/index.ts', SB = 'src/renderer/components/Sidebar.tsx';
const MUTANTS = [
  { id: 'M1 same-name no-op records', file: FB, from: 'if (!before || before === after) return {};', to: 'if (!before) return {};' },
  { id: 'M2 human-created records (no parent-named gate)', file: FB, from: 'if (!ws.namedByParent && !namedByParentAfter) return {};', to: '' },
  { id: 'M3 pin-on-rename ignored (only "before" counts)', file: FB, from: 'if (!ws.namedByParent && !namedByParentAfter) return {};', to: 'if (!ws.namedByParent) return {};' },
  { id: 'M4 records the NEW name, not the previous', file: FB, from: 'return { formerBranch: before };', to: 'return { formerBranch: after };' },
  { id: 'M5 exLabel loses the "ex-" prefix', file: FB, from: 'return f ? `${EX_PREFIX}${f}` : \'\';', to: "return f ? `${f}` : '';" },
  { id: 'M6 withExLabel drops the existing tooltip text', file: FB, from: 'return ex ? `${title} · ${ex}` : title;', to: 'return ex ? ex : title;' },
  { id: 'M7 peers: ex column always present', file: FB, from: "return cells.some((c) => c !== '') ? cells : null;", to: 'return cells;' },
  { id: 'M8 (m2) git rename records the never-displayed LIVE branch', file: WS, from: 'is no name change at all.\n    ...formerBranchPatch(ws, ws.branch, newBranch, opts.namedByParent),', to: 'is no name change at all.\n    ...formerBranchPatch(ws, liveBranch, newBranch, opts.namedByParent),' },
  { id: 'M9 scratch relabel does not record', file: WS, from: '      ...formerBranchPatch(ws, ws.branch, newBranch, opts.namedByParent),\n', to: '' },
  { id: 'M10 git rename does not record', file: WS, from: 'is no name change at all.\n    ...formerBranchPatch(ws, ws.branch, newBranch, opts.namedByParent),\n', to: 'is no name change at all.\n' },
  { id: 'M11 git rename ignores the pin (after) side', file: WS, from: 'is no name change at all.\n    ...formerBranchPatch(ws, ws.branch, newBranch, opts.namedByParent),', to: 'is no name change at all.\n    ...formerBranchPatch(ws, ws.branch, newBranch, undefined),' },
  { id: 'M12 /peers payload drops formerBranch', file: WS, from: '    ...(w.formerBranch ? { formerBranch: w.formerBranch } : {}),\n', to: '' },
  { id: 'M13 CLI prints no ex cell', file: CLI, from: '        ...(exCells ? { ex: exCells[i] } : {}),\n', to: '', cli: true },
  { id: 'M14 CLI ex column moved off the branch', file: CLI, from: "const idCols = exCells ? ['id', 'branch', 'ex', 'repo', 'status']", to: "const idCols = exCells ? ['id', 'branch', 'repo', 'status', 'ex']", cli: true },
  { id: 'M17 out-of-band git rename is not recorded', file: AC, from: '    ...formerBranchPatch(fresh, fresh.branch, live, decision.pin.namedByParent),\n', to: '' },
  { id: 'M18 drift adoption write is not recorded', file: WS, from: ' ...formerBranchPatch(ws, ws.branch, liveBranch, opts.namedByParent) };', to: ' };' },
  { id: 'M19 archived row loses the former name', file: SB, from: 'title={w.formerBranch ? withExLabel(w.branch, w.formerBranch) : undefined}', to: 'title={undefined}' },
  { id: 'M20 (m1) reconciler broadcasts the pre-rename record', file: AC, from: '  void store.upsertWorkspace(updated).catch((e) => alog.swallow("persist status", e));\n  platform.broadcast(\'workspace:update\', updated);\n}\n\n/** Detect the published GitHub Releases', to: '  void store.upsertWorkspace(updated).catch((e) => alog.swallow("persist status", e));\n  platform.broadcast(\'workspace:update\', fresh);\n}\n\n/** Detect the published GitHub Releases' },
  { id: 'M21 (m1) scratch relabel broadcasts the pre-rename record', file: WS, from: "      ...formerBranchPatch(ws, ws.branch, newBranch, opts.namedByParent),\n    };\n    await store.upsertWorkspace(updated);\n    platform.broadcast('workspace:update', updated);", to: "      ...formerBranchPatch(ws, ws.branch, newBranch, opts.namedByParent),\n    };\n    await store.upsertWorkspace(updated);\n    platform.broadcast('workspace:update', ws);" },
  { id: 'M22 (m1) drift adoption broadcasts the pre-rename record', file: WS, from: "...formerBranchPatch(ws, ws.branch, liveBranch, opts.namedByParent) };\n      await store.upsertWorkspace(updated);\n      platform.broadcast('workspace:update', updated);", to: "...formerBranchPatch(ws, ws.branch, liveBranch, opts.namedByParent) };\n      await store.upsertWorkspace(updated);\n      platform.broadcast('workspace:update', ws);" },
  { id: 'M23 (m1) git rename broadcasts the pre-rename record', file: WS, from: "is no name change at all.\n    ...formerBranchPatch(ws, ws.branch, newBranch, opts.namedByParent),\n  };\n  await store.upsertWorkspace(updated);\n  platform.broadcast('workspace:update', updated);", to: "is no name change at all.\n    ...formerBranchPatch(ws, ws.branch, newBranch, opts.namedByParent),\n  };\n  await store.upsertWorkspace(updated);\n  platform.broadcast('workspace:update', ws);" },
  { id: 'M24 (F1) comms skill legend loses the ex column', file: WS, from: 'orchestra peers            # id  branch  [ex]  repo  status   (ex = ex-<former name>, only when some peer was renamed)', to: 'orchestra peers            # id  branch  repo  status' },
  { id: 'M15 sidebar TREE path loses the former name', file: SB, from: '                      w.formerBranch,\n                    )}\n                    onDoubleClick={(e) => startRename(e, w)}\n                  >\n                    {w.branch}', to: '                      undefined,\n                    )}\n                    onDoubleClick={(e) => startRename(e, w)}\n                  >\n                    {w.branch}' },
  { id: 'M16 sidebar REPO path loses the former name', file: SB, from: '                            w.formerBranch,\n                          )}', to: '                            undefined,\n                          )}' },
];

const base = runTests();
console.log(`BASELINE (unmutated)  rc=${base.rc} pass=${base.pass} fail=${base.fail} skipped=${base.skipped}`);
if (base.rc !== 0 || base.fail !== 0 || base.skipped !== 0 || !(base.pass > 0)) { console.log('ABORT: the unmutated tree is not green — a red mutant would prove nothing'); process.exit(2); }

let bad = 0;
for (const m of MUTANTS) {
  const f = path.join(ROOT, m.file);
  const orig = fs.readFileSync(f);
  const text = orig.toString('utf8');
  const hits = text.split(m.from).length - 1;
  if (hits !== 1) { console.log(`ABORT ${m.id}: needle occurs ${hits}× (must be exactly 1)`); process.exit(2); }
  const backup = path.join(ROOT, '.tmp-mutant-backup'); fs.writeFileSync(backup, orig);
  let res;
  try {
    fs.writeFileSync(f, text.replace(m.from, () => m.to));
    const live = fs.readFileSync(f, 'utf8').includes(m.to) && !fs.readFileSync(f).equals(orig);
    if (!live) { console.log(`ABORT ${m.id}: the mutant is not live in the file`); process.exit(2); }
    if (m.cli) buildCli();
    res = runTests();
  } finally {
    fs.writeFileSync(f, orig);
    const same = fs.readFileSync(f).equals(fs.readFileSync(backup));
    fs.rmSync(backup, { force: true });
    if (!same || sha(f) !== crypto.createHash('sha256').update(orig).digest('hex')) { console.log(`FATAL: ${m.file} not restored byte-exact`); process.exit(3); }
    if (m.cli) buildCli();
  }
  const killed = res.rc !== 0 && res.fail > 0;
  if (!killed) bad++;
  console.log(`${killed ? 'RED   ' : 'GREEN!'} ${m.id}  (rc=${res.rc} fail=${res.fail}${killed ? `; killed by: ${res.failing.slice(0, 3).join(' | ')}` : ' — SURVIVED'})`);
}
const gitDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim();
console.log(`\nRESULT  mutants=${MUTANTS.length} killed=${MUTANTS.length - bad} survived=${bad}  tree-after: ${gitDirty ? 'DIRTY\n' + gitDirty : 'clean (git status --porcelain empty)'}`);
process.exit(bad || gitDirty ? 1 : 0);
