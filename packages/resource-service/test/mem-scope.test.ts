// A4 (#452): `exec --run <id> --mem <size> -- <cmd>` caps a command in a systemd user scope — the kernel kills the runaway, the caller survives (exit 137 + a message).
// Allocations stay SMALL (300 MB over a 150M cap). Every scope here carries this file's TOKEN in its name and is stopped in `after` (never the real resctl.service).
// These tests need a systemd user manager with the memory controller: a host without one fails the instrument check (it never SKIPs).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Rig, identityOf, isAlive, waitFor, within } from './lib/rig.ts';
import { capEvidence, userScopeCgroup, scopeInfo, scopeLaunch, scopeSupport, scopeUnitName, SCOPE_NAME_RE } from '../src/scope.ts';
import { readStat, sleep } from '../src/proc.ts';
import { withState } from '../src/state.ts';

const HOG = fileURLToPath(new URL('./fixtures/hog.mjs', import.meta.url));
const LANE = fileURLToPath(new URL('./fixtures/lane.mjs', import.meta.url));
const TOKEN = `a4t${randomBytes(3).toString('hex')}`;
const CAP = '150M';
const CAP_BYTES = 150 * 1024 * 1024;
const node = process.execPath;

const ctl = (...a: string[]) => spawnSync('systemctl', ['--user', '--no-pager', ...a], { encoding: 'utf8' });
/** Every unit of THIS file's token (any state), stopped and cleared. */
function sweep(): string[] {
  const units = ctl('list-units', '--all', '--plain', '--no-legend', `resctl-${TOKEN}*`).stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  for (const u of units) {
    ctl('kill', '--kill-whom=all', '--signal=SIGKILL', u);
    ctl('stop', u);
    ctl('reset-failed', u);
  }
  return units;
}
const unitLoaded = (u: string): boolean => ctl('show', '-p', 'LoadState', '--value', u).stdout.trim() !== 'not-found';
const cgroupFile = (pid: number, file: string): string => {
  const cg = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((l) => l.startsWith('0::'))!.slice(3);
  return fs.readFileSync(`/sys/fs/cgroup${cg}/${file}`, 'utf8').trim();
};

