// resctl run end --id <id>: clean the run NOW (synchronously, in the CLI) and mark it cleaned.
import { parse } from '../args.ts';
import { endRun } from '../cleanup.ts';
import { stateDir } from '../env.ts';
import { CliError, EXIT, refused, usageError } from '../errors.ts';
import { readState } from '../state.ts';

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { id: { type: 'string' } });
  if (positionals.length) throw usageError(`unexpected argument: ${positionals[0]}`);
  if (!values.id) throw usageError('--id <id> is required');
  const dir = stateDir();
  const run = readState(dir).runs[values.id];
  if (!run) throw refused(`no such run: ${values.id}`);
  if (run.state === 'cleaned') {
    process.stderr.write(`resctl: run ${values.id} was already cleaned\n`);
    return EXIT.ok;
  }
  const failures = await endRun(dir, run);
  if (failures.length) throw new CliError(EXIT.failure, `run ${values.id}: cleanup failed: ${failures.map((f) => `${f.step}: ${f.error}`).join('; ')}`);
  return EXIT.ok;
}
