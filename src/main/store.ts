import { app } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Account, RepoEntry, RepoScripts, Workspace } from '../shared/types';
import { sanitizeAccountInherit } from '../shared/accounts';

const PORT_RANGE_START = 55100;
const PORT_RANGE_END = 55600; // exclusive — keeps 500 slots, well above realistic concurrency

interface StoreShape {
  repos: RepoEntry[];
  workspaces: Workspace[];
  /** Explicit list of Claude accounts for the per-workspace usage badge. Each
   *  account's `token` is a template (a `${VAR}` reference or literal label),
   *  NEVER an expanded secret — secrets stay in Orchestra's env, out of
   *  store.json. Absent on stores predating the feature → treated as `[]`. */
  accounts?: Account[];
}

const DEFAULT: StoreShape = { repos: [], workspaces: [], accounts: [] };

class Store {
  private file: string;
  private data: StoreShape = DEFAULT;
  // Chain of pending saves — each save waits for the previous to finish before
  // writing. Prevents concurrent writeFile calls from interleaving and
  // truncating each other, which was corrupting store.json.
  private writeChain: Promise<void> = Promise.resolve();
  // Workspace ids that were `running` when the store was last loaded — i.e. an
  // agent PTY was live when Orchestra previously exited. `load()` resets their
  // persisted status to `idle` (a PTY can't survive a restart), but stashes the
  // ids here so startup can relaunch `claude --continue` for them and bring the
  // agent back. Read once via `takeResumeCandidates()`, which drains the list.
  private resumeCandidates: string[] = [];

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
    // A workspace that was running with a real prior conversation
    // (`hasInput`) is also queued for resume: startup relaunches its agent
    // with `claude --continue` so the work picks back up where it left off.
    // The reset-to-idle still stands so the UI never shows a stale `running`
    // for a workspace whose resume fails (worktree gone, spawn error).
    this.resumeCandidates = [];
    let mutated = false;
    for (const ws of this.data.workspaces) {
      // Migrate the obsolete 'stalled' status from older orchestra versions
      // (the PTY-quiescence watchdog has been removed) — treat as idle.
      if (ws.status === 'running' || (ws.status as string) === 'stalled') {
        if (ws.status === 'running' && !ws.archived && ws.hasInput) {
          this.resumeCandidates.push(ws.id);
        }
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
    const before = this.data.repos.length;
    this.data.repos = this.data.repos.filter((r) => r.path !== absPath);
    if (this.data.repos.length !== before) await this.save();
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

  /** Workspace ids that were `running` at the last `load()` and had a real
   *  prior conversation — candidates for `claude --continue` resume on startup.
   *  Drains the list so a second call returns nothing (resume runs once). */
  takeResumeCandidates(): string[] {
    const ids = this.resumeCandidates;
    this.resumeCandidates = [];
    return ids;
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

  get accounts(): Account[] {
    return this.data.accounts ?? [];
  }

  /** Replace the whole accounts list. Drops entries missing an id or label,
   *  trims fields, and keeps `id`/`label`/`configDir`/`inherit`. `configDir` is
   *  a path (optionally with `~`/`${VAR}`) — never a secret; the credentials
   *  live in that dir's `.credentials.json`, which Orchestra never persists here.
   *  `inherit` is normalized via {@link sanitizeAccountInherit} and omitted when
   *  empty. */
  async setAccounts(accounts: Account[]): Promise<Account[]> {
    const cleaned: Account[] = [];
    for (const a of accounts) {
      const id = (a?.id ?? '').trim();
      const label = (a?.label ?? '').trim();
      if (!id || !label) continue;
      const inherit = sanitizeAccountInherit(a?.inherit);
      cleaned.push({
        id,
        label,
        configDir: typeof a.configDir === 'string' ? a.configDir.trim() : '',
        ...(inherit ? { inherit } : {}),
      });
    }
    this.data.accounts = cleaned;
    // Clear any repo's accountId that now points at a removed account, so a
    // dangling reference can't linger in store.json.
    const liveIds = new Set(cleaned.map((a) => a.id));
    for (const repo of this.data.repos) {
      if (repo.accountId && !liveIds.has(repo.accountId)) delete repo.accountId;
    }
    await this.save();
    return cleaned;
  }

  /** Assign (or clear, with `null`/'') the account a repo's workspaces log in
   *  as. Unknown account ids are rejected so we never store a dangling ref. */
  async setRepoAccount(absPath: string, accountId: string | null): Promise<RepoEntry> {
    const repo = this.data.repos.find((r) => r.path === absPath);
    if (!repo) throw new Error(`repo not found: ${absPath}`);
    const id = (accountId ?? '').trim();
    if (!id) {
      delete repo.accountId;
    } else {
      if (!(this.data.accounts ?? []).some((a) => a.id === id)) {
        throw new Error(`unknown account: ${id}`);
      }
      repo.accountId = id;
    }
    await this.save();
    return repo;
  }
}

export const store = new Store();
