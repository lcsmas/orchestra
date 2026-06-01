import { app } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RepoEntry, RepoScripts, Workspace } from '../shared/types';

const PORT_RANGE_START = 55100;
const PORT_RANGE_END = 55600; // exclusive — keeps 500 slots, well above realistic concurrency

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
    // `running` across a restart can only be stale state from a prior PTY
    // that no longer exists — reset to idle. `waiting` is intentionally
    // preserved so an unread "agent finished" dot from the previous session
    // survives until the user actually views the workspace (markSeen).
    let mutated = false;
    for (const ws of this.data.workspaces) {
      // Migrate the obsolete 'stalled' status from older orchestra versions
      // (the PTY-quiescence watchdog has been removed) — treat as idle.
      if (ws.status === 'running' || (ws.status as string) === 'stalled') {
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

  async updateRepo(absPath: string, patch: Partial<RepoEntry>) {
    const i = this.data.repos.findIndex((r) => r.path === absPath);
    if (i < 0) return;
    this.data.repos[i] = { ...this.data.repos[i], ...patch };
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

  /** Reorder workspaces to match `orderedIds`. Any workspace whose id is not
   *  in the list keeps its relative order and trails the listed ones. */
  async reorderWorkspaces(orderedIds: string[]) {
    const rank = new Map(orderedIds.map((id, i) => [id, i] as const));
    this.data.workspaces.sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    await this.save();
  }

  /** Reorder registered repos to match `orderedPaths`. Unknown paths keep
   *  their relative order and trail the listed ones. */
  async reorderRepos(orderedPaths: string[]) {
    const rank = new Map(orderedPaths.map((p, i) => [p, i] as const));
    this.data.repos.sort(
      (a, b) =>
        (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER),
    );
    await this.save();
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.data.workspaces.find((w) => w.id === id);
  }

  /** Hand out the next free port in [PORT_RANGE_START, PORT_RANGE_END). Counts
   * a port as taken iff a non-archived workspace holds it — archived ones can
   * recycle their ports since their dev servers are gone. */
  allocatePort(): number {
    const used = new Set<number>();
    for (const w of this.data.workspaces) {
      if (w.archived) continue;
      if (typeof w.port === 'number') used.add(w.port);
    }
    for (let p = PORT_RANGE_START; p < PORT_RANGE_END; p++) {
      if (!used.has(p)) return p;
    }
    throw new Error('No free Orchestra port available');
  }

  async setRepoScripts(absPath: string, scripts: RepoScripts) {
    const repo = this.data.repos.find((r) => r.path === absPath);
    if (!repo) throw new Error(`repo not found: ${absPath}`);
    // Drop empty fields so we don't persist junk like {setup: ''}.
    const cleaned: RepoScripts = {};
    if (scripts.setup && scripts.setup.trim()) cleaned.setup = scripts.setup;
    if (scripts.run && scripts.run.trim()) cleaned.run = scripts.run;
    if (scripts.archive && scripts.archive.trim()) cleaned.archive = scripts.archive;
    if (Object.keys(cleaned).length === 0) {
      delete repo.scripts;
    } else {
      repo.scripts = cleaned;
    }
    await this.save();
    return repo;
  }

  getRepoScripts(absPath: string): RepoScripts {
    const repo = this.data.repos.find((r) => r.path === absPath);
    return repo?.scripts ?? {};
  }
}

export const store = new Store();
