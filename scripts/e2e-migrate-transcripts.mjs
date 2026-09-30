// #240 (C13) — migrating a workspace to another account must NEVER delete its transcripts when the target
// config dir is the same dir spelled differently, and must remove the source only after a verified copy.
// Drives the REAL `dispatchMigrateAccountRequest` (→ moveWorkspaceTranscripts), REAL store, REAL account-inherit sync.
// SCRATCH HOME + scratch config dirs + scratch transcripts only (never a live ~/.claude*).
//
// Arms (ok:true = the shipped behaviour; on unfixed master the ★ arms print ok:false):
//   trailing_slash       ★ default login → account configDir `~/.claude/`            → project dir byte-identical
//   dot_segment          ★ default login → `~/./.claude`                              → byte-identical
//   home_var_dotdot      ★ default login → `$HOME/.claude/../.claude`                 → byte-identical
//   symlink_alias        ★ default login → `~/alias-claude` (symlink → ~/.claude)     → byte-identical
//   acct_trailing_slash  ★ account A `~/.claude-a` → account B `~/.claude-a/`         → byte-identical
//   acct_symlink_alias   ★ account A `~/.claude-a` → B `~/.claude-b` (symlink → A)    → byte-identical
//   shared_projects      ★ two DIFFERENT config dirs whose `projects/` is one shared dir (symlink) → byte-identical
//   bind_mount           ★ B is a bind mount of A (realpath differs, dev+ino equal; unshare -rm) → byte-identical
//   copy_fail_midway     ★ the 3rd entry (a session dir, chmod 555 ⇒ rename EACCES) fails after two moved → ok:false, SOURCE FULLY INTACT, nothing left at the target
//   exdev_copy_fail      ★ same, cross-filesystem: the 2nd file is unreadable ⇒ copy fails → ok:false, source intact, no tmp/orphan copy
//   dst_different_kept   ★ the target already has a DIFFERENT same-named transcript → never overwritten, kept in the source + a warning in the result
//   src_unreadable       ★ the source project dir is unreadable (chmod 000) → NOT a silent ok:true: result.warnings names it, nothing lost
//   live_writer          ★ a REAL agent PTY still appending to its transcript (ignores SIGTERM for ~2 s) when the migration starts → the move waits for its exit; NO appended line is lost or split
//   live_writer_stuck    ★ an agent PTY that ignores HUP/TERM for ~15 s (appending by path): after the bounded wait it is SIGKILLed (pid + start-time verified) and the move goes ahead; a RETRY moves nothing under a live writer → 0 appends lost (~12 s arm)
//   stuck_latch          ★ SIGKILL suppressed (seam) so the child survives the stop → latched: every migration of the workspace is refused, naming the pid, until it really dies
//   stuck_identity       ★ at the escalation the pid no longer names the SAME process (start-time changed = recycled) → it is NEVER signalled (seam: /proc read)
//   start_fence          ★ while a migration is between stop and re-pin, an agent PTY start AND an SDK ensureSession for that workspace are refused; the migration's own resume still works
//   keeper_detached      ★ NO in-memory session, a REAL detached keeper (built keeper.js) + fake CLI appending by path → keeper AND CLI dead when the migration returns, 0 appends lost (needs `pnpm run build:keeper`)
//   keeper_slowterm      ★ same, the CLI takes 1.5 s to die on SIGTERM → the move still waits for it
//   concurrent           ★ two overlapping migrations of ONE workspace (the reviewer's shape) → 0 transcripts lost, the 2nd is refused "already in progress"
//   exdev_subdir         ★ target on ANOTHER filesystem (tmpfs), session has a subdir → moves + source gone (master: EISDIR)
//   different_dir_moves    must-PASS: genuinely different target → everything at the target byte-identical, mtimes kept, source gone
//   exdev_move           ★ target on another filesystem, flat files → moves with mtimes KEPT (master's EXDEV copyFile drops them)
//
// Run one arm:  node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-migrate-transcripts.mjs <arm>
// Run all:      node scripts/e2e-migrate-transcripts.mjs all      (children + an independent live-dir canary before/after)

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
const ARMS = [
  'trailing_slash', 'dot_segment', 'home_var_dotdot', 'symlink_alias', 'acct_trailing_slash', 'acct_symlink_alias',
  'shared_projects', 'bind_mount', 'copy_fail_midway', 'exdev_copy_fail', 'dst_different_kept', 'src_unreadable',
  'concurrent', 'live_writer', 'live_writer_stuck', 'stuck_latch', 'stuck_identity', 'start_fence', 'keeper_detached', 'keeper_slowterm', 'exdev_subdir', 'different_dir_moves', 'exdev_move',
];
const BASE = process.env.E2E_HOME ?? path.join(REAL_HOMES[0], '.cache', 'e2e-migrate-transcripts'); // btrfs, under ~
const XBASE = process.env.E2E_XHOME ?? path.join(os.tmpdir(), 'e2e-migrate-transcripts-x'); // tmpfs: a DIFFERENT filesystem (EXDEV)

