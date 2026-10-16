// #240 — an account migration must never delete a workspace's transcripts. Driven through the REAL `dispatchMigrateAccountRequest` (the
// function behind the UI, the socket route and `orchestra migrate-account`) over a scratch HOME / ORCHESTRA_HOME / config dirs — never a live
// `~/.claude*`. Every clause asserts the end state of the DISK + the store: all transcripts present, byte-identical, mtime-identical, in the
// config dir of the account the workspace is now pinned to.
//
//   slash / tilde_default / symlink / shared_projects / bindmount   ★ must-FAIL on master: target = the SAME dir spelled differently
//                   (trailing slash; default login `~/.claude` vs an account `~/.claude/`; a symlink alias; two config dirs sharing one
//                   `projects/` symlink; a `mount --bind` inside `unshare -Urm`) → master "moves" onto itself and `rm -r`s the dir
//   different       — control: a genuinely different target still moves, the source project dir is gone, the pin follows
//   concurrent_same ★ two OVERLAPPING migrations to the SAME account (40 iterations, the 2nd at a random instant of the 1st) → nothing lost / stranded
//   concurrent_diff ★ two overlapping migrations to DIFFERENT accounts → the transcripts all end up in the dir of the account the pin names
//
// Run: E2E_REPO=<tree under test> node --experimental-strip-types --import <tree>/scripts/.r2-register.mjs scripts/e2e-migrate-transcripts.mjs <arm>
// Exit 0 = every clause PASS; 1 = a clause FAILed; 3 = the rig could not run (a missing capability is never a PASS).

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(process.env.E2E_REPO ?? path.join(path.dirname(SELF), '..'));
const ARM = process.argv[2] ?? 'different';
const ARMS = ['slash', 'tilde_default', 'symlink', 'shared_projects', 'bindmount', 'different', 'concurrent_same', 'concurrent_diff'];
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM}`); process.exit(2); }
const IN_NS = process.env.E2E_IN_NS === '1';

const scratchRoot = path.join(process.env.E2E_HOME ?? path.join(os.tmpdir(), 'e2e-migrate-transcripts'));
const tmpHome = path.join(scratchRoot, ARM);
if (!IN_NS) { fs.rmSync(tmpHome, { recursive: true, force: true }); }
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'tmp'), { recursive: true });
const A = path.join(tmpHome, 'acctX');   // account X's config dir (the source)
const B = path.join(tmpHome, 'acctY');

if (ARM === 'bindmount' && !IN_NS) {
  // The outer process only prepares the mount points and re-executes itself inside a user+mount namespace where `acctY` IS `acctX`.
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  const r = spawnSync('unshare', ['-Urm', 'sh', '-c', 'mount --bind "$1" "$2" || exit 97; shift 2; exec "$@"', 'sh', A, B, process.execPath, ...process.execArgv, SELF, ARM], {
    stdio: 'inherit', env: { ...process.env, E2E_IN_NS: '1' },
  });
  if (r.status === 97 || r.error) { console.log(`RIG CANNOT RUN — unshare/mount --bind unavailable (${r.error?.message ?? 'mount refused'}); NOT a pass`); process.exit(3); }
  process.exit(r.status ?? 3);
}

process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.TMPDIR = path.join(tmpHome, 'tmp');
process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
for (const k of ['ORCHESTRA_WS_ID', 'ORCHESTRA_SOCK', 'CLAUDE_CONFIG_DIR']) delete process.env[k];
if (os.homedir() !== tmpHome) { console.log(`RIG BROKEN — os.homedir()=${os.homedir()} is not the scratch HOME ${tmpHome}`); process.exit(3); }

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-migrate-transcripts',
  broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e-migrate-transcripts', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const workspaces = await import(`${REPO}/src/main/workspaces.ts`);

process.on('unhandledRejection', (e) => console.log(`(unhandledRejection: ${e?.message ?? e})`));
const results = [];
const clause = (name, ok, evidence) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${evidence}`); };
const inScratch = (p) => path.resolve(p).startsWith(tmpHome + path.sep);

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────
let wsSeq = 0;
/** A scratch/orchestrator workspace (no repo needed) + N seeded transcripts under `srcCfg`. Returns what the clauses compare against. */
function mkWorkspace(srcCfg, accountId, nFiles = 8) {
  const id = `ws-mig-${++wsSeq}`;
  const worktreePath = path.join(tmpHome, 'cwd', id);
  fs.mkdirSync(worktreePath, { recursive: true });
  const mangled = workspaces.mangleProjectDir(worktreePath);
  const pd = path.join(srcCfg, 'projects', mangled);
  fs.mkdirSync(pd, { recursive: true });
  const base = new Map();
  for (let i = 0; i < nFiles; i++) {
    const name = `${crypto.randomUUID()}.jsonl`;
    fs.writeFileSync(path.join(pd, name), `{"n":${i}}\n`.repeat(200 + i * 13));
    const t = new Date(Date.UTC(2026, 0, 1 + i));
    fs.utimesSync(path.join(pd, name), t, t);
  }
  const sub = path.join(pd, crypto.randomUUID(), 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), 'nested\n'.repeat(30));
  const walk = (p, rel) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(p, e.name), r); else { const st = fs.statSync(path.join(p, e.name)); base.set(r, { sha: crypto.createHash('sha256').update(fs.readFileSync(path.join(p, e.name))).digest('hex'), mtimeMs: st.mtimeMs }); } } };
  walk(pd, '');
  return { id, worktreePath, mangled, base, walk };
}
function readSet(dir) {
  const out = new Map();
  const walk = (p, rel) => { let es; try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; } for (const e of es) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(p, e.name), r); else { const st = fs.statSync(path.join(p, e.name)); out.set(r, { sha: crypto.createHash('sha256').update(fs.readFileSync(path.join(p, e.name))).digest('hex'), mtimeMs: st.mtimeMs }); } } };
  walk(dir, '');
  return out;
}
/** null = identical; else a one-line description of the first difference (missing / extra / bytes / mtime). */
function diffSets(base, got) {
  for (const [k, v] of base) { const g = got.get(k); if (!g) return `MISSING ${k}`; if (g.sha !== v.sha) return `BYTES differ ${k}`; if (Math.abs(g.mtimeMs - v.mtimeMs) > 1) return `MTIME differs ${k}`; }
  for (const k of got.keys()) if (!base.has(k)) return `EXTRA ${k}`;
  return null;
}
async function setAccounts(list) { await store.setAccounts(list.map(([id, configDir]) => ({ id, label: id, configDir }))); }
async function putWorkspace(w, accountId) {
  await store.upsertWorkspace({
    id: w.id, name: w.id, kind: 'orchestrator', repoPath: '', branch: w.id, baseBranch: 'main', worktreePath: w.worktreePath,
    status: 'idle', createdAt: Date.now(), hasInput: false, ...(accountId ? { accountId } : {}),
  });
}
const projOf = (cfg, w) => path.join(cfg, 'projects', w.mangled);

