// #614 (spec #601, ledger #613) — `orchestra fanout run` WITHOUT `--scenario`: the loop on the LIVE ports (src/shared/fanout-loop-live-*.ts). Everything that touches the world goes through a shipped verb or the host:
// fleet = the built CLI (`fanout start|review`, `check`, `ack`, `send`) + the host's `live` / `transcripts` ops; forge = `gh`, the MERGE through the shipped `deliver` (every refusal of that verb is the loop's); git = `git`.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createLiveFleet, type Cli, type Host } from '../shared/fanout-loop-live-fleet.ts';
import { createLiveForge, type MergeAnswer } from '../shared/fanout-loop-live-forge.ts';
import { createLiveGit, type Exec, type ExecResult } from '../shared/fanout-loop-live-git.ts';
import { DEFAULT_OPTIONS, runLoop, type LoopOptions, type LoopResult } from '../shared/fanout-loop.ts';
import { tokensOfFiles, transcriptFilesIn, workspacesOfTicket } from '../shared/fanout-report.ts';
import { SeatRefusal, readState, stateFile } from '../shared/fanout-state.ts';
import { deliver, realDeps, recordedStateFor, upstreamsFromState, verifierSwitchFromState, type DeliverDeps } from './fanout-deliver.ts';
import { acceptanceFromState } from './fanout-acceptance.ts';
import { followUpFromState } from './fanout-followup.ts';

/** `execFile` behind the {@link Exec} seam: argv, never a shell; a missing binary is a result, not a throw. */
export const realExec: Exec = (cmd, args, opts) => new Promise<ExecResult>((resolve) => {
  execFile(cmd, args, { cwd: opts?.cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60_000, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: err && (err as { code?: unknown }).code === 'ENOENT' ? `${cmd}: command not found` : String(stderr) });
  });
});

export interface LiveRunInput {
  home: string;
  run: string;
  /** The host-vouched caller: must be the run's own coordinator (`fanout start` accepts no one else). */
  caller: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  options: Partial<LoopOptions>;
  host: Host;
  log: (line: string) => void;
  /** The bundle to re-execute for the shipped verbs (default: this process's own script). */
  cliJs?: string;
  exec?: Exec;
}

/** `deliver`'s readers of the run state, bound to the LOOP's home (never to whatever ORCHESTRA_HOME the process happens to carry): the same state the loop is leading. */
export function deliverDepsFor(home: string): DeliverDeps {
  const env: NodeJS.ProcessEnv = { ...process.env, ORCHESTRA_HOME: home };
  return { ...realDeps(), upstreams: (o) => upstreamsFromState(o, env), acceptance: (o) => acceptanceFromState(o, env), followUp: (o) => followUpFromState(o, env), verifierSwitch: (o) => verifierSwitchFromState(o, env), recorded: (o) => recordedStateFor(o, env) };
}

