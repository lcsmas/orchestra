// #683 — the loop owns the ticket branch name: creation in the target repo, the brief, the implementer push guard, the separator-twin adoption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptBranchTwins, type LoopCtx } from './fanout-loop.ts';
import { withLoop } from './fanout-loop-side.ts';
import { createLiveGit } from './fanout-loop-live-git.ts';
import { renderImplementerBrief } from './fanout-implementer-brief.ts';
import { buildRoleGuardScript } from './role-guard.ts';
import { applyTicketPatch, newState, stateFile, writeStateAtomic, type FanoutState } from './fanout-state.ts';
import { startRun, type StartDeps } from './fanout-start.ts';
import { ensureTicketBranch, separatorTwin, ticketBranchCheckout, type GhRun } from './fanout-ticket-branch.ts';

const NOW = '2026-11-25T10:00:00.000Z';
const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const tmp = (t: { after: (f: () => void) => void }): string => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ticket-branch-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

function fakeGh(refs: Record<string, string>, opts: { postFails?: boolean } = {}): { gh: GhRun; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRun = async (args) => {
    calls.push(args);
    const m = /git\/ref\/heads\/(.+)$/.exec(args[1] ?? '');
    if (args[1] === '-X') { if (opts.postFails) return { code: 1, stdout: '', stderr: 'boom' }; const ref = args[args.indexOf('-f') + 1].slice('ref=refs/heads/'.length); refs[ref] = args[args.lastIndexOf('-f') + 1].slice(4); return { code: 0, stdout: '{}', stderr: '' }; }
    return m && refs[m[1]] ? { code: 0, stdout: refs[m[1]] + '\n', stderr: '' } : { code: 1, stdout: '', stderr: 'Not Found' };
  };
  return { gh, calls };
}

test('separatorTwin: / - _ are one name; the exact name wins; none = null', () => {
  assert.equal(separatorTwin('impl-NMC-5132', ['main', 'impl/NMC-5132']), 'impl/NMC-5132');
  assert.equal(separatorTwin('impl-NMC-5132', ['impl_NMC_5132']), 'impl_NMC_5132');
  assert.equal(separatorTwin('impl-NMC-5132', ['impl-NMC-5132', 'impl/NMC-5132']), null, 'the tracked name exists: nothing to adopt');
  assert.equal(separatorTwin('impl-NMC-5132', ['impl-NMC-5133', 'implNMC5132']), null);
});

test('ensureTicketBranch: created from the TARGET tip; an existing one is left; a lost race adopts; a failure throws', async () => {
  const refs: Record<string, string> = { 'bench/run': SHA1 };
  const a = fakeGh(refs);
  assert.deepEqual(await ensureTicketBranch({ repo: 'o/stack', target: 'bench/run', branch: 'impl-NMC-1', gh: a.gh }), { created: true, head: SHA1 });
  assert.equal(refs['impl-NMC-1'], SHA1);
  refs['bench/run'] = SHA2; // the target moved on: the existing branch is NOT touched
  assert.deepEqual(await ensureTicketBranch({ repo: 'o/stack', target: 'bench/run', branch: 'impl-NMC-1', gh: a.gh }), { created: false, head: SHA1 });
  await assert.rejects(() => ensureTicketBranch({ repo: 'o/stack', target: 'bench/run', branch: 'impl-NMC-2', gh: fakeGh(refs, { postFails: true }).gh }), /cannot create impl-NMC-2/);
  await assert.rejects(() => ensureTicketBranch({ repo: 'o/stack', target: 'nope', branch: 'impl-NMC-3', gh: fakeGh({}).gh }), /cannot read the tip/);
  await assert.rejects(() => ensureTicketBranch({ repo: 'o/stack', target: 'bench/run', branch: 'x; rm -rf', gh: a.gh }), /refusing/);
});

function writePlan(home: string, repo: string | null): void {
  let s: FanoutState = newState('r1', { target: 'bench/run', repo, switches: { seatRecords: 'on' }, now: NOW });
  s = { ...s, plan: { tickets: ['A', 'B'], declaredAt: NOW } } as FanoutState;
  for (const id of ['A', 'B']) s = applyTicketPatch(s, id, { spec: `ledger §${id}`, dependsOn: [] }, NOW);
  writeStateAtomic(stateFile(home, 'r1'), s);
}
function startDeps(home: string, over: Partial<StartDeps>, tasks: string[]): StartDeps {
  let n = 0;
  return { home, now: () => NOW, implementerLive: () => false, repoPath: () => '/meta', worktreeRepo: () => ({ remote: 'git@github.com:o/meta.git', defaultBranch: 'master' }),
    spawn: async (i) => { tasks.push(i.task); return { ok: true, id: `ws-${++n}`, branch: i.name }; }, ...over };
}

