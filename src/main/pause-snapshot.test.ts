// #252 D1b — the pause snapshot must capture uncommitted + untracked work into a
// `refs/orchestra/pause/…` ref while leaving the worktree, the REAL index, HEAD and every
// branch byte-identical (LEAD ruling D4). Real git repos, real linked worktrees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pauseRefName, refSegment, snapshotWorktree, SNAPSHOT_MAX_UNTRACKED_BYTES } from './pause-snapshot.ts';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
}

function mkdtemp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pause-snap-')));
}

/** A main repo with one commit + a LINKED worktree (Orchestra's shape: per-worktree index). */
function makeLinkedWorktree(): { main: string; wt: string; root: string } {
  const root = mkdtemp();
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(main, 'tracked.txt'), 'base\n');
  fs.writeFileSync(path.join(main, 'other.txt'), 'other\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'ignored.log\nnode_modules/\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(root, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  return { main, wt, root };
}

/** Everything the snapshot must NOT change, read with node fs (never through git status). */
function fingerprint(wt: string): string {
  const gitDir = git(wt, 'rev-parse', '--absolute-git-dir');
  const lines: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (rel === '' && name === '.git') continue;
      const p = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p, { bigint: true });
      if (st.isDirectory()) {
        lines.push(`D ${r} ${st.mtimeNs}`);
        walk(p, r);
      } else if (st.isSymbolicLink()) lines.push(`L ${r} ${fs.readlinkSync(p)}`);
      else {
        const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        lines.push(`F ${r} ${st.mode} ${st.size} ${st.mtimeNs} ${h}`);
      }
    }
  };
  walk(wt, '');
  const idx = path.join(gitDir, 'index');
  if (fs.existsSync(idx)) {
    const st = fs.statSync(idx, { bigint: true });
    lines.push(`INDEX ${st.size} ${st.mtimeNs} ${st.ctimeNs} ${crypto.createHash('sha256').update(fs.readFileSync(idx)).digest('hex')}`);
  } else lines.push('INDEX absent');
  lines.push(`HEAD ${fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8')}`);
  lines.push(`HEADS ${git(wt, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes')}`);
  lines.push(`STASH ${git(wt, 'stash', 'list')}`);
  return lines.join('\n');
}

function dirtyUp(wt: string): void {
  fs.writeFileSync(path.join(wt, 'tracked.txt'), 'edited-unstaged\n'); // modified, unstaged
  fs.writeFileSync(path.join(wt, 'other.txt'), 'edited-staged\n');
  git(wt, 'add', 'other.txt'); // staged…
  fs.writeFileSync(path.join(wt, 'other.txt'), 'edited-staged-then-more\n'); // …then edited again
  fs.writeFileSync(path.join(wt, 'untracked.txt'), 'brand new\n');
  fs.mkdirSync(path.join(wt, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'sub', 'deep', 'n.txt'), 'nested untracked\n');
  fs.writeFileSync(path.join(wt, 'ignored.log'), 'must not be captured\n');
}

test('refSegment / pauseRefName: safe components, no traversal', () => {
  assert.equal(refSegment('0524718f-ac2a-4367'), '0524718f-ac2a-4367');
  assert.equal(refSegment('a b/c..d'), 'a_b_c_d');
  assert.equal(refSegment('..'), '_');
  assert.equal(refSegment('x.lock'), 'x_lock');
  assert.equal(refSegment(''), '_');
  assert.equal(pauseRefName('R', 'W', 1700), 'refs/orchestra/pause/R/W/1700');
});

