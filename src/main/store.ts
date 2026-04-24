import { app } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RepoEntry, Workspace } from '../shared/types';

interface StoreShape {
  repos: RepoEntry[];
  workspaces: Workspace[];
}

const DEFAULT: StoreShape = { repos: [], workspaces: [] };

export class Store {
  private file: string;
  private data: StoreShape = DEFAULT;
  // Chain of pending saves — each save waits for the previous to finish before
  // writing. Prevents concurrent writeFile calls from interleaving and
  // truncating each other, which was corrupting store.json.
  private writeChain: Promise<void> = Promise.resolve();

  constructor() {
    const dir = path.join(app.getPath('userData'), 'orchestra');
    this.file = path.join(dir, 'store.json');
  }

  async load() {
    const dir = path.dirname(this.file);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    if (!existsSync(this.file)) {
      await this.save();
      return;
    }
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...DEFAULT, ...parsed };
    } catch {
      this.data = DEFAULT;
    }
    // `running` across a restart can only be stale crash state — no PTY is
    // alive yet. Reset to idle. `waiting` is intentionally preserved so an
    // unread "agent finished" dot from the previous session survives until the
    // user actually views the workspace (markSeen).
    let mutated = false;
    for (const ws of this.data.workspaces) {
      if (ws.status === 'running') {
        ws.status = 'idle';
        mutated = true;
      }
    }
    if (mutated) await this.save();
  }

  async save() {
    // Serialize every save through a single promise chain, and write atomically
    // (tmp + rename) so a mid-write crash or overlapping write can't leave a
    // truncated / interleaved store.json on disk.
    const next = this.writeChain.then(async () => {
      const payload = JSON.stringify(this.data, null, 2);
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, this.file);
    });
    // Never let one failure poison subsequent saves.
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  get repos() {
    return this.data.repos;
  }

  get workspaces() {
    return this.data.workspaces;
  }

  async addRepo(r: RepoEntry) {
    if (!this.data.repos.find((x) => x.path === r.path)) {
      this.data.repos.push(r);
      await this.save();
    }
    return r;
  }

  async removeRepo(absPath: string) {
    this.data.repos = this.data.repos.filter((r) => r.path !== absPath);
    await this.save();
  }

  async upsertWorkspace(w: Workspace) {
    const i = this.data.workspaces.findIndex((x) => x.id === w.id);
    if (i >= 0) this.data.workspaces[i] = w;
    else this.data.workspaces.push(w);
    await this.save();
  }

  async removeWorkspace(id: string) {
    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id);
    await this.save();
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.data.workspaces.find((w) => w.id === id);
  }
}

export const store = new Store();
