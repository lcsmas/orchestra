// #510 — `orchestra fanout acceptance freeze|amend|show` (coordinator writes; the role guard denies freeze|amend elsewhere) + the I/O the gate and
// deliver clauses share: hashing the frozen files in a checkout (gate), re-reading them at a head through gh (deliver), the state reader.
// Pure decisions: src/shared/fanout-acceptance.ts. Schema + the one writer: src/shared/fanout-state.ts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FanoutStateError, SAFE_BRANCH, parseRunArgv, readState, runConfigOf, resolveFanoutRun, sha256Hex, stateFile, updateState,
  type Acceptance, type FanoutState, type TicketState,
} from '../shared/fanout-state.ts';
import {
  acceptanceBranch, acceptancePhase, amendInto, decideGateAcceptance, decisionApiPath, decisionNamesSentence, freezeInto, normaliseSentence, parseFileList, waiveInto,
  type AcceptancePhase, type FileStatus, type GateAcceptance,
} from '../shared/fanout-acceptance.ts';
import { acceptanceLine, homeOf, loadOrFail, needsAcceptor, parseArgs, runOf, spawnCall, type FanoutDeps, type HostCall, type RunResult, type Runner } from './fanout-state.ts';

export const ACCEPTANCE_USAGE = `usage: orchestra fanout acceptance freeze <ticket> [--run <id>] --files <p1,p2,…> --run-cmd "<cmd>" [--from <ref|dir>]
       orchestra fanout acceptance amend  <ticket> [--run <id>] --decision <ledger comment url> --spec-sentence "<text>" --files <p1,p2,…> [--from <ref|dir>] [--run-cmd "<cmd>"]
       orchestra fanout acceptance waive  <ticket> [--run <id>] --decision <ledger comment url> --reason "<why this ticket cannot have tests>"
       orchestra fanout acceptance spawn  <ticket> [--run <id>] [--replace]
       orchestra fanout acceptance show   <ticket> [--run <id>] [--json | --brief]

FORCED FLOW (#515): \`fanout state set <ticket> --spec <ref>\` registers the ticket's spec and Orchestra SPAWNS its \`accept-\` writer itself (Opus 5.5; brief = spec + ticket,
never an implementer branch; \`spawn\` re-requests it after a failure). The writer ends with \`freeze\` (its OWN ticket only; --from defaults to its checkout): the files are
committed to ONE shared branch ${'`'}acceptance/<run>${'`'} (a commit built from the writer's blobs, pushed without force; a path another ticket froze with other bytes is refused) and
Orchestra posts a bus status (path + command) to the ticket's --implementer / --verifier. Until then \`fanout gate\` WAITS (bounded) and \`deliver\` says acceptance-pending.
Harness (#538): the writer's brief names the repo's integration harness (declared: \`fanout state init|set --harness <ref>\`; else discovered on origin/<target>; else none, said in the brief)
and requires every frozen test to boot the FULL app module through it and to open its OWN execution context per test. The harness is imported as it stands on the target (residue below).
  waive   coordinator only, recorded: the ticket cannot have tests. --decision = a ledger comment URL of this repo that names the ticket (read through gh, fail closed).
          The other recorded escape is \`fanout deliver --no-acceptance-gate\`. Neither lifts a refusal for an edited or red frozen test.
  spawn   coordinator only: re-request the writer after a failed / stale spawn; --replace respawns even when one is recorded (its session died, was archived…).
  show    --brief = one line: where the tests are + the run command (or pending / waived).

Frozen acceptance tests (#510): the test writer's files are hashed (sha256 of the bytes) at --from (a git ref of the writer's branch, or a checkout dir),
and recorded in the ticket's fanout state with the targeted command (--run-cmd, run with cwd = the candidate checkout).
  freeze  the coordinator, or the ticket's own writer (#515); refused when already frozen (amend), on an empty/unsafe file list, a non-regular or uncommitted file, or a --run-cmd naming
          none of the frozen files. The command is a DIRECT runner call, executed WITHOUT a shell: first word in an allowlist (node, tsx, vitest [run],
          jest, mocha, pytest, python -I -m pytest|unittest, deno test, bun test, ruby, rspec; NO npx / pnpm exec / yarn exec launcher), only that runner's
          INERT flags from a fixed allowlist (e.g. node: --test, --test-reporter=spec|tap|dot|junit|lcov, --test-timeout=N — never --require, --env-file*,
          --experimental-*, --test-name-pattern, --check, a reporter/preload/config path), every other argument EXACTLY a frozen path, no shell metacharacter
          (no npm run / make / sh -c / env / ; & | $ # quotes). The command is part of the frozen hash. NOT checked (residue): argv[0] and anything on its search
          path — PATH, the checkout's module/import path, a runner config file (vitest.config.*, .mocharc, deno.json…), a helper the test imports — are resolved in the
          candidate's tree: keep the frozen tests self-contained (the one helper they may import is the repo's integration harness, #538 — NOT hashed either) and review changes to such files.
          ONE exception, #542: \`jest --config <path> <frozen files>\` (also \`--config=<path>\`; jest only, once, no other config-loading flag). <path> is repo-relative (no
          absolute / \`..\` / glob) and must be a regular file TRACKED at the tip of origin/<target> (checked at freeze and amend; untracked, writer-branch-only, symlink or
          behind a symlinked directory ⇒ refused, exit 2). Its sha256 is recorded in the ticket and in the frozen hash; the gate REFUSES (frozen-config-changed, exit 2, the
          command never run) a candidate whose config is not byte-identical to that, and deliver re-reads it at the PR head. A config that must legitimately change is
          re-recorded by the coordinator with \`amend\` (a ledger decision; amend re-reads the config from the target tip). What the config itself imports stays residue.
  amend   coordinator only; --decision = a GitHub ledger comment URL whose body (read through gh, fail closed) quotes --spec-sentence (≥ 12 chars,
          whitespace-normalised); appends {decision, specSentence, bodySha256, hashBefore, hashAfter}; refused (exit 2) without them, or when that decision comment (repo + id,
          however the URL is spelled, leading zeros included) already authorised an amendment of the ticket. --run-cmd replaces the command (same decision rules, same must-name-a-frozen-file rule). --from defaults to the recorded source branch.
  show    read-only, every role. \`fanout gate --ticket <id> --cwd <checkout>\` runs + hashes them; \`fanout deliver --acceptance <receipt>\` demands the receipt.
Exit 0 = ok, 2 = refused (policy), 1 = usage / could not check. A frozen file cannot be set by \`fanout state set\` (--json included).`;

