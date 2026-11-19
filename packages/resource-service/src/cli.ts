// The dispatch table. EVERY verb is registered here (A1 owns this file; later tickets fill their verb file and leave the table alone).
import { CliError, EXIT } from './errors.ts';
import * as admit from './verbs/admit.ts';
import * as dockerEnv from './verbs/docker-env.ts';
import * as exec from './verbs/exec.ts';
import * as installUnit from './verbs/install-unit.ts';
import * as runEnd from './verbs/run-end.ts';
import * as runStart from './verbs/run-start.ts';
import * as serve from './verbs/serve.ts';
import * as status from './verbs/status.ts';
import * as uninstallUnit from './verbs/uninstall-unit.ts';

type Verb = { main: (argv: string[]) => Promise<number> };

/** Verb path → implementation. `run` takes a subverb. */
export const VERBS: Record<string, Verb> = {
  'admit': admit,
  'run start': runStart,
  'run end': runEnd,
  'exec': exec,
  'docker-env': dockerEnv,
  'status': status,
  'serve': serve,
  'install-unit': installUnit,
  'uninstall-unit': uninstallUnit,
};

const USAGE = `usage: resctl <verb> [options]
  run start --id <id> --owner <pid|auto> [--max-life <dur>]
                                      declare a run (or re-adopt it inside its grace); auto = the nearest
                                      "claude" ancestor; max-life cleans it even while its owner lives
  run end --id <id>                   clean the run now
  exec --run <id> -- <cmd> [args...]  start a lane of the run
  serve                               the reaper daemon (foreground; a container's main command)
  status [--json]                     runs with owner, state, processes, containers, memory
  install-unit [--no-start|--print]   write + enable + start the systemd user unit ($RESCTL_UNIT_NAME)
  uninstall-unit                      stop, disable, remove it
  admit [--timeout <dur>]             wait until free memory and disk are above RESCTL_MIN_FREE_MEM / _DISK
  docker-env                          not implemented yet
exit codes: 0 ok · 1 failure · 2 usage · 3 refused · 64 not implemented
`;

export async function run(argv: string[]): Promise<number> {
  const [a, b] = argv;
  if (!a || a === '--help' || a === '-h' || a === 'help') {
    (a ? process.stdout : process.stderr).write(USAGE);
    return a ? EXIT.ok : EXIT.usage;
  }
  const key = a === 'run' ? `run ${b ?? ''}`.trim() : a;
  const verb = VERBS[key];
  if (!verb) {
    process.stderr.write(`resctl: unknown verb ${JSON.stringify(key)}\n${USAGE}`);
    return EXIT.usage;
  }
  try {
    return await verb.main(argv.slice(key.split(' ').length));
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`resctl: ${e.message}\n`);
      return e.code;
    }
    process.stderr.write(`resctl: ${(e as Error).stack ?? e}\n`);
    return EXIT.failure;
  }
}