/** One same-dir migration: the workspace (pinned to `fromAcct`, or the default login when null) migrates to account Y whose configDir names the SAME dir. */
async function sameDirArm({ label, srcCfg, fromAcct, accounts, dataCfg }) {
  for (const p of [srcCfg, dataCfg]) if (!inScratch(p)) { console.log(`RIG BROKEN — ${p} is outside the scratch prefix`); process.exit(3); }
  const w = mkWorkspace(srcCfg, fromAcct);
  await setAccounts(accounts);
  await putWorkspace(w, fromAcct);
  const res = await workspaces.dispatchMigrateAccountRequest({ id: w.id, accountId: 'Y' });
  const got = readSet(projOf(dataCfg, w));
  const d = diffSets(w.base, got);
  clause(`${label}: the migration answers ok and re-pins to Y`, res.ok === true && store.getWorkspace(w.id)?.accountId === 'Y', JSON.stringify({ ok: res.ok, error: res.error, pin: store.getWorkspace(w.id)?.accountId }));
  clause(`${label}: every transcript (${w.base.size} files incl. a nested one) is still there — bytes + mtimes intact`, d === null && got.size === w.base.size, `files=${got.size}/${w.base.size} diff=${d ?? 'none'}`);
  clause(`${label}: no warning (the same dir is recognized, not "kept")`, !res.warnings?.length, JSON.stringify(res.warnings ?? []));
}

