// #400 — must-FAIL proof for the BUILT-APP rig (scripts/e2e-browser-profiles.sh): each mutant is applied IN PLACE to the real source, the app is
// REBUILT (a stale bundle reproduces perfectly), the rig runs only the arm(s) that own the clause, and the clause(s) named below must be RED
// while every ctl/* control stays GREEN (a red for the wrong reason is a failure). The source is restored byte-exact (cmp) right after the build;
// a final CLEAN rebuild leaves dist/ matching the tree. The mutant string is checked LIVE (exactly one occurrence).
// Run: node scripts/e2e-browser-profiles-mutants.mjs [id ...]      (exit 0 = every mutant killed for its named reason, tree restored)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = process.env.MUT_OUT || path.join(process.env.TMPDIR || os.tmpdir(), 'e2e-browser-profiles-mutants');
fs.mkdirSync(OUT, { recursive: true });
const PANEL = 'src/main/browser-panel.ts';
const SVC = 'src/main/browser-profiles.ts';
const HOST = 'src/main/browser-profiles-host.ts';
const PURE = 'src/shared/browser-profile.ts';
const CDPHOST = 'src/main/browser-cdp-host.ts';

const MUTANTS = [
  { id: 'P1-partition-ignored', file: PANEL, arms: 'attach', from: '      partition: panel.partition,', to: '      partition: partitionFor(panel.wsId, undefined),', red: ['profile-partition-holds-the-sign-in-on-disk', 'two-workspaces-share-one-profile-and-its-sign-in'] },
  { id: 'P2-human-guard-off', file: PURE, arms: 'human', from: "  return typeof c.senderId === 'number' && typeof c.mainId === 'number' && c.senderId === c.mainId && c.senderIsMainFrame;", to: '  return true;', red: ['foreign-webcontents-refused-on-every-write-channel', 'nothing-moved-after-every-agent-path-attempt'] },
  { id: 'P3-rebuild-leaks-old-views', file: PANEL, arms: 'attach', from: '  for (const t of oldTabs) {\n    try {\n      destroyTab(t);\n    } catch (e) {\n      log.warn(\'browser-panel: reprofilePanel could not close an old view\', e);\n    }\n  }\n  try {\n    if (wasAttached) attachActive(panel);\n  } catch (e) {', to: '  for (const t of [] as typeof oldTabs) void t;\n  try {\n    if (wasAttached) attachActive(panel);\n  } catch (e) {', red: ['no-view-leaked-by-the-rebuild'] },
  { id: 'P4-rebuild-never-recomposites', file: PANEL, arms: 'attach', from: '    if (wasAttached) attachActive(panel);\n  } catch (e) {\n    log.warn(\'browser-panel: reprofilePanel could not re-composite the panel\', e);', to: '    void wasAttached;\n  } catch (e) {\n    log.warn(\'browser-panel: reprofilePanel could not re-composite the panel\', e);', red: ['rebuilt-active-view-is-painted-on-screen'] },
  { id: 'P5-delete-keeps-storage', file: HOST, arms: 'delete', from: '      await ses.clearStorageData();\n      await ses.clearCache();\n      await ses.clearAuthCache();\n      ses.flushStorageData();', to: '      await ses.clearCache();\n      await ses.clearAuthCache();\n      ses.flushStorageData();', red: ['partition-storage-cleared-on-disk'] },
  { id: 'P6-delete-keeps-carriers-recorded', file: SVC, arms: 'delete', from: '          await deps.setWorkspaceProfile(wsId, undefined);', to: '', red: ['carriers-detached-in-the-store'] },
  { id: 'P7-no-cookie-flush-on-change', file: PANEL, arms: 'flush', from: '  if (panel.profileId !== undefined) persistSignIns(ses);', to: '', red: ['sign-in-made-9s-before-a-sigkill-survives'] },
  { id: 'P8-dangling-profile-honoured', file: PURE, arms: 'restore', from: 'return recorded !== undefined && profiles.some((p) => p.id === recorded) ? recorded : undefined;', to: 'return recorded;', red: ['dangling-profile-id-reads-as-ephemeral'] },
  { id: 'P9-attach-not-recorded', file: SVC, arms: 'attach', from: '        if (prev !== d.profileId) await deps.setWorkspaceProfile(wsId, d.profileId);', to: '', red: ['attach-records-the-profile-on-the-workspace'] },
  { id: 'P10-no-unencrypted-warning', file: 'src/renderer/components/BrowserSettings.tsx', arms: 'settings', from: '  const warning = PROFILE_AT_REST_WARNING;', to: "  const warning = 'x' as string;", red: ['unencrypted-storage-warning-shown-at-creation'] },
  { id: 'P11-cli-grows-a-profile-verb', file: 'src/cli/index.ts', arms: 'human', from: "    case 'peers': {\n      const { present: stats, rest } = takeBoolFlag(args, '--stats');", to: "    case 'profile': {\n      process.stdout.write('attached\\n');\n      return;\n    }\n    case 'peers': {\n      const { present: stats, rest } = takeBoolFlag(args, '--stats');", red: ['cli-has-no-profile-verb'] },
  { id: 'P12-socket-grows-a-profile-route', file: 'src/main/hooks-server.ts', arms: 'human', from: "          if (route === '/rename') {", to: "          if (route === '/browserProfileAttach') {\n            send(200, { ok: true, attached: true });\n          } else if (route === '/rename') {", red: ['socket-has-no-profile-route'] },
  { id: 'P13-detach-broadcasts-a-deleted-key', file: HOST, arms: 'attach', from: 'const updated = { ...ws, browserProfileId: profileId };\n      await store.upsertWorkspace(updated);', to: 'const updated: typeof ws = { ...ws };\n      if (profileId === undefined) delete updated.browserProfileId; else updated.browserProfileId = profileId;\n      await store.upsertWorkspace(updated);', red: ['settings-usage-count-follows-a-detach'] },
  { id: 'P14-session-cookies-not-promoted', file: PANEL, arms: 'session', from: '        return p ? ses.cookies.set(p) : undefined;', to: '        void p;\n        return undefined;', red: ['profile-session-cookie-gets-a-30-day-expiry', 'session-cookie-sign-in-survives-the-restart'] },
  { id: 'P15-proxy-never-asks-the-profile-policy', file: CDPHOST, arms: 'cdp', from: "      const d = decideAgentCdp({ method, params, profileId: bp.panelProfileId(wsId), pageUrl: tab.url, frameUrls: bp.tabFrameUrls(wsId, tab.id) });", to: "      const d = { ok: true } as ReturnType<typeof decideAgentCdp>; void method; void params; void tab;", red: ['cookies-clear-is-refused-for-a-profile-workspace', 'the-other-workspace-stays-signed-in-after-the-refused-clear', 'cookie-write-on-another-site-is-refused'] },
  { id: 'P16-proxy-forgets-the-target-tab-url', file: CDPHOST, arms: 'cdp', from: 'pageUrl: tab.url, frameUrls:', to: 'pageUrl: undefined, frameUrls:', red: ['cookie-write-on-the-pages-own-site-is-allowed'] },
  { id: 'P17-proxy-judges-an-ephemeral-workspace-as-a-profile-one', file: CDPHOST, arms: 'cdp', from: 'profileId: bp.panelProfileId(wsId), pageUrl:', to: "profileId: bp.panelProfileId(wsId) ?? 'bp-000000000000', pageUrl:", red: ['ephemeral-workspace-may-clear-its-own-jar'] },
  { id: 'P18-ephemeral-session-not-cleared-on-detach', file: HOST, arms: 'attach', from: '      const ses = session.fromPartition(ephemeralPartition(wsId));\n      await ses.clearStorageData();', to: '      const ses = session.fromPartition(ephemeralPartition(wsId));\n      void ses;', red: ['detach-returns-to-ephemeral-signed-out'] },
  { id: 'P19-proxy-ignores-the-frame-tree', file: CDPHOST, arms: 'cdp', from: 'frameUrls: bp.tabFrameUrls(wsId, tab.id) });', to: 'frameUrls: [tab.url] });', red: ['cookies-get-refused-when-the-page-embeds-another-site'] },
  { id: 'P20-getcookies-without-urls-judged-on-the-page-only', file: PURE, arms: 'cdp', from: 'return frameUrls ? frameUrls.filter(isHttp) : null;', to: 'return [];', red: ['cookies-get-refused-when-the-page-embeds-another-site'] },
  { id: 'P21-getcookies-refused-without-urls-always', file: PURE, arms: 'cdp', from: 'return frameUrls ? frameUrls.filter(isHttp) : null;', to: 'return null;', red: ['own-page-cookies-can-be-read-by-the-agent', 'cookies-get-allowed-again-on-a-page-without-foreign-frames'] },
];

