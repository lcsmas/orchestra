#!/usr/bin/env node
// One-shot migration of spawned agents' names to the parent-given convention (#385, vague #380).
//
//   node --experimental-strip-types scripts/migrate-parent-names.mjs --table <table.json>           # DRY RUN (default): prints the plan, writes nothing
//   node --experimental-strip-types scripts/migrate-parent-names.mjs --table <table.json> --apply   # applies, one result line per workspace
//
// TABLE = the human-validated old → new table, a JSON array: [{ "id": "<full workspace id>", "old": "<branch it was validated against>", "new": "<rôle>-<objet>[-<ticket>]" }].
//   `old` is optional but recommended: a row whose workspace was renamed since is rejected as stale. `new` must pass naming-policy.checkSpawnName.
// INPUTS (all READ-ONLY): the app's store.json (the CLI's own path rule — ORCHESTRA_HOME/userData/orchestra/store.json, see appStoreFile), `git ls-remote --heads origin` +
//   `git for-each-ref refs/heads` of each table workspace's repo, and the RUNNING VAGUES derived from the store with the app's own liveness rule (activeVagueMemberIds:
//   a live OPS with a live member below it — nothing writes runs.closed_at, so the bus adds nothing and is never opened).
// APPLY goes ONLY through the installed app's CLI: `orchestra rename <id> <name>` with ORCHESTRA_WS_ID=<that workspace's parentId> (D2: a rename AS the parent, so the app records
//   namedByParent + formerBranch, #383/#384) — never by editing store.json. Re-run it after each vague closes: it plans exactly that vague's members; after a full apply it plans nothing.
// EXIT: 0 ok · 1 an `orchestra rename` failed · 2 refused (usage, unreadable input, git unreadable, ANY rejected table row, ORCHESTRA_SOCK set).
// SAFETY: it targets the app of $ORCHESTRA_HOME (default: the live ~/.orchestra) and refuses to run when $ORCHESTRA_SOCK is set (an agent PTY always has it) — one home for the
//   store it reads and the app it renames in. Tests and drives use a fixture store under a scratch ORCHESTRA_HOME.

import fs from 'node:fs';
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
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--table') tableFile = argv[++i] ?? '';
  else if (a === '--apply') apply = true;
  else if (a === '--dry-run') dryRun = true;
  else if (a === '-h' || a === '--help') {
    out(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  } else die(`unknown argument ${JSON.stringify(a)} — usage: --table <file> [--dry-run | --apply]`);
}
if (apply && dryRun) die('--apply and --dry-run are exclusive');
if (!tableFile) die('--table <file> is required (also for --dry-run: an empty table plans nothing). --apply never guesses a table.');
if (process.env.ORCHESTRA_SOCK) {
  die('ORCHESTRA_SOCK is set (an agent PTY, or a stray export) — this script targets the app of ORCHESTRA_HOME; unset ORCHESTRA_SOCK and set ORCHESTRA_HOME to the app you mean');
}

const { planMigration, renderPlan, activeVagueMemberIds } = await import(pathToFileURL(path.join(REPO, 'src/shared/naming-migration.ts')).href);
const { appStoreFile } = await import(pathToFileURL(path.join(REPO, 'src/cli/index.ts')).href);

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
    const ok = r && typeof r === 'object' && typeof r.id === 'string' && typeof r.new === 'string' && (r.old === undefined || typeof r.old === 'string');
    if (!ok) throw new Error(`row ${i + 1}: expected { "id": string, "old"?: string, "new": string }`);
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
// Repos of the table's live, non-scratch workspaces. A repo without an `origin` remote has nothing on origin (a positive read of `git remote`); one whose ls-remote FAILS refuses.
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
  if (!git(repo, 'remote').split('\n').includes('origin')) continue;
  for (const line of git(repo, 'ls-remote', '--heads', 'origin').split('\n')) {
    const m = /\trefs\/heads\/(.+)$/.exec(line);
    if (m) remoteBranches.add(m[1]);
  }
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const plan = planMigration({ workspaces, remoteBranches, localBranches, activeVagueMembers: activeVagueMemberIds(workspaces), table });
out(`# naming migration — ${apply ? 'APPLY' : 'DRY RUN'} — store=${storeFile} table=${tableFile}`);
out(`# ORCHESTRA_HOME=${process.env.ORCHESTRA_HOME || '(unset → the live default home)'} · ${repos.size} repo(s) read · ${remoteBranches.size} branch(es) on origin · ${workspaces.length} workspace(s)`);
for (const line of renderPlan(plan)) out(line);
if (plan.rejected.length > 0) die(`${plan.rejected.length} rejected table row(s) — fix the table; nothing applied`);
if (!apply) {
  out(`DRY-RUN  nothing written; ${plan.renames.length} rename(s) would be applied with --apply`);
  process.exit(0);
}

// ── apply: ONLY through the installed app's CLI, AS the parent ────────────────────────────────────────────────────────
let failed = 0;
for (const step of plan.renames) {
  const r = spawnSync('orchestra', ['rename', step.id, step.to], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ORCHESTRA_WS_ID: step.asParent, ORCHESTRA_WS_ID_IDENTITY: step.asParent },
  });
  const id8 = step.id.slice(0, 8);
  const final = /^Renamed to (.+)$/m.exec(r.stdout ?? '')?.[1];
  if (r.error || r.status !== 0 || !final) {
    failed++;
    out(`FAILED   ${id8}  ${step.from} -> ${step.to}  [${(r.error?.message ?? (r.stderr || r.stdout || `rc ${r.status}`)).trim().split('\n')[0]}]`);
    if (r.error?.code === 'ENOENT') {
      out("ABORTED  `orchestra` is not on PATH — nothing further attempted");
      break;
    }
    continue;
  }
  out(`APPLIED  ${id8}  ${step.from} -> ${final}${final === step.to ? '' : `  [the app changed the requested name ${step.to}]`}`);
}
out(`DONE  ${plan.renames.length - failed}/${plan.renames.length} renamed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
