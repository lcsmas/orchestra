// #476 — the role guard lets a `scribe-` do the jobs the verified-fanout skill names for it, and still denies what it may never do.
// Runs the INSTALLED command string (HOOK_ROLE_GUARD_CMD) through bash with real PreToolUse JSON, like role-guard.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_ROLE_GUARD_CMD, ROLE_GUARD_SCRIPT, ROLE_SENTINEL_FILE } from './role-guard.ts';
import { VERIFIED_FANOUT_SKILL } from './verified-fanout-skill.ts';

// NOT under os.tmpdir(): /tmp counts as scratch for the guard.
const root = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.sj-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');

function install(role: string, script = ROLE_GUARD_SCRIPT): string {
  const w = path.join(home, '.orchestra', 'worktrees', `sj-${role}`);
  fs.mkdirSync(path.join(w, '.orchestra'), { recursive: true });
  fs.writeFileSync(path.join(w, '.orchestra', 'role-guard.sh'), script, { mode: 0o755 });
  fs.writeFileSync(path.join(w, '.orchestra', ROLE_SENTINEL_FILE), role);
  return w;
}
function run(w: string, tool_name: string, tool_input: Record<string, unknown>) {
  const payload = { session_id: 's', transcript_path: `${home}/.claude/p/s.jsonl`, cwd: w, hook_event_name: 'PreToolUse', tool_name, tool_input };
  const r = spawnSync('bash', ['-c', HOOK_ROLE_GUARD_CMD], {
    input: JSON.stringify(payload),
    env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_WS_ID: 'ws-1', ORCHESTRA_WORKTREE: w },
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr };
}
const sh = (w: string, command: string) => run(w, 'Bash', { command, description: 'x' });

/** The scribe jobs the skill names (one per bullet), as the scribe runs them. Every one must be ALLOWED for a `scribe-`. */
export const SCRIBE_JOBS: ReadonlyArray<readonly [job: string, command: string]> = [
  ['ledger: comment from a body file', 'gh issue comment 471 -R lcsmas/orchestra --body-file $TMPDIR/c.md'],
  ['ledger: body rewrite from a file', 'gh issue edit 471 -R lcsmas/orchestra --body-file $TMPDIR/body.md'],
  ['ledger: a table row via ledger-set', '.claude/skills/verified-fanout/scripts/ledger-set lcsmas/orchestra 471 Candidates 476 "| #476 | gated |"'],
  ['state relay: fanout state set', 'orchestra fanout state set 476 --status gated --head 0123456789abcdef0123456789abcdef01234567 --pr 12'],
  ['state read: fanout state show', 'orchestra fanout state show'],
  ['CI poll: gh pr checks --watch', 'gh pr checks 12 -R lcsmas/orchestra --watch'],
  ['CI poll: gh pr view json', 'gh pr view 12 --json state,mergeable,statusCheckRollup'],
  ['CI poll: gh run watch', 'gh run watch 12345 -R lcsmas/orchestra'],
  ['sweep: range check', 'git log origin/master..impl-foo-1'],
  ['sweep: porcelain', 'git -C ~/.orchestra/worktrees/impl-foo-1-abcd1234 status --porcelain | grep -v ".claude/skills"'],
  ['sweep: verify-landed', 'orchestra verify-landed impl-foo-1 --into ops-bar'],
  ['sweep: peers grep', 'orchestra peers | grep -c wave-name'],
  ['sweep: ls-remote', 'git ls-remote origin impl-foo-1'],
  ['final report: worker_done', 'orchestra send --type worker_done --to 55ebf3ca-875f-429b-a31a-419c249b5566 --cap "$(orchestra token)" --body-file $TMPDIR/r.md'],
];

/** What a scribe may NEVER do (code edit, merge, push, deliver, init, delete, a check chained with a destructive act). */
export const SCRIBE_DENIED: ReadonlyArray<readonly [what: string, command: string]> = [
  ['gh pr merge', 'gh pr merge 12 --squash --match-head-commit abc'],
  ['git push', 'git push origin impl-foo-1'],
  ['git commit', 'git commit -am x'],
  ['fanout deliver', 'orchestra fanout deliver --branch b --into main --ticket 1 --review-verdict f --verified-head abc'],
  ['fanout state init', 'orchestra fanout state init --run r --target main'],
  ['state set --accept-merged (review MINOR 3)', 'orchestra fanout state set 476 --status merged --accept-merged "relay"'],
  ['state set --accept-merged after &&', 'cd /r && orchestra fanout state set 476 --accept-merged x --status merged'],
  ['workspace delete', 'orchestra delete impl-foo-1'],
  ['sed -i in the worktree', "sed -i 's/a/b/' src/a.ts"],
  ['redirect into the worktree', 'echo x > src/a.ts'],
  ['check chained with a destructive act', 'gh pr checks 12 && gh pr merge 12'],
];

test('#476: every scribe job the skill names is ALLOWED for a scribe through the installed hook', () => {
  const w = install('scribe');
  for (const [job, command] of SCRIBE_JOBS) {
    const r = sh(w, command);
    assert.equal(r.code, 0, `${job}: ${command} → ${r.code} ${r.err.trim()}`);
  }
  assert.equal(run(w, 'Write', { file_path: `${home}/.orchestra/agent-tmp/ws-1/c.md`, content: 'x' }).code, 0, 'a body file in scratch is writable');
});

test('#476: a scribe is still DENIED code edits, merges, pushes, deliver, state init, delete (must-FAIL arms)', () => {
  const w = install('scribe');
  for (const [what, command] of SCRIBE_DENIED) {
    const r = sh(w, command);
    assert.equal(r.code, 2, `${what}: ${command} → ${r.code}`);
    assert.match(r.err, /BLOCKED \(role: scribe\)/);
  }
  for (const t of ['Edit', 'Write', 'MultiEdit']) assert.equal(run(w, t, { file_path: `${w}/src/a.ts`, old_string: 'a', new_string: 'b', content: 'x' }).code, 2, `${t} in the worktree`);
});

test('#476: the relay is `state set` only — every OTHER role stays denied it, and init is denied to the scribe', () => {
  for (const role of ['implementer', 'verifier', 'reviewer', 'explorer']) {
    assert.equal(sh(install(role), SCRIBE_JOBS.find(([j]) => j.startsWith('state relay'))![1]).code, 2, role);
  }
  assert.equal(sh(install('coordinator'), 'orchestra fanout state init --run r --target main').code, 0);
});

test('#476: the skill names each scribe job (the probed list and the text cannot drift)', () => {
  for (const re of [/scribe-ledger/, /scribe-state/, /scribe-sweep/]) assert.match(VERIFIED_FANOUT_SKILL, re);
  assert.doesNotMatch(VERIFIED_FANOUT_SKILL, /scribe-ci/, '`fanout deliver` absorbs CI polling: not a scribe job (LEAD scope change)');
  for (const re of [/gh issue comment --body-file/, /fanout state set/, /scripts\/ledger-set/]) assert.match(VERIFIED_FANOUT_SKILL, re);
});
