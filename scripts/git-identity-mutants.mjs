#!/usr/bin/env node
// #513 self-gate — IN-PLACE mutation sweep of "a spawned worktree carries the owner's git identity". Each mutant breaks ONE clause in the real source and
// must turn src/main/git-identity.test.ts red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree. CONTROL first: the unit file
// must be GREEN unmutated (skipped 0).  Run: node scripts/git-identity-mutants.mjs [--only M01,M07] [--check-anchors]   (pnpm run test:git-identity-mutants)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const GI = 'src/main/git-identity.ts', GIT = 'src/main/git.ts', WS = 'src/main/workspaces.ts', SDK = 'src/main/agent-sdk.ts';
const TEST = 'src/main/git-identity.test.ts';
const F = 'false as boolean';

/** One mutant = exact-once edits [file, find, replacement]. Every mutant must turn TEST red. */
const MUTANTS = [
  // ── each spawn path that could skip the pin ──
  { id: 'M01', name: 'createWorktree (spawn / top-level / adopt-repo / eject chokepoint) no longer pins', edits: [[GIT, '  await ensureWorktreeGitIdentity(repoPath, worktreePath);\n', '']] },
  { id: 'M02', name: 'createWorktree pins BEFORE the worktree exists', edits: [[GIT, "  await git.raw(['worktree', 'add', worktreePath, branch]);\n  // #513: the ONE worktree-creation chokepoint (createWorkspace, adopt-repo, sandbox eject) — never throws.\n  await ensureWorktreeGitIdentity(repoPath, worktreePath);\n", "  // #513: the ONE worktree-creation chokepoint (createWorkspace, adopt-repo, sandbox eject) — never throws.\n  await ensureWorktreeGitIdentity(repoPath, worktreePath);\n  await git.raw(['worktree', 'add', worktreePath, branch]);\n"]] },
  { id: 'M03', name: 'createWorktree pins with the worktree as its own repo', edits: [[GIT, 'await ensureWorktreeGitIdentity(repoPath, worktreePath);', 'await ensureWorktreeGitIdentity(worktreePath, worktreePath);']] },
  { id: 'M04', name: 'unarchive (restore) no longer pins', edits: [[WS, '    await ensureWorkspaceGitIdentity(updated); // #513: a worktree archived before the pin (or edited meanwhile) gets it on restore; never throws\n', '']] },
  { id: 'M05', name: 'attach no longer pins', edits: [[WS, '  await ensureWorkspaceGitIdentity(updated); // #513: idempotent — a member attached after the fact carries the owner\'s identity too; never throws\n', '']] },
  { id: 'M06', name: 'a session start (spawn / restart / wake) no longer pins', edits: [[SDK, '    await ensureWorkspaceGitIdentity(ws); // #513: every session start (spawn, restart, wake, restore) — idempotent, never throws\n', '']] },
  { id: 'M07', name: 'a session start pins BEFORE the hook install (order pinned)', edits: [[SDK, "    await installOrchestraHooks(ws.worktreePath).catch((err) =>\n      log.warn(`agent-sdk: hook install failed for ${wsId}`, err),\n    );\n    await ensureWorkspaceGitIdentity(ws); // #513: every session start (spawn, restart, wake, restore) — idempotent, never throws\n", "    await ensureWorkspaceGitIdentity(ws); // #513: every session start (spawn, restart, wake, restore) — idempotent, never throws\n    await installOrchestraHooks(ws.worktreePath).catch((err) =>\n      log.warn(`agent-sdk: hook install failed for ${wsId}`, err),\n    );\n"]] },
  { id: 'M08', name: 'adopt-repo creates its worktree with raw git instead of the chokepoint', edits: [[WS, 'await createWorktree(repoPath, branch, baseBranch, newWorktreePath);', "await git.raw(['worktree', 'add', newWorktreePath, branch]);"]] },
  // ── the clauses of the pin itself ──
  { id: 'M09', name: 'an explicit worktree identity is overwritten', edits: [[GI, "(await getConfig(worktreePath, ['--worktree', '--get-regexp', `^${group}\\\\.(name|email)$`])) !== null) keptGroups.add(group);", `${F}) keptGroups.add(group);`]] },
  { id: 'M25', name: 'the keep check is per key again (an explicit email gets the owner\'s name beside it)', edits: [[GI, "const group = key.split('.')[0];\n      if (!keptGroups.has(group)", "const group = key;\n      if (!keptGroups.has(group)"]] },
  { id: 'M10', name: 'the identity is read at the worktree path (an includeIf onbranch on the repo no longer matches)', edits: [[GI, "const v = await getConfig(repoPath, ['--get', key]);", "const v = await getConfig(worktreePath, ['--get', key]);"]] },
  { id: 'M11', name: 'the identity is hardcoded', edits: [[GI, 'if (v !== null) wanted.push([key, v]);', "if (v !== null) wanted.push([key, key.endsWith('name') ? 'Hardcoded' : 'hard@coded']);"]] },
  { id: 'M12', name: 'a host with no identity still enables the extension / writes', edits: [[GI, "if (!wanted.some(([k]) => k === 'user.name') || !wanted.some(([k]) => k === 'user.email')) return { ...result, skipped: 'no-identity' };\n", '']] },
  { id: 'M13', name: 'name-without-email counts as an identity', edits: [[GI, "if (!wanted.some(([k]) => k === 'user.name') || !wanted.some(([k]) => k === 'user.email')) return", "if (!wanted.some(([k]) => k === 'user.name')) return"]] },
  { id: 'M14', name: 'the committer overrides are not copied (a split committer collapses)', edits: [[GI, "'author.name', 'author.email', 'committer.name', 'committer.email'] as const;", "'author.name', 'author.email'] as const;"]] },
  { id: 'M15', name: 'the author overrides are not copied', edits: [[GI, "'user.email', 'author.name', 'author.email', 'committer.name',", "'user.email', 'committer.name',"]] },
  { id: 'M16', name: 'the identity is written to the SHARED repo config, not the worktree\'s own', edits: [[GI, "['-C', worktreePath, 'config', '--worktree', key, value]", "['-C', worktreePath, 'config', key, value]"]] },
  { id: 'M17', name: 'the worktree-config extension is never enabled', edits: [[GI, "'config', 'extensions.worktreeConfig', 'true'], { env: gitEnv() });", "'config', 'extensions.noop513', 'true'], { env: gitEnv() });"]] },
  { id: 'M18', name: 'a bare repo is not refused', edits: [[GI, "if ((await getConfig(repoPath, ['--bool', '--get', 'core.bare'])) === 'true') return false;\n", '']] },
  { id: 'M19', name: 'the main worktree itself can be pinned', edits: [[GI, 'if (path.resolve(realpathSync(repoPath)) === path.resolve(realpathSync(worktreePath))) return { ...result, skipped: \'not-a-worktree\' };\n', '']] },
  { id: 'M20', name: 'a failure is raised instead of reported (a spawn would fail on its identity)', edits: [[GI, "    glog.warn(`could not pin the git identity in ${worktreePath}: ${msg}`);\n    return { ...result, skipped: 'error', error: msg };", "    glog.warn(`could not pin the git identity in ${worktreePath}: ${msg}`);\n    throw e;"]] },
  { id: 'M21', name: 'a scratch workspace is pinned (it has no git)', edits: [[GI, 'if (isScratchLike(ws) || !ws.repoPath || ws.host?.kind === \'sandbox\') return null;', "if (!ws.repoPath || ws.host?.kind === 'sandbox') return null;"]] },
  { id: 'M22', name: 'a sandbox workspace is pinned (its checkout is in the container)', edits: [[GI, "if (isScratchLike(ws) || !ws.repoPath || ws.host?.kind === 'sandbox') return null;", 'if (isScratchLike(ws) || !ws.repoPath) return null;']] },
  { id: 'M23', name: 'a second call is not idempotent (rewrites every key)', edits: [[GI, 'if (keptGroups.has(key.split(\'.\')[0])) {\n        result.kept.push(key);\n        continue;\n      }', '']] },
  { id: 'M24', name: 'a config.lock held by another process fails the spawn (no retry)', edits: [[GI, 'for (let attempt = 0; attempt < 5; attempt++) {', 'for (let attempt = 0; attempt < 1; attempt++) {']] },
];
for (const m of MUTANTS) m.tests = [TEST];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const count = (src, s) => src.split(s).length - 1;
function anchorsOk() {
  let bad = 0, total = 0;
  for (const m of MUTANTS) for (const [f, find] of m.edits) {
    total++;
    const n = count(fs.readFileSync(path.join(REPO, f), 'utf8'), find);
    if (n !== 1) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${f} matches ${n}× (need exactly 1): ${JSON.stringify(find.slice(0, 80))}`); }
  }
  console.log(`ANCHORS: ${total - bad}/${total} resolve exactly once`);
  return bad === 0;
}
if (args.includes('--check-anchors')) process.exit(anchorsOk() ? 0 : 1);
if (!anchorsOk()) process.exit(2);
const touched = [...new Set(MUTANTS.flatMap((m) => m.edits.map(([f]) => f)))];
if (spawnSync('git', ['-C', REPO, 'diff', '--quiet', '--', ...touched]).status !== 0) { console.error('ABORT: a file a mutant edits has uncommitted changes — commit first (the restore proof is `git diff` empty)'); process.exit(2); }

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'gitid513-mutants-'));
const unit = (files) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: REPO, encoding: 'utf8', timeout: 600000 });
const failedNames = (out) => [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);

{
  const u = unit([TEST]); const red = failedNames(u.stdout);
  const skipped = /^# skipped (\d+)/m.exec(u.stdout)?.[1];
  console.log(`CONTROL unmutated unit file: ${u.status === 0 && red.length === 0 && skipped === '0' ? 'GREEN, skipped 0 (instrument can pass)' : `RED ${JSON.stringify(red)} skipped=${skipped} — INSTRUMENT BROKEN`}`);
  if (u.status !== 0 || skipped !== '0') process.exit(4);
}

const results = [];
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const files = [...new Set(m.edits.map(([f]) => f))];
  const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
  files.forEach((f, i) => fs.copyFileSync(path.join(REPO, f), path.join(BACKUP, `${m.id}-${i}.bak`)));
  const killedBy = [];
  let restored = false;
  try {
    for (const [f, find, to] of m.edits) {
      const p = path.join(REPO, f);
      const src = fs.readFileSync(p, 'utf8');
      if (count(src, find) !== 1) throw new Error(`PATTERN-GONE ${m.id} ${f}`);
      fs.writeFileSync(p, src.replace(find, () => to));
    }
    const u = unit(m.tests);
    const red = failedNames(u.stdout);
    if (u.status !== 0 || red.length) killedBy.push(`unit: ${red.length ? red.map((n) => n.replace(/^\\?#513 /, '').slice(0, 60)).join(' | ') : `rc=${u.status}`}`);
  } finally {
    files.forEach((f, i) => fs.copyFileSync(path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)));
    restored = files.every((f, i) => sha(f) === before[f] && spawnSync('cmp', ['-s', path.join(BACKUP, `${m.id}-${i}.bak`), path.join(REPO, f)]).status === 0);
  }
  results.push({ id: m.id, name: m.name, killed: killedBy.length > 0, killedBy, restored });
  console.log(`${killedBy.length ? 'KILLED ' : 'SURVIVED'} ${m.id} ${m.name}${killedBy.length ? `\n         ← ${killedBy.join('\n         ← ')}` : ''}${restored ? '' : '\n         !! RESTORE FAILED'}`);
}
const survivors = results.filter((r) => !r.killed);
const unrestored = results.filter((r) => !r.restored);
const diff = spawnSync('git', ['-C', REPO, 'diff', '--stat', '--', ...touched], { encoding: 'utf8' }).stdout.trim();
console.log(`\nMUTANTS: ${results.length - survivors.length}/${results.length} killed; survivors: ${survivors.map((s) => s.id).join(', ') || 'none'}; restore: ${unrestored.length ? 'FAILED ' + unrestored.map((s) => s.id).join(',') : 'all byte-exact'}; git diff on touched files: ${diff || 'empty'}`);
process.exit(survivors.length === 0 && unrestored.length === 0 && !diff ? 0 : 1);