// ---- runner: one child per arm, plus an independent live-dir canary ----------------------------------
if (ARM === 'all') {
  const pre = liveCanary();
  const rows = [];
  for (const arm of ARMS) {
    let line = '';
    const args = ['--experimental-strip-types', '--import', './scripts/.r2-register.mjs', fileURLToPath(import.meta.url), arm];
    // bind_mount needs a mount namespace (no root): the WHOLE arm runs inside `unshare -rm`, the arm mounts.
    const [cmd, argv] = arm === 'bind_mount' ? ['unshare', ['-rm', process.execPath, ...args]] : [process.execPath, args];
    try {
      line = execFileSync(cmd, argv, {
        cwd: REPO, encoding: 'utf8', timeout: 120_000,
        env: { PATH: process.env.PATH, HOME: os.homedir(), ...(REAL_CFG ? { CLAUDE_CONFIG_DIR: REAL_CFG } : {}), ...(process.env.E2E_HOME ? { E2E_HOME: process.env.E2E_HOME } : {}), ...(process.env.E2E_XHOME ? { E2E_XHOME: process.env.E2E_XHOME } : {}) },
      });
    } catch (e) { line = String(e.stdout ?? ''); }
    const j = [...line.split('\n')].reverse().find((l) => l.startsWith('{'));
    const r = j ? JSON.parse(j) : { arm, ok: false, error: 'no result line', raw: line.slice(-300) };
    rows.push(r);
    console.log(`${r.ok ? 'ok    ' : 'NOT OK'} ${arm}  ${j ?? r.raw}`);
  }
  const post = liveCanary();
  const diff = canaryDiff(pre, post);
  const unchanged = diff.strict.length === 0;
  console.log(`live-dir canary (find depth<=2; STRICT = symlink set + inherit manifest + MCP key list; ${Object.keys(pre).length} dirs): strict ${unchanged ? 'UNCHANGED' : 'CHANGED ' + JSON.stringify(diff.strict)}; churn ${JSON.stringify(diff.churn)}`);
  const bad = rows.filter((r) => !r.ok).map((r) => r.arm);
  console.log(`SUMMARY arms=${rows.length}/${ARMS.length} ok=${rows.length - bad.length} notok=${bad.length}${bad.length ? ' [' + bad.join(',') + ']' : ''} canary=${unchanged ? 'UNCHANGED' : 'CHANGED'}`);
  process.exit(bad.length === 0 && unchanged && rows.length === ARMS.length ? 0 : 1);
}
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

// ---- one arm ------------------------------------------------------------------------------------------
const out = { arm: ARM };
const bail = (error) => { console.log(JSON.stringify({ arm: ARM, ok: false, error })); process.exit(3); };
const scratchOk = (p) => { const a = checkScratch(p, BASE); return a.ok ? a : checkScratch(p, XBASE); };
const mustBeScratch = (p) => { const g = scratchOk(p); if (!g.ok) bail(`SAFETY: ${g.clause} ${g.detail}`); };

const X_ARM = ARM.startsWith('exdev');
const root = path.join(BASE, ARM);
const xroot = path.join(XBASE, ARM);
for (const p of [BASE, root, ...(X_ARM ? [XBASE, xroot] : [])]) mustBeScratch(p);
if (path.basename(BASE) !== 'e2e-migrate-transcripts' && !process.env.E2E_HOME) bail('SAFETY: unexpected BASE');
/** Permissions an arm tightened must be loosened again (the scratch tree has to stay deletable). Scratch-only: `dir` is asserted. */
const restoreTree = (dir) => {
  mustBeScratch(dir);
  const walk = (d) => { try { if (fs.lstatSync(d).isSymbolicLink()) return; fs.chmodSync(d, 0o755); for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.lstatSync(p).isDirectory()) walk(p); else if (!fs.lstatSync(p).isSymbolicLink()) fs.chmodSync(p, 0o644); } } catch { /* gone */ } };
  walk(dir);
};
restoreTree(root); restoreTree(xroot);
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(xroot, { recursive: true, force: true });

