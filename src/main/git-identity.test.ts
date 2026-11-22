import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorktree } from './git.ts';
import { ensureWorktreeGitIdentity, ensureWorkspaceGitIdentity } from './git-identity.ts';

// #513 — a spawned worktree carries the human owner's author AND committer identity in its OWN config.
// Real git on scratch repos; the "host" identity is a scratch GIT_CONFIG_GLOBAL (never the real ~/.gitconfig).

const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'orch-gitid513-'));
const GLOBAL = path.join(ROOT, 'global.gitconfig');
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM, a: process.env.GIT_AUTHOR_NAME };
const OWNER = { name: 'Owner Human', email: 'owner@example.test' };

before(() => {
  process.env.GIT_CONFIG_GLOBAL = GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k];
});
after(() => {
  if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
  if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.s;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env: Record<string, string | undefined> = {}): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}
function tryGit(cwd: string, args: string[], env: Record<string, string | undefined> = {}): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(cwd, args, env) };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) };
  }
}
function writeGlobal(body: string): void {
  fs.writeFileSync(GLOBAL, body);
}
const ownerGlobal = `[user]\n\tname = ${OWNER.name}\n\temail = ${OWNER.email}\n`;
let n = 0;
function mkRepo(): string {
  const dir = path.join(ROOT, `repo${++n}`);
  fs.mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  // the base commit carries a fixed fixture identity so it works whatever the scratch host config says
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'base'], { GIT_AUTHOR_NAME: 'fx', GIT_AUTHOR_EMAIL: 'fx@fx', GIT_COMMITTER_NAME: 'fx', GIT_COMMITTER_EMAIL: 'fx@fx' });
  return dir;
}
const wtPath = (name: string) => path.join(ROOT, `wt-${name}-${++n}`);
/** What a commit made in `wt` would record, with the HOME-level identity REMOVED (the scratch-HOME condition the ticket is about). */
function identityUnderScratchHome(wt: string): { author: string; committer: string } {
  const scratch = { GIT_CONFIG_GLOBAL: '/dev/null', HOME: path.join(ROOT, 'no-home') };
  return {
    author: git(wt, ['var', 'GIT_AUTHOR_IDENT'], scratch).replace(/ \d+ [+-]\d{4}$/, ''),
    committer: git(wt, ['var', 'GIT_COMMITTER_IDENT'], scratch).replace(/ \d+ [+-]\d{4}$/, ''),
  };
}
const expected = `${OWNER.name} <${OWNER.email}>`;

test('#513 must-PASS: createWorktree pins author AND committer, readable with the host identity gone', async () => {
  writeGlobal(ownerGlobal);
  const repo = mkRepo();
  const wt = wtPath('a');
  await createWorktree(repo, 'agent-a', 'main', wt);
  assert.equal(git(wt, ['config', '--worktree', '--get', 'user.name']), OWNER.name);
  assert.equal(git(wt, ['config', '--worktree', '--get', 'user.email']), OWNER.email);
  const { author, committer } = identityUnderScratchHome(wt);
  assert.equal(author, expected);
  assert.equal(committer, expected);
  // …and a real commit under the same condition succeeds with that identity on both sides.
  fs.writeFileSync(path.join(wt, 'f.txt'), 'x\n');
  git(wt, ['add', 'f.txt'], { GIT_CONFIG_GLOBAL: '/dev/null', HOME: path.join(ROOT, 'no-home') });
  git(wt, ['commit', '-qm', 'c'], { GIT_CONFIG_GLOBAL: '/dev/null', HOME: path.join(ROOT, 'no-home') });
  assert.equal(git(wt, ['log', '-1', '--format=%an <%ae>|%cn <%ce>']), `${expected}|${expected}`);
});

test('#513 must-FAIL (unfixed arm, same rig): a worktree made by bare `git worktree add` cannot commit under a scratch HOME', () => {
  writeGlobal(ownerGlobal);
  const repo = mkRepo();
  const wt = wtPath('bare');
  git(repo, ['worktree', 'add', '-q', '-b', 'agent-bare', wt, 'main']);
  const scratch = { GIT_CONFIG_GLOBAL: '/dev/null', HOME: path.join(ROOT, 'no-home') };
  fs.writeFileSync(path.join(wt, 'f.txt'), 'x\n');
  git(wt, ['add', 'f.txt'], scratch);
  const r = tryGit(wt, ['-c', 'user.useConfigOnly=true', 'commit', '-qm', 'c'], scratch);
  assert.equal(r.ok, false, 'the rig must be able to say FAIL: no pinned identity ⇒ the commit is refused');
  assert.match(r.out, /Author identity unknown|empty ident|unable to auto-detect/i);
});

