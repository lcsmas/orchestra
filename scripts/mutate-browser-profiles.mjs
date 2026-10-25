// Must-FAIL proof for the profils navigateur unit/stub tests (#400, ledger #405). Mutates the source IN PLACE, one
// clause at a time; each mutant MUST redden at least one of the #400 test files, and every touched file is restored
// from a byte-exact backup and `cmp`-checked after each mutant (and on any exit path).
// Run: node scripts/mutate-browser-profiles.mjs   (RC 0 = every mutant killed, restore byte-exact)

import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = [
  'src/shared/browser-profile.test.ts',
  'src/main/browser-profiles.test.ts',
  'src/main/browser-profiles-ipc.test.ts',
  'src/main/browser-panel-profiles.test.ts',
  'src/main/browser-profiles-wiring.test.ts',
  'src/shared/browser-cookie-promote.test.ts',
];
const PANEL = 'src/main/browser-panel.ts';
const SVC = 'src/main/browser-profiles.ts';
const IPC = 'src/main/browser-profiles-ipc.ts';
const PURE = 'src/shared/browser-profile.ts';
const PROMO = 'src/shared/browser-cookie-promote.ts';
const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'bprof-mut-'));
const backups = new Map();
const orig = new Map();
const load = (rel) => {
  if (!orig.has(rel)) {
    const b = path.join(tmp, rel.replaceAll('/', '__') + '.orig');
    copyFileSync(path.join(root, rel), b);
    backups.set(rel, b);
    orig.set(rel, readFileSync(path.join(root, rel), 'utf8'));
  }
  return orig.get(rel);
};

