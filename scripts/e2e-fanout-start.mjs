#!/usr/bin/env node
// #587 PR B rig (ledger #591 I6) — `orchestra fanout start`, the implementer brief and the hand-spawn refusal: every clause MUTATED in a scratch copy of src/ and
// src/cli/fanout-start.test.ts + src/main/fanout-start-wiring.test.ts (production paths: `runStart`, `startRun`, the host op, `handSpawnRefusalFor`, the main-process wiring pinned by source) must go RED.
// Light: no Electron, no network, no tokens; the scratch copy lives under $TMPDIR; the repo is never written.
//   node scripts/e2e-fanout-start.mjs            control: the unpatched copy must be GREEN (0 fail, 0 skipped)
//   node scripts/e2e-fanout-start.mjs --mutants  each mutant (exact string, must occur ONCE in its file — else REFUSED as stale) must be KILLED (≥1 test FAILs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-start-rig-'));
if (!path.resolve(scratch).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
fs.cpSync(path.join(ROOT, 'src'), path.join(scratch, 'src'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ type: 'module' })); // quiet the module-type reparse warning
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'), 'dir'); // git.ts imports simple-git (git-reuse-branch.test.ts)
const TESTS = ['src/cli/fanout-start.test.ts', 'src/main/fanout-start-wiring.test.ts', 'src/main/git-reuse-branch.test.ts', 'src/main/fanout-start-base.test.ts'].map((f) => path.join(scratch, f));

function run() {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...TESTS], { cwd: scratch, encoding: 'utf8', timeout: 240_000, env: { ...process.env, TMPDIR: tmpBase } });
  const out = `${r.stdout}\n${r.stderr}`;
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return { pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests'), out };
}

