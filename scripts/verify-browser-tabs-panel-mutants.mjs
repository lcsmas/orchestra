// #393 — must-FAIL proof for the browser-tabs arms: each mutant is applied IN PLACE to the real source, the suite that owns the
// clause must go RED (non-zero), and the file is restored byte-exact (cmp'd against a backup) whatever happens.
// The mutant string is checked LIVE (exactly one occurrence) so a drifted source fails loudly instead of "killing" nothing.
// Run: node scripts/verify-browser-tabs-panel-mutants.mjs [id ...]   (exit 0 = baseline green AND every mutant killed AND every file restored)

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HARNESS = ['node', '--experimental-strip-types', 'scripts/verify-browser-tabs-panel.mjs'];
const unit = (f) => ['node', '--test', '--experimental-strip-types', f];
const P = 'src/main/browser-panel.ts';
const POL = 'src/shared/browser-tab-policy.ts';
const ST = 'src/shared/browser-tab-state.ts';
const STORE = 'src/main/browser-tabs-store.ts';

const MUTANTS = [
  // main-process arms (stub harness)
  { id: 'M1-cap-ignored', file: P, cmd: HARNESS, from: '  if (!d.ok) return refused(wsId, d.reason, d.message);\n  const tab = createTab(wsId, opts);', to: '  const tab = createTab(wsId, opts);' },
  { id: 'M2-agent-closes-anything', file: P, cmd: HARNESS, from: 'decideTabClose({ tabs: panel.tabs, activeId: panel.activeId, tabId, actor })', to: "decideTabClose({ tabs: panel.tabs, activeId: panel.activeId, tabId, actor: 'human' })" },
  { id: 'M3-last-tab-evicts-panel', file: P, cmd: HARNESS, from: "if (d.replaceWithBlank) createTab(wsId, { openedBy: 'human', activate: true });", to: '' },
  { id: 'M4-snapshot-never-saved', file: P, cmd: HARNESS, from: '  savePanelTabs(panel);\n  platform.broadcast', to: '  platform.broadcast' },
  { id: 'M5-active-index-ignored', file: P, cmd: HARNESS, from: 'built[Math.min(saved.activeIndex, built.length - 1)]', to: 'built[0]' },
  { id: 'M6-destroy-keeps-tabs', file: P, cmd: HARNESS, from: '  persistence?.save(wsId, null);\n}', to: '}' },
  { id: 'M7-restore-url-forgotten', file: P, cmd: HARNESS, from: '        restoreUrls.set(tab, t.url);\n', to: '' },
  { id: 'M8-popup-non-web-loads-in-view', file: P, cmd: HARNESS, from: "      case 'external':\n        void shell.openExternal(details.url);", to: "      case 'external':\n        void wc.loadURL(details.url);" },
  { id: 'M9-inactive-tab-stays-attached', file: P, cmd: HARNESS, from: '  if (prev) detachTab(panel, prev);\n  panel.attachedId = null;', to: '  panel.attachedId = null;' },
  { id: 'M11-restore-url-dropped-on-error-commit', file: P, cmd: HARNESS, from: '    if (restorableUrl(url)) restoreUrls.delete(tab);', to: '    restoreUrls.delete(tab);' },
  { id: 'M12-close-picks-left-neighbour', file: P, cmd: HARNESS, from: 'panel.activeId = panel.tabs[Math.min(idx, panel.tabs.length - 1)].id;\n    if (wasAttached) attachActive(panel);\n  }\n  return publish(panel);', to: 'panel.activeId = panel.tabs[Math.max(0, idx - 1)].id;\n    if (wasAttached) attachActive(panel);\n  }\n  return publish(panel);' },
  { id: 'M13-bare-last-close-keeps-saved-tabs', file: P, cmd: HARNESS, from: '    panel.pendingShow = false;\n    persistence?.save(wsId, null);\n    const empty', to: '    panel.pendingShow = false;\n    const empty' },
  { id: 'M10-unknown-tab-activate-throws', file: P, cmd: HARNESS, from: "if (!panel?.tabs.some((t) => t.id === tabId)) return refused(wsId, 'unknown-tab', `No such browser tab: ${tabId}.`);", to: '' },
  // pure policy arms
  { id: 'P1-cap-off-by-one', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: 'if (input.openCount < cap) return { ok: true };', to: 'if (input.openCount <= cap) return { ok: true };' },
  { id: 'P2-cap-constant', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: 'export const BROWSER_TAB_CAP = 8;', to: 'export const BROWSER_TAB_CAP = 9;' },
  { id: 'P3-ownership-dropped', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: "if (input.actor === 'agent' && tab.openedBy !== 'agent') {", to: 'if (false) {' },
  { id: 'P4-left-neighbour-first', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: 'input.tabs[idx + 1] ?? input.tabs[idx - 1]', to: 'input.tabs[idx - 1] ?? input.tabs[idx + 1]' },
  { id: 'P5-last-tab-not-replaced', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: 'if (input.tabs.length === 1) return', to: 'if (input.tabs.length === 0) return' },
  { id: 'P6-background-close-moves-active', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: 'return { ok: true, nextActiveId: input.activeId, replaceWithBlank: false };', to: 'return { ok: true, nextActiveId: input.tabs[0].id, replaceWithBlank: false };' },
  { id: 'P7-popup-external-urls-load', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: "return /^https?:/i.test(req.url) ? { route: 'same-view' } : { route: 'external' };", to: "return { route: 'same-view' };" },
  // persisted-state arms
  { id: 'P8-background-event-reopens-the-pane', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: 'const navigated = key !== \'\' && key !== prev?.key;', to: 'const navigated = key !== \'\';' },
  { id: 'P9-url-less-event-opens', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: 'const navigated = key !== \'\' && key !== prev?.key;', to: 'const navigated = key !== prev?.key;' },
  { id: 'P10-same-url-navigate-does-not-reopen', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: 'return { open: navigated || startedLoading, next };', to: 'return { open: navigated, next };' },
  { id: 'P11-loading-edge-is-level', file: POL, cmd: unit('src/shared/browser-tab-policy.test.ts'), from: 'const startedLoading = key !== \'\' && state.loading && !prev?.loading;', to: 'const startedLoading = key !== \'\' && state.loading;' },
  { id: 'S1-unsafe-scheme-restored', file: ST, cmd: unit('src/shared/browser-tab-state.test.ts'), from: 'return /^(https?|file):/i.test(u) ? u : \'\';', to: 'return u;' },
  { id: 'S2-cap-ignored-on-parse', file: ST, cmd: unit('src/shared/browser-tab-state.test.ts'), from: '    if (tabs.length >= BROWSER_TAB_CAP) break;\n', to: '' },
  { id: 'S3-active-index-unclamped', file: ST, cmd: unit('src/shared/browser-tab-state.test.ts'), from: 'return { tabs, activeIndex: ai >= 0 && ai < tabs.length ? ai : 0 };', to: 'return { tabs, activeIndex: ai };' },
  { id: 'S4-corrupt-file-throws', file: ST, cmd: unit('src/shared/browser-tab-state.test.ts'), from: '  try {\n    json = JSON.parse(text);\n  } catch {\n    return {};\n  }', to: '  json = JSON.parse(text);' },
  // on-disk store arms
  { id: 'D1-noop-save-rewrites', file: STORE, cmd: unit('src/main/browser-tabs-store.test.ts'), from: 'JSON.stringify(all[wsId]) === JSON.stringify(tabs)', to: 'false' },
  { id: 'D2-write-not-atomic', file: STORE, cmd: unit('src/main/browser-tabs-store.test.ts'), from: 'fs.renameSync(tmp, file);', to: 'fs.copyFileSync(tmp, file);' },
  { id: 'D4-unreadable-file-overwritten', file: STORE, cmd: unit('src/main/browser-tabs-store.test.ts'), from: '        readFailed = true;\n', to: '' },
  { id: 'D5-merge-resurrects-forgotten', file: STORE, cmd: unit('src/main/browser-tabs-store.test.ts'), from: '        for (const id of forgotten) delete cache[id];\n', to: '' },
  { id: 'D3-failed-write-forgotten', file: STORE, cmd: unit('src/main/browser-tabs-store.test.ts'), from: '      dirty = true; // keep it pending', to: '      // keep it pending' },
];