/** A policy refusal (exit 2), as opposed to a usage error / could-not-check (exit 1). */
class Refusal extends Error {}

const REGULAR_MODES = new Set(['100644', '100755']);

/** `git ls-tree -r -z` output → path → mode (NUL-separated, so non-ASCII paths are not quoted). */
function treeModes(out: string): Map<string, string> {
  const modes = new Map<string, string>();
  for (const rec of out.split('\0')) {
    const m = /^(\d+) \w+ [0-9a-f]+\t([\s\S]+)$/.exec(rec);
    if (m) modes.set(m[2], m[1]);
  }
  return modes;
}

// ── reading the frozen files ──────────────────────────────────────────────────────────────────────────────

interface Frozen { files: Record<string, string>; source: Acceptance['source']; /** the checkout the blobs were read in + their git modes (the publish reuses them) */ repo: string; modes: Map<string, string> }

/** Hash `paths` as committed at `from`: a checkout DIR (HEAD, tracked files unmodified) or a git ref resolved in `cwd` with the runner. */
export function readFrozen(paths: string[], from: string, cwd: string, runner: Runner): Frozen {
  let repo = cwd;
  let rev = from;
  let branch: string | null = null;
  const asDir = path.resolve(cwd, from);
  let isDir = false;
  try { isDir = fs.statSync(asDir).isDirectory(); } catch { /* a ref, not a dir */ }
  if (isDir) {
    repo = asDir;
    rev = 'HEAD';
    const st = runner('git', ['status', '--porcelain', '--untracked-files=no'], repo);
    if (st.code !== 0) throw new FanoutStateError(`--from ${from}: not a git checkout (git status exit ${st.code})`);
    if (st.stdout.trim()) throw new FanoutStateError(`--from ${from}: uncommitted changes to tracked files — the writer commits first; the frozen bytes are the committed ones`);
    const b = runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo).stdout.trim();
    branch = b && b !== 'HEAD' && SAFE_BRANCH.test(b) ? b : null;
  } else {
    if (!/^[A-Za-z0-9._@+][A-Za-z0-9._/@+~^-]{0,199}$/.test(from)) throw new FanoutStateError(`--from ${JSON.stringify(from)} is neither a directory nor a plain git ref`);
    branch = /^[0-9a-f]{7,40}$/.test(from) || !SAFE_BRANCH.test(from) ? null : from;
  }
  const h = runner('git', ['rev-parse', '--verify', '-q', `${rev}^{commit}`], repo);
  const head = h.stdout.trim();
  if (h.code !== 0 || !/^[0-9a-f]{40}$/.test(head)) throw new FanoutStateError(`--from ${from}: not a commit in ${repo} (git rev-parse exit ${h.code}) — fetch the writer's branch first`);
  const tree = runner('git', ['ls-tree', '-r', '-z', '--full-tree', head, '--', ...paths], repo);
  if (tree.code !== 0) throw new FanoutStateError(`git ls-tree ${head.slice(0, 12)}: exit ${tree.code}`);
  const modes = treeModes(tree.stdout);
  const files: Record<string, string> = {};
  for (const p of paths) {
    const mode = modes.get(p);
    if (!mode) throw new FanoutStateError(`${p}: not in ${from} (${head.slice(0, 12)}) — a frozen test is a committed file of the writer's branch`);
    if (!REGULAR_MODES.has(mode)) throw new FanoutStateError(`${p}: not a regular file in ${from} (mode ${mode}); a symlink / submodule cannot be frozen`);
    const blob = runner('git', ['show', `${head}:${p}`], repo);
    if (blob.code !== 0) throw new FanoutStateError(`git show ${head.slice(0, 12)}:${p}: exit ${blob.code}`);
    if (blob.stdout.includes('�')) throw new FanoutStateError(`${p}: not valid UTF-8 text (the byte re-read cannot be exact) — freeze text files only`);
    files[p] = sha256Hex(Buffer.from(blob.stdout, 'utf8'));
  }
  return { files, source: { branch, head }, repo, modes };
}

