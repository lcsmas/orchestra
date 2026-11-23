// #510 — `orchestra fanout acceptance freeze|amend|show` (coordinator writes; the role guard denies freeze|amend elsewhere) + the I/O the gate and
// deliver clauses share: hashing the frozen files in a checkout (gate), re-reading them at a head through gh (deliver), the state reader.
// Pure decisions: src/shared/fanout-acceptance.ts. Schema + the one writer: src/shared/fanout-state.ts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FanoutStateError, SAFE_BRANCH, parseRunArgv, readState, runConfigOf, resolveFanoutRun, sha256Hex, stateFile, updateState,
  type Acceptance, type FanoutState, type FreezeCheck, type TicketState,
} from '../shared/fanout-state.ts';
import { changedLines, compareFrozenSets } from '../shared/fanout-assertions.ts';
import {
  AcceptanceOffError, acceptableBytes, acceptanceBranch, acceptanceOn, acceptancePhase, assertAcceptanceOn, amendHarnessInto, amendInto, amendedStatusText, decideGateAcceptance, decisionApiPath, decisionNamesSentence, freezeInto, normaliseSentence, parseFileList, waiveInto,
  type AcceptancePhase, type FileStatus, type GateAcceptance,
} from '../shared/fanout-acceptance.ts';
import { checkOnTargetTip, freezeTimeoutMs, realFreezeIo, type FreezeIo } from './fanout-freeze-check.ts';
import { formatErrors } from '../shared/fanout-freeze-classify.ts';
import { acceptanceLine, homeOf, loadOrFail, needsAcceptor, parseArgs, runOf, spawnCall, type FanoutDeps, type HostCall, type RunResult, type Runner } from './fanout-state.ts';

