import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeMdImports } from '../shared/claude-md-imports.ts';

// parseClaudeMdImports decides which extra files get symlinked into a login
// dir alongside CLAUDE.md. Claude Code resolves @imports relative to the
// file's location, so missing one import means that file silently never loads
// for the alternate account.
test('parseClaudeMdImports: bare-filename imports are collected in order', () => {
  const md = '@RTK.md\n@LESSONS.md\n\n## Debugging Discipline\n\n- some rule\n';
  assert.deepEqual(parseClaudeMdImports(md), ['RTK.md', 'LESSONS.md']);
});

test('parseClaudeMdImports: ignores non-import lines and inline mentions', () => {
  const md = 'see @RTK.md for details\nemail me @lucas\n- @LESSONS.md trailing words\n';
  assert.deepEqual(parseClaudeMdImports(md), []);
});

test('parseClaudeMdImports: rejects path-traversal and separator imports', () => {
  const md = '@../outside.md\n@dir/file.md\n@dir\\file.md\n@.hidden\n@ok-name.md\n';
  assert.deepEqual(parseClaudeMdImports(md), ['ok-name.md']);
});

test('parseClaudeMdImports: tolerates surrounding whitespace and CRLF', () => {
  const md = '  @RTK.md  \r\n@LESSONS.md\r\n';
  assert.deepEqual(parseClaudeMdImports(md), ['RTK.md', 'LESSONS.md']);
});