test('startRun, cross-repo: the branch is created BEFORE the spawn, the brief names the exact checkout, the recorded branch is the created one', async (t) => {
  const home = tmp(t); writePlan(home, 'o/stack');
  const order: string[] = [], tasks: string[] = [];
  const r = await startRun('r1', 'r1', startDeps(home, { prepareTicketBranch: async (i) => { order.push(`prepare ${i.ticket} ${i.branch} ${i.repo}@${i.target}`); }, spawn: async (i) => { order.push(`spawn ${i.name}`); tasks.push(i.task); return { ok: true, id: `ws-${order.length}`, branch: `${i.name}-2` }; } }, tasks));
  assert.deepEqual(order, ['prepare A impl-A o/stack@bench/run', 'spawn impl-A', 'prepare B impl-B o/stack@bench/run', 'spawn impl-B']);
  assert.ok(tasks[0].includes(`\`${ticketBranchCheckout('impl-A')}\``) && tasks[0].includes('already exists on o/stack'));
  const st = JSON.parse(fs.readFileSync(stateFile(home, 'r1'), 'utf8')) as FanoutState;
  assert.equal(st.tickets.A.branch, 'impl-A', 'the loop tracks the name it created, even when the worktree branch got a suffix');
});

test('startRun: briefs are byte-identical whether the branch was created now or already existed; none without the hook; none for a same-repo run', async (t) => {
  const run = async (over: Partial<StartDeps>, repo: string | null): Promise<string[]> => { const home = tmp(t); writePlan(home, repo); const tasks: string[] = []; await startRun('r1', 'r1', startDeps(home, over, tasks)); return tasks; };
  const made = await run({ prepareTicketBranch: async () => undefined }, 'o/stack');
  const existed = await run({ prepareTicketBranch: async () => undefined }, 'o/stack'); // (an existing branch is the same resolved promise)
  assert.deepEqual(made, existed);
  const bare = await run({}, 'o/stack');
  assert.ok(!bare.some((x) => x.includes('Ticket branch:')), 'no hook wired: the brief is the old one');
  const same = await run({ prepareTicketBranch: async () => { throw new Error('must not be called'); }, worktreeRepo: () => ({ remote: 'git@github.com:o/stack.git', defaultBranch: 'master' }) }, 'o/stack');
  assert.ok(same.length === 2 && !same.some((x) => x.includes('Ticket branch:')), 'a same-repo run creates nothing');
});

test('startRun: a branch that cannot be created fails that ticket (retried next pass) and spawns nothing', async (t) => {
  const home = tmp(t); writePlan(home, 'o/stack'); const tasks: string[] = [];
  const r = await startRun('r1', 'r1', startDeps(home, { prepareTicketBranch: async () => { throw new Error('gh: 502'); } }, tasks));
  assert.equal(tasks.length, 0); assert.equal(r.failed.length, 2); assert.match(r.failed[0].error, /could not create the ticket branch impl-A on o\/stack: gh: 502/);
});

