/**
 * Host side of "import to sandbox" — the one-way flow that makes a container
 * OWN a workspace's checkout (the central-sandbox model; see
 * docs/multi-machine-sandbox-remaining.md item A).
 *
 * Staging: `git bundle create --all` carries the full history; an overlay tar
 * carries what git doesn't — uncommitted modifications, untracked files, and
 * the gitignored .orchestra/.claude hook dirs the local worktree already has
 * installed. The payload is POSTed to the shim's /import route (plain HTTP on
 * the same port as the WS endpoint), which clones the bundle into /workspace,
 * checks out the branch, repoints origin, and lays the overlay on top.
 *
 * On success the LOCAL worktree is retired (git worktree remove) and the
 * workspace record flips to host:{kind:'sandbox',endpoint} — from then on
 * pty:start streams to the container instead of spawning locally, and the
 * prune/delete paths know there is nothing local to reap.
 */

import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, cp, stat, writeFile, rename, readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from './platform';
import { store } from './store';
import { stopPty } from './pty';
import { removeWorktree, detectRemoteUrl, createWorktree } from './git';
import { log } from './logger';
import { workspaceAccountConfigDir, installOrchestraHooks } from './workspaces';
import { syncAccountInheritance } from './account-inherit';
import { isScratchLike, type Workspace, type WorkspaceHost } from '../shared/types';
import {
  endpointToHttpUrl,
  parseZList,
  overlayPaths,
  HOOK_DIRS,
  CLAUDE_CONFIG_ENTRIES,
  IMPORT_SESSION_HEADER,
  type ImportMeta,
} from './transport/import-core';

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Build the import payload tarball for a workspace in a fresh temp dir.
 *  Returns the tgz path; caller owns cleanup of the returned stage dir. */
export async function stageImportPayload(
  ws: Workspace,
): Promise<{ stageDir: string; tgzPath: string }> {
  const stageDir = await mkdtemp(path.join(os.tmpdir(), 'orchestra-export-'));

  // Full history from the source repo — the worktree's branch lives there.
  await git(ws.repoPath, ['bundle', 'create', path.join(stageDir, 'repo.bundle'), '--all']);

  // Overlay: what the bundle can't carry. Untracked-but-not-ignored files,
  // uncommitted modifications, and the hook dirs (gitignored by design but
  // required in the container's /workspace for the agent's hooks to work).
  const untracked = parseZList(
    await git(ws.worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']),
  );
  const modified = parseZList(await git(ws.worktreePath, ['diff', '--name-only', '-z', 'HEAD']));
  const hookDirs = HOOK_DIRS.filter((d) => existsSync(path.join(ws.worktreePath, d)));
  const overlay = overlayPaths(untracked, modified, [...hookDirs]);

  const overlayRoot = path.join(stageDir, 'worktree');
  await mkdir(overlayRoot, { recursive: true });
  for (const rel of overlay) {
    const src = path.join(ws.worktreePath, rel);
    try {
      await stat(src); // an uncommitted *deletion* lists in diff but has no file
      const dest = path.join(overlayRoot, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await cp(src, dest, { recursive: true });
    } catch {
      /* skip unreadable/deleted entries — the bundle still has their history */
    }
  }

  // Claude login/config: the sandbox agent must run as the SAME account with
  // the user's MCP servers/settings/skills. Pack the workspace's effective
  // config — the pinned account's dir, or the default ~/.claude — into
  // claude-config/; the shim seeds the container's ~/.claude from it. For the
  // default login, `.claude.json` (user-scope MCP registry) lives NEXT TO
  // ~/.claude, not inside it, so it is sourced separately.
  const configDir = workspaceAccountConfigDir(ws, undefined) || path.join(os.homedir(), '.claude');
  const stateJson = ws.accountId
    ? path.join(configDir, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
  const configRoot = path.join(stageDir, 'claude-config');
  await mkdir(configRoot, { recursive: true });
  for (const entry of CLAUDE_CONFIG_ENTRIES) {
    const src = entry === '.claude.json' ? stateJson : path.join(configDir, entry);
    if (!existsSync(src)) continue;
    await cp(src, path.join(configRoot, entry), { recursive: true }).catch(() => {});
  }
  if (!existsSync(path.join(configRoot, '.credentials.json'))) {
    log.warn(
      `sandbox import: no .credentials.json found in ${configDir} — the sandbox agent will need credentials mounted or a manual login`,
    );
  }

  const meta: ImportMeta = {
    session: ws.id,
    branch: ws.branch,
    baseBranch: ws.baseBranch,
    ...(await detectRemoteUrl(ws.repoPath).then(
      (url) => (url ? { originUrl: url } : {}),
      () => ({}),
    )),
  };
  await writeFile(path.join(stageDir, 'meta.json'), JSON.stringify(meta));

  const tgzPath = path.join(stageDir, 'payload.tgz');
  await execFileP('tar', [
    '-czf',
    tgzPath,
    '-C',
    stageDir,
    'meta.json',
    'repo.bundle',
    'worktree',
    'claude-config',
  ]);
  return { stageDir, tgzPath };
}

/** POST a file to the shim's admin HTTP plane, streaming from disk (payloads
 *  are far past any sane in-memory size). Resolves with the parsed JSON body;
 *  rejects on transport errors or a non-ok reply. */
function postPayload(
  url: string,
  filePath: string,
  session: string,
): Promise<{ ok: boolean; [k: string]: unknown }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        // Lets a provisioned shim recognize a RETRY of this same import (our
        // copy of the success response was lost) and replay it instead of 409.
        [IMPORT_SESSION_HEADER]: session,
      },
    });
    req.on('error', (e) => reject(new Error(`sandbox unreachable: ${e.message}`)));
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let parsed: { ok?: boolean; error?: string };
        try {
          parsed = JSON.parse(body) as { ok?: boolean; error?: string };
        } catch {
          reject(new Error(`sandbox replied ${res.statusCode} with a non-JSON body`));
          return;
        }
        if (res.statusCode === 200 && parsed.ok) {
          resolve(parsed as { ok: boolean });
        } else {
          reject(new Error(parsed.error || `sandbox replied ${res.statusCode}`));
        }
      });
    });
    createReadStream(filePath)
      .on('error', (e) => {
        req.destroy();
        reject(e);
      })
      .pipe(req);
  });
}

