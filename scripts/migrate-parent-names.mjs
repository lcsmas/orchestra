#!/usr/bin/env node
// One-shot migration of spawned agents' names to the parent-given convention (#385, vague #380).
//
//   node --experimental-strip-types scripts/migrate-parent-names.mjs --table <table.json> [--dry-run]  # DRY RUN (the default; --dry-run says so): prints the plan, writes nothing
//   node --experimental-strip-types scripts/migrate-parent-names.mjs --table <table.json> --apply   # applies, one result line per workspace
//   options: --closed <ops-id>[,<ops-id>…]  declare a finished-but-live vague over (its members stop being held) — BEFORE archiving it: archiving an OPS archives its whole subtree and the app then
//                                           refuses every rename · --allow-gone  rows of workspaces that no longer exist (GONE) or are archived (ARCHIVED) are history, not an error / a WARN ·
//                                           --assume-app-current  attest that the running app was restarted on the build this script comes from, WHEN its version cannot be read (the preflight
//                                           below; a banner that reads older is never overridden) · --live  required for --apply when ORCHESTRA_HOME is UNSET (= the LIVE ~/.orchestra); an EXPLICIT spelling of the live home, or a home carrying the live socket pointer, is refused outright (rc 2) even with --live · --verbose  list every workspace · -h/--help  this text
//   --closed takes the full OPS id (the skip-vague line prints it) or a unique prefix of 6+ characters.
//
// TABLE = the human-validated old → new table, a JSON array: [{ "id": "<full workspace id>", "old": "<branch it was validated against>", "new": "<rôle>-<objet>[-<ticket>]" }].
//   `old` is REQUIRED (it is what tells a lost former name from a never-renamed workspace when a run is repeated): a row without it refuses the run; a row whose workspace was PARENT-named differently since
//   is rejected as stale (a legacy child that renamed ITSELF is not). `new` must pass naming-policy.checkSpawnName.
// INPUTS (all READ-ONLY): the app's store.json (the CLI's own path rule — ORCHESTRA_HOME/userData/orchestra/store.json, see appStoreFile), `git ls-remote --heads` of EVERY remote +
//   `git for-each-ref refs/heads` of each table workspace's repo, and the RUNNING VAGUES derived from the store with the app's own liveness rule (activeVagueMemberIds:
//   a live OPS with a live member below it — nothing writes runs.closed_at, so the bus adds nothing and is never opened; a top-level orchestrator is a mission: its workers are not held).
// PREFLIGHT: the RUNNING app must be at least as new as this checkout (a release installed but the app not restarted renames WITHOUT pinning or recording the former name). Read-only: the startup
//   banner in <home>/logs/orchestra.log, of a live process. Older refuses (rc 2) always; unknown (the log rotates at 5 MB) or dead refuses unless --assume-app-current. The plan also skips what it cannot know: a
//   worktree whose live HEAD differs from the store (or is unreadable / not a worktree we can see), and a branch another live workspace has as its baseBranch (renaming it would dangle that workspace's Diff).
// APPLY goes ONLY through the installed app's CLI: `orchestra rename <id> <name>` with ORCHESTRA_WS_ID=<that workspace's parentId> (D2: a rename AS the parent, so the app records
//   namedByParent + formerBranch, #383/#384) — never by editing store.json. Re-run it after each vague closes: it plans exactly that vague's members; after a full apply it plans nothing.
//   After each rename the store (and the worktree's git HEAD, read-only) is re-read: the workspace must show the VALIDATED name, namedByParent (the existing namer, else the parent) and a former
//   name. The FIRST row is the canary: a rename the CLI answered "Renamed to" but the store does not show recorded ABORTS the run at that row (nothing after it is touched; rc 1; re-run after fixing
//   the cause). A CLI error alone (the git lock) is a FAILED row and the others go on — but a timeout (state UNKNOWN) or two CLI errors in a row stop the run. A pin-only re-run whose former name is unrecoverable is FORMER-LOST (rc 1), never a green APPLIED.
//   A row is stale only when the workspace was PARENT-named differently since.
// EXIT: 0 ok · 1 an `orchestra rename` failed / was not pinned / FORMER-LOST / the run ABORTED / an archived row WARN · 2 refused (usage, unreadable input, git unreadable, ANY rejected table row, ORCHESTRA_SOCK set, the live home without --live, the app preflight).
// SAFETY: it targets the app of $ORCHESTRA_HOME. The documented live run is ORCHESTRA_HOME UNSET + --live (the live app runs without ORCHESTRA_HOME: its store is the XDG one); any EXPLICIT spelling of the live
//   home — explicit, relative, symlinked, or a copy carrying the live socket pointer — is refused outright (rc 2), EVEN WITH --live. It also refuses to run when $ORCHESTRA_SOCK is set (an agent PTY always has it) —
//   one home for the store it reads and the app it renames in. Tests and drives use a fixture store under a scratch ORCHESTRA_HOME.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const out = (s) => process.stdout.write(`${s}\n`);
const die = (msg, code = 2) => {
  process.stderr.write(`migrate-parent-names: ${msg}\n`);
  process.exit(code);
};

