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
    'for (const tab of panel.tabs) destroyTab(tab);\n  notifyPanelListeners(wsId, [], true);',
    'destroyTab(activeTabOf(panel)!);\n  notifyPanelListeners(wsId, [], true);'],
  ['destroyTab skips the proxy seat\'s force-detach (#398: the debugger seat outlives its tab)',
    'tabTeardownHook?.(wc);', ''],
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
  ['an explicit tabId resurrects a panel (liveTabFor, the CDP primitives\' resolver)',
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
  ['default liveTabFor no longer opens the panel on demand',
    'getPanel(wsId) ?? (tabId === undefined ? ensurePanel(wsId) : undefined);', 'getPanel(wsId);'],
  ['reaping the dead last tab promotes the first tab',
    'panel.activeId = panel.tabs[Math.min(activeIdx, panel.tabs.length - 1)].id;',
    'panel.activeId = panel.tabs[activeIdx < panel.tabs.length ? activeIdx : 0].id;'],
  ['requireComposited builds a panel for an explicit tabId (getPanel -> ensurePanel)',
    'function requireComposited(wsId: string, what: string, tabId?: BrowserTabId): Tab {\n  const panel = getPanel(wsId);',
    'function requireComposited(wsId: string, what: string, tabId?: BrowserTabId): Tab {\n  const panel = ensurePanel(wsId);'],
  ['readPage builds the panel before resolving an explicit tabId',
    'export async function readPage(wsId: string, tabId?: BrowserTabId): Promise<string> {',
    'export async function readPage(wsId: string, tabId?: BrowserTabId): Promise<string> {\n  ensurePanel(wsId);'],
  ['goBack builds the panel before resolving an explicit tabId',
    'export function goBack(wsId: string, tabId?: BrowserTabId): void {',
    'export function goBack(wsId: string, tabId?: BrowserTabId): void {\n  ensurePanel(wsId);'],
  ['capture builds the panel before resolving an explicit tabId',
    "  tabId?: BrowserTabId,\n): Promise<string> {\n  const tab = requireComposited(wsId, 'screenshot', tabId);",
    "  tabId?: BrowserTabId,\n): Promise<string> {\n  ensurePanel(wsId);\n  const tab = requireComposited(wsId, 'screenshot', tabId);"],
  ['clickRef builds the panel before resolving an explicit tabId',
    'export async function clickRef(wsId: string, ref: number, tabId?: BrowserTabId): Promise<void> {',
    'export async function clickRef(wsId: string, ref: number, tabId?: BrowserTabId): Promise<void> {\n  ensurePanel(wsId);'],
  ['designModePoll builds the panel before resolving an explicit tabId',
    '): Promise<DesignPick | { cancelled: true } | null> {\n',
    '): Promise<DesignPick | { cancelled: true } | null> {\n  ensurePanel(wsId);\n'],
  ['reload builds the panel before resolving an explicit tabId',
    'export function reload(wsId: string, tabId?: BrowserTabId): void {',
    'export function reload(wsId: string, tabId?: BrowserTabId): void {\n  ensurePanel(wsId);'],
  ['hidePanel leaves the view attached',
    'if (attached) detachTab(panel, attached);', ''],
  // #398: design mode's lease on the proxy's debugger attach
  ['design mode keeps no lease while armed (every poll attaches anew)',
    'if (!tab.designHold) tab.designHold = await cdpSeat.hold(wsId, tab.id);', ''],
  ['a pick or Escape never gives the lease back',
    '    endDesign(pinned, gen); // a re-arm landing during the read or the screenshot owns the tab now\n', ''],
  ['a disarm never gives the lease back',
    "    } finally {\n      endDesign(tab, gen); // an arm called while this disarm's teardown was in flight bumped the counter: it owns the tab\n    }\n  });\n}", '    } finally {\n    }\n  });\n}'],
  ['an arm whose script fails keeps the lease',
    '    } catch (err) {\n      endDesign(tab, gen); // no-op when a later arm (a URL-change re-arm queued behind this one) already owns the tab\n      throw err;', '    } catch (err) {\n      throw err;'],
  ['a disarm does not wait for the arm still attaching (orphan overlay)',
    'const run = tab.designOp.then(fn);', 'const run = fn();'],
  ['a disarm of an unarmed tab still attaches and evaluates',
    '    if (!tab.designArmed || tab.designGen !== gen) return; // not armed, or a later arm (off→on inside one round trip) supersedes this disarm\n', ''],
  ['a disarm reaches only the ACTIVE tab (a lease and an overlay stay on the tab armed before the switch)',
    'targets = tabId === undefined ? armedTabs(wsId) :', 'targets = tabId === undefined ? (getActiveTab(wsId) ? [getActiveTab(wsId)!] : []) :'],
  ['a pick leaves the picker armed on the other tabs',
    '    for (const other of armedTabs(wsId)) if (other !== pinned) void disarmTab(wsId, other);\n', ''],
  ['a poll for a workspace with no panel builds one',
    'if (!pinned) return null;', 'if (!pinned) { getPanel(wsId) ?? ensurePanel(wsId); return null; }'],
  ['the armed mark is set after the lease is granted (a disarm queued behind the arm finds nothing)',
    '  tab.designArmed = true; // now, not after the lease: a disarm queued right behind this arm must find it armed\n', ''],
  ['a disarm superseded by a later arm still tears down (off→on orphans overlay + lease)',
    'if (!tab.designArmed || tab.designGen !== gen) return;', 'if (!tab.designArmed) return;'],
  ['a finished pick wipes a re-arm that landed during its screenshot (F2)',
    '    endDesign(pinned, gen); // a re-arm landing during the read or the screenshot owns the tab now', '    endDesign(pinned, pinned.designGen); // a re-arm landing during the read or the screenshot owns the tab now'],
  ['the arm\'s catch clears under a newer arm (F5: A1 fails mid-install while A2 is queued)',
    '      endDesign(tab, gen); // no-op when a later arm', '      endDesign(tab, tab.designGen); // no-op when a later arm'],
  ['the disarm\'s finally clears under an arm called during its teardown',
    '      endDesign(tab, gen); // an arm called while this disarm', '      endDesign(tab, tab.designGen); // an arm called while this disarm'],
  ['the poll reads its generation AFTER the read round trip (F6)',
    "  const gen = pinned.designGen; // BEFORE the first await: a re-arm landing inside the read round trip must not be folded into this pick's generation\n  const raw = await readRawPick(wsId, pin);\n  if (!raw) return null;",
    "  const raw = await readRawPick(wsId, pin);\n  if (!raw) return null;\n  const gen = pinned.designGen;"],
  ['an arm call does not bump the generation (every clearing path is then current)',
    'const gen = ++tab.designGen;', 'const gen = tab.designGen;'],
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
// a kill (Ctrl-C, a rejected tool call, a timeout) must not leave the last mutant in the tree: route signals through the exit handler above
for (const [sig, rc] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => process.exit(rc));

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
