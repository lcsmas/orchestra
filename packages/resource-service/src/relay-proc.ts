// The relay child process: `relay-proc.ts <run id> <run token> <socket> <upstream>`, spawned detached by docker-env. Serves until stopped (SIGTERM from the cleanup step) —
// and, as a belt against a cleanup that never reached it, exits by itself once its run instance is gone, cleaned or closed (state re-read every RESCTL_TICK).
import { stateDir, tickMs } from './env.ts';
import { createRelay } from './relay.ts';
import { own, registerRelay, relayOf } from './relay-host.ts';
import { readState } from './state.ts';

const [id, token, sock, upstream] = process.argv.slice(2);
if (!id || !token || !sock || !upstream) {
  process.stderr.write('usage: relay-proc.ts <run id> <run token> <socket> <upstream>\n');
  process.exit(2);
}
const log = (m: string): void => void process.stderr.write(`${new Date().toISOString()} relay ${id}: ${m}\n`);
process.on('uncaughtException', (e) => log(`uncaught: ${e.stack ?? e}`)); // one bad connection must not end the run's docker access
const dir = stateDir();
// register our identity in the run's record BEFORE listening: a cleanup that runs from now on can stop us, and a run that is already closed never gets a relay
if (!(await registerRelay(dir, id, token, sock))) {
  log('its run instance is gone or closed: not starting');
  process.exit(0);
}
const relay = createRelay({ sockPath: sock, upstream, runId: id, token, log });
if (!(await relay.start())) process.exit(1);
log(`listening on ${sock}, forwarding to ${upstream} (pid ${process.pid})`);

const stop = (why: string): void => {
  log(`stopping: ${why}`);
  relay.stop();
  process.exit(0);
};
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => stop(sig));
setInterval(() => {
  try {
    const run = own(readState(dir).runs, id);
    if (!run || run.token !== token || run.state === 'cleaned' || relayOf(run)?.closed) stop('its run instance is gone or closed');
  } catch {
    /* an unreadable state file: keep serving, never guess the run is over */
  }
}, tickMs());