const home = path.join(root, 'home');
const ohome = path.join(home, '.orchestra');
const userData = path.join(root, 'userData');
const wtPath = path.join(root, 'wt', 'ws1');
for (const p of [home, ohome, userData, wtPath]) mustBeScratch(p);
for (const p of [ohome, userData, wtPath, ...(X_ARM ? [xroot] : [])]) fs.mkdirSync(p, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = ohome;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude-rig-cfg'); // scratch — never the invoker's
delete process.env.ORCHESTRA_HIBERNATE_AFTER_MS;
if (os.homedir() !== home) bail(`SAFETY: os.homedir() ${os.homedir()} != scratch ${home}`);

const HD = path.join(home, '.claude'); // the default login's config dir (what the real function derives)
const mangle = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const MANGLED = mangle(wtPath);
const projOf = (cfg) => path.join(cfg, 'projects', MANGLED);

// Per arm: where the workspace starts (default login unless `srcCfg`), and the target account's configDir TEMPLATE.
const S = {
  trailing_slash:      { target: '~/.claude/' },
  dot_segment:         { target: '~/./.claude' },
  home_var_dotdot:     { target: '$HOME/.claude/../.claude' },
  symlink_alias:       { target: '~/alias-claude', prep: () => fs.symlinkSync(HD, path.join(home, 'alias-claude')) },
  acct_trailing_slash: { srcCfg: path.join(home, '.claude-a'), target: '~/.claude-a/' },
  acct_symlink_alias:  { srcCfg: path.join(home, '.claude-a'), target: '~/.claude-b', prep: () => fs.symlinkSync(path.join(home, '.claude-a'), path.join(home, '.claude-b')) },
  shared_projects: {
    srcCfg: path.join(home, '.claude-a'), target: '~/.claude-b',
    prep: () => { fs.mkdirSync(path.join(home, '.claude-b'), { recursive: true }); fs.symlinkSync(path.join(home, '.claude-a', 'projects'), path.join(home, '.claude-b', 'projects')); },
  },
  bind_mount: {
    srcCfg: path.join(home, '.claude-a'), target: '~/.claude-b',
    prep: () => { fs.mkdirSync(path.join(home, '.claude-b'), { recursive: true }); execFileSync('mount', ['--bind', path.join(home, '.claude-a'), path.join(home, '.claude-b')]); },
  },
  copy_fail_midway:    { target: '~/.claude-b', post: () => fs.chmodSync(path.join(src, 'c'), 0o555) }, // renaming a DIR needs write on the dir itself: entries a, b move, then `c` fails EACCES
  exdev_copy_fail:     { target: path.join(xroot, 'cfg-b'), post: () => fs.chmodSync(path.join(src, 'b.jsonl'), 0o000) }, // cp cannot read b.jsonl (2nd entry)
  dst_different_kept:  { target: '~/.claude-b', post: () => put(path.join(projOf(path.join(home, '.claude-b')), 'b.jsonl'), 'DST-HAS-A-DIFFERENT-NEWER-CONVERSATION\n', 1_756_999_999) },
  src_unreadable:      { target: '~/.claude-b', post: () => fs.chmodSync(src, 0o000) },
  concurrent:          { srcCfg: path.join(home, '.claude-a'), target: '~/.claude-b' },
  live_writer:         { target: '~/.claude-b' },
  live_writer_stuck:   { target: '~/.claude-b' },
  stuck_latch:         { target: '~/.claude-b' },
  stuck_identity:      { target: '~/.claude-b' },
  start_fence:         { target: '~/.claude-b' },
  keeper_detached:     { target: '~/.claude-b' },
  keeper_slowterm:     { target: '~/.claude-b' },
  exdev_subdir:        { target: path.join(xroot, 'cfg-b') },
  different_dir_moves: { target: '~/.claude-b' },
  exdev_move:          { target: path.join(xroot, 'cfg-b') },
}[ARM];
const ALIAS = ['trailing_slash', 'dot_segment', 'home_var_dotdot', 'symlink_alias', 'acct_trailing_slash', 'acct_symlink_alias', 'shared_projects', 'bind_mount'].includes(ARM);
const srcCfg = S.srcCfg ?? HD;

// Transcripts: distinct mtimes, multi-KB content, a session subdir tree (subagents/tool-results) — except the flat EXDEV control.
const SUBDIR = ARM !== 'exdev_move';
const put = (p, body, mtimeSec) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); const t = new Date(mtimeSec * 1000); fs.utimesSync(p, t, t); };
const line = (n) => JSON.stringify({ type: 'user', n, text: 'x'.repeat(200) + String(n) }) + '\n';
const body = (k, n) => Array.from({ length: n }, (_, i) => line(`${k}-${i}`)).join('');
const src = projOf(srcCfg);
mustBeScratch(srcCfg);
fs.mkdirSync(srcCfg, { recursive: true });
S.prep?.();
put(path.join(src, 'a.jsonl'), body('a', 40), 1_756_000_000);
put(path.join(src, 'b.jsonl'), body('b', 90), 1_756_100_000);
put(path.join(src, 'c.jsonl'), body('c', 25), 1_756_200_000);
if (SUBDIR) {
  put(path.join(src, 'c', 'subagents', 'agent-1.jsonl'), body('s1', 12), 1_756_200_100);
  put(path.join(src, 'c', 'tool-results', 'r.txt'), 'result\n'.repeat(500), 1_756_200_200);
}

// SAFETY: resolve every config dir the real function will touch and refuse anything outside the scratch prefix.
const expand = (t) => t.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home);
const dstCfg = expand(S.target);
for (const p of [srcCfg, dstCfg, path.join(dstCfg, 'projects'), projOf(dstCfg)]) mustBeScratch(p);

