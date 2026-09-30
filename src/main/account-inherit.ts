// Materialize selected pieces of the GLOBAL `~/.claude` config into a
// per-account login dir (the account's `CLAUDE_CONFIG_DIR`).
//
// Why: each account is an isolated config dir that, by default, contains only
// `.credentials.json`. An agent spawned as that account therefore loses the
// user's global settings, statusline, skills, MCP servers, and memory
// (CLAUDE.md and its @-imports). This module
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
import { sameDir } from './same-dir';
import { deselectedAccountIds, expandConfigDir, type Account, type AccountInherit } from '../shared/accounts';
import { parseClaudeMdImports } from '../shared/claude-md-imports';
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

/** The global `mcpServers` map, or null when `~/.claude.json` is missing/unreadable/torn ("unknown", never "none"). */
function readGlobalMcpServers(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(globalClaudeJson(), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
  } catch {
    return null;
  }
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
  /** The `~/.claude` these links were built from (#235/D10); absent in legacy manifests. */
  source?: string;
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
      source: typeof parsed.source === 'string' ? parsed.source : undefined,
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

/** True iff `p` is a readable directory — the inheritance SOURCE test (#235). */
function isReadableDir(p: string): boolean {
  try {
    fs.readdirSync(p);
    return true;
  } catch {
    return false;
  }
}

/** True iff `p` exists AND is a symlink (so we may safely manage/remove it). */
function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isInside(p: string, dir: string): boolean {
  if (pathWithin(p, dir)) return true;
  try {
    return pathWithin(fs.realpathSync(p), fs.realpathSync(dir));
  } catch {
    return false;
  }
}

/** True only for a DEFINITE absence (ENOENT/ENOTDIR, dangling links included) — EACCES/ELOOP are not "gone". */
function isGone(p: string): boolean {
  try {
    fs.statSync(p);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/** #235/D10: the OTHER, still-existing source this login dir's links were built from (manifest
 *  `source`; legacy manifest: a link resolving outside `globalDir`), else null. A source/target that
 *  no longer exists is no evidence — master re-homes those, so must we. */
function builtFromElsewhere(loginDir: string, globalDir: string, prev: InheritManifest): string | null {
  if (prev.source !== undefined) {
    return sameDir(prev.source, globalDir) || isGone(prev.source) ? null : prev.source;
  }
  for (const rel of prev.symlinks) {
    const linkPath = path.join(loginDir, rel);
    if (!isSymlink(linkPath)) continue;
    const target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    if (isGone(target) || isInside(target, globalDir)) continue;
    return target.endsWith(path.sep + rel) ? target.slice(0, -(rel.length + 1)) : path.dirname(target); // the source DIR
  }
  return null;
}

/** 'link' / 'other' (absent or a real file) / 'unknown' (lstat failed for a reason that is NOT a definite absence). */
function linkState(p: string): 'link' | 'other' | 'unknown' {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? 'link' : 'other';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'other' : 'unknown';
  }
}

/** #235 residual/C10: the inherited state in `loginDir` a full prune would destroy — manifest links still
 *  present as symlinks + manifest MCP keys still present in its `.claude.json`. Presence, not the manifest
 *  list alone, so a stale manifest over an already-clean dir does not block reconciling it. FAILS CLOSED:
 *  only a DEFINITE absence (ENOENT/ENOTDIR) is "not held"; a torn/unreadable `.claude.json` or an lstat
 *  error counts every manifest entry as held (review F4). */
function heldInherited(loginDir: string, prev: InheritManifest): { links: string[]; mcp: string[] } {
  const links = prev.symlinks.filter((rel) => linkState(path.join(loginDir, rel)) !== 'other');
  let mcp: string[] = [];
  if (prev.mcpServers.length > 0) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(loginDir, '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
      const have = d.mcpServers && typeof d.mcpServers === 'object' ? d.mcpServers : {};
      mcp = prev.mcpServers.filter((k) => k in have);
    } catch (err) {
      mcp = (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : prev.mcpServers;
    }
  }
  return { links, mcp };
}

/** True iff `ensureSymlink` would leave `loginDir/rel` a link after this sync: the source exists AND the slot is
 *  free, already a link, or replaceable. A user-owned real dir in the slot, or an lstat we cannot read, is not. */
function linkWouldBeLive(loginDir: string, rel: string, target: string, replaceReal: boolean): boolean {
  if (!fs.existsSync(target)) return false;
  try {
    return fs.lstatSync(path.join(loginDir, rel)).isSymbolicLink() || replaceReal;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
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

/** `x` is `dir` or inside it (both already resolved). */
function pathWithin(x: string, dir: string): boolean {
  const rel = path.relative(dir, x);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** #241: whose entry is `loginDir/rel`? 'source' = the slot IS one of the source's own entries — decided by IDENTITY
 *  (`sameDir`: path | realpath | dev+ino) of the slot's real parent and the source's dir of the same rel, so a source
 *  `skills/` folded outside `~/.claude` (stow/dotfiles), a bind-mounted `skills/` and an ANCESTOR login dir (`configDir=~`)
 *  are all recognised — or, failing that, the slot lands inside the real source but outside the real login dir (an alias
 *  onto ANY source dir). Unlinking/repointing it would destroy the source's own link. 'unknown' = the parent cannot be
 *  resolved (fail closed). 'ok' = the login dir's own slot (a child account inside the source and a not-yet-existing
 *  parent included). Only 'ok' slots may be created, rewritten or pruned. */
function slotOwner(loginDir: string, rel: string, globalDir: string, realGlobal: string, realLogin: string): 'ok' | 'source' | 'unknown' {
  let parent: string;
  try {
    parent = fs.realpathSync(path.dirname(path.join(loginDir, rel)));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'ok' : 'unknown';
  }
  if (sameDir(parent, path.join(globalDir, path.dirname(rel)))) return 'source';
  const slot = path.join(parent, path.basename(rel));
  return pathWithin(slot, realGlobal) && !pathWithin(slot, realLogin) ? 'source' : 'ok';
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

// ---- torn-safe login .claude.json write (#238) -----------------------------------
//
// The login `.claude.json` is rewritten by the account's live CLIs. Measured on claude 2.1.284 (inotify): each write is
// `mkdir <file>.lock` → tmp in the same dir → rename → `rmdir` — so THAT CLI never leaves a torn file, and the producer of
// the field tear is UNEXPLAINED (the old in-place `writeFileSync` in this very function is one candidate).
// Rule: an unreadable/unparseable file is NEVER rebuilt from `{}` (that erased trust + oauth state), and a write only
// replaces exactly the bytes we read (tmp + fresh re-read + compare + rename, all under the CLI's own `<file>.lock`).

/** Bytes + mtime read through ONE fd; `raw === null` = definitely absent (ENOENT/ENOTDIR). Any other error throws. */
interface FileView {
  raw: Buffer | null;
  mtimeNs: bigint;
  mode: number;
}

function viewFile(p: string): FileView {
  let fd: number;
  try {
    fd = fs.openSync(p, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { raw: null, mtimeNs: 0n, mode: 0 };
    throw err;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    return { raw: fs.readFileSync(fd), mtimeNs: st.mtimeNs, mode: Number(st.mode & 0o7777n) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Same bytes AND same mtime (a rewrite with identical bytes is still a writer at work → not "unchanged"). */
function sameView(a: FileView, b: FileView): boolean {
  if (a.raw === null || b.raw === null) return a.raw === b.raw;
  return a.mtimeNs === b.mtimeNs && a.raw.equals(b.raw);
}

/** The JSON object in `raw`, or null for anything else (torn/empty/non-JSON, or JSON that is not a plain object). */
function parseJsonObject(raw: Buffer): Record<string, unknown> | null {
  try {
    let text = raw.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // the CLI tolerates a UTF-8 BOM; JSON.parse does not
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Where to write for `p`: `p` itself, or the file a symlinked `p` resolves to (rename would otherwise replace the
 *  link). null = a dangling link — not ours to materialize. */
function resolveWriteTarget(p: string): string | null {
  let isLink: boolean;
  try {
    isLink = fs.lstatSync(p).isSymbolicLink();
  } catch {
    return p; // absent / unreadable: viewFile decides
  }
  if (!isLink) return p;
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

let tmpSeq = 0;

/** Replace `target` with `content` iff it is still exactly `seen`: write a tmp in the SAME dir (mode = the target's, 0600
 *  for a fresh file, set at creation), take the CLI's own `<target>.lock` (a directory; mkdir = acquire), re-read the
 *  target, then rename (fresh target: hard-link, so a file created meanwhile is not overwritten — on a filesystem
 *  without hard links it falls back to rename). 'stale' = it changed since `seen`; 'locked' = the lock exists (another
 *  writer, or a crashed CLI's leftover — we NEVER break a lock we did not create, so nothing is replaced until it is gone).
 *  Either way nothing is replaced and the next sync retries. Throws on I/O failure. Residual: a writer that does not
 *  honour the lock can still land between the re-read and the rename (sub-ms). */
function replaceIfUnchanged(target: string, seen: FileView, content: string): 'written' | 'stale' | 'locked' {
  const tmp = path.join(path.dirname(target), `.claude.json.orchestra-tmp-${process.pid}-${++tmpSeq}`);
  const lock = `${target}.lock`;
  let held = false;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: seen.raw === null ? 0o600 : seen.mode });
    if (seen.raw !== null) fs.chmodSync(tmp, seen.mode); // creation mode is masked by the umask; the target's own mode is exact
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.mkdirSync(lock);
      held = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'locked';
      throw err;
    }
    let fresh: FileView;
    try {
      fresh = viewFile(target);
    } catch {
      return 'stale'; // cannot re-read it now → do not replace what we cannot see
    }
    if (!sameView(seen, fresh)) return 'stale';
    if (seen.raw === null) {
      try {
        fs.linkSync(tmp, target);
        return 'written';
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'stale';
        /* filesystem without hard links → rename below */
      }
    }
    fs.renameSync(tmp, target);
    return 'written';
  } finally {
    if (held) {
      try {
        fs.rmdirSync(lock);
      } catch {
        /* best effort — it is ours */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already renamed away */
    }
  }
}

// ---- MCP merge ---------------------------------------------------------------

/** Merge the selected global mcpServers into the login dir's `.claude.json`,
 *  removing any we previously injected that are no longer selected. Preserves
 *  every other key in the file (project history, trust, the user's own servers).
 *  A file we cannot read or parse — or that changes while we work — is left
 *  byte-identical (one WARN, manifest unchanged, retried next sync; #238).
 *  Returns the keys that are now ours. */
function syncMcpServers(loginDir: string, desired: string[], prevKeys: string[]): string[] {
  // Read the global server definitions (null = missing/unreadable/torn → handled below).
  const globalMcp = readGlobalMcpServers();
  // #235: an unreadable source is "unknown", never "no servers" — remove nothing.
  if (globalMcp === null) {
    if (desired.length > 0 || prevKeys.length > 0) {
      log.warn(`account-inherit: ${globalClaudeJson()} is missing or unreadable — MCP servers left untouched for ${loginDir}`);
    }
    return prevKeys;
  }
  const want = desired.filter((k) => k in globalMcp);
  // A server can be selected in the Accounts UI yet no longer exist in the
  // global `~/.claude.json` (renamed, removed, or never defined there). Those
  // are dropped from `want` above — WARN rather than silently discard, since the
  // account then never gets that MCP server in any workspace (SDK view AND
  // terminal alike) with no other signal that it went missing.
  const dropped = desired.filter((k) => !(k in globalMcp));
  if (dropped.length > 0) {
    log.warn(
      `account-inherit: ${dropped.length} selected MCP server(s) not defined in the global config and were skipped for ${loginDir}: ${dropped.join(', ')}`,
    );
  }
  const toRemove = prevKeys.filter((k) => !want.includes(k));
  // Nothing to add and nothing to remove → don't even touch (or create) the file.
  if (want.length === 0 && toRemove.length === 0) return [];

  const claudeJsonPath = path.join(loginDir, '.claude.json');
  const target = resolveWriteTarget(claudeJsonPath);
  if (target === null) {
    log.warn(`account-inherit: ${claudeJsonPath} is a dangling symlink — MCP servers left untouched for ${loginDir}`);
    return prevKeys;
  }
  // #238: only a DEFINITE absence starts from {}; a torn/empty/non-object file or any other read error is
  // "unknown" — skip the write (fail closed), the next sync retries once the file is whole again.
  let seen: FileView;
  try {
    seen = viewFile(target);
  } catch (err) {
    log.warn(`account-inherit: cannot read ${claudeJsonPath} — MCP servers left untouched for ${loginDir}`, err);
    return prevKeys;
  }
  let data: Record<string, unknown> = {};
  if (seen.raw !== null) {
    const parsed = parseJsonObject(seen.raw);
    if (parsed === null) {
      log.warn(`account-inherit: ${claudeJsonPath} is empty or unparseable (torn read?) — MCP servers left untouched for ${loginDir}, retried next sync`);
      return prevKeys;
    }
    data = parsed;
  }
  const servers: Record<string, unknown> =
    data.mcpServers && typeof data.mcpServers === 'object'
      ? (data.mcpServers as Record<string, unknown>)
      : {};
  for (const k of toRemove) delete servers[k];
  for (const k of want) servers[k] = globalMcp[k];
  data.mcpServers = servers;
  const content = JSON.stringify(data, null, 2);
  // Already exactly what we would write → touch nothing (an idempotent per-spawn sync must not race a live CLI).
  if (seen.raw !== null && seen.raw.toString('utf8') === content) return want;
  try {
    const outcome = replaceIfUnchanged(target, seen, content);
    if (outcome === 'locked') {
      log.warn(`account-inherit: ${claudeJsonPath} is locked (${target}.lock exists — another writer, or a crashed CLI's leftover; never broken here) — MCP write skipped for ${loginDir}, retried next sync`);
      return prevKeys;
    }
    if (outcome === 'stale') {
      log.warn(`account-inherit: ${claudeJsonPath} changed while syncing — MCP write skipped for ${loginDir}, retried next sync`);
      return prevKeys;
    }
  } catch (err) {
    log.warn(`account-inherit: failed to write ${claudeJsonPath}`, err);
    return prevKeys; // leave manifest unchanged on failure
  }
  return want;
}

// ---- public sync -------------------------------------------------------------

/** Per-call context for {@link syncAccountInheritance}. */
export interface SyncOptions {
  /** #235 residual/C10: true ONLY when the Accounts UI setter just took THIS account's selection from
   *  non-empty to empty ({@link deselectedAccountIds}) — the sole authority to prune a dir to nothing.
   *  Never derive it from the account object itself (empty `inherit` is also what a bad store looks like). */
  userDeselected?: boolean;
  /** Who is syncing — named in the blocked-prune WARN so the writer of a stray empty sync is attributable. */
  caller?: string;
}

/** Materialize `account.inherit` into the account's login dir. Idempotent and
 *  non-destructive; safe to call before every agent spawn. No-ops for an account
 *  with no usable config dir. */
export async function syncAccountInheritance(account: Account, opts: SyncOptions = {}): Promise<void> {
  const loginDir = expandConfigDir(account.configDir, os.homedir(), process.env);
  if (!loginDir) return;
  const inherit = account.inherit;
  const globalDir = globalClaudeDir();
  // #235: a missing/unreadable source is "unknown", never "empty" — gates every destructive step below.
  if (!isReadableDir(globalDir)) {
    log.warn(`account-inherit: source ${globalDir} is missing or unreadable — sync skipped, ${loginDir} left untouched`);
    return;
  }

  // #235/D10: links built from ANOTHER source (a fake-HOME app vs a live config dir) are not ours to
  // rewrite — even a readable, skeletal source would repoint/strip them. No write at all.
  const prev = readManifest(loginDir);
  const from = builtFromElsewhere(loginDir, globalDir, prev);
  if (from !== null) {
    log.warn(`account-inherit: ${loginDir} was built from ${from}, not ${globalDir} — sync skipped (delete ${MANIFEST_NAME} there to re-home it)`);
    return;
  }

  // Build the desired symlink set (relative path -> {target, replaceReal}) — BEFORE the C10 guard, which
  // keys on what this sync would leave behind. Config FILES the user opted into replace a stale real
  // copy (with backup); skill DIRS never clobber a real dir (could be the user's own skill).
  const wantLinks = new Map<string, { target: string; replaceReal: boolean }>();
  if (inherit?.settings) {
    wantLinks.set('settings.json', { target: path.join(globalDir, 'settings.json'), replaceReal: true });
    // Global memory travels with settings: CLAUDE.md plus every file it
    // @-imports (RTK.md, LESSONS.md, …). Without these an alternate login runs
    // with no user instructions at all. replaceReal like settings.json — a
    // stale real copy must not shadow the global one (backed up once).
    wantLinks.set('CLAUDE.md', { target: path.join(globalDir, 'CLAUDE.md'), replaceReal: true });
    let importNames: string[] = [];
    try {
      importNames = parseClaudeMdImports(fs.readFileSync(path.join(globalDir, 'CLAUDE.md'), 'utf8'));
    } catch {
      /* no global CLAUDE.md → nothing to import */
    }
    for (const name of importNames) {
      wantLinks.set(name, { target: path.join(globalDir, name), replaceReal: true });
    }
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

  // #241: entries (wanted now, or listed in the manifest for pruning) whose slot is really one of the SOURCE's own —
  // never created, rewritten or pruned; not claimed in the manifest either. ONE warn per sync.
  const realOr = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const realGlobal = realOr(globalDir);
  const realLogin = realOr(loginDir);
  const untouchable = new Map<string, 'source' | 'unknown'>();
  for (const rel of new Set([...wantLinks.keys(), ...prev.symlinks])) {
    const owner = slotOwner(loginDir, rel, globalDir, realGlobal, realLogin);
    if (owner !== 'ok') untouchable.set(rel, owner);
  }
  if (untouchable.size > 0) {
    const n = untouchable.size;
    const dirs = [...new Set([...untouchable.keys()].map((r) => path.dirname(r)))].sort().join(', ');
    log.warn(
      `account-inherit: ${n} entr${n === 1 ? 'y' : 'ies'} of ${loginDir} (${dirs}) resolve${n === 1 ? 's' : ''} into the source ${globalDir} or cannot be resolved — left untouched (never pruned or rewritten)`,
    );
  }

  // #235 residual/C10: keyed on EFFECT, not selection shape. A sync that would leave NO inherited item
  // (empty selection, or one naming only missing sources / invalid names / slots holding a user's real dir)
  // over a dir that still holds inherited links / MCP servers is a full prune — only the UI setter's
  // per-account grant may do that (incident #3: a real-HOME sync with no selection stripped the live dir,
  // writer unattributed). Any other caller: no write at all + ONE WARN. A swap to other, existing items
  // still applies (it leaves something), so the UI's own edits are never blocked.
  // the source's links seen through an alias are not ours to count as "held" (C10 would block on them, the UI log would lie)
  const held = heldInherited(loginDir, { ...prev, symlinks: prev.symlinks.filter((rel) => !untouchable.has(rel)) });
  let uiPrune: { links: string[]; mcp: string[] } | null = null;
  if (held.links.length + held.mcp.length > 0) {
    const globalMcp = readGlobalMcpServers();
    const alive =
      [...wantLinks].filter(([rel, { target, replaceReal }]) => !untouchable.has(rel) && linkWouldBeLive(loginDir, rel, target, replaceReal)).length +
      // an unreadable MCP source keeps the held servers (syncMcpServers), so it never makes a full prune
      (globalMcp === null ? held.mcp.length : (inherit?.mcpServers ?? []).filter((k) => k in globalMcp).length);
    if (alive === 0) {
      if (!opts.userDeselected) {
        log.warn(
          `account-inherit: this sync would leave no inherited item (selection empty or naming only missing items) but ${loginDir} holds ${held.links.length} inherited link(s) + ${held.mcp.length} MCP server(s) — sync skipped, only the Accounts UI may de-select everything` +
            ` [caller=${opts.caller ?? 'unknown'} pid=${process.pid} HOME=${os.homedir()} ORCHESTRA_HOME=${process.env.ORCHESTRA_HOME ?? ''}]`,
        );
        return;
      }
      uiPrune = held; // logged AFTER the writes, with what was actually pruned (a skipped MCP write prunes 0)
    }
  }

  try {
    await fs.promises.mkdir(loginDir, { recursive: true });
  } catch (err) {
    log.warn(`account-inherit: cannot create login dir ${loginDir}`, err);
    return;
  }

  // Apply desired links; collect the ones actually present afterwards.
  const liveLinks: string[] = [];
  for (const [rel, { target, replaceReal }] of wantLinks) {
    if (untouchable.has(rel)) continue;
    if (ensureSymlink(loginDir, rel, target, replaceReal)) liveLinks.push(rel);
  }
  // Remove links we created before that are no longer desired.
  for (const rel of prev.symlinks) {
    if (!wantLinks.has(rel) && !untouchable.has(rel)) removeOurSymlink(loginDir, rel);
  }
  // A slot we merely could not resolve ('unknown', e.g. a transient ELOOP) may still hold OUR link: keep owning it, so the
  // next sync can prune it. A 'source' slot was never ours and is shed from the manifest.
  for (const rel of prev.symlinks) {
    if (untouchable.get(rel) === 'unknown' && !liveLinks.includes(rel)) liveLinks.push(rel);
  }

  // MCP servers (selective merge into the login dir's own .claude.json).
  const liveMcp = syncMcpServers(loginDir, inherit?.mcpServers ?? [], prev.mcpServers);

  writeManifest(loginDir, { source: globalDir, symlinks: liveLinks, mcpServers: liveMcp });
  if (uiPrune !== null) {
    const links = uiPrune.links.filter((rel) => linkState(path.join(loginDir, rel)) === 'other').length;
    const mcp = uiPrune.mcp.filter((k) => !liveMcp.includes(k)).length;
    log.info(`account-inherit: UI de-selection pruned ${links} link(s) + ${mcp} MCP server(s) from ${loginDir}`);
  }
}

/** Sync every configured account. Called after the accounts list changes so
 *  edits apply immediately (not just on the next agent spawn). `deselectedIds`
 *  (UI setter only) names the accounts allowed to prune to an empty selection. */
export async function syncAllAccountsInheritance(
  opts: { caller?: string; deselectedIds?: ReadonlySet<string> } = {},
): Promise<void> {
  for (const account of store.accounts) {
    await syncAccountInheritance(account, {
      caller: opts.caller,
      userDeselected: opts.deselectedIds?.has(account.id) === true,
    }).catch((err) => log.warn(`account-inherit: sync failed for ${account.label}`, err));
  }
}

/** The Accounts-UI setter's post-save step: `before` is `store.accounts` captured BEFORE the save,
 *  `saved` what the store persisted. Only accounts the user just took to an empty selection — on the SAME
 *  resolved config dir — may prune (a save that also repoints `configDir` is not a de-selection of THAT dir). */
export function syncAfterAccountsSave(before: readonly Account[], saved: readonly Account[]): Promise<void> {
  const same = (a: string, b: string): boolean => {
    const ra = expandConfigDir(a, os.homedir(), process.env);
    const rb = expandConfigDir(b, os.homedir(), process.env);
    return ra !== '' && rb !== '' && sameDir(ra, rb);
  };
  return syncAllAccountsInheritance({ caller: 'ui-save', deselectedIds: deselectedAccountIds(before, saved, same) });
}
