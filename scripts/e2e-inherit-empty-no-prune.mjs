// #235 residual (C10) — an EMPTY/absent `inherit` must not full-prune a config dir that still holds
// inherited links, unless the Accounts UI setter just de-selected it.
// Drives the REAL api-handlers `setAccounts` (the UI setter), REAL store, REAL account-inherit, REAL
// logger (arms read `<ORCHESTRA_HOME>/logs/orchestra.log`). SCRATCH HOME + config dir only.
//
// Arms (ok:true = the shipped behaviour; on unfixed master the ★ arms print ok:false):
//   refuse_live        ★ the rig's own scratch guard REFUSES ~/.claude-*, $CLAUDE_CONFIG_DIR, a symlink into ~/.claude, outside paths
//   boot_empty_obj     ★ boot order (seed + syncAll, caller=boot), account `inherit:{}` over a live-shaped dir → dir untouched + ONE warn
//   ui_unrelated_save  ★ REAL apiHandlers.setAccounts, account already empty (no de-selection) → dir untouched + warn caller=ui-save
//   boot_vanished_only ★ boot order, account `inherit:{skills:['gone']}` (NON-empty but names only a missing source) → dir untouched + ONE warn (review F1: guard keys on effect)
//   ui_configdir_swap  ★ REAL setAccounts: configDir repointed at another held dir AND boxes cleared in one save → that dir untouched (review F2)
//   ui_deselect          must-PASS: REAL setAccounts takes a FULL selection to empty → links/MCP pruned, own MCP + trust kept
//   ui_normal_save       must-PASS: REAL setAccounts, selection unchanged → nothing pruned, no held-block warn
//   boot_absent_seeded   control: `inherit` ABSENT is re-seeded by boot's seed (pre-existing) → dir keeps its links
//   torn_json_boot     ★ (#238/C11) boot order, FULL selection, the login `.claude.json` torn (60% of it; the tear's producer is unexplained — claude 2.1.284 writes tmp+rename under a lock) → file byte-identical + ONE warn, links intact; whole again → next sync merges, trust kept
//   torn_json_ui_save  ★ (#238/C11) same through the REAL apiHandlers.setAccounts (a normal, unchanged-selection save)
//   alias_skills_ui_save ★ (#241/C14) login `skills/` symlinked to the source's dotfile-linked `skills/`; REAL setAccounts (unchanged FULL save) → the SOURCE's skill links intact, alias intact, ONE warn, the other 5 links kept
//   self_loop_ui_save  ★ (#239/C12) REAL setAccounts saves an account whose configDir IS the source `~/.claude` next to a normal one → source byte-identical (no .orchestra-bak, no self-loop, no manifest), ONE warn, the normal account fully synced
//   same_file_mcp_ui_save ★ (#239/F1) a login whose .claude.json is a SYMLINK to the GLOBAL ~/.claude.json: REAL setAccounts de-selects MCP servers → the global file byte-identical, ONE warn, manifest keeps its servers
//
// Run one arm:  node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-inherit-empty-no-prune.mjs <arm>
// Run all:      node scripts/e2e-inherit-empty-no-prune.mjs all      (children + a live-dir listing canary before/after)

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Imported (hoisted) BEFORE the HOME override below: the live dirs are captured at its load.
import { REAL_HOMES, REAL_CFG, checkScratch, liveCanary, canaryDiff } from './.scratch-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'all';
const ARMS = ['refuse_live', 'boot_empty_obj', 'boot_vanished_only', 'ui_unrelated_save', 'ui_configdir_swap', 'ui_deselect', 'ui_normal_save', 'boot_absent_seeded', 'torn_json_boot', 'torn_json_ui_save', 'alias_skills_ui_save', 'self_loop_ui_save', 'same_file_mcp_ui_save'];

const BASE = process.env.E2E_HOME ?? path.join(REAL_HOMES[0], '.cache', 'e2e-inherit-empty');