// ---- signatures -----------------------------------------------------------------------------------------
const sig = (dir) => {
  const o = {};
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name); const r = rel ? `${rel}/${ent.name}` : ent.name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) o[r] = `L:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { o[r] = 'D'; walk(p, r); }
      else o[r] = `F:${st.size}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16)}:${st.mtimeMs}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return o;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const before = sig(src);
const nFiles = Object.values(before).filter((v) => v.startsWith('F:')).length;
// POSITIVE CONTROL: the mirror really holds transcripts (a rig that started empty proves nothing).
const control = nFiles >= (SUBDIR ? 5 : 3) && Object.keys(before).includes('a.jsonl');
S.post?.(); // arm-specific tightening AFTER the pristine signature was taken (restored by restoreTree after the dispatch)

// ---- store + platform + logger (real) ---------------------------------------------------------------
const ACCT_A = { id: 'acct-a', label: 'a', configDir: srcCfg };
const ACCT_B = { id: 'acct-b', label: 'b', configDir: S.target };
fs.mkdirSync(path.join(userData, 'orchestra'), { recursive: true });
fs.writeFileSync(path.join(userData, 'orchestra', 'store.json'), JSON.stringify({
  repos: [], workspaces: [], selfTuneRuns: [], accounts: S.srcCfg ? [ACCT_A, ACCT_B] : [ACCT_B],
}, null, 2));
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-migrate-transcripts', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {}, openExternal: () => {}, showItemInFolder: () => {},
  openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => userData, getLogsDir: () => path.join(userData, 'logs'),
  getAppVersion: () => '0.0.0-e2e-migrate-transcripts', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { initLogger } = await import(`${REPO}/src/main/logger.ts`);
initLogger();
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load();
const { dispatchMigrateAccountRequest } = await import(`${REPO}/src/main/workspaces.ts`);
const fence = await import(`${REPO}/src/main/migration-fence.ts`); // every arm: whatever the outcome, the fence must be RELEASED when dispatch returns
// The zero-token contract (D6): no credentials in any scratch dir ⇒ refreshAccountsNow() has nothing to fetch.
const creds = [srcCfg, dstCfg].map((d) => path.join(d, '.credentials.json')).filter((f) => fs.existsSync(f));
if (creds.length) bail(`SAFETY: credentials present in scratch config dir: ${creds}`);

await store.upsertWorkspace({
  id: 'ws1', name: 'ws1', kind: 'scratch', repoPath: '', branch: 'ws1', worktreePath: wtPath,
  status: 'idle', createdAt: Date.now(), hasInput: false, ...(S.srcCfg ? { accountId: ACCT_A.id } : {}),
});

// Precondition per arm: the spelling really IS the same object / different filesystem (else the arm proves nothing).
const idn = (p) => { const s = fs.statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; };
if (ALIAS) {
  const a = projOf(srcCfg); const b = projOf(dstCfg);
  const sameObj = fs.existsSync(b) && idn(a) === idn(b);
  out.aliasControl = { sameObj, rawStringDiffers: expand(S.target) !== srcCfg, realpathDiffers: fs.realpathSync(a) !== fs.realpathSync(b) };
  if (!sameObj) bail(`PRECONDITION: target project dir is not the same object as the source (${a} vs ${b})`);
  if (!out.aliasControl.rawStringDiffers) bail('PRECONDITION: raw config-dir strings are EQUAL — master already handles this spelling; the arm proves nothing');
}
if (X_ARM) {
  const dSrc = fs.statSync(srcCfg).dev; const dDst = fs.statSync(xroot).dev;
  out.exdevControl = { srcDev: dSrc, dstDev: dDst };
  if (dSrc === dDst) bail('PRECONDITION: source and target are on the SAME filesystem — no EXDEV; arm would be vacuous');
}

