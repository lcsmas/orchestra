// #285 self-gate — IN-PLACE mutation sweep of the memory guard. Each mutant edits ONE clause of the real source, runs the unit
// suites + the end-to-end rig (scripts/e2e-memory-guard.mjs: real sampler → real /busStatus → real built CLI), and must turn at least
// the NAMED arm red. Restored by byte-exact backup + `cmp` after every mutant, and `git diff` of the mutated files must be empty at
// the end (the tree must be committed before the sweep). A CLI-affecting mutant rebuilds dist-electron/cli.js (the instrument is
// rebuilt, never reused stale) and the clean build is restored at the end.
//
// HEAVY by the wave rule (a mutation sweep): needs the OPS's heavy-rig token + MemAvailable > 6 GB right before.
// Run: node scripts/memory-guard-mutants.mjs [--only M1,M2] [--no-rig]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKUP = path.join(os.homedir(), '.cache', 'g1-285', 'mutant-backup');
fs.mkdirSync(BACKUP, { recursive: true });
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = args.includes('--no-rig');

const S = 'src/shared/memory-guard.ts';
const M = 'src/main/memory-guard.ts';
const H = 'src/main/hooks-server.ts';
const C = 'src/cli/index.ts';
const ST = 'src/main/memory-guard-settings.ts';
const V = 'src/shared/memory-guard-view.ts';
const MA = 'src/main/mem-available.ts';
// `expect` = a substring of the reddened unit test name or the rig arm that MUST be among the red ones.
const MUTANTS = [
  { id: 'M01_held_lte', file: S, find: "if (admission === 'open' && availBytes < t.admissionBytes) {", to: "if (admission === 'open' && availBytes <= t.admissionBytes) {", expect: ['admission_held_boundary', 'b_held'] },
  { id: 'M02_reopen_gte', file: S, find: "admission === 'held' && availBytes > t.admissionBytes + t.releaseMarginBytes) {", to: "admission === 'held' && availBytes >= t.admissionBytes + t.releaseMarginBytes) {", expect: ['admission_reopen_boundary', 'b_reopen'] },
  { id: 'M03_pause_due_lte', file: S, find: 'return availBytes < t.criticalBytes;', to: 'return availBytes <= t.criticalBytes;', expect: ['pause_due_boundary', 'b_pause_due'] },
  { id: 'M04_pause_lift_gte', file: S, find: 'return availBytes > t.admissionBytes;', to: 'return availBytes >= t.admissionBytes;', expect: ['pause_lift_boundary', 'b_pause_lift'] },
  { id: 'M05_release_gte', file: S, find: 'return availBytes > t.admissionBytes + t.releaseMarginBytes;', to: 'return availBytes >= t.admissionBytes + t.releaseMarginBytes;', expect: ['may_release_boundary'] },
  { id: 'M06_cadence_lte', file: S, find: 'return availBytes < t.admissionBytes ? SAMPLE_FAST_MS : SAMPLE_SLOW_MS;', to: 'return availBytes <= t.admissionBytes ? SAMPLE_FAST_MS : SAMPLE_SLOW_MS;', expect: ['nextSampleDelayMs', 'cadence_injected'] },
  { id: 'M07_pause_lift_plus_margin', file: S, find: 'return availBytes > t.admissionBytes;', to: 'return availBytes > t.admissionBytes + t.releaseMarginBytes;', expect: ['pause_lift_boundary', 'b_pause_lift'] },
  { id: 'M08_episode_not_counted', file: S, find: 'episode += 1;', to: 'episode += 0;', expect: ['one_episode_per_crossing', 'episodes'] },
  { id: 'M09_no_hysteresis', file: S, find: "admission === 'held' && availBytes > t.admissionBytes + t.releaseMarginBytes) {", to: "admission === 'held' && availBytes > t.admissionBytes) {", expect: ['hysteresis_band', 'b_reopen'] },
  { id: 'M10_null_is_zero', file: S, find: "return typeof availBytes === 'number' && Number.isFinite(availBytes) && availBytes >= 0;", to: 'return (availBytes ?? 0) >= 0;', expect: ['unmeasured', 'unreadable'] },
  { id: 'M11_pause_due_every_sample', file: S, find: "if (pause === 'none' && memoryPauseDue(availBytes, t)) {", to: 'if (memoryPauseDue(availBytes, t)) {', expect: ['pause_one_per_crossing'] },
  { id: 'M12_fast_20s', file: S, find: 'export const SAMPLE_FAST_MS = 10_000;', to: 'export const SAMPLE_FAST_MS = 20_000;', expect: ['nextSampleDelayMs', 'cadence'] },
  { id: 'M13_slow_120s', file: S, find: 'export const SAMPLE_SLOW_MS = 60_000;', to: 'export const SAMPLE_SLOW_MS = 120_000;', expect: ['nextSampleDelayMs', 'cadence'] },
  { id: 'M14_default_8gb', file: S, find: 'export const DEFAULT_ADMISSION_GB = 6;', to: 'export const DEFAULT_ADMISSION_GB = 8;', expect: ['settings default'] },
  { id: 'M15_margin_2gb', file: S, find: 'export const RELEASE_MARGIN_GB = 1;', to: 'export const RELEASE_MARGIN_GB = 2;', expect: ['admission_reopen_boundary', 'b_reopen'] },
  { id: 'M16_settings_read_once', file: M, find: '    settings = readSettings();\n    const t = thresholdsFrom(settings);', to: '    const t = thresholdsFrom(settings);', expect: ['hot_thresholds', 'hot'] },
  { id: 'M17_transition_not_logged', file: M, find: "if (tr.kind === 'admission_held' || tr.kind === 'pause_due') deps.warn(line);\n      else deps.info(line);", to: 'void line;', expect: ['logging', 'walk'] },
  { id: 'M18_unreadable_is_zero', file: M, find: 'reading = deps.readAvailableBytes();', to: 'reading = deps.readAvailableBytes() ?? 0;', expect: ['unreadable'] },
  { id: 'M19_delay_constant', file: M, find: 'delayMs = nextSampleDelayMs(d.measured ? reading : null, t);', to: 'delayMs = 60_000;', expect: ['cadence_injected', 'cadence_default_scheduler'] },
  { id: 'M20_no_rearm', file: M, find: '      delayMs = SAMPLE_FAST_MS;\n      deps.warn(\'sample threw (will retry)\', e);\n    }\n    if (started) arm();', to: "      delayMs = SAMPLE_FAST_MS;\n      deps.warn('sample threw (will retry)', e);\n    }", expect: ['cadence_injected', 'cadence_default_scheduler'] },
  { id: 'M21_busstatus_no_guard', file: H, find: '              memoryGuard: getMemoryGuardSnapshot(),\n', to: '', expect: ['walk', 'b_held'] },
  { id: 'M22_cli_no_line', file: C, find: 'process.stdout.write(`${formatMemoryGuardLine(res.memoryGuard as MemoryGuardSnapshot)}\\n`);', to: 'void 0;', expect: ['walk', 'b_held'], cli: true },
  { id: 'M23_format_held_lowercase', file: S, find: '`admission HELD since ', to: '`admission held since ', expect: ['formatMemoryGuardLine', 'walk'], cli: true },
  { id: 'M24_settings_no_validation', file: ST, find: 'if (!res.ok) return { ok: false, error: res.error, view: memoryGuardView(current) };', to: '', expect: ['invalid pair', 'invalid_refused'] },
  { id: 'M25_settings_no_resample', file: ST, find: '  sampleMemoryGuardNow();\n  const view = memoryGuardView(store.getMemoryGuardSettings());', to: '  const view = memoryGuardView(store.getMemoryGuardSettings());', expect: ['persisted AND applied at once', 'raised_applies_at_once'] },
  // pre-review fixes (c364a283 review): real source, FIFO delivery, edge order, MemTotal bound, sampled flag
  { id: 'M26_real_source_platform', file: MA, find: "export function readMemAvailableBytes(): number | null {\n  if (process.platform !== 'linux') return null;", to: "export function readMemAvailableBytes(): number | null {\n  if (process.platform !== 'darwin') return null;", expect: ['mem-available', 'real_source'] },
  { id: 'M27_nested_delivery_sync', file: M, find: '    if (draining) return;\n', to: '', expect: ['nested_sampleNow'] },
  { id: 'M28_reopen_before_lift', file: S, find: "  if (transitions.length === 2 && transitions[0].kind === 'admission_reopened') transitions.reverse();\n", to: '', expect: ['jump_recovery'] },
  { id: 'M29_total_bound_gt', file: S, find: 's.admissionGb * GIB >= totalBytes', to: 's.admissionGb * GIB > totalBytes', expect: ['validate_total'] },
  { id: 'M30_sampled_never_set', file: M, find: '    sampled = true;\n', to: '', expect: ['sampled: false until'] },
  { id: 'M31_save_error_swallowed', file: ST, find: '  if (saveError) {', to: '  if (false) {', expect: ['a save that FAILS'] },
  { id: 'M32_patch_null_throws', file: S, find: "  if (patch === null || typeof patch !== 'object') return { ok: false, error: 'invalid settings patch' };\n", to: '', expect: ['patch: a null', 'a patch that is null'] },
  // follow-up (review m2-m6): API fields, fresh view, MemTotal bound, non-default settings, modal click handling
  { id: 'M33_mayrelease_last_good', file: M, find: 'mayRelease = d.mayReleaseOneStart;', to: 'mayRelease = availBytes !== null && availBytes > t.admissionBytes + t.releaseMarginBytes;', expect: ['mayReleaseOneStart rides the snapshot'] },
  { id: 'M34_replay_on_subscribe', file: M, find: '    subscribe(listener) {\n      listeners.add(listener);', to: "    subscribe(listener) {\n      listeners.add(listener);\n      if (state.admission === 'held') listener({ transition: { kind: 'admission_held', episode: state.episode, pauseCycle: state.pauseCycle, availBytes: availBytes ?? 0, thresholdBytes: 0 }, snapshot: snapshot() });", expect: ['no_replay'] },
  { id: 'M35_pause_cycle_not_counted', file: S, find: 'pauseCycle += 1;', to: 'pauseCycle += 0;', expect: ['pause_cycle', 'pauseCycle numbers'] },
  { id: 'M36_view_stale_snapshot', file: ST, edits: [{ find: "import { sampleMemoryGuardNow } from './memory-guard.ts';", to: "import { getMemoryGuardSnapshot, sampleMemoryGuardNow } from './memory-guard.ts';" }, { find: 'snapshot: MemoryGuardSnapshot = sampleMemoryGuardNow()', to: 'snapshot: MemoryGuardSnapshot = getMemoryGuardSnapshot()' }], expect: ['memoryGuardView is FRESH'] },
  { id: 'M37_view_live_null', file: ST, find: 'liveAvailBytes: snapshot.measured ? snapshot.availBytes : null,', to: 'liveAvailBytes: null,', expect: ['memoryGuardView is FRESH'] },
  { id: 'M38_total_bound_without_margin', file: S, find: '(admissionGb + RELEASE_MARGIN_GB) * GIB >= totalBytes', to: 'admissionGb * GIB >= totalBytes', expect: ['validate_total'] },
  { id: 'M39_toggle_only_hits_total_bound', file: S, find: 'pairChanged ? totalBytes : undefined', to: 'totalBytes', expect: ['toggle_only_small_host'] },
  { id: 'M40_unreachable_warning_every_sample', file: M, find: '    if (unreachableWarned === key) return;\n', to: '', expect: ['unreachable_warning'] },
  { id: 'M41_unreachable_never_warns', file: M, find: 'if (total === null || !thresholdUnreachable(settings.admissionGb, total)) {', to: 'if (true) {', expect: ['unreachable_warning'] },
  { id: 'M42_toggle_resets_thresholds', file: ST, find: '  const current = store.getMemoryGuardSettings();\n  const res = patchMemoryGuardSettings(', to: '  const current = { admissionGb: 6, criticalGb: 3, admissionEnabled: true };\n  const res = patchMemoryGuardSettings(', expect: ['toggle_keeps_custom_thresholds'] },
  { id: 'M43_patch_enabled_default_true', file: S, find: 'admissionEnabled: patch.admissionEnabled ?? current.admissionEnabled,', to: 'admissionEnabled: patch.admissionEnabled ?? true,', expect: ['patch_merge_keeps_stored_fields', 'toggle_keeps_custom_thresholds'] },
  { id: 'M44_patch_critical_default', file: S, find: 'criticalGb: patch.criticalGb ?? current.criticalGb,', to: 'criticalGb: patch.criticalGb ?? DEFAULT_CRITICAL_GB,', expect: ['patch_merge_keeps_stored_fields', 'toggle_keeps_custom_thresholds'] },
  { id: 'M45_settings_read_failure_defaults', file: M, find: '      return settings; // an unreadable store never changes the thresholds in force', to: '      return DEFAULT_MEMORY_GUARD_SETTINGS;', expect: ['settings_read_failure_keeps_thresholds'] },
  { id: 'M46_toggle_type_unchecked', file: S, find: "  if (typeof s.admissionEnabled !== 'boolean') return 'the toggle must be true or false';\n", to: '', expect: ['validate_toggle_type'] },
  { id: 'M47_echo_wipes_typed_draft', file: UI, find: 'setDraft((d) => (committed !== null && d === committed ? null : d));', to: 'setDraft(null);', expect: ['draft_kept'], ui: true },
  { id: 'M48_toggle_dropped_while_draft', file: UI, find: 'onChange={(e) => void apply({ admissionEnabled: e.target.checked })}', to: 'onChange={(e) => void (draft ? undefined : apply({ admissionEnabled: e.target.checked }))}', expect: ['slow_ipc'], ui: true },
  // Settings dialog view logic (the React component itself is proven by the built-app drive, not here)
  { id: 'V01_gauge_crit_lte', file: V, find: "availBytes < s.criticalGb * GIB ? 'crit'", to: "availBytes <= s.criticalGb * GIB ? 'crit'", expect: ['gauge: ticks'] },
  { id: 'V02_gauge_warn_lte', file: V, find: "availBytes < s.admissionGb * GIB ? 'warn'", to: "availBytes <= s.admissionGb * GIB ? 'warn'", expect: ['gauge: ticks'] },
  { id: 'V03_chip_pause_ignored', file: V, find: "if (s.pause === 'held') return", to: "if (false) return", expect: ['chip: HELD'] },
  { id: 'V04_commit_always_patch', file: V, find: "  if (admissionGb === current.admissionGb && criticalGb === current.criticalGb) return { kind: 'unchanged' };\n", to: '', expect: ['commit: a valid changed pair'] },
  { id: 'V05_commit_no_validation', file: V, find: "  if (error !== null) return { kind: 'invalid', error: `${error.charAt(0).toUpperCase()}${error.slice(1)}.` };\n", to: '', expect: ['commit: invalid pairs'] },
  { id: 'V06_comma_decimal', file: V, find: ".replace(',', '.')", to: '', expect: ['parseGbInput'] },
];

