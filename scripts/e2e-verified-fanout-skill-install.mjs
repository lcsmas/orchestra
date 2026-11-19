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
  const { VERIFIED_FANOUT_SKILL, VERIFIED_FANOUT_SKILL_NAME, VERIFIED_FANOUT_MARKER } = await import(`${REPO}/src/shared/verified-fanout-skill.ts`);
  const { VERIFIED_FANOUT_FILES } = await import(`${REPO}/src/shared/verified-fanout-files.ts`);
  await store.load?.();
  await store.upsertWorkspace({ id: 'ws-vf-skill', name: 'vf-skill', kind: 'scratch', repoPath: '', worktreePath: wt, status: 'idle', createdAt: Date.now(), hasInput: true });

  const skills = path.join(wt, '.claude', 'skills');
  const file = path.join(skills, VERIFIED_FANOUT_SKILL_NAME, 'SKILL.md');
  const stamp = path.join(wt, '.orchestra', '.hooks-version');
  out.nameIsVerifiedFanout = VERIFIED_FANOUT_SKILL_NAME === 'verified-fanout';
  out.absentBefore = !fs.existsSync(file);

  await installOrchestraHooks(wt);
  out.landed = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === VERIFIED_FANOUT_SKILL;
  const dir = path.join(skills, VERIFIED_FANOUT_SKILL_NAME);
  out.filesLanded = VERIFIED_FANOUT_FILES.length === 5 && VERIFIED_FANOUT_FILES.every((f) => fs.readFileSync(path.join(dir, f.path), 'utf8') === f.content);
  out.ledgerSetExecutable = (fs.statSync(path.join(dir, 'scripts', 'ledger-set')).mode & 0o111) !== 0;
  out.siblingsKept = ['orchestra-spawn', 'orchestra-comms', 'orchestra-workspace-admin', 'orchestra-rename', 'orchestra-status', 'orchestra-browser'].every((n) => fs.existsSync(path.join(skills, n, 'SKILL.md')));

  // A later spawn after an UPGRADE: the stamp of the previous bundle + a stale skill body → the install rewrites the skill.
  fs.writeFileSync(file, `<!-- ${VERIFIED_FANOUT_MARKER} -->\nSTALE body from before the upgrade\n`); // a previous generated copy (carries the marker)
  fs.writeFileSync(stamp, 'previous-bundle-version\n');
  await installOrchestraHooks(wt);
  out.rewrittenOnUpgrade = fs.readFileSync(file, 'utf8') === VERIFIED_FANOUT_SKILL;

  // Same bundle, nothing changed: the short-circuit leaves the (here deliberately edited) file alone — the rewrite is tied to the version stamp.
  fs.writeFileSync(file, 'EDITED-IN-PLACE\n');
  await installOrchestraHooks(wt);
  out.stampedInstallIsNoop = fs.readFileSync(file, 'utf8') === 'EDITED-IN-PLACE\n';

  // A repo's OWN tracked project-level verified-fanout (no generated marker) is not overwritten, and no bundled file is added beside it.
  const wt2 = path.join(base, 'worktree-own-skill');
  const own = path.join(wt2, '.claude', 'skills', 'verified-fanout');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), '---\nname: verified-fanout\ndescription: the repo\'s own\n---\nOWN\n');
  fs.writeFileSync(path.join(own, 'extra.md'), 'EXTRA\n');
  await store.upsertWorkspace({ id: 'ws-vf-skill-2', name: 'vf-skill-2', kind: 'scratch', repoPath: '', worktreePath: wt2, status: 'idle', createdAt: Date.now(), hasInput: true });
  await installOrchestraHooks(wt2);
  out.ownSkillKept = fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8').endsWith('OWN\n') && fs.readFileSync(path.join(own, 'extra.md'), 'utf8') === 'EXTRA\n' && !fs.existsSync(path.join(own, 'references'));

  // An fs error at the skill path must NEVER abort the hook install (settings.local.json + the stamp come after the skill): dangling symlink,
  // SKILL.md that is a directory, a file where the skill dir should be.
  const shapes = {
    dangling_symlink: (d) => { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.symlinkSync(path.join(base, 'absent-personal-dir'), d); },
    skill_md_is_dir: (d) => { fs.mkdirSync(path.join(d, 'SKILL.md'), { recursive: true }); },
    file_at_skill_dir: (d) => { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, 'not a dir\n'); },
  };
  out.errorShapes = {};
  for (const [name, make] of Object.entries(shapes)) {
    const w = path.join(base, `worktree-${name}`);
    make(path.join(w, '.claude', 'skills', 'verified-fanout'));
    await store.upsertWorkspace({ id: `ws-vf-${name}`, name: `vf-${name}`, kind: 'scratch', repoPath: '', worktreePath: w, status: 'idle', createdAt: Date.now(), hasInput: true });
    await installOrchestraHooks(w);
    out.errorShapes[name] = fs.existsSync(path.join(w, '.claude', 'settings.local.json')) && fs.existsSync(path.join(w, '.orchestra', '.hooks-version')) && fs.existsSync(path.join(w, '.claude', 'skills', 'orchestra-spawn', 'SKILL.md'));
  }
  out.errorShapesKeepHooks = Object.values(out.errorShapes).every(Boolean);

  out.ok = out.errorShapesKeepHooks && out.filesLanded && out.ledgerSetExecutable && out.ownSkillKept && out.nameIsVerifiedFanout && out.absentBefore && out.landed && out.siblingsKept && out.rewrittenOnUpgrade && out.stampedInstallIsNoop;
  done(out.ok ? 0 : 1);
} catch (e) {
  out.error = String(e?.stack ?? e).slice(0, 600);
  done(1);
}
