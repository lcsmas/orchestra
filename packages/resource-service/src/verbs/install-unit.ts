// resctl install-unit [--no-start] [--print] [--force]: write the systemd USER unit of `resctl serve` (name $RESCTL_UNIT_NAME, default resctl.service),
// enable it and (re)start it. `--print` = dry run: unit text on stdout, nothing touched, no systemd needed.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../args.ts';
import { refused, usageError, CliError, EXIT } from '../errors.ts';
import { isManaged, renderUnit, requireUserManager, settle, systemctl, unitDir, unitSpec } from '../systemd.ts';

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { 'no-start': { type: 'boolean' }, print: { type: 'boolean' }, force: { type: 'boolean' } });
  if (positionals.length) throw usageError(`unexpected argument: ${positionals[0]}`);
  const spec = unitSpec(process.env);
  const text = renderUnit(spec);
  const file = path.join(unitDir(process.env), spec.name);
  if (values.print) {
    process.stderr.write(`would install ${spec.name} at ${file}\n`);
    process.stdout.write(text);
    return EXIT.ok;
  }
  requireUserManager(process.env);
  if (fs.existsSync(file) && !isManaged(file) && !values.force) throw refused(`${file} exists and was not written by resctl install-unit (use --force to replace it)`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
  for (const args of [['daemon-reload'], ['enable', spec.name], ...(values['no-start'] ? [] : [['restart', spec.name]])]) {
    const r = systemctl(args, process.env);
    if (r.status !== 0) throw new CliError(EXIT.failure, `systemctl --user ${args.join(' ')} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
  }
  if (!values['no-start']) {
    const down = await settle(spec.name, process.env);
    if (down) throw new CliError(EXIT.failure, `installed ${spec.name} (${file}) but ${down}`);
  }
  process.stdout.write(`installed ${spec.name} (${file}); state dir ${spec.environment.RESCTL_STATE_DIR}${values['no-start'] ? '' : '; started'}\n`);
  return EXIT.ok;
}
