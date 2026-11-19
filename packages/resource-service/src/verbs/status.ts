// resctl status — stub until A5 fills this file (freeze: print `not implemented (A5)`, exit 64).
import { EXIT } from '../errors.ts';

export async function main(_argv: string[]): Promise<number> {
  process.stderr.write('resctl status: not implemented (A5)\n');
  return EXIT.notImplemented;
}
