// Wiring pins for #395 (the pieces no unit can see from inside): the route, the verb, the teardown hook and "the old tools keep working".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COMMANDS } from '../cli/help.ts';

const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the hooks socket serves /browser through dispatchBrowserRequest (and only there)', () => {
  const src = read('./hooks-server.ts');
  assert.match(src, /route === '\/browser'[\s\S]{0,400}dispatchBrowserRequest\(msg\)/);
  assert.equal((src.match(/dispatchBrowserRequest/g) ?? []).length, 2, 'one import + one call: no second path to the endpoint');
});

test('m4: every /browser call re-prepares the layout, and quit removes only our own socket dir after the daemons are gone', () => {
  const host = read('./browser-cdp-host.ts');
  assert.match(host, /const l = layout\(\);\s*prepareLayout\(l\);[\s\S]{0,200}await ensureDaemon\(/);
  assert.match(host, /terminateDaemonsOf\(layout\(\)\)[\s\S]{0,400}await Promise\.all\(\[\.\.\.endpoints\.keys\(\)\]\.map\(\(id\) => disposeEndpoint\(id\)\)\);[\s\S]{0,200}removeSocketDir\(layout\(\)\)/);
});

test('seam review m2: everything the client prints passes through redactEndpoint with the host-issued URL before it reaches the agent', () => {
  const cli = read('../cli/index.ts');
  assert.match(cli, /const wsUrl = res\.wsUrl as string;\s*const out = mapBrowserFailure\(\{ \.\.\.run, stdout: redactEndpoint\(run\.stdout, wsUrl\), stderr: redactEndpoint\(run\.stderr, wsUrl\) \}/);
});

test('M2: the proxy URL reaches agent-browser through its environment only — neither the CLI nor the host puts it in an argv', () => {
  const cli = read('../cli/index.ts');
  assert.match(cli, /spawnChild\(binary, plan\.args, /);
  assert.doesNotMatch(cli, /'--cdp'/, 'the CLI no longer passes --cdp');
  const host = read('./browser-cdp-host.ts');
  assert.match(host, /env: \{ \.\.\.abEnv\(l, ep\.session, shot\), AGENT_BROWSER_CDP: ep\.server\.wsUrl \}/);
  const daemon = read('./agent-browser-daemon.ts');
  assert.match(daemon, /deps\.run\(binary, \['get', 'url'\], \{ \.\.\.abEnv\(layout, session, undefined\), AGENT_BROWSER_CDP: wsUrl \}/);
  assert.doesNotMatch(daemon, /\['connect', wsUrl\]/);
});

test('the CLI verb is registered with help, sends the session key, refuses before the socket, and is NOT a bus-identity verb', () => {
  const cli = read('../cli/index.ts');
  assert.match(cli, /case 'browser': \{[\s\S]*prepareBrowserCommand\(args, process\.cwd\(\)\)[\s\S]*if \(!plan\.ok\) fail\(plan\.error\)[\s\S]*request\(\s*'\/browser'/);
  assert.match(cli, /key: process\.env\.ORCHESTRA_SESSION_KEY/);
  assert.ok(COMMANDS.some((c) => c.name === 'browser' && c.group === 'Browser'));
  const m = /const HOST_IDENTITY_VERBS[^\n]*\n/.exec(cli);
  assert.ok(m && !m[0].includes("'browser'"), 'browser never reads the run/generation, so it must not pay the identity round-trip');
});

test('panel teardown reaches the proxy: destroyPanel notifies observers with destroyed=true and the host disposes on it', () => {
  const panel = read('./browser-panel.ts');
  assert.match(panel, /notifyPanelListeners\(wsId, \[\], true\)/);
  const host = read('./browser-cdp-host.ts');
  assert.match(host, /onPanelChange\(\(wsId, _tabs, destroyed\) => \{\s*if \(destroyed\) void disposeEndpoint\(wsId\)/);
  assert.match(read('./index.ts'), /disposeAllEndpoints\(\)/);
});

test('the proxy host is the ONLY attacher (#398): it acquires the seat; the seat owns attach, the grace-delayed reset and the detach', () => {
  const host = read('./browser-cdp-host.ts');
  assert.equal((host.match(/\bdebugger\b/g) ?? []).length, 0, 'browser-cdp-host.ts touches no debugger itself — browser-cdp-seat.ts does');
  assert.match(host, /seatAcquire\(live, `seat\[\$\{wsId\.slice\(0, 8\)\}\] \$\{tabId\}`\)/);
  assert.match(host, /release: \(tabId\) => \{\s*const live = bp\.tabContents\(wsId, tabId\);\s*if \(live\) seatRelease\(live, RELEASE_GRACE_MS\);/, 'the last session leaving starts the grace period');
  assert.match(host, /bp\.setTabTeardownHook\(\(wc\) => seatForceDetach\(wc\)\)/, 'a destroyed tab drops its seat before its contents close');
  const seat = read('./browser-cdp-seat.ts');
  assert.equal((seat.match(/\.attach\(/g) ?? []).length, 1, 'exactly one attach call in the whole of src/main');
  assert.match(seat, /if \(!wc\.debugger\.isAttached\(\)\) wc\.debugger\.attach\('1\.3'\);/);
  assert.match(seat, /if \(seat\.timer\) \{\s*clearTimeout\(seat\.timer\); \/\/ a holder came back/, 'a session coming back cancels the pending reset');
  assert.match(seat, /resetCommands\(wc\.getUserAgent\(\)\)[\s\S]{0,900}drop\(wc, seat\)/, 'the grace-delayed reset clears the agent overrides, then detaches');
});

test('the legacy mcp__browser__* tools are still built per session and still define their eight tools', () => {
  assert.match(read('./agent-sdk.ts'), /buildBrowserToolServer/);
  const tools = read('./agent-browser-tools.ts');
  for (const t of ['navigate', 'read_page', 'screenshot', 'click', 'type', 'form_input', 'evaluate', 'scroll']) {
    assert.match(tools, new RegExp(`tool\\(\\s*'${t}'`), `tool ${t}`);
  }
});
