// #498 — the role guard refuses a host-wide kill by name/pattern, through the INSTALLED hook script (real bash, real PreToolUse JSON).
// SAFETY: the guard only READS the command (JSON data) and never runs it; stub `pkill`/`killall`/`kill` are put first on the hook's PATH as
// defence in depth only (bash may re-order PATH — the real proof is the canary in the must-FAIL arm). No test ever executes pkill/killall.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_ROLE_GUARD_CMD, ROLE_GUARD_SCRIPT, ROLE_SENTINEL_FILE } from './role-guard.ts';
import { FLEET_ROLES } from './fleet-roles.ts';
import { mkHomeScratch } from './home-scratch.ts';

const root = mkHomeScratch('rg-hk-');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
const calls = path.join(root, 'stub-calls.txt');
fs.mkdirSync(stubs, { recursive: true });
for (const n of ['pkill', 'killall', 'kill', 'pgrep']) fs.writeFileSync(path.join(stubs, n), `#!/bin/sh\necho "${n} $*" >> "${calls}"\n`, { mode: 0o755 });

function install(script: string, role: string | null, name: string): string {
  const w = path.join(home, '.orchestra', 'worktrees', `hk-${name}`);
  fs.mkdirSync(path.join(w, '.orchestra'), { recursive: true });
  fs.writeFileSync(path.join(w, '.orchestra', 'role-guard.sh'), script, { mode: 0o755 });
  if (role !== null) fs.writeFileSync(path.join(w, '.orchestra', ROLE_SENTINEL_FILE), role);
  return w;
}
function run(w: string, command: string) {
  const payload = { session_id: 's', cwd: w, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } };
  const r = spawnSync('bash', ['-c', HOOK_ROLE_GUARD_CMD], {
    input: JSON.stringify(payload),
    env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home, ORCHESTRA_WS_ID: 'ws-1', ORCHESTRA_WORKTREE: w },
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr };
}
const stubCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');

const DENY = [
  'pkill -f jest', 'pkill jest', 'pkill -9 -f "vitest|jest"', 'killall node', 'killall -9 node', 'sudo pkill -f jest', '/usr/bin/pkill -f jest',
  'cd /r && pkill -f jest; echo done', 'timeout 5 pkill -f jest', 'bash -c "pkill -f jest"', 'echo jest | xargs pkill -f', 'pkill -P 1234',
  'kill $(pgrep -f jest)', 'kill -9 $(pgrep jest)', 'kill -9 "$(pidof node)"', 'kill `pgrep -f jest`', "kill -9 $(ps aux | grep jest | awk '{print $2}')",
  'pgrep -f jest | xargs kill', 'pgrep -f jest | xargs kill -9', 'pgrep jest | sudo xargs kill',
  'for p in $(pgrep -f jest); do kill $p; done', 'pids=$(pgrep -f jest); kill -9 $pids', 'pgrep -f jest | while read p; do kill $p; done',
  'sudo -u root pkill x', 'timeout -k 5 10 pkill x', 'timeout -s KILL 10 pkill x', 'nice pkill x', 'setsid pkill x', 'ionice -c3 pkill x',
  'nohup setsid pkill x', '/usr/bin/env pkill x', '\\pkill x', '"pkill" -f x', 'busybox killall node', 'skill -9 node', 'fuser -k 3000/tcp',
  'kill $(lsof -ti:3000)', 'lsof -t :3000 | xargs kill', 'kill -9 -1', "ps aux | grep jest | awk '{print $2}' | xargs kill -9",
];
const ALLOW = [
  'kill 1234', 'kill -9 1234', 'kill -- -1234', 'kill -TERM -- -$pgid', 'kill $!', 'kill $(cat "$TMPDIR/x.pid")', 'kill $JEST_PID',
  'pgrep -f jest', 'ps aux | grep jest', 'kill $pid || echo "still alive: $(ps -p $pid -o pid=)"', 'pgrep -f jest; kill 1234',
  'gh issue comment 1 --body "avoid xargs pkill"', 'git log --grep "use xargs pkill"', 'grep -rn "xargs killall" src', 'echo "run skill later"',
  'kill -- -$(cat "$TMPDIR/pgid")', 'kill -9 -1234', 'echo hi | xargs echo', 'pkillx', 'ls killall-notes',
  'gh issue comment 498 --body "never pkill -f or killall node host-wide"', 'git log --grep "refuse pkill -f"',
  'grep -rn pkill src', 'cat <<EOF\npkill -f jest\nEOF',
];