const only = process.argv.slice(2);
const run = (cmd) => spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? os.tmpdir() } });

const backups = new Map(); // file -> backup path
const bk = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'bt-mut-'));
for (const f of new Set(MUTANTS.map((m) => m.file))) {
  const dst = path.join(bk, f.replaceAll('/', '__'));
  fs.copyFileSync(path.join(ROOT, f), dst);
  backups.set(f, dst);
}
let cleaned = false;
const restoreAll = () => {
  if (cleaned) return; // backups are gone once the run finished normally
  for (const [f, b] of backups) fs.copyFileSync(b, path.join(ROOT, f));
};
process.on('exit', restoreAll);
process.on('SIGINT', () => process.exit(130));

let bad = 0;
const rows = [];

// Baseline: every suite must be GREEN unmutated — otherwise "red" under a mutant proves nothing.
for (const cmd of new Map(MUTANTS.map((m) => [m.cmd.join(' '), m.cmd])).values()) {
  const r = run(cmd);
  const ok = r.status === 0;
  rows.push([ok ? 'BASELINE-GREEN' : 'BASELINE-RED', cmd.slice(-1)[0]]);
  if (!ok) {
    bad++;
    console.log(r.stdout.split('\n').slice(-15).join('\n'));
  }
}

for (const m of MUTANTS) {
  if (only.length && !only.includes(m.id)) continue;
  const abs = path.join(ROOT, m.file);
  const src = fs.readFileSync(abs, 'utf8');
  const n = src.split(m.from).length - 1;
  if (n !== 1) {
    rows.push(['STRING-NOT-LIVE', `${m.id} (${n} occurrences of the mutant string in ${m.file})`]);
    bad++;
    continue;
  }
  fs.writeFileSync(abs, src.replace(m.from, () => m.to));
  let r;
  try {
    r = run(m.cmd);
  } finally {
    fs.copyFileSync(backups.get(m.file), abs);
  }
  let restored = true;
  try {
    execFileSync('cmp', [abs, backups.get(m.file)]);
  } catch {
    restored = false;
  }
  const killed = r.status !== 0;
  if (!killed || !restored) bad++;
  // Which arm reddened — so a mutant killed for an unrelated reason (a syntax error) is visible.
  const red = (r.stdout.match(/^(?:FAIL|not ok \d+) ?-? ?(.{0,90})/gm) ?? []).slice(0, 2).join(' | ') || (r.stderr.match(/(SyntaxError|TypeError|Error)[^\n]{0,80}/) ?? [''])[0];
  rows.push([killed && restored ? 'KILLED' : !killed ? 'SURVIVED' : 'NOT-RESTORED', `${m.id}  <- ${red}`]);
}

for (const [s, t] of rows) console.log(`${s.padEnd(15)} ${t}`);
console.log(`\n${rows.filter((r) => r[0] === 'KILLED').length}/${MUTANTS.length - (only.length ? MUTANTS.length - only.length : 0)} killed; ${bad ? bad + ' PROBLEM(S)' : 'all clean'}`);
cleaned = true;
fs.rmSync(bk, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
