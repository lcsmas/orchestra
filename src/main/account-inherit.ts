// Materialize selected pieces of the GLOBAL `~/.claude` config into a
// per-account login dir (the account's `CLAUDE_CONFIG_DIR`).
//
// Why: each account is an isolated config dir that, by default, contains only
// `.credentials.json`. An agent spawned as that account therefore loses the
// user's global settings, statusline, skills, and MCP servers. This module
// "inherits" the user-chosen subset (see {@link Account.inherit}) so an
// alternate login behaves like the default one for the things that should be
// shared, while keeping per-account state (credentials, conversation history,
// project trust) isolated.
//
// Mechanism is a HYBRID, by necessity:
//   - files & skills → SYMLINK into the login dir (so they track the global
//     config; edits propagate). Non-destructive: we never replace a real file,
//     and only ever remove links WE created (tracked in a manifest).
//   - MCP servers    → selective MERGE into the login dir's `.claude.json`
//     (that file also holds the account's per-project history/trust, which must
//     stay isolated, so it cannot be symlinked). Additive + manifest-tracked.
//
// One-way dependency: this imports `store`; `store` must NOT import this.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { store } from './store';
import { expandConfigDir, type Account, type AccountInherit } from '../shared/accounts';
import { log } from './logger';

/** The user's real global Claude config dir — the inheritance SOURCE. Always
 *  `~/.claude`, never an account dir or a relocated `CLAUDE_CONFIG_DIR`: that is
 *  the canonical config we copy *from*. */
function globalClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

/** The global `~/.claude.json` (home, NOT inside `.claude/`) — where Claude Code
 *  stores `mcpServers` and per-project state. We read `mcpServers` from here. */
function globalClaudeJson(): string {
  return path.join(os.homedir(), '.claude.json');
}

// ---- inheritance defaults ----------------------------------------------------
//
// Initial per-account selection seeded for accounts that have none yet. These
// are SEED values only — the Accounts UI fully overrides them and the seed runs
// once per account (it never clobbers an existing `inherit`). Names are filtered
// against what actually exists in the global config, so a missing skill/server
// is silently skipped.

/** Items every account inherits unless edited: shared config + general skills +
 *  general MCP servers. */
const BASE_SKILLS = ['frontend-design', 'handoff', 'web-artifacts-builder'];
const BASE_MCP = ['chrome-devtools', 'chrome-devtools-electron'];
/** Extra items seeded only for the work ("mc") login. */
const MC_SKILLS = ['implement-linear-ticket', 'triage-helptech'];
const MC_MCP = [
  'github',
  'linear-server',
  'datadog-mcp',
  'postgres-local',
  'postgres-prod',
  'postgres-staging',
  'mysql-nextmobile-int',
  'mysql-nextmobile-local',
  'mysql-nextmobile-prod',
];

// ---- manifest ----------------------------------------------------------------
//
// Records what THIS module created in a login dir, so a later sync can remove
// items the user de-selected without touching anything the user added by hand.

interface InheritManifest {
  /** Login-dir-relative paths of symlinks we created (e.g. `settings.json`,
   *  `skills/frontend-design`). */
  symlinks: string[];
  /** mcpServer keys we merged into the login dir's `.claude.json`. */
  mcpServers: string[];
}

const MANIFEST_NAME = '.orchestra-inherited.json';

function readManifest(loginDir: string): InheritManifest {
  try {
    const raw = fs.readFileSync(path.join(loginDir, MANIFEST_NAME), 'utf8');
    const parsed = JSON.parse(raw) as Partial<InheritManifest>;
    return {
      symlinks: Array.isArray(parsed.symlinks) ? parsed.symlinks.filter((s) => typeof s === 'string') : [],
      mcpServers: Array.isArray(parsed.mcpServers)
        ? parsed.mcpServers.filter((s) => typeof s === 'string')
        : [],
    };
  } catch {
    return { symlinks: [], mcpServers: [] };
  }
}

function writeManifest(loginDir: string, m: InheritManifest): void {
  try {
    fs.writeFileSync(path.join(loginDir, MANIFEST_NAME), JSON.stringify(m, null, 2));
  } catch (err) {
    log.warn(`account-inherit: failed to write manifest in ${loginDir}`, err);
  }
}

// ---- discovery (feeds the Accounts UI) ---------------------------------------

/** What the global `~/.claude` currently offers to inherit: skill dir names and
 *  MCP server keys. Drives the per-account checkbox lists in the renderer. Both
 *  lists are sorted; empty when the global config is missing the source. */
