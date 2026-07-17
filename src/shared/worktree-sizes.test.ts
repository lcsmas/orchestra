import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuSizes, parseBtrfsDuSizes } from './worktree-sizes.ts';

test('parseDuSizes maps "<KiB>\\t<path>" lines to bytes', () => {
  const out = [
    '599732\t/home/u/.orchestra/worktrees/orchestra-sunny-willow',
    '1024\t/home/u/.orchestra/worktrees/tiny',
    '20971520\t/home/u/.orchestra/worktrees',
  ].join('\n');
  const m = parseDuSizes(out);
  assert.equal(m.get('/home/u/.orchestra/worktrees/orchestra-sunny-willow'), 599732 * 1024);
  assert.equal(m.get('/home/u/.orchestra/worktrees/tiny'), 1024 * 1024);
  assert.equal(m.size, 3);
});

test('parseDuSizes skips tab-less and non-numeric lines', () => {
  const out = [
    "du: cannot access '/gone': No such file or directory",
    'garbage\t/not/a/number',
    '2048\t/ok',
    '',
  ].join('\n');
  const m = parseDuSizes(out);
  assert.deepEqual([...m.entries()], [['/ok', 2048 * 1024]]);
});

test('parseBtrfsDuSizes extracts the exclusive column, ignoring the header', () => {
  const out = [
    '     Total   Exclusive  Set shared  Filename',
    ' 574918656     2285568   438956032  /home/u/.orchestra/worktrees/orchestra-sunny-willow',
    '  18161664    18161664           0  /home/u/.orchestra/worktrees/dotfiles-noble-otter',
  ].join('\n');
  const m = parseBtrfsDuSizes(out);
  assert.equal(m.get('/home/u/.orchestra/worktrees/orchestra-sunny-willow'), 2285568);
  assert.equal(m.get('/home/u/.orchestra/worktrees/dotfiles-noble-otter'), 18161664);
  assert.equal(m.size, 2);
});

test('parseBtrfsDuSizes survives interleaved error lines and spaces in paths', () => {
  const out = [
    '     Total   Exclusive  Set shared  Filename',
    "ERROR: cannot check space of '/gone': No such file or directory",
    ' 100  40  60  /home/u/.orchestra/worktrees/with space/dir ',
  ].join('\n');
  const m = parseBtrfsDuSizes(out);
  assert.deepEqual([...m.entries()], [['/home/u/.orchestra/worktrees/with space/dir', 40]]);
});
