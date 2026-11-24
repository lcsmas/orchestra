// #470 review m5: the guard-SCRIPT claims of the "Roles are typed" section, run through the real installed command (HOOK_ROLE_GUARD_CMD + the
// generated role-guard.sh of master) — verified-fanout-skill.test.ts only ties them to the role TABLE. Each claim has an allow AND a deny arm.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_ROLE_GUARD_CMD, ROLE_GUARD_SCRIPT, ROLE_SENTINEL_FILE } from './role-guard.ts';
import { renderVerifiedFanoutSkill } from './verified-fanout-skill.ts';
/** #559: the defaults changed (acceptance off, minorPolicy legacy) — these checks read the FULL text, every feature on (the strictest reading: word budget, pointers, rule pins). The default render is pinned in cli/fanout-switches.test.ts. */
const VERIFIED_FANOUT_SKILL = renderVerifiedFanoutSkill({ acceptance: 'on', minorPolicy: 'spec' });
import { mkHomeScratch } from './home-scratch.ts';

// NOT under os.tmpdir(): /tmp counts as scratch for the guard (same reason as role-guard.test.ts).
const root = mkHomeScratch('vf-guard-test-');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const scratch = path.join(home, '.orchestra', 'agent-tmp', 'ws-1');

function worktree(role: string | null, script = ROLE_GUARD_SCRIPT): string {
  const w = path.join(home, '.orchestra', 'worktrees', `vf-${role ?? 'none'}`);
  fs.mkdirSync(path.join(w, '.orchestra'), { recursive: true });
  fs.writeFileSync(path.join(w, '.orchestra', 'role-guard.sh'), script, { mode: 0o755 });
  if (role !== null) fs.writeFileSync(path.join(w, '.orchestra', ROLE_SENTINEL_FILE), role);
  return w;
}
function code(w: string, payload: object): number | null {
  return spawnSync('bash', ['-c', HOOK_ROLE_GUARD_CMD], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_WS_ID: 'ws-1', ORCHESTRA_WORKTREE: w },
  }).status;
}
const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } });
const edit = (file: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
const ask = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: {} };

type Role = 'coordinator' | 'implementer' | 'verifier' | 'reviewer' | 'explorer' | 'scribe';
const ALL: Role[] = ['coordinator', 'implementer', 'verifier', 'reviewer', 'explorer', 'scribe'];
const NOT_COORD = ALL.filter((r) => r !== 'coordinator');
const READONLY: Role[] = ['verifier', 'reviewer', 'explorer', 'scribe'];

