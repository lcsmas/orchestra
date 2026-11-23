// #539 — the freeze check's I/O half: fetch the target tip fresh, build a CLEAN scratch checkout of it (not the writer's tree) with the frozen blobs laid over it, run the
// frozen command ONCE there with the runner's structured reporter, classify. Pure classification: src/shared/fanout-freeze-classify.ts. Called by `acceptance freeze`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FanoutStateError, SAFE_BRANCH, parseRunArgv } from '../shared/fanout-state.ts';
import { adapterFor, classifyRun, type ExecResult, type FreezeVerdict } from '../shared/fanout-freeze-classify.ts';
import type { Runner } from './fanout-state.ts';

export interface FreezeIo {
  /** Extract the tree of `sha` (of the repo at `repo`) into the empty dir `dir`. Throws FanoutStateError. */
  materialise: (repo: string, sha: string, dir: string) => void;
  /** Execute `argv` directly (NO shell) in `cwd`, bounded by `timeoutMs`, the whole process group killed on expiry. */
  exec: (argv: string[], cwd: string, timeoutMs: number) => ExecResult;
}

/** The wall-clock bound of the freeze's one run (ms). Test seam: ORCHESTRA_FREEZE_CHECK_TIMEOUT_MS (1 s … 1 h). */
export function freezeTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.ORCHESTRA_FREEZE_CHECK_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 1000 && n <= 3_600_000 ? n : 10 * 60_000;
}

export const realFreezeIo: FreezeIo = {
  materialise: (repo, sha, dir) => {
    const tar = `${dir}.tar`;
    try {
      const a = spawnSync('git', ['archive', '--format=tar', '-o', tar, sha], { cwd: repo, encoding: 'utf8', timeout: 300_000 });
      if (a.status !== 0) throw new FanoutStateError(`freeze check: git archive ${sha.slice(0, 12)} failed: ${(a.stderr ?? '').trim().slice(0, 200)}`);
      const x = spawnSync('tar', ['-xf', tar, '-C', dir], { encoding: 'utf8', timeout: 300_000 });
      if (x.status !== 0) throw new FanoutStateError(`freeze check: could not extract the target tip: ${(x.stderr ?? '').trim().slice(0, 200)}`);
    } finally { fs.rmSync(tar, { force: true }); }
  },
  exec: (argv, cwd, timeoutMs) => {
    // NODE_TEST_CONTEXT (set when the freeze itself runs under `node --test`) turns a nested `node --test` into a silent exit-0 child: scrub it (same as the gate).
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    // argv[0] is resolved on the PATH we INHERIT — exactly what the gate's `spawnSync(argv[0])` does: a runner only the scratch's node_modules/.bin has would freeze here and 127 at every gate
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const opts = { cwd, env, encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    const t0 = Date.now();
    // GNU `timeout` signals the WHOLE process group (the runner's per-file children too); without it (no coreutils) the direct child alone is killed.
    const viaTimeout = spawnSync('timeout', ['--kill-after=10', String(secs), ...argv], { ...opts, timeout: (secs + 30) * 1000, killSignal: 'SIGKILL' });
    const noTimeout = (viaTimeout.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    const r = noTimeout ? spawnSync(argv[0], argv.slice(1), { ...opts, timeout: timeoutMs, killSignal: 'SIGKILL' }) : viaTimeout;
    const err = r.error as NodeJS.ErrnoException | undefined;
    const expired = noTimeout ? err?.code === 'ETIMEDOUT' : (r.status === 124 || r.status === 137 || err?.code === 'ETIMEDOUT') && Date.now() - t0 >= secs * 1000 - 1500;
    if (err && !expired) return { exit: null, signal: null, timedOut: false, stdout: r.stdout ?? '', spawnError: err.code ?? err.message };
    return { exit: r.status, signal: r.signal ?? null, timedOut: expired, stdout: r.stdout ?? '' };
  },
};

export interface TargetCheck { target: string; targetSha: string; verdict: FreezeVerdict }

/** Run the frozen command once on the CURRENT tip of `target`: fetched fresh from origin (a repo without an origin falls back to its local branch), extracted into a clean
 *  scratch dir, the frozen blobs (`head`:path) laid over it, `node_modules` of the writer's repo linked in (the target tip carries no install). Throws FanoutStateError when it cannot be set up. */
export function checkOnTargetTip(
  o: { repo: string; head: string; paths: string[]; modes: Map<string, string>; run: string; target: string; runner: Runner; io: FreezeIo; timeoutMs: number },
): TargetCheck {
  if (!SAFE_BRANCH.test(o.target)) throw new FanoutStateError(`freeze check: the state's target ${JSON.stringify(o.target)} is not a plain branch name`);
  const git = (args: string[]) => o.runner('git', args, o.repo);
  let sha: string;
  if (git(['remote', 'get-url', 'origin']).code === 0) {
    const f = git(['fetch', '--quiet', 'origin', `refs/heads/${o.target}`]);
    if (f.code !== 0) throw new FanoutStateError(`freeze check: could not fetch the target tip (git fetch origin ${o.target}, exit ${f.code}): ${f.stderr.trim().slice(0, 200)} — nothing was frozen`);
    sha = git(['rev-parse', '--verify', '-q', 'FETCH_HEAD^{commit}']).stdout.trim();
  } else {
    sha = git(['rev-parse', '--verify', '-q', `refs/heads/${o.target}^{commit}`]).stdout.trim();
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new FanoutStateError(`freeze check: cannot resolve the tip of target ${o.target} in ${o.repo} — nothing was frozen`);
  const frozenArgv = parseRunArgv(o.run, o.paths);
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'orchestra-freeze-check-'));
  const outFile = `${dir}.results.json`; // a file-writing reporter's output (jest), beside the scratch dir so the checkout stays clean
  try {
    o.io.materialise(o.repo, sha, dir);
    for (const p of o.paths) {
      const blob = git(['show', `${o.head}:${p}`]);
      if (blob.code !== 0) throw new FanoutStateError(`freeze check: git show ${o.head.slice(0, 12)}:${p} failed`);
      const dest = path.join(dir, p);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.rmSync(dest, { force: true });
      fs.writeFileSync(dest, blob.stdout, { mode: o.modes.get(p) === '100755' ? 0o755 : 0o644 });
    }
    const top = git(['rev-parse', '--show-toplevel']).stdout.trim();
    const nm = top ? path.join(top, 'node_modules') : '';
    if (nm && fs.existsSync(nm) && !fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'dir');
    const adapter = adapterFor(frozenArgv);
    const res: ExecResult = adapter ? o.io.exec(adapter.argv(frozenArgv, outFile), dir, o.timeoutMs) : { exit: null, signal: null, timedOut: false, stdout: '' };
    if (adapter?.usesFile) res.outText = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
    return { target: o.target, targetSha: sha, verdict: classifyRun(frozenArgv, res) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
  }
}