test('#513 idempotent: a second call writes nothing, and config.worktree is byte-identical', async () => {
  writeGlobal(ownerGlobal);
  const repo = mkRepo();
  const wt = wtPath('idem');
  await createWorktree(repo, 'agent-idem', 'main', wt);
  const cfg = path.join(git(wt, ['rev-parse', '--git-dir']), 'config.worktree');
  const before = fs.readFileSync(path.resolve(wt, cfg));
  const r = await ensureWorktreeGitIdentity(repo, wt);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.kept, ['user.name', 'user.email']);
  assert.ok(fs.readFileSync(path.resolve(wt, cfg)).equals(before));
});

test('#513 never overwrites an identity the user set explicitly in that worktree (a half-set group is kept whole)', async () => {
  writeGlobal(ownerGlobal);
  const repo = mkRepo();
  const wt = path.join(ROOT, `wt-explicit-${++n}`);
  git(repo, ['worktree', 'add', '-q', '-b', 'agent-explicit', wt, 'main']);
  git(repo, ['config', 'extensions.worktreeConfig', 'true']);
  git(wt, ['config', '--worktree', 'user.email', 'explicit@wt.test']); // only the email is explicit
  const r = await ensureWorktreeGitIdentity(repo, wt);
  assert.equal(git(wt, ['config', '--worktree', '--get', 'user.email']), 'explicit@wt.test', 'explicit email kept');
  assert.equal(tryGit(wt, ['config', '--worktree', '--get', 'user.name']).ok, false, 'no owner name written beside their email');
  assert.deepEqual(r.kept, ['user.name', 'user.email']);
  assert.deepEqual(r.applied, []);
});

test('#513 the identity is READ from the host config, never hardcoded: another owner ⇒ another identity', async () => {
  writeGlobal('[user]\n\tname = Someone Else\n\temail = else@example.test\n');
  const repo = mkRepo();
  const wt = wtPath('else');
  await createWorktree(repo, 'agent-else', 'main', wt);
  assert.equal(identityUnderScratchHome(wt).author, 'Someone Else <else@example.test>');
});

test('#513 resolved for the REPO (includeIf gitdir), not for the worktree path', async () => {
  const repo = mkRepo();
  const incl = path.join(ROOT, `incl-${++n}.gitconfig`);
  fs.writeFileSync(incl, '[user]\n\tname = Work Me\n\temail = work@example.test\n');
  writeGlobal(`${ownerGlobal}[includeIf "gitdir:${repo}/"]\n\tpath = ${incl}\n`);
  const wt = wtPath('incl'); // outside the repo dir: an includeIf evaluated at the worktree would NOT match
  await createWorktree(repo, 'agent-incl', 'main', wt);
  assert.equal(identityUnderScratchHome(wt).author, 'Work Me <work@example.test>');
});

test('#513 the REPO\'s own resolution wins where it differs from the worktree\'s (includeIf onbranch)', async () => {
  const repo = mkRepo(); // on `main`
  const incl = path.join(ROOT, `onbranch-${++n}.gitconfig`);
  fs.writeFileSync(incl, '[user]\n\tname = Main Branch Me\n\temail = mainbranch@example.test\n');
  writeGlobal(`${ownerGlobal}[includeIf "onbranch:main"]\n\tpath = ${incl}\n`);
  const wt = wtPath('onb');
  await createWorktree(repo, 'agent-onb', 'main', wt); // the worktree is on `agent-onb`: resolved AT the worktree it would read the plain global
  assert.equal(identityUnderScratchHome(wt).author, 'Main Branch Me <mainbranch@example.test>');
});

test('#513 author.* overrides are copied when the owner set them', async () => {
  writeGlobal(`${ownerGlobal}[author]\n\tname = Pen Name\n\temail = pen@example.test\n`);
  const repo = mkRepo();
  const wt = wtPath('auth');
  await createWorktree(repo, 'agent-auth', 'main', wt);
  const { author, committer } = identityUnderScratchHome(wt);
  assert.equal(author, 'Pen Name <pen@example.test>');
  assert.equal(committer, expected);
});

test('#513 a split committer the owner configured survives (author.* / committer.* are copied when set)', async () => {
  writeGlobal(`${ownerGlobal}[committer]\n\tname = Bot Committer\n\temail = bot@example.test\n`);
  const repo = mkRepo();
  const wt = wtPath('split');
  await createWorktree(repo, 'agent-split', 'main', wt);
  const { author, committer } = identityUnderScratchHome(wt);
  assert.equal(author, expected);
  assert.equal(committer, 'Bot Committer <bot@example.test>');
});