if (ARM === 'concurrent') {
  // TWO overlapping migrations of ONE workspace (UI click + `orchestra migrate-account`, or a retried CLI call) through the
  // REAL dispatch. Delays for the 2nd call are drawn from [0, solo duration] so they land inside the 1st call.
  const ITERS = Number(process.env.E2E_CONC_ITERS ?? 40);
  const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const dstP = projOf(dstCfg);
  const seedIter = () => {
    for (const d of [srcCfg, dstCfg]) { mustBeScratch(d); fs.rmSync(d, { recursive: true, force: true }); }
    fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(dstCfg, { recursive: true });
    const files = new Map();
    for (let i = 0; i < 24; i++) { const b = crypto.randomBytes(400_000 + i); fs.writeFileSync(path.join(src, `s${i}.jsonl`), b); files.set(`s${i}.jsonl`, h(b)); }
    return files;
  };
  const ws0 = { id: 'ws1', name: 'ws1', kind: 'scratch', repoPath: '', branch: 'ws1', worktreePath: wtPath, status: 'idle', createdAt: Date.now(), hasInput: false, accountId: ACCT_A.id };
  seedIter(); await store.upsertWorkspace({ ...ws0 });
  const t0 = Date.now(); const solo = await dispatchMigrateAccountRequest({ id: 'ws1', accountId: ACCT_B.id }); const T1 = Math.max(Date.now() - t0, 2);
  let lostIters = 0, lostFiles = 0, guardFired = 0, otherFailures = 0, bothOk = 0, movedIters = 0;
  for (let it = 0; it < ITERS; it++) {
    const files = seedIter(); await store.upsertWorkspace({ ...ws0 });
    const delay = Math.floor(Math.random() * T1);
    const [r1, r2] = await Promise.all([
      dispatchMigrateAccountRequest({ id: 'ws1', accountId: ACCT_B.id }),
      sleep(delay).then(() => dispatchMigrateAccountRequest({ id: 'ws1', accountId: ACCT_B.id })),
    ]);
    await sleep(20);
    for (const r of [r1, r2]) { if (r.ok) continue; if (/already in progress/.test(r.error ?? '')) guardFired++; else otherFailures++; }
    if (r1.ok && r2.ok) bothOk++;
    let lost = 0;
    for (const [n, hash] of files) {
      const at = (d) => { const f = path.join(d, n); return fs.existsSync(f) && h(fs.readFileSync(f)) === hash; };
      if (!at(src) && !at(dstP)) lost++;
    }
    if (lost) { lostIters++; lostFiles += lost; }
    if ([...files.keys()].every((n) => fs.existsSync(path.join(dstP, n))) && !fs.existsSync(src)) movedIters++; // the winner really moved everything
  }
  Object.assign(out, { soloOk: solo.ok, soloMs: T1, iters: ITERS, lostIters, lostFiles, guardFired, otherFailures, bothOk, movedIters });
  out.ok = solo.ok === true && lostFiles === 0 && guardFired > 0 && otherFailures === 0 && movedIters === ITERS; // guardFired>0 = positive control: the overlap really happened
  console.log(JSON.stringify(out));
  process.exit(0);
}

