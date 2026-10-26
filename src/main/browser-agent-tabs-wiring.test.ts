// Wiring pins for #397 (the seams no unit sees from inside): the proxy's tab operations go through the panel's POLICY-CHECKED entry
// points, the host answers `{op:'tabs'}` from the same pure rule the proxy enforces, the CLI refuses a forbidden close before agent-browser,
// and the renderer shows the notice. Mutants: scripts/mutate-browser-agent-tabs.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the proxy port opens / closes / activates tabs ONLY through the agent entry points (never the bare createTab / closeTab / activateTab)', () => {
  const host = read('./browser-cdp-host.ts');
  assert.match(host, /createTab: async \(url\) => \{\s*const r = bp\.agentOpenTab\(wsId, url \? \{ url \} : \{\}\);\s*if \(!r\.ok\) throw new Error\(r\.message\);/);
  assert.match(host, /closeTab: async \(tabId\) => \{\s*const r = bp\.agentCloseTab\(wsId, tabId\);\s*if \(!r\.ok\) throw new Error\(r\.message\);/);
  assert.match(host, /activateTab: \(tabId\) => \{\s*bp\.agentActivateTab\(wsId, tabId\);/);
  for (const bare of ['bp.createTab(', 'bp.closeTab(', 'bp.activateTab(']) assert.equal(host.includes(bare), false, `${bare} bypasses the cap / ownership rule`);
  assert.equal(host.includes('INTERIM_TAB_CAP'), false, 'the hand-rolled interim cap is gone: the policy module owns the cap');
});

test('the agent entry points ask the SAME pure policy as the human strip (tryOpenTab / tryCloseTab with the agent actor)', () => {
  const panel = read('./browser-panel.ts');
  assert.match(panel, /export function agentOpenTab\([^)]*\): BrowserTabResult \{\s*return tryOpenTab\(wsId, \{[\s\S]{0,80}?openedBy: AGENT_OPENER, activate: focusedWsId === wsId \}\);/);
  assert.match(panel, /export function agentCloseTab\([^)]*\): BrowserTabResult \{[\s\S]{0,160}?const r = tryCloseTab\(wsId, tabId, AGENT_OPENER\);/);
  assert.match(panel, /decideAgentFront\(\{ wsFocused: focusedWsId === wsId,/);
});

test('/browser answers {op:"tabs"} from describeAgentTabs (decideTabClose with the agent actor), after the session-key check and before revealing the panel', () => {
  const host = read('./browser-cdp-host.ts');
  const verify = host.indexOf('sessionKeys().verify(id, key)');
  const op = host.indexOf("msg.op === 'tabs'");
  const reveal = host.indexOf('bp.revealForAgent(id)');
  assert.ok(verify > 0 && op > verify && reveal > op, 'order: verify → tabs op → reveal');
  assert.match(host, /describeAgentTabs\(bp\.listTabs\(id\), bp\.getActiveTab\(id\)\?\.id \?\? null, \(t\) => ep\.server\.core\.targetIdFor\(t\), AGENT_OPENER\)/);
});

test('the CLI refuses a close of the user\'s tab BEFORE agent-browser runs it, and annotates `tab list`', () => {
  const cli = read('../cli/index.ts');
  const body = cli.slice(cli.indexOf("case 'browser': {"), cli.indexOf("case 'whoami': {"));
  assert.match(body, /parseTabInvocation\(plan\.args\)/);
  assert.match(body, /op: 'tabs'/);
  const refuse = body.indexOf('tabCloseRefusal(verdict.message');
  const nativeClose = body.indexOf('run = await runAb(plan.args);');
  assert.ok(refuse > 0 && nativeClose > refuse, 'the refusal branch comes before the native close is run');
  assert.match(body, /if \(!verdict\.run\) \{\s*run = tabCloseRefusal\(verdict\.message, tab\.json\);/);
  assert.match(body, /decideCloseThroughCli\(abTabs, tab\.refs, hostTabs\)/, 'ALL candidate refs reach the gate, not just the first token');
  assert.match(body, /tab && \(tab\.op === 'list' \|\| tab\.op === 'close' \|\| tab\.op === 'switch'\)/, 'a switch is pre-flighted too: a stale tN must say whose tab it landed on');
  assert.match(body, /annotateSwitchOutput\(run\.stdout, resolveSwitchTarget\(abTabs, tab\.refs\), hostTabs, tab\.json\)/);
  assert.match(body, /annotateTabListJson\(run\.stdout, hostTabs\) : annotateTabListText\(run\.stdout, abTabs, hostTabs\)/);
});

test('the proxy core brings a tab to the front on any ACTING command, before the frame-bound refusal', () => {
  const core = read('../shared/cdp-proxy-core.ts');
  const acting = core.indexOf('if (isActingCdpMethod(method)) this.bringToFrontIfBackground(tabId);');
  const frames = core.indexOf('if (FRAME_BOUND_METHODS.has(method)) {');
  assert.ok(acting > 0 && frames > acting, 'bring-to-front precedes the framesError check, so a click on a background tab succeeds instead of being refused');
});

test('the renderer announces an agent swap in a ROW below the toolbar and marks agent tabs without taking width', () => {
  const tsx = read('../renderer/components/BrowserPanel.tsx');
  assert.match(tsx, /\{agentNoticeOn && agentSwitch && \(\s*<div className="browser-agent-switch" role="status"/);
  assert.match(tsx, /browserTabActivate\(workspaceId, agentSwitch\.from\)/, 'Back is a HUMAN tab activation (it clears the notice)');
  const strip = tsx.indexOf('className="browser-tab-new"');
  const toolbar = tsx.indexOf('<div className="browser-toolbar">');
  const notice = tsx.indexOf('className="browser-agent-switch"');
  const holder = tsx.indexOf('className="browser-holder"');
  assert.ok(strip > 0 && toolbar > strip && notice > toolbar && holder > notice, 'tabs, toolbar, notice row, page area — the notice is a ROW BELOW the toolbar: it never moves or covers a tab, ×, +, the URL bar or the design button');
  assert.ok(!tsx.includes('browser-tabs-row'), 'no overlay wrapper');
  assert.match(tsx, /t\.openedBy === 'agent' && \(\s*<span className="browser-tab-agent-mark"/);
  const css = read('../renderer/styles.css');
  const notice_css = /\.browser-agent-switch \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.doesNotMatch(notice_css, /position:/, 'F2/F6/F3: the notice is an in-flow ROW (an overlay can cover a tab, a ×, the URL bar or the design button; a row in the tab flow would move the tabs — it is neither)');
  const mark = /\.browser-tab-agent-mark \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(mark, /position:\s*absolute/, 'round-2 F2: the agent mark takes NO width (a text badge widened every agent tab ~38 px: at 6-8 tabs its × overflowed onto the next tab / the +)');
  assert.match(mark, /font-size:\s*0/);
  const tab = /\.browser-tab \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(tab, /overflow:\s*hidden/, 'a tab clips its contents: the × can never leave its own tab');
  assert.match(tab, /position:\s*relative/, 'the absolute mark\'s containing block');
});

test('F1/F3: #395\'s shared isBrowserLevelMethod decides the browser-level verbs BEFORE the root/child split (not copied here); the frame-bound + bring-to-front checks are not root-only', () => {
  const core = read('../shared/cdp-proxy-core.ts');
  assert.ok(!core.includes('isBrowserLevelOnTabSession'), 'no second predicate in #397');
  const dispatch = core.slice(core.indexOf('private async dispatch('), core.indexOf('// ── browser-level surface'));
  const pred = dispatch.indexOf('if (isBrowserLevelMethod(method)) {');
  const split = dispatch.indexOf('return this.tabCommand(tabId, method, params, childSessionId);');
  assert.ok(pred > 0 && split > pred, 'the predicate is applied before the tab/child split');
  const tab = core.slice(core.indexOf('private async tabCommand('), core.indexOf('/** An agent action on a tab nobody is looking at'));
  assert.match(tab, /\n    if \(isActingCdpMethod\(method\)\) this\.bringToFrontIfBackground\(tabId\);\n    if \(FRAME_BOUND_METHODS\.has\(method\)\) \{/, 'neither is inside an `if (!childSessionId)` guard');
  assert.match(tab, /if \(!childSessionId && method === 'Page\.captureScreenshot'\)/, 'only the screenshot interception stays root-only');
});

test('round-2 INFO: tabCommand refuses TAB_DESTROYING_METHODS on a tab the agent did not open, before the debugger, for root AND child sessions', () => {
  const core = read('../shared/cdp-proxy-core.ts');
  const tab = core.slice(core.indexOf('private async tabCommand('), core.indexOf('/** An agent action on a tab nobody is looking at'));
  const gate = tab.indexOf('if (TAB_DESTROYING_METHODS.has(method)) {');
  const send = tab.indexOf('st.channel.send(method, params, childSessionId)');
  assert.ok(gate > 0 && send > gate, 'the gate precedes the debugger send');
  assert.match(tab, /owner && owner\.openedBy !== 'agent'/);
  const pure = read('../shared/browser-agent-tabs.ts');
  assert.match(pure, /TAB_DESTROYING_METHODS[^=]*= new Set\(\['Page\.crash', 'Runtime\.terminateExecution'\]\)/);
});
