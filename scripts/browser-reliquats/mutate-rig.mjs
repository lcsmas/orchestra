#!/usr/bin/env node
// In-place mutants of the browser-Reliquat bridge driven through the REAL-PATH rig (#331): each edits ONE clause of the shipped source (byte-exact backup, restored + `cmp`ed), runs the rig arm that
// can see it (REAL headless Chromium, the real tick with the production deps, the real Pause dure) and requires the NAMED check(s) to go RED. A clean control per arm gates the harness; every anchor must
// match EXACTLY ONCE. HEAVY (real browsers): hold the heavy-rig token + MemAvailable ≥ 6 GB. Two layers that cover each other are removed TOGETHER (an `edits` list), like the unit harness does.
//   node scripts/browser-reliquats/mutate-rig.mjs [--only <id>[,<id>…]]   →  last line: BROWSER-RIG-MUTANTS: PASS|FAIL (n/N caught)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RIG = path.join(REPO, 'scripts', 'browser-reliquats', 'rig.mjs');
const ONLY = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null;
const PURE = 'src/shared/browser-reliquats.ts', IO = 'src/main/browser-reliquats.ts', MON = 'src/main/resource-monitor.ts', TRAP = 'src/main/pause-trap.ts', VIEW = 'src/renderer/components/ResourcesView.tsx', CSS = 'src/renderer/styles.css', CHIP = 'src/shared/browser-chip.ts';

const M = [
  { id: 'brig-bridge-not-installed', file: MON, find: '    browser: productionBrowserBridge(),\n  };\n}', rep: '  };\n}', arm: 'monitor', red: ['pipe_orphan_stopped_at_once', 'port_orphan_stopped_after_window'] },
  { id: 'brig-pause-skips-browsers', file: TRAP, find: '  if (deps.killBrowserReliquats) {', rep: '  if (false && deps.killBrowserReliquats) {', arm: 'pause_dure', red: ['pause_stops_the_orphaned_browsers', 'bilan_lists_the_browsers'] },
  { id: 'brig-live-client-stopped', file: PURE, find: "  if (f.client === 'yes') return { stop: false, why: 'client-connected' };\n", rep: '', arm: 'monitor', red: ['the port-mode orphan with a LIVE CLIENT survives the window (the main process and its group — Chromium retires an idle renderer or two by itself)'],
    edits: [{ find: "  if (f.client === 'yes') return { stop: false, why: 'client-connected' };\n", rep: '' }, { find: "      if (cs === 'unknown' || cs.client !== 'no') { d.warn(`resources: browser reliquat pid ${t.main.pid} withheld — a client appeared / could not be read`); continue; }", rep: '', file: IO }, { find: "lastClientAt: client !== 'no' ? now : (prev?.lastClientAt ?? null)", rep: "lastClientAt: prev?.lastClientAt ?? null" }] },
  { id: 'brig-launcher-alive-stopped', file: PURE, find: '  if (ppid <= 1) return true;\n  return parent !== null && parent.comm === \'systemd\' && parent.ppid <= 1;', rep: '  return true;', arm: 'monitor', red: ['still protected by its client two windows later; the other four untouched'] },
  { id: 'brig-outside-agent-tmp-stopped', file: IO, red: ['must survive (pass 1)'], arm: 'monitor',
    edits: [{ find: '    if (!owner) continue; // the human\'s browser, a default profile, anything outside agent-tmp/: not ours — not even tracked\n', rep: '    const owner = ownerOrNull ?? { wsId: \'x\', prefix: \'/\' };\n' }, { find: '    const owner = profileOwner(parsed.userDataDir, root);', rep: '    const ownerOrNull = profileOwner(parsed.userDataDir, root);' }, { find: 'ownerKnown: d.workspaceKnown(owner.wsId)', rep: 'ownerKnown: true' }] },
  { id: 'brig-idle-window-ignored', file: PURE, find: '  if (idle >= windowMs) return { stop: true,', rep: '  if (true) return { stop: true,', arm: 'monitor', red: ['the port-mode orphan is NOT stopped before the idle window (survives pass 1)'] },
  { id: 'brig-only-the-main-process', file: IO, find: 'members: descendantsOf(table, p.pid) });', rep: 'members: [p] });', arm: 'monitor', red: ['pipe_group_signalled'] },
  // the verifier's blocker: a Chromium main started from the SESSION env (one-string cmdline) must still be classified — the arm launches with the session bus
  { id: 'brig-argv-not-normalized', file: PURE, find: '  const argv = normalizeArgv(rawArgv);', rep: '  const argv = [...rawArgv];', arm: 'session_env', red: ['session_env_pipe_orphan_stopped_at_once', 'session_env_pipe_group_signalled', 'session_env_port_orphan_stopped_after_window', 'session_env_owner_told_per_pass'] },
  // the D-Q4 A' chip, through the REAL page markup + stylesheet in an Electron window under the rig's own headless sway (scripts/browser-reliquats/chip-screenshot.mjs)
  { id: 'brig-chip-never-asked', file: VIEW, find: 'browsers={browsersOf ? browsersOf(row) : null}', rep: 'browsers={null}', arm: 'chip', red: ['chip_on_owning_row', 'chip_tooltip', 'chip_after_docker', 'chip_on_screen', 'chip_singular'] },
  { id: 'brig-chip-remote-shown', file: VIEW, find: 'return row.remote ? null : browserChipOf(view, row.key);', rep: 'return browserChipOf(view, row.key);', arm: 'chip', red: ['no_chip_on_remote_row'] },
  { id: 'brig-chip-zero-shown', file: CHIP, find: '  if (!c || !(c.stopped > 0)) return null;', rep: '  if (!c) return null;', arm: 'chip', red: ['no_chip_at_zero', 'zero_equals_pre_feature'] },
  { id: 'brig-chip-status-colour', file: CSS, find: '.res-chip.browsers { text-transform: none; letter-spacing: 0; }', rep: '.res-chip.browsers { text-transform: none; letter-spacing: 0; color: var(--yellow); border-color: var(--yellow); }', arm: 'chip', red: ['chip_is_grey'] },
];

