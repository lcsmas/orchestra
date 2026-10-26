import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_NOT_OWNER_CODE,
  annotateSwitchOutput,
  annotateTabListJson,
  annotateTabListText,
  decideAgentFront,
  decideCloseThroughCli,
  describeAgentTabs,
  isActingCdpMethod,
  parseAbTabList,
  parseTabInvocation,
  resolveAbTab,
  resolveSwitchTarget,
  tabCloseRefusal,
  type AbTab,
  type AgentTabView,
} from './browser-agent-tabs.ts';

// ---- bring to front ----------------------------------------------------------------------------------------------------

test('decideAgentFront: a non-active tab of the FOCUSED workspace comes to the front', () => {
  assert.deepEqual(decideAgentFront({ wsFocused: true, activeId: 't1', tabId: 't2', tabExists: true }), { act: 'activate' });
});

test('decideAgentFront: a BACKGROUND workspace never activates (story 44: no view attached or shown)', () => {
  assert.deepEqual(decideAgentFront({ wsFocused: false, activeId: 't1', tabId: 't2', tabExists: true }), { act: 'none', reason: 'background-workspace' });
});

test('decideAgentFront: the active tab and an unknown tab change nothing', () => {
  assert.deepEqual(decideAgentFront({ wsFocused: true, activeId: 't2', tabId: 't2', tabExists: true }), { act: 'none', reason: 'already-active' });
  assert.deepEqual(decideAgentFront({ wsFocused: true, activeId: 't1', tabId: 't9', tabExists: false }), { act: 'none', reason: 'unknown-tab' });
  // unknown beats background: a stale id is reported as such, not as a focus matter
  assert.deepEqual(decideAgentFront({ wsFocused: false, activeId: 't1', tabId: 't9', tabExists: false }), { act: 'none', reason: 'unknown-tab' });
});

test('isActingCdpMethod: what agent-browser v0.39.2 sends for snapshot / get / eval / click / screenshot / navigate is an ACTION', () => {
  for (const m of [
    'Runtime.evaluate', 'Accessibility.getFullAXTree', 'Page.navigate', 'Page.captureScreenshot', 'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent', 'DOM.getDocument', 'DOM.setFileInputFiles', 'Page.handleJavaScriptDialog', 'Network.getCookies',
    'Emulation.setDeviceMetricsOverride', 'Some.futureMethod',
  ]) {
    assert.equal(isActingCdpMethod(m), true, m);
  }
});

test('isActingCdpMethod: the attach-time chatter (measured per `tab new` / switch) is NOT an action', () => {
  for (const m of [
    'Page.enable', 'Runtime.enable', 'Network.enable', 'WebMCP.enable', 'DOM.enable', 'Accessibility.enable', 'Network.disable',
    'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger', 'Page.getFrameTree',
  ]) {
    assert.equal(isActingCdpMethod(m), false, m);
  }
  // not a suffix match on the word: a method merely ending in "enable"-like text is still decided by the dot
  assert.equal(isActingCdpMethod('Page.setLifecycleEventsEnabled'), true);
});

// ---- host ownership view -----------------------------------------------------------------------------------------------

test('describeAgentTabs: the user\'s tab is not closable by the agent (with the policy\'s own message), the agent\'s is', () => {
  const tabs = [
    { id: 't1', openedBy: 'human' as const },
    { id: 't2', openedBy: 'agent' as const },
  ];
  const v = describeAgentTabs(tabs, 't2', (id) => `TARGET-${id}`, 'agent');
  assert.deepEqual(v.map((x) => [x.targetId, x.openedBy, x.active, x.closable]), [
    ['TARGET-t1', 'human', false, false],
    ['TARGET-t2', 'agent', true, true],
  ]);
  assert.match(v[0]!.reason!, /opened by the user.*close only the tabs it opened/);
  assert.equal(v[1]!.reason, undefined);
});

// ---- CLI ---------------------------------------------------------------------------------------------------------------

