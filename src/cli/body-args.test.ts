import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBody, splitAtSeparator } from './body-args.ts';

const base = {
  verb: 'send',
  knownFlags: ['--type', '--to', '--body-file'],
  bodyFilePresent: false,
  readFile: (): string => {
    throw new Error('readFile must not be called');
  },
};

test('splitAtSeparator: everything after the first "--" is tail, verbatim', () => {
  assert.deepEqual(splitAtSeparator(['--to', 'x', '--', '--file', 'y', '--']), {
    flagArgs: ['--to', 'x'],
    tail: ['--file', 'y', '--'],
  });
  assert.deepEqual(splitAtSeparator(['a', 'b']), { flagArgs: ['a', 'b'], tail: [] });
});

test('an unknown option is refused, named, with the vocabulary and remedies', () => {
  const r = resolveBody({ ...base, rest: ['--file', '/tmp/x'], tail: [] });
  assert.ok('error' in r);
  assert.match(r.error, /unknown option --file — nothing was sent/);
  assert.match(r.error, /Options: --type --to --body-file/);
  assert.match(r.error, /"--" separator/);
  assert.match(r.error, /--body-file <path>/);
});

test('plain words, a lone "-" and "--" inside the tail are body text', () => {
  assert.deepEqual(resolveBody({ ...base, rest: ['hello', '-', 'world'], tail: [] }), { body: 'hello - world' });
  assert.deepEqual(resolveBody({ ...base, rest: ['use'], tail: ['--file', 'x'] }), { body: 'use --file x' });
});

test('--body-file reads the file (stdin as "-") and trims trailing whitespace only', () => {
  const seen: string[] = [];
  const readFile = (p: string): string => {
    seen.push(p);
    return '  line 1\nline 2\n\n';
  };
  assert.deepEqual(
    resolveBody({ ...base, rest: [], tail: [], bodyFilePresent: true, bodyFile: '-', readFile }),
    { body: '  line 1\nline 2' },
  );
  assert.deepEqual(seen, ['-']);
});

test('--body-file refusals: no path, both forms, empty, unreadable', () => {
  const ok = (): string => 'content';
  const cases: Array<[Partial<Parameters<typeof resolveBody>[0]>, RegExp]> = [
    [{ bodyFilePresent: true, bodyFile: undefined, readFile: ok }, /--body-file needs a path/],
    [{ bodyFilePresent: true, bodyFile: '--to', readFile: ok }, /--body-file needs a path/],
    [{ bodyFilePresent: true, bodyFile: 'f', readFile: ok, rest: ['inline'] }, /not both/],
    [{ bodyFilePresent: true, bodyFile: 'f', readFile: ok, tail: ['inline'] }, /not both/],
    [{ bodyFilePresent: true, bodyFile: 'f', readFile: () => ' \n' }, /is empty/],
    [
      {
        bodyFilePresent: true,
        bodyFile: 'f',
        readFile: () => {
          throw new Error('ENOENT');
        },
      },
      /cannot read --body-file f: ENOENT/,
    ],
  ];
  for (const [over, re] of cases) {
    const r = resolveBody({ ...base, rest: [], tail: [], ...over });
    assert.ok('error' in r, JSON.stringify(over));
    assert.match(r.error, re);
    assert.match(r.error, /nothing was sent/);
  }
});