export function listInheritables(): { skills: string[]; mcpServers: string[] } {
  const skills: string[] = [];
  try {
    for (const ent of fs.readdirSync(path.join(globalClaudeDir(), 'skills'), { withFileTypes: true })) {
      // A skill is a directory (or a symlink to one); skip stray files.
      if (ent.isDirectory() || ent.isSymbolicLink()) skills.push(ent.name);
    }
  } catch {
    /* no skills dir → none to offer */
  }
  let mcpServers: string[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(globalClaudeJson(), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      mcpServers = Object.keys(parsed.mcpServers);
    }
  } catch {
    /* no ~/.claude.json or unparseable → none to offer */
  }
  return { skills: skills.sort(), mcpServers: mcpServers.sort() };
}

/** The seed selection for an account that has no `inherit` yet, filtered to what
 *  actually exists in the global config. Work account (`label === 'mc'`) gets
 *  the base set plus its extras; every other account gets just the base. */
function defaultInheritForAccount(
  account: Account,
  available: { skills: string[]; mcpServers: string[] },
): AccountInherit {
  const isMc = account.label.trim().toLowerCase() === 'mc';
  const skillSet = isMc ? [...BASE_SKILLS, ...MC_SKILLS] : BASE_SKILLS;
  const mcpSet = isMc ? [...BASE_MCP, ...MC_MCP] : BASE_MCP;
  const skills = skillSet.filter((s) => available.skills.includes(s));
  const mcpServers = mcpSet.filter((s) => available.mcpServers.includes(s));
  return {
    settings: true,
    statusline: true,
    ...(skills.length ? { skills } : {}),
    ...(mcpServers.length ? { mcpServers } : {}),
  };
}

/** One-time seed: give every account that lacks an `inherit` a sensible default
 *  (see {@link defaultInheritForAccount}). Persists via `store.setAccounts` only
 *  when something was actually seeded, so a startup with all accounts already
 *  configured is a no-op. */
export async function seedAccountInheritDefaults(): Promise<void> {
  const accounts = store.accounts;
  if (!accounts.some((a) => a.inherit === undefined)) return;
  const available = listInheritables();
  const next = accounts.map((a) =>
    a.inherit === undefined ? { ...a, inherit: defaultInheritForAccount(a, available) } : a,
  );
  await store.setAccounts(next);
  log.info('account-inherit: seeded default inheritance for new accounts');
}

// ---- symlink helpers ---------------------------------------------------------

/** True iff `p` exists AND is a symlink (so we may safely manage/remove it). */
function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Ensure `loginDir/rel` is a symlink to `target`.
 *  Returns true if the link is present afterwards (created/already-correct),
 *  false if it was skipped (missing source, or a real file is in the way and
 *  `replaceReal` is false).
 *
 *  `replaceReal` governs what happens when a REAL (non-symlink) file already
 *  sits at `linkPath`: when false we leave it untouched (skills — a real dir is
 *  the user's own skill, never destroy it); when true we back it up ONCE to
 *  `<linkPath>.orchestra-bak` then replace it with the symlink. The replace path
 *  is for the config FILES the user explicitly opted to inherit (settings.json,
 *  statusline) — an auto-generated stale copy in the login dir must not silently
 *  shadow the global one, but we still keep a recoverable backup. */
function ensureSymlink(loginDir: string, rel: string, target: string, replaceReal: boolean): boolean {
  const linkPath = path.join(loginDir, rel);
  if (!fs.existsSync(target)) {
    // Source gone — drop a stale link if we have one, then skip.
    if (isSymlink(linkPath)) {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        /* best effort */
      }
    }
    return false;
  }
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      if (fs.readlinkSync(linkPath) === target) return true; // already correct
      fs.unlinkSync(linkPath); // repoint
    } else if (replaceReal) {
      // Back up the real file once (never clobber an existing backup), then
      // replace it with the symlink so the inherited config actually wins.
      const backup = `${linkPath}.orchestra-bak`;
      try {
        if (!fs.existsSync(backup)) fs.renameSync(linkPath, backup);
        else fs.rmSync(linkPath, { recursive: true, force: true });
        log.info(`account-inherit: replaced real ${linkPath} with inherited symlink (backup: ${backup})`);
      } catch (err) {
        log.warn(`account-inherit: could not back up ${linkPath}, leaving it as-is`, err);
        return false;
      }
    } else {
      // A REAL file/dir the user owns — never clobber it.
      log.warn(`account-inherit: ${linkPath} is a real file, not inheriting (left as-is)`);
      return false;
    }
  } catch {
    /* linkPath doesn't exist yet — fall through to create */
  }
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    const type = fs.statSync(target).isDirectory() ? 'dir' : 'file';
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    log.warn(`account-inherit: failed to symlink ${linkPath} -> ${target}`, err);
    return false;
  }
}

