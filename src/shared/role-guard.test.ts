import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HOOK_ROLE_GUARD_CMD, ROLE_GUARD_MATCHER, ROLE_GUARD_SCRIPT, ROLE_SENTINEL_FILE, toEre } from './role-guard.ts';

// Runs the INSTALLED command string (HOOK_ROLE_GUARD_CMD, as settings.json carries it) through bash in a scratch worktree.
// NOT under os.tmpdir(): /tmp counts as scratch for the guard, so a /tmp root would make every "edit in a worktree" case vacuous.
const root = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.rg-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const wt = '@WT@'; // the worktree the case runs in (its own worktree), substituted by run()
const other = path.join(home, '.orchestra', 'worktrees', 'impl-other-bbbb2222');
const scratchDir = path.join(home, '.orchestra', 'agent-tmp', 'ws-1');

/** One worktree per script variant so a mutant never touches the baseline. */
function install(script: string, role: string | null, name = 'main'): string {
  const w = path.join(home, '.orchestra', 'worktrees', `rg-${name}`);
  fs.mkdirSync(path.join(w, '.orchestra'), { recursive: true });
  fs.writeFileSync(path.join(w, '.orchestra', 'role-guard.sh'), script, { mode: 0o755 });
  if (role !== null) fs.writeFileSync(path.join(w, '.orchestra', ROLE_SENTINEL_FILE), role);
  return w;
}
function run(w: string, payload: unknown, cmd = HOOK_ROLE_GUARD_CMD) {
  const r = spawnSync('bash', ['-c', cmd], {
    input: (typeof payload === 'string' ? payload : JSON.stringify(payload)).split('@WT@').join(w),
    env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_WS_ID: 'ws-1', ORCHESTRA_WORKTREE: w },
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr };
}
const bash = (command: string) => ({
  session_id: 's', transcript_path: `${home}/.claude/p/s.jsonl`, cwd: wt, hook_event_name: 'PreToolUse',
  tool_name: 'Bash', tool_input: { command, description: 'x' },
});
const tool = (tool_name: string, tool_input: Record<string, unknown> = {}) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input });
const edit = (t: string, file: string) => tool(t, t === 'NotebookEdit' ? { notebook_path: file, new_source: 'x' } : { file_path: file, old_string: 'a', new_string: 'b', content: 'x' });

interface Case { role: string; name: string; payload: unknown; code: 0 | 2; msg?: RegExp }
const CASES: Case[] = [];
const deny = (role: string, name: string, payload: unknown, msg: RegExp) => CASES.push({ role, name, payload, code: 2, msg });
const allow = (role: string, name: string, payload: unknown) => CASES.push({ role, name, payload, code: 0 });

