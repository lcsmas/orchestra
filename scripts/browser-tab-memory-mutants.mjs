// #394 self-gate — IN-PLACE mutation sweep of browser tab memory attribution. Each mutant edits ONE clause of the real source, runs the two
// unit suites and must turn the NAMED test(s) red. Backup is byte-exact + `cmp` after every mutant; sha256 of every mutated file is compared
// before/after the sweep. Run on a COMMITTED tree. Light (two node --test runs, ~1 s each).
// Run: node scripts/browser-tab-memory-mutants.mjs [--check] [--only M01,M02]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const T = ['src/shared/browser-tab-memory.test.ts', 'src/main/browser-tab-memory.test.ts'];
const SH = 'src/shared/browser-tab-memory.ts';
const RS = 'src/shared/resources.ts';
const MP = 'src/main/browser-tab-memory.ts';

// `expect` = names (prefix of the test title) that MUST be among the red tests.
const MUTANTS = [
  { id: 'M01_split_not_divided', file: SH, find: 'const base = Math.floor(total / list.length);', to: 'const base = total;', expect: ['T5', 'T6', 'T16'] },
  { id: 'M02_remainder_dropped', file: SH, find: 'base + (i < extra ? 1 : 0);', to: 'base;', expect: ['T5', 'T6', 'T16'] },
  { id: 'M03_unmeasured_is_zero', file: SH, find: "{ wsId, tabs: 0, bytes: null, unmeasured: 0, shared: 0 }", to: "{ wsId, tabs: 0, bytes: 0, unmeasured: 0, shared: 0 }", expect: ['T8', 'T10', 'T11', 'T12'] },
  { id: 'M04_exclude_ignored', file: SH, find: ' || excludePids.has(t.pid)) return null;', to: ') return null;', expect: ['T11', 'P3'] },
  { id: 'M05_pid_zero_accepted', file: SH, find: '|| t.pid <= 0 ', to: '', expect: ['T12'] },
  { id: 'M06_same_ws_marked_shared', file: SH, find: 'if (crossWs) r.shared += 1;', to: 'r.shared += 1;', expect: ['T4', 'T7'] },
  { id: 'M07_unsorted', file: SH, find: 'const ordered = [...tabs].sort(', to: 'const ordered = [...tabs].map((x) => x).slice(0, tabs.length) || [].sort(', expect: ['T15'] },
  { id: 'M08_app_tile_counts_billed', file: SH, find: 'billed.has(p.pid) ? n : n + p.memBytes', to: 'n + p.memBytes', expect: ['B2', 'B3'] },
  { id: 'M09_negative_figure_accepted', file: SH, find: 'Number.isFinite(m) && m >= 0 ? m : null', to: 'Number.isFinite(m) ? m : null', expect: ['T12'] },
  { id: 'M10_estimate_note_always', file: SH, find: "if (b.shared > 0) parts.push(", to: "if (b.shared >= 0) parts.push(", expect: ['F1'] },
  { id: 'M11_unmeasured_count_dropped', file: SH, find: 'if (measuredOf(t) === null) r.unmeasured += 1;', to: 'void 0;', expect: ['T8', 'T9', 'T10', 'T11', 'T12', 'R2'] },
  { id: 'M12_attributed_pids_all', file: SH, find: 'attributedPids: [...users.keys()].sort((a, b) => a - b) }', to: 'attributedPids: [...new Set(tabs.map((t) => t.pid ?? 0))].sort((a, b) => a - b) }', expect: ['T8', 'T11'] },
  { id: 'G01_row_ignores_tabs', file: RS, find: ' + browserBytesFor(browserTabs, key) + (remote ? 0 : viewBytesFor(containers, key)), // #394 tabs', to: ' + (remote ? 0 : viewBytesFor(containers, key)), // #394 tabs', expect: ['R1', 'R5', 'R6'] },
  { id: 'G02_browser_only_for_session_ws', file: RS, find: 'if (w.tabs <= 0 || byWs.has(w.wsId) || scopeOnly.has(w.wsId)) continue;', to: 'if (w.tabs <= 0) continue;', expect: ['R2'] },
  { id: 'G03_container_row_duplicated', file: RS, find: ' && !browserOnly.has(a.wsId)) rows.push(', to: ') rows.push(', expect: ['R4'] },
  { id: 'G04_scope_only_ignores_tabs', file: RS, find: ' + viewBytesFor(containers, m.wsId) + browserBytesFor(browserTabs, m.wsId), procCount: 0,', to: ' + viewBytesFor(containers, m.wsId), procCount: 0,', expect: ['R5'] },
  { id: 'G05_remote_row_unbilled', file: RS, find: ' + browserBytesFor(browserTabs, key) + (remote ?', to: ' + (remote ? 0 : browserBytesFor(browserTabs, key)) + (remote ?', expect: ['R5'] },
  { id: 'G06_snapshot_drops_tabs', file: RS, find: 'snap?.members, snap?.browserTabs);', to: 'snap?.members);', expect: ['R6'] },
  { id: 'G07_browser_only_no_flag', file: RS, find: 'cap: null, browser: w, browserOnly: true });', to: 'cap: null, browser: w, browserOnly: false });', expect: ['R3'] },
  { id: 'P01_nontab_ignored', file: MP, find: 'new Set(src.nonTabPids())', to: 'new Set<number>()', expect: ['P3'] },
  { id: 'P02_pids_not_deduped', file: MP, find: 'tableOf([...new Set(tabs.flatMap(', to: 'tableOf([...(tabs.flatMap(', expect: ['P5'] },
  { id: 'P03_dead_pid_asked', file: MP, find: '(t.pid !== null && t.pid > 0 ? [t.pid] : [])', to: '(t.pid !== null ? [t.pid] : [])', expect: ['P5'] },
  { id: 'P04_throw_is_empty', file: MP, find: "      warn('resources: browser tab memory could not be read — rows carry no browser figure', e);\n    }\n    return undefined;", to: "      warn('resources: browser tab memory could not be read — rows carry no browser figure', e);\n    }\n    return { byWorkspace: [], attributedPids: [] };", expect: ['P4'] },
  { id: 'P05_warn_every_time', file: MP, find: 'if (!warned) {\n      warned = true;', to: 'if (true) {\n      warned = true;', expect: ['P4'] },
  { id: 'P06_page_size_hardcoded', file: MP, find: 'const pageSize = hostPageSize();', to: 'const pageSize = 4096;', expect: ['P6'], note: 'discriminates on a non-4 KB-page host only (this one is 16 KB)' },
  { id: 'P07_no_source_is_empty', file: MP, find: '  if (!src) return undefined;\n  try {\n    return f(src);', to: '  if (!src) return { byWorkspace: [], attributedPids: [] };\n  try {\n    return f(src);', expect: ['P2'] },
  { id: 'W01_snapshot_unwired', file: 'src/main/resources.ts', find: '    browserTabs: sampleBrowserTabMemory(table),\n', to: '', expect: ['W3'] },
  { id: 'W02_monitor_line_unwired', file: 'src/main/resource-monitor.ts', find: '      browserTabs: d.browserTabs?.(table),\n', to: '', expect: ['W4'] },
  { id: 'W03_prod_deps_unwired', file: 'src/main/resource-monitor.ts', find: '    browserTabs: (table) => sampleBrowserTabMemory(table, undefined,', to: '    browserTabsX: (table) => sampleBrowserTabMemory(table, undefined,', expect: ['W4'] },
  { id: 'W04_busstatus_unwired', file: 'src/main/hooks-server.ts', find: '...(browserTabsView ? { browserTabs: browserTabsView, ', to: '...(false ? { browserTabs: browserTabsView, ', expect: ['W5'] },
  { id: 'W05_cli_unwired', file: 'src/cli/index.ts', find: 'process.stdout.write(`${formatBrowserTabsLine(', to: 'void (`${formatBrowserTabsLine(', expect: ['W5'] },
  { id: 'W06_panel_source_unwired', file: 'src/main/browser-panel.ts', find: '  setBrowserTabSource({\n', to: '  void ({\n', expect: ['W2'] },
  { id: 'W07_panel_source_reaps', file: 'src/main/browser-panel.ts', find: 'const wc = liveContents(t); return wc ?', to: 'const wc = (reapIfDead(p.wsId), liveContents(t)); return wc ?', expect: ['W2'] },
  { id: 'W08_app_tile_unchanged', file: 'src/renderer/components/ResourcesView.tsx', find: 'const appMem = appMemoryExcludingTabs(snap?.app ?? [], snap?.browserTabs);', to: 'const appMem = (snap?.app ?? []).reduce((n, p) => n + p.memBytes, 0);', expect: ['W6'] },
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const files = [...new Set(MUTANTS.map((m) => m.file))];
const before = new Map(files.map((f) => [f, sha(fs.readFileSync(path.join(REPO, f)))]));
const backup = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'btm-mutants-'));

