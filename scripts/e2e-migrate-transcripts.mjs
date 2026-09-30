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
//   live_writer_stuck    ★ the agent PTY does NOT exit within the bounded wait (ignores SIGTERM ~14 s) → ok:false "did not exit", NOTHING moved, pin unchanged (~10 s arm)
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
  'concurrent', 'live_writer', 'live_writer_stuck', 'exdev_subdir', 'different_dir_moves', 'exdev_move',
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

let live = null;
if (ARM === 'live_writer' || ARM === 'live_writer_stuck') {
  // A REAL PTY session (pty.ts, the plain-node child-process transport) running a fake "agent" that ignores SIGTERM/SIGHUP and
  // appends BY PATH to a.jsonl every 50 ms for 2 s — the CLI still dying/flushing after stop that F2 measured. `claude` (the
  // resume after the move) is a scratch shim that exits at once: no real CLI, zero tokens.
  const bin = path.join(root, 'bin'); mustBeScratch(bin); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const { startPty, isRunning, getPtyPid } = await import(`${REPO}/src/main/pty.ts`);
  const target = path.join(src, 'a.jsonl');
  const script = ARM === 'live_writer'
    ? `trap '' TERM HUP; i=0; while [ $i -lt 40 ]; do echo "late-$i" >> '${target}' 2>/dev/null; i=$((i+1)); sleep 0.05; done`
    : `trap '' TERM HUP; sleep 14`; // stuck: outlives the 10 s bounded wait, writes nothing
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
} else if (ARM === 'live_writer_stuck') {
  out.srcIntact = same(before, afterSrc);
  ok = control && r.ok === false && /did not exit/.test(r.error ?? '') && out.srcIntact && Object.keys(afterDst).length === 0 && pinned === undefined;
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
out.ok = ok;
console.log(JSON.stringify(out));
process.exit(0);