test('captures unstaged + staged-then-edited + untracked (not ignored) work in the ref; HEAD is the parent', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    dirtyUp(wt);
    const head = git(wt, 'rev-parse', 'HEAD');
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'run-1', wsId: 'ws-1', at: 1234 });
    assert.equal(r.ref, 'refs/orchestra/pause/run-1/ws-1/1234');
    assert.equal(git(wt, 'rev-parse', r.ref), r.commit);
    assert.equal(git(wt, 'rev-parse', `${r.ref}^`), head, 'parent is the HEAD at snapshot time');
    assert.equal(git(wt, 'show', `${r.ref}:tracked.txt`), 'edited-unstaged');
    assert.equal(git(wt, 'show', `${r.ref}:other.txt`), 'edited-staged-then-more', 'the WORKTREE content wins over the index');
    assert.equal(git(wt, 'show', `${r.ref}:untracked.txt`), 'brand new');
    assert.equal(git(wt, 'show', `${r.ref}:sub/deep/n.txt`), 'nested untracked');
    assert.throws(() => git(wt, 'cat-file', '-e', `${r.ref}:ignored.log`), 'ignored files are not captured');
    assert.equal(r.dirty, true);
    assert.deepEqual(r.changed, { modified: 2, added: 2, deleted: 0 });
    assert.equal(r.branch, 'feature');
    assert.equal(r.head, head);
    // The diff the pause ref holds IS the uncommitted work (what a coordinator will read).
    const names = git(wt, 'diff', '--name-status', head, r.ref).split('\n').sort();
    assert.deepEqual(names, ['A\tsub/deep/n.txt', 'A\tuntracked.txt', 'M\tother.txt', 'M\ttracked.txt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('NO-TOUCH: worktree (content+mtime), REAL index (bytes+mtime+ctime), HEAD, branches, stash are byte-identical; ONLY the pause ref is new', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    dirtyUp(wt);
    // Positive control first: the fingerprint must actually see a change when one is made.
    const before = fingerprint(wt);
    assert.equal(fingerprint(wt), before, 'fingerprint is stable when nothing runs (instrument is deterministic)');
    const refsBefore = git(wt, 'for-each-ref', '--format=%(refname)');
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'run-1', wsId: 'ws-1', at: 99 });
    assert.equal(fingerprint(wt), before, 'snapshot left the worktree + index + HEAD + branches untouched');
    const refsAfter = git(wt, 'for-each-ref', '--format=%(refname)').split('\n').filter((x) => x !== r.ref);
    assert.deepEqual(refsAfter, refsBefore.split('\n'), 'the pause ref is the ONLY new ref');
    // No stray temp index left anywhere we put one.
    const gitDir = git(wt, 'rev-parse', '--absolute-git-dir');
    assert.deepEqual(fs.readdirSync(gitDir).filter((n) => n.startsWith('orchestra-pause-idx-')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CONTROL: the fingerprint DOES go red when something touches the index / worktree (proves the no-touch arm can fail)', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    dirtyUp(wt);
    const before = fingerprint(wt);
    git(wt, 'add', '-A'); // what a naive snapshot (git add -A on the REAL index) does
    assert.notEqual(fingerprint(wt), before, 'index mutation must be detected');
    git(wt, 'reset', '-q'); // restore staged state roughly; now touch a file mtime
    const b2 = fingerprint(wt);
    fs.utimesSync(path.join(wt, 'tracked.txt'), new Date(), new Date(Date.now() + 5000));
    assert.notEqual(fingerprint(wt), b2, 'an mtime touch on the worktree must be detected');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clean worktree: dirty=false, snapshot tree == HEAD tree', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 1 });
    assert.equal(r.dirty, false);
    assert.equal(r.tree, git(wt, 'rev-parse', 'HEAD^{tree}'));
    assert.deepEqual(r.changed, { modified: 0, added: 0, deleted: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleted tracked file is recorded as a deletion in the snapshot', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    fs.rmSync(path.join(wt, 'tracked.txt'));
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 1 });
    assert.deepEqual(r.changed, { modified: 0, added: 0, deleted: 1 });
    assert.throws(() => git(wt, 'cat-file', '-e', `${r.ref}:tracked.txt`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unborn branch (no commits): snapshot has no parent and captures untracked files', async () => {
  const root = mkdtemp();
  try {
    git(root, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
    const r = await snapshotWorktree({ worktreePath: root, runId: 'r', wsId: 'w', at: 5 });
    assert.equal(r.head, null);
    assert.equal(r.dirty, true);
    assert.equal(git(root, 'show', `${r.ref}:a.txt`), 'hello');
    assert.equal(git(root, 'rev-list', '--count', r.ref), '1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt/torn real index: falls back to a HEAD-seeded index and STILL captures the worktree, real index untouched', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    dirtyUp(wt);
    const gitDir = git(wt, 'rev-parse', '--absolute-git-dir');
    const idx = path.join(gitDir, 'index');
    fs.writeFileSync(idx, Buffer.from('DIRC-corrupt-not-an-index'));
    const before = crypto.createHash('sha256').update(fs.readFileSync(idx)).digest('hex');
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 7 });
    assert.equal(git(wt, 'show', `${r.ref}:untracked.txt`), 'brand new');
    assert.equal(git(wt, 'show', `${r.ref}:tracked.txt`), 'edited-unstaged');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(idx)).digest('hex'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('untracked files over the size cap are left out of the ref and REPORTED (not silently dropped)', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    const big = path.join(wt, 'big.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, SNAPSHOT_MAX_UNTRACKED_BYTES + 1);
    fs.writeFileSync(path.join(wt, 'small.txt'), 's\n');
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 8 });
    assert.deepEqual(r.skippedLarge, [{ path: 'big.bin', bytes: SNAPSHOT_MAX_UNTRACKED_BYTES + 1 }]);
    assert.throws(() => git(wt, 'cat-file', '-e', `${r.ref}:big.bin`));
    assert.equal(git(wt, 'show', `${r.ref}:small.txt`), 's');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('same `at` twice never overwrites a ref: the second lands on at+1', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    const a = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 50 });
    fs.writeFileSync(path.join(wt, 'x.txt'), 'x\n');
    const b = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 50 });
    assert.equal(a.ref, 'refs/orchestra/pause/r/w/50');
    assert.equal(b.ref, 'refs/orchestra/pause/r/w/51');
    assert.notEqual(a.commit, b.commit);
    assert.equal(git(wt, 'rev-parse', a.ref), a.commit, 'the first ref is intact');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the pause ref survives gc (it is a real ref) and does not appear in `git branch`', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    dirtyUp(wt);
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 3 });
    git(wt, 'gc', '--prune=now', '-q');
    assert.equal(git(wt, 'show', `${r.ref}:untracked.txt`), 'brand new');
    assert.ok(!git(wt, 'branch', '--list').includes('pause'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('submodule: a checked-out submodule is snapshotted in its OWN repo and its dirtiness is reported', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    const subSrc = path.join(root, 'subsrc');
    fs.mkdirSync(subSrc);
    git(subSrc, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(subSrc, 's.txt'), 'sub\n');
    git(subSrc, 'add', '-A');
    git(subSrc, 'commit', '-q', '-m', 'sub init');
    git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSrc, 'vendor/sub');
    git(wt, 'commit', '-q', '-m', 'add submodule');
    fs.writeFileSync(path.join(wt, 'vendor', 'sub', 's.txt'), 'sub-edited\n');
    fs.writeFileSync(path.join(wt, 'vendor', 'sub', 'new.txt'), 'sub-new\n');
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 11 });
    assert.equal(r.submodules.length, 1);
    assert.equal(r.submodules[0].path, 'vendor/sub');
    assert.equal(r.submodules[0].dirty, true);
    assert.ok(r.submodules[0].ref);
    const subWt = path.join(wt, 'vendor', 'sub');
    assert.equal(git(subWt, 'show', `${r.submodules[0].ref}:s.txt`), 'sub-edited');
    assert.equal(git(subWt, 'show', `${r.submodules[0].ref}:new.txt`), 'sub-new');
    assert.equal(r.dirty, true, 'a dirty submodule makes the member dirty');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ONE unreadable untracked file does not abort the snapshot: everything else is captured and the unreadable one is REPORTED', async () => {
  const { wt, root } = makeLinkedWorktree();
  const bad = path.join(wt, 'secret.txt');
  try {
    dirtyUp(wt);
    fs.writeFileSync(bad, 'cannot read me\n');
    fs.chmodSync(bad, 0o000);
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 21 });
    assert.equal(git(wt, 'show', `${r.ref}:untracked.txt`), 'brand new', 'the readable work is in the ref');
    assert.equal(git(wt, 'show', `${r.ref}:tracked.txt`), 'edited-unstaged');
    if (process.getuid?.() === 0) {
      assert.equal(git(wt, 'show', `${r.ref}:secret.txt`), 'cannot read me', 'root reads it: captured');
    } else {
      assert.ok(r.warnings.some((w) => /secret\.txt/.test(w)), `the unreadable file is named: ${JSON.stringify(r.warnings)}`);
      assert.throws(() => git(wt, 'cat-file', '-e', `${r.ref}:secret.txt`), 'and is not in the ref');
    }
  } finally {
    try { fs.chmodSync(bad, 0o644); } catch { /* */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a nested STANDALONE repository (.git directory, not a submodule) is left untouched: no ref is written inside the worktree, it is reported', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    const nested = path.join(wt, 'vendor-copy');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(nested, 'n.txt'), 'n\n');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-q', '-m', 'n');
    fs.writeFileSync(path.join(nested, 'n.txt'), 'edited in nested\n');
    const listGit = (): string => execFileSync('find', [path.join(nested, '.git'), '-printf', '%p %T@ %s\\n'], { encoding: 'utf8' }).split('\n').sort().join('\n');
    const before = listGit();
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 22 });
    assert.equal(listGit(), before, 'the nested repo\'s .git directory is byte-identical (no ref written inside the worktree)');
    assert.equal(git(nested, 'for-each-ref', 'refs/orchestra').length, 0);
    assert.equal(r.submodules.length, 1);
    assert.match(r.submodules[0].error ?? '', /nested repository \(not a submodule\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a missing worktree with a clear error', async () => {
  await assert.rejects(
    snapshotWorktree({ worktreePath: '/nonexistent/path/xyz', runId: 'r', wsId: 'w', at: 1 }),
    /does not exist/,
  );
});
