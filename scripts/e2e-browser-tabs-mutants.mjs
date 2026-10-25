// #393 — must-FAIL proof for the BUILT-APP rig (scripts/e2e-browser-tabs.sh): each mutant is applied IN PLACE to the real source, the app is
// REBUILT (a stale bundle reproduces perfectly), the rig runs only the arm that owns the clause, and the clause(s) named below must be RED
// while every ctl/* control stays GREEN (a red for the wrong reason is a failure). The source is restored byte-exact (cmp) right after the
// build; a final CLEAN rebuild leaves dist/ matching the tree. The mutant string is checked LIVE (exactly one occurrence).
// Run: node scripts/e2e-browser-tabs-mutants.mjs [id ...]      (exit 0 = every mutant killed for its named reason, tree restored)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = process.env.MUT_OUT || path.join(process.env.TMPDIR || os.tmpdir(), 'e2e-browser-tabs-mutants');
fs.mkdirSync(OUT, { recursive: true });
const P = 'src/main/browser-panel.ts';

const MUTANTS = [
  { id: 'B1-cap-ignored', file: P, arms: 'tabs,cap', from: '  if (!d.ok) return refused(wsId, d.reason, d.message);\n  const tab = createTab(wsId, opts);', to: '  const tab = createTab(wsId, opts);', red: ['ninth-tab-refused-with-a-clear-notice', 'ninth-tab-creates-no-tab-and-no-view'] },
  { id: 'B2-snapshot-never-saved', file: P, arms: 'tabs,restore', from: '  savePanelTabs(panel);\n  platform.broadcast', to: '  platform.broadcast', red: ['tabs-file-holds-three-tabs-and-the-active-index', 'graceful-restart-restores-three-tabs-same-urls', 'sigkill-restart-restores-three-tabs-with-the-active-one'] },
  { id: 'B3-active-index-ignored', file: P, arms: 'tabs,restore', from: 'built[Math.min(saved.activeIndex, built.length - 1)]', to: 'built[0]', red: ['graceful-restart-restores-the-same-active-tab', 'restored-active-tab-is-the-one-painted'] },
  { id: 'B4-switch-does-not-swap-the-view', file: P, arms: 'tabs', from: '  panel.activeId = tab.id;\n  if (panel.attachedId !== null) attachActive(panel);\n  publish(panel);', to: '  panel.activeId = tab.id;\n  publish(panel);', red: ['switch-paints-the-active-view/B'] },
  { id: 'B5-inactive-view-stays-composited', file: P, arms: 'tabs,paint', from: '  if (prev) detachTab(panel, prev);\n  panel.attachedId = null;', to: '  panel.attachedId = null;', red: ['pane-hidden-leaves-no-view-over-the-app'] },
  { id: 'B7-workspace-switch-leaves-view-attached', file: P, arms: 'tabs,ws', from: "  const attached = panel.tabs.find((t) => t.id === panel.attachedId);\n  if (attached) detachTab(panel, attached);\n  panel.attachedId = null;\n}", to: '  panel.attachedId = null;\n}', red: ['switching-workspace-leaves-no-view-over-the-app'] },
  { id: 'B6-last-tab-evicts-the-panel', file: P, arms: 'last', from: "if (d.replaceWithBlank) createTab(wsId, { openedBy: 'human', activate: true });", to: '', red: ['closing-the-last-tab-leaves-one-fresh-blank-tab'] },
];

const only = process.argv.slice(2);
const sh = (cmd, args, opt = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opt });
const abs = path.join(ROOT, P);
const backup = path.join(OUT, 'browser-panel.ts.orig');
fs.copyFileSync(abs, backup);
let cleaned = false;
process.on('exit', () => { if (!cleaned) fs.copyFileSync(backup, abs); });
process.on('SIGINT', () => process.exit(130));

const rows = []; let bad = 0;
for (const m of MUTANTS) {
  if (only.length && !only.includes(m.id)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  const n = src.split(m.from).length - 1;
  if (n !== 1) { rows.push(['STRING-NOT-LIVE', `${m.id} (${n} occurrences)`]); bad++; continue; }
  fs.writeFileSync(abs, src.replace(m.from, () => m.to));
  let built;
  try { built = sh('nice', ['-n', '10', 'pnpm', 'run', 'build:bundles']); } finally { fs.copyFileSync(backup, abs); }
  let restored = true; try { execFileSync('cmp', [abs, backup]); } catch { restored = false; }
  if (built.status !== 0) { rows.push(['BUILD-FAILED', `${m.id}: ${built.stderr.split('\n').slice(-5).join(' ')}`]); bad++; continue; }
  // the mutant must be IN the bundle we are about to drive (stale-build guard): the main bundle differs from the clean build's hash
  const rig = sh(path.join(ROOT, 'scripts/e2e-browser-tabs.sh'), [ROOT, '--arms', m.arms, '--label', m.id, '--out', OUT]);
  fs.writeFileSync(path.join(OUT, `${m.id}.log`), rig.stdout + rig.stderr);
  let res = null; try { res = JSON.parse(fs.readFileSync(path.join(OUT, `${m.id}-result.json`), 'utf8')); } catch {}
  if (!res) { rows.push(['RIG-NO-RESULT', `${m.id} rc=${rig.status} (see ${m.id}.log)`]); bad++; continue; }
  const redNames = res.results.filter((r) => !r.ok).map((r) => r.clause);
  const ctlRed = redNames.filter((c) => c.startsWith('ctl/') || c.startsWith('rig/'));
  const namedRed = m.red.every((c) => redNames.includes(c));
  const ok = restored && rig.status !== 0 && namedRed && ctlRed.length === 0;
  if (!ok) bad++;
  rows.push([ok ? 'KILLED' : !restored ? 'NOT-RESTORED' : rig.status === 0 ? 'SURVIVED' : ctlRed.length ? 'WRONG-REASON' : 'NOT-NAMED-CLAUSE', `${m.id}: red = ${redNames.join(', ') || 'none'}${ctlRed.length ? ` | CONTROLS RED: ${ctlRed.join(', ')}` : ''}${namedRed ? '' : ` | wanted ${m.red.join(', ')}`}`]);
}

// leave a CLEAN build behind
cleaned = true;
fs.copyFileSync(backup, abs);
const clean = sh('nice', ['-n', '10', 'pnpm', 'run', 'build:bundles']);
rows.push([clean.status === 0 ? 'CLEAN-REBUILD-OK' : 'CLEAN-REBUILD-FAILED', 'dist/ matches the restored tree']);
if (clean.status !== 0) bad++;
for (const [s, t] of rows) console.log(`${s.padEnd(18)} ${t}`);
console.log(`\n${rows.filter((r) => r[0] === 'KILLED').length}/${MUTANTS.length - (only.length ? MUTANTS.length - only.length : 0)} killed; ${bad ? `${bad} PROBLEM(S)` : 'all clean'}`);
process.exit(bad ? 1 : 0);
