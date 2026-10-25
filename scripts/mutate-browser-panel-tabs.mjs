// Must-FAIL proof for src/main/browser-panel-tabs.test.ts (#391, ledger #405).
// Mutates src/main/browser-panel.ts IN PLACE, one clause at a time; each mutant
// MUST redden the test, and the file is restored from a byte-exact backup and
// `cmp`-checked after every mutant (and on any exit path).
// Run: node scripts/mutate-browser-panel-tabs.mjs   (RC 0 = every mutant killed)

import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src/main/browser-panel.ts');
const testFile = 'src/main/browser-panel-tabs.test.ts';
const backup = path.join(mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'bp-mut-')), 'browser-panel.ts.orig');
copyFileSync(target, backup);
const orig = readFileSync(target, 'utf8');

const MUTANTS = [
  ['destroyPanel tears down only the ACTIVE tab (leaks the rest)',
    'for (const tab of panel.tabs) destroyTab(tab);\n}',
    'destroyTab(activeTabOf(panel)!);\n}'],
  ['destroyTab skips the debugger detach',
    'if (tab.debuggerAttached) wc.debugger.detach();', ''],
  ['closeTab never destroys the closed tab contents',
    'panel.tabs.splice(idx, 1);\n  destroyTab(tab);', 'panel.tabs.splice(idx, 1);'],
  ['closing the LAST tab leaks its contents',
    '    destroyTab(tab);\n    panels.delete(wsId);', '    panels.delete(wsId);'],
  ['attachActive does not detach the previously attached tab (two views composit)',
    'if (prev) detachTab(panel, prev);', ''],
  ['reapIfDead only notices a dead ACTIVE tab',
    'const dead = panel.tabs.filter((t) => !liveContents(t));',
    'const dead = panel.tabs.filter((t) => !liveContents(t) && t.id === panel.activeId);'],
  ['an evicted panel restarts tab numbering (ids reused)',
    'panel.attachedId = null;\n    panels.delete(wsId);\n    return undefined;',
    'panel.attachedId = null;\n    panels.delete(wsId);\n    tabSeq.delete(wsId);\n    return undefined;'],
  ['an explicit tabId is ignored (always the active tab)',
    'if (tabId === undefined) return getActiveTab(wsId);', 'return getActiveTab(wsId);'],
  ['requireComposited lets a background tab through',
    'if (panel.attachedId !== tab.id) {', 'if (false) {'],
  ['setBounds sizes only the active tab',
    'for (const tab of panel.tabs) tab.view.setBounds(rect);',
    'activeTabOf(panel)!.view.setBounds(rect);'],
  ['showPanel no longer hides the other workspaces\' panels',
    'if (id !== wsId && other.attachedId !== null) hidePanel(id);', ''],
  ['the panel state mirrors the FIRST tab, not the active one',
    'const active = activeTabOf(panel);\n  const n = active ? refreshNav(active) : blankNav();',
    'const active = panel.tabs[0];\n  const n = active ? refreshNav(active) : blankNav();'],
  ['closing the active tab does not promote a neighbour',
    'panel.activeId = panel.tabs[Math.min(idx, panel.tabs.length - 1)].id;\n    if (wasAttached) attachActive(panel);\n  }\n  return publish(panel);',
    'if (wasAttached) attachActive(panel);\n  }\n  return publish(panel);'],
  ['activateTab of a hidden panel attaches anyway',
    'if (panel.attachedId !== null) attachActive(panel);\n  publish(panel);',
    'attachActive(panel);\n  publish(panel);'],
  ['clickAt release is not pinned to the pressed tab',
    "{ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, pin)", "{ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, tabId)"],
  ['getState does not reap dead tabs',
    'return reapIfDead(wsId)?.state ?? emptyState(wsId);', 'return panels.get(wsId)?.state ?? emptyState(wsId);'],
  ['closing the last tab empties panel.tabs (held Panel.view throws)',
    '    destroyTab(tab);\n    panels.delete(wsId);', '    panel.tabs.splice(0, 1);\n    destroyTab(tab);\n    panels.delete(wsId);'],
  ['emitState publishes for an evicted panel (ghost state)',
    ' || panels.get(panel.wsId) !== panel) return;', ') return;'],
  ['an explicit tabId resurrects a panel (attachDebugger)',
    "  const explicit = tabId === undefined ? undefined : resolveTab(wsId, tabId);\n  const panel = getPanel(wsId) ?? (tabId === undefined ? ensurePanel(wsId) : undefined);\n  const tab = explicit ?? (panel ? activeTabOf(panel) : undefined);",
    "  const panel = getPanel(wsId) ?? ensurePanel(wsId);\n  const tab = resolveTab(wsId, tabId);"],
  ['an explicit tabId resurrects a panel (navigate)',
    'const tab = tabId === undefined ? (ensurePanel(wsId), getActiveTab(wsId)) : resolveTab(wsId, tabId);',
    'ensurePanel(wsId);\n  const tab = resolveTab(wsId, tabId);'],
  ['listTabs does not reap',
    'const panel = reapIfDead(wsId);\n  return panel ? panel.tabs.map((t) => tabInfo(panel, t)) : [];',
    'const panel = panels.get(wsId);\n  return panel ? panel.tabs.map((t) => tabInfo(panel, t)) : [];'],
  ['getTab does not reap',
    'return reapIfDead(wsId)?.tabs.find((t) => t.id === tabId);', 'return panels.get(wsId)?.tabs.find((t) => t.id === tabId);'],
  ['getActiveTab does not reap',
    'const panel = reapIfDead(wsId);\n  return panel ? activeTabOf(panel) : undefined;',
    'const panel = panels.get(wsId);\n  return panel ? activeTabOf(panel) : undefined;'],
  ['reaping a dead active tab always promotes the first tab',
    'panel.activeId = panel.tabs[Math.min(activeIdx, panel.tabs.length - 1)].id;', 'panel.activeId = panel.tabs[0].id;'],
  ['clickRef click is not pinned to the resolved tab',
    'await clickAt(wsId, p.x, p.y, pin);', 'await clickAt(wsId, p.x, p.y, tabId);'],
  ['designModePoll screenshot is not pinned to the pick tab',
    "{ format: 'png', clip, captureBeyondViewport: false },\n        pin,", "{ format: 'png', clip, captureBeyondViewport: false },\n        tabId,"],
  ['default navigate no longer opens the panel on demand',
    'const tab = tabId === undefined ? (ensurePanel(wsId), getActiveTab(wsId)) : resolveTab(wsId, tabId);',
    'const tab = tabId === undefined ? getActiveTab(wsId) : resolveTab(wsId, tabId);'],
  ['default attachDebugger no longer opens the panel on demand',
    'getPanel(wsId) ?? (tabId === undefined ? ensurePanel(wsId) : undefined);', 'getPanel(wsId);'],
  ['reaping the dead last tab promotes the first tab',
    'panel.activeId = panel.tabs[Math.min(activeIdx, panel.tabs.length - 1)].id;',
    'panel.activeId = panel.tabs[activeIdx < panel.tabs.length ? activeIdx : 0].id;'],
  ['hidePanel leaves the view attached',
    'if (attached) detachTab(panel, attached);', ''],
];