// ── #542: the runner config a `jest --config <path>` command names ────────────────────────────────────────

/** The config's sha256 as committed at the TARGET tip (`origin/<target>`, else the local `<target>`): the baseline every candidate branches from. Refused (exit 2) when it is not a
 *  regular file TRACKED there (untracked, absent, a symlink / directory / submodule, or behind a symlinked directory: git lists no such path). Unreadable tip ⇒ could-not-check (1). */
export function readRunnerConfig(runner: Runner, repo: string, target: string, cfgPath: string): { path: string; sha256: string } {
  let tip = '';
  let ref = '';
  for (const c of [`origin/${target}`, target]) {
    const r = runner('git', ['rev-parse', '--verify', '-q', `${c}^{commit}`], repo);
    if (r.code === 0 && /^[0-9a-f]{40}$/.test(r.stdout.trim())) { tip = r.stdout.trim(); ref = c; break; }
  }
  if (!tip) throw new FanoutStateError(`--run-cmd names --config ${cfgPath}: cannot inspect the target tip (neither origin/${target} nor ${target} resolves in ${repo}) — fetch it first`);
  const mode = treeModes(runner('git', ['ls-tree', '-r', '-z', '--full-tree', tip, '--', cfgPath], repo).stdout).get(cfgPath);
  if (!mode) throw new Refusal(`the runner config ${cfgPath} is not a file tracked at the tip of ${ref} (${tip.slice(0, 12)}): --config must name a file committed in the target repo`);
  if (!REGULAR_MODES.has(mode)) throw new Refusal(`the runner config ${cfgPath} is not a regular file at ${ref} (mode ${mode}); a symlink / submodule cannot be a config`);
  const blob = runner('git', ['show', `${tip}:${cfgPath}`], repo);
  if (blob.code !== 0) throw new FanoutStateError(`git show ${tip.slice(0, 12)}:${cfgPath}: exit ${blob.code}`);
  if (blob.stdout.includes('\uFFFD')) throw new FanoutStateError(`${cfgPath}: not valid UTF-8 text (the byte re-read cannot be exact) — a runner config must be a text file`);
  return { path: cfgPath, sha256: sha256Hex(Buffer.from(blob.stdout, 'utf8')) };
}

// ── #515: publish to the ONE shared branch acceptance/<run> ───────────────────────────────────────────────

/** Add the frozen blobs to branch `acceptance/<run>` as ONE new commit on its remote tip (git plumbing on a scratch index: the writer's worktree and branch are untouched),
 *  pushed WITHOUT force; a lost race re-reads the tip and retries. A path another ticket already froze on that branch with other bytes is refused. */