// ---- runner: one child per arm, plus an independent live-dir listing canary ----------------------
if (ARM === 'all') {
  const canary = liveCanary;
  const pre = canary();
  const rows = [];
  for (const arm of ARMS) {
    let line = '';
    try {
      line = execFileSync(process.execPath, ['--experimental-strip-types', '--import', './scripts/.r2-register.mjs', fileURLToPath(import.meta.url), arm],
        { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.homedir(), ...(REAL_CFG ? { CLAUDE_CONFIG_DIR: REAL_CFG } : {}), ...(process.env.E2E_HOME ? { E2E_HOME: process.env.E2E_HOME } : {}) }, timeout: 120_000 });
    } catch (e) { line = String(e.stdout ?? ''); }
    const j = [...line.split('\n')].reverse().find((l) => l.startsWith('{'));
    const r = j ? JSON.parse(j) : { arm, ok: false, error: 'no result line', raw: line.slice(-300) };
    rows.push(r);
    console.log(`${r.ok ? 'ok    ' : 'NOT OK'} ${arm}  ${j ?? r.raw}`);
  }
  const post = canary();
  const diff = canaryDiff(pre, post);
  const unchanged = diff.strict.length === 0;
  console.log(`live-dir canary (find depth<=2; STRICT = symlink set + inherit manifest + MCP key list; ${Object.keys(pre).length} dirs): strict ${unchanged ? 'UNCHANGED' : 'CHANGED ' + JSON.stringify(diff.strict)}; churn ${JSON.stringify(diff.churn)}`);
  const bad = rows.filter((r) => !r.ok).map((r) => r.arm);
  console.log(`SUMMARY arms=${rows.length} ok=${rows.length - bad.length} notok=${bad.length}${bad.length ? ' [' + bad.join(',') + ']' : ''} canary=${unchanged ? 'UNCHANGED' : 'CHANGED'}`);
  process.exit(bad.length === 0 && unchanged ? 0 : 1);
}
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

// ---- one arm --------------------------------------------------------------------------------------
const out = { arm: ARM };
const root = path.join(BASE, ARM);
{
  // Refuse to delete/create anything unless the arm root is a scratch path under BASE.
  const g = checkScratch(root, BASE);
  if (!g.ok || path.basename(BASE) !== 'e2e-inherit-empty' && !process.env.E2E_HOME) { console.log(JSON.stringify({ arm: ARM, ok: false, error: `SAFETY: ${g.clause} ${g.detail}` })); process.exit(3); }
}
if (ARM === 'refuse_live') {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const home0 = REAL_HOMES[0];
  const cases = [
    ['live ~/.claude-mc', path.join(home0, '.claude-mc'), 'live-claude-dir'],
    ['live ~/.claude', path.join(home0, '.claude'), 'live-claude-dir'],
    ['live ~/.claude/skills/x', path.join(home0, '.claude', 'skills', 'x'), 'live-claude-dir'],
    ...(REAL_CFG ? [['$CLAUDE_CONFIG_DIR', REAL_CFG, 'live-claude-dir']] : []),
    ['outside the scratch base', path.join(os.tmpdir(), 'not-scratch'), 'outside-scratch'],
    ['scratch look-alike', path.join(root, 'home', '.claude-mc'), 'scratch'],
  ];
  if (fs.existsSync(path.join(home0, '.claude'))) {
    const link = path.join(root, 'lookalike');
    fs.symlinkSync(path.join(home0, '.claude'), link); // a scratch-named path that RESOLVES into the live dir
    cases.push(['symlink in scratch → live ~/.claude', link, 'live-claude-dir']);
  }
  const verdicts = cases.map(([name, p, want]) => { const v = checkScratch(p, BASE); return { name, want, got: v.clause, ok: v.clause === want }; });
  out.verdicts = verdicts;
  out.ok = verdicts.every((v) => v.ok) && verdicts.length >= 5;
  console.log(JSON.stringify(out));
  process.exit(0);
}