try {
  if (ARM === 'slash') {
    fs.mkdirSync(A, { recursive: true });
    await sameDirArm({ label: 'trailing slash', srcCfg: A, fromAcct: 'X', accounts: [['X', `${A}/`], ['Y', A]], dataCfg: A });
  } else if (ARM === 'tilde_default') {
    const dflt = path.join(tmpHome, '.claude');
    fs.mkdirSync(dflt, { recursive: true });
    await sameDirArm({ label: 'default login `~/.claude` → account `~/.claude/`', srcCfg: dflt, fromAcct: null, accounts: [['Y', '~/.claude/']], dataCfg: dflt });
  } else if (ARM === 'symlink') {
    fs.mkdirSync(A, { recursive: true });
    const link = path.join(tmpHome, 'link-to-X');
    fs.symlinkSync(A, link);
    await sameDirArm({ label: 'symlink alias', srcCfg: A, fromAcct: 'X', accounts: [['X', A], ['Y', link]], dataCfg: A });
  } else if (ARM === 'shared_projects') {
    fs.mkdirSync(A, { recursive: true });
    fs.mkdirSync(B, { recursive: true });
    fs.symlinkSync(path.join(A, 'projects'), path.join(B, 'projects'));   // dangling until the first transcript is seeded
    await sameDirArm({ label: 'two config dirs sharing one `projects/`', srcCfg: A, fromAcct: 'X', accounts: [['X', A], ['Y', B]], dataCfg: A });
  } else if (ARM === 'bindmount') {
    const [sa, sb] = [fs.statSync(A, { bigint: true }), fs.statSync(B, { bigint: true })];
    if (sa.dev !== sb.dev || sa.ino !== sb.ino || A === B) { console.log(`RIG BROKEN — acctY is not a bind mount of acctX (${sa.dev}:${sa.ino} vs ${sb.dev}:${sb.ino})`); process.exit(3); }
    clause('setup: acctY IS acctX (same dev+ino through `mount --bind` in a user+mount namespace)', true, `${sa.dev}:${sa.ino}`);
    await sameDirArm({ label: 'bind mount', srcCfg: A, fromAcct: 'X', accounts: [['X', A], ['Y', B]], dataCfg: A });
  } else if (ARM === 'different') {
    fs.mkdirSync(A, { recursive: true });
    fs.mkdirSync(B, { recursive: true });
    const w = mkWorkspace(A, 'X');
    await setAccounts([['X', A], ['Y', B]]);
    await putWorkspace(w, 'X');
    const res = await workspaces.dispatchMigrateAccountRequest({ id: w.id, accountId: 'Y' });
    const got = readSet(projOf(B, w));
    const d = diffSets(w.base, got);
    clause('a different target: ok, pinned to Y', res.ok === true && store.getWorkspace(w.id)?.accountId === 'Y', JSON.stringify({ ok: res.ok, error: res.error }));
    clause('every transcript arrived at Y — bytes + mtimes intact', d === null, `files=${got.size}/${w.base.size} diff=${d ?? 'none'}`);
    clause('the source project dir is gone (the move completed)', !fs.existsSync(projOf(A, w)), `exists=${fs.existsSync(projOf(A, w))}`);
    const back = await workspaces.dispatchMigrateAccountRequest({ id: w.id, accountId: 'X' });
    const got2 = readSet(projOf(A, w));
    clause('and back again (Y → X): the history round-trips intact', back.ok === true && diffSets(w.base, got2) === null && !fs.existsSync(projOf(B, w)), `ok=${back.ok} diff=${diffSets(w.base, got2) ?? 'none'}`);
  } else if (ARM === 'concurrent_same' || ARM === 'concurrent_diff') {
    const C = path.join(tmpHome, 'acctZ');
    fs.mkdirSync(A, { recursive: true });
    fs.mkdirSync(B, { recursive: true });
    fs.mkdirSync(C, { recursive: true });
    await setAccounts([['X', A], ['Y', B], ['Z', C]]);
    const ITER = Number(process.env.E2E_ITER ?? 40), FILES = Number(process.env.E2E_FILES ?? 40);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // calibrate: how long does ONE migration of this size take? The 2nd call starts at a random instant inside that span (and a little past it).
    const cal = mkWorkspace(A, 'X', FILES);
    await putWorkspace(cal, 'X');
    const t0 = performance.now();
    await workspaces.dispatchMigrateAccountRequest({ id: cal.id, accountId: 'Y' });
    const solo = Math.max(2, performance.now() - t0);
    const TICK = 10; // the first TICK iterations start both calls in the SAME tick (a certain overlap)
    let violated = 0, bothOk = 0, refused = 0, noneOk = 0, firstBad = '', tickBad = 0, tickNote = '';
    for (let i = 0; i < ITER; i++) {
      const w = mkWorkspace(A, 'X', FILES);
      await putWorkspace(w, 'X');
      const targets = ARM === 'concurrent_same' ? ['Y', 'Y'] : ['Y', 'Z'];
      const delay = i < TICK ? 0 : Math.random() * solo * 1.2;
      const rs = await Promise.all(targets.map(async (t, k) => { if (k) await sleep(delay); return workspaces.dispatchMigrateAccountRequest({ id: w.id, accountId: t }); }));
      const okN = rs.filter((r) => r.ok).length;
      if (okN === 2) bothOk++;
      if (okN === 0) noneOk++;
      const refusedN = rs.filter((r) => !r.ok && /already in progress/.test(r.error ?? '')).length;
      refused += refusedN;
      if (i < TICK && (okN !== 1 || refusedN !== 1)) { tickBad++; tickNote ||= `iter ${i}: ok=[${rs.map((r) => r.ok)}] err=[${rs.map((r) => (r.error ?? '').slice(0, 70))}]`; }
      const pin = store.getWorkspace(w.id)?.accountId;
      const dirOf = { X: A, Y: B, Z: C };
      // the invariant: ALL transcripts live in the config dir of the account the workspace is pinned to, and nowhere else
      const atPin = readSet(projOf(dirOf[pin], w));
      const elsewhere = Object.entries(dirOf).filter(([k]) => k !== pin).flatMap(([, d]) => [...readSet(projOf(d, w)).keys()]);
      const d = diffSets(w.base, atPin);
      if (d !== null || elsewhere.length || okN === 0) { violated++; firstBad ||= `iter ${i} (2nd call +${delay.toFixed(1)}ms): ok=[${rs.map((r) => r.ok)}] pin=${pin} atPin=${atPin.size}/${w.base.size} strandedElsewhere=${elsewhere.length} diff=${d ?? 'none'} err=[${rs.map((r) => (r.error ?? '').slice(0, 60))}]`; }
    }
    clause(`${TICK} same-tick pairs: exactly ONE migration runs and the other is refused ("already in progress") — a 2nd mover never starts`, tickBad === 0, `bad=${tickBad}/${TICK}${tickNote ? ` first: ${tickNote}` : ''}`);
    clause(`${ITER} iterations of two overlapping migrations (2nd starts at a random instant of the 1st, solo=${solo.toFixed(0)}ms): ALL transcripts sit in the pinned account's dir, none stranded elsewhere, never both failed`, violated === 0, `violations=${violated}/${ITER} bothOk=${bothOk} refusedInFlight=${refused} noneOk=${noneOk}${firstBad ? ` first: ${firstBad}` : ''}`);
  }
} catch (e) {
  clause('the arm ran to completion', false, `threw: ${e?.stack ?? e}`);
}

const bad = results.filter((r) => !r.ok).length;
console.log(`\n${ARM}: ${results.length - bad}/${results.length} clauses PASS${bad ? ` — ${bad} FAIL` : ''}`);
process.exit(bad ? 1 : 0);