const TESTS = ['src/main/mem-available.test.ts', 'src/shared/memory-guard.test.ts', 'src/shared/memory-guard-view.test.ts', 'src/main/memory-guard.test.ts', 'src/main/memory-guard-settings.test.ts', 'src/main/memory-guard-wiring.test.ts'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, ...opts });

function unitRed() {
  const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...TESTS]);
  const names = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  return { names, pass, skipped, status: r.status };
}
function rigRed() {
  if (noRig) return { arms: [], line: '(rig skipped)' };
  const r = sh(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, path.join(HERE, 'e2e-memory-guard.mjs')]);
  const out = r.stdout ?? '';
  const arms = [...out.matchAll(/^FAIL (\w+)/gm)].map((m) => m[1]);
  const pass = (out.match(/^PASS \w+/gm) ?? []).length;
  return { arms, pass, line: (out.split('\n').filter((l) => l.startsWith('MEMORY-GUARD RIG')).pop() ?? `no summary (exit ${r.status})`) };
}
function modalRed() {
  if (noRig) return { fails: [], pass: 0, line: '(modal rig skipped)' };
  const r = sh(process.execPath, [path.join(HERE, 'e2e-memory-guard-modal.mjs')]);
  const out = r.stdout ?? '';
  return { fails: [...out.matchAll(/^\s+FAIL\s+(\S+)/gm)].map((m) => m[1]), pass: (out.match(/^\s+PASS\s/gm) ?? []).length, line: (out.split('\n').filter((l) => l.startsWith('MODAL RIG')).pop() ?? `no summary (exit ${r.status})`).slice(0, 120) };
}
const buildCli = () => { const r = sh('pnpm', ['run', 'build:cli']); if (r.status !== 0) throw new Error(`build:cli failed: ${r.stderr}`); };