// INERT: no sentinel / an unknown role word ⇒ nothing is ever denied (human sessions, the LEAD, role-less agents).
for (const role of ['(none)', 'wizard']) {
  allow(role, 'AskUserQuestion', tool('AskUserQuestion'));
  allow(role, 'Edit on code', edit('Edit', `${wt}/src/a.ts`));
  allow(role, 'gh pr merge', bash('gh pr merge 1'));
}
// D6 — AskUserQuestion is denied to EVERY fleet role, the coordinator included.
for (const role of ['coordinator', 'implementer', 'verifier', 'reviewer', 'explorer', 'scribe']) {
  deny(role, 'AskUserQuestion', tool('AskUserQuestion', { questions: [] }), /AskUserQuestion is not available/);
}
// coordinator: no code edits; scratch + memory stay writable; Bash is free except the chain rule.
for (const t of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) deny('coordinator', `${t} on code`, edit(t, `${wt}/src/a.ts`), /never edits files/);
allow('coordinator', 'Write in its agent-tmp scratch', edit('Write', `${scratchDir}/notes.md`));
allow('coordinator', 'Write a memory file', edit('Write', `${home}/.claude-mc/projects/-x/memory/m.md`));
deny('coordinator', 'scratch path with ..', edit('Write', `${scratchDir}/../../../worktrees/x/a.ts`), /never edits files/);
allow('coordinator', 'orchestra delete (alone)', bash('orchestra delete abc --yes'));
allow('coordinator', 'gh pr merge (alone)', bash('gh pr merge 12 --squash'));
allow('coordinator', 'verify-landed (alone)', bash('orchestra verify-landed impl-x'));
allow('coordinator', 'git branch -D (alone)', bash('git branch -D old-x'));
allow('coordinator', 'a ticket comment MENTIONING both verbs', bash('gh issue comment 471 -b "after gh pr checks, never gh pr merge in one command"'));
// the chain rule — every role, every separator
for (const role of ['coordinator', 'implementer', 'verifier']) {
  deny(role, 'verify-landed && delete', bash('orchestra verify-landed impl-x && orchestra delete abc --yes'), /ONE command|belongs to the coordinator/);
  deny(role, 'gh pr checks ; merge', bash('gh pr checks 5; gh pr merge 5'), /ONE command|merging a PR/);
}
deny('coordinator', 'check && merge', bash('gh pr checks 5 && gh pr merge 5 --squash'), /chained with a destructive act/);
deny('coordinator', 'check || force-push', bash('gh pr checks 5 || git push --force-with-lease origin x'), /chained/);
deny('coordinator', 'rev-list then branch -D (newline)', bash('git rev-list --count a..b\ngit branch -D x'), /chained/);
deny('coordinator', 'ls-remote | worktree remove', bash('cd /r && git ls-remote origin x && git worktree remove /w'), /chained/);
deny('coordinator', 'env-prefixed verify-landed + sudo-less delete', bash('FOO=1 orchestra verify-landed x; orchestra archive abc'), /chained/);
allow('coordinator', 'check chained with a non-destructive act', bash('git fetch && git rev-list --count HEAD..origin/master'));
// implementer
allow('implementer', 'Edit in its own worktree', edit('Edit', `${wt}/src/a.ts`));
allow('implementer', 'Edit a relative path', edit('Edit', 'src/a.ts'));
allow('implementer', 'Write to /tmp', edit('Write', '/tmp/rig/x.sh'));
deny('implementer', "Edit in another workspace's worktree", edit('Edit', `${other}/src/a.ts`), /belongs to another workspace/);
deny('implementer', 'gh pr merge', bash('gh pr merge 12 --squash'), /merging a PR belongs to the coordinator/);
deny('implementer', 'gh pr merge after cd', bash('cd /r && gh pr merge 12'), /merging a PR/);
deny('implementer', 'git push origin master', bash('git push origin master'), /fleet-roles table/);
deny('implementer', 'git push HEAD:main', bash('git push -u origin HEAD:main'), /fleet-roles table/);
deny('implementer', 'orchestra delete', bash('orchestra delete other --yes'), /belongs to the coordinator/);
deny('implementer', 'orchestra archive', bash('orchestra archive other'), /belongs to the coordinator/);
allow('implementer', 'push its own branch', bash('git push -u origin impl-role-guard-468'));
allow('implementer', 'force-push its own branch (alone)', bash('git push --force-with-lease origin impl-role-guard-468'));
allow('implementer', 'commit', bash('git commit -m x'));
allow('implementer', 'a comment MENTIONING gh pr merge', bash('gh issue comment 3 -b "do not gh pr merge yourself"'));
// verifier: edits only scratch
deny('verifier', 'Edit in its worktree', edit('Edit', `${wt}/src/a.ts`), /edits only scratch/);
deny('verifier', 'Write a code file', edit('Write', '/home/x/repo/a.ts'), /edits only scratch/);
deny('verifier', '/tmp path with ..', edit('Write', '/tmp/../home/x/a.ts'), /edits only scratch/);
allow('verifier', 'Write in its scratch dir', edit('Write', `${scratchDir}/rig.sh`));
allow('verifier', 'Write to /tmp', edit('Write', '/tmp/v/x.txt'));
deny('verifier', 'git push', bash('git push origin x'), /fleet-roles table/);
deny('verifier', 'git commit', bash('git commit -am x'), /fleet-roles table/);
deny('verifier', 'gh pr merge', bash('gh pr merge 1'), /merging a PR/);
allow('verifier', 'git log + status', bash('git status --short && git log --oneline -3'));
allow('verifier', 'the gate commands', bash('npx tsc --noEmit && pnpm run test'));
// reviewer / explorer / scribe: read-only
for (const role of ['reviewer', 'explorer', 'scribe']) {
  deny(role, 'Edit code', edit('Edit', `${wt}/src/a.ts`), /never edits files/);
  deny(role, 'git commit', bash('git commit -m x'), /fleet-roles table/);
  deny(role, 'gh pr merge', bash('gh pr merge 1'), /merging a PR/);
  allow(role, 'read-only Bash', bash('git diff origin/master...HEAD | wc -l && grep -rn foo src'));
  allow(role, 'Write to its scratch', edit('Write', `${scratchDir}/probe.txt`));
}