export const ACCEPTANCE_USAGE = `usage: orchestra fanout acceptance freeze <ticket> [--run <id>] --files <p1,p2,…> --run-cmd "<cmd>" [--from <ref|dir>] [--accept-unclassified "<why>"]
       orchestra fanout acceptance amend  <ticket> [--run <id>] --decision <ledger comment url> --spec-sentence "<text>" --files <p1,p2,…> [--from <ref|dir>] [--run-cmd "<cmd>"]
       orchestra fanout acceptance amend  <ticket> [--run <id>] --harness-only --reason "<why the harness changed>" --files <p1,p2,…> [--from <ref|dir>]
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
  amend --harness-only (#540)  coordinator only, NO decision: the same file set + command, setup / teardown / context changed, the assertions NOT. Orchestra extracts, from the recorded bytes and from --from,
          the contract statements and requires them byte-identical in order (JS/TS and Python; any other file, an unlexable one or one with no assertion = unknown shape ⇒ REFUSED, use the decision amend):
          assertions (expect / assert / should / t.* / any assert*|expect*|verify* call, e.g. supertest .expect) with the control prefix on their line (if (false), 0 &&, setTimeout(() =>) and the
          non-test blocks enclosing them (try, a function, a label); test declarations (title, { skip } options, callback parameters); imports / bindings of the runner and assert identifiers; return / throw /
          break / continue inside a test body; assertion-NAMED definitions (function expectOk, def assertEqual) pinned in full, and X.assert* assignments / mock.patch of assert*; skip / exit neutralisers (.skip, this.skip(), pytestmark, process.on). Comments, indentation and spacing between statements are ignored; text inside a string is not.
          Records {kind:harness-only, assertionsHash, reason, filesBefore, lines}, publishes the new bytes to ${'`'}acceptance/<run>${'`'} (rolled back if the state write fails) and tells the implementer + verifier.
          It PRINTS the non-assertion lines it changed: that is what you attest. NOT proven: a VALUE an assertion references that a setup line defines (const expected = 2, run = async () => 5), what a helper the
          tests call does, a runner config file, alias forms of patching an assert (Object.defineProperty(assert…), assert['equal']=, jest.spyOn / vi.mock of the assert module, process.once / exitCode) — a best-effort denylist; read the printed diff (capped at 40 lines; a reorder-only change is announced as such). Known limit: after a DECISION amend of a forced ticket the shared branch no longer holds the recorded bytes, so --harness-only is refused for it. \`fanout gate\` / \`deliver\` then ACCEPT a candidate still holding a previous recorded version (gate: the amended bytes are run from
          the shared branch, hash-proven, the candidate's file restored; no copy); other bytes stay \`frozen-test-changed\`; a receipt for the old hash is \`acceptance-stale\`.
  show    read-only, every role. \`fanout gate --ticket <id> --cwd <checkout>\` runs + hashes them; \`fanout deliver --acceptance <receipt>\` demands the receipt.
  freeze check (#539): freeze first RUNS the frozen command ONCE on the current tip of the state's target (fetched fresh, in a clean scratch checkout with the frozen files laid over it —
          not the writer's tree) and classifies each test from the runner's STRUCTURED output (node --test: its TAP reporter; jest: ${'`'}--json --outputFile${'`'} — forced for that run only; the frozen command and its hash are unchanged).
          pass or an assertion FAIL (the behaviour is not built yet) = accepted. ERROR = REFUSED (exit 2), nothing published or recorded, the test + its error named: a setup / teardown /
          hook failure, a non-assertion exception, a crash, a file that does not load (import / syntax error, top-level throw), a timeout (the runner's own, or ${'`'}ORCHESTRA_FREEZE_CHECK_TIMEOUT_MS${'`'},
          default 10 min). Fix the tests and re-freeze. Output that cannot be classified (a runner without an adapter — node --test and jest have one — truncated or inconsistent output) FAILS CLOSED
          with the reason; the coordinator alone may record an escape: ${'`'}--accept-unclassified "<why>"${'`'} (kept in the ticket's acceptance.freezeCheck; it never lifts a classified ERROR).
          jest: an assertion FAIL = an ${'`'}expect${'`'} failure (a matcher, ${'`'}.rejects/.resolves${'`'} on a promise that settles the other way, ${'`'}expect.assertions/hasAssertions${'`'}); anything else — a hook, a thrown
          exception, a timeout, a ${'`'}node:assert${'`'} failure — is an ERROR. LIMITS: an ${'`'}expect()${'`'} failing inside beforeAll / beforeEach / afterEach is indistinguishable from one in the test body (jest exposes
          no field) and reads as an assertion FAIL; ${'`'}.resolves${'`'} on a promise that REJECTED is an ERROR (the one fixed jest phrase read); an error whose stack is forged to look like the expect library's (or a custom error thrown from a directory named expect/build) reads as an assertion FAIL — that fails toward a frozen RED test the gate still runs. The runner (argv[0]) is resolved on the PATH the freeze INHERITS — the gate resolves it the same way; not found ⇒ "could not be started".
          RESIDUE of the scratch: it is ${'`'}git archive${'`'} of the tip (no export-ignored path, submodule, LFS content or gitignored build output) + the writer repo's TOP-LEVEL ${'`'}node_modules${'`'}
          linked in (a workspace package's own node_modules is absent ⇒ a load failure ⇒ refused; root links into a workspace package resolve into the WRITER's tree). ${'`'}amend${'`'} does not re-run the check.
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

interface Frozen { files: Record<string, string>; /** the UTF-8 text of each file (the #540 assertion check reads it) */ texts: Record<string, string>; source: Acceptance['source']; /** the checkout the blobs were read in + their git modes (the publish reuses them) */ repo: string; modes: Map<string, string> }

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
  const texts: Record<string, string> = {};
  for (const p of paths) {
    const mode = modes.get(p);
    if (!mode) throw new FanoutStateError(`${p}: not in ${from} (${head.slice(0, 12)}) — a frozen test is a committed file of the writer's branch`);
    if (!REGULAR_MODES.has(mode)) throw new FanoutStateError(`${p}: not a regular file in ${from} (mode ${mode}); a symlink / submodule cannot be frozen`);
    const blob = runner('git', ['show', `${head}:${p}`], repo);
    if (blob.code !== 0) throw new FanoutStateError(`git show ${head.slice(0, 12)}:${p}: exit ${blob.code}`);
    if (blob.stdout.includes('�')) throw new FanoutStateError(`${p}: not valid UTF-8 text (the byte re-read cannot be exact) — freeze text files only`);
    files[p] = sha256Hex(Buffer.from(blob.stdout, 'utf8'));
    texts[p] = blob.stdout;
  }
  return { files, texts, source: { branch, head }, repo, modes };
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
export function publishFrozen(runner: Runner, f: Frozen, o: { run: string; ticket: string; paths: string[]; /** #540: path → sha256 the branch may currently hold for it (this ticket's own recorded bytes), replaced by the amended ones */ replace?: Record<string, string>; verb?: string }): Acceptance['source'] {
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
          let there = git(['rev-parse', '--verify', '-q', `${tip}:${p}`]).stdout.trim();
          // #540: the ticket's OWN recorded bytes on the branch (`o.replace`) may be replaced by its harness-only amend; anything else there stays refused
          if (there && there !== blob && o.replace?.[p] !== undefined && (() => { const t = git(['show', `${tip}:${p}`]); return t.code === 0 && sha256Hex(Buffer.from(t.stdout, 'utf8')) === o.replace![p]; })()) there = blob;
          if (there && there !== blob) throw new Refusal(`${p} is already on ${branch} with other bytes (another ticket froze it): a frozen path belongs to ONE ticket — choose another path`);
        }
        if (git(['update-index', '--add', '--cacheinfo', f.modes.get(p) ?? '100644', blob, p], env).code !== 0) throw new FanoutStateError(`git update-index ${p} failed`);
      }
      const tree = git(['write-tree'], env).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new FanoutStateError('git write-tree failed');
      if (tip && git(['rev-parse', `${tip}^{tree}`]).stdout.trim() === tree) return { branch, head: tip }; // same bytes already published
      const c = git(['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', `acceptance(${o.ticket}): ${o.verb ?? 'freeze'} ${o.paths.length} file(s) [${o.run}]`]);
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