// ── args ────────────────────────────────────────────────────────────────────────────────────────────────────────────
let tableFile = '';
let apply = false;
let dryRun = false;
let verbose = false;
let allowGone = false;
let assumeAppCurrent = false;
let liveTarget = false;
const closedIds = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--table') tableFile = argv[++i] ?? '';
  else if (a === '--apply') apply = true;
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--verbose') verbose = true;
  else if (a === '--allow-gone') allowGone = true;
  else if (a === '--assume-app-current') assumeAppCurrent = true;
  else if (a === '--live') liveTarget = true;
  else if (a === '--closed') closedIds.push(...(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  else if (a === '-h' || a === '--help') {
    const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1); // after the shebang: the leading `//` block ONLY
    out(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  } else die(`unknown argument ${JSON.stringify(a)} — usage: --table <file> [--dry-run | --apply] [--closed <ops-id>,…] [--allow-gone] [--assume-app-current] [--live] [--verbose]`);
}
if (apply && dryRun) die('--apply and --dry-run are exclusive');
if (!tableFile) die('--table <file> is required (also for --dry-run: an empty table plans nothing). --apply never guesses a table.');
if (process.env.ORCHESTRA_SOCK) {
  die('ORCHESTRA_SOCK is set (an agent PTY, or a stray export) — this script targets the app of ORCHESTRA_HOME; unset ORCHESTRA_SOCK and set ORCHESTRA_HOME to the app you mean');
}

const realPath = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
// The LIVE home (~/.orchestra) is the live fleet, however it is spelled — the gate keys on the RESOLVED path (and on the socket pointer a copied home may carry). Reads are fine; --apply needs the explicit word.
// But the live packaged app runs WITHOUT ORCHESTRA_HOME: its store is the XDG one, not <home>/userData — so an EXPLICIT spelling of the live home (or a home whose socket pointer is the live app's)
// would plan from one store and rename in another app: refused outright, --live or not. Unset ORCHESTRA_HOME is the only way to act on the live app.
const homeUnset = !process.env.ORCHESTRA_HOME;
const home = process.env.ORCHESTRA_HOME || path.join(os.homedir(), '.orchestra');
const liveHome = realPath(path.join(os.homedir(), '.orchestra'));
const pointerOf = (h) => { try { return fs.readFileSync(path.join(h, 'sock'), 'utf8').trim(); } catch { return ''; } };
const dirIsLive = realPath(home) === liveHome;
const pointerIsLive = !dirIsLive && pointerOf(home) !== '' && pointerOf(home) === pointerOf(liveHome);
const isLiveHome = dirIsLive || pointerIsLive;
if (!homeUnset && isLiveHome) {
  die(`ORCHESTRA_HOME=${process.env.ORCHESTRA_HOME} ${pointerIsLive ? "carries the LIVE app's socket pointer" : 'is the live default home spelled explicitly'}: the live app runs WITHOUT ORCHESTRA_HOME, so its store is NOT under this home (it is the XDG one) and this script would plan from one store and rename in the live app. Unset ORCHESTRA_HOME (and pass --live with --apply) to act on the live app, or point it at a scratch home.`);
}
if (apply && isLiveHome && !liveTarget) {
  die(`ORCHESTRA_HOME is unset: --apply would act on the LIVE default app (home ${home}, socket pointer ${path.join(home, 'sock')}; its store is the XDG one). Set ORCHESTRA_HOME to a scratch home, or pass --live to confirm that the live fleet is the target.`);
}

const { planMigration, renderPlan, activeVagueMemberIds, vagueHolders } = await import(pathToFileURL(path.join(REPO, 'src/shared/naming-migration.ts')).href);
const { appStoreFile } = await import(pathToFileURL(path.join(REPO, 'src/cli/index.ts')).href);
const { isScratchLike } = await import(pathToFileURL(path.join(REPO, 'src/shared/types.ts')).href);

// ── read the inputs (fail closed: an unreadable input is a refusal, never an empty set) ──────────────────────────────
const storeFile = appStoreFile(process.env);
let workspaces;
try {
  const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  if (!Array.isArray(parsed.workspaces)) throw new Error('no "workspaces" array');
  workspaces = parsed.workspaces.filter((w) => w && typeof w.id === 'string' && typeof w.branch === 'string');
} catch (e) {
  die(`cannot read the store ${storeFile}: ${e.message}`);
}
let table;
try {
  table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
  if (!Array.isArray(table)) throw new Error('the table must be a JSON array');
  table.forEach((r, i) => {
    const ok = r && typeof r === 'object' && typeof r.id === 'string' && typeof r.new === 'string' && typeof r.old === 'string' && r.old !== '';
    if (!ok) throw new Error(`row ${i + 1}: expected { "id": string, "old": string, "new": string } — "old" is REQUIRED: it is what tells a lost former name from a never-renamed workspace when a run is repeated`);
  });
} catch (e) {
  die(`cannot read the table ${tableFile}: ${e.message}`);
}

const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error || r.status !== 0) die(`git ${args.join(' ')} failed in ${repo}: ${(r.error?.message ?? r.stderr ?? '').trim()}`);
  return r.stdout;
};
// Repos of the table's live, non-scratch workspaces. A remote whose ls-remote FAILS refuses (an unreadable remote is UNKNOWN, never "nothing pushed").
const byId = new Map(workspaces.map((w) => [w.id, w]));
const repos = new Set();
for (const r of table) {
  const w = byId.get(r.id);
  if (w && !w.archived && typeof w.repoPath === 'string' && w.repoPath) repos.add(w.repoPath);
}
const remoteBranches = new Set();
const localBranches = new Set();
for (const repo of repos) {
  for (const b of git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')) if (b) localBranches.add(b);
  // EVERY remote (a repo whose remote is not called `origin` must not read as "nothing pushed"); a repo with no remote at all has nothing on a remote.
  for (const remote of git(repo, 'remote').split('\n').filter(Boolean)) {
    for (const line of git(repo, 'ls-remote', '--heads', remote).split('\n')) {
      const m = /\trefs\/heads\/(.+)$/.exec(line);
      if (m) remoteBranches.add(m[1]);
    }
  }
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The worktree's REAL branch (read-only; the app renames THIS one, not the store's `branch`). undefined = no git branch to read; null = UNKNOWN (unreadable / not a worktree we can see).
const gitHead = (w) => {
  if (isScratchLike(w) || !w.worktreePath) return undefined; // no git branch to read (a git workspace record always carries its worktreePath)
  if (w.host?.kind === 'sandbox' || !fs.existsSync(path.join(w.worktreePath, '.git'))) return null; // a worktree we cannot see: UNKNOWN (a plain directory inside another repo would send `git branch -m` to the WRONG repo)
  const r = spawnSync('git', ['-C', w.worktreePath, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return r.status === 0 ? r.stdout.trim() : null;
};
const liveHeads = new Map();
for (const r of table) {
  const w = byId.get(r.id);
  if (!w || w.archived) continue;
  const h = gitHead(w);
  if (h !== undefined) liveHeads.set(w.id, h);
}

// --closed takes the FULL id (the skip-vague hint prints it) or a UNIQUE prefix of at least 6 characters; ambiguity lists the candidates.
const resolveClosed = (arg) => {
  if (byId.has(arg)) return arg;
  if (arg.length < 6) die(`--closed ${arg}: no workspace with this id, and too short to be an id prefix (6 characters minimum)`);
  const matches = workspaces.filter((w) => w.id.startsWith(arg));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) die(`--closed ${arg}: no workspace with this id (or id prefix) in the store (a typo would leave its vague protected while you believe it is released)`);
  die(`--closed ${arg}: ambiguous — ${matches.length} workspaces start with it, give more characters:\n${matches.map((w) => `  ${w.id}  ${w.branch}`).join('\n')}`);
};
const closed = closedIds.map(resolveClosed);
const plannerWorkspaces = workspaces.map((w) => (typeof w.repoPath === 'string' && w.repoPath ? { ...w, repoPath: realPath(w.repoPath) } : w)); // the same repo under two spellings is ONE repo
const runningAnchors = new Set([...vagueHolders(workspaces).values()].flat());
const holders = vagueHolders(workspaces, new Set(closed));
const plan = planMigration({ workspaces: plannerWorkspaces, remoteBranches, localBranches, activeVagueMembers: new Set(holders.keys()), vagueHolders: holders, table, liveHeads });
out(`# naming migration — ${apply ? 'APPLY' : 'DRY RUN'} — store=${storeFile} table=${tableFile}`);
const pointerFile = path.join(home, 'sock');
let pointerTarget = '(missing)';
try { pointerTarget = fs.readFileSync(pointerFile, 'utf8').trim() || '(empty)'; } catch { /* not running, or another home */ }
out(`# acting on: ${isLiveHome ? `the LIVE default home ${home} (${homeUnset ? 'ORCHESTRA_HOME unset' : `ORCHESTRA_HOME=${process.env.ORCHESTRA_HOME}`})` : `ORCHESTRA_HOME=${home}`} · store=${storeFile} · socket pointer ${pointerFile} -> ${pointerTarget}`);
out(`# ORCHESTRA_HOME=${process.env.ORCHESTRA_HOME || '(unset → the live default home)'} · ${repos.size} repo(s) read · ${remoteBranches.size} branch(es) on a remote · ${workspaces.length} workspace(s)${closed.length ? ` · closed vague(s) declared: ${closed.map((x) => x.slice(0, 8)).join(',')}` : ''}`);
for (const line of renderPlan(plan, { verbose, allowGone })) out(line);
// A --closed that names no running vague's OPS (a member, an archived workspace, a vague already over) releases nothing — it can only HOLD more, so it is a NOTE, not an error.
for (const id of closed) if (!runningAnchors.has(id)) out(`NOTE  --closed ${id.slice(0, 8)} is not the OPS of a running vague (a member, an archived workspace, or a vague already over): it releases nothing`);
const blocking = plan.rejected.filter((x) => !(allowGone && x.code === 'unknown-workspace'));
if (blocking.length > 0) die(`${blocking.length} rejected table row(s) — fix the table; nothing applied`);
// A table row of an ARCHIVED workspace can never apply (the app refuses to rename it; archiving an OPS archives its whole subtree). Say so — and in --apply it is not a green run
// (`--allow-gone` = "I know, those rows are history").
const archivedRows = plan.rows.filter((r) => r.action === 'untouched-archived');
for (const r of archivedRows) out(`${allowGone ? 'ARCHIVED' : 'WARN'}  ${r.id.slice(0, 8)}  ${r.branch}  [its table row can never apply: the app refuses to rename an archived workspace — remove the row, or --allow-gone]`);
const warnings = allowGone ? 0 : archivedRows.length;

// PREFLIGHT: the RUNNING app must be at least as new as the checkout this script comes from (a release installed but the app not restarted renames WITHOUT pinning or recording the
// former name). Read-only: the app's startup banner in <home>/logs (the log rotates at 5 MB: an unreadable banner is UNKNOWN, and UNKNOWN refuses like OLDER does) — the human
// who restarted the app after installing says so with --assume-app-current.
const parseVersion = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v); return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : null; };
// older = strictly older by number; at equal numbers a suffixed build (-rc.1, +build7) is older than the plain one. (Both operands come out of a \d+.\d+.\d+ match — the banner regex, package.json — so parsing cannot fail.)
const olderThan = (a, b) => {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i];
  return x.pre !== '' && y.pre === '';
};
const aliveProcess = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readRunningApp = () => {
  for (const f of [path.join(home, 'logs', 'orchestra.log'), path.join(home, 'logs', 'orchestra.log.1')]) {
    let text;
    try {
      const size = fs.statSync(f).size;
      const len = Math.min(size, 16 * 1024 * 1024); // the log rotates at 5 MB: the whole file, so a banner is never cut off
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    // the LAST banner of an instance running on THIS home (another home's instance sharing the log dir is not the app we will talk to)
    const mine = [...text.matchAll(/=== Orchestra (\d+\.\d+\.\d+\S*) \([^)]*\) starting === pid=(\d+)[^\n]*?home=([^\n]+)/g)].filter((m) => realPath(m[3].trim()) === realPath(home));
    if (mine.length > 0) return { version: mine[mine.length - 1][1], pid: Number(mine[mine.length - 1][2]) };
  }
  return null;
};
const checkoutVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const running = readRunningApp();
let appVerdict;
if (!running) appVerdict = { ok: false, kind: 'unknown', text: 'the running app\'s version is UNKNOWN (no startup banner in its log — it rotates at 5 MB)' };
else if (!aliveProcess(running.pid)) appVerdict = { ok: false, kind: 'unknown', text: `the last startup banner (v${running.version}, pid ${running.pid}) is of a process that is no longer running — the version of the app that answers is UNKNOWN` };
else if (olderThan(running.version, checkoutVersion)) appVerdict = { ok: false, kind: 'older', text: `the running app is v${running.version} (pid ${running.pid}) but this checkout is v${checkoutVersion}: it predates the rename pin / former name — restart Orchestra on the new build` };
else appVerdict = { ok: true, kind: 'ok', text: `running app v${running.version} (pid ${running.pid}) >= checkout v${checkoutVersion}` };
// --assume-app-current attests a restart where the version CANNOT be read (rotated log, no banner, dead pid); it never overrides a banner that READS older.
const refused = !appVerdict.ok && (appVerdict.kind === 'older' || !assumeAppCurrent);
out(`# app: ${appVerdict.text}${appVerdict.ok ? '' : appVerdict.kind === 'older' ? (assumeAppCurrent ? ' — --assume-app-current does NOT override a version that reads older' : '') : assumeAppCurrent ? ' — OVERRIDDEN by --assume-app-current' : ''}`);
if (refused && apply) die(`${appVerdict.text}. ${appVerdict.kind === 'older' ? 'Restart the app on the build this script comes from and re-run (--assume-app-current does not override a version that reads older)' : 'Restart the app on the build this script comes from and re-run, or pass --assume-app-current to attest that you did'}. Nothing applied.`);

