import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_ROLE_GUARD_CMD, ROLE_GUARD_MATCHER, ROLE_GUARD_SCRIPT, ROLE_SENTINEL_FILE, toEre } from './role-guard.ts';
import { mkHomeScratch } from './home-scratch.ts';

// Runs the INSTALLED command string (HOOK_ROLE_GUARD_CMD, as settings.json carries it) through bash in a scratch worktree.
// NOT under os.tmpdir(): /tmp counts as scratch for the guard, so a /tmp root would make every "edit in a worktree" case vacuous.
const root = mkHomeScratch('rg-test-');
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
deny('implementer', 'env FOO=1 gh pr merge (assignment after the wrapper, #473)', bash('env FOO=1 gh pr merge 5'), /merging a PR/);
deny('implementer', 'Edit climbing out with ..', edit('Edit', `${wt}/../rg-other/a.ts`), /climbs out/);

// follow-up (review #468 m1–m4)
for (const role of ['coordinator', 'verifier', 'reviewer', 'explorer', 'scribe']) {
  deny(role, 'sed -i on a repo file', bash('sed -i s/a/b/ src/a.ts'), /sed -i edits files in place/);
  deny(role, 'redirect into the repo', bash('echo x > src/a.ts'), /shell write to 'src\/a\.ts'/);
  deny(role, 'cat >> into the repo', bash('cat patch >> README.md'), /shell write/);
  deny(role, 'tee into the repo', bash('git diff | tee src/a.ts'), /shell write/);
  allow(role, 'redirect to /dev/null and 2>&1', bash('ls nope 2>/dev/null; ls 2>&1 | head'));
  allow(role, 'redirect into $TMPDIR', bash('git diff > $TMPDIR/d.patch'));
  allow(role, 'redirect into agent-tmp', bash(`git diff > ${home}/.orchestra/agent-tmp/ws-1/d.patch`));
  allow(role, 'tee into /var/tmp', bash('git diff | tee /var/tmp/x/d.patch'));
  allow(role, 'sed -n (read only)', bash('sed -n 1,5p src/a.ts'));
  allow(role, 'sed into scratch after cd', bash('cd $TMPDIR/s && sed -i s/a/b/ f'));
  deny(role, 'rewriting .orchestra/role', bash('echo implementer > .orchestra/role'), /role guard's own wiring/);
  for (const cmd of ['rm .orchestra/role', 'mv .orchestra/role /var/tmp/x', 'cp /var/tmp/r .orchestra/role', 'truncate -s 0 .orchestra/role', 'rm .claude/settings.local.json',
    'chmod 000 .orchestra/role-guard.sh', 'tee .orchestra/role', 'sed -i s/a/b/ .claude/settings.local.json', 'ln -sf /dev/null .orchestra/role-guard.sh', 'ls && rm .orchestra/role', '(rm .orchestra/role)'])
    deny(role, `protect: ${cmd} (verb at command start or after a separator)`, bash(cmd), /role guard's own wiring|sed -i edits|shell write/);
  allow(role, 'reading the guard wiring', bash('cat .orchestra/role && ls .claude/settings.local.json'));
  deny(role, 'Edit of .orchestra/role', edit('Edit', `${wt}/.orchestra/role`), /role guard's own wiring/);
  deny(role, 'Edit of .claude/settings.local.json', edit('Write', `${wt}/.claude/settings.local.json`), /role guard's own wiring/);
}
for (const role of ['verifier', 'reviewer', 'explorer', 'scribe']) {
  deny(role, 'git apply', bash('git apply p.patch'), /rewrites the working tree/);
  deny(role, 'git checkout <ref> -- file', bash('git checkout origin/master -- f'), /rewrites the working tree/);
  deny(role, 'git cherry-pick', bash('git cherry-pick abc'), /rewrites the working tree/);
  deny(role, 'git clean -fdx', bash('git clean -fdx'), /rewrites the working tree/);
  allow(role, 'git apply --check', bash('git apply --check p.patch'));
  allow(role, 'git checkout --detach (the gate)', bash('git fetch -q origin && git checkout --detach FETCH_HEAD'));
  allow(role, 'git apply in a scratch clone', bash('cd $TMPDIR/s && git apply p.patch'));
}
allow('coordinator', 'merge / cherry-pick are the coordinator\'s job', bash('git merge --no-edit impl-x && git cherry-pick abc'));
deny('implementer', 'writing the role sentinel', bash('echo reviewer > .orchestra/role'), /role guard's own wiring/);
allow('implementer', 'redirects into its own worktree stay free', bash('echo x > src/a.ts && sed -i s/a/b/ src/a.ts'));
// m2: quoting and wrappers around the table rules
for (const [name, cmd] of [
  ['quoted branch', 'git push origin "master"'], ['bash -c wrapper', 'bash -c "cd x && git push origin master"'],
  ['ssh wrapper', 'ssh h "git push origin master"'], ['timeout wrapper', 'timeout 30 git push origin master'],
  ['absolute git', '/usr/bin/git push origin master'], ['git -c', 'git -c k=v push origin main'], ['eval', 'eval "git push origin main"'],
  ['no remote', 'git push master'],
] as const) deny('implementer', `push target branch: ${name}`, bash(cmd), /fleet-roles table/);
deny('implementer', 'gh -R pr merge', bash('gh -R o/r pr merge 3'), /merging a PR/);
deny('implementer', 'gh api .../merge', bash('gh api -X PUT repos/o/r/pulls/3/merge'), /merging a PR/);
// m3: heredoc BODIES are text, not commands; a `..` inside a file NAME is not traversal
allow('reviewer', 'ticket comment whose body lines start with table verbs', bash("gh issue comment 3 --body-file - <<'EOF'\ngit rebase onto master denied\ngit push origin master\nEOF"));
allow('coordinator', 'comment body with check + merge lines', bash("gh issue comment 3 --body-file - <<'EOF'\norchestra verify-landed ok\nthen gh pr merge 12\nEOF"));
deny('coordinator', 'a real chain AFTER a heredoc still trips', bash("cat <<'EOF' > $TMPDIR/x\nbody\nEOF\norchestra verify-landed a && orchestra delete b --yes"), /chained/);
allow('reviewer', 'Write to a scratch file named a..b.txt', edit('Write', `${scratchDir}/a..b.txt`));

// delta review #468: `>` inside quotes / arrows / [[ ]] is not a redirect; a quoted TARGET still is
for (const role of ['coordinator', 'reviewer', 'verifier']) {
  allow(role, 'gh --body "a -> b" (the ledger post itself)', bash('gh issue comment 471 --body "m1 -> fixed, x => y, count > 3"'));
  allow(role, "awk '$1 > 5' | jq select(.n > 3)", bash("awk '$1 > 5' f | jq 'select(.n > 3)'"));
  allow(role, 'node -e arrows and 1>0', bash('node -e "[1].map(x => x+1); console.log(1>0)"'));
  allow(role, '[[ a > b ]]', bash('[[ $a > $b ]] && echo ok'));
  allow(role, "git log --format='%h > %s'", bash("git log --format='%h > %s' -3"));
  allow(role, 'unquoted ~ redirect into agent-tmp', bash('echo x > ~/.orchestra/agent-tmp/ws-1/x'));
  deny(role, 'quoted redirect TARGET', bash('echo x > "src/a.ts"'), /shell write to 'src\/a\.ts'/);
  deny(role, "single-quoted redirect TARGET", bash("echo x > 'src/a.ts'"), /shell write to 'src\/a\.ts'/);
  deny(role, 'a quoted arrow AND a real redirect', bash('echo "a -> b" > src/a.ts'), /shell write/);
}
allow('coordinator', 'redirect into an auto-memory file', bash('cat > $HOME/.claude-mc/projects/-x/memory/a.md'));
for (const role of ['verifier', 'reviewer', 'explorer', 'scribe']) {
  allow(role, 'git branch -a --format=… (--format is not -f)', bash('git branch -a --format=%(refname)'));
  deny(role, 'git branch -f', bash('git branch -f x y'), /rewrites the working tree/);
  deny(role, '$((1<<n)) does not hide the next line', bash('echo $((1<<n))\ngit push origin master'), /fleet-roles table/);
  deny(role, 'a here-string does not hide the next line', bash('cat <<<"x" > /dev/null\ngit commit -m x'), /fleet-roles table/);
}

// delta2 review m1: a write INSIDE a quote wrapper / a quoted tee target / a spaced quoted path / `foo=>f` / `>|` is still a write
for (const role of ['coordinator', 'reviewer', 'verifier']) {
  deny(role, 'bash -c "… > repo file"', bash('bash -c "echo x > src/a.ts"'), /shell write to 'src\/a\.ts'/);
  deny(role, "bash -c '… > f'", bash("bash -c 'cat > f'"), /shell write/);
  deny(role, 'eval "… > f"', bash('eval "echo x > f"'), /shell write/);
  deny(role, 'ssh h "… > f"', bash('ssh h "cat > f"'), /shell write/);
  deny(role, 'tee "quoted target"', bash('echo x | tee "src/a.ts"'), /shell write to 'src\/a\.ts'/);
  deny(role, 'tee -a "f"', bash('echo x | tee -a "f"'), /shell write/);
  deny(role, '> "path with a space"', bash('echo x > "src/my file.ts"'), /shell write to 'src\/my file\.ts'/);
  deny(role, 'echo foo=>src/a.ts (a real redirect, not an arrow)', bash('echo foo=>src/a.ts'), /shell write to 'src\/a\.ts'/);
  deny(role, '>| clobber', bash('echo x >| f'), /shell write/);
  allow(role, 'bash -c writing into scratch', bash('bash -c "echo x > /var/tmp/q/f"'));
  allow(role, 'tee into scratch (quoted)', bash('echo x | tee "/var/tmp/q/f"'));
  allow(role, 'bash -c read-only', bash('bash -c "git log --oneline | head"'));
  allow(role, 'spaced arrow outside quotes', bash('echo a -> b'));
}

// follow-up review M1: only wrappers that EXECUTE their argument are unquoted — `-c` of grep/rg/psql/python is data, not a shell
for (const role of ['coordinator', 'reviewer', 'verifier']) {
  for (const cmd of ['grep -c ">" file', 'grep -c "a > b" f', "rg -c '=>' src", 'psql -c "select 1 where n > 3"', "psql -c 'select 1 where a>1'",
    'python3 -c "print(1>0)"', 'python -c "x=3; print(x>2)"', 'x | sort -c "x>y"', 'echo eval "a > b"', 'echo ssh h "a > b"', 'ssh host "echo $((3>2))"', 'echo $(( 5 > 3 ))'])
    allow(role, `data -c / arithmetic: ${cmd}`, bash(cmd));
  for (const cmd of ['bash -lc "echo x > f"', 'bash --login -c "echo x > f"', 'zsh -c "echo x > f"', 'sh -c "echo x > f"', '/bin/bash -c "echo x > f"', 'ssh -p 22 h "cat > f"', 'ssh -i k h "cat > f"',
    'sudo ssh h "cat > f"', 'cd x && eval "echo x > f"', 'cat a | sudo tee "f"'])
    deny(role, `executing wrapper: ${cmd}`, bash(cmd), /shell write/);
}

// #473: `orchestra fanout deliver` merges a PR through gh internally; `fanout state init|set` writes the coordinator's state file.
// Decision: deliver + state init/set denied to every non-coordinator role; state show / resume (read / reconcile) stay allowed to all.
const DELIVER = 'orchestra fanout deliver --branch impl-x --into master --ticket 473 --review-verdict v.json --verified-head abc';
for (const role of ['implementer', 'verifier', 'reviewer', 'explorer', 'scribe']) {
  deny(role, 'fanout deliver', bash(DELIVER), /fanout deliver opens and MERGES a PR.*coordinator/);
  for (const [name, cmd] of [
    ['after ;', `cd /r; ${DELIVER}`], ['after &&', `cd /r && ${DELIVER}`], ['after ||', `false || ${DELIVER}`], ['after a pipe', `echo x | ${DELIVER}`],
    ['bash -c', `bash -c "${DELIVER}"`], ['eval', `eval "${DELIVER}"`], ['ssh wrapper', `ssh h "${DELIVER}"`], ['sudo', `sudo ${DELIVER}`],
    ['env assignment', `FOO=1 ${DELIVER}`], ['env wrapper', `env FOO=1 ${DELIVER}`], ['env -i', `env -i PATH=$PATH ${DELIVER}`], ['bare + ;', 'orchestra fanout deliver; ls'], ['bare in bash -c', 'bash -c "orchestra fanout deliver"'], ['bare in eval single quotes', "eval 'orchestra fanout deliver'"], ['bare in subshell', '(orchestra fanout deliver)'], ['timeout', `timeout 60 ${DELIVER}`], ['subshell', `(${DELIVER})`],
    ['$( )', `x=$(${DELIVER})`], ['if/then', `if true; then ${DELIVER}; fi`], ['newline', `cd /r\n${DELIVER}`], ['extra spaces', 'orchestra   fanout   deliver --branch b'],
    ['bare deliver', 'orchestra fanout deliver'],
  ] as const) deny(role, `fanout deliver ${name}`, bash(cmd), /fanout deliver opens and MERGES/);
  // #476: a scribe relays the coordinator's `state set` lines; `init` stays denied to it
  const SETS = [['fanout state set', 'orchestra fanout state set 473 --status merged --pr 5'], ['fanout state set via bash -c', 'bash -c "orchestra fanout state set 1 --status x"'], ['bare state set in sh -c', "sh -c 'orchestra fanout state set'"]] as const;
  for (const [name, cmd] of SETS) { if (role === 'scribe') allow(role, `${name} (scribe relay)`, bash(cmd)); else deny(role, name, bash(cmd), /state file/); }
  deny(role, 'fanout state init (after &&)', bash('cd /r && orchestra fanout state init --run r1 --target master'), /state file/);
  deny(role, 'bare state init in bash -c', bash('bash -c "orchestra fanout state init"'), /state file/);
  allow(role, 'fanout state show', bash('orchestra fanout state show --json'));
  allow(role, 'fanout resume', bash('orchestra fanout resume --run r1 --no-write'));
  allow(role, 'fanout help', bash('orchestra fanout --help && orchestra help fanout'));
  allow(role, 'a comment MENTIONING fanout deliver', bash('gh issue comment 473 --body "the coordinator runs orchestra fanout deliver; state set is its too"'));
  allow(role, 'echo mentioning fanout deliver', bash("echo 'orchestra fanout deliver' > /dev/null"));
  allow(role, 'heredoc body with the verb', bash("gh issue comment 3 --body-file - <<'EOF'\norchestra fanout deliver --branch b\nEOF"));
  allow(role, 'grep for the verb', bash('grep -rn "orchestra fanout deliver" src'));
  allow(role, 'another orchestra fanout-ish word', bash('orchestra fanout-deliver-notes'));
}
// #479: `fanout open` opens the PR at nomination — coordinator-only like deliver (the flag form `deliver --open-only` rides deliver's rule).
const OPEN = 'orchestra fanout open --branch impl-x --into master --ticket 479';
for (const role of ['implementer', 'verifier', 'reviewer', 'explorer', 'scribe']) {
  for (const [name, cmd] of [['plain', OPEN], ['after &&', `cd /r && ${OPEN}`], ['bash -c', `bash -c "${OPEN}"`], ['bare', 'orchestra fanout open'], ['bare + ;', 'orchestra fanout open; ls']] as const) {
    deny(role, `fanout open ${name}`, bash(cmd), /fanout open opens the PR.*coordinator/);
  }
  deny(role, 'fanout deliver --open-only', bash(`${DELIVER.replace(' --review-verdict v.json --verified-head abc', '')} --open-only`), /fanout deliver opens and MERGES/);
  allow(role, 'a comment MENTIONING fanout open', bash('gh issue comment 479 --body "the coordinator runs orchestra fanout open at nomination"'));
  allow(role, 'another orchestra fanout-ish word', bash('orchestra fanout opener-notes'));
}
allow('coordinator', 'fanout open', bash(OPEN));
allow('(none)', 'fanout open (no sentinel: inert)', bash(OPEN));
test('#479 MUST-FAIL ARM: without the rule `fanout open` passes the installed command (and with it, every non-coordinator role is denied)', () => {
  const noRule = ROLE_GUARD_SCRIPT.split('orchestra[[:space:]]+fanout[[:space:]]+open(').join('orchestra[[:space:]]+NOFANOUTOPEN(');
  assert.notEqual(noRule, ROLE_GUARD_SCRIPT);
  for (const role of ['implementer', 'verifier', 'reviewer', 'explorer', 'scribe']) {
    assert.equal(run(install(noRule, role, `no-${role}`), bash(OPEN)).code, 0, `${role}: the rule-less guard must let open through`);
    const r = run(install(ROLE_GUARD_SCRIPT, role, `o-${role}`), bash(OPEN));
    assert.equal(r.code, 2); assert.match(r.err, /coordinator/);
  }
});

// #510: `fanout acceptance freeze|amend` writes a ticket's frozen acceptance tests — coordinator-only; `show` stays open to every role.
const FREEZE = 'orchestra fanout acceptance freeze 510 --files t/a.test.ts --run-cmd "node --test t/a.test.ts" --from impl-writer';
const AMEND = 'orchestra fanout acceptance amend 510 --decision https://github.com/o/r/issues/511#issuecomment-1 --spec-sentence "the carrier is optional" --files t/a.test.ts';
for (const role of ['implementer', 'verifier', 'reviewer', 'explorer', 'scribe']) {
  for (const [name, cmd] of [['freeze', FREEZE], ['amend', AMEND], ['freeze after &&', `cd /r && ${FREEZE}`], ['amend via bash -c', `bash -c "${AMEND}"`], ['bare freeze', 'orchestra fanout acceptance freeze'], ['bare amend + ;', 'orchestra fanout acceptance amend; ls']] as const) {
    deny(role, `fanout acceptance ${name}`, bash(cmd), /fanout acceptance freeze\|amend.*coordinator/);
  }
  allow(role, 'fanout acceptance show', bash('orchestra fanout acceptance show 510 --json'));
  allow(role, 'fanout gate --cwd', bash('orchestra fanout gate --branch b --into master --head abc --ticket 510 --cwd /r'));
  allow(role, 'a comment MENTIONING fanout acceptance freeze', bash('gh issue comment 510 --body "the coordinator runs orchestra fanout acceptance freeze at dispatch"'));
}
allow('coordinator', 'fanout acceptance freeze/amend/show', bash(`${FREEZE} && ${AMEND} && orchestra fanout acceptance show 510`));
allow('(none)', 'fanout acceptance freeze (no sentinel: inert)', bash(FREEZE));
test('#510 MUST-FAIL ARM: without the rule `fanout acceptance freeze|amend` passes the installed command (and with it, every non-coordinator role is denied)', () => {
  const noRule = ROLE_GUARD_SCRIPT.split('orchestra[[:space:]]+fanout[[:space:]]+acceptance[[:space:]]+(freeze|amend)(').join('orchestra[[:space:]]+NOACCEPTANCEVERB[[:space:]]+(freeze|amend)(');
  assert.notEqual(noRule, ROLE_GUARD_SCRIPT);
  for (const role of ['implementer', 'verifier', 'reviewer', 'explorer', 'scribe']) {
    for (const cmd of [FREEZE, AMEND]) {
      assert.equal(run(install(noRule, role, `na-${role}`), bash(cmd)).code, 0, `${role}: the rule-less guard must let it through`);
      const r = run(install(ROLE_GUARD_SCRIPT, role, `a-${role}`), bash(cmd));
      assert.equal(r.code, 2); assert.match(r.err, /coordinator/);
    }
  }
});

allow('coordinator', 'fanout deliver', bash(DELIVER));
allow('coordinator', 'fanout deliver in a chain', bash(`cd /r && ${DELIVER}`));
allow('coordinator', 'fanout deliver via bash -c', bash(`bash -c "${DELIVER}"`));
allow('coordinator', 'fanout state init/set/show + resume', bash('orchestra fanout state init --run r --target master && orchestra fanout state set 1 --status merged && orchestra fanout state show && orchestra fanout resume'));
allow('(none)', 'fanout deliver (no sentinel: inert)', bash(DELIVER));
allow('wizard', 'fanout deliver (unknown role: inert)', bash(DELIVER));

test('#473 MUST-FAIL ARM: without the rule `fanout deliver` passes the installed command (and with it, every non-coordinator role is denied)', () => {
  const noRule = ROLE_GUARD_SCRIPT.split('orchestra[[:space:]]+fanout[[:space:]]+deliver(').join('orchestra[[:space:]]+NOFANOUTVERB(');
  assert.notEqual(noRule, ROLE_GUARD_SCRIPT);
  for (const role of ['implementer', 'verifier', 'reviewer', 'explorer', 'scribe']) {
    assert.equal(run(install(noRule, role, `nd-${role}`), bash(DELIVER)).code, 0, `${role}: the rule-less guard must let deliver through`);
    const r = run(install(ROLE_GUARD_SCRIPT, role, `d-${role}`), bash(DELIVER));
    assert.equal(r.code, 2); assert.match(r.err, /coordinator/);
  }
});

function runMatrix(script: string, tag: string, firstOnly = false): string[] {
  const bad: string[] = [];
  for (const c of CASES) {
    const w = install(script, c.role === '(none)' ? null : c.role, `${tag}-${c.role}`);
    const r = run(w, c.payload);
    const ok = r.code === c.code && (c.code === 0 ? r.err === '' : /BLOCKED \(role: /.test(r.err) && !!c.msg && c.msg.test(r.err) && r.err.includes(`role: ${c.role}`));
    if (!ok) bad.push(`${c.role}: ${c.name} → rc=${r.code} ${r.err.slice(0, 120)}`);
    if (!ok && firstOnly) break; // a mutant only has to redden ONE case
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
  assert.match(push, /^\(\^\|\[;&\|\(\{\]/, 'starts at a command boundary');
  assert.ok(push.includes('git[[:space:]]+((-C|-c)[[:space:]]+[^[:space:]]+[[:space:]]+)*push([[:space:]]|$)(([^;&|]*[[:space:]:"\'\\\\]|[^;&|]*refs/heads/)?)(master|main)'), push);
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
    ['fanout deliver rule removed', 'orchestra[[:space:]]+fanout[[:space:]]+deliver(', 'orchestra[[:space:]]+NOFANOUTVERB('],
    ['fanout state write rule removed', 'fanout[[:space:]]+state[[:space:]]+(init|set)', 'fanout[[:space:]]+state[[:space:]]+NOVERB'],
    ['scratch exemption admits ..', '*/../*|*/..) scratch=0 ;;', '*/../*|*/..) scratch=1 ;;'],
    ['unquote after ANY -c (grep -c ">" reads as a redirect)', 'nm == "dash" || nm == "ksh") code_operand', 'nm == "dash" || nm == "ksh" || nm == "grep" || nm == "psql" || nm == "python3" || nm == "rg") code_operand'],
    ['shell wrappers are never unquoted (bash -c "… > f" invisible)', 'nm == "dash" || nm == "ksh") code_operand', 'nm == "dash" || nm == "ksh") nm = nm'],
    ['tee targets are not judged', 'if (base == "tee") {', 'if (base == "tee") { return }\n  if (0) {'],
    ['arrow blank eats foo=>f', '(P < 3 || ws(substr(S, P - 2, 1)))', '1'],
    ['quoted > counts as a redirect', 'if (c == "\\"") { wq = 1; dqparse(); continue }', 'if (c == "\\"") { P++; continue }'],
    ['here-strings open a heredoc', 'gsub(/<<</, "", c);', ''],
    ['git branch --format reads as -f', 'branch[[:space:]]+([^;&|]*[[:space:]])?(-f|--force)([[:space:]]|$))', 'branch[[:space:]]+[^;&|]*(-f|--force))'],
    ['heredoc bodies are scanned as commands', '| awk "$awk_prog" |', '| cat |'],
    ['redirect targets are never judged', 'judge("W", wd, wv, bd)', 'wv = wv'],
    ['sed -i is allowed', 'if (!inpl) return', 'return'],
    ['the guard wiring is editable', "*/.orchestra/role|*/.orchestra/role-guard.sh|*/.claude/settings.json|*/.claude/settings.local.json)", "*/.orchestra/NEVER)"],
    ['the table\'s bashDeny rules are never evaluated', 'if ! { [ "$in_scratch" = 1 ] && [ "$i" -lt "$n_table" ]; } && chk', 'if false && chk'],
    ['scratch-clone exemption removed', 'then in_scratch=1; fi', 'then in_scratch=0; fi'],
    ['scratch-clone exemption admits a push', '&& ! chk \'', '&& ! chk \'NEVERMATCH'],
    ['implementer may edit another workspace', 'deny "\'$fp\' belongs to another workspace', 'exit 0; deny "\'$fp\' belongs to another workspace'],
  ];
  for (const [name, from, to] of mutants) {
    assert.ok(ROLE_GUARD_SCRIPT.includes(from), `mutant "${name}": anchor string not found in the live script`);
    const bad = runMatrix(ROLE_GUARD_SCRIPT.replace(from, to), `m${name.length}`, true);
    assert.ok(bad.length > 0, `mutant "${name}" survived — the matrix cannot see it`);
  }
});