// [file, name, find (exactly once), replace]
const MUTANTS = [
  // --- browser-panel.ts: which partition, what a move does ---
  [PANEL, 'buildTab ignores the panel partition (always ephemeral)', '      partition: panel.partition,\n', '      partition: partitionFor(panel.wsId, undefined),\n'],
  [PANEL, 'ensurePanel ignores the profile resolver', 'const profileId = profileOf?.(wsId);', 'const profileId = undefined;'],
  [PANEL, 'ensurePanel does not record the profile on the panel', '    partition: partitionFor(wsId, profileId),\n    profileId,', '    partition: partitionFor(wsId, profileId),'],
  [PANEL, 'reprofilePanel leaves the old views alive', '  for (const t of oldTabs) {\n    trackClose(t);\n    destroyTab(t);\n  }\n  if (wasAttached) attachActive(panel);', '  if (wasAttached) attachActive(panel);'],
  [PANEL, 'reprofilePanel mints new tab ids', 'buildTab(panel, { openedBy: sn.openedBy, id: sn.id })', 'buildTab(panel, { openedBy: sn.openedBy })'],
  [PANEL, 'reprofilePanel does not reload the tabs\' URLs', '      if (sn.url) {\n        restoreUrls.set(tab, sn.url);', '      if (false as boolean) {\n        restoreUrls.set(tab, sn.url);'],
  [PANEL, 'reprofilePanel loses the active tab', 'panel.activeId = oldActive;', 'panel.activeId = panel.tabs[0].id;'],
  [PANEL, 'reprofilePanel never re-composites the active view', '  for (const t of oldTabs) {\n    trackClose(t);\n    destroyTab(t);\n  }\n  if (wasAttached) attachActive(panel);', '  for (const t of oldTabs) {\n    trackClose(t);\n    destroyTab(t);\n  }'],
  [PANEL, 'reprofilePanel does not detach the old attached view first', '  if (attachedTab) detachTab(panel, attachedTab);\n  panel.partition = partition;', '  panel.partition = partition;'],
  [PANEL, 'reprofilePanel rebuilds even for the same identity', '  if (partition === panel.partition) return panel.state;\n', ''],
  [PANEL, 'reprofilePanel builds a panel that is not open', '  if (!panel) return getState(wsId);\n  const partition', '  if (!panel) { ensurePanel(wsId); return getState(wsId); }\n  const partition'],
  [PANEL, 'reprofilePanel keeps the old profileId in the state', '  panel.partition = partition;\n  panel.profileId = profileId;', '  panel.partition = partition;'],
  [PANEL, 'the panel state never says which profile it runs on', '    ...(panel.profileId !== undefined ? { profileId: panel.profileId } : {}),\n', ''],
  [PANEL, 'sign-in flushing also watches ephemeral sessions', 'if (panel.profileId !== undefined) persistSignIns(ses);', 'persistSignIns(ses);'],
  [PANEL, 'sign-in flushing adds a watcher per tab', '  if (signInSessions.has(ses)) return;\n', ''],
  [PANEL, 'flushProfileStorage also flushes ephemeral partitions', '    if (panel.profileId === undefined) continue;\n', ''],
  [PANEL, 'a failed rebuild leaves a half-built panel', '    panel.tabs = oldTabs;\n    panel.partition = prev.partition;\n    panel.profileId = prev.profileId;\n    if (wasAttached) attachActive(panel);\n    throw e;', '    throw e;'],
  [PANEL, 'the closing views are not tracked', '    trackClose(t);\n    destroyTab(t);', '    destroyTab(t);'],
  [PANEL, 'settleClosedViews never waits', 'await Promise.race([Promise.all([...closing]).then(() => undefined), new Promise<void>((r) => setTimeout(r, timeoutMs))]);', 'void timeoutMs;'],
  [PANEL, 'settleClosedViews can wait forever', 'await Promise.race([Promise.all([...closing]).then(() => undefined), new Promise<void>((r) => setTimeout(r, timeoutMs))]);', 'await Promise.all([...closing]);'],
  [PANEL, 'workspacesOnProfile lists every open panel', '.filter((p) => p.profileId === profileId).map((p) => p.wsId)', '.map((p) => p.wsId)'],
  [SVC, 'delete does not wait for the closed views', '        await deps.settleViews();\n', ''],
  [SVC, 'delete ignores open panels the record does not know', '        for (const wsId of deps.openPanelsOn(profileId)) deps.reprofilePanel(wsId, undefined);\n', ''],
  ['src/main/browser-profiles-host.ts', 'the host never waits for the closed views', 'settleViews: () => settleClosedViews(3000),', 'settleViews: async () => {},'],
  ['src/main/browser-profiles-host.ts', 'a detach broadcasts a DELETED key (the renderer keeps the old id)', 'const updated = { ...ws, browserProfileId: profileId };\n      await store.upsertWorkspace(updated);', 'const updated: typeof ws = { ...ws };\n      if (profileId === undefined) delete updated.browserProfileId; else updated.browserProfileId = profileId;\n      await store.upsertWorkspace(updated);'],
  // --- session cookies are promoted in a profile (OPS ruling) ---
  [PROMO, 'a cookie that already has an expiry is promoted again (set → changed loop)', 'if (c.session !== true || c.expirationDate !== undefined) return null;', 'if (c.session !== true) return null;'],
  [PROMO, 'a persistent cookie is promoted too', 'if (c.session !== true || c.expirationDate !== undefined) return null;', 'if (c.expirationDate !== undefined) return null;'],
  [PROMO, 'a host-only cookie becomes a domain cookie', 'if (c.hostOnly === false && c.domain) out.domain = c.domain;', 'if (c.domain) out.domain = c.domain;'],
  [PROMO, 'a secure cookie is set on an http url', "url: `${secure ? 'https' : 'http'}://${host}${path}`,", 'url: `http://${host}${path}`,'],
  [PROMO, 'the promoted lifetime is not 30 days', 'export const PROMOTED_COOKIE_TTL_S = 30 * 24 * 3600;', 'export const PROMOTED_COOKIE_TTL_S = 24 * 3600;'],
  [PROMO, 'the url host keeps the cookie domain\'s leading dot', "const host = (c.domain ?? '').replace(/^\\./, '');", "const host = (c.domain ?? '');"],
  [PANEL, 'session cookies are never promoted', "      if (promoted) ses.cookies.set(promoted).catch((err) => log.debug('browser-panel: promoting a session cookie failed', err));\n", ''],
  [PANEL, 'a cookie REMOVAL (logout) is promoted back', '    if (!removed) {\n      const promoted', '    if (true as boolean) {\n      const promoted'],
  // --- browser-profiles.ts: the orchestration ---
  [SVC, 'delete never clears the partition storage', '          await deps.clearStorage(profileId);', '          void profileId;'],
  [SVC, 'delete forgets the profile even when the clear failed', '          return refuse(\'storage\',', '          void refuse(\'storage\','],
  [SVC, 'delete does not reload the carriers ephemeral', '          deps.reprofilePanel(wsId, undefined);', ''],
  [SVC, 'delete does not clear the carriers\' record', '          await deps.setWorkspaceProfile(wsId, undefined);', ''],
  [SVC, 'delete forgets the profile before the carriers move', 'const d = decideDelete({ profiles, workspaces: deps.workspaces(), profileId: id as BrowserProfileId });\n        if (!d.ok) return refuse(d.reason, d.message);', 'const d = decideDelete({ profiles, workspaces: deps.workspaces(), profileId: id as BrowserProfileId });\n        if (!d.ok) return refuse(d.reason, d.message);\n        await deps.setProfiles(profiles.filter((p) => p.id !== id));'],
  [SVC, 'attach does not record the profile on the workspace', '        if (prev !== d.profileId) await deps.setWorkspaceProfile(wsId, d.profileId);', ''],
  [SVC, 'attach leaves the record when the panel could not move', '          if (prev !== d.profileId) await deps.setWorkspaceProfile(wsId, prev).catch(() => {});', ''],
  [SVC, 'operations are not serialized', 'const run = chain.then(fn, fn);', 'const run = fn();'],
  [SVC, 'create may reuse a taken id', '        while (profiles.some((p) => p.id === id)) id = deps.mintId();\n', ''],
  [SVC, 'rename ignores the name check', 'const c = checkProfileName(name, profiles, cur.id);\n        if (!c.ok) return refuse(c.reason, c.message);', 'const c = { ok: true as const, name: String(name) };'],
  // --- browser-profiles-ipc.ts: who may ask ---
  [IPC, 'create is not sender-checked', "guard('browserProfiles:create', e) ?? run(", 'run('],
  [IPC, 'rename is not sender-checked', "guard('browserProfiles:rename', e) ?? run(", 'run('],
  [IPC, 'delete is not sender-checked', "guard('browserProfiles:delete', e) ?? run(", 'run('],
  [IPC, 'attach is not sender-checked', "guard('browser:profileAttach', e) ?? run(", 'run('],
  [IPC, 'the guard accepts a sub-frame / unknown frame', 'const fromMainFrame = e.senderFrame != null && e.senderFrame === e.sender?.mainFrame;', 'const fromMainFrame = true;'],
  [IPC, 'a refusal is not logged', "    log.warn(`browser-profiles: ${channel} refused — sender ${e.sender?.id ?? '?'} is not the app window`);\n", ''],
  [IPC, 'an unexpected failure rejects the invoke', "    try {\n      return await fn();\n    } catch (e) {\n      log.error(`browser-profiles: ${channel} failed`, e);\n      return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e), profiles: service.list() };\n    }", '    return await fn();'],
  // --- shared/browser-profile.ts: the rules ---
  [PURE, 'the caller check accepts unknown ids (undefined === undefined)', "typeof c.senderId === 'number' && typeof c.mainId === 'number' && ", ''],
  [PURE, 'the caller check ignores which window sent it', 'c.senderId === c.mainId && c.senderIsMainFrame', 'c.senderIsMainFrame'],
  [PURE, 'the caller check ignores sub-frames', 'c.senderId === c.mainId && c.senderIsMainFrame', 'c.senderId === c.mainId'],
  [PURE, 'a profile partition is not persist:', '`persist:orchestra-profile-${profileId}`', '`orchestra-profile-${profileId}`'],
  [PURE, 'partitionFor swaps the identities', 'profileId === undefined ? ephemeralPartition(wsId) : profilePartition(profileId)', 'profileId === undefined ? profilePartition(profileId as never) : ephemeralPartition(wsId)'],
  [PURE, 'the ephemeral partition is shared by all workspaces', '`orchestra-browser-${wsId}`', '`orchestra-browser`'],
  [PURE, 'a dangling profile id still counts as attached', 'return recorded !== undefined && profiles.some((p) => p.id === recorded) ? recorded : undefined;', 'return recorded;'],
  [PURE, 'delete detaches every workspace', '.filter((w) => w.browserProfileId === input.profileId)', ''],
  [PURE, 'a rename clashes with its own name', 'p.id !== selfId && p.name.toLowerCase() === key', 'p.name.toLowerCase() === key'],
  [PURE, 'name uniqueness is case-sensitive', 'p.name.toLowerCase() === key', 'p.name === name'],
  [PURE, 'attach always reports a change', 'changed: now !== input.target }', 'changed: true }'],
  [PURE, 'attach accepts a profile that does not exist', "if (!input.profiles.some((p) => p.id === input.target)) {", 'if (false as boolean) {'],
  [PURE, 'the create warning is always shown', 'return secretsNotice(state)\n    ?', 'return state\n    ?'],
  [PURE, 'a malformed id reaches a partition name', 'if (!isBrowserProfileId(id) || seen.has(id)) continue;', 'if (seen.has(id as string)) continue;'],
  [PURE, 'a repeated id is kept twice', 'if (!isBrowserProfileId(id) || seen.has(id)) continue;', 'if (!isBrowserProfileId(id)) continue;'],
  // --- wiring: an agent surface reaching a profile operation, the generic table serving a write, no module-scope init ---
  ['src/main/agent-browser-tools.ts', 'an MCP browser tool can re-profile a panel', "import * as bp from './browser-panel';", "import * as bp from './browser-panel';\nvoid bp.reprofilePanel;"],
  ['src/main/hooks-server.ts', 'a socket route can attach a profile', "const maxBytes = route === '/spawn' || route === '/message' ? 1_048_576 : 4096;", "const maxBytes = route === '/spawn' || route === '/message' || route === '/profileAttach' ? 1_048_576 : 4096;"],
  ['src/main/api-handlers.ts', 'the generic table serves a profile write', "  browserTabClose: 'browser:tabClose',", "  browserTabClose: 'browser:tabClose',\n  browserProfileAttach: 'browser:profileAttach',"],
  ['src/main/index.ts', 'the human wiring is never installed', 'initBrowserProfiles(() => mainWindow?.webContents.id ?? null);', ''],
  ['src/renderer/components/BrowserSettings.tsx', 'Settings can attach a profile', "setError(r.ok ? null : r.message);\n    return r.ok;", "setError(r.ok ? null : r.message);\n    void window.orchestra.browserProfileAttach('x', null);\n    return r.ok;"],
];

