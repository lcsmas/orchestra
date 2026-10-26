// Must-FAIL proof for the #397 unit layer (ledger #405). Mutates the SOURCE files in place, one clause at a time; each mutant MUST redden the
// test files listed with it, and every file is restored from a byte-exact backup and `cmp`-checked after every mutant (and on any exit path).
// Built-app mutants (bundle patches) live in scripts/e2e-browser-agent-tabs.mjs. Run: node scripts/mutate-browser-agent-tabs.mjs [--only <substr>]  (RC 0 = all killed)
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const T = {
  pure: 'src/shared/browser-agent-tabs.test.ts',
  core: 'src/shared/cdp-proxy-core-agent-tabs.test.ts',
  panel: 'src/main/browser-panel-agent-tabs.test.ts',
  wiring: 'src/main/browser-agent-tabs-wiring.test.ts',
};
const F = {
  pure: 'src/shared/browser-agent-tabs.ts',
  core: 'src/shared/cdp-proxy-core.ts',
  panel: 'src/main/browser-panel.ts',
  host: 'src/main/browser-cdp-host.ts',
  cli: 'src/cli/index.ts',
  tsx: 'src/renderer/components/BrowserPanel.tsx',
  css: 'src/renderer/styles.css',
};

// [file, name, find, replace, tests that must go red]
const MUTANTS = [
  [F.pure, 'bring-to-front ignores the focus rule (a background workspace activates)', "  if (!i.wsFocused) return { act: 'none', reason: 'background-workspace' };\n", '', [T.pure]],
  [F.pure, 'bring-to-front re-activates the already-active tab', "  if (i.activeId === i.tabId) return { act: 'none', reason: 'already-active' };\n", '', [T.pure]],
  [F.pure, 'bring-to-front acts on an unknown tab', "  if (!i.tabExists) return { act: 'none', reason: 'unknown-tab' };\n", '', [T.pure]],
  [F.pure, 'domain enables count as agent actions', "  if (/\\.(enable|disable)$/.test(method)) return false;\n", '', [T.pure, T.core]],
  [F.pure, 'attach-time calls count as agent actions', "  'Runtime.runIfWaitingForDebugger',\n  'Target.setAutoAttach',\n  'Page.getFrameTree',\n", '', [T.pure, T.core]],
  [F.pure, 'nothing counts as an agent action', "  return !PASSIVE_METHODS.has(method);\n}", "  return false && !PASSIVE_METHODS.has(method);\n}", [T.pure, T.core]],
  [F.pure, 'a forbidden close is never refused at the CLI', "    if (view && !view.closable) {", "    if (false as boolean) {", [T.pure]],
  [F.pure, 'only the FIRST candidate ref reaches the close gate (a ref behind a flag value escapes)', "const named = refs.map((r) => resolveAbTab(abTabs, r)).filter((t): t is AbTab => t !== undefined);", "const named = refs.slice(0, 1).map((r) => resolveAbTab(abTabs, r)).filter((t): t is AbTab => t !== undefined);", [T.pure]],
  [F.pure, 'a close naming nothing resolvable does not fall back to the current tab', "const targets = named.length > 0 ? named : [resolveAbTab(abTabs, undefined)]", "const targets = named.length > 0 || refs.length > 0 ? named : [resolveAbTab(abTabs, undefined)]", [T.pure]],
  [F.pure, 'the refusal names the registry/host id, not the id the agent typed', "return { run: false, message: `Tab ${tab.tabId}${tab.title", "return { run: false, message: `Tab ${view.targetId}${tab.title", [T.pure]],
  [F.pure, 'a close with no ref resolves the first tab, not the current one', "if (ref === undefined) return tabs.find((t) => t.active);", "if (ref === undefined) return tabs[0];", [T.pure]],
  [F.pure, 'a label is not a tab ref', "    tabs.find((t) => t.label !== null && normRef(t.label) === r) ??\n", '', [T.pure]],
  [F.pure, 'a target id is not a tab ref', "    tabs.find((t) => normRef(t.targetId) === r)\n", "    undefined\n", [T.pure]],
  [F.pure, 'the host calls every tab closable', "      closable: d.ok,\n", "      closable: true,\n", [T.pure]],
  [F.pure, 'tab close loses its refs', "  return { op, refs: words.filter((_, i) => i !== opAt), json };", "  return { op, refs: [], json };", [T.pure]],
  [F.pure, 'the subcommand is only recognised as the FIRST word (`tab --timeout 3000 close t1` becomes a switch)', "const opAt = words.findIndex((w) => w === 'list' || w === 'new' || w === 'close');", "const opAt = ['list', 'new', 'close'].includes(words[0] ?? '') ? 0 : -1;", [T.pure]],
  [F.pure, 'the owner suffix is swapped', "(o === AGENT_OPENER ? ' (yours)' : \" (the user's)\")", "(o === AGENT_OPENER ? \" (the user's)\" : ' (yours)')", [T.pure]],
  [F.pure, 'the refusal exits 0', "if (json) return { code: 1, stdout: JSON.stringify", "if (json) return { code: 0, stdout: JSON.stringify", [T.pure]],
  [F.core, 'an acting command never brings its tab to the front', "    if (isActingCdpMethod(method)) this.bringToFrontIfBackground(tabId);\n", '', [T.core, T.wiring]],
  [F.core, 'EVERY command brings its tab to the front (enables included)', "    if (isActingCdpMethod(method)) this.bringToFrontIfBackground(tabId);", "    this.bringToFrontIfBackground(tabId);", [T.core]],
  [F.panel, 'an agent opens its tab ACTIVE in a background workspace', "openedBy: AGENT_OPENER, activate: focusedWsId === wsId });", "openedBy: AGENT_OPENER, activate: true });", [T.panel, T.wiring]],
  [F.panel, 'the agent closes as the human (any tab)', "const r = tryCloseTab(wsId, tabId, AGENT_OPENER);", "const r = tryCloseTab(wsId, tabId, 'human');", [T.panel, T.wiring]],
  [F.panel, 'agentActivateTab ignores the focus rule', "decideAgentFront({ wsFocused: focusedWsId === wsId,", "decideAgentFront({ wsFocused: true,", [T.panel, T.wiring]],
  [F.panel, 'an agent swap is not recorded for the human', "    panel.agentSwitch = { from: origin === tab.id ? from : origin, to: tab.id, at: Date.now() };\n  } else delete panel.agentSwitch;", "  } else delete panel.agentSwitch;", [T.panel]],
  [F.panel, 'chained agent swaps point « Back » at the own previous agent stop', "const origin = prev && prev.to === from && panel.tabs.some((t) => t.id === prev.from) ? prev.from : from;", "const origin = from;", [T.panel]],
  [F.panel, '« Back » may point at a tab that was closed meanwhile (the chain keeps a dead from)', "prev.to === from && panel.tabs.some((t) => t.id === prev.from) ? prev.from : from;", "prev.to === from ? prev.from : from;", [T.panel]],
  [F.panel, 'returning to the human tab makes « Back » point at the tab you are on', "from: origin === tab.id ? from : origin,", "from: origin,", [T.panel]],
  [F.panel, 'a swap by the human leaves the agent notice up', "  } else delete panel.agentSwitch;\n  if (panel.attachedId", "  }\n  if (panel.attachedId", [T.panel]],
  [F.panel, 'the agent closing the tab on screen is not announced', "  if (after && after.activeId !== tabId) {\n    after.agentSwitch = { from: tabId, to: after.activeId, at: Date.now() };\n    publish(after);\n  }", "", [T.panel]],
  [F.panel, 'the first read_page (no panel yet) pins nothing', "const read = tab ?? (panel ? activeTabOf(panel) : undefined);", "const read = tab;", [T.panel]],
  [F.panel, 'click ref swaps the human tab BEFORE it knows the ref exists', "  const p = await refToPoint(wsId, ref, pin); // a stale ref fails HERE, before anything is swapped on the human's screen\n  if (pin !== undefined) agentActivateTab(wsId, pin);", "  if (pin !== undefined) agentActivateTab(wsId, pin);\n  const p = await refToPoint(wsId, ref, pin);", [T.panel]],
  [F.panel, 'form_input of a missing ref reports success', "  if (found === false) throw new Error(`ref_${ref} not found (call read_page again)`); // before any swap on the human's screen\n", "", [T.panel]],
  [F.panel, 'an agent-opened tab that takes the screen is not an agent swap', "setActive(panel, tab, tab.openedBy === AGENT_OPENER)", "setActive(panel, tab)", [T.panel]],
  [F.panel, 'read_page does not pin its tab', "  if (panel && read) panel.refTabId = read.id;\n", '', [T.panel]],
  [F.panel, 'click ref follows the active tab, not the pinned one', "  const pin = refTab(wsId, tabId); // resolve once", "  const pin = tabId ?? resolveTab(wsId)?.id; // resolve once", [T.panel]],
  [F.panel, 'click ref does not bring the pinned tab to the front', "  if (pin !== undefined) agentActivateTab(wsId, pin); // a click needs", "  void 0; // a click needs", [T.panel]],
  [F.panel, 'form_input ignores the pin', "  const pin = refTab(wsId, tabId);\n  const found = await evaluate(", "  const pin = tabId;\n  const found = await evaluate(", [T.panel]],
  [F.panel, 'a pin on a closed tab silently falls back to the active tab', "    if (!panel.tabs.some((t) => t.id === panel.refTabId)) {\n      throw new Error('the tab this ref came from was closed (call read_page again)');\n    }\n", '', [T.panel]],
  [F.host, 'the proxy opens tabs with the bare, unguarded createTab', "const r = bp.agentOpenTab(wsId, url ? { url } : {});\n      if (!r.ok) throw new Error(r.message);\n      const info = bp.listTabs(wsId).find((t) => t.id === r.tabId);", "const t = bp.createTab(wsId, { ...(url ? { url } : {}), openedBy: 'agent', activate: true });\n      const info = bp.listTabs(wsId).find((x) => x.id === t.id);", [T.wiring]],
  [F.host, 'the proxy closes tabs with the bare, unguarded closeTab', "const r = bp.agentCloseTab(wsId, tabId);\n      if (!r.ok) throw new Error(r.message);", "bp.closeTab(wsId, tabId);", [T.wiring]],
  [F.host, 'the proxy activates tabs with the bare activateTab', "bp.agentActivateTab(wsId, tabId);\n    },\n    userAgent", "try { bp.activateTab(wsId, tabId); } catch { /* */ }\n    },\n    userAgent", [T.wiring]],
  [F.host, 'the tabs op answers after the panel is revealed', "    if (msg.op === 'tabs') {", "    bp.revealForAgent(id);\n    if (msg.op === 'tabs') {", [T.wiring]],
  [F.cli, 'the CLI runs a forbidden close', "        if (!verdict.run) {\n          run = tabCloseRefusal(verdict.message, tab.json);", "        if (false as boolean) {\n          run = tabCloseRefusal((verdict as { message: string }).message, tab.json);", [T.wiring]],
  [F.tsx, 'the notice is never rendered', "{agentNoticeOn && agentSwitch && (", "{false && agentNoticeOn && agentSwitch && (", [T.wiring]],
  [F.css, 'round-2 F2: the agent mark takes width again (in flow)', "  position: absolute;\n  left: 3px;\n  top: 50%;", "  position: static;\n  left: 3px;\n  top: 50%;", [T.wiring]],
  [F.css, 'round-2 F2: a tab no longer clips its contents (the × can leave its tab)', "  position: relative;\n  overflow: hidden;\n}\n.browser-tab:hover {", "  position: relative;\n}\n.browser-tab:hover {", [T.wiring]],
  [F.css, 'F2/F6/F3: the swap notice is an overlay again (can cover tabs / the URL bar)', ".browser-agent-switch {\n  display: flex;", ".browser-agent-switch {\n  position: absolute;\n  display: flex;", [T.wiring]],
  [F.core, 'round-2 INFO: renderer-destroying methods are not ownership-gated', "    if (TAB_DESTROYING_METHODS.has(method)) {", "    if (false && TAB_DESTROYING_METHODS.has(method)) {", [T.core, T.wiring]],
  [F.core, 'round-2 INFO: the destroyer gate protects the AGENT\'s tab instead of the user\'s', "if (owner && owner.openedBy !== 'agent') {", "if (owner && owner.openedBy === 'agent') {", [T.core]],
  [F.core, 're-attack F4: navigation of the user\'s tab to an internal URL is not gated', "    if (method === 'Page.navigate' || method === 'Page.navigateToHistoryEntry') {", "    if (false && (method === 'Page.navigate' || method === 'Page.navigateToHistoryEntry')) {", [T.core]],
  [F.core, 're-attack F4: the navigation gate protects the AGENT\'s tab instead of the user\'s', "owner.openedBy !== 'agent' && (await this.navigatesToInternalUrl(", "owner.openedBy === 'agent' && (await this.navigatesToInternalUrl(", [T.core]],
  [F.core, 're-attack F4: a history entry is not resolved to its URL (navigateToHistoryEntry escapes)', "      return isBrowserInternalUrl(h?.entries?.find((e) => e.id === params?.entryId)?.url);", "      return false;", [T.core]],
  [F.core, 're-attack F4: a failed history lookup fails OPEN', "      if (e === gone) throw e; // the child is gone: answer like any command on a dead session, not with an internal-URL refusal\n      return true;", "      if (e === gone) throw e; // the child is gone: answer like any command on a dead session, not with an internal-URL refusal\n      return false;", [T.core]],
  [F.core, 're-attack F4: a refused navigation still swaps the human\'s view (bring-to-front before the throw)', "        throw new CdpError(internalNavigationRefusal(method, tabId), ERR_SERVER);", "        this.bringToFrontIfBackground(tabId);\n        throw new CdpError(internalNavigationRefusal(method, tabId), ERR_SERVER);", [T.core]],
  [F.pure, 're-attack F4: devtools: is not an internal scheme', "'chrome-distiller', 'devtools'])", "'chrome-distiller'])", [T.pure]],
  [F.pure, 're-attack F4: about: is never internal (about:crash escapes — Chromium rewrites it to chrome://)', "if (m[1] === 'about') return !/^(blank|srcdoc)([?#].*)?$/s.test(m[2]!);", "if (m[1] === 'about') return false;", [T.pure, T.core]],
  [F.pure, 're-attack F4: about:blank is refused too', "if (m[1] === 'about') return !/^(blank|srcdoc)([?#].*)?$/s.test(m[2]!);", "if (m[1] === 'about') return true;", [T.pure, T.core]],
  [F.pure, 're-attack F4: leading/trailing space and control characters are not trimmed', ".replace(/^[\\u0000-\\u0020]+|[\\u0000-\\u0020]+$/g, '')", "", [T.pure, T.core]],
  [F.pure, 're-attack F4: tab/newline inside the URL are not dropped (the parser drops them)', ".replace(/[\\t\\n\\r]/g, '').toLowerCase();", ".toLowerCase();", [T.pure]],
  [F.pure, 're-attack F4: the scheme is case-sensitive', ".replace(/[\\t\\n\\r]/g, '').toLowerCase();", ".replace(/[\\t\\n\\r]/g, '');", [T.pure, T.core]],
  [F.pure, 're-attack F4: view-source: is not unwrapped', "for (let i = 0; i < 4 && u.startsWith('view-source:'); i++)", "for (let i = 0; i < 0 && u.startsWith('view-source:'); i++)", [T.pure]],
  [F.pure, 're-attack F4: a non-string url counts as internal', "if (typeof url !== 'string') return false;", "if (typeof url !== 'string') return true;", [T.pure]],
  [F.pure, 'round-2 F1: ref spellings are not case-folded', "const normRef = (r: string): string => r.trim().toLowerCase();", "const normRef = (r: string): string => r.trim();", [T.pure]],
  [F.pure, 'round-2 F1: ref spellings are not trimmed', "const normRef = (r: string): string => r.trim().toLowerCase();", "const normRef = (r: string): string => r.toLowerCase();", [T.pure]],
  [F.pure, 'round-2 F1: a blank ref resolves to something', "  if (r === '') return undefined;\n", "", [T.pure]],
  [F.core, 'F1: the browser-level rules are skipped for a CHILD session (the predicate is applied to root sessions only)', "    if (isBrowserLevelMethod(method)) {", "    if (isBrowserLevelMethod(method) && !childSessionId) {", [T.core]],
  [F.core, 'F1: Page.close is not a browser-level verb (root and child both reach the debugger)', "  return method === 'Page.close' || method.startsWith('Browser.')", "  return method.startsWith('Browser.')", [T.core]],
  [F.core, 'F1: Browser.* is not a browser-level verb', " || method.startsWith('Browser.') || TAB_SESSION_BROWSER_LEVEL.has(method);", " || TAB_SESSION_BROWSER_LEVEL.has(method);", [T.core]],
  [F.core, 'F3: a CHILD session skips the frames fail-fast', "    if (FRAME_BOUND_METHODS.has(method)) {\n      const why = this.port.framesError(tabId);", "    if (!childSessionId && FRAME_BOUND_METHODS.has(method)) {\n      const why = this.port.framesError(tabId);", [T.core, T.wiring]],
  [F.core, 'F3: a CHILD session\'s acting command does not bring its tab to the front', "    if (isActingCdpMethod(method)) this.bringToFrontIfBackground(tabId);\n    if (FRAME_BOUND", "    if (!childSessionId && isActingCdpMethod(method)) this.bringToFrontIfBackground(tabId);\n    if (FRAME_BOUND", [T.core, T.wiring]],
  [F.pure, 'F4b: a switch is not annotated with whose tab it landed on', "  lines[i] += ownerSuffix(owner);", "  lines[i] += '';", [T.pure]],
  [F.pure, 'F4b: --json switch loses openedBy', "      doc.data.openedBy = owner;\n", "", [T.pure]],
  [F.pure, 'F4b: only the first candidate token is tried for the switch target', "  for (const r of refs) {\n    const t = resolveAbTab(abTabs, r);\n    if (t) return t;", "  for (const r of refs.slice(0, 1)) {\n    const t = resolveAbTab(abTabs, r);\n    if (t) return t;", [T.pure]],
  [F.cli, 'F4b: a switch is not pre-flighted (no annotation)', "if (tab && (tab.op === 'list' || tab.op === 'close' || tab.op === 'switch')) {", "if (tab && (tab.op === 'list' || tab.op === 'close')) {", [T.wiring]],
];

