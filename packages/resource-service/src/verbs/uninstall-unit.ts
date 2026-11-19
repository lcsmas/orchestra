// resctl uninstall-unit [--force]: stop + disable the unit, delete its file (only one resctl wrote), reload. Idempotent: a unit that is not installed is exit 0.
// Stopping the unit stops the reaper only; runs and their lanes are left exactly as they are.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '../args.ts';
import { CliError, EXIT, refused, usageError } from '../errors.ts';
import { isManaged, resolveUnitName, resolveUnitDir, systemctl, unitDir, userManager } from '../systemd.ts';

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { force: { type: 'boolean' }, print: { type: 'boolean' } });
  if (positionals.length) throw usageError(`unexpected argument: ${positionals[0]}`);
  const name = resolveUnitName(process.env);
  const mgr = userManager(process.env);
  let dir = unitDir(process.env);
  if (mgr.ok) try { dir = resolveUnitDir(process.env); } catch { /* the manager searches neither dir: look in the conventional one */ }
  // the unit may have been installed under the other searched directory (the installer's XDG_CONFIG_HOME differed): take the one that has the file
  const home = path.join(os.homedir(), '.config', 'systemd', 'user');
  const file = [dir, home].map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) ?? path.join(dir, name);
  if (values.print) {
    process.stderr.write(`would uninstall ${name} at ${file}\n`); // dry run: names what it would act on (read-only `systemctl show` only)
    return EXIT.ok;
  }
  const present = fs.existsSync(file);
  if (present && !isManaged(file) && !values.force) throw refused(`${file} was not written by resctl install-unit (use --force to remove it)`);
  if (!mgr.ok) {
    if (present) throw new CliError(EXIT.failure, `cannot uninstall ${name}: ${mgr.detail} (its file ${file} is still there)`);
    process.stdout.write(`${name} was not installed (no systemd user manager here)\n`);
    return EXIT.ok;
  }
  const failures: string[] = [];
  const step = (args: string[], tolerate = false): void => {
    const r = systemctl(args, process.env);
    if (r.status !== 0 && !tolerate) failures.push(`systemctl --user ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  };
  // Always stop + disable, even when the file is already gone (deleted by hand while the unit still runs); with no file that failing is expected.
  step(['disable', '--now', name], !present);
  if (present) fs.rmSync(file, { force: true });
  step(['daemon-reload']);
  step(['reset-failed', name], true); // nothing to reset when it never failed
  if (failures.length) throw new CliError(EXIT.failure, failures.join('; '));
  process.stdout.write(present ? `uninstalled ${name} (${file} removed)\n` : `${name} was not installed\n`);
  return EXIT.ok;
}