test('renderImplementerBrief: no ticketBranch ⇒ no section (byte-identical)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-')); try { writePlan(home, 'o/stack'); const s = JSON.parse(fs.readFileSync(stateFile(home, 'r1'), 'utf8')) as FanoutState; const c = { targetRepo: 'o/stack', defaultBranch: 'master' };
    assert.ok(!renderImplementerBrief({ state: s, ticket: 'A', crossRepo: c }).includes('Ticket branch:'));
    assert.ok(renderImplementerBrief({ state: s, ticket: 'A', crossRepo: c, ticketBranch: 'impl-A' }).includes('Ticket branch:')); } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('role guard: an implementer pushes its ticket branch only (impl/X, impl_X, --all refused; the right name, a suffix twin of the name, a plain command pass)', (t) => {
  const d = tmp(t); fs.mkdirSync(path.join(d, '.orchestra'));
  fs.writeFileSync(path.join(d, '.orchestra/role-guard.sh'), buildRoleGuardScript());
  const sentinel = (role: string, branch?: string): void => { fs.writeFileSync(path.join(d, '.orchestra/role'), `${role}\n`); fs.rmSync(path.join(d, '.orchestra/ticket-branch'), { force: true }); if (branch) fs.writeFileSync(path.join(d, '.orchestra/ticket-branch'), `${branch}\n`); };
  const run = (cmd: string): { code: number | null; err: string } => { const r = spawnSync('bash', [path.join(d, '.orchestra/role-guard.sh')], { input: JSON.stringify({ tool_name: 'Bash', cwd: d, tool_input: { command: cmd } }), encoding: 'utf8', env: { ...process.env, ORCHESTRA_WORKTREE: d } }); return { code: r.status, err: r.stderr }; };
  sentinel('implementer', 'impl-NMC-5132');
  for (const ok of ['git push -u origin impl-NMC-5132', 'git push origin +impl-NMC-5132:refs/heads/impl-NMC-5132', 'git push origin impl-NMC-5132 && echo hi', 'git status', 'git -C /x push origin HEAD:impl-NMC-5132']) assert.equal(run(ok).code, 0, ok);
  for (const bad of ['git push origin impl/NMC-5132', 'git push -u origin HEAD:impl/NMC-5132', 'git -C /x push origin impl_NMC-5132', 'git push --all origin', 'git push origin impl-NMC-5132 other-branch']) { const r = run(bad); assert.equal(r.code, 2, bad); assert.match(r.err, /ticket branch 'impl-NMC-5132' only/, bad); }
  assert.equal(run('echo impl/x > .orchestra/ticket-branch').code, 2, 'the sentinel is protected');
  fs.writeFileSync(path.join(d, '.orchestra/ticket-branch'), 'impl-NMC-5132-2\n'); assert.equal(run('git push origin impl-NMC-5132').code, 0, 'a suffixed worktree branch may push the ticket name');
  sentinel('implementer'); assert.equal(run('git push origin impl/NMC-5132').code, 0, 'no ticket-branch file ⇒ no push rule');
  sentinel('coordinator', 'impl-NMC-5132'); assert.equal(run('git push origin impl/NMC-5132').code, 0, 'only the implementer role');
});

function loopCtx(home: string, tracked: string, remote: string[], status: 'started' | 'todo' = 'started'): { ctx: LoopCtx; did: string[]; st: () => ReturnType<LoopCtx['st']> } {
  writePlan(home, 'o/stack');
  let s: FanoutState = JSON.parse(fs.readFileSync(stateFile(home, 'r1'), 'utf8'));
  s = applyTicketPatch(s, 'A', { branch: tracked, status }, NOW);
  let cur = withLoop(s, undefined as never);
  const did: string[] = [];
  const git = { head: async (b: string) => (remote.includes(b) ? SHA1 : null), twin: async (b: string) => separatorTwin(b, remote) } as unknown as LoopCtx['deps']['git'];
  const ctx = { deps: { git, now: () => NOW }, st: () => cur, update: (f: (x: typeof cur) => typeof cur) => { cur = f(cur); }, did: (l: string) => { did.push(l); } } as unknown as LoopCtx;
  return { ctx, did, st: () => cur };
}

test('adoptBranchTwins: branch-gone + a separator twin on the remote ⇒ the ticket follows the twin, said in the log; otherwise nothing', async (t) => {
  const home = tmp(t);
  const a = loopCtx(home, 'impl-A', ['bench/run', 'impl/A']);
  await adoptBranchTwins(a.ctx);
  assert.equal(a.st().tickets.A.branch, 'impl/A'); assert.match(a.did[0], /adopted impl\/A as the branch of A/);
  await adoptBranchTwins(a.ctx); assert.equal(a.did.length, 1, 'a second pass finds it tracked: no second adoption');
  const b = loopCtx(tmp(t), 'impl-A', ['bench/run', 'impl-A', 'impl/A']); await adoptBranchTwins(b.ctx); assert.equal(b.st().tickets.A.branch, 'impl-A', 'the tracked branch exists: nothing adopted');
  const c = loopCtx(tmp(t), 'impl-A', ['bench/run']); await adoptBranchTwins(c.ctx); assert.deepEqual(c.did, [], 'no twin: the branch-gone stays for the reconcile');
  const d = loopCtx(tmp(t), 'impl-A', ['impl/A'], 'todo'); await adoptBranchTwins(d.ctx); assert.equal(d.st().tickets.A.branch, 'impl-A', 'a ticket not started adopts nothing');
});

test('live git twin: lists the remote (ls-remote), unreadable ⇒ null (never "gone")', async () => {
  const mk = (code: number, stdout: string) => createLiveGit({ git: async () => ({ code, stdout, stderr: '' }) });
  assert.equal(await mk(0, `${SHA1}\trefs/heads/main\n${SHA2}\trefs/heads/impl/NMC-5132\n`).twin!('impl-NMC-5132'), 'impl/NMC-5132');
  assert.equal(await mk(128, '').twin!('impl-NMC-5132'), null);
});
