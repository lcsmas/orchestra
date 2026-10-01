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
import { pauseRefName, refSegment, selectSkipped, snapshotWorktree, SnapshotTimeoutError, SNAPSHOT_MAX_UNTRACKED_BYTES } from './pause-snapshot.ts';

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
    assert.deepEqual(r.skippedLarge, [{ path: 'big.bin', bytes: SNAPSHOT_MAX_UNTRACKED_BYTES + 1, reason: 'file-cap' }]);
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

test('the repo\'s HOOKS never run for a snapshot (post-index-change, reference-transaction, post-commit…): 0 hook executions', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    dirtyUp(wt);
    const hooks = path.join(git(wt, 'rev-parse', '--git-common-dir').replace(/^(?!\/)/, `${wt}/`), 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const log = path.join(root, 'hook-runs.log');
    for (const h of ['post-index-change', 'reference-transaction', 'post-commit', 'pre-commit', 'post-checkout', 'pre-auto-gc']) {
      fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\necho ${h} >> ${log}\nexit 0\n`, { mode: 0o755 });
    }
    // positive control: the hooks DO fire for an ordinary git command of the same shape (else the arm proves nothing)
    git(wt, 'update-ref', 'refs/control/x', 'HEAD');
    assert.ok(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('reference-transaction'), 'control: reference-transaction hook fires on a plain update-ref');
    fs.rmSync(log);
    await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 31 });
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '', 'no hook ran during the snapshot');
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

test('round-3 F7: selectSkipped — per-file cap first, then the LARGEST of the rest are dropped until the total fits (reason total-cap); under the caps nothing is skipped', () => {
  const f = (path: string, bytes: number) => ({ path, bytes });
  assert.deepEqual(selectSkipped([f('a', 10), f('b', 20)], 100, 1000), []);
  assert.deepEqual(selectSkipped([f('huge', 500), f('a', 10)], 100, 1000), [{ path: 'huge', bytes: 500, reason: 'file-cap' }]);
  const r = selectSkipped([f('c', 60), f('a', 100), f('d', 70), f('b', 90), f('e', 80)], 1000, 250); // total 400 > 250: drop 100, then 90 (210 fits)
  assert.deepEqual(r, [{ path: 'a', bytes: 100, reason: 'total-cap' }, { path: 'b', bytes: 90, reason: 'total-cap' }]);
});

test('round-3 F7: a TOTAL size cap on untracked work — the largest files are left out of the ref and REPORTED with their reason; the rest is captured', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    for (const [n, size] of [['f100', 100], ['f90', 90], ['f80', 80], ['f70', 70], ['f60', 60]] as const) fs.writeFileSync(path.join(wt, n), 'x'.repeat(size));
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 20, limits: { perFileBytes: 1000, totalBytes: 250 } });
    assert.deepEqual(r.skippedLarge.map((x) => `${x.path}:${x.reason}`).sort(), ['f100:total-cap', 'f90:total-cap']);
    assert.throws(() => git(wt, 'cat-file', '-e', `${r.ref}:f100`));
    assert.equal(git(wt, 'show', `${r.ref}:f80`).length, 80, 'the files that fit are in the ref');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-3 F8: MORE than 200 oversize files are ALL excluded (pathspec file, no silent truncation) — none of them is in the ref, none is reported "not captured" while actually captured', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(wt, `big-${i}.bin`), 'x'.repeat(40));
    fs.writeFileSync(path.join(wt, 'small.txt'), 's\n');
    const before = fingerprint(wt);
    const touched: string[] = [];
    await new Promise((r) => setTimeout(r, 200));
    const watcher = fs.watch(wt, { recursive: true }, (_ev, name) => touched.push(String(name))); // ANY create/modify/delete inside the worktree while the snapshot runs (a transient spec file leaves no trace afterwards)
    let r;
    try {
      r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 21, limits: { perFileBytes: 10, totalBytes: 1 << 20 } });
      await new Promise((res) => setTimeout(res, 300));
    } finally {
      watcher.close();
    }
    assert.deepEqual(touched, [], 'D4: NOTHING is written inside the worktree during the snapshot (not even a transient pathspec file)');
    assert.equal(fingerprint(wt), before, 'NO-TOUCH holds on the pathspec-file path too: worktree, REAL index, HEAD and branches byte-identical');
    assert.equal(r.skippedLargeCount, 260, 'all 260 big files counted');
    assert.equal(r.skippedLarge.length, 200, 'and the largest 200 stored (a 100k-file tree must not bloat the Bilan row)');
    assert.deepEqual(git(wt, 'ls-tree', '-r', '--name-only', r.ref).split('\n').sort(), ['.gitignore', 'other.txt', 'small.txt', 'tracked.txt'], 'the EXACT ref tree: tracked files + small.txt, no spec file, no big file');
    const inRef = git(wt, 'ls-tree', '-r', '--name-only', r.ref).split('\n').filter((n) => n.startsWith('big-'));
    assert.deepEqual(inRef, [], 'and NONE of them is in the ref (201+ used to be captured while reported skipped)');
    assert.equal(git(wt, 'show', `${r.ref}:small.txt`), 's');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-3 F8 legacy git (< 2.25, argv-only pathspec): excludes beyond 200 are NOT applied and the WARNING says so (never "not captured" for a file that is in the ref)', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    for (let i = 0; i < 230; i++) fs.writeFileSync(path.join(wt, `big-${i}.bin`), 'x'.repeat(40));
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 22, limits: { perFileBytes: 10, totalBytes: 1 << 20 }, legacyPathspec: true });
    assert.match(r.notes.join(' | '), /30 oversize entr\(ies\) could NOT be excluded/);
    assert.equal(r.skippedLargeCount, 200, 'skippedLarge lists only what was ACTUALLY excluded');
    assert.equal(r.skippedLarge.length, 200);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-3 review #4: a NON-UTF8 file name over the cap is still sized, excluded from the ref and REPORTED (the utf8 decode used to hide it from both caps); names with spaces/newlines/leading dashes are excluded exactly', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    const odd = Buffer.concat([Buffer.from(wt + '/'), Buffer.from([0x62, 0x69, 0x67, 0xff, 0x2e, 0x62, 0x69, 0x6e])]);
    fs.writeFileSync(odd, 'x'.repeat(40));
    for (const n of ['-lead dash.bin', 'new\nline.bin', 'sp ace.bin']) fs.writeFileSync(path.join(wt, n), 'x'.repeat(40));
    fs.writeFileSync(path.join(wt, 'small.txt'), 's\n');
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 23, limits: { perFileBytes: 10, totalBytes: 1 << 20 } });
    assert.equal(r.skippedLarge.length, 4, `all four oversize files reported: ${JSON.stringify(r.skippedLarge.map((x) => x.path))}`);
    const inRef = git(wt, 'ls-tree', '-r', '--name-only', '-z', r.ref).split('\0').filter(Boolean);
    assert.deepEqual(inRef.filter((n) => n.includes('bin')), [], 'none of them is in the ref');
    assert.ok(inRef.includes('small.txt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-3 F1: a wholly-untracked DIRECTORY dropped by the total cap is ONE entry (one exclude, files counted); a tracked edit in a MIXED directory is never lost with it', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    fs.mkdirSync(path.join(wt, 'vendor/a/b'), { recursive: true });
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(wt, `vendor/a/b/f${i}.js`), 'x'.repeat(10));
    fs.mkdirSync(path.join(wt, 'mixed'));
    fs.writeFileSync(path.join(wt, 'mixed/tracked-in-mixed.txt'), 'v1\n');
    git(wt, 'add', 'mixed/tracked-in-mixed.txt');
    git(wt, 'commit', '-q', '-m', 'mixed');
    fs.writeFileSync(path.join(wt, 'mixed/tracked-in-mixed.txt'), 'EDITED v2\n'); // a tracked edit inside a mixed dir
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(wt, `mixed/u${i}.dat`), 'y'.repeat(30)); // untracked files in the same mixed dir
    fs.writeFileSync(path.join(wt, 'loose.txt'), 'l\n');
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 24, limits: { perFileBytes: 1 << 20, totalBytes: 3500 } });
    const names = git(wt, 'ls-tree', '-r', '--name-only', r.ref).split('\n');
    assert.ok(!names.some((n) => n.startsWith('vendor/')), 'the whole vendor/ tree is out of the ref');
    const dirEntry = r.skippedLarge.find((x) => x.path === 'vendor/');
    assert.ok(dirEntry && dirEntry.files === 300 && dirEntry.reason === 'total-cap', `ONE entry for the directory: ${JSON.stringify(r.skippedLarge.slice(0, 3))}`);
    assert.equal(git(wt, 'show', `${r.ref}:mixed/tracked-in-mixed.txt`), 'EDITED v2', 'the tracked edit in the MIXED directory is captured (a directory exclude would have lost it)');
    assert.equal(git(wt, 'show', `${r.ref}:loose.txt`), 'l');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-3 F1 PERF: selectSkipped is linear — 200k files select in well under 2 s (shift() made it quadratic: 150 s on 240k files)', () => {
  const files = Array.from({ length: 200_000 }, (_, i) => ({ path: `f${i}`, bytes: 1 + (i % 7) }));
  const t0 = Date.now();
  const r = selectSkipped(files, 100, 1000);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.ok(r.length > 195_000, 'nearly everything is dropped to fit the 1000-byte cap');
});

test('round-3 F1 PERF: a 60k-file un-ignored tree over the total cap snapshots in seconds, with the event loop never frozen and ONE entry per directory (master took 18 s, the first cap 150 s)', { timeout: 180_000 }, async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    for (let d = 0; d < 100; d++) {
      const dir = path.join(wt, `pkg${d}`, 'lib');
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(dir, `m${i}.js`), 'x'.repeat(20));
    }
    let maxLag = 0;
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); maxLag = Math.max(maxLag, now - last - 25); last = now; }, 25);
    const t0 = Date.now();
    let r;
    try {
      r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 25, limits: { perFileBytes: 1 << 20, totalBytes: 100_000 } });
    } finally {
      clearInterval(timer);
    }
    const took = Date.now() - t0;
    assert.ok(took < 30_000, `snapshot took ${took} ms`);
    assert.ok(maxLag < 2000, `event-loop lag ${maxLag} ms`);
    assert.ok(r.skippedLargeCount <= 100, `one entry per directory, not per file: ${r.skippedLargeCount}`);
    assert.ok(r.skippedLarge.every((x) => x.path.endsWith('/') && x.files === 600));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-3 F4a: git < 2.25 (a PATH shim that rejects --pathspec-from-file with exit 129) — the fallback excludes 200, the other 30 ARE in the ref and are said so; skippedLarge lists only what was really excluded', async () => {
  const { wt, root } = makeLinkedWorktree();
  const shimDir = path.join(root, 'shim');
  fs.mkdirSync(shimDir);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\nfor a in "$@"; do case "$a" in --pathspec-from-file=*) echo "error: unknown option \\\`pathspec-from-file'" >&2; echo "usage: git add [<options>] [--] <pathspec>..." >&2; exit 129;; esac; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  try {
    for (let i = 0; i < 230; i++) fs.writeFileSync(path.join(wt, `big-${i}.bin`), 'x'.repeat(40));
    process.env.PATH = `${shimDir}:${oldPath}`;
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 26, limits: { perFileBytes: 10, totalBytes: 1 << 20 } });
    process.env.PATH = oldPath;
    const inRef = git(wt, 'ls-tree', '-r', '--name-only', r.ref).split('\n').filter((n) => n.startsWith('big-'));
    assert.equal(inRef.length, 30, 'the 30 beyond the argv cap ARE in the ref');
    assert.equal(r.skippedLargeCount, 200);
    assert.ok(r.skippedLarge.every((x) => !inRef.includes(x.path)), 'nothing listed as left out is in the ref');
    assert.match(r.notes.join(' | '), /30 oversize entr\(ies\) could NOT be excluded/);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-3 review #1 (MAJOR): IGNORED content never counts toward a directory unit — untracked source next to an ignored 3 MB node_modules stays in the ref when the cap fires on nothing else; a directory holding only ignored files is no unit', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    fs.mkdirSync(path.join(wt, 'newpkg/src'), { recursive: true });
    fs.mkdirSync(path.join(wt, 'newpkg/node_modules'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'newpkg/src/a.ts'), 'abc');
    fs.writeFileSync(path.join(wt, 'newpkg/node_modules/big.bin'), 'x'.repeat(3_000_000)); // ignored (fixture .gitignore)
    fs.writeFileSync(path.join(wt, 'newpkg/ignored.log'), 'noise');
    fs.mkdirSync(path.join(wt, 'onlyignored'));
    fs.writeFileSync(path.join(wt, 'onlyignored/ignored.log'), 'y'.repeat(2_000_000));
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 27, limits: { perFileBytes: 1 << 20, totalBytes: 1_000_000 } });
    assert.deepEqual(r.skippedLarge, [], `nothing non-ignored is over the cap: ${JSON.stringify(r.skippedLarge)}`);
    assert.equal(git(wt, 'show', `${r.ref}:newpkg/src/a.ts`), 'abc', 'the untracked source is in the ref');
    const names = git(wt, 'ls-tree', '-r', '--name-only', r.ref).split('\n');
    assert.ok(!names.some((n) => n.includes('node_modules') || n.endsWith('ignored.log')), 'ignored files are not captured (as before)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-3 review #4: selectSkipped — a DIRECTORY unit over the per-file cap is not a "file-cap" entry and still counts toward (and can be dropped by) the total cap', () => {
  const dir = { path: 'vendor/', bytes: 30 * 1048576, dir: true };
  assert.deepEqual(selectSkipped([dir], 25 * 1048576, 1 << 30), [], 'fits the total: kept, never "file-cap"');
  assert.deepEqual(selectSkipped([dir], 25 * 1048576, 10 * 1048576).map((x) => `${x.path}:${x.reason}`), ['vendor/:total-cap'], 'over the total: dropped by the total cap, not vanished from the accounting');
});

test('round-3 review #4 (real): a wholly-untracked directory bigger than the PER-FILE cap but under the total stays in the ref', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    fs.mkdirSync(path.join(wt, 'pkg'));
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(wt, `pkg/f${i}.txt`), 'x'.repeat(10)); // 200 B in total, each 10 B
    const r = await snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 28, limits: { perFileBytes: 100, totalBytes: 1 << 20 } });
    assert.deepEqual(r.skippedLarge, []);
    assert.equal(git(wt, 'show', `${r.ref}:pkg/f3.txt`), 'x'.repeat(10));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A PATH shim `git`: logs every `add`, then misbehaves as `mode` says; everything else goes to the real git. */
function gitShim(root: string, mode: 'hang' | 'unrelated-failure'): { dir: string; log: string } {
  const dir = path.join(root, 'shim-' + mode);
  fs.mkdirSync(dir);
  const log = path.join(dir, 'add.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const body =
    mode === 'hang'
      ? 'echo "add $*" >> "$LOG"; exec sleep 5'
      : 'echo "add $*" >> "$LOG"; case "$*" in *--pathspec-from-file=*) echo "fatal: unrelated failure (disk quota)" >&2; exit 128;; esac';
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nLOG=${log}\nfor a in "$@"; do if [ "$a" = add ]; then ${body}; fi; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  return { dir, log };
}

test('round-4 (verifier MAJOR): a git add TIMEOUT is not "git < 2.25" — no fallback, nothing staged, NO ref; SnapshotTimeoutError says so; exactly ONE add was run (no argv retry, no HEAD rebuild)', async () => {
  const { wt, root } = makeLinkedWorktree();
  const shim = gitShim(root, 'hang');
  const oldPath = process.env.PATH;
  try {
    fs.mkdirSync(path.join(wt, 'tracked-dir'));
    fs.writeFileSync(path.join(wt, 'tracked-dir/t.txt'), 'tracked\n');
    git(wt, 'add', 'tracked-dir/t.txt');
    git(wt, 'commit', '-q', '-m', 'dir');
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(wt, `tracked-dir/big-${i}.bin`), 'x'.repeat(40)); // flat untracked files in a TRACKED dir: per-file excludes (> 50) ⇒ the pathspec-file path
    process.env.PATH = `${shim.dir}:${oldPath}`;
    await assert.rejects(
      snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 40, limits: { perFileBytes: 10, totalBytes: 1 << 20 }, gitTimeoutMs: 800 }),
      (e: unknown) => e instanceof SnapshotTimeoutError && /snapshot incomplete: timeout/.test(e.message),
    );
    process.env.PATH = oldPath;
    assert.equal(fs.readFileSync(shim.log, 'utf8').trim().split('\n').length, 1, 'ONE git add: no capped-argv fallback and no rebuild from HEAD (each would wait another timeout)');
    assert.equal(git(wt, 'for-each-ref', 'refs/orchestra/pause'), '', 'no ref was written');
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-4: the old-git fallback needs a USAGE error (exit 129 + "unknown option" on stderr) — an unrelated git failure whose COMMAND TEXT contains --pathspec-from-file is rethrown, never read as an old git', async () => {
  const { wt, root } = makeLinkedWorktree();
  const shim = gitShim(root, 'unrelated-failure');
  const oldPath = process.env.PATH;
  try {
    for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(wt, `big-${i}.bin`), 'x'.repeat(40));
    process.env.PATH = `${shim.dir}:${oldPath}`;
    await assert.rejects(
      snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 41, limits: { perFileBytes: 10, totalBytes: 1 << 20 } }),
      (e: unknown) => e instanceof Error && /unrelated failure \(disk quota\)/.test(e.message) && !(e instanceof SnapshotTimeoutError),
    );
    process.env.PATH = oldPath;
    const adds = fs.readFileSync(shim.log, 'utf8').trim().split('\n');
    assert.ok(adds.every((l) => l.includes('--pathspec-from-file=')), `no capped-argv fallback was attempted (the two adds are the existing seeded-index / rebuild-from-HEAD pair): ${adds.join(' | ').slice(0, 300)}`);
    assert.equal(git(wt, 'for-each-ref', 'refs/orchestra/pause'), '');
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A generic PATH shim `git` for ONE subcommand: `hang` (sleeps past the timeout), `term-usage` (on SIGTERM prints a usage error and exits 129 — a timed-out git that LOOKS like an old git), `fail-then-hang` (first call exits 128, later calls hang), `log` (records the locale, then runs the real git). */
function gitShimFor(root: string, on: string, behavior: 'hang' | 'term-usage' | 'fail-then-hang' | 'log'): { dir: string; log: string } {
  const dir = path.join(root, `shim-${on}-${behavior}`);
  fs.mkdirSync(dir);
  const log = path.join(dir, 'calls.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const actions: Record<string, string> = {
    hang: 'exec sleep 5',
    'term-usage': `trap 'echo "error: unknown option \\\`pathspec-from-file'"'"'" >&2; exit 129' TERM; sleep 5 & wait $!`,
    'fail-then-hang': `if [ "$(wc -l < "$LOG")" -le 1 ]; then echo "fatal: transient failure" >&2; exit 128; else exec sleep 5; fi`,
    log: ':',
  };
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nLOG=${log}\nfor a in "$@"; do if [ "$a" = ${on} ]; then echo "${on} LC_ALL=$LC_ALL $*" >> "$LOG"; ${actions[behavior]}; break; fi; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  return { dir, log };
}

async function withShim<T>(shim: { dir: string }, fn: () => Promise<T>): Promise<T> {
  const old = process.env.PATH;
  process.env.PATH = `${shim.dir}:${old}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = old;
  }
}

function flatTracked(wt: string, n: number): void {
  fs.mkdirSync(path.join(wt, 'tracked-dir'));
  fs.writeFileSync(path.join(wt, 'tracked-dir/t.txt'), 'tracked\n');
  git(wt, 'add', 'tracked-dir/t.txt');
  git(wt, 'commit', '-q', '-m', 'dir');
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(wt, `tracked-dir/big-${i}.bin`), 'x'.repeat(40));
}

