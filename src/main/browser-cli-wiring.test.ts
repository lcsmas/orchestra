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

test('the CLI verb is registered with help, sends the session key, refuses before the socket, and is NOT a bus-identity verb', () => {
  const cli = read('../cli/index.ts');
  assert.match(cli, /case 'browser': \{[\s\S]*planBrowserCommand\(args\)[\s\S]*if \(!plan\.ok\) fail\(plan\.error\)[\s\S]*request\(\s*'\/browser'/);
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

test('the proxy is the only NEW debugger attacher, and it shares the legacy attach instead of replacing it', () => {
  const host = read('./browser-cdp-host.ts');
  assert.equal((host.match(/\.debugger\.attach\(/g) ?? []).length, 2, 'acquire, and the grace-period reset (which re-attaches only to undo overrides, then detaches)');
  assert.match(host, /if \(!wc\.debugger\.isAttached\(\)\) wc\.debugger\.attach\('1\.3'\);/);
  assert.match(host, /const reset = pendingReset\.get\(tabId\);\s*if \(reset\) \{\s*clearTimeout\(reset\)/, 'a session coming back cancels the pending reset');
  assert.match(host, /release: \(tabId\) => \{[\s\S]{0,500}setTimeout\([\s\S]{0,700}resetCommands\([\s\S]{0,900}\.debugger\.detach\(\)[\s\S]{0,300}RELEASE_GRACE_MS\)/, 'the last session leaving schedules a grace-delayed reset that clears the agent overrides, then detaches');
});

test('the legacy mcp__browser__* tools are still built per session and still define their eight tools', () => {
  assert.match(read('./agent-sdk.ts'), /buildBrowserToolServer/);
  const tools = read('./agent-browser-tools.ts');
  for (const t of ['navigate', 'read_page', 'screenshot', 'click', 'type', 'form_input', 'evaluate', 'scroll']) {
    assert.match(tools, new RegExp(`tool\\(\\s*'${t}'`), `tool ${t}`);
  }
});
