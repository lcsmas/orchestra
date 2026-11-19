// Which leftover `resctl-test-*` unit files a test run may sweep: ones resctl wrote, named like a test unit, whose pinned state dir is a rig dir that no longer exists.
// A sibling suite's LIVE unit (its state dir exists) is never touched.
import os from 'node:os';
import path from 'node:path';
import { parseUnitEnv } from '../../src/systemd.ts';

export const TEST_UNIT = /^resctl-test-[0-9a-f]{8}\.service$/;

export function staleTestUnits(files: { name: string; text: string }[], exists: (p: string) => boolean, tmp: string = process.env.TMPDIR || os.tmpdir()): string[] {
  const prefix = path.join(tmp, 'resctl-test-');
  return files
    .filter((f) => TEST_UNIT.test(f.name) && f.text.startsWith('# managed by `resctl install-unit`'))
    .filter((f) => {
      const dir = parseUnitEnv(f.text).RESCTL_STATE_DIR;
      return !!dir && dir.startsWith(prefix) && !exists(dir);
    })
    .map((f) => f.name);
}