let killed = 0;
const survivors = [];
const run = () =>
  spawnSync('node', ['--test', '--experimental-strip-types', testFile], { cwd: root, encoding: 'utf8' });

function restore() {
  copyFileSync(backup, target);
  const same = readFileSync(target).equals(readFileSync(backup));
  if (!same) throw new Error('RESTORE FAILED: browser-panel.ts differs from backup');
}
process.on('exit', () => { try { copyFileSync(backup, target); } catch {} });

// Positive control: the UNMUTATED tree passes (a rig that cannot say PASS proves nothing).
const base = run();
if (base.status !== 0) { console.log('BASELINE FAILS — abort\n' + base.stdout.slice(-2000)); process.exit(2); }
console.log('baseline PASS');

for (const [name, find, replace] of MUTANTS) {
  const n = orig.split(find).length - 1;
  if (n !== 1) { console.log(`ABORT: mutant "${name}" find-string occurs ${n}x (need exactly 1)`); restore(); process.exit(2); }
  writeFileSync(target, orig.replace(find, replace));
  if (readFileSync(target, 'utf8') === orig) { console.log(`ABORT: mutant "${name}" did not change the file`); restore(); process.exit(2); }
  const r = run();
  restore();
  const failing = (r.stdout.match(/^not ok .*/gm) || []).length;
  const dead = r.status !== 0;
  if (dead) killed++; else survivors.push(name);
  console.log(`${dead ? 'KILLED  ' : 'SURVIVED'} ${name}${dead ? `  (${failing} arm(s) red)` : ''}`);
}
const finalSame = readFileSync(target).equals(readFileSync(backup));
console.log(`\n${killed}/${MUTANTS.length} killed; restore byte-exact: ${finalSame}`);
process.exit(survivors.length || !finalSame ? 1 : 0);