/** Remove a symlink we previously created (only if it is in fact a symlink). */
function removeOurSymlink(loginDir: string, rel: string): void {
  const linkPath = path.join(loginDir, rel);
  if (isSymlink(linkPath)) {
    try {
      fs.unlinkSync(linkPath);
    } catch {
      /* best effort */
    }
  }
}

// ---- MCP merge ---------------------------------------------------------------

/** Merge the selected global mcpServers into the login dir's `.claude.json`,
 *  removing any we previously injected that are no longer selected. Preserves
 *  every other key in the file (project history, trust, the user's own servers).
 *  Returns the keys that are now ours. */
function syncMcpServers(loginDir: string, desired: string[], prevKeys: string[]): string[] {
  // Read the global server definitions.
  let globalMcp: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(globalClaudeJson(), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') globalMcp = parsed.mcpServers;
  } catch {
    /* no global servers available */
  }
  const want = desired.filter((k) => k in globalMcp);
  const toRemove = prevKeys.filter((k) => !want.includes(k));
  // Nothing to add and nothing to remove → don't even touch (or create) the file.
  if (want.length === 0 && toRemove.length === 0) return [];

  const claudeJsonPath = path.join(loginDir, '.claude.json');
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as Record<string, unknown>;
  } catch {
    /* missing/empty → start from {} */
  }
  const servers: Record<string, unknown> =
    data.mcpServers && typeof data.mcpServers === 'object'
      ? (data.mcpServers as Record<string, unknown>)
      : {};
  for (const k of toRemove) delete servers[k];
  for (const k of want) servers[k] = globalMcp[k];
  data.mcpServers = servers;
  try {
    fs.writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2));
  } catch (err) {
    log.warn(`account-inherit: failed to write ${claudeJsonPath}`, err);
    return prevKeys; // leave manifest unchanged on failure
  }
  return want;
}

// ---- public sync -------------------------------------------------------------

/** Materialize `account.inherit` into the account's login dir. Idempotent and
 *  non-destructive; safe to call before every agent spawn. No-ops for an account
 *  with no usable config dir. */
export async function syncAccountInheritance(account: Account): Promise<void> {
  const loginDir = expandConfigDir(account.configDir, os.homedir(), process.env);
  if (!loginDir) return;
  const inherit = account.inherit;
  const globalDir = globalClaudeDir();

  try {
    await fs.promises.mkdir(loginDir, { recursive: true });
  } catch (err) {
    log.warn(`account-inherit: cannot create login dir ${loginDir}`, err);
    return;
  }

  const prev = readManifest(loginDir);

  // Build the desired symlink set (relative path -> {target, replaceReal}).
  // Config FILES the user opted into replace a stale real copy (with backup);
  // skill DIRS never clobber a real dir (could be the user's own skill).
  const wantLinks = new Map<string, { target: string; replaceReal: boolean }>();
  if (inherit?.settings) {
    wantLinks.set('settings.json', { target: path.join(globalDir, 'settings.json'), replaceReal: true });
  }
  if (inherit?.statusline) {
    wantLinks.set('statusline-command.sh', {
      target: path.join(globalDir, 'statusline-command.sh'),
      replaceReal: true,
    });
  }
  for (const name of inherit?.skills ?? []) {
    // Guard against path traversal in stored names — skills are single segments.
    if (name.includes('/') || name.includes('\\') || name === '..') continue;
    wantLinks.set(path.join('skills', name), {
      target: path.join(globalDir, 'skills', name),
      replaceReal: false,
    });
  }

  // Apply desired links; collect the ones actually present afterwards.
  const liveLinks: string[] = [];
  for (const [rel, { target, replaceReal }] of wantLinks) {
    if (ensureSymlink(loginDir, rel, target, replaceReal)) liveLinks.push(rel);
  }
  // Remove links we created before that are no longer desired.
  for (const rel of prev.symlinks) {
    if (!wantLinks.has(rel)) removeOurSymlink(loginDir, rel);
  }

  // MCP servers (selective merge into the login dir's own .claude.json).
  const liveMcp = syncMcpServers(loginDir, inherit?.mcpServers ?? [], prev.mcpServers);

  writeManifest(loginDir, { symlinks: liveLinks, mcpServers: liveMcp });
}

/** Sync every configured account. Called after the accounts list changes so
 *  edits apply immediately (not just on the next agent spawn). */
export async function syncAllAccountsInheritance(): Promise<void> {
  for (const account of store.accounts) {
    await syncAccountInheritance(account).catch((err) =>
      log.warn(`account-inherit: sync failed for ${account.label}`, err),
    );
  }
}