const run = () => spawnSync('node', ['--test', '--experimental-strip-types', ...TESTS], { cwd: root, encoding: 'utf8' });
function restoreAll() {
  for (const [rel, b] of backups) copyFileSync(b, path.join(root, rel));
  for (const [rel, b] of backups) {
    if (!readFileSync(path.join(root, rel)).equals(readFileSync(b))) throw new Error(`RESTORE FAILED: ${rel}`);
  }
}
process.on('exit', () => { for (const [rel, b] of backups) { try { copyFileSync(b, path.join(root, rel)); } catch {} } });

for (const m of MUTANTS) load(m[0]);
if (process.argv.includes('--check')) { // every mutant string LIVE (exactly one occurrence), nothing run
  let bad = 0;
  for (const [file, name, find] of MUTANTS) { const n = orig.get(file).split(find).length - 1; if (n !== 1) bad++; if (n !== 1) console.log(`DEAD ${name} (${n}x in ${file})`); }
  console.log(`${MUTANTS.length - bad}/${MUTANTS.length} live`);
  process.exit(bad ? 1 : 0);
}
const base = run();
if (base.status !== 0) { console.log('BASELINE FAILS — abort\n' + base.stdout.slice(-3000)); process.exit(2); }
const baseTests = /# tests (\d+)/.exec(base.stdout)?.[1];
console.log(`baseline PASS (${baseTests} tests, ${/# skipped (\d+)/.exec(base.stdout)?.[1]} skipped)`);