test('#513 the host has no identity ⇒ nothing invented, nothing written, the shared config untouched', async () => {
  writeGlobal('');
  const repo = mkRepo();
  const wt = wtPath('none');
  git(repo, ['worktree', 'add', '-q', '-b', 'agent-none', wt, 'main']);
  const r = await ensureWorktreeGitIdentity(repo, wt);
  assert.equal(r.skipped, 'no-identity');
  assert.equal(tryGit(repo, ['config', '--get', 'extensions.worktreeConfig']).ok, false);
});

test('#513 only name without email is not an identity (both or nothing)', async () => {
  writeGlobal('[user]\n\tname = Name Only\n');
  const repo = mkRepo();
  const wt = wtPath('half');
  git(repo, ['worktree', 'add', '-q', '-b', 'agent-half', wt, 'main']);
  assert.equal((await ensureWorktreeGitIdentity(repo, wt)).skipped, 'no-identity');
});

test('#513 the owner\'s main checkout and sibling worktrees are not touched', async () => {
  writeGlobal(ownerGlobal);
  const repo = mkRepo();
  const sibling = wtPath('sib');
  git(repo, ['worktree', 'add', '-q', '-b', 'agent-sib', sibling, 'main']);
  const wt = wtPath('pinned');
  await createWorktree(repo, 'agent-pinned', 'main', wt);
  assert.equal(tryGit(repo, ['config', '--local', '--get', 'user.name']).ok, false, 'no user.* written to the shared repo config');
  assert.equal(tryGit(repo, ['config', '--worktree', '--get', 'user.name']).ok, false, 'main checkout carries no per-worktree identity');
  assert.equal(tryGit(sibling, ['config', '--worktree', '--get', 'user.name']).ok, false, 'sibling worktree carries none');
});

test('#513 parallel spawns in one repo all end pinned (the shared-config flip is race-safe)', async () => {
  writeGlobal(ownerGlobal);
  const repo = mkRepo();
  const wts = Array.from({ length: 6 }, (_, i) => wtPath(`par${i}`));
  await Promise.all(wts.map((w, i) => createWorktree(repo, `agent-par${i}`, 'main', w)));
  for (const w of wts) assert.equal(identityUnderScratchHome(w).committer, expected, w);
});

test('#513 24 pins racing on a repo that has never had the flag all succeed', async () => {
  writeGlobal(ownerGlobal);
  const repo = mkRepo();
  const wts = Array.from({ length: 24 }, (_, i) => {
    const w = wtPath(`race${i}`);
    git(repo, ['worktree', 'add', '-q', '-b', `agent-race${i}`, w, 'main']);
    return w;
  });
  const rs = await Promise.all(wts.map((w) => ensureWorktreeGitIdentity(repo, w)));
  for (const r of rs) assert.equal(r.skipped, undefined, JSON.stringify(r));
  for (const w of wts) assert.equal(identityUnderScratchHome(w).committer, expected, w);
});

test('#513 a config.lock held by another process for ~120 ms is waited out (retry), not a failed spawn', async () => {
  writeGlobal(ownerGlobal);
  const repo = mkRepo();
  const wt = wtPath('lock');
  git(repo, ['worktree', 'add', '-q', '-b', 'agent-lock', wt, 'main']);
  const lock = path.join(repo, '.git', 'config.lock');
  fs.writeFileSync(lock, '');
  setTimeout(() => fs.rmSync(lock, { force: true }), 120);
  const r = await ensureWorktreeGitIdentity(repo, wt);
  assert.equal(r.skipped, undefined, JSON.stringify(r));
  assert.equal(identityUnderScratchHome(wt).committer, expected);
});

test('#513 a bare repo is refused (extension needs a migration we do not do), nothing written', async () => {
  writeGlobal(ownerGlobal);
  const src = mkRepo();
  const bare = path.join(ROOT, `bare-${++n}.git`);
  git(ROOT, ['clone', '-q', '--bare', src, bare]);
  const wt = wtPath('bare2');
  git(bare, ['worktree', 'add', '-q', '-b', 'agent-bare2', wt, 'main']);
  assert.equal((await ensureWorktreeGitIdentity(bare, wt)).skipped, 'unsupported-repo');
  assert.equal(tryGit(bare, ['config', '--get', 'extensions.worktreeConfig']).ok, false);
});