test('round-4 review #2: a TIMED-OUT git that exits 129 with "unknown option" (SIGTERM handler) is still a TIMEOUT, never an old git — no capped-argv fallback', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    flatTracked(wt, 300);
    const shim = gitShimFor(root, 'add', 'term-usage');
    await withShim(shim, () => assert.rejects(snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 42, limits: { perFileBytes: 10, totalBytes: 1 << 20 }, gitTimeoutMs: 800 }), (e: unknown) => e instanceof SnapshotTimeoutError));
    const adds = fs.readFileSync(shim.log, 'utf8').trim().split('\n');
    assert.equal(adds.length, 1, `ONE add (no fallback): ${adds.join(' | ').slice(0, 200)}`);
    assert.equal(git(wt, 'for-each-ref', 'refs/orchestra/pause'), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-4 review #3: a hang on the CAPPED-ARGV path (≤ 50 excludes) times out too (timeoutMs reaches viaArgv); a non-timeout failure then a hang on the REBUILD is still a timeout', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(wt, `big-${i}.bin`), 'x'.repeat(40));
    const hang = gitShimFor(root, 'add', 'hang');
    await withShim(hang, () => assert.rejects(snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 43, limits: { perFileBytes: 10, totalBytes: 1 << 20 }, gitTimeoutMs: 800 }), (e: unknown) => e instanceof SnapshotTimeoutError));
    const ft = gitShimFor(root, 'add', 'fail-then-hang');
    await withShim(ft, () => assert.rejects(snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 44, limits: { perFileBytes: 10, totalBytes: 1 << 20 }, gitTimeoutMs: 800 }), (e: unknown) => e instanceof SnapshotTimeoutError));
    assert.equal(fs.readFileSync(ft.log, 'utf8').trim().split('\n').length, 2, 'first add fails (transient), the rebuild-from-HEAD add hangs: two adds, then the timeout');
    assert.equal(git(wt, 'for-each-ref', 'refs/orchestra/pause'), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-4 review #4: git runs with LC_ALL=C (a localized "option inconnue" would defeat the old-git fallback)', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    fs.writeFileSync(path.join(wt, 'u.txt'), 'u\n');
    const shim = gitShimFor(root, 'add', 'log');
    const old = process.env.LC_ALL;
    process.env.LC_ALL = 'fr_FR.UTF-8';
    try {
      await withShim(shim, () => snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 45 }));
    } finally {
      if (old === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = old;
    }
    assert.match(fs.readFileSync(shim.log, 'utf8'), /^add LC_ALL=C /m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-4 review #5: a ls-files TIMEOUT is a timeout too (named, no ref) — and a failed listing is never read as "no untracked files" (that stages everything past the size caps)', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    fs.writeFileSync(path.join(wt, 'big.bin'), 'x'.repeat(40));
    const shim = gitShimFor(root, 'ls-files', 'hang');
    await withShim(shim, () => assert.rejects(snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 46, limits: { perFileBytes: 10, totalBytes: 1 << 20 }, gitTimeoutMs: 800 }), (e: unknown) => e instanceof SnapshotTimeoutError && /git ls-files exceeded/.test(e.message)));
    assert.equal(git(wt, 'for-each-ref', 'refs/orchestra/pause'), '', 'no ref: big.bin was NOT staged past its cap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('round-4 review #5: a timeout in update-ref is a timeout (named) and is NEVER retried as "the ref exists"', async () => {
  const { wt, root } = makeLinkedWorktree();
  try {
    fs.writeFileSync(path.join(wt, 'u.txt'), 'u\n');
    const shim = gitShimFor(root, 'update-ref', 'hang');
    await withShim(shim, () => assert.rejects(snapshotWorktree({ worktreePath: wt, runId: 'r', wsId: 'w', at: 47, gitTimeoutMs: 800 }), (e: unknown) => e instanceof SnapshotTimeoutError && /git update-ref exceeded/.test(e.message)));
    assert.equal(fs.readFileSync(shim.log, 'utf8').trim().split('\n').length, 1, 'one update-ref, not six');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