function runTests() {
  const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', '--experimental-strip-types', ...T], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const red = [...out.matchAll(/^not ok \d+ - (\S+)/gm)].map((m) => m[1]);
  const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN);
  const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(out)?.[1] ?? NaN);
  return { red, pass, fail, skipped, status: r.status };
}

let bad = 0;
const base = runTests();
console.log(`BASELINE (unmutated): pass ${base.pass} fail ${base.fail} skipped ${base.skipped} RC ${base.status}`);
if (base.fail !== 0 || base.skipped !== 0 || !(base.pass > 0)) { console.log('FAIL: the unmutated tree is not green — no mutant can be judged'); process.exit(1); }

for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const abs = path.join(REPO, m.file);
  const orig = fs.readFileSync(abs, 'utf8');
  const n = orig.split(m.find).length - 1;
  if (n !== 1) { console.log(`ANCHOR ${m.id}: ${n} occurrences of the find string in ${m.file} (need exactly 1)`); bad++; continue; }
  if (checkOnly) { console.log(`ANCHOR ${m.id}: ok`); continue; }
  const bk = path.join(backup, m.id);
  fs.writeFileSync(bk, orig);
  try {
    fs.writeFileSync(abs, orig.replace(m.find, () => m.to));
    const mutated = fs.readFileSync(abs, 'utf8');
    if (mutated === orig) { console.log(`${m.id}: mutation was a no-op`); bad++; continue; }
    const r = runTests();
    const hit = m.expect.filter((e) => r.red.some((t) => t === e || t.startsWith(e)));
    const missing = m.expect.filter((e) => !hit.includes(e));
    const ok = r.fail > 0 && missing.length === 0;
    console.log(`${ok ? 'KILLED  ' : 'SURVIVED'} ${m.id}: red=[${r.red.join(',')}] expected=[${m.expect.join(',')}]${missing.length ? ` MISSING=[${missing.join(',')}]` : ''}${m.note ? ` (${m.note})` : ''}`);
    if (!ok) bad++;
  } finally {
    fs.writeFileSync(abs, fs.readFileSync(bk));
    if (Buffer.compare(fs.readFileSync(abs), fs.readFileSync(bk)) !== 0) { console.log(`RESTORE FAILED for ${m.file}`); process.exit(2); }
  }
}
for (const f of files) {
  const now = sha(fs.readFileSync(path.join(REPO, f)));
  if (now !== before.get(f)) { console.log(`TREE DIRTY: ${f} differs from its pre-sweep sha`); bad++; }
}
fs.rmSync(backup, { recursive: true, force: true });
const after = runTests();
console.log(`AFTER (restored): pass ${after.pass} fail ${after.fail} skipped ${after.skipped}`);
console.log(bad === 0 && after.fail === 0 ? `MUTANTS: ALL KILLED (${checkOnly ? 'anchors only' : MUTANTS.filter((m) => !only || only.has(m.id)).length})` : `MUTANTS: ${bad} PROBLEM(S)`);
process.exit(bad === 0 && after.fail === 0 ? 0 : 1);
