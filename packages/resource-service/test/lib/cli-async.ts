// The CLI without blocking the test's event loop: a test that hosts a FAKE daemon in-process must not use `rig.cli` (spawnSync) for a verb that talks to it — the daemon could never
// answer. Exit status + stderr only (rig.spawnCli drops stdout).
import { within, type Rig } from './rig.ts';

export async function endRun(rig: Rig, id: string, env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stderr: string }> {
  const { exited, stderr } = rig.spawnCli(['run', 'end', '--id', id], env);
  const { code } = await within(`run end ${id}`, exited, 60_000);
  return { status: code, stderr: stderr() };
}
