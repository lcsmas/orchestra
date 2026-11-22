// #510 — `orchestra fanout acceptance freeze|amend|show` (coordinator writes; the role guard denies freeze|amend elsewhere) + the I/O the gate and
// deliver clauses share: hashing the frozen files in a checkout (gate), re-reading them at a head through gh (deliver), the state reader.
// Pure decisions: src/shared/fanout-acceptance.ts. Schema + the one writer: src/shared/fanout-state.ts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FanoutStateError, SAFE_BRANCH, readState, resolveFanoutRun, sha256Hex, stateFile, updateState,
  type Acceptance, type FanoutState,
} from '../shared/fanout-state.ts';
import {
  amendInto, decideGateAcceptance, decisionApiPath, decisionNamesSentence, freezeInto, normaliseSentence, parseFileList,
  type FileStatus, type GateAcceptance,
} from '../shared/fanout-acceptance.ts';
import { homeOf, loadOrFail, parseArgs, runOf, type FanoutDeps, type RunResult, type Runner } from './fanout-state.ts';

export const ACCEPTANCE_USAGE = `usage: orchestra fanout acceptance freeze <ticket> [--run <id>] --files <p1,p2,…> --run-cmd "<cmd>" --from <ref|dir>
       orchestra fanout acceptance amend  <ticket> [--run <id>] --decision <ledger comment url> --spec-sentence "<text>" --files <p1,p2,…> [--from <ref|dir>]
       orchestra fanout acceptance show   <ticket> [--run <id>] [--json]

Frozen acceptance tests (#510): the test writer's files are hashed (sha256 of the bytes) at --from (a git ref of the writer's branch, or a checkout dir),
and recorded in the ticket's fanout state with the targeted command (--run-cmd, run with cwd = the candidate checkout).
  freeze  coordinator only; refused when already frozen (amend), on an empty/unsafe file list, a non-regular or uncommitted file.
  amend   coordinator only; --decision = a GitHub ledger comment URL whose body (read through gh, fail closed) quotes --spec-sentence (≥ 12 chars,
          whitespace-normalised); appends {decision, specSentence, hashBefore, hashAfter}; refused (exit 2) without them. --from defaults to the recorded source branch.
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

interface Frozen { files: Record<string, string>; source: Acceptance['source'] }

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
  return { files, source: { branch, head } };
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
    for (const f of ['--files', '--run-cmd', '--from']) if (!p.vals[f]) throw new FanoutStateError(`${f} is required\n${ACCEPTANCE_USAGE}`);
    const run = p.vals['--run-cmd'].trim();
    if (!run || run.length > 2000 || /[\r\n\0]/.test(run)) throw new FanoutStateError('--run-cmd must be a single-line command (≤ 2000 chars)');
    const paths = parseFileList(p.vals['--files']);
    const r = runOf(p, deps, 'write');
    const file = stateFile(homeOf(deps.env), r.run);
    const had = loadOrFail(file).tickets[ticket];
    if (had?.acceptance) throw new Refusal(`${ticket}: acceptance tests are already frozen (hash ${had.acceptance.hash.slice(0, 12)}) — change them with \`orchestra fanout acceptance amend\` (coordinator, ledger decision)`);
    const frozen = readFrozen(paths, p.vals['--from'], deps.cwd, deps.runner);
    const next = updateState(file, (cur) => {
      if (!cur) throw new FanoutStateError(`no state at ${file} — run \`orchestra fanout state init\` first`);
      return freezeInto(cur, ticket, { files: frozen.files, run, source: frozen.source, now: deps.now() });
    });
    const a = next.tickets[ticket].acceptance!;
    return { code: 0, stdout: `${ticket}: froze ${paths.length} file(s) hash=${a.hash.slice(0, 12)} @ ${a.source.head.slice(0, 12)}${a.source.branch ? ` (${a.source.branch})` : ''}\n${had ? '' : `note: ticket ${ticket} was not in the state of run ${r.run} — created (todo); a typo? \`orchestra fanout state show\`\n`}`, stderr: r.note };
  }
  if (verb === 'amend') {
    const p = parseArgs(rest, ['--run', '--decision', '--spec-sentence', '--files', '--from'], []);
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
    let hashes: { before: string; after: string } | null = null;
    updateState(file, (c) => {
      if (!c) throw new FanoutStateError(`no state at ${file}`);
      try {
        const n = amendInto(c, ticket, { files: frozen.files, decision, specSentence: normaliseSentence(sentence), source: frozen.source, now: deps.now() });
        const am = n.tickets[ticket].acceptance!.amendments.at(-1)!;
        hashes = { before: am.hashBefore, after: am.hashAfter };
        return n;
      } catch (e) {
        if (e instanceof FanoutStateError && /changes nothing/.test(e.message)) throw new Refusal(e.message);
        throw e;
      }
    });
    const h = hashes as { before: string; after: string } | null;
    return { code: 0, stdout: `${ticket}: amended ${h?.before.slice(0, 12)} → ${h?.after.slice(0, 12)} (decision ${decision})\n`, stderr: r.note };
  }
  if (verb === 'show') {
    const p = parseArgs(rest, ['--run'], ['--json']);
    const ticket = oneTicket(p.pos, 'show');
    const r = runOf(p, deps, 'use');
    const s: FanoutState = loadOrFail(stateFile(homeOf(deps.env), r.run));
    const t = s.tickets[ticket];
    if (!t) throw new FanoutStateError(`ticket ${ticket} is not in the fanout state of run ${r.run}`);
    const a = t.acceptance;
    if (p.bools.has('--json')) return { code: 0, stdout: `${JSON.stringify(a, null, 2)}\n`, stderr: r.note };
    if (!a) return { code: 0, stdout: `${ticket}: no frozen acceptance tests\n`, stderr: r.note };
    const lines = [
      `${ticket}: frozen hash=${a.hash.slice(0, 12)} (${Object.keys(a.files).length} file(s)) at ${a.frozenAt}`,
      `  run:    ${a.run}`,
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

/** `lenient` (the gate, like its `stack`): an absent state / ticket = no clause (deliver, the merge authority, is strict). `consulted:false` = no state at all (no --run, none at the caller's own run). Throws (FanoutStateError) like `upstreamsFromState`: explicit --run with
 *  no state, a ticket the existing state does not name, or an unreadable state — fail closed. */
export function acceptanceFromState(opts: { ticket: string; run?: string; lenient?: boolean }, env: NodeJS.ProcessEnv = process.env): { consulted: boolean; acceptance: Acceptance | null } {
  const { run } = resolveFanoutRun(opts.run, env);
  if (!run) return { consulted: false, acceptance: null };
  const home = env.ORCHESTRA_HOME && env.ORCHESTRA_HOME.trim() ? env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
  const state = readState(stateFile(home, run));
  if (!state) {
    if (opts.run && !opts.lenient) throw new FanoutStateError(`no fanout state for --run ${opts.run}: a wrong run id would skip the acceptance clause`);
    return { consulted: false, acceptance: null };
  }
  const t = state.tickets[opts.ticket];
  if (!t && opts.lenient) return { consulted: true, acceptance: null };
  if (!t) throw new FanoutStateError(`ticket ${opts.ticket} is not in the fanout state of run ${run}: a mistyped --ticket would skip the acceptance clause`);
  return { consulted: true, acceptance: t.acceptance };
}

// ── gate: hash + run in the candidate checkout ────────────────────────────────────────────────────────────

export interface CheckoutIo {
  git: (args: string[], cwd: string) => { code: number; stdout: string };
  /** The bytes of a regular file, null when absent / not a regular file. */
  readFile: (abs: string) => Buffer | null;
  run: (cmd: string, cwd: string) => { exit: number; tail: string };
}

export const realCheckoutIo: CheckoutIo = {
  git: (args, cwd) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }); return { code: r.status ?? 1, stdout: r.stdout ?? '' }; },
  readFile: (abs) => { try { return fs.lstatSync(abs).isFile() ? fs.readFileSync(abs) : null; } catch { return null; } },
  run: (cmd, cwd) => {
    // NODE_TEST_CONTEXT (set when the gate itself runs under `node --test`) turns a nested `node --test` into a silent exit-0 child: scrub it.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-40).join('\n');
    return { exit: r.status ?? (r.error ? 127 : 1), tail: out };
  },
};

/** The acceptance clause of `fanout gate`: `--cwd` required, its HEAD = `--head`, tracked files clean, every frozen file byte-identical (and a regular
 *  file at HEAD), then the frozen command runs there. The command only runs once the bytes are proven. */
export function checkAcceptanceInCheckout(acc: Acceptance, o: { cwd?: string; head: string; log?: (s: string) => void }, io: CheckoutIo = realCheckoutIo): GateAcceptance {
  const cwd = o.cwd ? path.resolve(o.cwd) : null;
  let root: string | null = null;
  let cwdHead: string | null = null;
  let dirty: string[] = [];
  let files: FileStatus[] = [];
  if (cwd) {
    const top = io.git(['rev-parse', '--show-toplevel'], cwd);
    const hd = io.git(['rev-parse', 'HEAD'], cwd);
    try { root = top.code === 0 && fs.realpathSync(top.stdout.trim()) === fs.realpathSync(cwd) ? cwd : null; } catch { root = null; }
    cwdHead = root && hd.code === 0 && /^[0-9a-f]{40}$/.test(hd.stdout.trim()) ? hd.stdout.trim() : null;
    if (root && cwdHead) {
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
    }
  }
  return decideGateAcceptance(acc, {
    cwdGiven: !!cwd, cwdHead, head: o.head, dirty, files,
    run: () => { const r = io.run(acc.run, root!); if (r.exit !== 0 && r.tail) o.log?.(`frozen tests (${acc.run}) exit ${r.exit}:\n${r.tail}`); return { cmd: acc.run, exit: r.exit }; },
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
  return out;
}