test('#513 never throws: an unreadable repo is reported, not raised (a spawn must not fail on its identity)', async () => {
  writeGlobal(ownerGlobal);
  const dir = path.join(ROOT, `plain-${++n}`);
  fs.mkdirSync(dir);
  const r = await ensureWorktreeGitIdentity(path.join(ROOT, 'no-such-repo'), dir);
  assert.equal(r.skipped, 'error');
  assert.deepEqual(r.applied, []);
});

test('#513 the main worktree itself and a missing path are not pinned', async () => {
  writeGlobal(ownerGlobal);
  const repo = mkRepo();
  assert.equal((await ensureWorktreeGitIdentity(repo, repo)).skipped, 'not-a-worktree');
  assert.equal((await ensureWorktreeGitIdentity(repo, path.join(ROOT, 'does-not-exist'))).skipped, 'not-a-worktree');
});

test('#513 ensureWorkspaceGitIdentity: restore / attach / session-start entry — pins a pre-existing worktree, skips scratch, orchestrator-without-repo, sandbox', async () => {
  writeGlobal(ownerGlobal);
  const repo = mkRepo();
  const wt = wtPath('ws');
  git(repo, ['worktree', 'add', '-q', '-b', 'agent-ws', wt, 'main']); // made before the pin existed
  const base = { kind: 'worktree' as const, repoPath: repo, worktreePath: wt };
  assert.ok((await ensureWorkspaceGitIdentity(base))?.applied.includes('user.email'));
  assert.equal(identityUnderScratchHome(wt).committer, expected);
  assert.deepEqual((await ensureWorkspaceGitIdentity(base))?.applied, [], 'idempotent');
  const other = wtPath('ws2');
  git(repo, ['worktree', 'add', '-q', '-b', 'agent-ws2', other, 'main']);
  assert.equal(await ensureWorkspaceGitIdentity({ kind: 'scratch', repoPath: '', worktreePath: other }), null);
  assert.equal(await ensureWorkspaceGitIdentity({ kind: 'scratch', repoPath: repo, worktreePath: other }), null, 'a scratch record with a stray repoPath is still scratch');
  assert.equal(await ensureWorkspaceGitIdentity({ kind: 'orchestrator', repoPath: '', worktreePath: other }), null);
  assert.equal(await ensureWorkspaceGitIdentity({ ...base, worktreePath: other, host: { kind: 'sandbox' } as never }), null);
  assert.equal(tryGit(other, ['config', '--worktree', '--get', 'user.name']).ok, false, 'skipped kinds wrote nothing');
});

// ── wiring: each lifecycle path that can hand an agent a worktree calls the pin (grep-level, like scope-stop-wiring) ──
const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
function body(src: string, startMarker: string): string {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, `anchor gone: ${startMarker}`);
  const rest = src.slice(i + startMarker.length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\n\/\/ ----------/);
  return rest.slice(0, end < 0 ? undefined : end);
}

test('#513 wiring: createWorktree (the chokepoint of spawn / top-level / adopt-repo / sandbox eject) pins', () => {
  assert.match(body(read('git.ts'), 'export async function createWorktree('), /await ensureWorktreeGitIdentity\(repoPath, worktreePath\)/);
});
test('#513 wiring: no other code creates a worktree behind the chokepoint\'s back', () => {
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts') && x !== 'git.ts')) {
    assert.doesNotMatch(read(f), /\[\s*'worktree'\s*,\s*'add'/, `${f} runs \`git worktree add\` itself`);
  }
});
test('#513 wiring: every creating caller goes through createWorktree', () => {
  const ws = read('workspaces.ts');
  assert.match(body(ws, 'export async function createWorkspace('), /await createWorktree\(input\.repoPath, branch, baseBranch, worktreePath\)/);
  assert.match(body(ws, 'export async function dispatchAdoptRepoRequest('), /await createWorktree\(repoPath, branch, baseBranch, newWorktreePath\)/);
  assert.match(read('sandbox-import.ts'), /await createWorktree\(ws\.repoPath, branch, ws\.baseBranch, worktreePath\)/);
});
test('#513 wiring: unarchive (restore) pins', () => {
  assert.match(body(read('workspaces.ts'), 'export async function unarchiveWorkspace('), /await ensureWorkspaceGitIdentity\(updated\)/);
});
test('#513 wiring: attach pins', () => {
  assert.match(body(read('workspaces.ts'), 'export async function dispatchAttachRequest('), /await ensureWorkspaceGitIdentity\(updated\)/);
});
test('#513 wiring: every session start (spawn, restart, wake, restore) pins right after the hook install', () => {
  assert.match(read('agent-sdk.ts'), /await installOrchestraHooks\(ws\.worktreePath\)\.catch\([^]*?\);\s*await ensureWorkspaceGitIdentity\(ws\);/);
});
