import { parseArgs, type ParseArgsConfig } from 'node:util';
import { usageError } from './errors.ts';

/** `util.parseArgs`, strict, with usage errors mapped to exit 2. Everything after `--` stays positional. */
export function parse<T extends ParseArgsConfig['options']>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw usageError((e as Error).message);
  }
}