let killed = 0;
const survivors = [];
for (const [file, name, find, replace] of MUTANTS) {
  const src = orig.get(file);
  const n = src.split(find).length - 1;
  if (n !== 1) { console.log(`ABORT: mutant "${name}" find-string occurs ${n}x in ${file} (need exactly 1)`); restoreAll(); process.exit(2); }
  const next = src.replace(find, replace);
  if (next === src) { console.log(`ABORT: mutant "${name}" did not change ${file}`); restoreAll(); process.exit(2); }
  writeFileSync(path.join(root, file), next);
  const r = run();
  restoreAll();
  const failing = (r.stdout.match(/^not ok .*/gm) || []).length;
  const dead = r.status !== 0;
  if (dead) killed++; else survivors.push(name);
  console.log(`${dead ? 'KILLED  ' : 'SURVIVED'} [${path.basename(file)}] ${name}${dead ? `  (${failing} arm(s) red)` : ''}`);
}
const same = [...backups].every(([rel, b]) => readFileSync(path.join(root, rel)).equals(readFileSync(b)));
console.log(`\n${killed}/${MUTANTS.length} killed; restore byte-exact: ${same}`);
if (survivors.length) console.log('SURVIVORS:\n  ' + survivors.join('\n  '));
process.exit(survivors.length || !same ? 1 : 0);
