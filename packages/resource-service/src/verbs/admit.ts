// resctl admit — stub until A3 fills this file (freeze: print `not implemented (A3)`, exit 64).
import { EXIT } from '../errors.ts';

export async function main(_argv: string[]): Promise<number> {
  process.stderr.write('resctl admit: not implemented (A3)\n');
  return EXIT.notImplemented;
}
