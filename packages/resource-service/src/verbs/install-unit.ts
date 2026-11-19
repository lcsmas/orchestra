// resctl install-unit [--no-start] [--print] [--force]: write the systemd USER unit of `resctl serve` (name $RESCTL_UNIT_NAME, default resctl.service),
// enable it and (re)start it. `--print` = dry run: unit text on stdout, nothing touched, no systemd needed.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../args.ts';
import { daemonLockPath } from '../daemon.ts';
import { termWaitMs } from '../env.ts';
import { refused, usageError, CliError, EXIT } from '../errors.ts';
import { readHolder } from '../lockfile.ts';
import { isAlive, signalIfSame, sleep } from '../proc.ts';
import { isManaged, renderUnit, requireUserManager, settle, systemctl, unitDirFor, unitSpec } from '../systemd.ts';

/** A daemon the unit did not start (autostarted by `run start`, or a hand-run `serve`) holds daemon.lock: the unit's `serve` would exit 3 and sit `failed`. */
async function stopOtherDaemon(stateDir: string, unit: string, log: (m: string) => void): Promise<void> {
  const h = readHolder(daemonLockPath(stateDir));
  if (!h || h === 'unreadable' || !isAlive(h)) return;
  const main = Number(systemctl(['show', '--property=MainPID', '--value', unit], process.env).stdout.trim());
  if (h.pid === main) return; // the unit's own daemon: `restart` replaces it
  // SIGTERM to a `serve` is a clean exit that reaps nothing (identity re-read at signal time)
  if (signalIfSame(h, 'SIGTERM') === 'refused') throw new CliError(EXIT.failure, `daemon pid ${h.pid} holds ${daemonLockPath(stateDir)} but this process may not signal it (same process group?): stop it yourself, then re-run install-unit`);
  const deadline = Date.now() + 2 * termWaitMs() + 2000;
  while (isAlive(h) && Date.now() < deadline) await sleep(50);
  if (isAlive(h)) throw new CliError(EXIT.failure, `daemon pid ${h.pid} holds ${daemonLockPath(stateDir)} and did not exit on SIGTERM: stop it (kill ${h.pid}), then re-run install-unit (the unit is installed and enabled, not started)`);
  log(`stopped daemon pid ${h.pid} that held daemon.lock (it reaped nothing; the unit takes over)`);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { 'no-start': { type: 'boolean' }, print: { type: 'boolean' }, force: { type: 'boolean' } });
  if (positionals.length) throw usageError(`unexpected argument: ${positionals[0]}`);
  const spec = unitSpec(process.env);
  const text = renderUnit(spec);
  if (values.print) {
    process.stderr.write(`would install ${spec.name} at ${path.join(unitDirFor(process.env), spec.name)}\n`);
    process.stdout.write(text);
    return EXIT.ok;
  }
  requireUserManager(process.env);
  const file = path.join(unitDirFor(process.env), spec.name);
  if (fs.existsSync(file) && !isManaged(file) && !values.force) throw refused(`${file} exists and was not written by resctl install-unit (use --force to replace it)`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
  const step = (args: string[]): void => {
    const r = systemctl(args, process.env);
    if (r.status !== 0) throw new CliError(EXIT.failure, `systemctl --user ${args.join(' ')} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
  };
  step(['daemon-reload']);
  step(['enable', spec.name]);
  if (!values['no-start']) {
    await stopOtherDaemon(spec.environment.RESCTL_STATE_DIR, spec.name, (m) => void process.stderr.write(`resctl: ${m}\n`));
    systemctl(['reset-failed', spec.name], process.env); // a unit left failed by an earlier attempt
    step(['restart', spec.name]);
    const down = await settle(spec.name, spec.environment.RESCTL_STATE_DIR, process.env);
    if (down) throw new CliError(EXIT.failure, `installed ${spec.name} (${file}) but ${down}`);
  }
  process.stdout.write(`installed ${spec.name} (${file}); state dir ${spec.environment.RESCTL_STATE_DIR}${values['no-start'] ? '' : '; started'}\n`);
  return EXIT.ok;
}