/**
 * Import a local worktree workspace into an always-on sandbox and retire the
 * local copy. Throws with a user-presentable message on any failure BEFORE
 * anything local is touched — the local worktree is only removed after the
 * container has confirmed it owns the checkout.
 */
export async function importWorkspaceToSandbox(id: string, endpoint: string): Promise<Workspace> {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  if (isScratchLike(ws)) throw new Error('scratch sessions have no git checkout to import');
  if (ws.host?.kind === 'sandbox') throw new Error('workspace is already sandbox-hosted');
  if (!existsSync(ws.worktreePath)) throw new Error('local worktree is missing');
  const importUrl = endpointToHttpUrl(endpoint, '/import'); // validates the endpoint

  // Quiesce the worktree so the payload is a consistent snapshot (an agent
  // mid-edit during staging would tear the overlay).
  stopPty(id);
  stopPty(`${id}:run`);
  stopPty(`${id}:nvim`);

  // A pinned account inherits global config (skills/MCP) into its dir at
  // spawn time locally — materialize it now so the packed config is complete.
  if (ws.accountId) {
    const account = store.accounts.find((a) => a.id === ws.accountId);
    if (account) {
      await syncAccountInheritance(account).catch((err) =>
        log.warn(`sandbox import: account-inherit sync failed for ${id}`, err),
      );
    }
  }

  log.info(`importing workspace ${ws.branch} (${id}) to sandbox ${endpoint}`);
  const { stageDir, tgzPath } = await stageImportPayload(ws);
  try {
    await postPayload(importUrl, tgzPath, ws.id);
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }

  // The container owns the checkout now — retire the local copy. NOT deleted:
  // gitignored files that never ride the overlay (.env, local DBs, scratch
  // notes) would be destroyed. Move the whole dir to a trash folder instead,
  // then let git prune the dangling worktree registration. Best-effort: a
  // failure here leaves a husk but must not roll back the import (the sandbox
  // copy is already canonical).
  const trashDir = path.join(
    os.homedir(),
    '.orchestra',
    'trash',
    `${path.basename(ws.worktreePath)}-${Date.now()}`,
  );
  try {
    await mkdir(path.dirname(trashDir), { recursive: true });
    await rename(ws.worktreePath, trashDir);
    await execFileP('git', ['-C', ws.repoPath, 'worktree', 'prune']);
    log.info(`local worktree retired to trash: ${trashDir}`);
  } catch (e) {
    log.warn(`trash retire failed for ${id}, falling back to worktree remove: ${String(e)}`);
    try {
      await removeWorktree(ws.repoPath, ws.worktreePath);
    } catch (e2) {
      log.warn(`local worktree retire failed for ${id}: ${String(e2)}`);
    }
  }

  const host: WorkspaceHost = { kind: 'sandbox', endpoint };
  const updated: Workspace = {
    ...ws,
    host,
    status: 'idle',
    // The Claude conversation does NOT move (it lives in the host's ~/.claude,
    // keyed by the local cwd). First sandbox spawn starts a fresh session in
    // /workspace — so never ask the container to `--continue` a conversation
    // it doesn't have.
    hasInput: false,
    heavyResumePending: false,
  };
  await store.upsertWorkspace(updated);
  platform.broadcast('workspace:update', updated);
  log.info(`workspace ${ws.branch} (${id}) is now sandbox-hosted at ${endpoint}`);

  // First safety snapshot immediately: proves the container's /export works
  // for this workspace while the local trash copy still exists, so BOTH
  // recovery paths are live from minute one. Failure is loud in the logs but
  // must not fail the import (the sandbox is already canonical).
  try {
    await backupSandboxWorkspace(id);
  } catch (e) {
    log.warn(`sandbox import: initial backup failed for ${id}: ${String(e)}`);
  }
  return updated;
}

