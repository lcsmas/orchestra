// resctl run start --id <id> --owner <pid|auto> [--max-life <duration>]: declare a run, or re-adopt one still in its grace.
import { randomBytes } from 'node:crypto';
import { parse } from '../args.ts';
import { endRun } from '../cleanup.ts';
import { ensureDaemon } from '../daemon.ts';
import { noAutostart, stateDir } from '../env.ts';
import { refused, usageError } from '../errors.ts';
import { parseDuration } from '../units.ts';
import { resolveOwner } from '../owner.ts';
import { isAlive, type Identity } from '../proc.ts';
import { withState, type Run } from '../state.ts';

type Plan = { kind: 'created' | 'adopted' | 'unchanged' } | { kind: 'expired'; old: Run };

const same = (a: Identity, b: Identity): boolean => a.pid === b.pid && a.startTime === b.startTime;

/** `--max-life <duration>` → ms; a positive duration, counted from this call (a repeated start with the flag moves the deadline; without it the old one stays). */
function maxLife(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  let ms: number;
  try {
    ms = parseDuration(text);
  } catch (e) {
    throw usageError(`--max-life: ${(e as Error).message}`);
  }
  if (!(ms > 0)) throw usageError(`--max-life ${JSON.stringify(text)}: must be a positive duration`);
  return ms;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { id: { type: 'string' }, owner: { type: 'string' }, 'max-life': { type: 'string' } });
  if (positionals.length) throw usageError(`unexpected argument: ${positionals[0]}`);
  const id = values.id ?? `run-${randomBytes(4).toString('hex')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw usageError(`--id ${JSON.stringify(id)}: use letters, digits, . _ - (max 128)`);
  const lifeMs = maxLife(values['max-life']);
  const owner = await resolveOwner(values.owner);
  const dir = stateDir();

  for (let attempt = 0; attempt < 3; attempt++) {
    const plan = await withState((s): Plan => {
      const cur = s.runs[id];
      const now = Date.now();
      if (cur && cur.state === 'alive') {
        if (same(cur.owner, owner)) {
          if (lifeMs !== undefined) cur.maxLifeAt = now + lifeMs;
          return { kind: 'unchanged' };
        }
        if (isAlive(cur.owner)) throw refused(`run ${id} is alive with another owner (pid ${cur.owner.pid})`);
      } else if (cur && cur.state === 'grace') {
        if (cur.graceEndsAt === undefined || now >= cur.graceEndsAt) return { kind: 'expired', old: JSON.parse(JSON.stringify(cur)) };
      }
      if (cur && cur.state !== 'cleaned') {
        // re-adopt: same instance (token, lanes kept), new owner, grace cleared (also covers an owner that died before the reaper noticed)
        cur.owner = owner;
        cur.state = 'alive';
        delete cur.graceEndsAt;
        if (lifeMs !== undefined) cur.maxLifeAt = now + lifeMs;
        return { kind: 'adopted' };
      }
      s.runs[id] = { id, token: randomBytes(16).toString('hex'), owner, state: 'alive', startedAt: now, lanes: [], ...(lifeMs !== undefined ? { maxLifeAt: now + lifeMs } : {}) };
      return { kind: 'created' };
    }, dir);
    if (plan.kind === 'expired') {
      // Past the grace the run is being cleaned for good: finish it here, then start the id fresh.
      const failures = await endRun(dir, plan.old);
      if (failures.length) throw refused(`run ${id}: its previous instance could not be cleaned: ${failures.map((f) => f.error).join('; ')}`);
      continue;
    }
    if (plan.kind === 'adopted') process.stderr.write(`resctl: run ${id} re-adopted (owner ${owner.pid})\n`);
    process.stdout.write(`${id}\n`);
    if (!noAutostart()) ensureDaemon(dir);
    return 0;
  }
  throw refused(`run ${id}: could not start (raced with its cleanup)`);
}