// ── guard: the tree must be committed (git diff is the independent restoration proof) ──
const files = [...new Set(MUTANTS.map((m) => m.file))];
const dirty = sh('git', ['diff', '--quiet', '--', ...files, ...TESTS, 'scripts/e2e-memory-guard.mjs']).status !== 0;
if (dirty) { console.error('REFUSING: the mutated files / suites / rig have uncommitted changes — commit first (the end-of-sweep `git diff` must prove restoration)'); process.exit(2); }
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
buildCli();

// ── POSITIVE CONTROL: the unmutated tree must be all green, else every "killed" below is vacuous ──
const base = unitRed();
const baseRig = rigRed();
const baseModal = modalRed();
console.log(`BASELINE unit: pass ${base.pass} fail ${base.names.length} skipped ${base.skipped} | rig: ${baseRig.line} | modal: ${baseModal.line}`);
if (base.names.length || base.status !== 0 || base.skipped !== 0 || baseRig.arms.length || (!noRig && baseRig.pass !== 9) || baseModal.fails.length || (!noRig && baseModal.pass !== 9)) { console.error('BASELINE NOT GREEN — aborting (nothing was mutated)'); process.exit(3); }

const rows = [];
let restoreBad = false;
const restore = (m, backupFile) => {
  fs.copyFileSync(backupFile, path.join(REPO, m.file));
  if (spawnSync('cmp', ['-s', backupFile, path.join(REPO, m.file)]).status !== 0) { restoreBad = true; console.error(`RESTORE FAILED for ${m.file} — stop and fix by hand: git checkout -- ${m.file}`); }
};
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const abs = path.join(REPO, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  const edits = m.edits ?? [{ find: m.find, to: m.to }];
  let mutated = original; let anchorBad = null;
  for (const e of edits) { const c = mutated.split(e.find).length - 1; if (c !== 1) { anchorBad = `find occurs ${c}× (need exactly 1): ${e.find.slice(0, 60)}`; break; } mutated = mutated.replace(e.find, () => e.to); }
  if (anchorBad) { rows.push({ id: m.id, verdict: 'ANCHOR-BAD', detail: anchorBad }); continue; }
  const backupFile = path.join(BACKUP, `${m.id}.orig`);
  fs.writeFileSync(backupFile, original);
  const onSig = () => { restore(m, backupFile); process.exit(130); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  try {
    fs.writeFileSync(abs, mutated);
    if (fs.readFileSync(abs, 'utf8') === original) { rows.push({ id: m.id, verdict: 'NO-OP', detail: 'the mutation changed nothing' }); continue; }
    if (m.cli) buildCli();
    const u = unitRed();
    const r = rigRed();
    const mo = m.ui ? modalRed() : { fails: [] };
    const red = [...u.names, ...r.arms.map((a) => `rig:${a}`), ...mo.fails.map((a) => `modal:${a}`)];
    const hit = m.expect.filter((e) => red.some((n) => n.includes(e)));
    rows.push({ id: m.id, verdict: hit.length > 0 ? 'KILLED' : red.length ? 'KILLED-BUT-NOT-BY-NAMED-ARM' : 'SURVIVED', detail: `named ${JSON.stringify(m.expect)} hit ${JSON.stringify(hit)}; red: ${red.slice(0, 4).join(' | ')}${red.length > 4 ? ` (+${red.length - 4})` : ''}` });
  } finally {
    restore(m, backupFile);
    process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig);
    if (m.cli) buildCli();
  }
}
const after = Object.fromEntries(files.map((f) => [f, sha(f)]));
const sameSha = files.every((f) => before[f] === after[f]);
const gitClean = sh('git', ['diff', '--quiet', '--', ...files]).status === 0;
const post = unitRed();
const postRig = rigRed();
const postModal = modalRed();
for (const r of rows) console.log(`${r.verdict.padEnd(30)} ${r.id.padEnd(30)} ${r.detail}`);
const killed = rows.filter((r) => r.verdict === 'KILLED').length;
console.log(`RESTORED: sha-identical ${sameSha} · git diff clean ${gitClean} · cmp-restore ${!restoreBad} · post-sweep unit fail ${post.names.length} rig ${postRig.line} modal ${postModal.line}`);
console.log(`MUTANTS: ${killed}/${rows.length} killed by their NAMED arm${rows.length === killed ? '' : ` — NOT ALL: ${rows.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id}=${r.verdict}`).join(', ')}`}`);
process.exit(rows.length === killed && sameSha && gitClean && !restoreBad && post.names.length === 0 && postModal.fails.length === 0 ? 0 : 1);
