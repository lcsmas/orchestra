// #322 self-gate — IN-PLACE mutation sweep of the dedicated Plafond mémoire notice row (D-Q7 = B): the pure row builder (red kill / amber warning, command chip, inferred « probably », session ended, external OOM, legacy fallback),
// the fold, the renderer and its markup. Each mutant edits ONE clause of the real source, runs the unit + wiring suites AND the SSR render smoke (scripts/memory-cap-row-render-smoke.mjs), and must turn red at least one NAMED
// test / smoke check. Restored by byte-exact backup + `cmp`; `git diff` of the mutated files must be empty at the end (commit first). NOT heavy (unit + SSR only).
// Run: node scripts/memory-cap-row-mutants.mjs [--only R01,R02] [--check | --check-anchors]
// `expect` = a substring of a reddened unit test title, or `smoke:<check label>` for a failing smoke check — at least one MUST be red. `smoke: true` also runs the smoke.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKUP = path.join(os.homedir(), '.cache', 'h2-322', 'mutant-backup');
const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--only', '--check-anchors', '--check']);
const unknownFlags = args.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
if (unknownFlags.length) { // fail CLOSED: a flag this script does not know must never fall through to the full sweep
  console.error(`REFUSING: unknown option(s) ${unknownFlags.join(' ')} — NOTHING was run. Known: --only ID,ID | --check (alias --check-anchors: dry anchor check, no build / scratch)`);
  process.exit(2);
}
const dryCheck = args.includes('--check-anchors') || args.includes('--check');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = true;

const MN = 'src/shared/mem-notice.ts';
const AE = 'src/shared/agent-events.ts';
const NR = 'src/renderer/components/agent/NoticeRow.tsx';
const CSS = 'src/renderer/agent-view-theme.css';
const MS = 'src/shared/memory-scope.ts';
const TESTS = ['src/shared/mem-notice.test.ts', 'src/renderer/history-backfill.test.ts', 'src/main/memory-notice.test.ts', 'src/main/memory-cap-row-wiring.test.ts'];