test('parseTabInvocation: list / new / close / switch, with and without refs and flags', () => {
  assert.deepEqual(parseTabInvocation(['tab']), { op: 'list', refs: [], json: false });
  assert.deepEqual(parseTabInvocation(['tab', 'list']), { op: 'list', refs: [], json: false });
  assert.deepEqual(parseTabInvocation(['--json', 'tab', 'list']), { op: 'list', refs: [], json: true });
  assert.deepEqual(parseTabInvocation(['tab', 'new', 'http://x/']), { op: 'new', refs: [], json: false });
  assert.deepEqual(parseTabInvocation(['tab', 'new', '--label', 'docs', 'http://x/']), { op: 'new', refs: [], json: false });
  assert.deepEqual(parseTabInvocation(['tab', 'close']), { op: 'close', refs: [], json: false });
  assert.deepEqual(parseTabInvocation(['tab', 'close', 't3']), { op: 'close', refs: ['t3'], json: false });
  assert.deepEqual(parseTabInvocation(['--json', 'tab', 'close', 'docs']), { op: 'close', refs: ['docs'], json: true });
  assert.deepEqual(parseTabInvocation(['tab', 't2']), { op: 'switch', refs: ['t2'], json: false });
  assert.deepEqual(parseTabInvocation(['tab', 'docs']), { op: 'switch', refs: ['docs'], json: false });
});

test('parseTabInvocation: a ref hiding behind a value-taking flag is still a candidate (agent-browser takes globals around the subcommand; the CLI cannot know their arity)', () => {
  // pre-review finding 2: `tab close --timeout 3000 t1` used to parse as ref "3000", `tab --timeout 3000 close t1` as a SWITCH — both slipped past the gate
  assert.deepEqual(parseTabInvocation(['tab', 'close', '--timeout', '3000', 't1']), { op: 'close', refs: ['3000', 't1'], json: false });
  assert.deepEqual(parseTabInvocation(['tab', '--timeout', '3000', 'close', 't1']), { op: 'close', refs: ['3000', 't1'], json: false });
});

test('parseTabInvocation: any other command is not a tab invocation (a URL containing "tab" is not either)', () => {
  assert.equal(parseTabInvocation(['click', '@e2']), null);
  assert.equal(parseTabInvocation(['open', 'http://x/tab']), null);
  assert.equal(parseTabInvocation(['get', 'tab']), null);
  assert.equal(parseTabInvocation([]), null);
});

const T1: AbTab = { tabId: 't1', label: null, targetId: 'AAAA', active: false, title: 'Tabs fixture B' };
const T2: AbTab = { tabId: 't2', label: 'docs', targetId: 'BBBB', active: true };

test('resolveAbTab: by tN id, label or target id; no ref = the session\'s current tab; unknown = undefined', () => {
  assert.equal(resolveAbTab([T1, T2], 't1'), T1);
  assert.equal(resolveAbTab([T1, T2], 'docs'), T2);
  assert.equal(resolveAbTab([T1, T2], 'AAAA'), T1);
  assert.equal(resolveAbTab([T1, T2], undefined), T2);
  assert.equal(resolveAbTab([T1, T2], 't9'), undefined);
  assert.equal(resolveAbTab([{ ...T1 }, { ...T2, active: false }], undefined), undefined);
});

const HOST: AgentTabView[] = [
  { targetId: 'AAAA', openedBy: 'human', active: false, closable: false, reason: 'Tab t1 was opened by the user: an agent may close only the tabs it opened.' },
  { targetId: 'BBBB', openedBy: 'agent', active: true, closable: true },
];

test('decideCloseThroughCli: a close of the user\'s tab is REFUSED before agent-browser sees it — by ref, by target id and as the current tab', () => {
  for (const ref of ['t1', 'AAAA']) {
    const v = decideCloseThroughCli([T1, T2], [ref], HOST);
    assert.equal(v.run, false, ref);
    assert.match((v as { message: string }).message, /^Tab t1 (\(.*\) )?was opened by the user/, 'names the id the AGENT typed, not the registry\'s');
  }
  const asCurrent = decideCloseThroughCli([{ ...T1, active: true }, { ...T2, active: false }], [], HOST);
  assert.equal(asCurrent.run, false, 'no ref = the current tab, which here is the user\'s');
});