fs.rmSync(root, { recursive: true, force: true });
const home = path.join(root, 'home');
const login = path.join(home, '.claude-mc'); // the live-shaped dir (the `~/.claude-mc` stand-in)
const ohome = path.join(home, '.orchestra');
const userData = path.join(root, 'userData');
for (const p of [root, home, login, ohome, userData]) {
  const g = checkScratch(p, BASE);
  if (!g.ok) { console.log(JSON.stringify({ arm: ARM, ok: false, error: `SAFETY: ${g.clause} ${g.detail}` })); process.exit(3); }
}
fs.mkdirSync(ohome, { recursive: true });
fs.mkdirSync(login, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = ohome;
process.env.CLAUDE_CONFIG_DIR = login; // scratch — never the invoker's
delete process.env.ORCHESTRA_HIBERNATE_AFTER_MS;

const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
// The global source: ~/.claude/* and ~/.claude.json (the MCP source), inside the SCRATCH home.
put(path.join(home, '.claude', 'settings.json'), '{"model":"opus"}\n');
put(path.join(home, '.claude', 'CLAUDE.md'), '@RTK.md\n@LESSONS.md\n\n# global\n');
put(path.join(home, '.claude', 'RTK.md'), '# rtk\n');
put(path.join(home, '.claude', 'LESSONS.md'), '# lessons\n');
put(path.join(home, '.claude', 'statusline-command.sh'), '#!/bin/sh\necho hi\n');
put(path.join(home, '.claude', 'skills', 'frontend-design', 'SKILL.md'), '# fd\n');
put(path.join(home, '.claude', 'skills', 'handoff', 'SKILL.md'), '# handoff\n');
put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh' }, 'linear-server': { url: 'u' }, 'chrome-devtools': { command: 'cd' } } }));

const FULL = { settings: true, statusline: true, skills: ['frontend-design', 'handoff'], mcpServers: ['github', 'linear-server', 'chrome-devtools'] };
const LINKS = ['CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json', 'skills/frontend-design', 'skills/handoff', 'statusline-command.sh'];
const ACCOUNT = { id: 'rig-c10', label: 'mc', configDir: login };
// Store seeded RAW before load: sanitizeAccountInherit would turn `{}` into absent, and `{}` is the shape
// that survives boot's seed (`inherit === undefined` is the seed's only trigger).
const seedInherit = ARM === 'ui_deselect' || ARM === 'ui_normal_save' || ARM === 'ui_configdir_swap' || ARM === 'torn_json_boot' || ARM === 'torn_json_ui_save' || ARM === 'alias_skills_ui_save' ? FULL : ARM === 'boot_absent_seeded' ? undefined : ARM === 'boot_vanished_only' ? { skills: ['gone'] } : {};
fs.mkdirSync(path.join(userData, 'orchestra'), { recursive: true });
fs.writeFileSync(path.join(userData, 'orchestra', 'store.json'), JSON.stringify({
  repos: [], workspaces: [], selfTuneRuns: [],
  accounts: [{ ...ACCOUNT, ...(seedInherit === undefined ? {} : { inherit: seedInherit }) }],
}, null, 2));

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-inherit-empty', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {}, openExternal: () => {}, showItemInFolder: () => {},
  openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => userData, getLogsDir: () => path.join(userData, 'logs'),
  getAppVersion: () => '0.0.0-e2e-inherit-empty', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { initLogger } = await import(`${REPO}/src/main/logger.ts`);
initLogger(); // the REAL logger writes nothing until initialised; arms read <ORCHESTRA_HOME>/logs/orchestra.log
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load();
const inh = await import(`${REPO}/src/main/account-inherit.ts`);
const { apiHandlers } = await import(`${REPO}/src/main/api-handlers.ts`);

// Build the live-shaped dir with the REAL sync (FULL selection), then user-owned state the sync must keep.
await inh.syncAccountInheritance({ ...ACCOUNT, inherit: FULL });
{
  const cj = path.join(login, '.claude.json');
  const d = JSON.parse(fs.readFileSync(cj, 'utf8'));
  d.projects = { '/scratch/proj': { hasTrustDialogAccepted: true } };
  d.mcpServers['my-own'] = { command: 'mine' };
  fs.writeFileSync(cj, JSON.stringify(d, null, 2));
}

const snapshot = (dir = login) => {
  const o = {};
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name); const r = rel ? `${rel}/${ent.name}` : ent.name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) o[r] = `L:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { o[r] = 'D'; walk(p, r); }
      else o[r] = `F:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir, '');
  return o;
};
const linksOf = (s) => Object.keys(s).filter((k) => s[k].startsWith('L:')).sort();
const mcpOf = (dir = login) => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers ?? {}).sort();
const manifest = () => JSON.parse(fs.readFileSync(path.join(login, '.orchestra-inherited.json'), 'utf8'));
const logLines = () => {
  try { return fs.readFileSync(path.join(ohome, 'logs', 'orchestra.log'), 'utf8').split('\n').filter((l) => l.includes('account-inherit')); } catch { return []; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Bounded wait-until (never sleep-then-read): resolves true when `pred` holds, false at the timeout. */
async function until(pred, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(25); } return false; }

const before = snapshot();
// POSITIVE CONTROL: the mirror really holds what the incident wiped (a rig that started empty proves nothing).
const control = JSON.stringify(linksOf(before)) === JSON.stringify(LINKS) && mcpOf().join() === 'chrome-devtools,github,linear-server,my-own';
Object.assign(out, { control, storeInherit: store.accounts[0]?.inherit ?? null, loginIsScratch: checkScratch(login, BASE).ok });
const heldWarn = (caller, dir = login) => logLines().filter((l) => l.includes('would leave no inherited item') && l.includes(`caller=${caller} `) && l.includes(dir));
const stripped = () => linksOf(snapshot()).length < LINKS.length || manifest().symlinks.length === 0;

let ok = false;
if (ARM === 'boot_empty_obj') {
  // index.ts createMainWindow, in order: seed defaults, then `void syncAllAccountsInheritance({caller:'boot'})`.
  await inh.seedAccountInheritDefaults();
  out.seedKeptEmpty = JSON.stringify(store.accounts[0]?.inherit) === '{}';
  await inh.syncAllAccountsInheritance({ caller: 'boot' });
  await sleep(200);
  const after = snapshot();
  Object.assign(out, { links: linksOf(after).length, mcp: mcpOf(), manifestLinks: manifest().symlinks.length, byteIdentical: JSON.stringify(after) === JSON.stringify(before), heldWarns: heldWarn('boot').length });
  ok = control && out.seedKeptEmpty && out.byteIdentical && out.heldWarns === 1;
} else if (ARM === 'boot_vanished_only') {
  await inh.seedAccountInheritDefaults();
  out.seedKeptSelection = JSON.stringify(store.accounts[0]?.inherit) === JSON.stringify({ skills: ['gone'] });
  await inh.syncAllAccountsInheritance({ caller: 'boot' });
  await sleep(200);
  const after = snapshot();
  Object.assign(out, { links: linksOf(after).length, mcp: mcpOf(), byteIdentical: JSON.stringify(after) === JSON.stringify(before), heldWarns: heldWarn('boot').length });
  ok = control && out.seedKeptSelection && out.byteIdentical && out.heldWarns === 1;
} else if (ARM === 'boot_absent_seeded') {
  await inh.seedAccountInheritDefaults();
  const seeded = store.accounts[0]?.inherit ?? null;
  await inh.syncAllAccountsInheritance({ caller: 'boot' });
  await sleep(200);
  const after = snapshot();
  Object.assign(out, { seeded, links: linksOf(after).length, mcp: mcpOf(), heldWarns: heldWarn('boot').length });
  ok = control && seeded !== null && seeded.settings === true && linksOf(after).join() === LINKS.join() && out.heldWarns === 0;
} else if (ARM === 'ui_unrelated_save') {
  // Account already empty (`{}`); the user saves an UNRELATED edit (label) — no de-selection happened.
  await apiHandlers.setAccounts([{ id: ACCOUNT.id, label: 'mc-renamed', configDir: login }]);
  const settled = await until(() => heldWarn('ui-save').length > 0 || stripped());
  await sleep(300);
  const after = snapshot();
  Object.assign(out, { settled, labelPersisted: store.accounts[0]?.label === 'mc-renamed', links: linksOf(after).length, mcp: mcpOf(), manifestLinks: manifest().symlinks.length, byteIdentical: JSON.stringify(after) === JSON.stringify(before), heldWarns: heldWarn('ui-save').length });
  ok = control && settled && out.labelPersisted && out.byteIdentical && out.heldWarns === 1;
} else if (ARM === 'ui_configdir_swap') {
  // A second dir, held (built by the REAL sync). The user repoints the account at it AND clears the boxes in ONE save.
  const loginB = path.join(home, '.claude-b');
  { const g = checkScratch(loginB, BASE); if (!g.ok) { console.log(JSON.stringify({ arm: ARM, ok: false, error: `SAFETY: ${g.clause}` })); process.exit(3); } }
  await inh.syncAccountInheritance({ id: 'rig-b', label: 'b', configDir: loginB, inherit: FULL });
  const beforeB = snapshot(loginB);
  out.controlB = JSON.stringify(linksOf(beforeB)) === JSON.stringify(LINKS) && mcpOf(loginB).join() === 'chrome-devtools,github,linear-server';
  await apiHandlers.setAccounts([{ id: ACCOUNT.id, label: 'mc', configDir: loginB }]);
  const settled = await until(() => heldWarn('ui-save', loginB).length > 0 || linksOf(snapshot(loginB)).length < LINKS.length);
  await sleep(300);
  Object.assign(out, {
    settled, bByteIdentical: JSON.stringify(snapshot(loginB)) === JSON.stringify(beforeB), aByteIdentical: JSON.stringify(snapshot()) === JSON.stringify(before),
    bLinks: linksOf(snapshot(loginB)).length, warnsForB: heldWarn('ui-save', loginB).length, storeConfigDir: store.accounts[0]?.configDir === loginB,
  });
  ok = control && out.controlB && settled && out.storeConfigDir && out.bByteIdentical && out.aByteIdentical && out.warnsForB === 1;
} else if (ARM === 'ui_deselect') {
  // The user unchecks EVERYTHING and saves: the renderer sends the account with no `inherit`.
  Object.assign(out, { preLinks: linksOf(before).length, preStoreNonEmpty: !!store.accounts[0]?.inherit });
  await apiHandlers.setAccounts([{ id: ACCOUNT.id, label: 'mc', configDir: login }]);
  const settled = await until(() => linksOf(snapshot()).length === 0);
  await sleep(300);
  const after = snapshot();
  const cj = JSON.parse(fs.readFileSync(path.join(login, '.claude.json'), 'utf8'));
  Object.assign(out, {
    settled, links: linksOf(after).length, mcp: mcpOf(), manifest: manifest(), storeAfter: store.accounts[0]?.inherit ?? null,
    trustKept: JSON.stringify(cj.projects) === JSON.stringify({ '/scratch/proj': { hasTrustDialogAccepted: true } }),
    intentLogged: logLines().some((l) => l.includes('UI de-selection pruned 7 link(s) + 3 MCP')),
  });
  ok = control && out.preStoreNonEmpty && settled && out.links === 0 && out.mcp.join() === 'my-own'
    && out.manifest.symlinks.length === 0 && out.manifest.mcpServers.length === 0 && out.trustKept && out.storeAfter === null;
} else if (ARM === 'torn_json_boot' || ARM === 'torn_json_ui_save') {
  // #238/C11: the login `.claude.json` is found torn by the sync (fixture: a 60% truncation; the real producer is UNEXPLAINED). Selection stays FULL,
  // so the C10 guard does NOT block — only the torn-read handling stands between the file and a `{mcpServers}` rewrite.
  const cj = path.join(login, '.claude.json');
  const whole = fs.readFileSync(cj, 'utf8');
  const tornText = whole.slice(0, Math.floor(whole.length * 0.6));
  const tornBytes = Buffer.from(tornText);
  out.tornControl = (() => { try { JSON.parse(tornText); return false; } catch { return true; } })() && JSON.parse(whole).projects !== undefined; // really torn; the whole file really holds trust
  fs.writeFileSync(cj, tornBytes);
  const tornWarns = () => logLines().filter((l) => l.includes('is empty or unparseable') && l.includes(cj));
  if (ARM === 'torn_json_boot') {
    await inh.seedAccountInheritDefaults();
    await inh.syncAllAccountsInheritance({ caller: 'boot' });
    await sleep(200);
  } else {
    await apiHandlers.setAccounts([{ ...ACCOUNT, label: 'mc-renamed', inherit: FULL }]); // unchanged selection: a normal save
    out.settled = await until(() => tornWarns().length > 0);
    await sleep(300);
  }
  const afterBytes = fs.readFileSync(cj);
  const tornAfter = snapshot();
  Object.assign(out, {
    byteIdentical: afterBytes.equals(tornBytes), warns: tornWarns().length, links: linksOf(tornAfter).length,
    manifestMcp: manifest().mcpServers, strayTmp: fs.readdirSync(login).filter((n) => n.includes('.orchestra-tmp-')),
  });
  // The writer finishes (whole file, minus one injected server): the NEXT sync merges into it and keeps everything the CLI wrote.
  const repaired = JSON.parse(whole);
  delete repaired.mcpServers['linear-server'];
  repaired.oauthAccount = { emailAddress: 'scratch@example.invalid' };
  fs.writeFileSync(cj, JSON.stringify(repaired, null, 2));
  await inh.syncAccountInheritance({ ...ACCOUNT, inherit: FULL }, { caller: 'rig-recover' });
  const rec = JSON.parse(fs.readFileSync(cj, 'utf8'));
  Object.assign(out, {
    recoveredMcp: Object.keys(rec.mcpServers).sort(), recoveredTrust: JSON.stringify(rec.projects) === JSON.stringify({ '/scratch/proj': { hasTrustDialogAccepted: true } }),
    recoveredOauth: rec.oauthAccount?.emailAddress === 'scratch@example.invalid',
  });
  ok = control && out.tornControl && (ARM === 'torn_json_boot' || out.settled) && out.byteIdentical && out.warns === 1 && out.links === LINKS.length
    && out.manifestMcp.join() === 'github,linear-server,chrome-devtools' && out.strayTmp.length === 0
    && out.recoveredMcp.join() === 'chrome-devtools,github,linear-server,my-own' && out.recoveredTrust && out.recoveredOauth;
} else if (ARM === 'alias_skills_ui_save') {
  // #241/C14: the source's skills are dotfile-style links and the login's `skills/` is a symlink to the SOURCE's `skills/`.
  // Unguarded, the sync treats the login-side links as its own and unlinks/repoints the SOURCE's through the alias.
  const srcDir = path.join(home, '.claude');
  const dot = path.join(home, 'dotfiles', 'skills');
  fs.rmSync(path.join(srcDir, 'skills'), { recursive: true, force: true });
  fs.mkdirSync(path.join(srcDir, 'skills'), { recursive: true });
  for (const n of ['frontend-design', 'handoff']) {
    put(path.join(dot, n, 'SKILL.md'), `# ${n}\n`);
    fs.symlinkSync(path.join(dot, n), path.join(srcDir, 'skills', n));
  }
  fs.rmSync(path.join(login, 'skills'), { recursive: true, force: true }); // the mirror's real skills/ (its manifest still lists skills/*)
  fs.symlinkSync(path.join(srcDir, 'skills'), path.join(login, 'skills'));
  const srcBefore = snapshot(srcDir);
  out.controlSrc = linksOf(srcBefore).join() === 'skills/frontend-design,skills/handoff' && fs.readlinkSync(path.join(login, 'skills')) === path.join(srcDir, 'skills');
  await apiHandlers.setAccounts([{ ...ACCOUNT, label: 'mc-renamed', inherit: FULL }]); // unchanged selection: a normal save
  const settled = await until(() => store.accounts[0]?.label === 'mc-renamed');
  const aliasWarns = () => logLines().filter((l) => l.includes('resolve into the source') && l.includes(login));
  await until(() => aliasWarns().length > 0);
  await sleep(400);
  const srcAfter = snapshot(srcDir);
  Object.assign(out, {
    settled, srcByteIdentical: JSON.stringify(srcAfter) === JSON.stringify(srcBefore), srcSkillLinks: linksOf(srcAfter).filter((l) => l.startsWith('skills/')),
    aliasKept: fs.lstatSync(path.join(login, 'skills')).isSymbolicLink() && fs.readlinkSync(path.join(login, 'skills')) === path.join(srcDir, 'skills'),
    warns: aliasWarns().length, loginLinks: linksOf(snapshot()).filter((l) => l !== 'skills'), manifestSymlinks: manifest().symlinks.slice().sort(),
  });
  ok = control && out.controlSrc && settled && out.srcByteIdentical && out.srcSkillLinks.length === 2 && out.aliasKept && out.warns === 1
    && out.loginLinks.join() === 'CLAUDE.md,LESSONS.md,RTK.md,settings.json,statusline-command.sh' && out.manifestSymlinks.join() === out.loginLinks.join();
} else if (ARM === 'self_loop_ui_save') {
  // #239/C12: the source is a login dir. Without the guard the sync moves the SOURCE's settings.json/CLAUDE.md/imports to
  // `.orchestra-bak`, leaves self-loops, and writes a manifest + .claude.json into `~/.claude`.
  const srcDir = path.join(home, '.claude');
  const loginB = path.join(home, '.claude-b');
  for (const d of [srcDir, loginB]) {
    const g = checkScratch(d, BASE);
    if (!g.ok) { console.log(JSON.stringify({ arm: ARM, ok: false, error: `SAFETY: ${g.clause}` })); process.exit(3); }
  }
  const srcBefore = snapshot(srcDir);
  out.controlSrc = linksOf(srcBefore).length === 0 && !fs.lstatSync(path.join(srcDir, 'settings.json')).isSymbolicLink() && !fs.existsSync(path.join(srcDir, '.orchestra-inherited.json'));
  await apiHandlers.setAccounts([
    { id: ACCOUNT.id, label: 'mc', configDir: srcDir, inherit: FULL },
    { id: 'rig-b', label: 'b', configDir: loginB, inherit: FULL },
  ]);
  const bLinks = () => (fs.existsSync(loginB) ? linksOf(snapshot(loginB)).length : 0);
  const settled = await until(() => bLinks() === LINKS.length);
  await sleep(400); // the source-pointed account syncs first in store order; let any (unfixed) damage land before reading
  const srcAfter = snapshot(srcDir);
  Object.assign(out, {
    settled, srcByteIdentical: JSON.stringify(srcAfter) === JSON.stringify(srcBefore), srcLinks: linksOf(srcAfter).length,
    srcBak: Object.keys(srcAfter).filter((k) => k.endsWith('.orchestra-bak')), srcManifest: fs.existsSync(path.join(srcDir, '.orchestra-inherited.json')),
    warns: logLines().filter((l) => l.includes('is the inheritance source') && l.includes(srcDir)).length, bLinks: bLinks(),
    bMcp: fs.existsSync(path.join(loginB, '.claude.json')) ? mcpOf(loginB) : null, storeConfigDir: store.accounts[0]?.configDir === srcDir,
  });
  ok = control && out.controlSrc && settled && out.storeConfigDir && out.srcByteIdentical && out.srcLinks === 0 && out.srcBak.length === 0
    && !out.srcManifest && out.warns === 1 && out.bLinks === LINKS.length && out.bMcp?.join() === 'chrome-devtools,github,linear-server';
} else if (ARM === 'same_file_mcp_ui_save') {
  // #239/F1: the login's .claude.json IS the user's global ~/.claude.json (symlink). De-selecting an injected server would
  // `delete servers[k]` in the GLOBAL file. Scratch HOME only.
  const globalJson = path.join(home, '.claude.json');
  const loginB = path.join(home, '.claude-b');
  { const g = checkScratch(loginB, BASE); if (!g.ok) { console.log(JSON.stringify({ arm: ARM, ok: false, error: `SAFETY: ${g.clause}` })); process.exit(3); } }
  await inh.syncAccountInheritance({ id: 'rig-b', label: 'b', configDir: loginB, inherit: FULL }); // real login file + manifest first
  fs.rmSync(path.join(loginB, '.claude.json'));
  fs.symlinkSync(globalJson, path.join(loginB, '.claude.json'));
  const globalBefore = fs.readFileSync(globalJson, 'utf8');
  out.controlGlobal = Object.keys(JSON.parse(globalBefore).mcpServers).join() === 'github,linear-server,chrome-devtools';
  await apiHandlers.setAccounts([
    { id: ACCOUNT.id, label: 'mc', configDir: login, inherit: FULL },
    { id: 'rig-b', label: 'b', configDir: loginB, inherit: { ...FULL, mcpServers: ['github'] } }, // linear-server + chrome-devtools de-selected
  ]);
  const sameFileWarns = () => logLines().filter((l) => l.includes('is the global MCP source')).length;
  const settled = await until(() => sameFileWarns() > 0);
  await sleep(400);
  Object.assign(out, {
    settled, globalByteIdentical: fs.readFileSync(globalJson, 'utf8') === globalBefore, globalMcp: Object.keys(JSON.parse(fs.readFileSync(globalJson, 'utf8')).mcpServers),
    warns: sameFileWarns(), symlinkKept: fs.lstatSync(path.join(loginB, '.claude.json')).isSymbolicLink(),
    manifestMcp: JSON.parse(fs.readFileSync(path.join(loginB, '.orchestra-inherited.json'), 'utf8')).mcpServers,
  });
  ok = control && out.controlGlobal && settled && out.globalByteIdentical && out.warns === 1 && out.symlinkKept && out.manifestMcp.join() === 'github,linear-server,chrome-devtools';
} else if (ARM === 'ui_normal_save') {
  await apiHandlers.setAccounts([{ ...ACCOUNT, label: 'mc-renamed', inherit: FULL }]);
  const changed = await until(() => store.accounts[0]?.label === 'mc-renamed');
  await sleep(600); // the fire-and-forget sync has no completion event on this path — settle, then read
  const after = snapshot();
  Object.assign(out, { labelPersisted: changed, links: linksOf(after).length, mcp: mcpOf(), byteIdentical: JSON.stringify(after) === JSON.stringify(before), heldWarns: logLines().filter((l) => l.includes('would leave no inherited item')).length });
  ok = control && changed && out.byteIdentical && out.heldWarns === 0;
}

out.ok = ok;
console.log(JSON.stringify(out));
process.exit(0);