// ---- arms that drive a REAL agent process around a migration (each dispatches itself and exits) --------------------
const PROC_ARMS = ['live_writer_stuck', 'stuck_latch', 'stuck_identity', 'start_fence', 'keeper_detached', 'keeper_slowterm'];
if (PROC_ARMS.includes(ARM)) {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); } catch { return false; } try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0] !== 'Z'; } catch { return false; } };
  const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => /^late-\d+$/.test(l)).length : 0);
  // `claude` (the resume after the move) is a scratch shim that exits at once: no real CLI, zero tokens.
  const bin = path.join(root, 'bin'); mustBeScratch(bin); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const pty = await import(`${REPO}/src/main/pty.ts`);
  const target = path.join(src, 'a.jsonl'); const countFile = path.join(root, 'count'); const dstP = projOf(dstCfg);
  const startAgent = async (script) => {
    await pty.startPty({ id: 'ws1', workspaceId: 'ws1', cwd: wtPath, cols: 80, rows: 24, command: '/bin/sh', args: ['-c', script] });
    const pid = pty.getPtyPid('ws1'); await sleep(250);
    if (!pty.isRunning('ws1') || !pid) bail('PRECONDITION: the fake agent PTY is not running');
    return pid;
  };
  const finish = (extra, ok) => { restoreTree(root); restoreTree(xroot); const fenceReleased = !fence.isMigrating('ws1'); console.log(JSON.stringify({ ...out, control, ...extra, fenceReleased, ok: control && ok && fenceReleased })); process.exit(0); };

  if (ARM === 'live_writer_stuck') {
    // Ignores HUP/TERM for ~15 s, appending by path: past the 10 s bounded wait it is SIGKILLed; the retry is a no-op, never a move under a writer.
    const pid = await startAgent(`trap '' TERM HUP; i=0; while [ $i -lt 300 ]; do echo "late-$i" >> '${target}' 2>/dev/null; i=$((i+1)); echo $i > '${countFile}'; sleep 0.05; done`);
    const t0 = Date.now(); const r1 = await dispatchMigrateAccountRequest({ id: 'ws1', accountId: ACCT_B.id }); const ms1 = Date.now() - t0;
    const alive1 = alive(pid);
    const r2 = await dispatchMigrateAccountRequest({ id: 'ws1', accountId: ACCT_B.id }); // the user clicks Migrate again
    await sleep(500);
    const attempted = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : -1);
    const atDst = lines(path.join(dstP, 'a.jsonl')); const atSrc = lines(target);
    const pinned = store.getWorkspace('ws1')?.accountId;
    finish({ first: { ok: r1.ok, error: r1.error, ms: ms1, childAlive: alive1 }, retry: { ok: r2.ok, error: r2.error }, appends: { attempted, atDst, atSrc, lost: attempted - atDst - atSrc }, srcExists: fs.existsSync(src), pinned: pinned ?? null },
      r1.ok === true && !alive1 && ms1 >= 9000 && r2.ok === true && atSrc === 0 && attempted > 0 && atDst >= attempted && !fs.existsSync(src) && pinned === ACCT_B.id);
  }
  if (ARM === 'stuck_latch') {
    // SIGKILL suppressed by the test seam ⇒ the child survives the stop. It must then be LATCHED: no migration of this workspace while it lives.
    const pid = await startAgent(`trap '' TERM HUP; sleep 40`);
    const stopped = await pty.stopPtyAndWait('ws1', 300, 300, { kill: () => {} });
    const latch = pty.stuckPtyWriter('ws1');
    const r1 = await dispatchMigrateAccountRequest({ id: 'ws1', accountId: ACCT_B.id }); // isRunning('ws1') is false now: only the latch can refuse
    const afterR1 = sig(src);
    process.kill(pid, 'SIGKILL');
    let released = false; for (let i = 0; i < 60 && !released; i++) { released = pty.stuckPtyWriter('ws1') === null; if (!released) await sleep(50); }
    const r2 = await dispatchMigrateAccountRequest({ id: 'ws1', accountId: ACCT_B.id });
    const pinned = store.getWorkspace('ws1')?.accountId;
    finish({ stopped, latch, first: { ok: r1.ok, error: r1.error }, srcIntactAfterRefusal: same(before, afterR1), released, second: { ok: r2.ok, error: r2.error }, movedIdentical: same(before, sig(dstP)), pinned: pinned ?? null },
      stopped === false && latch?.pid === pid && r1.ok === false && new RegExp(`pid ${pid}.*still running`).test(r1.error ?? '') && same(before, afterR1) && released && r2.ok === true && same(before, sig(dstP)) && pinned === ACCT_B.id);
  }
  if (ARM === 'stuck_identity') {
    // The child ignores the stop. At the escalation its /proc start-time reads DIFFERENT (as if the pid had been recycled): the stop must NOT
    // signal that pid. (The child itself is real and alive — a wrong SIGKILL would kill it.)
    const pid = await startAgent(`trap '' TERM HUP; sleep 40`);
    const real = (p_) => { try { return fs.readFileSync(`/proc/${p_}/stat`, 'utf8'); } catch { return null; } };
    let reads = 0; const signalled = [];
    const readStat = (p_) => { const t = real(p_); reads++; return reads === 1 || t === null ? t : t.replace(/(\) (?:\S+ ){19})(\d+)/, (_m, a, b) => `${a}${Number(b) + 1}`); };
    const res = await pty.stopPtyAndWait('ws1', 300, 300, { kill: (p_, sg) => { signalled.push([p_, sg]); }, readStat });
    const stillAlive = alive(pid);
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    finish({ resolved: res, signalled, childAliveAfter: stillAlive, statReads: reads }, res === true && signalled.length === 0 && stillAlive && reads >= 2);
  }
  if (ARM === 'start_fence') {
    // The agent takes ~2.5 s to die on stop, so the migration sits between stop and re-pin. In that window neither start path may run an agent.
    await import(`${REPO}/src/main/agent-sdk.ts`); // registers the SDK delivery seam, as the app does
    const sdkd = await import(`${REPO}/src/main/sdk-delivery.ts`);
    await startAgent(`trap '' TERM HUP; sleep 2.5`);
    const p = dispatchMigrateAccountRequest({ id: 'ws1', accountId: ACCT_B.id });
    await sleep(700);
    let ptyErr = null; try { await pty.startPty({ id: 'ws1', workspaceId: 'ws1', cwd: wtPath, cols: 80, rows: 24, command: '/bin/sh', args: ['-c', 'sleep 0.2'] }); } catch (e) { ptyErr = String(e.message); }
    const sdkRes = await sdkd.sdkStartAndDeliverResult('ws1', 'hello');
    const during = { ptyRefused: /being migrated/.test(ptyErr ?? ''), ptyRunning: pty.isRunning('ws1'), sdkRefused: sdkRes.ok === false && /being migrated/.test(sdkRes.error ?? ''), sdkSession: sdkd.sdkSessionLive('ws1') };
    const r = await p;
    finish({ during, result: r },
      during.ptyRefused && !during.ptyRunning && during.sdkRefused && !during.sdkSession && r.ok === true && r.resumed === true);
  }
  // keeper_detached / keeper_slowterm: a REAL detached keeper daemon (dist-electron/keeper.js) running a fake CLI that appends BY PATH —
  // the app "relaunched": NO in-memory SDK session (agent-sdk is loaded, as in the app), isRunning() false.
  const { spawn } = await import('node:child_process'); const net = await import('node:net');
  const kc = await import(`${REPO}/src/main/keeper-client.ts`);
  await import(`${REPO}/src/main/agent-sdk.ts`);
  const keeperJs = path.join(REPO, 'dist-electron', 'keeper.js');
  if (!fs.existsSync(keeperJs)) bail('PRECONDITION: dist-electron/keeper.js is missing — run `pnpm run build:keeper`');
  const kdir = path.join(ohome, 'keepers'); fs.mkdirSync(kdir, { recursive: true }); fs.mkdirSync(path.join(ohome, 'bin'), { recursive: true });
  fs.copyFileSync(keeperJs, path.join(ohome, 'bin', 'keeper.js'));
  const WS = 'ws1';
  if (!kc.keeperSocketPath(WS).startsWith(ohome + path.sep)) bail('VOID: keeper socket path fell back to a hashed tmp name');
  const cli = path.join(root, 'fake-cli.cjs');
  fs.writeFileSync(cli, `
const fs=require('fs'); let i=0; const t=${JSON.stringify(target)}; const cnt=${JSON.stringify(path.join(root, 'child.done'))};
setInterval(()=>{ try{ fs.appendFileSync(t, 'late-'+i+'\\n'); i++; }catch(e){} }, 50);
process.on('SIGTERM',()=>{ const fin=()=>{ fs.writeFileSync(cnt,String(i)); process.exit(0); }; if(${ARM === 'keeper_slowterm'}) setTimeout(fin,1500); else fin(); });
process.stdin.on('data',()=>{}); setTimeout(()=>{ fs.writeFileSync(cnt,String(i)); process.exit(0); }, 25000);
`);
  const pidFile = path.join(kdir, `${WS}.pid`);
  const k = spawn(process.execPath, [path.join(ohome, 'bin', 'keeper.js'), WS, kc.keeperSocketPath(WS), pidFile, path.join(kdir, `${WS}.log`)], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  k.unref();
  for (let i = 0; i < 250 && !fs.existsSync(pidFile); i++) await sleep(100);
  const sock = net.connect(kc.keeperSocketPath(WS)); await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  sock.on('data', () => {}); sock.write(JSON.stringify({ t: 'hello', wsId: WS }) + '\n'); await sleep(150);
  sock.write(JSON.stringify({ t: 'spawn', command: process.execPath, args: [cli], cwd: wtPath, env: { PATH: process.env.PATH } }) + '\n');
  await sleep(600);
  const keeperPid = JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid;
  const cliPid = Number(fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).find((n) => { try { return fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0')[1] === cli; } catch { return false; } })) || null;
  const { sdkSessionLive } = await import(`${REPO}/src/main/sdk-delivery.ts`);
  const kc0 = { keeperAlive: alive(keeperPid), cliAlive: alive(cliPid), isRunning: pty.isRunning('ws1'), sdkSessionLive: sdkSessionLive('ws1') };
  if (!kc0.keeperAlive || !kc0.cliAlive || kc0.isRunning || kc0.sdkSessionLive) bail('PRECONDITION: ' + JSON.stringify(kc0));
  await sleep(300); // the CLI is mid-append when the migration starts
  const r = await dispatchMigrateAccountRequest({ id: 'ws1', accountId: ACCT_B.id });
  await sleep(1800);
  const attempted = Number(fs.existsSync(path.join(root, 'child.done')) ? fs.readFileSync(path.join(root, 'child.done'), 'utf8') : -1);
  const atDst = lines(path.join(dstP, 'a.jsonl')); const atSrc = lines(target);
  const res = { dispatchOk: r.ok, keeperAliveAfter: alive(keeperPid), cliAliveAfter: alive(cliPid), attempted, atDst, atSrc, lost: attempted - atDst - atSrc, pinned: store.getWorkspace('ws1')?.accountId ?? null };
  for (const pid of [keeperPid, cliPid]) { try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  try { sock.destroy(); } catch { /* gone */ }
  finish({ keeperControl: kc0, keeper: res }, r.ok === true && !res.keeperAliveAfter && !res.cliAliveAfter && res.lost === 0 && attempted > 0 && atSrc === 0 && res.pinned === ACCT_B.id);
}

let live = null;
if (ARM === 'live_writer') {
  // A REAL PTY session (pty.ts, the plain-node child-process transport) running a fake "agent" that ignores SIGTERM/SIGHUP and
  // appends BY PATH to a.jsonl every 50 ms for 2 s — the CLI still dying/flushing after stop that F2 measured. `claude` (the
  // resume after the move) is a scratch shim that exits at once: no real CLI, zero tokens.
  const bin = path.join(root, 'bin'); mustBeScratch(bin); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const { startPty, isRunning, getPtyPid } = await import(`${REPO}/src/main/pty.ts`);
  const target = path.join(src, 'a.jsonl');
  const script = `trap '' TERM HUP; i=0; while [ $i -lt 40 ]; do echo "late-$i" >> '${target}' 2>/dev/null; i=$((i+1)); sleep 0.05; done`;
  await startPty({ id: 'ws1', workspaceId: 'ws1', cwd: wtPath, cols: 80, rows: 24, command: '/bin/sh', args: ['-c', script] });
  const pid = getPtyPid('ws1');
  live = { running: isRunning('ws1'), pid };
  await new Promise((res) => setTimeout(res, 250)); // the writer is mid-loop
  out.liveControl = live;
  if (!live.running || !pid) bail('PRECONDITION: the fake agent PTY is not running');
}
const r = await dispatchMigrateAccountRequest({ id: 'ws1', accountId: ACCT_B.id });
if (live) { live.aliveAfter = (() => { try { process.kill(live.pid, 0); return true; } catch { return false; } })(); }
restoreTree(root); restoreTree(xroot);
const pinned = store.getWorkspace('ws1')?.accountId;
const dst = projOf(dstCfg);
const afterSrc = sig(src);
const afterDst = sig(dst);
// Top-level mtime-order preservation (`--continue` resumes the NEWEST transcript).
const newest = (s) => Object.keys(s).filter((k) => k.endsWith('.jsonl') && !k.includes('/')).sort((x, y) => Number(s[x].split(':')[3]) - Number(s[y].split(':')[3])).join('<');
Object.assign(out, { result: r, pinned: pinned ?? null, control, nFiles, srcFilesAfter: Object.keys(afterSrc).length, dstFilesAfter: Object.keys(afterDst).length });

let ok = false;
if (ALIAS) {
  // The transcripts must still be where they were, byte-identical (content + mtime), the migration itself succeeds.
  out.byteIdentical = same(before, afterSrc);
  out.lost = Object.keys(before).filter((k) => !(k in afterSrc));
  out.noWarnings = r.warnings === undefined; // the same-dir early return is silent (a guard that only limps through per-entry checks warns)
  ok = control && r.ok === true && out.byteIdentical && out.noWarnings && pinned === ACCT_B.id;
} else if (ARM === 'copy_fail_midway' || ARM === 'exdev_copy_fail') {
  // A failure mid-way: ok:false, the SOURCE whole again (byte-identical incl. mtimes), nothing (no tmp, no orphan) at the target, pin unchanged.
  out.srcIntact = same(before, afterSrc);
  out.leftAtTarget = Object.keys(afterDst);
  ok = control && r.ok === false && out.srcIntact && out.leftAtTarget.length === 0 && pinned === undefined;
} else if (ARM === 'dst_different_kept') {
  // A same-named DIFFERENT transcript at the target is never overwritten: kept there AND in the source, a warning names it; the rest moves.
  const dstB = fs.readFileSync(path.join(dst, 'b.jsonl'), 'utf8');
  out.dstBIntact = dstB === 'DST-HAS-A-DIFFERENT-NEWER-CONVERSATION\n';
  out.srcBKept = afterSrc['b.jsonl'] === before['b.jsonl'];
  out.restMoved = ['a.jsonl', 'c.jsonl', 'c'].every((k) => afterDst[k] === before[k] || k === 'c') && !('a.jsonl' in afterSrc) && !('c.jsonl' in afterSrc);
  out.warned = (r.warnings ?? []).some((w) => /b\.jsonl/.test(w));
  ok = control && r.ok === true && out.dstBIntact && out.srcBKept && out.restMoved && out.warned && pinned === ACCT_B.id;
} else if (ARM === 'live_writer') {
  // All 40 appended lines must be at the destination (none split into a recreated source file, none lost to a removed dir),
  // the fake agent must be DEAD when the migration returns, and the source project dir gone.
  const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => /^late-\d+$/.test(l)) : []);
  const atDst = lines(path.join(dst, 'a.jsonl')); const atSrc = lines(path.join(src, 'a.jsonl'));
  out.late = { atDst: atDst.length, atSrc: atSrc.length, aliveAfter: live.aliveAfter };
  ok = control && r.ok === true && atDst.length === 40 && atSrc.length === 0 && live.aliveAfter === false && !fs.existsSync(src) && pinned === ACCT_B.id;
} else if (ARM === 'src_unreadable') {
  // An unreadable source dir is NOT "nothing to move": the result carries a warning naming it; nothing lost, nothing created.
  out.warned = (r.warnings ?? []).some((w) => /cannot read/.test(w));
  out.srcIntact = same(before, afterSrc);
  ok = control && r.ok === true && out.warned && out.srcIntact && Object.keys(afterDst).length === 0 && pinned === ACCT_B.id;
} else {
  // different_dir_moves / exdev_*: all at the target byte-identical (content + mtime), order kept, source gone, pin moved.
  out.movedIdentical = same(before, afterDst);
  out.orderKept = newest(before) === newest(afterDst);
  out.srcGone = !fs.existsSync(src);
  ok = control && r.ok === true && out.movedIdentical && out.orderKept && out.srcGone && pinned === ACCT_B.id;
}
out.fenceReleased = !fence.isMigrating('ws1');
out.ok = ok && out.fenceReleased;
console.log(JSON.stringify(out));
process.exit(0);
