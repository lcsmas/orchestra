// resctl docker-env — stub until A2 fills this file (freeze: print `not implemented (A2)`, exit 64).
import { EXIT } from '../errors.ts';

export async function main(_argv: string[]): Promise<number> {
  process.stderr.write('resctl docker-env: not implemented (A2)\n');
  return EXIT.notImplemented;
}
