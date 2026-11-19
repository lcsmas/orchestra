// resctl uninstall-unit [--force]: stop + disable the unit, delete its file (only one resctl wrote), reload. Idempotent: a unit that is not installed is exit 0.
// Stopping the unit stops the reaper only; runs and their lanes are left exactly as they are.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../args.ts';
import { CliError, EXIT, refused, usageError } from '../errors.ts';
import { isManaged, resolveUnitName, systemctl, unitDir, userManager } from '../systemd.ts';

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { force: { type: 'boolean' } });
  if (positionals.length) throw usageError(`unexpected argument: ${positionals[0]}`);
  const name = resolveUnitName(process.env);
  const file = path.join(unitDir(process.env), name);
  const present = fs.existsSync(file);
  if (present && !isManaged(file) && !values.force) throw refused(`${file} was not written by resctl install-unit (use --force to remove it)`);
  const mgr = userManager(process.env);
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