/** [claim, role, payload-builder(worktree), expected exit code]. */
function matrix(): Array<[string, Role | null, (w: string) => object, 0 | 2]> {
  const m: Array<[string, Role | null, (w: string) => object, 0 | 2]> = [];
  for (const r of ALL) m.push([`AskUserQuestion denied: ${r}`, r, () => ask, 2]);
  for (const r of ['coordinator', 'reviewer', 'explorer', 'scribe'] as Role[]) m.push([`Edit in the worktree denied: ${r}`, r, (w) => edit(`${w}/src/a.ts`), 2]);
  m.push(['Edit in the worktree allowed: implementer', 'implementer', (w) => edit(`${w}/src/a.ts`), 0]);
  m.push(['Edit in the worktree denied: verifier (edits only scratch)', 'verifier', (w) => edit(`${w}/src/a.ts`), 2]);
  m.push(['Edit in scratch allowed: verifier', 'verifier', () => edit(`${scratch}/x.ts`), 0]);
  for (const r of READONLY) {
    m.push([`git push denied: ${r}`, r, () => bash('git push origin x'), 2]);
    m.push([`git commit denied in the worktree: ${r}`, r, () => bash('git commit -m x'), 2]);
    m.push([`git merge denied in the worktree: ${r}`, r, () => bash('git merge x'), 2]);
  }
  m.push(['verifier commits inside a scratch clone', 'verifier', () => bash(`cd ${scratch}/clone && git commit -m x`), 0]);
  m.push(['verifier rebases inside a scratch clone', 'verifier', () => bash(`cd ${scratch}/clone && git rebase origin/master`), 0]);
  m.push(['verifier push denied even inside a scratch clone', 'verifier', () => bash(`cd ${scratch}/clone && git push origin x`), 2]);
  m.push(['implementer: push of master denied', 'implementer', () => bash('git push origin master'), 2]);
  m.push(['implementer: push of its own branch allowed', 'implementer', () => bash('git push origin impl-x'), 0]);
  for (const r of NOT_COORD) m.push([`gh pr merge denied: ${r}`, r, () => bash('gh pr merge 1 --merge'), 2]);
  m.push(['gh pr merge allowed: coordinator', 'coordinator', () => bash('gh pr merge 1 --merge'), 0]);
  for (const r of NOT_COORD) m.push([`orchestra fanout deliver denied (it merges, #473): ${r}`, r, () => bash('orchestra fanout deliver --branch b --into master --ticket 1'), 2]);
  // #476: a scribe relays the coordinator's `state set` lines (init stays the coordinator's)
  m.push(['orchestra fanout state set allowed: scribe (the relay job, #476)', 'scribe', () => bash('orchestra fanout state set T1 --status merged'), 0]);
  m.push(['orchestra fanout state init denied: scribe', 'scribe', () => bash('orchestra fanout state init --run r --target master'), 2]);
  for (const r of NOT_COORD) { if (r !== 'scribe') m.push([`orchestra fanout state set denied: ${r}`, r, () => bash('orchestra fanout state set T1 --status merged'), 2]); m.push([`orchestra fanout state show allowed: ${r}`, r, () => bash('orchestra fanout state show'), 0]); }
  m.push(['orchestra fanout state set allowed: coordinator', 'coordinator', () => bash('orchestra fanout state set T1 --status merged'), 0]);
  m.push(['orchestra fanout deliver allowed: coordinator', 'coordinator', () => bash('orchestra fanout deliver --branch b --into master --ticket 1'), 0]);
  for (const r of NOT_COORD) { m.push([`orchestra delete denied: ${r}`, r, () => bash('orchestra delete ws-9'), 2]); m.push([`orchestra archive denied: ${r}`, r, () => bash('orchestra archive ws-9'), 2]); }
  m.push(['orchestra delete allowed: coordinator', 'coordinator', () => bash('orchestra delete ws-9'), 0]);
  for (const r of ALL) m.push([`check chained with a destructive act in ONE command denied: ${r}`, r, () => bash('orchestra verify-landed ws-9 && orchestra delete ws-9'), 2]);
  m.push(['the same two as separate calls: the check alone is allowed', 'coordinator', () => bash('orchestra verify-landed ws-9'), 0]);
  m.push(['inert without the sentinel: gh pr merge allowed', null, () => bash('gh pr merge 1'), 0]);
  m.push(['inert without the sentinel: AskUserQuestion allowed', null, () => ask, 0]);
  return m;
}

function drift(script: string): string[] {
  const out: string[] = [];
  for (const [claim, role, payload, want] of matrix()) {
    const w = worktree(role, script);
    const got = code(w, payload(w));
    if (got !== want) out.push(`${claim}: exit ${got}, want ${want}`);
  }
  return out;
}

test('the guard-script claims of the skill text hold against master\'s role-guard.sh (each with an allow and a deny arm)', () => {
  const m = matrix();
  assert.ok(m.some((c) => c[3] === 0) && m.some((c) => c[3] === 2) && m.length === 74, `${m.length} probes, both outcomes present`);
  assert.deepEqual(drift(ROLE_GUARD_SCRIPT), []);
  // the text still states what is probed
  for (const re of [/gh pr merge` and workspace delete\/archive to every role but the coordinator/, /a check[\s\S]*chained with a destructive act[\s\S]*in ONE command/, /a push of master\/main to an implementer/, /inert/, /`fanout state init\|set` to every role but the\s+coordinator/]) assert.match(VERIFIED_FANOUT_SKILL, re);
});

test('must-FAIL: a guard with the chain rule or every Bash rule removed (or an always-allow script) is seen', () => {
  const mutate = (re: RegExp, to: string): string => { const s = ROLE_GUARD_SCRIPT.replace(re, to); assert.notEqual(s, ROLE_GUARD_SCRIPT, `mutant anchor ${re} matches`); return s; };
  assert.ok(drift(mutate(/if chk '[^\n]*' && chk '[^\n]*'; then\n  deny "a check/, 'if false; then\n  deny "a check')).some((d) => /ONE command denied/.test(d)), 'no chain rule');
  assert.ok(drift(mutate(/\[ "\$tool" = Bash \] \|\| exit 0/, 'exit 0')).some((d) => /gh pr merge denied/.test(d)), 'no Bash rules at all');
  assert.ok(drift('#!/usr/bin/env bash\nexit 0\n').length > 40, 'an always-allow guard fails nearly every deny arm');
});