export function publishFrozen(runner: Runner, f: Frozen, o: { run: string; ticket: string; paths: string[] }): Acceptance['source'] {
  const branch = acceptanceBranch(o.run);
  const git = (args: string[], env?: Record<string, string>) => runner('git', args, f.repo, env);
  const idx = path.join(process.env.TMPDIR || os.tmpdir(), `orchestra-accept-idx-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ls = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
      if (ls.code !== 0) throw new FanoutStateError(`cannot publish to ${branch}: git ls-remote origin failed (exit ${ls.code}) — the writer's checkout needs an origin remote`);
      const tip = ls.stdout.trim().split(/\s+/)[0] ?? '';
      if (tip && git(['fetch', '--quiet', 'origin', `refs/heads/${branch}`]).code !== 0) throw new FanoutStateError(`cannot publish to ${branch}: git fetch origin ${branch} failed`);
      const env = { GIT_INDEX_FILE: idx };
      fs.rmSync(idx, { force: true });
      if (git(tip ? ['read-tree', tip] : ['read-tree', '--empty'], env).code !== 0) throw new FanoutStateError('git read-tree failed');
      for (const p of o.paths) {
        const blob = git(['rev-parse', '--verify', '-q', `${f.source.head}:${p}`]).stdout.trim();
        if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new FanoutStateError(`${p}: no blob at ${f.source.head.slice(0, 12)}`);
        if (tip) {
          const there = git(['rev-parse', '--verify', '-q', `${tip}:${p}`]).stdout.trim();
          if (there && there !== blob) throw new Refusal(`${p} is already on ${branch} with other bytes (another ticket froze it): a frozen path belongs to ONE ticket — choose another path`);
        }
        if (git(['update-index', '--add', '--cacheinfo', f.modes.get(p) ?? '100644', blob, p], env).code !== 0) throw new FanoutStateError(`git update-index ${p} failed`);
      }
      const tree = git(['write-tree'], env).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new FanoutStateError('git write-tree failed');
      if (tip && git(['rev-parse', `${tip}^{tree}`]).stdout.trim() === tree) return { branch, head: tip }; // same bytes already published
      const c = git(['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', `acceptance(${o.ticket}): freeze ${o.paths.length} file(s) [${o.run}]`]);
      const commit = c.stdout.trim();
      if (c.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) throw new FanoutStateError(`git commit-tree failed: ${c.stderr.trim().slice(0, 200)}`);
      if (git(['push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`]).code === 0) return { branch, head: commit };
    }
    throw new FanoutStateError(`could not push ${branch} after 3 attempts (another writer keeps winning the race, or the push is refused) — nothing was frozen`);
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

// ── freeze | amend | show ─────────────────────────────────────────────────────────────────────────────────

export function runAcceptance(args: string[], deps: FanoutDeps): RunResult {
  try {
    return runAcceptanceInner(args, deps);
  } catch (e) {
    if (e instanceof Refusal) return { code: 2, stdout: '', stderr: `refused: ${e.message}\n` };
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

function runAcceptanceInner(args: string[], deps: FanoutDeps): RunResult {
  const [verb, ...rest] = args;
  if (!verb || verb === '--help' || verb === '-h') return { code: verb ? 0 : 1, stdout: verb ? `${ACCEPTANCE_USAGE}\n` : '', stderr: verb ? '' : `${ACCEPTANCE_USAGE}\n` };
  if (verb === 'freeze') {
    const p = parseArgs(rest, ['--run', '--files', '--run-cmd', '--from'], []);
    const ticket = oneTicket(p.pos, 'freeze');
    for (const f of ['--files', '--run-cmd']) if (!p.vals[f]) throw new FanoutStateError(`${f} is required\n${ACCEPTANCE_USAGE}`);
    const run = p.vals['--run-cmd'].trim();
    if (!run || run.length > 2000 || /[\r\n\0]/.test(run)) throw new FanoutStateError('--run-cmd must be a single-line command (≤ 2000 chars)');
    const paths = parseFileList(p.vals['--files']);
    const r = runOf(p, deps, 'write');
    const file = stateFile(homeOf(deps.env), r.run);
    const st0 = loadOrFail(file);
    const had = st0.tickets[ticket];
    const caller = (deps.env.ORCHESTRA_WS_ID || deps.env.ORCHESTRA_WS_ID_IDENTITY || '').trim();
    // #515: the writer is role-limited to ITS OWN ticket — a workspace recorded as another ticket's writer may not freeze this one.
    const own = Object.entries(st0.tickets).find(([, t]) => caller && t.accept?.acceptor?.id === caller);
    if (own && own[0] !== ticket) throw new Refusal(`you are the test writer of ticket ${own[0]}; you may freeze only that ticket, not ${ticket}`);
    // …and ONLY that ticket's recorded writer (in the run this freeze addresses) or the run's coordinator may freeze it; no workspace identity ⇒ refused (the host posts the status on no one else's word; #515 review M1).
    if (!caller) throw new Refusal(`${ticket}: no workspace identity (ORCHESTRA_WS_ID is empty): only the run's coordinator or the ticket's recorded test writer may freeze — run it from your workspace`);
    if (caller !== r.run && caller !== had?.accept?.acceptor?.id) throw new Refusal(`${ticket}: only its test writer${had?.accept?.acceptor?.id ? ` (${had.accept.acceptor.id})` : ' (none recorded in this run)'} or the run's coordinator (${r.run}) may freeze it, not ${caller}`);
    if (had?.acceptance) throw new Refusal(`${ticket}: acceptance tests are already frozen (hash ${had.acceptance.hash.slice(0, 12)}) — change them with \`orchestra fanout acceptance amend\` (coordinator, ledger decision)`);
    if (had?.accept?.waived) throw new Refusal(`${ticket}: acceptance is waived (${had.accept.waived.decision}) — nothing to freeze`);
    const cfgPath = runConfigOf(run, paths); // #542: also validates the command BEFORE anything is published
    const frozen = readFrozen(paths, p.vals['--from'] ?? '.', deps.cwd, deps.runner);
    const config = cfgPath ? readRunnerConfig(deps.runner, frozen.repo, st0.target, cfgPath) : undefined;
    // #515: a ticket registered with a spec has its tests PUBLISHED to the one shared branch acceptance/<run>; the recorded source is that published commit.
    const forced = !!had?.spec;
    const source = forced ? publishFrozen(deps.runner, frozen, { run: r.run, ticket, paths }) : frozen.source;
    const next = updateState(file, (cur) => {
      if (!cur) throw new FanoutStateError(`no state at ${file} — run \`orchestra fanout state init\` first`);
      return freezeInto(cur, ticket, { files: frozen.files, run, ...(config ? { config } : {}), source, now: deps.now() });
    });
    const a = next.tickets[ticket].acceptance!;
    const hostCalls: HostCall[] | undefined = forced ? [{ route: '/fanoutAcceptance', body: { op: 'frozen', run: r.run, ticket, ...(caller ? { from: caller } : {}) } }] : undefined;
    return { code: 0, stdout: `${ticket}: froze ${paths.length} file(s) hash=${a.hash.slice(0, 12)} @ ${a.source.head.slice(0, 12)}${a.source.branch ? ` (${a.source.branch})` : ''}\n${a.config ? `runner config ${a.config.path} recorded (sha256 ${a.config.sha256.slice(0, 12)}): a candidate whose copy differs is refused at the gate\n` : ''}${had ? '' : `note: ticket ${ticket} was not in the state of run ${r.run} — created (todo); a typo? \`orchestra fanout state show\` lists the tickets\n`}`, stderr: r.note, ...(hostCalls ? { hostCalls } : {}) };
  }
  if (verb === 'waive') {
    const p = parseArgs(rest, ['--run', '--decision', '--reason'], []);
    const ticket = oneTicket(p.pos, 'waive');
    const decision = p.vals['--decision']?.trim();
    if (decision === undefined || decision === '') throw new Refusal('a waiver needs --decision <ledger comment url> (the coordinator\'s recorded decision) — none given');
    const reason = p.vals['--reason']?.trim();
    if (!reason) throw new Refusal('a waiver needs --reason "<why this ticket cannot have acceptance tests>" — none given');
    const api = decisionApiPath(decision);
    if (!api) throw new FanoutStateError(`--decision must be a GitHub ledger comment URL (https://github.com/<o>/<r>/issues/<n>#issuecomment-<id>), got ${JSON.stringify(decision)}`);
    const r = runOf(p, deps, 'write');
    const file = stateFile(homeOf(deps.env), r.run);
    const st0 = loadOrFail(file);
    if (!st0.tickets[ticket]) throw new FanoutStateError(`ticket ${ticket} is not in the fanout state of run ${r.run}`);
    const decisionRepo = /^repos\/([^/]+\/[^/]+)\//.exec(api)?.[1] ?? '';
    if (st0.repo !== null && st0.repo.toLowerCase() !== decisionRepo.toLowerCase()) throw new Refusal(`the decision is a comment of ${decisionRepo}, not of this vague's repo ${st0.repo}`);
    const g = deps.runner('gh', ['api', api], deps.cwd);
    if (g.code !== 0) throw new FanoutStateError(`could not read the decision ${decision} (gh api exit ${g.code}): ${g.stderr.trim().slice(0, 300)}`);
    let body: unknown;
    try { body = (JSON.parse(g.stdout) as { body?: unknown }).body; } catch { body = undefined; }
    if (typeof body !== 'string') throw new FanoutStateError(`could not read the decision ${decision}: gh returned no comment body`);
    if (!body.toLowerCase().includes(ticket.toLowerCase())) throw new Refusal(`the decision comment does not name ticket ${ticket}: a waiver is a ledger decision about THIS ticket`);
    try {
      updateState(file, (c) => {
        if (!c) throw new FanoutStateError(`no state at ${file}`);
        return waiveInto(c, ticket, { decision, reason, now: deps.now() });
      });
    } catch (e) {
      if (e instanceof FanoutStateError && /already waived|nothing to waive/.test(e.message)) throw new Refusal(e.message);
      throw e;
    }
    return { code: 0, stdout: `${ticket}: acceptance waived (${decision}) — ${reason}\n`, stderr: r.note };
  }
  if (verb === 'spawn') {
    const p = parseArgs(rest, ['--run'], ['--replace']);
    const ticket = oneTicket(p.pos, 'spawn');
    const r = runOf(p, deps, 'use');
    const t = loadOrFail(stateFile(homeOf(deps.env), r.run)).tickets[ticket];
    if (!t) throw new FanoutStateError(`ticket ${ticket} is not in the fanout state of run ${r.run}`);
    const replace = p.bools.has('--replace');
    if (replace ? acceptancePhase(t) !== 'pending' : !needsAcceptor(t, deps.now())) throw new Refusal(`${ticket}: no writer is owed (${t.accept?.acceptor && !t.accept.acceptor.error ? `writer ${t.accept.acceptor.name} exists` : acceptancePhase(t) === 'pending' ? 'nothing to do' : `acceptance is ${acceptancePhase(t)}`})`);
    return { code: 0, stdout: `${ticket}: requesting its accept- writer from Orchestra\n`, stderr: r.note, hostCalls: [spawnCall(r.run, ticket, deps, replace)] };
  }
  if (verb === 'amend') {
    const p = parseArgs(rest, ['--run', '--decision', '--spec-sentence', '--files', '--from', '--run-cmd'], []);
    const ticket = oneTicket(p.pos, 'amend');
    const decision = p.vals['--decision']?.trim();
    if (!decision) throw new Refusal('an amendment needs --decision <ledger comment url> (the coordinator\'s recorded decision) — none given');
    const sentence = p.vals['--spec-sentence'];
    if (!sentence || !sentence.trim()) throw new Refusal('an amendment needs --spec-sentence "<the spec sentence the change follows>" — none given');
    if (!p.vals['--files']) throw new FanoutStateError(`--files is required\n${ACCEPTANCE_USAGE}`);
    const api = decisionApiPath(decision);
    if (!api) throw new FanoutStateError(`--decision must be a GitHub ledger comment URL (https://github.com/<o>/<r>/issues/<n>#issuecomment-<id>), got ${JSON.stringify(decision)}`);
    const paths = parseFileList(p.vals['--files']);
    const r = runOf(p, deps, 'write');
    const file = stateFile(homeOf(deps.env), r.run);
    const st0 = loadOrFail(file);
    const cur = st0.tickets[ticket];
    const decisionRepo = /^repos\/([^/]+\/[^/]+)\//.exec(api)?.[1] ?? '';
    if (st0.repo && decisionRepo.toLowerCase() !== st0.repo.toLowerCase()) throw new Refusal(`the decision is a comment of ${decisionRepo}, not of this vague's repo ${st0.repo}`);
    if (!cur) throw new FanoutStateError(`ticket ${ticket} is not in the fanout state of run ${r.run}`);
    if (!cur.acceptance) throw new FanoutStateError(`${ticket}: no frozen acceptance tests to amend — freeze first`);
    const from = p.vals['--from'] ?? cur.acceptance.source.branch;
    if (!from) throw new FanoutStateError('--from is required: the recorded source has no branch');
    // The decision is read through gh, fail closed: an unreadable comment is "could not check" (1), a comment without the sentence is a refusal (2).
    const g = deps.runner('gh', ['api', api], deps.cwd);
    if (g.code !== 0) throw new FanoutStateError(`could not read the decision ${decision} (gh api exit ${g.code}): ${g.stderr.trim().slice(0, 300)}`);
    let body: unknown;
    try { body = (JSON.parse(g.stdout) as { body?: unknown }).body; } catch { body = undefined; }
    if (typeof body !== 'string') throw new FanoutStateError(`could not read the decision ${decision}: gh returned no comment body`);
    const ok = decisionNamesSentence(body, sentence);
    if (!ok.ok) throw new Refusal(ok.why);
    const frozen = readFrozen(paths, from, deps.cwd, deps.runner);
    const newRun = p.vals['--run-cmd']?.trim();
    if (p.vals['--run-cmd'] !== undefined && (!newRun || newRun.length > 2000 || /[\r\n\0]/.test(newRun))) throw new FanoutStateError('--run-cmd must be a single-line command (≤ 2000 chars)');
    const cfgPath = runConfigOf(newRun ?? cur.acceptance.run, paths);
    const config = cfgPath ? readRunnerConfig(deps.runner, frozen.repo, st0.target, cfgPath) : undefined; // an amend re-records the config's bytes from the target tip
    let hashes: { before: string; after: string } | null = null;
    updateState(file, (c) => {
      if (!c) throw new FanoutStateError(`no state at ${file}`);
      try {
        const n = amendInto(c, ticket, { files: frozen.files, decision, specSentence: normaliseSentence(sentence), bodySha256: sha256Hex(Buffer.from(body, 'utf8')), source: frozen.source, ...(newRun ? { run: newRun } : {}), ...(config ? { config } : {}), now: deps.now() });
        const am = n.tickets[ticket].acceptance!.amendments.at(-1)!;
        hashes = { before: am.hashBefore, after: am.hashAfter };
        return n;
      } catch (e) {
        if (e instanceof FanoutStateError && /changes nothing|already authorised/.test(e.message)) throw new Refusal(e.message);
        throw e;
      }
    });
    const h = hashes as { before: string; after: string } | null;
    return { code: 0, stdout: `${ticket}: amended ${h?.before.slice(0, 12)} → ${h?.after.slice(0, 12)} (decision ${decision})\n`, stderr: r.note };
  }
  if (verb === 'show') {
    const p = parseArgs(rest, ['--run'], ['--json', '--brief']);
    const ticket = oneTicket(p.pos, 'show');
    const r = runOf(p, deps, 'use');
    const s: FanoutState = loadOrFail(stateFile(homeOf(deps.env), r.run));
    const t = s.tickets[ticket];
    if (!t) throw new FanoutStateError(`ticket ${ticket} is not in the fanout state of run ${r.run}`);
    const a = t.acceptance;
    if (p.bools.has('--brief')) return { code: 0, stdout: `${acceptanceLine(ticket, t) ?? `${ticket}  no acceptance flow (no spec registered, nothing frozen)`}\n`, stderr: r.note };
    if (p.bools.has('--json')) return { code: 0, stdout: `${JSON.stringify(a, null, 2)}\n`, stderr: r.note };
    if (!a) return { code: 0, stdout: `${ticket}: no frozen acceptance tests\n`, stderr: r.note };
    const lines = [
      `${ticket}: frozen hash=${a.hash.slice(0, 12)} (${Object.keys(a.files).length} file(s)) at ${a.frozenAt}`,
      `  run:    ${a.run}`,
      ...(a.config ? [`  config: ${a.config.sha256.slice(0, 12)}  ${a.config.path}  (not a frozen test: the gate refuses a candidate whose copy differs)`] : []),
      `  source: ${a.source.branch ?? '-'}@${a.source.head.slice(0, 12)}`,
      ...Object.entries(a.files).map(([f, h]) => `  ${h.slice(0, 12)}  ${f}`),
      `  amendments: ${a.amendments.length}`,
      ...a.amendments.map((m) => `    ${m.at} ${m.hashBefore.slice(0, 12)} → ${m.hashAfter.slice(0, 12)} ${m.decision}`),
    ];
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: r.note };
  }
  throw new FanoutStateError(`unknown acceptance verb "${verb}"\n${ACCEPTANCE_USAGE}`);
}

function oneTicket(pos: string[], verb: string): string {
  if (pos.length !== 1) throw new FanoutStateError(`usage: orchestra fanout acceptance ${verb} <ticket> …`);
  return pos[0];
}

// ── the state reader (gate, deliver) ──────────────────────────────────────────────────────────────────────

/** `lenient` (the gate WITHOUT an explicit --run): an absent state / ticket = `known:false`, reported as `acceptance:{consulted:false}` (deliver, the merge authority, is strict; so is the gate with --run). `consulted:false` = no state at all (no --run, none at the caller's own run). Throws (FanoutStateError) like `upstreamsFromState`: explicit --run with
 *  no state, a ticket the existing state does not name, or an unreadable state — fail closed. */
/** What the gate / deliver read of a ticket: its frozen tests, its #515 phase, and the ticket itself + the run it was found in (`run`, for the wait and the bypass record). */
export interface AcceptanceRead { consulted: boolean; known: boolean; acceptance: Acceptance | null; phase: AcceptancePhase; ticket?: TicketState; run?: string }
export function acceptanceFromState(opts: { ticket: string; run?: string; lenient?: boolean }, env: NodeJS.ProcessEnv = process.env): AcceptanceRead {
  const { run, inherited } = resolveFanoutRun(opts.run, env);
  if (!run) return { consulted: false, known: false, acceptance: null, phase: 'none' };
  const home = env.ORCHESTRA_HOME && env.ORCHESTRA_HOME.trim() ? env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
  // A verifier has no state of its own run: without --run the ticket is looked up in its own run, then in the run it inherits (#486, like show/resume).
  let sawState = false;
  for (const r of [run, ...(opts.run ? [] : inherited ? [inherited] : [])]) {
    const state = readState(stateFile(home, r));
    if (!state) continue;
    sawState = true;
    const t = state.tickets[opts.ticket];
    if (t) return { consulted: true, known: true, acceptance: t.acceptance, phase: acceptancePhase(t), ticket: t, run: r };
  }
  if (!sawState) {
    if (opts.run && !opts.lenient) throw new FanoutStateError(`no fanout state for --run ${opts.run}: a wrong run id would skip the acceptance clause`);
    return { consulted: false, known: false, acceptance: null, phase: 'none' };
  }
  if (opts.lenient) return { consulted: true, known: false, acceptance: null, phase: 'none' };
  throw new FanoutStateError(`ticket ${opts.ticket} is not in the fanout state of run ${run}${inherited && !opts.run ? ` or ${inherited}` : ''}: a mistyped --ticket would skip the acceptance clause`);
}

// ── gate: hash + run in the candidate checkout ────────────────────────────────────────────────────────────

export interface CheckoutIo {
  git: (args: string[], cwd: string) => { code: number; stdout: string };
  /** The bytes of a regular file, null when absent / not a regular file. */
  readFile: (abs: string) => Buffer | null;
  /** Executes `argv` directly (NO shell). */
  run: (argv: string[], cwd: string) => { exit: number; tail: string };
}

export const realCheckoutIo: CheckoutIo = {
  git: (args, cwd) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }); return { code: r.status ?? 1, stdout: r.stdout ?? '' }; },
  readFile: (abs) => { try { return fs.lstatSync(abs).isFile() ? fs.readFileSync(abs) : null; } catch { return null; } },
  run: (argv, cwd) => {
    // NODE_TEST_CONTEXT (set when the gate itself runs under `node --test`) turns a nested `node --test` into a silent exit-0 child: scrub it.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-40).join('\n');
    return { exit: r.status ?? (r.error ? 127 : 1), tail: out };
  },
};

/** #542 — the runner config the frozen command names, in the candidate checkout: a regular tracked file at HEAD whose worktree bytes AND blob at HEAD are the ones recorded at freeze. */
function configStatus(io: CheckoutIo, root: string, cfg: { path: string; sha256: string }): FileStatus {
  const mode = treeModes(io.git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', cfg.path], root).stdout).get(cfg.path);
  const bytes = REGULAR_MODES.has(mode ?? '') ? io.readFile(path.join(root, cfg.path)) : null;
  if (bytes === null) return { path: cfg.path, status: 'missing', config: true };
  const blob = io.git(['show', `HEAD:${cfg.path}`], root);
  const atHead = blob.code === 0 && !blob.stdout.includes('\uFFFD') && sha256Hex(Buffer.from(blob.stdout, 'utf8')) === cfg.sha256;
  return { path: cfg.path, status: sha256Hex(bytes) === cfg.sha256 && atHead ? 'same' : 'changed', config: true };
}

/** The acceptance clause of `fanout gate`: `--cwd` required, its HEAD = `--head`, tracked files clean, every frozen file byte-identical (and a regular
 *  file at HEAD), then the frozen command runs there. The command only runs once the bytes are proven. */
export function checkAcceptanceInCheckout(acc: Acceptance, o: { cwd?: string; head: string; ticket?: string; log?: (s: string) => void }, io: CheckoutIo = realCheckoutIo): GateAcceptance {
  const cwd = o.cwd ? path.resolve(o.cwd) : null;
  let root: string | null = null;
  let cwdHead: string | null = null;
  let cwdTree: string | null = null;
  let dirty: string[] = [];
  let files: FileStatus[] = [];
  let config: FileStatus | undefined;
  if (cwd) {
    const top = io.git(['rev-parse', '--show-toplevel'], cwd);
    const hd = io.git(['rev-parse', 'HEAD'], cwd);
    try { root = top.code === 0 && fs.realpathSync(top.stdout.trim()) === fs.realpathSync(cwd) ? cwd : null; } catch { root = null; }
    cwdHead = root && hd.code === 0 && /^[0-9a-f]{40}$/.test(hd.stdout.trim()) ? hd.stdout.trim() : null;
    if (root && cwdHead) {
      const tr = io.git(['rev-parse', 'HEAD^{tree}'], root); // #512: the receipt names the CONTENT it was run on
      cwdTree = tr.code === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tr.stdout.trim()) ? tr.stdout.trim() : null;
      const st = io.git(['status', '--porcelain', '--untracked-files=no'], root);
      dirty = st.code === 0 ? st.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean) : ['(git status failed)'];
      const paths = Object.keys(acc.files);
      const modes = treeModes(io.git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', ...paths], root).stdout);
      files = paths.map((p) => {
        const bytes = REGULAR_MODES.has(modes.get(p) ?? '') ? io.readFile(path.join(root!, p)) : null;
        if (bytes === null) return { path: p, status: 'missing' as const };
        // the bytes the command will run AND the blob at HEAD must both be the frozen ones (a skip-worktree / assume-unchanged file can hide the former from `git status`)
        const blob = io.git(['show', `HEAD:${p}`], root!);
        const atHead = blob.code === 0 && !blob.stdout.includes('\uFFFD') && sha256Hex(Buffer.from(blob.stdout, 'utf8')) === acc.files[p];
        return { path: p, status: sha256Hex(bytes) === acc.files[p] && atHead ? 'same' as const : 'changed' as const };
      });
      if (acc.config) config = configStatus(io, root, acc.config); // #542
    }
  }
  return decideGateAcceptance(acc, {
    cwdGiven: !!cwd, cwdHead, head: o.head, dirty, files, ...(config ? { config } : {}), cwdTree, ...(o.ticket ? { ticket: o.ticket } : {}),
    run: () => { const r = io.run(parseRunArgv(acc.run, Object.keys(acc.files)), root!); if (r.exit !== 0 && r.tail) o.log?.(`frozen tests (${acc.run}) exit ${r.exit}:\n${r.tail}`); return { cmd: acc.run, exit: r.exit }; },
  });
}

// ── deliver: independent byte re-read at the PR head through gh ───────────────────────────────────────────

/** Each frozen path's bytes at `head`, read through gh. 404 = missing; any other gh failure throws (could-not-check). */
export async function rereadFrozenAtHead(
  acc: Acceptance, head: string, repo: string | undefined, gh: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<FileStatus[]> {
  const base = `repos/${repo ?? '{owner}/{repo}'}/contents`;
  // a 404 on a CONTENT path means "no such file"; a 404 on the head itself (unpushed head, wrong --repo) is could-not-check, never "the test is missing"
  const c = await gh(['api', `repos/${repo ?? '{owner}/{repo}'}/commits/${head}`]);
  if (c.code !== 0) throw new Error(`gh api commits/${head.slice(0, 12)} failed (exit ${c.code}): ${c.stderr.trim().slice(0, 300)} — is the head pushed to that repo?`);
  const out: FileStatus[] = [];
  for (const [p, want] of Object.entries(acc.files)) {
    const r = await gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `${base}/${p.split('/').map(encodeURIComponent).join('/')}?ref=${head}`]);
    if (r.code !== 0) {
      if (/404|Not Found/i.test(r.stderr)) { out.push({ path: p, status: 'missing' }); continue; }
      throw new Error(`gh api contents/${p}@${head.slice(0, 12)} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    }
    out.push({ path: p, status: !r.stdout.includes('�') && sha256Hex(Buffer.from(r.stdout, 'utf8')) === want ? 'same' : 'changed' });
  }
  if (acc.config) { // #542: the runner config at the PR head must still be the bytes recorded at freeze
    const p = acc.config.path;
    const r = await gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `${base}/${p.split('/').map(encodeURIComponent).join('/')}?ref=${head}`]);
    if (r.code !== 0 && !/404|Not Found/i.test(r.stderr)) throw new Error(`gh api contents/${p}@${head.slice(0, 12)} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    out.push({ path: p, config: true, status: r.code !== 0 ? 'missing' : !r.stdout.includes('�') && sha256Hex(Buffer.from(r.stdout, 'utf8')) === acc.config.sha256 ? 'same' : 'changed' });
  }
  return out;
}
