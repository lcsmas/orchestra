// #470: the REAL installOrchestraHooks (workspaces.ts) writes the bundled verified-fanout v2 into a fresh worktree, REWRITES it on a later
// spawn when the hook bundle changed, and evicts/touches no other skill. Prints ONE JSON line `{ok, …}`; run through the Electron-stub loader:
//   node --experimental-strip-types --no-warnings --import ./scripts/.r2-register.mjs scripts/e2e-verified-fanout-skill-install.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(process.env.HOME ? path.join(process.env.HOME, '.cache', 'orchestra-test') : os.tmpdir(), 'vf-skill-install-'));
const home = path.join(base, 'home');
const wt = path.join(base, 'worktree');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(wt, { recursive: true });
process.env.ORCHESTRA_HOME = home;
process.env.HOME = home;
const out = { ok: false };
const done = (code) => { fs.rmSync(base, { recursive: true, force: true }); console.log(JSON.stringify(out)); process.exit(code); };

try {
  const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
  initPlatform({
    kind: 'headless-vf-skill', broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
    notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
    getUserDataDir: () => home, getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-vf-skill', getAppMetrics: () => [],
    isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
  });
  const { store } = await import(`${REPO}/src/main/store.ts`);
  const { installOrchestraHooks } = await import(`${REPO}/src/main/workspaces.ts`);
  const { VERIFIED_FANOUT_SKILL, VERIFIED_FANOUT_SKILL_NAME } = await import(`${REPO}/src/shared/verified-fanout-skill.ts`);
  await store.load?.();
  await store.upsertWorkspace({ id: 'ws-vf-skill', name: 'vf-skill', kind: 'scratch', repoPath: '', worktreePath: wt, status: 'idle', createdAt: Date.now(), hasInput: true });

  const skills = path.join(wt, '.claude', 'skills');
  const file = path.join(skills, VERIFIED_FANOUT_SKILL_NAME, 'SKILL.md');
  const stamp = path.join(wt, '.orchestra', '.hooks-version');
  out.nameIsVerifiedFanout = VERIFIED_FANOUT_SKILL_NAME === 'verified-fanout';
  out.absentBefore = !fs.existsSync(file);

  await installOrchestraHooks(wt);
  out.landed = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === VERIFIED_FANOUT_SKILL;
  out.siblingsKept = ['orchestra-spawn', 'orchestra-comms', 'orchestra-workspace-admin', 'orchestra-rename', 'orchestra-status', 'orchestra-browser'].every((n) => fs.existsSync(path.join(skills, n, 'SKILL.md')));

  // A later spawn after an UPGRADE: the stamp of the previous bundle + a stale skill body → the install rewrites the skill.
  fs.writeFileSync(file, 'STALE v1 body from before the upgrade\n');
  fs.writeFileSync(stamp, 'previous-bundle-version\n');
  await installOrchestraHooks(wt);
  out.rewrittenOnUpgrade = fs.readFileSync(file, 'utf8') === VERIFIED_FANOUT_SKILL;

  // Same bundle, nothing changed: the short-circuit leaves the (here deliberately edited) file alone — the rewrite is tied to the version stamp.
  fs.writeFileSync(file, 'EDITED-IN-PLACE\n');
  await installOrchestraHooks(wt);
  out.stampedInstallIsNoop = fs.readFileSync(file, 'utf8') === 'EDITED-IN-PLACE\n';

  out.ok = out.nameIsVerifiedFanout && out.absentBefore && out.landed && out.siblingsKept && out.rewrittenOnUpgrade && out.stampedInstallIsNoop;
  done(out.ok ? 0 : 1);
} catch (e) {
  out.error = String(e?.stack ?? e).slice(0, 600);
  done(1);
}
