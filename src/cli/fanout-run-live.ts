// #614 (spec #601, ledger #613) — `orchestra fanout run` WITHOUT `--scenario`: the loop on the LIVE ports (src/shared/fanout-loop-live-*.ts). Everything that touches the world goes through a shipped verb or the host:
// fleet = the built CLI (`fanout start|review`, `check`, `ack`, `send`) + the host's `live` / `transcripts` ops; forge = `gh`, the MERGE through the shipped `deliver` (every refusal of that verb is the loop's); git = `git`.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createLiveFleet, type Cli, type Host } from '../shared/fanout-loop-live-fleet.ts';
import { createLiveForge, type MergeAnswer } from '../shared/fanout-loop-live-forge.ts';
import { createLiveGit, type Exec, type ExecResult } from '../shared/fanout-loop-live-git.ts';
import { DEFAULT_OPTIONS, runLoop, type LoopOptions, type LoopResult } from '../shared/fanout-loop.ts';
import { tokensOfFiles, transcriptFilesIn, workspacesOfTicket } from '../shared/fanout-report.ts';
import { readState, stateFile } from '../shared/fanout-state.ts';
import { deliver, realDeps } from './fanout-deliver.ts';

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

/** The merge, through the shipped `deliver`: its verdict (recorded approval, CI, upstream order, acceptance, follow-up) is the loop's — nothing here merges around it. */
export function mergeThroughDeliver(i: { home: string; run: string; log: (l: string) => void }): (x: { n: number; head: string }) => Promise<MergeAnswer> {
  return async ({ n, head }) => {
    const s = readState(stateFile(i.home, i.run));
    const entry = Object.entries(s?.tickets ?? {}).find(([, t]) => t.pr === n);
    if (!s || !entry || !entry[1].branch) return { ok: false, reason: 'no-ticket', detail: `no ticket of run ${i.run} has pull request #${n}` };
    const [ticket, t] = entry;
    const out = await deliver({ branch: t.branch!, into: s.target, ticket, strategy: 'merge', timeoutMs: 15 * 60_000, intervalMs: 20_000, noChecksGraceMs: 120_000, requireChecks: [], run: i.run, ...(s.repo ? { repo: s.repo } : {}), verifiedHead: head }, { ...realDeps(), log: i.log });
    const r = out.result;
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
  const target = existing?.target ?? i.options.target ?? (await (async () => { const r = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: i.cwd }); return r.code === 0 ? r.stdout.trim().replace(/^origin\//, '') : 'main'; })());
  const readNow = () => readState(stateFile(i.home, i.run));
  const forge = createLiveForge({ gh: (args) => exec('gh', args, { cwd: i.cwd }), ...(existing?.repo ? { repo: existing.repo } : {}), deliver: mergeThroughDeliver({ home: i.home, run: i.run, log: i.log }) });
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
  await fleet.close(); // only after a COMPLETE pass: a loop that crashed mid-pass leaves its lot unacked, and the next start reads it again
  return result;
}