export function runAcceptance(args: string[], deps: FanoutDeps, io: FreezeIo = realFreezeIo): RunResult {
  try {
    return runAcceptanceInner(args, deps, io);
  } catch (e) {
    if (e instanceof Refusal || e instanceof AcceptanceOffError) return { code: 2, stdout: '', stderr: `refused: ${e.message}\n` };
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

function runAcceptanceInner(args: string[], deps: FanoutDeps, io: FreezeIo): RunResult {
  const [verb, ...rest] = args;
  if (!verb || verb === '--help' || verb === '-h') return { code: verb ? 0 : 1, stdout: verb ? `${ACCEPTANCE_USAGE}\n` : '', stderr: verb ? '' : `${ACCEPTANCE_USAGE}\n` };
  if (verb === 'freeze') {
    const p = parseArgs(rest, ['--run', '--files', '--run-cmd', '--from', '--accept-unclassified'], []);
    const ticket = oneTicket(p.pos, 'freeze');
    for (const f of ['--files', '--run-cmd']) if (!p.vals[f]) throw new FanoutStateError(`${f} is required\n${ACCEPTANCE_USAGE}`);
    const run = p.vals['--run-cmd'].trim();
    if (!run || run.length > 2000 || /[\r\n\0]/.test(run)) throw new FanoutStateError('--run-cmd must be a single-line command (≤ 2000 chars)');
    const paths = parseFileList(p.vals['--files']);
    const r = runOf(p, deps, 'write');
    const file = stateFile(homeOf(deps.env), r.run);
    const st0 = loadOrFail(file);
    assertAcceptanceOn(st0, 'run an acceptance verb'); // #554: refused up front (before any git / test work) when the run has the feature off
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
    const escape = p.vals['--accept-unclassified']?.trim();
    if (p.vals['--accept-unclassified'] !== undefined) {
      if (caller !== r.run) throw new Refusal(`--accept-unclassified is the run's coordinator's alone (${r.run}), not ${caller}: report the unclassifiable output to the coordinator`);
      if (!escape) throw new Refusal('--accept-unclassified needs a reason: the escape is recorded in the ticket');
    }
    const cfgPath = runConfigOf(run, paths); // #542: also validates the command BEFORE anything is published
    const frozen = readFrozen(paths, p.vals['--from'] ?? '.', deps.cwd, deps.runner);
    const config = cfgPath ? readRunnerConfig(deps.runner, frozen.repo, st0.target, cfgPath) : undefined;
    // #539: the frozen tests run ONCE on the current target tip BEFORE anything is published or recorded: an ERROR refuses, an assertion FAIL is the expected red.
    const chk = checkOnTargetTip({ repo: frozen.repo, head: frozen.source.head, paths, modes: frozen.modes, run, target: st0.target, runner: deps.runner, io, timeoutMs: freezeTimeoutMs(deps.env) });
    const at = `${chk.target}@${chk.targetSha.slice(0, 12)}`;
    if (chk.verdict.kind === 'error') throw new Refusal(`freeze check on ${at} (${chk.verdict.runner}): ${formatErrors(chk.verdict)}\n  nothing was published or recorded: fix the tests (an assertion that fails because the feature is not built is fine; an error is not) and freeze again`);
    if (chk.verdict.kind === 'unclassified' && !escape) throw new Refusal(`freeze check on ${at}: the output of the frozen command cannot be classified — ${chk.verdict.why}\n  nothing was published or recorded (fail closed). The run's coordinator may record an escape: --accept-unclassified "<why>"`);
    const verdict = chk.verdict;
    const freezeCheck: FreezeCheck = verdict.kind === 'clean'
      ? { at: deps.now(), target: chk.target, targetSha: chk.targetSha, result: 'clean', pass: verdict.pass, assertionFail: verdict.assertionFail, skipped: verdict.skipped }
      : { at: deps.now(), target: chk.target, targetSha: chk.targetSha, result: 'escaped', escape: { by: caller, reason: escape!, unclassified: verdict.kind === 'unclassified' ? verdict.why : '' } };
    // #515: a ticket registered with a spec has its tests PUBLISHED to the one shared branch acceptance/<run>; the recorded source is that published commit.
    const forced = !!had?.spec;
    const source = forced ? publishFrozen(deps.runner, frozen, { run: r.run, ticket, paths }) : frozen.source;
    const next = updateState(file, (cur) => {
      if (!cur) throw new FanoutStateError(`no state at ${file} — run \`orchestra fanout state init\` first`);
      return freezeInto(cur, ticket, { files: frozen.files, run, ...(config ? { config } : {}), source, now: deps.now(), freezeCheck });
    });
    const a = next.tickets[ticket].acceptance!;
    const hostCalls: HostCall[] | undefined = forced ? [{ route: '/fanoutAcceptance', body: { op: 'frozen', run: r.run, ticket, ...(caller ? { from: caller } : {}) } }] : undefined;
    return { code: 0, stdout: `${ticket}: froze ${paths.length} file(s) hash=${a.hash.slice(0, 12)} @ ${a.source.head.slice(0, 12)}${a.source.branch ? ` (${a.source.branch})` : ''}\n${freezeCheckLine(freezeCheck)}\n${a.config ? `runner config ${a.config.path} recorded (sha256 ${a.config.sha256.slice(0, 12)}): a candidate whose copy differs is refused at the gate\n` : ''}${had ? '' : `note: ticket ${ticket} was not in the state of run ${r.run} — created (todo); a typo? \`orchestra fanout state show\` lists the tickets\n`}`, stderr: r.note, ...(hostCalls ? { hostCalls } : {}) };
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
    assertAcceptanceOn(st0, 'run an acceptance verb'); // #554: refused up front (before any git / test work) when the run has the feature off
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
    const st = loadOrFail(stateFile(homeOf(deps.env), r.run));
    assertAcceptanceOn(st, `spawn a writer for ${ticket}`); // #554
    const t = st.tickets[ticket];
    if (!t) throw new FanoutStateError(`ticket ${ticket} is not in the fanout state of run ${r.run}`);
    const replace = p.bools.has('--replace');
    if (replace ? acceptancePhase(t) !== 'pending' : !needsAcceptor(t, deps.now())) throw new Refusal(`${ticket}: no writer is owed (${t.accept?.acceptor && !t.accept.acceptor.error ? `writer ${t.accept.acceptor.name} exists` : acceptancePhase(t) === 'pending' ? 'nothing to do' : `acceptance is ${acceptancePhase(t)}`})`);
    return { code: 0, stdout: `${ticket}: requesting its accept- writer from Orchestra\n`, stderr: r.note, hostCalls: [spawnCall(r.run, ticket, deps, replace)] };
  }
  if (verb === 'amend') {
    const p = parseArgs(rest, ['--run', '--decision', '--spec-sentence', '--files', '--from', '--run-cmd', '--reason'], ['--harness-only']);
    const ticket = oneTicket(p.pos, 'amend');
    if (p.bools.has('--harness-only')) return harnessAmend(ticket, p, deps);
    if (p.vals['--reason'] !== undefined) throw new FanoutStateError('--reason belongs to `amend --harness-only`; the decision amend records --decision + --spec-sentence');
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
    assertAcceptanceOn(st0, 'run an acceptance verb'); // #554: refused up front (before any git / test work) when the run has the feature off
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
    const oldCfg = cur.acceptance.config;
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
    return { code: 0, stdout: `${ticket}: amended ${h?.before.slice(0, 12)} → ${h?.after.slice(0, 12)} (decision ${decision})\n${config ? `runner config ${config.path}: ${oldCfg ? oldCfg.sha256.slice(0, 12) : '(none)'} → ${config.sha256.slice(0, 12)}${oldCfg?.sha256 === config.sha256 ? ' (unchanged)' : ' — RE-RECORDED from the target tip under this decision'}\n` : oldCfg ? `runner config ${oldCfg.path} dropped (the new command names none)\n` : ''}`, stderr: r.note };
  }
  if (verb === 'show') {
    const p = parseArgs(rest, ['--run'], ['--json', '--brief']);
    const ticket = oneTicket(p.pos, 'show');
    const r = runOf(p, deps, 'use');
    const s: FanoutState = loadOrFail(stateFile(homeOf(deps.env), r.run));
    const t = s.tickets[ticket];
    if (!t) throw new FanoutStateError(`ticket ${ticket} is not in the fanout state of run ${r.run}`);
    const a = t.acceptance;
    if (p.bools.has('--brief')) return { code: 0, stdout: `${(acceptanceOn(s) ? acceptanceLine(ticket, t) : null) ?? `${ticket}  no acceptance flow (${acceptanceOn(s) ? 'no spec registered, nothing frozen' : 'the acceptance switch is OFF for this run'})`}\n`, stderr: r.note };
    if (p.bools.has('--json')) return { code: 0, stdout: `${JSON.stringify(a, null, 2)}\n`, stderr: r.note };
    if (!a) return { code: 0, stdout: `${ticket}: no frozen acceptance tests\n`, stderr: r.note };
    const lines = [
      `${ticket}: frozen hash=${a.hash.slice(0, 12)} (${Object.keys(a.files).length} file(s)) at ${a.frozenAt}`,
      `  run:    ${a.run}`,
      ...(a.config ? [`  config: ${a.config.sha256.slice(0, 12)}  ${a.config.path}  (not a frozen test: the gate refuses a candidate whose copy differs)`] : []),
      `  source: ${a.source.branch ?? '-'}@${a.source.head.slice(0, 12)}`,
      ...Object.entries(a.files).map(([f, h]) => `  ${h.slice(0, 12)}  ${f}`),
      ...(a.freezeCheck ? [`  ${freezeCheckLine(a.freezeCheck)}${a.amendments.length ? ` — STALE: ${a.amendments.length} amendment(s) since; the amended files/command were NOT re-checked on a target tip` : ''}`] : []),
      `  amendments: ${a.amendments.length}`,
      ...a.amendments.map((m) => `    ${m.at} ${m.hashBefore.slice(0, 12)} → ${m.hashAfter.slice(0, 12)} ${m.kind === 'harness-only' ? `harness-only (assertions ${m.assertionsHash.slice(0, 12)}): ${m.reason}` : `${m.decision}${m.configAfter ? ` (config ${m.configAfter.sha256.slice(0, 12)})` : ''}`}`),
    ];
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: r.note };
  }
  throw new FanoutStateError(`unknown acceptance verb "${verb}"\n${ACCEPTANCE_USAGE}`);
}

/** One line for the freeze output / `show`: what the freeze's run on the target tip found. */
export function freezeCheckLine(c: FreezeCheck): string {
  const at = `${c.target}@${c.targetSha.slice(0, 12)}`;
  return c.result === 'escaped'
    ? `freeze check: NOT classified on ${at} — escape recorded by ${c.escape?.by}: ${c.escape?.reason} (${c.escape?.unclassified})`
    : `freeze check: on ${at}: ${c.pass ?? 0} pass, ${c.assertionFail ?? 0} assertion-fail (accepted: not built yet), ${c.skipped ?? 0} skipped — no ERROR`;
}

/** Make sure `head` (a commit of the shared acceptance branch / the recorded source) is present in `cwd`: fetch the recorded branch, then the sha. */
function ensureCommit(runner: Runner, cwd: string, head: string, branch: string | null): void {
  if (runner('git', ['cat-file', '-e', `${head}^{commit}`], cwd).code === 0) return;
  if (branch && runner('git', ['fetch', '--quiet', 'origin', `refs/heads/${branch}`], cwd).code === 0 && runner('git', ['cat-file', '-e', `${head}^{commit}`], cwd).code === 0) return;
  if (runner('git', ['fetch', '--quiet', 'origin', head], cwd).code === 0 && runner('git', ['cat-file', '-e', `${head}^{commit}`], cwd).code === 0) return;
  throw new FanoutStateError(`the recorded source ${head.slice(0, 12)}${branch ? ` (${branch})` : ''} is not in ${cwd} and could not be fetched: the frozen bytes cannot be re-read`);
}

/** #540 — `amend --harness-only`: assertion statements of the recorded bytes vs the new ones byte-identical ⇒ record + publish + notify; anything else is refused (the decision amend). */
function harnessAmend(ticket: string, p: ReturnType<typeof parseArgs>, deps: FanoutDeps): RunResult {
  for (const f of ['--decision', '--spec-sentence', '--run-cmd']) if (p.vals[f] !== undefined) throw new Refusal(`${f} cannot go with --harness-only: that mode changes neither what is asserted (no decision) nor the command — use the decision amend for either`);
  const reason = p.vals['--reason']?.trim();
  if (!reason) throw new Refusal('a harness-only amend needs --reason "<why the harness had to change>" (one short line) — none given');
  if (reason.length > 300 || /[\r\n\0]/.test(reason)) throw new Refusal('--reason must be one short line (≤ 300 chars): checked BEFORE anything is published');
  if (!p.vals['--files']) throw new FanoutStateError(`--files is required\n${ACCEPTANCE_USAGE}`);
  const paths = parseFileList(p.vals['--files']);
  const r = runOf(p, deps, 'write');
  // no ledger decision stands between this mode and the frozen bytes, so the CLI itself (not only the role-guard hook) holds it to the run's coordinator
  const caller = (deps.env.ORCHESTRA_WS_ID || deps.env.ORCHESTRA_WS_ID_IDENTITY || '').trim();
  if (caller !== r.run) throw new Refusal(`${ticket}: only the run's coordinator (${r.run}) may amend frozen tests${caller ? `, not ${caller}` : ' (no workspace identity: ORCHESTRA_WS_ID is empty)'}`);
  const file = stateFile(homeOf(deps.env), r.run);
  const st0 = loadOrFail(file);
    assertAcceptanceOn(st0, 'run an acceptance verb'); // #554: refused up front (before any git / test work) when the run has the feature off
  const cur = st0.tickets[ticket];
  if (!cur) throw new FanoutStateError(`ticket ${ticket} is not in the fanout state of run ${r.run}`);
  const acc = cur.acceptance;
  if (!acc) throw new FanoutStateError(`${ticket}: no frozen acceptance tests to amend — freeze first`);
  const from = p.vals['--from'] ?? acc.source.branch;
  if (!from) throw new FanoutStateError('--from is required: the recorded source has no branch');
  // the recorded bytes, re-read at the recorded source and PROVEN to be the frozen ones (a moved branch / a pruned commit must not stand in for them)
  ensureCommit(deps.runner, deps.cwd, acc.source.head, acc.source.branch);
  const old = readFrozen(Object.keys(acc.files), acc.source.head, deps.cwd, deps.runner);
  const drift = Object.keys(acc.files).filter((f) => old.files[f] !== acc.files[f]);
  if (drift.length) throw new FanoutStateError(`${ticket}: the recorded source ${acc.source.head.slice(0, 12)} no longer holds the frozen bytes of ${drift.join(', ')} — cannot compare the assertions`);
  const next = readFrozen(paths, from, deps.cwd, deps.runner);
  const cmp = compareFrozenSets(old.texts, next.texts);
  if (!cmp.ok) throw new Refusal(`not a harness-only change (${cmp.kind}): ${cmp.why} — a change to what is asserted needs the decision amend (--decision <ledger comment url> --spec-sentence "<text>")`);
  const diff = changedLines(old.texts, next.texts);
  const forced = !!cur.spec || acc.source.branch === acceptanceBranch(r.run);
  const source = forced ? publishFrozen(deps.runner, next, { run: r.run, ticket, paths, replace: acc.files, verb: 'harness-only amend' }) : next.source;
  let hashes: { before: string; after: string } | null = null;
  try {
  updateState(file, (c) => {
    if (!c) throw new FanoutStateError(`no state at ${file}`);
    try {
      if (c.tickets[ticket]?.acceptance?.hash !== acc.hash) throw new FanoutStateError(`${ticket}: the frozen set changed while this amend ran (another amend?) — re-read it and retry`);
      const n = amendHarnessInto(c, ticket, { files: next.files, reason, assertionsHash: cmp.assertionsHash, source, now: deps.now(), lines: { added: diff.added, removed: diff.removed, ...(diff.reorderOnly ? { reorderOnly: true as const } : {}) } });
      const am = n.tickets[ticket].acceptance!.amendments.at(-1)!;
      hashes = { before: am.hashBefore, after: am.hashAfter };
      return n;
    } catch (e) {
      if (e instanceof FanoutStateError && /changes nothing/.test(e.message)) throw new Refusal(e.message);
      throw e;
    }
  });
  } catch (e) {
    // the bytes are already on the shared branch: put the recorded ones back, or the next amend meets a path no record explains
    if (forced && source.head !== acc.source.head) { try { publishFrozen(deps.runner, old, { run: r.run, ticket, paths: Object.keys(acc.files), replace: next.files, verb: 'rollback of a failed harness-only amend' }); } catch { /* reported by the original error below */ } }
    throw e;
  }
  const h = hashes as { before: string; after: string } | null;
  const changed = paths.filter((f) => next.files[f] !== acc.files[f]);
  const hostCalls: HostCall[] = [{ route: '/fanoutAcceptance', body: { op: 'amended', run: r.run, ticket, ...(caller ? { from: caller } : {}) } }];
  return { code: 0, stdout: `${ticket}: harness-only amend ${h?.before.slice(0, 12)} → ${h?.after.slice(0, 12)}: ${cmp.statements} assertion statement(s) byte-identical (assertions ${cmp.assertionsHash.slice(0, 12)}); changed: ${changed.join(', ') || '-'} @ ${source.head.slice(0, 12)}${source.branch ? ` (${source.branch})` : ''}\nWHAT YOU ATTEST (not proven — values the assertions reference, helpers they call): ${diff.reorderOnly ? 'the non-assertion lines are the SAME SET — only their ORDER or INDENTATION changed (the bytes differ: read the two files)' : `${diff.added} line(s) added, ${diff.removed} removed outside the assertions`}\n${diff.sample.slice(0, 40).join('\n')}${diff.sample.length > 40 ? `\n… ${diff.sample.length - 40} more` : ''}\n`, stderr: r.note, hostCalls };
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
    if (t) {
      if (!acceptanceOn(state)) return { consulted: true, known: true, acceptance: null, phase: 'none', ticket: t, run: r }; // #554: acceptance off — the gate and deliver ask for no frozen test, wait for none
      return { consulted: true, known: true, acceptance: t.acceptance, phase: acceptancePhase(t), ticket: t, run: r };
    }
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
  /** #540 — write a regular file's bytes (the amended frozen bytes laid over a candidate holding a previous version for the run, then the candidate's own restored). Absent ⇒ that pickup fails closed. */
  writeFile?: (abs: string, bytes: Buffer) => void;
}

export const realCheckoutIo: CheckoutIo = {
  git: (args, cwd) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }); return { code: r.status ?? 1, stdout: r.stdout ?? '' }; },
  readFile: (abs) => { try { return fs.lstatSync(abs).isFile() ? fs.readFileSync(abs) : null; } catch { return null; } },
  writeFile: (abs, bytes) => fs.writeFileSync(abs, bytes),
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
  let overlay: { got: Map<string, Buffer>; why?: string } | null = null;
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
      const acceptable = acceptableBytes(acc);
      files = paths.map((p) => {
        const bytes = REGULAR_MODES.has(modes.get(p) ?? '') ? io.readFile(path.join(root!, p)) : null;
        if (bytes === null) return { path: p, status: 'missing' as const };
        // the bytes the command will run AND the blob at HEAD must both be the same recorded ones (a skip-worktree / assume-unchanged file can hide the former from `git status`)
        const blob = io.git(['show', `HEAD:${p}`], root!);
        const atHead = blob.code === 0 && !blob.stdout.includes('\uFFFD') && sha256Hex(Buffer.from(blob.stdout, 'utf8')) === acc.files[p];
        const st = sha256Hex(bytes) === acc.files[p] && atHead ? 'same' as const : 'changed' as const;
        if (st === 'same') return { path: p, status: st };
        // #540: a PREVIOUS recorded version of a harness-only-amended set (the worktree bytes AND the blob at HEAD) — the amended bytes are laid over it for the run
        const sha = sha256Hex(bytes);
        const headSha = blob.code === 0 && !blob.stdout.includes('\uFFFD') ? sha256Hex(Buffer.from(blob.stdout, 'utf8')) : null;
        return { path: p, status: sha === headSha && acceptable[p]?.has(sha) ? 'previous' as const : 'changed' as const };
      });
      const stale = files.filter((f) => f.status === 'previous');
      if (stale.length) {
        const got = new Map<string, Buffer>();
        let why: string | undefined;
        if (!io.writeFile) why = 'this gate cannot lay the amended bytes over the candidate (no write access)';
        else if (io.git(['cat-file', '-e', `${acc.source.head}^{commit}`], root).code !== 0 && !(acc.source.branch && io.git(['fetch', '--quiet', 'origin', `refs/heads/${acc.source.branch}`], root).code === 0 && io.git(['cat-file', '-e', `${acc.source.head}^{commit}`], root).code === 0) && io.git(['fetch', '--quiet', 'origin', acc.source.head], root).code !== 0) why = `the amended frozen bytes (${acc.source.branch ?? acc.source.head.slice(0, 12)}@${acc.source.head.slice(0, 12)}) are not in --cwd and could not be fetched`;
        else {
          for (const f of stale) {
            const b = io.git(['show', `${acc.source.head}:${f.path}`], root);
            if (b.code !== 0 || b.stdout.includes('\uFFFD') || sha256Hex(Buffer.from(b.stdout, 'utf8')) !== acc.files[f.path]) { why = `${f.path}: the shared source ${acc.source.head.slice(0, 12)} does not hold the recorded amended bytes`; break; }
            got.set(f.path, Buffer.from(b.stdout, 'utf8'));
          }
        }
        overlay = { got, why };
      }
      if (acc.config) config = configStatus(io, root, acc.config); // #542
    }
  }
  return decideGateAcceptance(acc, {
    cwdGiven: !!cwd, cwdHead, head: o.head, dirty, files, ...(config ? { config } : {}), cwdTree, ...(o.ticket ? { ticket: o.ticket } : {}),
    ...(overlay?.why ? { overlayError: overlay.why } : {}),
    run: () => {
      // #540: a candidate holding a previous version runs the AMENDED bytes (hash-proven above), then gets its own back — whatever the run does
      const kept = new Map<string, Buffer>();
      try {
        for (const [f, b] of overlay?.got ?? []) { kept.set(f, io.readFile(path.join(root!, f))!); io.writeFile!(path.join(root!, f), b); }
        const r = io.run(parseRunArgv(acc.run, Object.keys(acc.files)), root!);
        if (r.exit !== 0 && r.tail) o.log?.(`frozen tests (${acc.run}) exit ${r.exit}:\n${r.tail}`);
        return { cmd: acc.run, exit: r.exit };
      } finally {
        for (const [f, b] of kept) io.writeFile!(path.join(root!, f), b);
      }
    },
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
  const acceptable = acceptableBytes(acc);
  for (const [p, want] of Object.entries(acc.files)) {
    const r = await gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `${base}/${p.split('/').map(encodeURIComponent).join('/')}?ref=${head}`]);
    if (r.code !== 0) {
      if (/404|Not Found/i.test(r.stderr)) { out.push({ path: p, status: 'missing' }); continue; }
      throw new Error(`gh api contents/${p}@${head.slice(0, 12)} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    }
    const got = r.stdout.includes('�') ? null : sha256Hex(Buffer.from(r.stdout, 'utf8'));
    out.push({ path: p, status: got !== null && (got === want || acceptable[p]?.has(got)) ? 'same' : 'changed' }); // #540: a previous recorded harness-only version is not an edit (deliver proved the receipt for the CURRENT set)
  }
  if (acc.config) { // #542: the runner config at the PR head must still be the bytes recorded at freeze
    const p = acc.config.path;
    const r = await gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `${base}/${p.split('/').map(encodeURIComponent).join('/')}?ref=${head}`]);
    if (r.code !== 0 && !/404|Not Found/i.test(r.stderr)) throw new Error(`gh api contents/${p}@${head.slice(0, 12)} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    out.push({ path: p, config: true, status: r.code !== 0 ? 'missing' : !r.stdout.includes('�') && sha256Hex(Buffer.from(r.stdout, 'utf8')) === acc.config.sha256 ? 'same' : 'changed' });
  }
  return out;
}