// pre-review round 1: table rules are anchored at a command boundary and match the branch NAME / the verb exactly
allow('verifier', 'git merge-base (not git merge)', bash('git merge-base --is-ancestor a b && git merge-base HEAD origin/master'));
allow('reviewer', 'a quoted MENTION of a table verb', bash('gh pr review 3 -b "git commit msg, never git reset"'));
allow('reviewer', 'a pipe into grep for a table verb', bash('git log --oneline | grep "git reset"'));
allow('implementer', 'echo mentioning git push to main', bash('echo "never git push to main"'));
allow('implementer', 'push a branch NAMED *main*', bash('git push origin impl-main-fix'));
allow('implementer', 'push feature/master-detector', bash('git push origin feature/master-detector'));
allow('verifier', 'rebase inside a scratch clone (cd)', bash(`cd ${home}/.orchestra/agent-tmp/ws-1/s && git rebase origin/x && git reset --hard origin/x`));
allow('verifier', 'merge inside a scratch clone (-C $TMPDIR)', bash('git -C $TMPDIR/s merge --no-edit x'));
deny('verifier', 'push from a scratch clone is still denied', bash(`cd ${home}/.orchestra/agent-tmp/ws-1/s && git push origin x`), /fleet-roles table/);
deny('verifier', 'rebase in the repo (no scratch cd)', bash('git rebase origin/master'), /fleet-roles table/);
deny('verifier', 'git -C <repo> commit', bash('git -C /r commit -m x'), /fleet-roles table/);
deny('implementer', 'git -C x push origin master', bash('git -C x push origin master'), /fleet-roles table/);
deny('implementer', 'push HEAD:refs/heads/main', bash('git push origin HEAD:refs/heads/main'), /fleet-roles table/);
deny('implementer', 'gh pr merge inside if/then', bash('if true; then gh pr merge 5; fi'), /merging a PR/);
deny('implementer', 'gh pr merge via bash -c', bash('bash -c "gh pr merge 5"'), /merging a PR/);
deny('implementer', 'command gh pr merge', bash('command gh pr merge 5'), /merging a PR/);
deny('implementer', 'env-prefixed gh pr merge', bash('FOO=1 env gh pr merge 5'), /merging a PR/);
deny('implementer', 'Edit climbing out with ..', edit('Edit', `${wt}/../rg-other/a.ts`), /climbs out/);