// [name, file, from, to] — `from` must occur exactly once in `file`.
const SS = 'src/shared/fanout-start.ts';
const IB = 'src/shared/fanout-implementer-brief.ts';
const H = 'src/shared/fanout-acceptance-host.ts';
const C = 'src/cli/fanout-start.ts';
const W = 'src/main/workspaces.ts';
const FW = 'src/main/fanout-acceptance-wiring.ts';
const X = 'src/cli/index.ts';
const S = 'src/shared/fanout-state.ts';
const G = 'src/main/git.ts';
const mutants = [
  // #599: the run target in another repository than the worktrees
  ['#599 cross-repo is never detected (the unfixed arm: every ticket is cut from the foreign target and fails)', SS, "if (want && have && want !== have) return { kind: 'cross'", "if (false as boolean && want && have && want !== have) return { kind: 'cross'"],
  ['#599 cross-repo spawn still passes the run target as base', SS, "baseBranch: base.base, ...(onBranch", "baseBranch: cur.target, ...(onBranch"],
  ['#599 every run is read as cross-repo (a same-repo run loses its base)', SS, "if (want && have && want !== have) return { kind: 'cross'", "if (want && have) return { kind: 'cross'"],
  ['#599 an unknown worktree repo is read as cross-repo', SS, "const want = repoSlugOf(i.stateRepo), have = repoSlugOf(i.worktreeRemote);", "const want = repoSlugOf(i.stateRepo) ?? '?', have = repoSlugOf(i.worktreeRemote) ?? '!';"],
  ['#599 the slug compare is case-sensitive', SS, "return m ? m[1].toLowerCase() : null;", "return m ? m[1] : null;"],
  ['#599 the missing-target check is skipped', SS, "if (b.kind === 'same' && deps.refExists && !(await", "if (false as boolean && b.kind === 'same' && deps.refExists && !(await"],
  ['#599 the foreign target is looked up in the worktree repo too (a cross-repo run is refused)', SS, "if (b.kind === 'same' && deps.refExists && !(await deps.refExists({ run, repoPath, ref: b.base })))", "if (deps.refExists && !(await deps.refExists({ run, repoPath, ref: b.kind === 'same' ? b.base : 'bench-target' })))"],
  ['#599 the decision is taken per ticket (the target is looked up once per ticket)', SS, "      if (baseOf) return baseOf;\n", ""],
  ['#599 the refusal does not name the branch', SS, "the run's target branch ${b.base} does not exist", "the run's target branch does not exist"],
  ['#599 the refusal is not [start-base-missing]', SS, "new SeatRefusal('start-base-missing'", "new SeatRefusal('start-off'"],
  ['#599 the respawn brief forgets the foreign target', SS, "...(base.kind === 'cross' ? { crossRepo: { targetRepo: base.targetRepo, defaultBranch: base.defaultBranch } } : {}) });", "});"],
  ['#599 brief: the cross-repo run target line is missing', IB, "...(input.crossRepo ? [`Run target: branch", "...(false as boolean ? [`Run target: branch"],
  ['#599 brief: the cross-repo base line still says origin/<target>', IB, ": input.crossRepo ? [`Branch base: your worktree is cut from", ": false as boolean ? [`Branch base: your worktree is cut from"],
  ['#599 host: the worktree-repo wiring is not handed to startRun', H, "worktreeRepo: deps.worktreeRepo, refExists: deps.refExists, home", "home"],
  ['#599 main: the worktree repo is unknown to the wiring', FW, "remote: r?.remoteUrl ?? null,", "remote: null,"],
  ['#599 main: the ref check always answers yes', FW, "return p ? refResolves(p, ref) : Promise.resolve(true); }", "return Promise.resolve(true); }"],
  ['#599 git: a missing ref resolves', G, "`${ref}^{commit}`])).trim().length > 0; }", "`${ref}^{commit}`])).trim().length >= 0; }"],
  // refusals
  ['start under off is allowed', SS, "if (!seatRecordsOn(state)) return new SeatRefusal('start-off',", "if (false) return new SeatRefusal('start-off',"],
  ['start by a non-coordinator is allowed', SS, "if (!caller || caller !== run) return new SeatRefusal('start-caller',", "if (false) return new SeatRefusal('start-caller',"],
  ['start with no identity is allowed', SS, "if (!caller || caller !== run) return", "if (caller && caller !== run) return"],
  ['start with an incomplete plan is allowed', SS, "  if (missing.length) return new SeatRefusal('plan-incomplete',", "  if (false) return new SeatRefusal('plan-incomplete',"],
  ['the CLI does not check before asking the host', C, "    if (refusal) throw refusal;\n    const res = await host(", "    const res = await host("],
  ['the host does not re-check (startRun trusts its caller)', SS, "    const refusal = startRefusal(state0, run, caller);\n    if (refusal) throw refusal;\n", ""],
  ['a free-text flag is accepted', C, "const p = parseArgs(args, ['--run'], []);", "const p = parseArgs(args, ['--run', '--task', '--brief', '--name'], []);"],
  ['a positional is accepted', C, "    if (p.pos.length) throw new FanoutStateError(`unexpected argument", "    if (false) throw new FanoutStateError(`unexpected argument"],
  ['a host refusal loses its name (exit 1)', C, "      if (msg.startsWith('[')) throw new SeatRefusal(", "      if (false) throw new SeatRefusal("],
  ['a failed ticket exits 0', C, "return { code: bad ? 2 : 0,", "return { code: 0,"],
  // the launch
  ['a ticket with a live implementer is started again', SS, "      if (t.implementer && deps.implementerLive(t.implementer)) {", "      if (false) {"],
  ['a merged ticket is started again', SS, "      if (t.status !== 'todo' && t.status !== 'started') {", "      if (false) {"],
  ['the plan is ignored: every state ticket is started', SS, "for (const ticket of state0.plan!.tickets) {", "for (const ticket of Object.keys(state0.tickets)) {"],
  ['concurrent starts are not serialised', SS, "  const next = prev.then(fn, fn);", "  const next = fn();"],
  ['the implementer is not recorded', SS, "applyTicketPatch(s, ticket, { implementer: id, branch, status: 'started' }, now)", "applyTicketPatch(s, ticket, { branch, status: 'started' }, now)"],
  ['the branch is not recorded', SS, "applyTicketPatch(s, ticket, { implementer: id, branch, status: 'started' }, now)", "applyTicketPatch(s, ticket, { implementer: id, status: 'started' }, now)"],
  ['the ticket is not set started', SS, "applyTicketPatch(s, ticket, { implementer: id, branch, status: 'started' }, now)", "applyTicketPatch(s, ticket, { implementer: id, branch }, now)"],
  ['the start record is not written', SS, "{ ...tk, start: { at: now, kind, briefHash: hash, briefs: (t.start?.briefs ?? 0) + 1 } }", "tk"],
  ['the brief hash is of something else', SS, "briefHash: hash,", "briefHash: briefHash(ticket),"],
  ['the brief counter does not increase', SS, "briefs: (t.start?.briefs ?? 0) + 1", "briefs: 1"],
  ['the spawn is not given the rendered brief', SS, "task, repoPath: deps.repoPath", "task: ticket, repoPath: deps.repoPath"],
  ['a held start fails the call', SS, "      if (!res.ok) { out.failed.push({ ticket, error: `${res.error ?? 'the agent failed to start'}", "      if (!res.ok || res.held) { out.failed.push({ ticket, error: `${res.error ?? 'the agent failed to start'}"],
  ['a failed spawn is thrown, not listed', SS, "} catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e) }; }", "} catch (e) { throw e; }"],
  ['a spawn with no workspace is recorded anyway', SS, "if (!res.id || !res.branch) { out.failed.push", "if (false) { out.failed.push"],
  ['a kept child is not recorded (a second call duplicates it)', SS, "      if (!res.id || !res.branch) {", "      if (!res.ok || !res.id || !res.branch) {"],
  ['a kept child is reported as started', SS, "      if (!res.ok) { out.failed.push({ ticket, error: `${res.error ?? 'the agent failed to start'}", "      if (false) { out.failed.push({ ticket, error: `${res.error ?? 'the agent failed to start'}"],
  ['a record failure is reported as started', SS, "      if (!recorded) continue;", ""],
  ['the implementer name is not impl-', SS, "return `impl-${slug || 'ticket'}`;", "return `ops-${slug || 'ticket'}`;"],
  // the brief
  ['brief: the interfaces it builds on are missing', IB, "    renderInterfaces(state, t.dependsOn),", "    '',"],
  ['brief: its own interface is missing', IB, "own ? `Interface you PROVIDE (frozen, v${own.version}):\\n${own.text}`", "own ? ''"],
  ['brief: the run\'s decisions are missing', IB, "    renderDecisions(state),\n", ""],
  ['brief: the switches are missing', IB, "    renderSwitchesLine(state),\n", ""],
  ['brief: the rules are missing', IB, "    IMPLEMENTER_RULES,\n", ""],
  ['brief: the branch base is missing', IB, "`Branch base: origin/${state.target}${state.repo ? ` of ${state.repo}` : ''}.`", "''"],
  ['brief: the spec is missing', IB, "t.spec ? `Spec: ${t.spec}` : 'Spec: none registered.',", "''"],
  ['brief: the rules (now the implementer role file, #590) let the agent change an interface', 'src/shared/fanout-implementer-skill.ts', "you never change an interface yourself", "you may change an interface yourself"],
  ['brief: the rules (role file) drop the followed version', 'src/shared/fanout-implementer-skill.ts', "and the VERSION of each interface you built on (e.g. ¤follows A=2¤)", "and nothing else"],
  // the host + the main process
  ['host: op start is unknown', H, "    if (input.op === 'start') {", "    if (input.op === 'start-off') {"],
  ['host: start works with no wiring', H, "if (!deps.implementerLive || !deps.spawnImplementer) return", "if (false) return"],
  ['host: start uses the acceptor spawn', H, "implementerLive: deps.implementerLive, repoPath: ({ run: r, ticket: tk, repo }) => deps.repoPath({ run: r, ticket: tk, from: str(input.from), repo, implementer: null }), spawn: spawnImplementer", "implementerLive: deps.implementerLive, repoPath: ({ run: r, ticket: tk, repo }) => deps.repoPath({ run: r, ticket: tk, from: str(input.from), repo, implementer: null }), spawn: async (i) => ({ ok: false, error: 'no' })"],
  ['cli: start accepts an unvouched host (no key = env id)', X, "if (!helpOnly && hostIdentity?.source !== 'host') fail('refusing to start:", "if (false as boolean) fail('refusing to start:"],
  ['cli: start is not settled with the host', X, "if (!helpOnly) await settleHostIdentity();", "if (false as boolean) await settleHostIdentity();"],
  ['cli: the caller is the bare env id', C, "const caller = (deps.vouchedCaller ?? '').trim();", "const caller = (deps.vouchedCaller ?? deps.env.ORCHESTRA_WS_ID ?? '').trim();"],
  ['cli: the session key is not sent to the host', C, "key: deps.env.ORCHESTRA_SESSION_KEY?.trim() || undefined", "key: undefined"],
  ['host: the caller is trusted without the key', H, "const vouched = !!caller && !!deps.vouches && deps.vouches(caller, str(input.key));", "const vouched = !!caller;"],
  ['host: the key check is skipped when the host has no vouching', H, "const vouched = !!caller && !!deps.vouches && deps.vouches(caller, str(input.key));", "const vouched = !!caller && (!deps.vouches || deps.vouches(caller, str(input.key)));"],
  ['an unrecorded live implementer is not adopted (a second agent is spawned)', SS, "      if (orphan) {", "      if (false as boolean && orphan) {"],
  ['an adopted implementer is not recorded', SS, "applyTicketPatch(s, ticket, { implementer: orphan.id, branch: orphan.branch, status: 'started' }, deps.now())", "s"],
  ['an adopted implementer is not told as live', SS, "out.skipped.push({ ticket, reason: 'live' }); } catch (e) { out.failed.push({ ticket, error: `${orphan.id}", "} catch (e) { out.failed.push({ ticket, error: `${orphan.id}"],
  ['the orphan scan sees the recorded ones too', SS, "recorded: recordedIds,", "recorded: [],"],
  ['a hand-set started ticket is respawned', SS, "const kind: 'spawn' | 'respawn' = t.implementer ? 'respawn' : 'spawn';", "const kind: 'spawn' | 'respawn' = t.implementer || t.status === 'started' ? 'respawn' : 'spawn';"],
  ['a dead recorded implementer is spawned as new (not a respawn)', SS, "const kind: 'spawn' | 'respawn' = t.implementer ? 'respawn' : 'spawn';", "const kind: 'spawn' | 'respawn' = 'spawn';"],
  ['a held start is listed as started too', SS, "      if (!res.held) (kind === 'spawn' ? out.started : out.respawned).push(", "      (kind === 'spawn' ? out.started : out.respawned).push("],
  ['main: the hand-spawn rule reads the caller id, not its run', W, "fromWs ? resolveWaveRunId(fromWs) : input.from,", "input.from,"],
  ['main: the host cannot vouch', FW, "vouches: (id, key) => !!key && sessionKeys().verify(id, key) === 'ok',", "vouches: () => true,"],
  ['main: orphans are never looked for', FW, "const w = store.workspaces.find((x) => x.parentId === run &&", "const w = store.workspaces.find((x) => false && x.parentId === run &&"],
  ['the spawn is cut from the repo default, not the run target', SS, "baseBranch: base.base, ...(onBranch", "baseBranch: undefined, ...(onBranch"],
  ['a respawn is cut from the dead branch (diff base = the dead branch)', SS, "baseBranch: base.base, ...(onBranch", "baseBranch: onBranch ? t.branch! : base.base, ...(onBranch"],
  ['a respawn asks for a fresh name (a suffixed copy of the branch)', SS, "name: onBranch ? t.branch! : implementerName(ticket),", "name: implementerName(ticket),"],
  ['a respawn does not ask to reuse the branch', SS, "...(onBranch ? { reuseBranch: true } : {}) });", "});"],
  ['a respawn brief does not say it is on the branch', SS, "...(onBranch ? { continueFrom: { branch: t.branch!, head: t.head } } : {}), ...(base.kind", "...(base.kind"],
  ['brief: the respawn text says the branch starts from the old one', IB, "you are ON its branch ${input.continueFrom.branch}", "your branch starts from ${input.continueFrom.branch}"],
  ['start-no-spec: a spec-less ticket is launched', SS, "  if (bare.length) return new SeatRefusal('start-no-spec',", "  if (false) return new SeatRefusal('start-no-spec',"],
  ['start-no-spec: a ticket with a spec is listed too', SS, "&& !t.spec && !t.specText; });", "&& !t.specText; });"],
  ['start-no-spec: a ticket that is already running is listed', SS, "(t.status === 'todo' || (t.status === 'started' && !t.implementer)) && !t.spec", "(t.status !== 'merged') && !t.spec"],
  ['start-no-spec: the plan check is skipped for a bare ticket (host)', SS, "    const refusal = startRefusal(state0, run, caller);\n    if (refusal) throw refusal;\n", "    const refusal = startRefusal(state0, run, caller);\n    if (refusal && refusal.refusal !== 'start-no-spec') throw refusal;\n"],
  ['git: reuse does not force past the dead agent\'s worktree', G, "...(opts?.reuse ? ['--force'] : []), worktreePath", "worktreePath"],
  ['git: reuse never looks at origin', G, "'-q', `refs/remotes/origin/${branch}`]).then((o) => o.trim().length > 0, () => false) : false;", "'-q', `refs/remotes/origin/${branch}`]).then((o) => false, () => false) : false;"],
  ['git: a missing branch is always taken from origin', G, "then((o) => o.trim().length > 0, () => false)", "then((o) => true, () => false)"],
  ['git: the DEFAULT call also forces (control unchanged)', G, "...(opts?.reuse ? ['--force'] : []), worktreePath", "'--force', worktreePath"],
  ['main: the branch pick suffixes a reused name', W, "const free = requested && naming?.reuseBranch ? requested : requested ? await freeBranchName(", "const free = requested ? await freeBranchName("],
  ['main: createWorkspace does not reuse in git', W, "naming?.reuseBranch ? { reuse: true } : undefined);", "undefined);"],
  ['main: the spawn does not pass reuseBranch to createWorkspace', W, "...(input.reuseBranch ? { reuseBranch: true } : {}) }, input.profile", "}, input.profile"],
  ['main: the implementer door drops reuseBranch', FW, "...(i.reuseBranch ? { reuseBranch: true } : {}) }, { viaFanoutStart: true });", "}, { viaFanoutStart: true });"],
  ['cli: a --help start asks the host', X, "const helpOnly = args.includes('--help') || args.includes('-h');", "const helpOnly = false;"],
  ['cli: usage does not name the empty-task refusal', C, "A plan ticket with no spec and no text is refused ([start-no-spec], listing them)", "A ticket may have no spec"],
  ['cli: usage does not name the human-terminal limit', C, "Limit: it is the coordinator's door, not a lock", "It is the coordinator's door"],
  ['hand spawn: an impl- spawn of a seatRecords run is allowed', SS, "if (i.viaStart || !i.state || !seatRecordsOn(i.state) || roleOfName(i.name) !== 'implementer') return null;", "return null; if (i.viaStart || !i.state || !seatRecordsOn(i.state) || roleOfName(i.name) !== 'implementer') return null;"],
  ['hand spawn: fanout start itself is refused', SS, "if (i.viaStart || !i.state ||", "if (!i.state ||"],
  ['hand spawn: refused under off', SS, "|| !seatRecordsOn(i.state) || roleOfName(i.name)", "|| roleOfName(i.name)"],
  ['hand spawn: every role is refused', SS, "|| roleOfName(i.name) !== 'implementer') return null;", ") return null;"],
  ['hand spawn: an unreadable state refuses', SS, "try { state = readState(stateFile(home, run)); } catch { return null; }", "state = readState(stateFile(home, run));"],
  ['main: dispatchAgentSpawnRequest does not ask', W, "  if (handSpawn) return { ok: false, error: handSpawn };\n", ""],
  ['main: the bypass is always on', W, "opts.viaFanoutStart === true); // #587 PR B", "true); // #587 PR B"],
  ['main: the implementer spawn does not pass the bypass', FW, "}, { viaFanoutStart: true });", "});"],
  ['main: an archived implementer counts as live', FW, "implementerLive: (id) => { const w = store.getWorkspace(id); return !!w && !w.archived; },", "implementerLive: (id) => { const w = store.getWorkspace(id); return !!w; },"],
  ['main: the respawn does not pass the base branch', FW, "...(i.baseBranch ? { baseBranch: i.baseBranch } : {}), ", ""],
  ['cli: start is not routed', X, "if (args[0] === 'start') { // #587 PR B", "if (args[0] === 'start-off') { // #587 PR B"],
  // the state
  ['state: a start record of 0 briefs loads', S, "if (!Number.isInteger(v.briefs) || (v.briefs as number) < 1) throw", "if (false) throw"],
  ['state: a start record with a bad kind loads', S, "if (v.kind !== 'spawn' && v.kind !== 'respawn') throw", "if (false) throw"],
  ['state: a start record with an unknown field loads', S, "refuseUnknown(v, new Set(['at', 'kind', 'briefHash', 'briefs']), `${where} start`);", ""],
  ['state: `start` is settable by state set', S, "refuseUnknown(patch, new Set<string>([...SETTABLE_KEYS, ...SEAT_PATCH_KEYS]), 'patch');", "refuseUnknown(patch, new Set<string>([...SETTABLE_KEYS, ...SEAT_PATCH_KEYS, 'start']), 'patch');"],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const base = run();
const baseOk = base.fail === 0 && base.skipped === 0 && base.pass >= 37 && base.pass === base.tests;
console.log(`control (unpatched copy): ${base.pass} pass / ${base.fail} fail / ${base.skipped} skipped → ${baseOk ? 'GREEN' : 'RED'}`);
if (!baseOk) { console.log(base.out.split('\n').filter((l) => /^not ok|error:/.test(l)).slice(0, 12).join('\n')); process.exit(1); }
if (!process.argv.includes('--mutants')) { fs.rmSync(scratch, { recursive: true, force: true }); process.exit(0); }

let survived = 0, refused = 0;
for (const [i, [name, file, from, to]] of mutants.entries()) {
  if (only && !name.includes(only)) continue;
  const f = path.join(scratch, file);
  const orig = fs.readFileSync(f, 'utf8');
  const n = orig.split(from).length - 1;
  if (n !== 1) { console.log(`M${String(i + 1).padStart(2, '0')} REFUSED (stale: the string occurs ${n}×, need exactly 1) — ${name}`); refused++; continue; }
  fs.writeFileSync(f, orig.replace(from, () => to));
  const r = run();
  fs.writeFileSync(f, orig);
  const killed = r.fail > 0 || Number.isNaN(r.pass); // a mutant that breaks loading (no TAP summary) is dead too
  if (!killed) survived++;
  console.log(`M${String(i + 1).padStart(2, '0')} ${killed ? 'KILLED' : 'SURVIVED'} (${r.pass} pass / ${r.fail} fail) — ${name}`);
}
const after = run(); // the restore is real: the copy is green again
const same = after.fail === 0 && after.pass === base.pass;
console.log(`\n${mutants.length - survived - refused}/${mutants.length} mutants killed, ${survived} survived, ${refused} refused; scratch restored → ${same ? 'GREEN' : 'RED'}`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(survived || refused || !same ? 1 : 0);