/** The merge, through the shipped `deliver`: its verdict (recorded approval, CI, upstream order, acceptance, follow-up) is the loop's — nothing here merges around it. */
export function mergeThroughDeliver(i: { home: string; run: string; log: (l: string) => void; deps?: Partial<DeliverDeps> }): (x: { n: number; head: string }) => Promise<MergeAnswer> {
  return async ({ n, head }) => {
    const s = readState(stateFile(i.home, i.run));
    const entry = Object.entries(s?.tickets ?? {}).find(([, t]) => t.pr === n);
    if (!s || !entry || !entry[1].branch) return { ok: false, reason: 'no-ticket', detail: `no ticket of run ${i.run} has pull request #${n}` };
    const [ticket, t] = entry;
    const d = { ...deliverDepsFor(i.home), ...i.deps, log: i.log };
    // deliver finds its pull request by BRANCH: refuse before it can merge a different one than the loop tracks (a closed #n and a second open PR on the branch)
    const seen = await d.gh(['pr', 'view', String(n), '--json', 'state', ...(s.repo ? ['--repo', s.repo] : [])]);
    let state = '';
    try { state = String((JSON.parse(seen.stdout) as { state?: unknown }).state ?? ''); } catch { /* unreadable */ }
    if (seen.code !== 0 || state !== 'OPEN') return { ok: false, reason: 'pr-not-open', detail: `pull request #${n} is ${state || 'unreadable'} (${seen.stderr.trim().slice(0, 160)}): deliver would pick another pull request of ${t.branch}` };
    const out = await deliver({ branch: t.branch!, into: s.target, ticket, strategy: 'merge', timeoutMs: 15 * 60_000, intervalMs: 20_000, noChecksGraceMs: 120_000, requireChecks: [], run: i.run, ...(s.repo ? { repo: s.repo } : {}), verifiedHead: head }, d);
    const r = out.result;
    if (r.pr !== undefined && r.pr !== n) return { ok: false, reason: 'pr-mismatch', detail: `deliver acted on pull request #${r.pr} for branch ${t.branch}, the loop tracks #${n}` }; // deliver finds its PR by branch: never report another PR's merge as this one's
    if (out.exit === 0 && (r.verdict === 'merged' || r.verdict === 'already-merged')) return { ok: true };
    return { ok: false, reason: String(r.reason ?? r.verdict), ...(r.detail ? { detail: r.detail } : {}) };
  };
}

export async function runLive(i: LiveRunInput): Promise<LoopResult> {
  const exec = i.exec ?? realExec;
  const cliJs = i.cliJs ?? process.argv[1];
  const cli: Cli = (args) => exec(process.execPath, [cliJs, ...args], { cwd: i.cwd });
  const git = createLiveGit({ git: (args) => exec('git', args, { cwd: i.cwd }) });
  const existing = readState(stateFile(i.home, i.run));
  const target = existing?.target ?? i.options.target ?? (await (async () => {
    const r = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: i.cwd });
    if (r.code !== 0 || !r.stdout.trim()) throw new SeatRefusal('run-target', 'cannot tell the default branch of this repository (no refs/remotes/origin/HEAD): `git remote set-head origin -a` first — the loop never guesses the branch it merges into');
    return r.stdout.trim().replace(/^origin\//, '');
  })());
  const readNow = () => readState(stateFile(i.home, i.run));
  const forge = createLiveForge({ gh: (args) => exec('gh', args, { cwd: i.cwd }), branchHead: (b) => git.head(b), ...(existing?.repo ? { repo: existing.repo } : {}), deliver: mergeThroughDeliver({ home: i.home, run: i.run, log: i.log }) });
  const key = i.env.ORCHESTRA_SESSION_KEY?.trim() || undefined;
  const fleet = await createLiveFleet({
    run: i.run, caller: i.caller, cli, host: i.host, readState: readNow, key,
    costOf: async (ticket) => { // #608: tokens of every workspace that worked on the ticket, from the transcript directories the host names
      const t = readNow()?.tickets[ticket];
      const ids = t ? workspacesOfTicket(t) : [];
      if (!ids.length) return null;
      const r = await i.host({ op: 'transcripts', run: i.run, from: i.caller, key, ids });
      const dirs = (r.ok && r.dirs && typeof r.dirs === 'object' ? r.dirs : {}) as Record<string, string | null>;
      const c = tokensOfFiles(Object.values(dirs).flatMap((d) => (d && fs.existsSync(d) ? transcriptFilesIn(d) : [])));
      return c ? { tokens: c.tokens } : null;
    },
  });
  const result = await runLoop({
    home: i.home, run: i.run, caller: i.caller, fleet, forge, git,
    now: () => new Date().toISOString(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: i.log,
    options: { ...DEFAULT_OPTIONS, ...i.options, target },
  });
  // only after a COMPLETE pass: a loop that crashed — or ended on a refusal (exit 2) — mid-pass leaves its lot unacked, and the next start reads it again
  if (result.exit !== 2) await fleet.close().catch((e: unknown) => i.log(`could not ack the last lot (it will be read again): ${e instanceof Error ? e.message : String(e)}`));
  return result;
}