test('decideCloseThroughCli: a flag VALUE next to the ref does not hide it; flag values alone fall back to the current tab', () => {
  assert.equal(decideCloseThroughCli([T1, T2], ['3000', 't1'], HOST).run, false, '`tab close --timeout 3000 t1`');
  assert.equal(decideCloseThroughCli([{ ...T1, active: true }, { ...T2, active: false }], ['3000'], HOST).run, false, 'only a flag value, current tab is the user\'s');
  assert.deepEqual(decideCloseThroughCli([T1, T2], ['3000'], HOST), { run: true }, 'only a flag value, current tab is the agent\'s');
});

test('decideCloseThroughCli: the agent\'s own tab runs; an unresolvable ref and a target the host does not list pass through to agent-browser', () => {
  assert.deepEqual(decideCloseThroughCli([T1, T2], ['docs'], HOST), { run: true });
  assert.deepEqual(decideCloseThroughCli([T1, T2], [], HOST), { run: true });
  assert.deepEqual(decideCloseThroughCli([T1, T2], ['t9'], HOST), { run: true }, 'unknown ref, current tab is the agent\'s');
  assert.deepEqual(decideCloseThroughCli([T1, T2], ['t1'], []), { run: true });
});

test('tabCloseRefusal: non-zero, names the code, says the tab is still open; the --json form carries the same code', () => {
  const plain = tabCloseRefusal('Tab t1 was opened by the user.', false);
  assert.equal(plain.code, 1);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, new RegExp(`^${TAB_NOT_OWNER_CODE}: Tab t1 was opened by the user\\. It is still open\\.`));
  const js = tabCloseRefusal('Tab t1 was opened by the user.', true);
  const doc = JSON.parse(js.stdout);
  assert.equal(js.code, 1);
  assert.deepEqual([doc.success, doc.code], [false, TAB_NOT_OWNER_CODE]);
  assert.match(doc.error, /It is still open/);
});

test('annotateTabListText: appends who opened each tab and changes nothing else', () => {
  const native = '  [t1] CLI fixture - http://x/cli.html\n→ [t2] Fixture home - http://x/index.html\n';
  const out = annotateTabListText(native, [T1, { ...T2, label: null }], HOST);
  assert.equal(out, "  [t1] CLI fixture - http://x/cli.html (the user's)\n→ [t2] Fixture home - http://x/index.html (yours)\n");
});

test('annotateTabListText: a labelled tab keeps its `[tN] label title` line (measured on 0.39.2: the label follows the id); a line it cannot attribute is left alone', () => {
  const out = annotateTabListText('→ [t2] docs 127.0.0.1:1/index.html - http://x/\nno tabs open\n  [t7] ghost - http://y/\n', [T1, T2], HOST);
  assert.equal(out, '→ [t2] docs 127.0.0.1:1/index.html - http://x/ (yours)\nno tabs open\n  [t7] ghost - http://y/\n');
});

test('annotateTabListJson: adds openedBy + closable to each tab the host lists; garbage passes through untouched', () => {
  const doc = JSON.stringify({ success: true, data: { tabs: [{ tabId: 't1', targetId: 'AAAA' }, { tabId: 't2', targetId: 'BBBB' }, { tabId: 't3', targetId: 'CCCC' }] }, error: null });
  const out = JSON.parse(annotateTabListJson(doc, HOST));
  assert.deepEqual(out.data.tabs.map((t: any) => [t.tabId, t.openedBy, t.closable]), [['t1', 'human', false], ['t2', 'agent', true], ['t3', undefined, undefined]]);
  assert.equal(annotateTabListJson('not json', HOST), 'not json');
});

