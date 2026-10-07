// An in-memory Docker for the Pause tests (#292): containers with labels / running state / AutoRemove, the daemon's own label + status
// filtering (so a test that forgets the label filter lists — and would stop — a bystander), and a call log asserted in order.

import { DockerApiError } from './docker-api.ts';
import type { PauseDockerApi } from './pause-containers.ts';

export interface FakeContainer {
  id: string;
  name: string;
  image?: string;
  labels?: Record<string, string>;
  running?: boolean;
  /** `restarting` = a crash-looping container (still holds memory); default derives from `running`. */
  restarting?: boolean;
  autoRemove?: boolean;
}

export class FakeDocker implements PauseDockerApi {
  calls: string[] = [];
  containers: Required<FakeContainer>[];
  /** ids whose stop THROWS but only AFTER taking effect (a client-side timeout on a stop the daemon completed) */
  stopThrowsAfterEffect = new Set<string>();
  /** ids whose stop / start throws */
  failStop = new Set<string>();
  failStart = new Set<string>();
  /** the daemon exists but does not answer (socket there, connection refused) */
  down = false;
  /** Docker is simply not there (no socket: not installed / not started) */
  absent = false;
  /** a hook run right before each stop (the test lifts the pause / removes a container "by hand" here) */
  beforeStop: ((id: string) => void) | null = null;
  /** a hook run right before each start (the test asserts what must already be true — or not yet — at that moment) */
  beforeStart: ((id: string) => void) | null = null;

  constructor(cs: FakeContainer[]) {
    this.containers = cs.map((c) => ({ image: 'alpine', labels: {}, running: true, restarting: false, autoRemove: false, ...c }));
  }
  private get(id: string): Required<FakeContainer> | undefined {
    return this.containers.find((c) => c.id === id);
  }
  private check(): void {
    if (this.absent) throw new DockerApiError('docker unavailable: connect ENOENT /var/run/docker.sock', 'unavailable');
    if (this.down) throw new DockerApiError('docker unavailable: connect ECONNREFUSED /var/run/docker.sock', 'unavailable');
  }
  async listContainers(o: { all?: boolean; labels?: string[]; status?: string[] } = {}): Promise<import('./docker-api.ts').DockerContainerSummary[]> {
    this.calls.push(`list labels=${JSON.stringify(o.labels ?? [])} status=${JSON.stringify(o.status ?? [])}`);
    this.check();
    return this.containers
      .filter((c) => (o.labels ?? []).every((l) => (l.includes('=') ? c.labels[l.slice(0, l.indexOf('='))] === l.slice(l.indexOf('=') + 1) : l in c.labels)))
      .filter((c) => !(o.status ?? []).length || (o.status ?? []).includes(this.state(c)))
      .map((c) => ({ id: c.id, name: c.name, image: c.image, state: this.state(c), status: '', created: 0, labels: { ...c.labels } }));
  }
  private state(c: Required<FakeContainer>): string {
    return c.restarting ? 'restarting' : c.running ? 'running' : 'exited';
  }
  async inspectContainer(id: string): Promise<import("./docker-api.ts").DockerContainerInspect | null> {
    this.calls.push(`inspect ${id}`);
    this.check();
    const c = this.get(id);
    return c ? { id: c.id, name: c.name, image: c.image, running: c.running, autoRemove: c.autoRemove, labels: { ...c.labels } } : null;
  }
  async stopContainer(id: string, t = 10): Promise<'stopped' | 'already-stopped' | 'gone'> {
    this.calls.push(`stop ${id} t=${t}`);
    this.beforeStop?.(id);
    this.check();
    if (this.failStop.has(id)) throw new DockerApiError(`docker stop ${id}: HTTP 500 — daemon exploded`, 'http', 500);
    const c = this.get(id);
    if (!c) return 'gone';
    if (!c.running && !c.restarting) return 'already-stopped';
    c.running = false;
    c.restarting = false;
    if (this.stopThrowsAfterEffect.has(id)) throw new DockerApiError(`docker POST /containers/${id}/stop timed out`, 'timeout');
    return 'stopped';
  }
  async startContainer(id: string): Promise<'started' | 'already-running' | 'gone'> {
    this.calls.push(`start ${id}`);
    this.beforeStart?.(id);
    this.check();
    if (this.failStart.has(id)) throw new DockerApiError(`docker start ${id}: HTTP 500 — no space left`, 'http', 500);
    const c = this.get(id);
    if (!c) return 'gone';
    if (c.running) return 'already-running';
    c.running = true;
    return 'started';
  }
  /** `docker rm` by hand — what a user does during a Pause */
  remove(id: string): void {
    this.containers = this.containers.filter((c) => c.id !== id);
  }
  running(id: string): boolean {
    return this.get(id)?.running === true;
  }
}
