// Profils navigateur (#400, spec story 26 / ADR 0010): "only the human attaches, switches or creates a profile". The
// behavioural half is browser-profiles-ipc.test.ts (the sender guard); THIS file pins, by source position, what the
// rig cannot load (Electron-bound index.ts / api-handlers.ts / preload) and that NO agent-facing surface can reach a
// profile operation: no CLI verb, no socket route, no agent tool, no mobile route. Each arm has a positive control
// (the same scan MUST find the operation in the human wiring) — a scan that could not match proves nothing.
// Mutants: scripts/mutate-browser-profiles.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Comments stripped, so prose that NAMES an operation (to say it is forbidden) cannot trip or hide a match. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

/** Identifiers / channel names / module names of the profile OPERATIONS (not of the read-only `browserProfileId` field). */
const OPS =
  /browserProfileAttach|browserProfileCreate|browserProfileRename|browserProfileDelete|browser:profileAttach|browserProfiles:|reprofilePanel|setBrowserProfileResolver|createBrowserProfilesService|initBrowserProfiles|registerBrowserProfilesIpc|browser-profiles(?:-host|-ipc)?(?:\.ts)?['"]/;
/** The same operations as a human would type them at a shell. */
const VERBS = /profile[s]?\s+(?:attach|create|switch|use|set|delete|rename)\b|attach[- ]profile|use[- ]profile/i;

const AGENT_SURFACES = [
  ...fs.readdirSync(path.join(SRC, 'cli')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => `cli/${f}`),
  'main/hooks-server.ts',
  'main/agent-browser-tools.ts',
  'main/agent-sdk.ts',
  'main/acces-mobile-routes.ts',
  'main/acces-mobile-host.ts',
  'main/cli-shim.ts',
];

test('NO agent-facing surface (CLI, socket routes, MCP browser tools, agent session, phone routes) names a profile operation', () => {
  for (const f of AGENT_SURFACES) {
    assert.doesNotMatch(code(f), OPS, `${f} reaches a profile operation`);
    assert.doesNotMatch(code(f), VERBS, `${f} offers a profile verb`);
  }
});

test('positive control: the same scan DOES match the human wiring (so the arm above can fail)', () => {
  assert.match(code('main/browser-profiles-host.ts'), OPS);
  assert.match(code('main/index.ts'), OPS);
  assert.match(code('preload/index.ts'), OPS);
  assert.match(code('renderer/components/BrowserPanel.tsx'), OPS);
  assert.match('orchestra browser profile attach x', VERBS);
});

test('the socket routes table has no profile route: every `/route` of hooks-server.ts is profile-free', () => {
  const routes = [...code('main/hooks-server.ts').matchAll(/['"`](\/[A-Za-z][A-Za-z0-9/_-]*)['"`]/g)].map((m) => m[1]);
  assert.ok(routes.length >= 10, `expected the real route list, saw ${routes.length}`);
  assert.deepEqual(routes.filter((r) => /profile/i.test(r)), []);
});

test('the profile channels are NOT in the generic api-handlers table (a write must not be reachable as a served method)', () => {
  const api = code('main/api-handlers.ts');
  const table = api.slice(api.indexOf('export const METHOD_IPC_CHANNELS'), api.indexOf('export const apiHandlers'));
  assert.ok(table.length > 500, 'found the channel table');
  assert.doesNotMatch(table, /rowserProfile/);
  assert.doesNotMatch(api.slice(api.indexOf('export const apiHandlers')), /rowserProfile(?!Id)/);
  // …and the omit list names all five, so the exhaustive table type does not demand them
  for (const m of ['browserProfiles', 'browserProfileCreate', 'browserProfileRename', 'browserProfileDelete', 'browserProfileAttach']) {
    assert.match(api, new RegExp(`\\|\\s*'${m}'`), `${m} omitted from the servable table`);
  }
});

test('preload ↔ registrar: each OrchestraAPI method invokes the channel the registrar handles', () => {
  const pre = code('preload/index.ts');
  const reg = code('main/browser-profiles-ipc.ts');
  const pairs: Array<[string, string]> = [
    ['browserProfiles', 'browserProfiles:list'],
    ['browserProfileCreate', 'browserProfiles:create'],
    ['browserProfileRename', 'browserProfiles:rename'],
    ['browserProfileDelete', 'browserProfiles:delete'],
    ['browserProfileAttach', 'browser:profileAttach'],
  ];
  for (const [method, channel] of pairs) {
    assert.match(pre, new RegExp(`${method}:[^\\n]*ipcRenderer\\.invoke\\('${channel}'`), `${method} → ${channel}`);
    assert.match(reg, new RegExp(`ipc\\.handle\\('${channel}'`), `registrar handles ${channel}`);
  }
});

test('index.ts installs the human wiring ONCE, at module scope, reading the main window lazily', () => {
  const idx = code('main/index.ts');
  assert.equal([...idx.matchAll(/initBrowserProfiles\(/g)].length, 1);
  assert.match(idx, /^initBrowserProfiles\(\(\) => mainWindow\?\.webContents\.id \?\? null\);$/m);
  assert.match(idx, /flushProfileStorage\(\);/, 'sign-ins are flushed at quit');
});

test('the panel resolves a workspace\'s identity through the host resolver and the partition helper, never a literal', () => {
  const panel = code('main/browser-panel.ts');
  assert.match(panel, /profileOf\?\.\(wsId\)/);
  assert.match(panel, /partition: partitionFor\(wsId, profileId\)/);
  assert.match(panel, /session\.fromPartition\(panel\.partition\)/);
  assert.match(panel, /partition: panel\.partition,/);
  assert.doesNotMatch(panel, /fromPartition\(['"`]/, 'no literal partition string');
});

test('the renderer asks via browserProfileAttach only from the panel chip bar; Settings never attaches', () => {
  assert.match(code('renderer/components/BrowserPanel.tsx'), /browserProfileAttach\(workspaceId, profileId\)/);
  assert.doesNotMatch(code('renderer/components/BrowserSettings.tsx'), /browserProfileAttach/);
});

test('the host moves open panels off a deleted profile, waits for the closed views, and clears the carriers\' key with `undefined` (the renderer merges a workspace:update)', () => {
  const host = code('main/browser-profiles-host.ts');
  assert.match(host, /openPanelsOn: workspacesOnProfile,/);
  assert.match(host, /settleViews: \(\) => settleClosedViews\(\d+\),/);
  assert.match(host, /const updated = \{ \.\.\.ws, browserProfileId: profileId \};/, 'an ABSENT key would keep the old id in the renderer\'s merged record');
  assert.doesNotMatch(host, /delete updated\.browserProfileId/);
  assert.match(host, /platform\.broadcast\('workspace:update', updated\)/);
});