const only = process.argv.slice(2).filter((a) => a !== '--check');
if (process.argv.includes('--check')) { // verify every mutant string is LIVE (exactly one occurrence) without building anything
  let bad = 0;
  for (const m of MUTANTS) { const n = fs.readFileSync(path.join(ROOT, m.file), 'utf8').split(m.from).length - 1; if (n !== 1) bad++; console.log(`${n === 1 ? 'live ' : 'DEAD '} ${m.id} (${n}x in ${m.file})`); }
  process.exit(bad ? 1 : 0);
}
const sh = (cmd, args, opt = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opt });
const backups = new Map();
for (const f of new Set(MUTANTS.map((m) => m.file))) {
  const b = path.join(OUT, `${f.replaceAll('/', '__')}.orig`);
  fs.copyFileSync(path.join(ROOT, f), b);
  backups.set(f, b);
}
const restoreAll = () => { for (const [f, b] of backups) fs.copyFileSync(b, path.join(ROOT, f)); };
let cleaned = false;
process.on('exit', () => { if (!cleaned) restoreAll(); });
process.on('SIGINT', () => process.exit(130));

const rows = []; let bad = 0;
for (const m of MUTANTS) {
  if (only.length && !only.includes(m.id)) continue;
  const abs = path.join(ROOT, m.file), backup = backups.get(m.file);
  const src = fs.readFileSync(abs, 'utf8');
  const n = src.split(m.from).length - 1;
  if (n !== 1) { rows.push(['STRING-NOT-LIVE', `${m.id} (${n} occurrences in ${m.file})`]); bad++; continue; }
  fs.writeFileSync(abs, src.replace(m.from, () => m.to));
  let built;
  try { built = sh('nice', ['-n', '10', 'pnpm', 'run', 'build:bundles']); } finally { fs.copyFileSync(backup, abs); }
  let restored = true; try { execFileSync('cmp', [abs, backup]); } catch { restored = false; }
  if (built.status !== 0) { rows.push(['BUILD-FAILED', `${m.id}: ${built.stderr.split('\n').slice(-5).join(' ')}`]); bad++; continue; }
  // fleet rule (ledger #405, 2026-10-26): at most 3 contained-rig Electron trees at once — ONE slot per rig run (this mutant), not per sweep
  const SLOT = process.env.GUI_SLOT || '/var/tmp/orch-1000-b17728/gui-slot.sh';
  const rigArgs = [path.join(ROOT, 'scripts/e2e-browser-profiles.sh'), ROOT, '--arms', m.arms, '--label', m.id, '--out', OUT];
  const rig = fs.existsSync(SLOT) ? sh(SLOT, rigArgs) : sh(rigArgs[0], rigArgs.slice(1));
  fs.writeFileSync(path.join(OUT, `${m.id}.log`), rig.stdout + rig.stderr);
  let res = null; try { res = JSON.parse(fs.readFileSync(path.join(OUT, `${m.id}-result.json`), 'utf8')); } catch {}
  if (!res) { rows.push(['RIG-NO-RESULT', `${m.id} rc=${rig.status} (see ${m.id}.log)`]); bad++; continue; }
  const redNames = res.results.filter((r) => !r.ok).map((r) => r.clause);
  const ctlRed = redNames.filter((c) => c.startsWith('ctl/') || c.startsWith('rig/'));
  const namedRed = m.red.every((c) => redNames.includes(c));
  const ok = restored && rig.status !== 0 && namedRed && ctlRed.length === 0;
  if (!ok) bad++;
  rows.push([ok ? 'KILLED' : !restored ? 'NOT-RESTORED' : rig.status === 0 ? 'SURVIVED' : ctlRed.length ? 'WRONG-REASON' : 'NOT-NAMED-CLAUSE', `${m.id}: red = ${redNames.join(', ') || 'none'}${ctlRed.length ? ` | CONTROLS RED: ${ctlRed.join(', ')}` : ''}${namedRed ? '' : ` | wanted ${m.red.join(', ')}`}`]);
  console.log(`${rows.at(-1)[0].padEnd(18)} ${rows.at(-1)[1]}`);
}

// leave a CLEAN build behind
cleaned = true;
restoreAll();
const clean = sh('nice', ['-n', '10', 'pnpm', 'run', 'build:bundles']);
rows.push([clean.status === 0 ? 'CLEAN-REBUILD-OK' : 'CLEAN-REBUILD-FAILED', 'dist/ matches the restored tree']);
if (clean.status !== 0) bad++;
console.log('\n== summary ==');
for (const [s, t] of rows) console.log(`${s.padEnd(18)} ${t}`);
console.log(`\n${rows.filter((r) => r[0] === 'KILLED').length}/${only.length || MUTANTS.length} killed; ${bad ? `${bad} PROBLEM(S)` : 'all clean'}`);
process.exit(bad ? 1 : 0);