// ─── Backup + eject: the fail-safe half of the one-way import ───────────────
//
// After an import, the container holds the ONLY copy of unpushed work — the
// scariest property of the central-sandbox model. Two mitigations, both built
// on the shim's GET /export (the exact inverse payload of import):
//
//  * BACKUP — snapshot the container's bundle+overlay to
//    ~/.orchestra/backups/<wsid>/, right after import (which also proves the
//    export path works for this workspace) and periodically afterwards. A
//    dead sandbox costs at most one backup interval of work.
//  * EJECT — "return to this machine": restore the workspace to a local
//    worktree from a live export and flip the record back to local. Makes
//    the import reversible.

const BACKUP_ROOT = path.join(os.homedir(), '.orchestra', 'backups');
/** Snapshots kept per workspace (oldest pruned). */
const BACKUPS_KEPT = 5;
/** Periodic backup cadence. */
const BACKUP_INTERVAL_MS = (() => {
  const min = Number(process.env.ORCHESTRA_SANDBOX_BACKUP_MINUTES);
  return (Number.isFinite(min) && min > 0 ? min : 30) * 60_000;
})();

/** GET a URL to a file on disk. Rejects on transport error or non-200 (the
 *  error body is read for the message). */
function fetchToFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.request(url, { method: 'GET' });
    req.on('error', (e) => reject(new Error(`sandbox unreachable: ${e.message}`)));
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let msg = `sandbox replied ${res.statusCode}`;
          try {
            const parsed = JSON.parse(body) as { error?: string };
            if (parsed.error) msg = parsed.error;
          } catch {
            /* keep the status message */
          }
          reject(new Error(msg));
        });
        return;
      }
      const out = createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', reject);
      res.on('error', reject);
    });
    req.end();
  });
}

/** Snapshot a sandbox-hosted workspace's container state into the local
 *  backups dir. Returns the snapshot path. Throws when the workspace is not
 *  sandbox-hosted or the sandbox is unreachable. */
export async function backupSandboxWorkspace(id: string): Promise<string> {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  if (ws.host?.kind !== 'sandbox') throw new Error('workspace is not sandbox-hosted');
  const url = endpointToHttpUrl(ws.host.endpoint, '/export');

  const dir = path.join(BACKUP_ROOT, id);
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, `backup-${Date.now()}.tgz`);
  const partial = `${dest}.partial`;
  try {
    await fetchToFile(url, partial);
    await rename(partial, dest);
  } finally {
    await rm(partial, { force: true }).catch(() => {});
  }

  // Prune to the newest BACKUPS_KEPT (names sort chronologically by design).
  const entries = (await readdir(dir)).filter((n) => /^backup-\d+\.tgz$/.test(n)).sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - BACKUPS_KEPT))) {
    await rm(path.join(dir, stale), { force: true }).catch(() => {});
  }
  log.info(`sandbox backup for ${ws.branch} (${id}) → ${dest}`);
  return dest;
}

let backupTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic backup loop for every sandbox-hosted workspace. Runs
 *  for the app's lifetime; failures are logged, never fatal (an unreachable
 *  sandbox will be retried next tick). */
export function startSandboxAutoBackup(): void {
  if (backupTimer) return;
  backupTimer = setInterval(() => {
    void (async () => {
      for (const ws of store.workspaces) {
        if (ws.host?.kind !== 'sandbox' || ws.archived) continue;
        try {
          await backupSandboxWorkspace(ws.id);
        } catch (e) {
          log.warn(`sandbox auto-backup failed for ${ws.id}: ${String(e)}`);
        }
      }
    })();
  }, BACKUP_INTERVAL_MS);
  if (typeof backupTimer.unref === 'function') backupTimer.unref();
}

/**
 * Eject: restore a sandbox-hosted workspace to a LOCAL worktree from a live
 * export, then flip the record back to local. The container's copy is left
 * in place (it doubles as one more backup) but its agent session is stopped;
 * the sandbox can host another import only after being reprovisioned.
 *
 * Restores to the ORIGINAL worktreePath when free — Claude keys conversation
 * history by cwd, so the pre-import local conversation becomes resumable
 * again.
 */
export async function ejectWorkspaceFromSandbox(id: string): Promise<Workspace> {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  if (ws.host?.kind !== 'sandbox') throw new Error('workspace is not sandbox-hosted');
  const exportUrl = endpointToHttpUrl(ws.host.endpoint, '/export');

  // Quiesce the remote session first — a mid-turn agent would tear the export.
  stopPty(id);
  stopPty(`${id}:run`);
  stopPty(`${id}:nvim`);

  log.info(`ejecting workspace ${ws.branch} (${id}) from sandbox ${ws.host.endpoint}`);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'orchestra-eject-'));
  try {
    const tgz = path.join(tmp, 'export.tgz');
    await fetchToFile(exportUrl, tgz);
    // The export doubles as a final safety snapshot before we touch anything.
    const snapDir = path.join(BACKUP_ROOT, id);
    await mkdir(snapDir, { recursive: true });
    await cp(tgz, path.join(snapDir, `backup-${Date.now()}.tgz`)).catch(() => {});

    await execFileP('tar', ['-xzf', tgz, '-C', tmp]);
    const bundle = path.join(tmp, 'repo.bundle');
    if (!existsSync(bundle)) throw new Error('export payload missing repo.bundle');
    let meta: { branch?: string; head?: string } = {};
    try {
      meta = JSON.parse(await readFile(path.join(tmp, 'meta.json'), 'utf8')) as {
        branch?: string;
        head?: string;
      };
    } catch {
      /* meta is advisory; fall back to the record's branch */
    }
    const branch = meta.branch && !meta.branch.startsWith('-') ? meta.branch : ws.branch;

    // The container's history is canonical — force the local branch to it.
    // The branch is not checked out anywhere locally (the worktree was
    // retired at import), so a forced ref update is safe.
    await execFileP('git', ['-C', ws.repoPath, 'fetch', bundle, `+${branch}:${branch}`]);

    // Recreate the worktree — at the original path when free (conversation
    // continuity), else alongside it.
    let worktreePath = ws.worktreePath;
    if (existsSync(worktreePath)) worktreePath = `${ws.worktreePath}-restored-${Date.now()}`;
    await createWorktree(ws.repoPath, branch, ws.baseBranch, worktreePath);

    // Overlay: uncommitted changes + hook dirs from the container.
    const overlay = path.join(tmp, 'worktree');
    if (existsSync(overlay)) {
      await execFileP('cp', ['-a', `${overlay}/.`, `${worktreePath}/`]);
    }
    await installOrchestraHooks(worktreePath);

    const updated: Workspace = {
      ...ws,
      host: undefined,
      worktreePath,
      branch,
      status: 'idle',
      // The container's conversation stays in the container; the LOCAL
      // conversation (keyed by the original cwd) is resumable again only when
      // the original path was reused, so let the next spawn decide from disk
      // rather than promising a resume.
      hasInput: false,
      heavyResumePending: false,
    };
    await store.upsertWorkspace(updated);
    platform.broadcast('workspace:update', updated);
    log.info(`workspace ${branch} (${id}) restored to local at ${worktreePath}`);
    return updated;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