for (const role of FLEET_ROLES) {
  test(`#498 [${role}] denies host-wide kills (and no stub is ever called)`, () => {
    const w = install(ROLE_GUARD_SCRIPT, role, role);
    for (const c of DENY) {
      const r = run(w, c);
      assert.equal(r.code, 2, `${c} → ${r.code} ${r.err}`);
      assert.match(r.err, /^\[orchestra\] BLOCKED \(role: /);
      assert.match(r.err, /kill <pid>.*kill -- -<pgid>/);
    }
    assert.equal(stubCalls(), '', 'the hook must never execute the command');
  });
  test(`#498 [${role}] allows own-pid / own-pgid kills and mere mentions`, () => {
    const w = install(ROLE_GUARD_SCRIPT, role, role);
    for (const c of ALLOW) { const r = run(w, c); assert.equal(r.code, 0, `${c} → ${r.code} ${r.err}`); assert.equal(r.err, ''); }
  });
}

test('#498 INERT without the sentinel / unknown role (LEAD, humans)', () => {
  for (const [role, n] of [[null, 'none'], ['wizard', 'wiz']] as const) {
    const w = install(ROLE_GUARD_SCRIPT, role, `inert-${n}`);
    for (const c of DENY) assert.equal(run(w, c).code, 0, `${role}: ${c}`);
  }
});

test("#498 a scratch `cd` does not lift the kill rule (this module's own rule, not the table's)", () => {
  const w = install(ROLE_GUARD_SCRIPT, 'verifier', 'scratch');
  assert.equal(run(w, 'cd $TMPDIR/clone && pkill -f jest').code, 2);
});

test('#498 MUST-FAIL ARM: without the rule the denied calls pass — and the hook still kills nothing (it never executes the command)', () => {
  const noRule = ROLE_GUARD_SCRIPT.split('(pkill|killall|skill)').join('(NOPKILL|NOKILLALL|NOSKILL)').split('(pgrep|pidof)').join('(NOPGREP|NOPIDOF)'); // every pkill/killall alternative gone
  assert.notEqual(noRule, ROLE_GUARD_SCRIPT);
  const w = install(noRule, 'verifier', 'norule');
  const canary = path.join(root, 'canary');
  // The command text is JSON DATA: the hook only greps it. `touch canary` runs ONLY if the hook executed it (positive control below).
  // NEVER execute `pkill`/`killall` here, not even under a stubbed PATH: bash re-orders PATH on this host (measured: /bin/pkill won).
  for (const c of [`touch ${canary}; pkill -f jest`, `touch ${canary}; killall node`]) assert.equal(run(w, c).code, 0, `${c}: the rule-less guard must let it through`);
  assert.ok(!fs.existsSync(canary), 'the hook executed the command text');
  spawnSync('bash', ['-c', `touch ${canary}`]);
  assert.ok(fs.existsSync(canary), 'positive control: the canary can be written, so its absence above means something');
  assert.equal(stubCalls(), '');
});

test('#498 each clause is load-bearing: mutating one alternative lets its own cases through', () => {
  const clauses: Array<[string, string, string[]]> = [
    ['pkill|killall|skill', '(pkill|killall|skill)', ['pkill -f jest', 'killall node']],
    ['xargs pkill', 'xargs[[:space:]]+([^;&|]*[[:space:]])?(pkill', ['echo jest | xargs pkill -f']],
    ['fuser -k', 'fuser[[:space:]]', ['fuser -k 3000/tcp']],
    ['kill -1', '-1([[:space:];&|)', ['kill -9 -1']],
    ['kill $(pgrep)', '[^)`]*(pgrep|pidof|ps|lsof)[[:space:]]', ['kill $(pgrep -f jest)', 'kill `pgrep -f jest`', 'kill -9 $(lsof -ti:3000)']],
    ['var/loop hop', '(pgrep|pidof)[[:space:]].*', ['pids=$(pgrep -f jest); kill -9 $pids', 'for p in $(pgrep -f jest); do kill $p; done']],
    ['pgrep | xargs kill', '\\|[[:space:]]*(sudo[[:space:]]+)?xargs', ['pgrep -f jest | xargs kill', 'pgrep jest | sudo xargs kill']],
    ['pgrep | while', '\\|[[:space:]]*while', ['pgrep -f jest | while read p; do kill $p; done']],
    ['wrapper options', '(/[^[:space:]]*/)?(sudo|timeout|nice', ['sudo -u root pkill x', 'timeout -k 5 10 pkill x', 'nice pkill x']],
  ];
  for (const [name, anchor, cases] of clauses) {
    assert.ok(ROLE_GUARD_SCRIPT.includes(anchor), `${name}: anchor missing`);
    const mut = ROLE_GUARD_SCRIPT.split(anchor).join(anchor.replace(/pkill|killall|skill|xargs|pgrep|fuser|while|-1|sudo|nice|pidof|lsof|timeout/g, 'NOPE'));
    assert.notEqual(mut, ROLE_GUARD_SCRIPT);
    const w = install(mut, 'verifier', `mut-${name.length}`);
    for (const c of cases) assert.equal(run(w, c).code, 0, `${name}: mutant survived on ${c}`);
  }
  assert.equal(stubCalls(), '');
});