/** oom_kill of the parent cgroup the scopes live in (shared with every fleet scope), or null. */
function parentOomKills(): number | null {
  try {
    const uid = process.getuid!();
    const m = /^oom_kill (\d+)$/m.exec(fs.readFileSync(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/memory.events`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
describe('exec --mem', () => {
  let rig: Rig;
  let n = 0;
  const newRun = (): string => {
    const id = `${TOKEN}-r${++n}`;
    const c = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', id, '--owner', String(c.pid)]).status, 0);
    return id;
  };
  before(() => {
    rig = new Rig({ grace: '1s' });
    assert.equal(scopeSupport(CAP_BYTES).ok, true, 'instrument: this host must run a systemd user manager with the memory controller (see src/scope.ts scopeSupport)');
  });
  after(async () => {
    const swept = sweep();
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
    assert.deepEqual(ctl('list-units', '--all', '--plain', '--no-legend', `resctl-${TOKEN}*`).stdout.trim(), '', `a scope was left behind (swept ${swept.join(',')})`);
  });

  it('an allocation past the cap is killed; the caller gets exit 137 and a message naming the cap', () => {
    const id = newRun();
    const r = rig.cli(['exec', '--run', id, '--mem', CAP, '--', node, HOG, '300']);
    assert.equal(r.status, 137);
    assert.match(r.stderr, new RegExp(`most likely the memory cap --mem ${CAP}`));
    assert.match(r.stderr, /systemd recorded Result=oom-kill for scope/, 'the message says WHICH evidence was seen');
    assert.ok(r.stderr.includes(`scope ${scopeUnitName(id, 1)}`), 'the message names the scope');
    assert.doesNotMatch(r.stdout, /touched 300 MB/, 'the allocation must not complete');
    assert.doesNotMatch(r.stdout, /survived/);
    const unit = scopeUnitName(id, 1);
    assert.equal(unitLoaded(unit), false, 'the failed scope is cleared (reset-failed)');
    assert.deepEqual(rig.run(id)!.lanes, [], 'the lane record is dropped once the lane and its scope are gone');
    assert.equal(rig.run(id)!.state, 'alive', 'only the command died: the run is untouched');
  });

  it('the caller survives: a process that launches the exec wrapper keeps running and reads the verdict', async () => {
    const id = newRun();
    const probe = `const {spawnSync}=require('node:child_process');const r=spawnSync(process.argv[1],process.argv.slice(2),{encoding:'utf8'});console.log(JSON.stringify({status:r.status,err:r.stderr}));`;
    const out = spawnSync(node, ['-e', probe, node, path.join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'resctl.mjs'), 'exec', '--run', id, '--mem', CAP, '--', node, HOG, '300'], { env: rig.env, encoding: 'utf8' });
    assert.equal(out.status, 0, 'the caller itself exited normally (was not OOM-killed)');
    const seen = JSON.parse(out.stdout);
    assert.equal(seen.status, 137);
    assert.match(seen.err, /most likely the memory cap/);
  });

  it('instantly-exiting capped commands leave no lane record behind (the scope reads `active` for a moment after the leader exits)', () => {
    const id = newRun();
    for (let i = 0; i < 12; i++) assert.equal(rig.cli(['exec', '--run', id, '--mem', CAP, '--', i % 2 ? 'true' : 'echo', 'hi']).status, 0);
    assert.deepEqual(rig.run(id)!.lanes, [], '12 short capped commands: every lane record is dropped');
    assert.equal(rig.run(id)!.scopeSeq, 12);
    assert.equal(ctl('list-units', '--all', '--plain', '--no-legend', `resctl-${id}-*`).stdout.trim(), '');
  });

  it('DETERMINISTIC: a unit that reads `active` while its cgroup is already empty (systemd lagging) is not a member — the lane record is dropped', () => {
    const id = newRun();
    const cnt = path.join(rig.dir, 'lag-count');
    const lag = path.join(rig.dir, 'systemctl-lag');
    // the first two `show` reads answer « active » with a cgroup that does not exist (= empty); then the real systemctl
    fs.writeFileSync(lag, `#!/bin/sh\nn=$(cat ${cnt} 2>/dev/null || echo 0)\nif [ "$3" = show ] && [ "$n" -lt 2 ]; then echo $((n+1)) > ${cnt}; printf 'LoadState=loaded\\nActiveState=active\\nResult=success\\nDescription=x\\nControlGroup=/resctl-no-such-cgroup.slice\\n'; exit 0; fi\nexec systemctl "$@"\n`, { mode: 0o755 });
    assert.equal(rig.cli(['exec', '--run', id, '--mem', CAP, '--', 'true'], { RESCTL_SYSTEMCTL: lag }).status, 0);
    assert.equal(fs.readFileSync(cnt, 'utf8').trim(), '2', 'instrument: both lagging reads happened');
    assert.deepEqual(rig.run(id)!.lanes, [], 'an active unit with an empty cgroup is not a reason to keep the lane');
  });

  it('a cap kill whose Result systemd has not recorded yet is still reported (the scope read is retried after a SIGKILL exit)', () => {
    const id = newRun();
    const cnt = path.join(rig.dir, 'show-count');
    const stale = path.join(rig.dir, 'systemctl-stale');
    // fully synthetic (no dependence on a real kill being recorded): the first two `show` reads answer « already collected, success », the third « failed, oom-kill »
    fs.writeFileSync(stale, `#!/bin/sh\nif [ "$3" = show ]; then n=$(cat ${cnt} 2>/dev/null || echo 0); echo $((n+1)) > ${cnt}; if [ "$n" -lt 2 ]; then printf 'LoadState=not-found\\nActiveState=inactive\\nResult=success\\nDescription=\\nControlGroup=\\n'; else printf 'LoadState=loaded\\nActiveState=failed\\nResult=oom-kill\\nDescription=x\\nControlGroup=\\n'; fi; exit 0; fi\nexec systemctl "$@"\n`, { mode: 0o755 });
    const r = rig.cli(['exec', '--run', id, '--mem', CAP, '--', 'sh', '-c', 'kill -9 $$'], { RESCTL_SYSTEMCTL: stale, RESCTL_NO_OOM_WATCH: '1' });
    assert.equal(fs.readFileSync(cnt, 'utf8').trim(), '3', 'instrument: two stale reads, then the recorded one');
    assert.equal(r.status, 137);
    assert.match(r.stderr, /most likely the memory cap/);
  });

  it('a cap kill is still reported when EVERY systemctl read is slow (the re-read is bounded by reads that returned, not by elapsed time)', () => {
    const id = newRun();
    const cnt = path.join(rig.dir, 'slow-count');
    const slow = path.join(rig.dir, 'systemctl-slow');
    // each `show` takes 0.8 s (> the old 600 ms elapsed bound); two stale answers, then « failed, oom-kill » — synthetic, like the arm above
    fs.writeFileSync(slow, `#!/bin/sh\nif [ "$3" = show ]; then sleep 0.8; n=$(cat ${cnt} 2>/dev/null || echo 0); echo $((n+1)) > ${cnt}; if [ "$n" -lt 2 ]; then printf 'LoadState=not-found\\nActiveState=inactive\\nResult=success\\nDescription=\\nControlGroup=\\n'; else printf 'LoadState=loaded\\nActiveState=failed\\nResult=oom-kill\\nDescription=x\\nControlGroup=\\n'; fi; exit 0; fi\nexec systemctl "$@"\n`, { mode: 0o755 });
    const r = rig.cli(['exec', '--run', id, '--mem', CAP, '--', 'sh', '-c', 'kill -9 $$'], { RESCTL_SYSTEMCTL: slow, RESCTL_NO_OOM_WATCH: '1' });
    assert.equal(fs.readFileSync(cnt, 'utf8').trim(), '3', 'instrument: the two slow stale reads, then the recorded one');
    assert.equal(r.status, 137);
    assert.match(r.stderr, /most likely the memory cap/);
  });

  it('systemd lost the kill: the scope\'s OWN kernel counter (a REAL kill) still gets the message out — deterministic: the scope outlives the kill', async () => {
    const id = newRun();
    const never = path.join(rig.dir, 'systemctl-never');
    // systemd « lost the event »: every `show` answers collected/success; the other verbs go to the real systemctl
    fs.writeFileSync(never, `#!/bin/sh\nif [ "$3" = show ]; then printf 'LoadState=not-found\\nActiveState=inactive\\nResult=success\\nDescription=\\nControlGroup=\\n'; exit 0; fi\nexec systemctl "$@"\n`, { mode: 0o755 });
    // the race this arm must not depend on (the cgroup vanishing before we read its counter): OOMPolicy=continue + a sleeper in the scope keep the cgroup alive past the kill
    const sdrun = path.join(rig.dir, 'systemd-run-keep');
    fs.writeFileSync(sdrun, `#!/bin/sh\nfor a; do shift; case "$a" in OOMPolicy=kill) a=OOMPolicy=continue;; esac; set -- "$@" "$a"; done\nexec systemd-run "$@"\n`, { mode: 0o755 });
    const env = { RESCTL_SYSTEMCTL: never, RESCTL_SYSTEMD_RUN: sdrun };
    const r = rig.cli(['exec', '--run', id, '--mem', CAP, '--', 'sh', '-c', `sleep 120 >/dev/null 2>&1 & exec ${JSON.stringify(node)} ${JSON.stringify(HOG)} 300`], env);
    assert.equal(r.status, 137);
    assert.doesNotMatch(r.stdout, /survived/);
    assert.match(r.stderr, /most likely the memory cap/);
    assert.match(r.stderr, /kernel's oom_kill counter of scope .* moved \(systemd's record said otherwise\)/, 'the message names the counter, not Result=oom-kill');
    assert.doesNotMatch(r.stderr, /Result=oom-kill/);
    assert.equal(rig.run(id)!.lanes.length, 1, 'the scope still holds the sleeper: the lane record stays for stop-scopes');
    assert.equal(rig.cli(['run', 'end', '--id', id]).status, 0);
    // control, same blinded systemd + same surviving scope, a SIGKILL that is NOT the cap ⇒ the counter is 0 ⇒ no message
    const id2 = newRun();
    const k = rig.cli(['exec', '--run', id2, '--mem', CAP, '--', 'sh', '-c', 'sleep 120 >/dev/null 2>&1 & kill -9 $$'], env);
    assert.equal(k.status, 137);
    assert.doesNotMatch(k.stderr, /memory cap|OOM killer/);
    assert.equal(rig.cli(['run', 'end', '--id', id2]).status, 0);
    for (const u of [scopeUnitName(id, 1), scopeUnitName(id2, 1)]) ctl('reset-failed', u);
  });

  /** An OOM kill in a SIBLING scope (same parent cgroup as every lane): the shared counter moves, this lane's own scope is untouched. */
  async function siblingOom(): Promise<void> {
    const before = parentOomKills();
    const unit = `resctl-${TOKEN}-sib-${++n}.scope`;
    const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', `--unit=${unit}`, '-p', 'MemoryMax=100M', '-p', 'MemorySwapMax=0', '-p', 'OOMPolicy=kill', '--', node, HOG, '250'], { encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', 'instrument: the sibling hog was OOM-killed (spawnSync reports a signal death as status null)');
    if (before !== null) await waitFor('the shared parent counter moved', () => parentOomKills()! > before, 5000);
    ctl('reset-failed', unit);
  }

  it('INPUT A — a plain SIGKILL of a capped lane while a SIBLING scope is OOM-killed is NOT reported as the cap', async () => {
    const id = newRun();
    const pidfile = path.join(rig.dir, 'sibA.pid');
    const w = rig.spawnCli(['exec', '--run', id, '--mem', CAP, '--', node, LANE, 'sleep', pidfile]);
    const pid = await waitFor('lane pid', () => (fs.existsSync(pidfile) ? Number(fs.readFileSync(pidfile, 'utf8')) : 0));
    await siblingOom();
    process.kill(pid, 'SIGKILL');
    const x = await within('wrapper exits', w.exited);
    assert.equal(x.code, 137);
    assert.doesNotMatch(w.stderr(), /OOM killer|memory cap/, 'nothing of THIS scope was OOM-killed: no cap message');
  });

  it('INPUT B — `run end` (stop-scopes SIGKILL) of a capped lane while a SIBLING scope is OOM-killed is NOT reported as the cap', async () => {
    const id = newRun();
    const pidfile = path.join(rig.dir, 'sibB.pid');
    const w = rig.spawnCli(['exec', '--run', id, '--mem', CAP, '--', node, LANE, 'ignore-term', pidfile]);
    await waitFor('lane pid', () => (fs.existsSync(pidfile) ? Number(fs.readFileSync(pidfile, 'utf8')) : 0));
    await siblingOom();
    assert.equal(rig.cli(['run', 'end', '--id', id]).status, 0);
    await within('wrapper exits', w.exited);
    assert.doesNotMatch(w.stderr(), /OOM killer|memory cap/);
  });

  it('a cap larger than the host\'s memory warns that it can never fire (and still applies)', () => {
    const id = newRun();
    const r = rig.cli(['exec', '--run', id, '--mem', '1000G', '--', 'true']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /--mem 1000G is larger than this host's memory .* can never fire/);
    assert.doesNotMatch(r.stderr, /ignored/);
  });

  it('below the cap the command completes and keeps its own exit code', () => {
    const id = newRun();
    const r = rig.cli(['exec', '--run', id, '--mem', CAP, '--', node, HOG, '60']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /survived/);
    assert.doesNotMatch(r.stderr, /memory cap|ignored/);
    assert.equal(rig.cli(['exec', '--run', id, '--mem', CAP, '--', 'sh', '-c', 'exit 7']).status, 7, 'a plain failure is not reported as a cap kill');
  });

  it('a SIGKILL that is not the cap is not reported as the cap', () => {
    const id = newRun();
    const r = rig.cli(['exec', '--run', id, '--mem', CAP, '--', 'sh', '-c', 'kill -9 $$']);
    assert.equal(r.status, 137, 'natural 128+SIGKILL');
    assert.doesNotMatch(r.stderr, /memory cap/);
  });

  it('MUST-FAIL ARM: with no level the same allocation completes', () => {
    const id = newRun();
    const r = rig.cli(['exec', '--run', id, '--', node, HOG, '300']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /touched 300 MB/);
    assert.match(r.stdout, /survived/);
    assert.doesNotMatch(r.stderr, /memory cap|ignored/);
    assert.equal(rig.run(id)!.scopeSeq, undefined, 'no --mem: no scope is ever allocated');
  });

  it('the lane runs in a scope named resctl-<id>-<n>.scope, recorded on the lane, with the level and no swap really applied', async () => {
    const id = newRun();
    const pidfile = path.join(rig.dir, 'mem-lane.pid');
    const w = rig.spawnCli(['exec', '--run', id, '--mem', CAP, '--', node, LANE, 'sleep', pidfile]);
    const pid = await waitFor('lane pid', () => (fs.existsSync(pidfile) ? Number(fs.readFileSync(pidfile, 'utf8')) : 0));
    const unit = scopeUnitName(id, 1);
    assert.match(unit, SCOPE_NAME_RE);
    const rec = rig.run(id)!.lanes.find((l) => l.pid === pid)!;
    assert.equal(rec.scope, unit, 'the scope is recorded on the lane');
    assert.equal(cgroupFile(pid, 'memory.max'), String(CAP_BYTES), 'the kernel holds MemoryMax');
    assert.equal(cgroupFile(pid, 'memory.swap.max'), '0', 'and no swap');
    assert.ok((await scopeInfo(unit))!.description.includes(rig.run(id)!.token), 'the scope carries the run instance token');
    assert.equal(cgroupFile(pid, 'cgroup.type'), 'domain');
    assert.equal(rig.cli(['run', 'end', '--id', id]).status, 0);
    await within('exec wrapper returns', w.exited);
    assert.equal(unitLoaded(unit), false);
    assert.equal(isAlive(identityOf(pid) ?? { pid: -1, startTime: 0 }), false);
  });

  it('`run end` stops the scope: a setsid-ed child that cleared its environment (out of reach of the group kill and the marker sweep) dies with it', async () => {
    const id = newRun();
    const pidfile = path.join(rig.dir, 'esc.pid');
    const w = rig.spawnCli(['exec', '--run', id, '--mem', CAP, '--', node, LANE, 'escape-clean', pidfile]);
    const esc = identityOf(await waitFor('escapee pid', () => (fs.existsSync(pidfile) ? Number(fs.readFileSync(pidfile, 'utf8')) : 0)))!;
    const lane = rig.run(id)!.lanes[0];
    assert.notEqual(readStat(esc.pid)!.pgrp, lane.pgid, 'instrument: the escapee left the lane group');
    assert.ok(!fs.readFileSync(`/proc/${esc.pid}/environ`, 'utf8').includes(rig.run(id)!.token), 'instrument: and carries no run marker');
    assert.match(cgroupOf(esc.pid), new RegExp(`resctl-${id}-1\\.scope`), 'instrument: but it sits in the lane scope');
    assert.equal(rig.cli(['run', 'end', '--id', id]).status, 0);
    assert.ok(!isAlive(esc), 'the escapee must die with the scope');
    assert.equal(unitLoaded(scopeUnitName(id, 1)), false);
    await within('exec wrapper returns', w.exited);
  });

  it('a lane whose leader left but whose scope still holds a child keeps its record (so a cleanup can reach the scope)', async () => {
    const id = newRun();
    const pidfile = path.join(rig.dir, 'leave.pid');
    const w = rig.spawnCli(['exec', '--run', id, '--mem', CAP, '--', node, LANE, 'escape-clean-leave', pidfile]);
    const esc = identityOf(await waitFor('kid pid', () => (fs.existsSync(pidfile) ? Number(fs.readFileSync(pidfile, 'utf8')) : 0)))!;
    await within('exec wrapper returns (leader exited)', w.exited);
    assert.ok(isAlive(esc), 'instrument: the kid outlives the leader');
    rig.startDaemon(); // the reaper's stale-lane prune (empty group) runs every tick: it must not drop a lane whose scope is busy
    await sleep(700);
    assert.equal(rig.run(id)!.lanes.length, 1, 'the lane stays recorded while its scope has a member');
    assert.equal(rig.run(id)!.lanes[0].scope, scopeUnitName(id, 1));
    assert.equal(rig.cli(['run', 'end', '--id', id]).status, 0);
    assert.ok(!isAlive(esc), 'the scope kid dies with the run');
    assert.equal(unitLoaded(scopeUnitName(id, 1)), false);
  });

  it('systemd unreachable when the leader exits = unknown, not empty: the lane record (and its scope) is kept and a later `run end` still reaches it', async () => {
    const id = newRun();
    const broken = path.join(rig.dir, 'systemctl-broken');
    fs.writeFileSync(broken, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const pidfile = path.join(rig.dir, 'unk.pid');
    const w = rig.spawnCli(['exec', '--run', id, '--mem', CAP, '--', node, LANE, 'escape-clean-leave', pidfile], { RESCTL_SYSTEMCTL: broken });
    const esc = identityOf(await waitFor('kid pid', () => (fs.existsSync(pidfile) ? Number(fs.readFileSync(pidfile, 'utf8')) : 0)))!;
    await within('exec wrapper returns', w.exited);
    assert.equal(rig.run(id)!.lanes.length, 1, 'record kept');
    assert.equal(rig.cli(['run', 'end', '--id', id]).status, 0);
    assert.ok(!isAlive(esc));
  });

  it('two --mem lanes of one run get distinct scopes (a per-run counter), both recorded', async () => {
    const id = newRun();
    const ws = [1, 2].map((k) => rig.spawnCli(['exec', '--run', id, '--mem', CAP, '--', node, LANE, 'sleep', path.join(rig.dir, `two-${k}.pid`)]));
    await waitFor('both lanes recorded', () => rig.run(id)!.lanes.length === 2);
    assert.deepEqual(rig.run(id)!.lanes.map((l) => l.scope).sort(), [scopeUnitName(id, 1), scopeUnitName(id, 2)]);
    assert.equal(rig.cli(['run', 'end', '--id', id]).status, 0);
    for (const w of ws) await within('wrapper returns', w.exited);
    assert.equal(ctl('list-units', '--all', '--plain', '--no-legend', `resctl-${id}-*`).stdout.trim(), '');
  });

  it('the reaper stops the scope too when the coordinator dies', async () => {
    rig.startDaemon();
    const id = `${TOKEN}-reap`;
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', id, '--owner', String(coord.pid)]).status, 0);
    const pidfile = path.join(rig.dir, 'reap.pid');
    rig.spawnCli(['exec', '--run', id, '--mem', CAP, '--', node, LANE, 'escape-clean', pidfile]);
    const esc = identityOf(await waitFor('escapee pid', () => (fs.existsSync(pidfile) ? Number(fs.readFileSync(pidfile, 'utf8')) : 0)))!;
    await coord.kill();
    await waitFor('escapee reaped', () => !isAlive(esc), 15_000);
    await waitFor('run cleaned', () => rig.run(id)?.state === 'cleaned');
    assert.equal(unitLoaded(scopeUnitName(id, 1)), false);
  });

  it('an OOM kill ends EVERYTHING in the scope at once (a TERM-ignoring sibling does not hold the exit up)', async () => {
    const id = newRun();
    const t0 = Date.now();
    const r = await within('cap kill with a TERM-ignoring sibling', new Promise<ReturnType<Rig['cli']>>((res) => res(rig.cli(['exec', '--run', id, '--mem', CAP, '--', 'sh', '-c', `trap '' TERM; ${JSON.stringify(node)} ${JSON.stringify(HOG)} 300 trap-sibling; wait`]))), 30_000);
    assert.equal(r.status, 137);
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0}ms: the scope lingered`);
    assert.equal(unitLoaded(scopeUnitName(id, 1)), false);
  });

  it('stop-scopes never touches a scope that is not this run instance\'s (same name, other token)', async () => {
    const id = newRun();
    const unit = scopeUnitName(id, 9);
    const foreign = spawn('systemd-run', ['--user', '--scope', '--quiet', `--unit=${unit}`, '--description=someone else', '--', 'sleep', '300'], { stdio: 'ignore', env: rig.env });
    await waitFor('foreign scope up', () => unitLoaded(unit) && ctl('show', '-p', 'ActiveState', '--value', unit).stdout.trim() === 'active');
    // a lane record that names it: the run "believes" it owns the scope
    await withState((st) => void st.runs[id].lanes.push({ pid: 4194290, pgid: 4194290, startTime: 1, cmd: ['x'], startedAt: Date.now(), scope: unit }), rig.dir);
    assert.equal(rig.cli(['run', 'end', '--id', id]).status, 0);
    assert.equal(ctl('show', '-p', 'ActiveState', '--value', unit).stdout.trim(), 'active', 'a scope whose description lacks this run\'s token must survive');
    ctl('kill', '--kill-whom=all', '--signal=SIGKILL', unit);
    await within('foreign scope ends', new Promise<void>((r) => (foreign.exitCode !== null ? r() : foreign.once('exit', () => r()))));
  });

  describe('no systemd (or a systemd that cannot enforce the level): the command runs unchanged and the warning names --mem', () => {
    const warns4k = (stderr: string): void => {
      assert.match(stderr, /warning: --mem 4K ignored/);
      assert.match(stderr, /too small to start any process/);
      assert.doesNotMatch(stderr, /refused a scope/);
    };
    const warns = (stderr: string): void => {
      assert.match(stderr, /warning: --mem 150M ignored/);
      assert.match(stderr, /WITHOUT a memory cap/);
    };
    it('RESCTL_FORCE_NO_SYSTEMD=1 (simulated)', () => {
      const id = newRun();
      const r = rig.cli(['exec', '--run', id, '--mem', CAP, '--', node, HOG, '300'], { RESCTL_FORCE_NO_SYSTEMD: '1' });
      assert.equal(r.status, 0, 'the allocation completes: nothing capped it');
      assert.match(r.stdout, /survived/);
      warns(r.stderr);
      assert.match(r.stderr, /RESCTL_FORCE_NO_SYSTEMD=1/);
      assert.equal(rig.run(id)!.scopeSeq, undefined, 'no scope was allocated');
      assert.equal(ctl('list-units', '--all', '--plain', '--no-legend', `resctl-${id}-*`).stdout.trim(), '');
    });
    const shim = (name: string, body: string): string => {
      const p = path.join(rig.dir, name);
      fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return p;
    };
    it('real detection: a user manager that refuses the scope', () => {
      const id = newRun();
      const refusing = shim('systemd-run-refuse', 'echo "Failed to connect to bus: No medium found" >&2; exit 1');
      const r = rig.cli(['exec', '--run', id, '--mem', CAP, '--', node, HOG, '300'], { RESCTL_SYSTEMD_RUN: refusing });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /survived/);
      warns(r.stderr);
      assert.match(r.stderr, /refused a scope \(Failed to connect to bus/);
    });
    it('real detection: a scope that comes up WITHOUT the level (limit not applied) is not trusted', () => {
      const id = newRun();
      // forwards to the real systemd-run but drops every `-p X` pair: the scope exists, the kernel holds nothing
      const dropping = shim('systemd-run-nolimit', 'a=""; while [ $# -gt 0 ]; do if [ "$1" = "-p" ]; then shift 2; else a="$a \'$1\'"; shift; fi; done; eval exec systemd-run $a');
      const r = rig.cli(['exec', '--run', id, '--mem', CAP, '--', node, HOG, '300'], { RESCTL_SYSTEMD_RUN: dropping });
      assert.equal(r.status, 0, 'no cap was applied, so the allocation completes — and the user was told');
      warns(r.stderr);
      assert.match(r.stderr, /does not enforce MemoryMax \(memory\.max = max/);
    });
    it('real detection: a scope that holds the level but NOT the no-swap clause is not trusted either', () => {
      const id = newRun();
      const dropping = shim('systemd-run-noswap', 'a=""; while [ $# -gt 0 ]; do if [ "$1" = "-p" ] && [ "${2#MemorySwapMax}" != "$2" ]; then shift 2; else a="$a \'$1\'"; shift; fi; done; eval exec systemd-run $a');
      const r = rig.cli(['exec', '--run', id, '--mem', CAP, '--', node, HOG, '300'], { RESCTL_SYSTEMD_RUN: dropping });
      assert.equal(r.status, 0);
      warns(r.stderr);
      assert.match(r.stderr, /does not enforce MemorySwapMax=0 \(memory\.swap\.max = max/);
    });
    it('a cap too small to start any process says so (the probe shell is OOM-killed; the manager refused nothing)', () => {
      const id = newRun();
      const r = rig.cli(['exec', '--run', id, '--mem', '4K', '--', 'true']);
      assert.equal(r.status, 0);
      warns4k(r.stderr);
    });
    it('the support probe leaves no scope behind (this process\'s probes only: siblings probe on the same user manager)', async () => {
      assert.equal(scopeSupport(CAP_BYTES).ok, true);
      await waitFor('probe scope collected', () => ctl('list-units', '--all', '--plain', '--no-legend', `resctlprobe-${process.pid}-*`).stdout.trim() === '', 5000);
    });
  });

  it('the cap evidence: systemd\'s record or the scope\'s own counter — nothing else (not an exit code, a sibling, a parent)', () => {
    assert.equal(capEvidence({ result: 'oom-kill', own: 0 }), 'systemd');
    assert.equal(capEvidence({ result: 'success', own: 1 }), 'counter');
    assert.equal(capEvidence({ result: 'oom-kill', own: 3 }), 'systemd', 'systemd is named first when both say so');
    assert.equal(capEvidence({ result: 'success', own: 0 }), null);
    assert.equal(capEvidence({ result: undefined, own: 0 }), null);
    assert.equal(userScopeCgroup('resctl-x-1.scope', '/user.slice/user-1000.slice/user@1000.service/app.slice/some.scope'), '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/resctl-x-1.scope');
    assert.equal(userScopeCgroup('resctl-x-1.scope', '/system.slice/foo.service'), null, 'not inside a user manager: no derived path');
  });

  it('usage: a bad --mem is exit 2, a zero one too; the unit-name and argv shapes', () => {
    const id = newRun();
    for (const bad of ['abc', '0', '12Q', '-5M']) assert.equal(rig.cli(['exec', '--run', id, '--mem', bad, '--', 'true']).status, 2, `--mem ${bad}`);
    assert.equal(rig.cli(['exec', '--run', id, '--mem', '--', 'true']).status, 2, '--mem needs a value');
    assert.match(scopeUnitName('abc.d-e', 12), SCOPE_NAME_RE);
    for (const evil of ['resctl.service', '-p', 'resctl-.scope', 'resctl-x-1.service', 'resctl-x-y.scope', 'other-x-1.scope']) assert.doesNotMatch(evil, SCOPE_NAME_RE);
    const l = scopeLaunch({ unit: 'resctl-x-1.scope', bytes: 1048576, description: 'd', cmd: 'echo', args: ['hi'] });
    assert.deepEqual(l.args.slice(-3), ['--', 'echo', 'hi']);
    assert.ok(l.args.includes('MemoryMax=1048576') && l.args.includes('MemorySwapMax=0'));
  });
});

function cgroupOf(pid: number): string {
  return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
}