test('parseAbTabList: reads the real `--json tab list` shape (measured on agent-browser 0.39.2); null for anything else', () => {
  const real = '{"success":true,"data":{"lifecycle":{"launched":false},"tabs":[{"active":false,"label":null,"tabId":"t1","targetId":"3DB0C51127796395718680D356C981D8","title":"a","type":"page","url":"http://a/"},{"active":true,"label":"docs","tabId":"t2","targetId":"27498B9B768D17EC44A8FA9BA0BC96E2","title":"b","type":"page","url":"http://b/"}]},"error":null}';
  const tabs = parseAbTabList(real)!;
  assert.deepEqual(tabs.map((t) => [t.tabId, t.label, t.targetId, t.active]), [['t1', null, '3DB0C51127796395718680D356C981D8', false], ['t2', 'docs', '27498B9B768D17EC44A8FA9BA0BC96E2', true]]);
  assert.equal(parseAbTabList('{"success":false,"data":null,"error":"x"}'), null);
  assert.equal(parseAbTabList('nope'), null);
  assert.equal(parseAbTabList('{"success":true,"data":{"tabs":[{"tabId":1}]}}'), null);
});

test('F4b: a `tab <ref>` switch says whose tab it landed on — text and --json — so a stale tN that now names the user\'s tab is not silent', () => {
  const native = '✓ Tabs fixture B\n  http://127.0.0.1:1/tabs-b.html\n';
  assert.equal(annotateSwitchOutput(native, T1, HOST, false), "✓ Tabs fixture B (the user's)\n  http://127.0.0.1:1/tabs-b.html\n");
  assert.equal(annotateSwitchOutput(native, T2, HOST, false), '✓ Tabs fixture B (yours)\n  http://127.0.0.1:1/tabs-b.html\n');
  const js = JSON.parse(annotateSwitchOutput('{"success":true,"data":{"title":"B"},"error":null}', T1, HOST, true));
  assert.deepEqual([js.success, js.data.title, js.data.openedBy], [true, 'B', 'human']);
});

test('F4b: nothing it cannot attribute is touched — unknown tab, host without it, failure documents, garbage, blank output', () => {
  const native = '✓ X\n';
  assert.equal(annotateSwitchOutput(native, undefined, HOST, false), native);
  assert.equal(annotateSwitchOutput(native, T1, [], false), native);
  assert.equal(annotateSwitchOutput('{"success":false,"data":null,"error":"x"}', T1, HOST, true), '{"success":false,"data":null,"error":"x"}');
  assert.equal(annotateSwitchOutput('not json', T1, HOST, true), 'not json');
  assert.equal(annotateSwitchOutput('\n\n', T1, HOST, false), '\n\n');
});

test('F4b: resolveSwitchTarget takes the first candidate that resolves (a flag value such as 3000 is skipped)', () => {
  assert.equal(resolveSwitchTarget([T1, T2], ['3000', 't1']), T1);
  assert.equal(resolveSwitchTarget([T1, T2], ['docs']), T2);
  assert.equal(resolveSwitchTarget([T1, T2], ['3000']), undefined);
  assert.equal(resolveSwitchTarget([T1, T2], []), undefined);
});

test('round-2 F1: the close gate reads the spellings agent-browser accepts — case and whitespace of the USER\'s tab cannot slip past the pre-flight', () => {
  // the seat\'s deterministic table: control `t1` refused; every other spelling of the same tab refused too; the agent\'s own tab still RUNS under every spelling
  for (const ref of ['t1', 'T1', ' t1 ', 't1\t', '\tT1\n', 'aaaa', 'AAAA', ' aaaa ']) {
    const v = decideCloseThroughCli([T1, T2], [ref], HOST);
    assert.equal(v.run, false, `user's tab spelled ${JSON.stringify(ref)} must be refused`);
  }
  for (const ref of ['t2', 'T2', ' t2 ', 'bbbb', 'DOCS', ' docs ']) assert.deepEqual(decideCloseThroughCli([T1, T2], [ref], HOST), { run: true }, `agent's tab ${JSON.stringify(ref)}`);
  assert.equal(resolveAbTab([T1, T2], ' T2 '), T2);
  assert.equal(resolveAbTab([T1, T2], '   '), undefined, 'a blank ref resolves to nothing (not the current tab)');
  assert.equal(resolveAbTab([T1, { tabId: 't3', label: '', targetId: 'CCCC', active: false }], '  '), undefined, 'not even a tab whose label is the empty string');
  assert.equal(resolveSwitchTarget([T1, T2], ['3000', ' T1 ']), T1, 'a switch reads the same spellings');
});
