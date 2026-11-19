// resctl admit [--timeout <dur>]: return at once when free memory (MemAvailable) ≥ RESCTL_MIN_FREE_MEM and free disk ≥ RESCTL_MIN_FREE_DISK,
// else WAIT, printing what it waits for. Thresholds are re-read every poll from `$RESCTL_STATE_DIR/admit.conf` (KEY=VALUE lines, same names as
// the env, overriding it) — an env var is fixed at process start, the file is how a waiting `admit` is released by lowering a threshold.
import fs from 'node:fs';
import path from 'node:path';
import { parseMemAvailable, waitForAdmission, formatSize, formatElapsed, shortPhrase, type Reading, type Thresholds } from '../admission.ts';
import { parse } from '../args.ts';
import { admitPollMs, admitReportMs, diskPath, diskPathIsExplicit, minFreeDisk, minFreeMem, stateDir, type Env } from '../env.ts';
import { CliError, EXIT, refused, usageError } from '../errors.ts';
import { parseDuration, parseSize } from '../units.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The nearest existing ancestor (the default state dir may not exist yet); an explicit RESCTL_DISK_PATH must exist. */
function measuredPath(env: Env): string {
  let p = path.resolve(diskPath(env));
  if (diskPathIsExplicit(env)) {
    if (!fs.existsSync(p)) throw usageError(`RESCTL_DISK_PATH does not exist: ${p}`);
    return p;
  }
  while (!fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
  return p;
}

/** env thresholds, overridden by `admit.conf` in the state dir. An unreadable value in the file keeps the env value for that poll (warned once). */
export function readThresholds(env: Env, warn: (m: string) => void): Thresholds {
  const t: Thresholds = { minMem: minFreeMem(env), minDisk: minFreeDisk(env) };
  let text: string;
  try {
    text = fs.readFileSync(path.join(stateDir(env), 'admit.conf'), 'utf8');
  } catch {
    return t;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(RESCTL_MIN_FREE_MEM|RESCTL_MIN_FREE_DISK)\s*=\s*(\S+)\s*$/.exec(line);
    if (!m) {
      if (/RESCTL_MIN_FREE/.test(line) && !/^\s*#/.test(line)) warn(`admit.conf: unreadable line ${JSON.stringify(line.trim())} (ignored; use KEY=VALUE)`);
      continue;
    }
    try {
      if (m[1] === 'RESCTL_MIN_FREE_MEM') t.minMem = parseSize(m[2]);
      else t.minDisk = parseSize(m[2]);
    } catch (e) {
      warn(`admit.conf: ${(e as Error).message} (ignored)`);
    }
  }
  return t;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { timeout: { type: 'string' } });
  if (positionals.length) throw usageError(`unexpected argument: ${positionals[0]}`);
  const env = process.env;
  const timeoutMs = values.timeout === undefined ? undefined : durationOrUsage(values.timeout);
  let pollMs: number;
  let reportMs: number;
  const warned = new Set<string>();
  const warn = (m: string) => {
    if (!warned.has(m)) {
      warned.add(m);
      process.stderr.write(`resctl admit: ${m}\n`);
    }
  };
  let thresholds: () => Thresholds;
  let dpath: string;
  try {
    pollMs = admitPollMs(env);
    reportMs = admitReportMs(env);
    thresholds = () => readThresholds(env, warn);
    thresholds(); // a bad env value is a usage error now, not a stack trace later
    dpath = measuredPath(env);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw usageError((e as Error).message);
  }
  const read = (): Reading => {
    try {
      return { memFree: parseMemAvailable(fs.readFileSync('/proc/meminfo', 'utf8')), diskFree: freeDisk(dpath) };
    } catch (e) {
      throw new CliError(EXIT.failure, `cannot measure (refusing to admit blind): ${(e as Error).message}`);
    }
  };
  const res = await waitForAdmission({ read, thresholds, now: Date.now, sleep, pollMs, reportMs, timeoutMs, say: (l) => process.stderr.write(`resctl admit: ${l}\n`) });
  if (!res.admitted) throw refused(`timed out after ${formatElapsed(res.waitedMs)} waiting for ${shortPhrase(res.last.short)}`);
  const after = res.waitedMs >= 1000 ? ` after ${formatElapsed(res.waitedMs)}` : '';
  process.stdout.write(`admitted${after}: free memory ${formatSize(res.reading.memFree)} >= ${formatSize(res.thresholds.minMem)}, free disk ${formatSize(res.reading.diskFree)} >= ${formatSize(res.thresholds.minDisk)} (${dpath})\n`);
  return EXIT.ok;
}

function durationOrUsage(text: string): number {
  try {
    return parseDuration(text);
  } catch (e) {
    throw usageError((e as Error).message);
  }
}

/** Bytes available to an unprivileged writer (bavail, not bfree). */
function freeDisk(p: string): number {
  const s = fs.statfsSync(p);
  return Number(s.bavail) * Number(s.bsize);
}
