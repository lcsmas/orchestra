import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRepoEnv } from './repo-env.ts';

// expandRepoEnv is the core of the per-repo agent-env feature: it turns a
// repo's configured `env` map (with ${VAR} references) into concrete values
// against a source environment, dropping entries that expand to nothing so a
// missing token degrades to the agent's default login instead of a blank one.

test('expands ${VAR} from the source env', () => {
  const out = expandRepoEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_TOKEN_B}' },
    { CLAUDE_TOKEN_B: 'sk-ant-oat01-mc' },
  );
  assert.deepEqual(out, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-mc' });
});

test('expands bare $VAR too', () => {
  const out = expandRepoEnv({ TOKEN: '$CLAUDE_TOKEN_A' }, { CLAUDE_TOKEN_A: 'abc' });
  assert.deepEqual(out, { TOKEN: 'abc' });
});

test('drops an entry whose referenced var is unset (falls back to default login)', () => {
  const out = expandRepoEnv({ CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_TOKEN_B}' }, {});
  assert.deepEqual(out, {}); // no empty CLAUDE_CODE_OAUTH_TOKEN leaks through
});

test('drops an entry whose var is set but blank', () => {
  const out = expandRepoEnv({ TOKEN: '${X}' }, { X: '' });
  assert.deepEqual(out, {});
});

test('keeps a literal (no-reference) value', () => {
  const out = expandRepoEnv({ FOO: 'bar' }, {});
  assert.deepEqual(out, { FOO: 'bar' });
});

test('handles multiple keys, mixing kept and dropped', () => {
  const out = expandRepoEnv(
    { A: '${SET}', B: '${UNSET}', C: 'literal' },
    { SET: 'v' },
  );
  assert.deepEqual(out, { A: 'v', C: 'literal' });
});

test('undefined env map yields {} (repo with no env = today behavior)', () => {
  assert.deepEqual(expandRepoEnv(undefined, { X: 'y' }), {});
});

test('a token-shaped secret never lands in output when unset', () => {
  // Guard the security property: an unset reference must not produce an empty
  // CLAUDE_CODE_OAUTH_TOKEN that would override the stored login with nothing.
  const out = expandRepoEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_TOKEN_A}', KEEP: 'x' },
    {},
  );
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in out, false);
  assert.deepEqual(out, { KEEP: 'x' });
});