const MUTANTS = [
  // ── the row as data (src/shared/mem-notice.ts) ──
  { id: 'R01_back_to_the_warning_row', file: MN, find: "kind: 'memory-cap' as const, text: e.text, memCap: rowOfEntry(e)", to: "kind: 'warning' as const, text: e.text, memCap: rowOfEntry(e)", expect: ['R6 (#322 B)', 'ROW: the builder emits the DEDICATED kind', 'smoke:a kill becomes the memory-cap notice row'], smoke: true },
  { id: 'R02_entry_without_the_row', file: MN, find: "text: memNoticeText(rec), row: memCapRowOf(rec) };", to: "text: memNoticeText(rec) };", expect: ['#322: the entry carries the row text', 'ROW: the builder emits the DEDICATED kind'] },
  { id: 'R03_warning_level_is_red', file: MN, find: "return { tone: 'soft', segments: [{ kind: 'text', text: `Working set", to: "return { tone: 'hard', segments: [{ kind: 'text', text: `Working set", expect: ['R4 (#322 B)', 'smoke:the warning level is AMBER'], smoke: true },
  { id: 'R04_killed_command_is_amber', file: MN, find: "return { tone: 'hard', segments: [{ kind: 'text', text: 'Command' }", to: "return { tone: 'soft', segments: [{ kind: 'text', text: 'Command' }", expect: ['R1 (#322 B)', 'smoke:one line: label'], smoke: true },
  { id: 'R05_inferred_victim_shown_as_certain', file: MN, find: "if (rec.source === 'kernel') return { tone: 'hard', segments: [{ kind: 'text', text: 'Command' }", to: "if (true) return { tone: 'hard', segments: [{ kind: 'text', text: 'Command' }", expect: ['R2 (#322 B)', 'smoke:an INFERRED victim reads'], smoke: true },
  { id: 'R06_chip_never_cut', file: MN, find: "text: cutChars(command, MAX_CHIP_CHARS)", to: "text: command", expect: ['R5 (#322 B)', 'smoke:a long command is cut inside the chip'], smoke: true },
  { id: 'R07_session_ended_not_said', file: MN, find: "const ended = rec.role ? ` — the member's own ${rec.role === 'cli' ? 'agent process' : 'keeper'}: the session ended` : '';", to: "const ended = '';", expect: ['R3 (#322 B)', 'smoke:the member\'s own agent process killed'], smoke: true },
  { id: 'R08_external_oom_blamed_on_the_plafond', file: MN, find: "'by the system under memory pressure (not by the Plafond mémoire)'", to: "'Plafond mémoire reached'", expect: ['R3 (#322 B)', 'smoke:an OOM from outside the scope limit'], smoke: true },
  { id: 'R09_unnamed_command_gets_a_chip', file: MN, find: "if (rec.command === null || rec.command.trim() === '') return { tone: 'hard', segments: [{ kind: 'text', text: `A command was killed", to: "if (rec.command === null || rec.command.trim() === '') return { tone: 'hard', segments: [{ kind: 'chip', text: `A command was killed", expect: ['R2 (#322 B)', 'smoke:a command too brief to be named'], smoke: true },
  { id: 'R10_legacy_entry_always_red', file: MN, find: "{ tone: e.level === 'soft' ? 'soft' : 'hard', segments: [{ kind: 'text', text: e.text }] }", to: "{ tone: 'hard', segments: [{ kind: 'text', text: e.text }] }", expect: ['R7 (#322 B)'] },
  { id: 'R11_notice_without_the_row', file: MN, find: ", text: e.text, memCap: rowOfEntry(e) })", to: ", text: e.text })", expect: ['R6 (#322 B)', 'ROW: the builder emits the DEDICATED kind', 'smoke:the command is in a CHIP'], smoke: true },
  { id: 'R12_soft_row_hides_the_hard_cap', file: MN, find: "${rec.hardBytes !== null ? ` (hard cap ${fmtGb(rec.hardBytes)})` : ''}` }] };", to: "` }] };", expect: ['R4 (#322 B)', 'smoke:the warning level is AMBER'], smoke: true },
  { id: 'R13_kill_without_the_reached_level', file: MN, find: "`${rec.hardBytes !== null ? `${fmtGb(rec.hardBytes)} reached` : 'Plafond mémoire reached'}`", to: "'Plafond mémoire reached'", expect: ['R1 (#322 B)'] },
  // ── the fold ──
  { id: 'R14_fold_drops_the_row', file: AE, find: "...(event.memCap !== undefined ? { noticeMemCap: event.memCap } : {}),", to: "", expect: ['ROW: the builder emits the DEDICATED kind', 'smoke:a kill becomes the memory-cap notice row'], smoke: true },
  // ── the renderer ──
  { id: 'R15_row_not_routed', file: NR, find: "  if (kind === 'memory-cap') return <MemoryCapRow message={message} />;\n", to: "", expect: ['ROW: the builder emits the DEDICATED kind', 'smoke:one line: label'], smoke: true },
  { id: 'R16_row_without_the_chip', file: NR, find: "<code className=\"av-notice-chip\" data-memcap-chip=\"\">", to: "<span data-x=\"\">", expect: ['smoke:the command is in a CHIP', 'ROW: the one-line markup'], smoke: true },
  { id: 'R17_row_tone_class_dropped', file: NR, find: "className={`av-notice av-notice-memory-cap is-${row.tone}`}", to: "className=\"av-notice av-notice-memory-cap\"", expect: ['smoke:one line: label', 'ROW: the one-line markup'], smoke: true },
  { id: 'R18_row_without_the_tooltip', file: NR, find: " title={message.text}>", to: ">", expect: ['smoke:the full plain sentence rides as the tooltip', 'ROW: the one-line markup'], smoke: true },
  { id: 'R19_row_without_the_time', file: NR, find: "{time ? <span className=\"av-notice-tag\">{time}</span> : null}", to: "", expect: ['smoke:one line: label'], smoke: true },
  { id: 'R20_row_label_dropped', file: NR, find: "<span className=\"av-notice-label\">Plafond mémoire</span>", to: "", expect: ['smoke:one line: label'], smoke: true },
  { id: 'R21_row_throws_without_the_structured_row', file: NR, find: "const row = message.noticeMemCap ?? { tone: 'hard' as const, segments: [{ kind: 'text' as const, text: message.text ?? '' }] };", to: "const row = message.noticeMemCap!;", expect: ['smoke:a memory-cap message with no structured row'], smoke: true },
  { id: 'R22_memo_ignores_the_row', file: NR, find: " && a.message.noticeMemCap === b.message.noticeMemCap,", to: ",", expect: ['ROW: the builder emits the DEDICATED kind'] },
  { id: 'R23_segments_glued_without_space', file: NR, find: "{i > 0 ? ' ' : ''}", to: "", expect: ['smoke:the command is in a CHIP'], smoke: true },
  // ── pre-review round: exact wording, boundary, code points, CSS, time ──
  { id: 'R24_chip_boundary_off_by_one', file: MN, find: "export const MAX_CHIP_CHARS = 80;", to: "export const MAX_CHIP_CHARS = 79;", expect: ['R5b'] },
  { id: 'R25_chip_cut_splits_code_points', file: MS, find: "  const chars = Array.from(s);\n  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;", to: "  return s.length > max ? `${s.slice(0, max - 1)}…` : s;", expect: ['R5c'] },
  { id: 'R26_blank_command_gets_an_empty_pill', file: MN, find: "if (rec.command === null || rec.command.trim() === '') return", to: "if (rec.command === null) return", expect: ['R5c'] },
  { id: 'R27_inferred_session_ended_before_the_chip', file: MN, find: "text: `A command was killed ${dash}${reason} · probably` }, chipOf(rec.command), ...(ended ? [{ kind: 'text' as const, text: ended.trimStart() }] : [])]", to: "text: `A command was killed ${dash}${reason}${ended} · probably` }, chipOf(rec.command)]", expect: ['R5d'] },
  { id: 'R28_unnamed_session_ended_dropped', file: MN, find: "(it lived too briefly to be named)${ended}` }] };", to: "(it lived too briefly to be named)` }] };", expect: ['R5d'] },
  { id: 'R29_dash_after_an_external_kill', file: MN, find: "const dash = rec.level === 'hard' ? '— ' : '';", to: "const dash = '— ';", expect: ['R5d', 'R3 (#322 B)'] },
  { id: 'R30_dash_never', file: MN, find: "const dash = rec.level === 'hard' ? '— ' : '';", to: "const dash = '';", expect: ['R5d', 'R1 (#322 B)'] },
  { id: 'R31_hard_without_a_cap_figure_says_nothing', file: MN, find: "${rec.hardBytes !== null ? `${fmtGb(rec.hardBytes)} reached` : 'Plafond mémoire reached'}", to: "${fmtGb(rec.hardBytes ?? 0)} reached", expect: ['R5d'] },
  { id: 'R32_tooltip_sentence_cut_on_code_units', file: MS, find: "const cmd = cutChars(rec.command, 120);", to: "const cmd = rec.command.length > 120 ? `${rec.command.slice(0, 119)}…` : rec.command;", expect: ['R5c'] },
  { id: 'R33_time_is_the_render_instant', file: NR, find: "new Date(message.at).toLocaleTimeString(", to: "new Date().toLocaleTimeString(", expect: ['smoke:the time is the KILL'], smoke: true },
  { id: 'R34_hard_label_loses_its_colour', file: CSS, find: ".av-notice-memory-cap.is-hard .av-notice-label { color: var(--av-error); }", to: "", expect: ['ROW: the one-line markup'] },
  { id: 'R35_soft_label_loses_its_colour', file: CSS, find: ".av-notice-memory-cap.is-soft .av-notice-label { color: var(--av-warn); }", to: "", expect: ['ROW: the one-line markup'] },
  { id: 'R36_time_not_at_the_right', file: CSS, find: ".av-notice-tag { margin-left: auto; flex: none; font-size: 9.5px; }", to: ".av-notice-tag { flex: none; font-size: 9.5px; }", expect: ['ROW: the one-line markup'] },
  { id: 'R37_time_dimmed_below_contrast', file: CSS, find: ".av-notice-tag { margin-left: auto; flex: none; font-size: 9.5px; }", to: ".av-notice-tag { margin-left: auto; flex: none; font-size: 9.5px; opacity: 0.6; }", expect: ['ROW: the one-line markup'] },
  { id: 'R38_command_not_monospace', file: CSS, find: "font-family: var(--av-mono); font-size: 11px; padding: 0 5px;", to: "font-size: 11px; padding: 0 5px;", expect: ['ROW: the one-line markup'] },
  { id: 'R39_light_hard_label_back_to_the_raw_token', file: CSS, find: "{ color: color-mix(in srgb, var(--av-error) 82%, #000); }", to: "{ color: var(--av-error); }", expect: ['ROW: the one-line markup'] },
  { id: 'R40_light_soft_label_back_to_the_raw_token', file: CSS, find: "{ color: color-mix(in srgb, var(--av-warn) 78%, #000); }", to: "{ color: var(--av-warn); }", expect: ['ROW: the one-line markup'] },
];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 500_000, ...opts });