function runMatrix(script: string, tag: string): string[] {
  const bad: string[] = [];
  for (const c of CASES) {
    const w = install(script, c.role === '(none)' ? null : c.role, `${tag}-${c.role}`);
    const r = run(w, c.payload);
    const ok = r.code === c.code && (c.code === 0 ? r.err === '' : /BLOCKED \(role: /.test(r.err) && !!c.msg && c.msg.test(r.err) && r.err.includes(`role: ${c.role}`));
    if (!ok) bad.push(`${c.role}: ${c.name} → rc=${r.code} ${r.err.slice(0, 120)}`);
  }
  return bad;
}

for (const c of CASES) {
  test(`${c.code === 2 ? 'denies' : 'allows'} [${c.role}] ${c.name}`, () => {
    const r = run(install(ROLE_GUARD_SCRIPT, c.role === '(none)' ? null : c.role, `t-${c.role}`), c.payload);
    assert.equal(r.code, c.code, r.err);
    if (c.code === 2) {
      assert.match(r.err, /^\[orchestra\] BLOCKED \(role: /);
      assert.match(r.err, c.msg!);
      assert.ok(r.err.includes(`role: ${c.role}`), r.err);
    } else assert.equal(r.err, '');
  });
}

test('INERT without the sentinel, with an unknown role word, on garbage stdin', () => {
  const ask = tool('AskUserQuestion');
  assert.equal(run(install(ROLE_GUARD_SCRIPT, null, 'norole'), ask).code, 0);
  assert.equal(run(install(ROLE_GUARD_SCRIPT, 'wizard', 'badrole'), ask).code, 0);
  assert.equal(run(install(ROLE_GUARD_SCRIPT, 'implementer', 'garb'), 'not json').code, 0);
  assert.equal(run(install(ROLE_GUARD_SCRIPT, 'implementer', 'empty'), '').code, 0);
  // control: the very same payload IS denied once the sentinel names a role (the instrument can say FAIL)
  assert.equal(run(install(ROLE_GUARD_SCRIPT, 'implementer\r\n', 'crlf'), ask).code, 2);
});

test('the installed command has no `|| true` and exits 0 when the script is absent', () => {
  assert.ok(!/\|\|\s*true/.test(HOOK_ROLE_GUARD_CMD), HOOK_ROLE_GUARD_CMD);
  const empty = path.join(home, '.orchestra', 'worktrees', 'rg-none');
  fs.mkdirSync(empty, { recursive: true });
  assert.equal(run(empty, tool('AskUserQuestion')).code, 0);
  assert.equal(ROLE_GUARD_MATCHER, 'Bash|Edit|MultiEdit|Write|NotebookEdit|AskUserQuestion');
});

test('MUST-FAIL ARM: the same command with `|| true` appended lets the denied call through', () => {
  const w = install(ROLE_GUARD_SCRIPT, 'coordinator', 'ortrue');
  const denied = tool('AskUserQuestion');
  assert.equal(run(w, denied).code, 2);
  const swallowed = run(w, denied, `${HOOK_ROLE_GUARD_CMD} || true`);
  assert.equal(swallowed.code, 0, 'the broken form must be able to PASS the deny — else this test proves nothing');
  assert.match(swallowed.err, /BLOCKED/); // the script still denied; only the exit code was swallowed
});

test('toEre: the table regex sources translate to ERE (boundary-anchored, exact branch name, merge != merge-base)', () => {
  const push = toEre('\\bgit\\s+push\\b[^\\n]*\\b(master|main)\\b');
  assert.match(push, /^\(\^\|\[;&\|\(\{`\]/, 'starts at a command boundary');
  assert.ok(push.includes('git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?push([[:space:]]|$)[^;&|]*([[:space:]:]|refs/heads/)(master|main)'), push);
  const grepE = (re: string, text: string) => spawnSync('grep', ['-qE', '--', re], { input: text }).status === 0;
  const nc = toEre('\\bgit\\s+(commit|push|merge|rebase|reset)\\b');
  assert.ok(grepE(nc, 'git merge x') && !grepE(nc, 'git merge-base a b') && !grepE(nc, 'echo "git merge x"') && grepE(nc, 'cd r && git reset --hard'));
});

// MUTANTS: each breaks one clause of the script; the matrix above must redden (and the baseline must be clean).
test('baseline matrix is clean; every mutant reddens it', () => {
  assert.deepEqual(runMatrix(ROLE_GUARD_SCRIPT, 'base'), []);
  const mutants: Array<[string, string, string]> = [
    ['deny does not exit 2', 'echo "[orchestra] BLOCKED (role: $role): $1" >&2; exit 2;', 'echo "[orchestra] BLOCKED (role: $role): $1" >&2; exit 0;'],
    ['no sentinel / unknown role defaults to implementer', '*) exit 0 ;;\nesac', '*) role=coordinator; deny_tools=" AskUserQuestion "; edit_mode=none ;;\nesac'],
    ['chain rule needs only the destructive half', "&& chk '", "|| chk '"],
    ['edit_mode none no longer denies', '      none)\n        deny', '      none)\n        exit 0; deny'],
    ['scratch exemption admits ..', '*..*) scratch=0 ;;', '*..*) scratch=1 ;;'],
    ['the table\'s bashDeny rules are never evaluated', 'if ! { [ "$in_scratch" = 1 ] && [ "$i" -lt "$n_table" ]; } && chk', 'if false && chk'],
    ['scratch-clone exemption removed', 'then in_scratch=1; fi', 'then in_scratch=0; fi'],
    ['scratch-clone exemption admits a push', '&& ! chk \'', '&& ! chk \'NEVERMATCH'],
    ['implementer may edit another workspace', 'deny "\'$fp\' belongs to another workspace', 'exit 0; deny "\'$fp\' belongs to another workspace'],
  ];
  for (const [name, from, to] of mutants) {
    assert.ok(ROLE_GUARD_SCRIPT.includes(from), `mutant "${name}": anchor string not found in the live script`);
    const bad = runMatrix(ROLE_GUARD_SCRIPT.replace(from, to), `m${name.length}`);
    assert.ok(bad.length > 0, `mutant "${name}" survived — the matrix cannot see it`);
  }
});
