// resctl docker-env --run <id>: print `export DOCKER_HOST=unix://<socket>` for the run's Docker relay (started on first call, reused after). Use: eval "$(resctl docker-env --run <id>)"
import { parse } from '../args.ts';
import { stateDir } from '../env.ts';
import { usageError } from '../errors.ts';
import { ensureRelay } from '../relay-host.ts';

const quote = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { run: { type: 'string' } });
  if (positionals.length) throw usageError(`unexpected argument: ${positionals[0]}`);
  if (!values.run) throw usageError('--run <id> is required');
  const r = await ensureRelay(stateDir(), values.run);
  process.stdout.write(`export DOCKER_HOST=${quote(`unix://${r.sock}`)}\n`);
  return 0;
}
