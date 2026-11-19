// Tests that need systemd / docker FAIL LOUDLY when the host lacks it (a silent skip would read as green). The one way out is an explicit opt-out env var,
// which turns the block into a counted skip: RESCTL_TEST_NO_SYSTEMD=1 / RESCTL_TEST_NO_DOCKER=1.
import { spawnSync } from 'node:child_process';

export type Gate = { skip: string | false; why: string };

function gate(name: 'SYSTEMD' | 'DOCKER', probe: () => string | null): Gate {
  if (process.env[`RESCTL_TEST_NO_${name}`] === '1') return { skip: `RESCTL_TEST_NO_${name}=1`, why: '' };
  const missing = probe();
  if (missing) throw new Error(`${name.toLowerCase()} is required by these tests but unavailable (${missing}); set RESCTL_TEST_NO_${name}=1 to skip them explicitly`);
  return { skip: false, why: '' };
}

/** A reachable `systemctl --user` manager. */
export const systemd = (): Gate =>
  gate('SYSTEMD', () => {
    const r = spawnSync('systemctl', ['--user', 'show', '--property=Version', '--value'], { encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 ? null : (r.error?.message ?? r.stderr.trim()) || `exit ${r.status}`;
  });

/** A reachable docker daemon with the image already present locally (never pulled by a test). */
export const docker = (image: string): Gate =>
  gate('DOCKER', () => {
    const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 ? null : `docker image inspect ${image}: ${(r.error?.message ?? r.stderr.trim()) || `exit ${r.status}`}`;
  });