const backups = new Map();
const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'bat-mut-'));
for (const f of new Set(MUTANTS.map((m) => m[0]))) {
  const bak = path.join(dir, f.replace(/\//g, '__'));
  copyFileSync(path.join(root, f), bak);
  backups.set(f, bak);
}
const restoreAll = () => { for (const [f, bak] of backups) copyFileSync(bak, path.join(root, f)); };
process.on('exit', () => { try { restoreAll(); } catch {} });

// Every anchor must match EXACTLY once BEFORE anything runs (a stale one used to abort the sweep after minutes of baseline + mutants, once cbba639b rewrote a catch it anchored on).
// `--check` stops here: no tests, nothing mutated.
const staleAnchors = MUTANTS.map(([file, name, find]) => ({ file, name, n: readFileSync(path.join(root, file), 'utf8').split(find).length - 1 })).filter((m) => m.n !== 1);
if (staleAnchors.length) {
  for (const m of staleAnchors) console.log(`BAD  (${m.n}x in ${m.file}) ${m.name}`);
  console.log(`${staleAnchors.length} mutant anchor(s) stale — re-anchor before sweeping`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`all ${MUTANTS.length} mutant anchors match exactly once`); process.exit(0); }

const run = (tests) => spawnSync('node', ['--test', '--experimental-strip-types', ...tests], { cwd: root, encoding: 'utf8' });
const allTests = Object.values(T);

// Positive control: the UNMUTATED tree passes every file (a rig that cannot say PASS proves nothing).
const base = run(allTests);
const baseCount = /# pass (\d+)/.exec(base.stdout)?.[1];
if (base.status !== 0) { console.log('BASELINE FAILS — abort\n' + base.stdout.slice(-2500)); process.exit(2); }
console.log(`baseline PASS (${baseCount} tests over ${allTests.length} files)`);

let killed = 0, ran = 0;
const survivors = [];
for (const [file, name, find, replace, tests] of MUTANTS) {
  if (only && !name.includes(only)) continue;
  const orig = readFileSync(backups.get(file), 'utf8');
  const n = orig.split(find).length - 1;
  if (n !== 1) { console.log(`ABORT: mutant "${name}" find-string occurs ${n}x in ${file} (need exactly 1)`); restoreAll(); process.exit(2); }
  writeFileSync(path.join(root, file), orig.replace(find, () => replace));
  if (readFileSync(path.join(root, file), 'utf8') === orig) { console.log(`ABORT: mutant "${name}" did not change the file`); restoreAll(); process.exit(2); }
  const r = run(tests);
  restoreAll();
  ran++;
  const red = (r.stdout.match(/^not ok .*/gm) || []).length;
  const dead = r.status !== 0 && red > 0;
  if (dead) killed++; else survivors.push(name);
  console.log(`${dead ? 'KILLED  ' : 'SURVIVED'} ${name}${dead ? `  (${red} arm(s) red in ${tests.map((t) => path.basename(t)).join(', ')})` : ''}`);
}
let exact = true;
for (const [f, bak] of backups) if (!readFileSync(path.join(root, f)).equals(readFileSync(bak))) exact = false;
console.log(`\n${killed}/${ran} killed; restore byte-exact (cmp) over ${backups.size} files: ${exact}`);
if (survivors.length) console.log('SURVIVORS:\n  ' + survivors.join('\n  '));
process.exit(survivors.length || !exact ? 1 : 0);