function unitRed() {
  const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...TESTS]);
  const names = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1].replace(/\\([#])/g, '$1'));
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  return { names, pass, skipped, status: r.status };
}
function smokeRed() {
  const r = sh(process.execPath, [path.join(HERE, 'memory-cap-row-render-smoke.mjs')]);
  const out = r.stdout ?? '';
  const fails = [...out.matchAll(/^\s+FAIL (.*?)(?: — .*)?$/gm)].map((m) => `smoke:${m[1]}`);
  if (r.status !== 0 && fails.length === 0) fails.push(`smoke:(crashed, exit ${r.status})`);
  return { fails, pass: (out.match(/^\s+ok /gm) ?? []).length, status: r.status };
}
function rigRed() { return { red: [], pass: 0, line: '(no rig in this harness)' }; }
const buildCli = () => { const r = sh('pnpm', ['run', 'build:cli']); if (r.status !== 0) throw new Error(`build:cli failed: ${r.stderr}`); };
const strays = () => 0;
const _unusedStrays = () => {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try { if (fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').includes('e2e-resilient-watchers.mjs')) out.push(Number(n)); } catch { /* gone */ }
  }
  return out.length;
};
const scratchLeft = () => 0;

const editsOf = (m) => m.edits ?? [{ find: m.find, to: m.to }];
// a restore re-stamps the file: any mutant under src/shared or src/cli (the CLI bundle's inputs) makes the bundle STALE for the next mutant's rig — rebuild around it, always
for (const m of MUTANTS) if (m.file.startsWith('src/shared/') || m.file.startsWith('src/cli/')) m.cli = true;
if (dryCheck) {
  let bad = 0;
  for (const m of MUTANTS) {
    let text = fs.readFileSync(path.join(REPO, m.file), 'utf8'); let why = null;
    for (const e of editsOf(m)) { const c = text.split(e.find).length - 1; if (c !== 1) { why = `${c}× ${e.find.slice(0, 80)}`; break; } text = text.replace(e.find, () => e.to); }
    if (why) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${why}`); }
  }
  console.log(`ANCHORS: ${MUTANTS.length - bad}/${MUTANTS.length} resolve exactly once`);
  process.exit(bad ? 1 : 0);
}
fs.mkdirSync(BACKUP, { recursive: true }); // scratch exists only for a real sweep, never for the dry check

const files = [...new Set(MUTANTS.map((m) => m.file))];
const dirty = sh('git', ['diff', '--quiet', '--', ...files, ...TESTS, 'scripts/memory-cap-row-mutants.mjs', 'scripts/memory-cap-row-render-smoke.mjs']).status !== 0;
if (dirty) { console.error('REFUSING: the mutated files / suites / rig have uncommitted changes — commit first (the end-of-sweep `git diff` must prove restoration)'); process.exit(2); }
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
buildCli();

// ── POSITIVE CONTROL: the unmutated tree must be all green (and the CLI fresh), else every "killed" below is vacuous ──
const base = unitRed();
const baseRig = rigRed();
const baseSmoke = smokeRed();
console.log(`BASELINE unit: pass ${base.pass} fail ${base.names.length} skipped ${base.skipped} | rig: ${baseRig.line} (pass ${baseRig.pass}, red ${JSON.stringify(baseRig.red)}) | smoke ok ${baseSmoke.pass} fail ${baseSmoke.fails.length} | strays ${strays()} scratch ${scratchLeft()}`);
if (base.names.length || base.status !== 0 || base.skipped !== 0 || baseSmoke.fails.length || baseSmoke.status !== 0) { console.error('BASELINE NOT GREEN — aborting (nothing was mutated)'); process.exit(2); }

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
  let mutated = original; let anchorBad = null;
  for (const e of editsOf(m)) { const c = mutated.split(e.find).length - 1; if (c !== 1) { anchorBad = `find occurs ${c}× (need exactly 1): ${e.find.slice(0, 60)}`; break; } mutated = mutated.replace(e.find, () => e.to); }
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
    const sm = m.smoke ? smokeRed() : { fails: [] };
    const red = [...u.names, ...r.red, ...sm.fails];
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
for (const r of rows) console.log(`${r.verdict.padEnd(30)} ${r.id.padEnd(40)} ${r.detail}`);
const killed = rows.filter((r) => r.verdict === 'KILLED').length;
const sv = strays(); const sc = scratchLeft();
console.log(`RESTORED: sha-identical ${sameSha} · git diff clean ${gitClean} · cmp-restore ${!restoreBad} · post-sweep unit fail ${post.names.length} · survivors: rig processes=${sv} scratch dirs=${sc}`);
console.log(`MUTANTS: ${killed}/${rows.length} killed by their NAMED test/arm${rows.length === killed ? '' : ` — NOT ALL: ${rows.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id}=${r.verdict}`).join(', ')}`}`);
process.exit(rows.length === killed && sameSha && gitClean && !restoreBad && post.names.length === 0 && sv === 0 && sc === 0 ? 0 : 1);