function runRig(arm) {
  const r = arm === 'chip'
    ? spawnSync('bash', [path.join(REPO, 'scripts', 'e2e-contained-rig.sh'), process.execPath, path.join(REPO, 'scripts', 'browser-reliquats', 'chip-screenshot.mjs')], { cwd: REPO, encoding: 'utf8', timeout: 900_000 })
    : spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), RIG, arm], { cwd: REPO, encoding: 'utf8', timeout: 900_000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const red = [...out.matchAll(/^ {2}FAIL (.+?)(?:  \[|$)/gm)].map((m) => m[1]);
  const surv = /SURVIVORS arm=\S+ procs=(\d+)/.exec(out);
  return { out, red, survivors: surv ? Number(surv[1]) : NaN, pass: /^PASS /m.test(out) };
}
const idOf = (name) => name.split(':')[0];

const arms = [...new Set(M.filter((m) => !ONLY || ONLY.has(m.id)).map((m) => m.arm))];
for (const arm of arms) {
  const c = runRig(arm);
  console.log(`control ${arm}: ${c.pass ? 'PASS' : 'RED'} survivors=${c.survivors}`);
  if (!c.pass || c.survivors !== 0) { console.log(`BROWSER-RIG-MUTANTS: FAIL — the clean control of ${arm} is not green (${c.red.join(' | ')})\n${c.out.slice(-800)}`); process.exit(1); }
}
const bak = fs.mkdtempSync(path.join(os.tmpdir(), 'br-rig-mutate-'));
let activeRestore = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { activeRestore?.(); } catch { /* best effort */ } process.exit(130); });
let caught = 0, total = 0;
for (const m of M) {
  if (ONLY && !ONLY.has(m.id)) continue;
  total++;
  const edits = (m.edits ?? [{ find: m.find, rep: m.rep }]).map((e) => ({ ...e, file: e.file ?? m.file }));
  const files = [...new Set(edits.map((e) => e.file))];
  const backups = new Map();
  let bad = null;
  for (const f of files) {
    const abs = path.join(REPO, f);
    const b = path.join(bak, `${m.id}-${f.replace(/\W/g, '_')}.bak`);
    fs.copyFileSync(abs, b);
    backups.set(f, b);
  }
  const sources = new Map(files.map((f) => [f, fs.readFileSync(path.join(REPO, f), 'utf8')]));
  for (const e of edits) { const hits = sources.get(e.file).split(e.find).length - 1; if (hits !== 1) { bad = { e, hits }; break; } }
  if (bad) { console.log(`✗ ${m.id}: PATTERN-GONE — anchor matched ${bad.hits}× in ${bad.e.file}: ${bad.e.find.slice(0, 70)}`); continue; }
  let res;
  activeRestore = () => { for (const [f, b] of backups) fs.copyFileSync(b, path.join(REPO, f)); };
  try {
    for (const e of edits) sources.set(e.file, sources.get(e.file).replace(e.find, () => e.rep));
    for (const [f, text] of sources) fs.writeFileSync(path.join(REPO, f), text);
    res = runRig(m.arm);
  } finally {
    for (const [f, b] of backups) fs.copyFileSync(b, path.join(REPO, f)); // byte-exact restore
    activeRestore = null;
  }
  const restored = [...backups].every(([f, b]) => spawnSync('cmp', [path.join(REPO, f), b]).status === 0);
  const want = (m.red ?? []).filter((r) => !res.red.some((x) => x === r || idOf(x) === r));
  const ok = restored && want.length === 0 && res.survivors === 0;
  if (ok) caught++;
  console.log(`${ok ? '✓' : '✗'} ${m.id} [${m.arm}]: ${res.red.length} red${want.length ? ` — NOT RED: ${want.join(' | ')}` : ' — named checks RED'}${res.survivors === 0 ? '' : ` — SURVIVORS=${res.survivors}`}${restored ? '' : ' — RESTORE FAILED'}`);
}
fs.rmSync(bak, { recursive: true, force: true });
const post = runRig(arms[0]);
console.log(`post-restore control ${arms[0]}: ${post.pass ? 'PASS' : 'RED'} survivors=${post.survivors}`);
const ok = caught === total && post.pass;
console.log(`BROWSER-RIG-MUTANTS: ${ok ? 'PASS' : 'FAIL'} (${caught}/${total} caught)`);
process.exit(ok ? 0 : 1);
