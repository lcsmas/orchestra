import { platform } from './platform';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Account, PinnedTicket, RepoEntry, RepoScripts, Workspace } from '../shared/types';
import { sanitizeAccountInherit } from '../shared/accounts';
import type { SelfTuneRun } from '../shared/self-tune';

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
  /** History of monthly self-tune runs (per-step statuses/timestamps — never
   *  transcripts, those live in files). Bounded; newest last. Absent on stores
   *  predating the feature → treated as `[]`. */
  selfTuneRuns?: SelfTuneRun[];
  /** Linear tickets pinned into the sidebar's Tickets section. A ticket is NOT
   *  a workspace (see PinnedTicket in shared/types.ts for why) so it lives in
   *  its own collection. Absent on stores predating the feature → treated as
   *  `[]`, which renders no section at all. */
  tickets?: PinnedTicket[];
}

const DEFAULT: StoreShape = { repos: [], workspaces: [], accounts: [] };

/** How many self-tune runs to keep in store.json. One run per month plus
 *  manual triggers — 24 is years of history at trivial size. */
const SELF_TUNE_HISTORY_MAX = 24;

class Store {
  // Resolved lazily on first use, not in the constructor. The userData path
  // must be read AFTER the entry point has relocated it via ORCHESTRA_HOME and
  // installed the platform seam (initPlatform) — but the bundler runs this
  // module's top-level code (including the `export const store = new Store()`
  // singleton) before the entry's own top-level statements, so a constructor
  // read would capture the pre-override path (or an uninitialized seam).
  // Deferring to the first `file` access (always inside an async method that
  // runs well after boot) sidesteps the ordering entirely.
  private _file: string | null = null;
  private get file(): string {
    if (this._file === null) {
      this._file = path.join(platform.getUserDataDir(), 'orchestra', 'store.json');
    }
    return this._file;
  }
  private data: StoreShape = DEFAULT;
  // Chain of pending saves — each save waits for the previous to finish before
  // writing. Prevents concurrent writeFile calls from interleaving and
  // truncating each other, which was corrupting store.json.
  private writeChain: Promise<void> = Promise.resolve();
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
    // Previously-running agents are NOT relaunched at startup: the agent
    // spawns (with `claude --continue`) when the user first opens the
    // workspace — see the pty:start path in TerminalView/startAgentPty.
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

  /** Remove many workspaces in one filter + one atomic save. Bulk delete uses
   *  this so tearing down N workspaces costs a single store.json rewrite rather
   *  than N serialized rewrites. */
  async removeWorkspaces(ids: string[]) {
    const drop = new Set(ids);
    this.data.workspaces = this.data.workspaces.filter((w) => !drop.has(w.id));
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
    // At most one account may be the scratch-session default — keep the first.
    let scratchDefaultSeen = false;
    for (const a of accounts) {
      const id = (a?.id ?? '').trim();
      const label = (a?.label ?? '').trim();
      if (!id || !label) continue;
      const inherit = sanitizeAccountInherit(a?.inherit);
      const scratchDefault = a?.scratchDefault === true && !scratchDefaultSeen;
      if (scratchDefault) scratchDefaultSeen = true;
      cleaned.push({
        id,
        label,
        configDir: typeof a.configDir === 'string' ? a.configDir.trim() : '',
        ...(scratchDefault ? { scratchDefault: true } : {}),
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

  get tickets(): PinnedTicket[] {
    return this.data.tickets ?? [];
  }

  /** Upsert one pinned ticket, keyed by canonical identifier — pinning the same
   *  issue twice updates it in place rather than duplicating the row. Ordering
   *  is stable: an existing ticket keeps its position (so a refresh never
   *  reshuffles the sidebar), a new one appends. */
  async upsertTicket(ticket: PinnedTicket): Promise<PinnedTicket> {
    const tickets = this.data.tickets ?? [];
    const i = tickets.findIndex((t) => t.identifier === ticket.identifier);
    if (i >= 0) tickets[i] = ticket;
    else tickets.push(ticket);
    this.data.tickets = tickets;
    await this.save();
    return ticket;
  }

  /** Replace every pinned ticket in one atomic save — the batched refresh uses
   *  this so updating N tickets costs one store.json rewrite, not N. */
  async setTickets(tickets: PinnedTicket[]): Promise<void> {
    this.data.tickets = tickets;
    await this.save();
  }

  /** Un-pin by identifier. Returns the removed ticket, or undefined if no such
   *  ticket was pinned (so the caller can report "not pinned" rather than a
   *  misleading success). */
  async removeTicket(identifier: string): Promise<PinnedTicket | undefined> {
    const tickets = this.data.tickets ?? [];
    const i = tickets.findIndex((t) => t.identifier === identifier);
    if (i < 0) return undefined;
    const [removed] = tickets.splice(i, 1);
    this.data.tickets = tickets;
    await this.save();
    return removed;
  }

  getTicket(identifier: string): PinnedTicket | undefined {
    return (this.data.tickets ?? []).find((t) => t.identifier === identifier);
  }

  /** Clear any ticket's `workspaceId` that points at a workspace that no longer
   *  exists. Without this a ticket whose workspace was deleted stays
   *  "graduated" forever: hidden from the Tickets section, yet still pinned —
   *  invisible state the user cannot see or act on. Returns true if anything
   *  changed (so the caller knows whether to broadcast). */
  async reconcileTicketWorkspaces(): Promise<boolean> {
    const tickets = this.data.tickets ?? [];
    const live = new Set(this.data.workspaces.map((w) => w.id));
    let mutated = false;
    for (const t of tickets) {
      if (t.workspaceId && !live.has(t.workspaceId)) {
        delete t.workspaceId;
        mutated = true;
      }
    }
    if (mutated) {
      this.data.tickets = tickets;
      await this.save();
    }
    return mutated;
  }

  get selfTuneRuns(): SelfTuneRun[] {
    return this.data.selfTuneRuns ?? [];
  }

  /** Upsert one self-tune run by id (runs mutate step-by-step as the pipeline
   *  advances) and trim the history to the newest SELF_TUNE_HISTORY_MAX. */
  async saveSelfTuneRun(run: SelfTuneRun) {
    const runs = this.data.selfTuneRuns ?? [];
    const i = runs.findIndex((r) => r.id === run.id);
    if (i >= 0) runs[i] = run;
    else runs.push(run);
    this.data.selfTuneRuns = runs.slice(-SELF_TUNE_HISTORY_MAX);
    await this.save();
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
