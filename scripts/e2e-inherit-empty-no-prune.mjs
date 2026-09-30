// #235 residual (C10) — an EMPTY/absent `inherit` must not full-prune a config dir that still holds
// inherited links, unless the Accounts UI setter just de-selected it.
// Drives the REAL api-handlers `setAccounts` (the UI setter), REAL store, REAL account-inherit, REAL
// logger (arms read `<ORCHESTRA_HOME>/logs/orchestra.log`). SCRATCH HOME + config dir only.
//
// Arms (ok:true = the shipped behaviour; on unfixed master the ★ arms print ok:false):
//   refuse_live        ★ the rig's own scratch guard REFUSES ~/.claude-*, $CLAUDE_CONFIG_DIR, a symlink into ~/.claude, outside paths
//   boot_empty_obj     ★ boot order (seed + syncAll, caller=boot), account `inherit:{}` over a live-shaped dir → dir untouched + ONE warn
//   ui_unrelated_save  ★ REAL apiHandlers.setAccounts, account already empty (no de-selection) → dir untouched + warn caller=ui-save
//   ui_deselect          must-PASS: REAL setAccounts takes a FULL selection to empty → links/MCP pruned, own MCP + trust kept
//   ui_normal_save       must-PASS: REAL setAccounts, selection unchanged → nothing pruned, no held-block warn
//   boot_absent_seeded   control: `inherit` ABSENT is re-seeded by boot's seed (pre-existing) → dir keeps its links
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
const ARMS = ['refuse_live', 'boot_empty_obj', 'ui_unrelated_save', 'ui_deselect', 'ui_normal_save', 'boot_absent_seeded'];

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
const seedInherit = ARM === 'ui_deselect' || ARM === 'ui_normal_save' ? FULL : ARM === 'boot_absent_seeded' ? undefined : {};
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

const snapshot = () => {
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
  walk(login, '');
  return o;
};
const linksOf = (s) => Object.keys(s).filter((k) => s[k].startsWith('L:')).sort();
const mcpOf = () => Object.keys(JSON.parse(fs.readFileSync(path.join(login, '.claude.json'), 'utf8')).mcpServers ?? {}).sort();
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
const heldWarn = (caller) => logLines().filter((l) => l.includes('empty inherit selection') && l.includes(`caller=${caller} `) && l.includes(login));
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
} else if (ARM === 'ui_normal_save') {
  await apiHandlers.setAccounts([{ ...ACCOUNT, label: 'mc-renamed', inherit: FULL }]);
  const changed = await until(() => store.accounts[0]?.label === 'mc-renamed');
  await sleep(600); // the fire-and-forget sync has no completion event on this path — settle, then read
  const after = snapshot();
  Object.assign(out, { labelPersisted: changed, links: linksOf(after).length, mcp: mcpOf(), byteIdentical: JSON.stringify(after) === JSON.stringify(before), heldWarns: logLines().filter((l) => l.includes('empty inherit selection')).length });
  ok = control && changed && out.byteIdentical && out.heldWarns === 0;
}

out.ok = ok;
console.log(JSON.stringify(out));
process.exit(0);