if (!apply) {
  out(`DRY-RUN  nothing written; ${plan.renames.length} rename(s) would be applied with --apply${warnings ? `; ${warnings} WARN` : ''}${refused ? '; the app preflight above would REFUSE --apply' : ''}`);
  process.exit(0);
}

// What the app must have recorded for a parent-given name — read back from the store AND git, never assumed from rc 0 or from the CLI's own "Renamed to": the VALIDATED name
// (not a suffixed one, not the child's own rename that raced ours), the namer (#383: the EXISTING namer is kept, else the parent we acted as), a former name (#384: whatever the
// app saw before our rename — a child's own rename can land in between, so only "some former name other than the target"), and the worktree's real branch (read-only: a record
// that shows the target while git HEAD holds another name would be adopted back by the app's reconciler, as a human pin).
const readBack = (step) => {
  try {
    const w = JSON.parse(fs.readFileSync(storeFile, 'utf8')).workspaces.find((x) => x.id === step.id);
    const head = w ? gitHead(w) : undefined;
    const ok = !!w && w.branch === step.to && w.namedByParent === step.expectNamer && (step.to === step.from || (!!w.formerBranch && w.formerBranch !== step.to)) && (head === undefined || head === step.to);
    return { ok, saw: w ? `branch=${w.branch} namedByParent=${w.namedByParent ?? '∅'} formerBranch=${w.formerBranch ?? '∅'}${head === undefined ? '' : ` git HEAD=${head ?? '<unreadable>'}`}` : 'workspace not in the store' };
  } catch (e) {
    return { ok: false, saw: `store unreadable: ${e.message}` };
  }
};
const expected = (step) => `expected branch=${step.to} namedByParent=${step.expectNamer}${step.to === step.from ? '' : ' formerBranch=<the name it had>'} and the worktree on ${step.to}`;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ── apply: ONLY through the installed app's CLI, AS the parent ────────────────────────────────────────────────────────
// This runs ONCE on the live fleet, so every anomaly stops it on the safe side. The FIRST row is the canary: a rename the CLI answered "Renamed to" but whose store row does not show
// it recorded (an app that cannot pin, a child that won the race, a suffixed name, git behind the record) ABORTS the run at that row — nothing after it is touched; the run is idempotent,
// fix the cause and re-run. A CLI error alone (the git lock) is a FAILED row and the others go on. A pin-only step whose former name is unrecoverable is FORMER-LOST (rc 1), never a green APPLIED.
let failed = 0;
let aborted = false;
let formerLost = 0;
let attempted = 0;
let consecutiveCliErrors = 0;
const renameTimeoutMs = Number(process.env.MIGRATE_RENAME_TIMEOUT_MS) || 60_000; // (an env knob only so a test need not wait a minute)
const applied = [];
for (const step of plan.renames) {
  attempted++;
  const r = spawnSync('orchestra', ['rename', step.id, step.to], {
    encoding: 'utf8',
    timeout: renameTimeoutMs,
    env: { ...process.env, ORCHESTRA_WS_ID: step.asParent, ORCHESTRA_WS_ID_IDENTITY: step.asParent },
  });
  const id8 = step.id.slice(0, 8);
  const final = /^Renamed to (.+)$/m.exec(r.stdout ?? '')?.[1];
  if (r.error || r.status !== 0 || !final) {
    failed++;
    out(`FAILED   ${id8}  ${step.from} -> ${step.to}  [${(r.error?.message ?? (r.stderr || r.stdout || `rc ${r.status}`)).trim().split('\n')[0]}]`);
    if (r.error?.code === 'ENOENT') {
      out("ABORTED  `orchestra` is not on PATH — nothing further attempted");
      aborted = true;
      break;
    }
    // A timeout leaves the row's state UNKNOWN (git may have moved, the store not yet); two CLI errors in a row mean the app keeps failing: either way stop, the run is idempotent.
    consecutiveCliErrors++;
    if (r.error?.code === 'ETIMEDOUT' || consecutiveCliErrors >= 2) {
      out(`ABORTED  at ${id8}: ${r.error?.code === 'ETIMEDOUT' ? `the app did not answer within ${renameTimeoutMs} ms — the row's state is UNKNOWN` : 'two rename errors in a row — the app keeps failing'}; ${plan.renames.length - attempted} row(s) NOT attempted. Look at the app, then re-run: the run is idempotent.`);
      aborted = true;
      break;
    }
    continue;
  }
  consecutiveCliErrors = 0;
  let seen = readBack(step);
  for (let i = 0; i < 12 && !seen.ok; i++) {
    sleepSync(250); // the app awaits its store write before it answers; the poll only absorbs a slow disk
    seen = readBack(step);
  }
  if (!seen.ok) {
    failed++;
    out(`FAILED   ${id8}  ${step.from} -> ${step.to}  [renamed (the CLI said "${final}") but the store does NOT show a parent-named ${step.to}: ${seen.saw}; ${expected(step)} — a rename by the workspace itself racing ours, an app older than #383/#384, or the app suffixing the name]`);
    out(`ABORTED  at ${id8}: the app answered "Renamed to" but did not record the rename as asked — stopping at the first such row (the canary); ${plan.renames.length - attempted} row(s) NOT attempted. Fix the cause (restart the app on the new build?) and re-run: the run is idempotent.`);
    aborted = true;
    break;
  }
  if (step.formerLost) {
    failed++;
    formerLost++;
    out(`FORMER-LOST  ${id8}  ${step.formerLost} -> ${step.to}  [the pin is recorded, but the former name "${step.formerLost}" is not and cannot be: an earlier run renamed it without the app recording one — note it by hand]`);
    continue;
  }
  applied.push(step);
  out(`APPLIED  ${id8}  ${step.from} -> ${step.to}`);
}
// A racing rename by the child can land AFTER our read-back: look once more, after the dust settles, at everything reported APPLIED.
let lost = 0;
if (applied.length > 0) {
  sleepSync(1500);
  for (const step of applied) {
    const seen = readBack(step);
    if (!seen.ok) {
      lost++;
      failed++;
      out(`FAILED   ${step.id.slice(0, 8)}  ${step.from} -> ${step.to}  [LOST after the APPLIED line: ${seen.saw}; ${expected(step)} — re-run to plan it again]`);
    }
  }
}
const notAttempted = plan.renames.length - attempted;
const skipped = plan.rows.filter((r) => r.action.startsWith('skip-')).length;
out(`DONE  ${applied.length - lost}/${plan.renames.length} renamed${failed ? `, ${failed} FAILED` : ''}${formerLost ? ` (${formerLost} FORMER-LOST)` : ''}${notAttempted ? `, ${notAttempted} not attempted` : ''}${skipped ? `, ${skipped} skipped (see PLAN)` : ''}${warnings ? `, ${warnings} WARN` : ''}${aborted ? ' — ABORTED' : ''}`);
process.exit(failed || warnings ? 1 : 0);
