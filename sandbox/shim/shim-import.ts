/**
 * Sandbox-side provisioning: the one-way "import to sandbox" flow.
 *
 * The host POSTs a gzipped tar to /import containing everything needed to make
 * the container OWN the checkout (the central-sandbox model — the work moves in
 * once and never syncs back out):
 *
 *   meta.json      { session, branch, baseBranch?, originUrl? }
 *   repo.bundle    `git bundle create --all` of the host repo (full history)
 *   worktree/      overlay of files git doesn't carry: uncommitted changes,
 *                  untracked files, and the .orchestra/.claude hook dirs the
 *                  host installed into its local worktree
 *   claude-config/ (optional) the workspace's effective Claude login/config —
 *                  .credentials.json, .claude.json (MCP servers), settings,
 *                  CLAUDE.md, skills/agents/commands — packed from the pinned
 *                  account's config dir (or ~/.claude) on the host
 *
 * We clone the bundle into the (empty) workspace dir, check out the branch,
 * repoint origin at the real remote (the bundle path would dangle), lay the
 * overlay on top, and seed the container's ~/.claude from claude-config/ so
 * the agent runs as the RIGHT account with the user's MCP/settings. Claude
 * Code refreshes OAuth tokens in place, so the one-time seed stays valid.
 * After this the shim's normal `spawn` path finds a live checkout with hooks
 * at /workspace, exactly like the local case.
 *
 * Everything is deliberately transactional-ish: a failed import wipes the
 * workspace dir back to empty so the host can retry; a second import for a
 * DIFFERENT workspace is refused with 409 (one container owns ONE workspace),
 * while a retry of the SAME workspace — the lost-response case — replays the
 * recorded success from the meta state file instead of wedging on 409.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

/** Import request metadata, the meta.json entry of the payload tar. */
export interface ImportMeta {
  /** Workspace id — informational (logs), the shim is single-workspace. */
  session: string;
  /** Branch to check out from the bundle. Required. */
  branch: string;
  /** Base branch, kept for future PR-diff use. */
  baseBranch?: string;
  /** Real origin URL to repoint the clone at (bundle path would dangle). */
  originUrl?: string;
}

/** Validate a parsed meta.json. Returns an error string or null when valid.
 *  Pure — unit-testable without any I/O. */
export function validateImportMeta(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return 'meta.json is not an object';
  const m = meta as Record<string, unknown>;
  if (typeof m.session !== 'string' || !m.session) return 'meta.session missing';
  if (typeof m.branch !== 'string' || !m.branch) return 'meta.branch missing';
  // Refuse names git would parse as options; everything is also passed after
  // `--` or as a ref, but belt-and-braces for a value that came off the wire.
  if (m.branch.startsWith('-')) return 'meta.branch invalid';
  if (m.originUrl !== undefined && typeof m.originUrl !== 'string') return 'meta.originUrl invalid';
  if (m.baseBranch !== undefined && typeof m.baseBranch !== 'string') return 'meta.baseBranch invalid';
  return null;
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

/** True when the workspace dir already holds a checkout (provisioned). */
export function isProvisioned(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, '.git'));
}

/** Empty a directory without removing it (the dir itself may be a mount /
 *  image-owned path we must not recreate with wrong ownership). */
function emptyDir(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

/** What a completed import recorded, persisted to the state file so a retry
 *  of the same workspace (lost HTTP response) can replay success. */
export interface ImportRecord {
  session: string;
  branch: string;
  head: string;
}

/** Read the recorded import, or null when none/unreadable. */
export function readImportRecord(metaPath: string): ImportRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ImportRecord;
    return typeof rec.session === 'string' && typeof rec.head === 'string' ? rec : null;
  } catch {
    return null;
  }
}

export interface RunImportOptions {
  /** Where claude-config/ is installed (~/.claude's parent). Default: homedir. */
  claudeHome?: string;
  /** Where the success record is persisted for idempotent retries. */
  metaPath?: string;
  log?: (...args: unknown[]) => void;
}

/** Seed the agent's Claude login/config from the payload's claude-config/
 *  entry: everything lands in <home>/.claude, and .claude.json (the state
 *  file carrying user-scope MCP servers) ALSO lands at <home>/.claude.json —
 *  the container runs claude with no CLAUDE_CONFIG_DIR, so both default
 *  locations must be right. Copies per top-level entry, each best-effort: a
 *  file the operator chose to bind-mount read-only (e.g. the legacy
 *  .credentials.json mount) must not abort the whole import — the mount
 *  simply wins over the payload copy. Never touches anything else already in
 *  ~/.claude. */
async function installClaudeConfig(
  srcDir: string,
  home: string,
  log: (...args: unknown[]) => void = () => {},
): Promise<void> {
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    try {
      // -T: dest is the exact target path, so a re-seed overwrites
      // ~/.claude/skills instead of nesting a second skills/ inside it.
      await run('cp', ['-aT', path.join(srcDir, entry), path.join(claudeDir, entry)]);
    } catch (e) {
      log(`claude-config: skipped ${entry}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const stateJson = path.join(claudeDir, '.claude.json');
  if (fs.existsSync(stateJson)) {
    try {
      fs.copyFileSync(stateJson, path.join(home, '.claude.json'));
    } catch {
      /* read-only mount wins */
    }
  }
  // Credentials are secrets — clamp to owner-only regardless of tar modes.
  const creds = path.join(claudeDir, '.credentials.json');
  try {
    if (fs.existsSync(creds)) fs.chmodSync(creds, 0o600);
  } catch {
    /* read-only mount — mode is the mount's concern */
  }
}

/** Run one import from an already-received payload tarball. Throws on any
 *  failure after wiping the workspace dir back to empty (retryable). */
export async function runImport(
  tgzPath: string,
  workspaceDir: string,
  opts: RunImportOptions = {},
): Promise<ImportRecord> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-import-'));
  try {
    await run('tar', ['-xzf', tgzPath, '-C', tmp]);

    let meta: ImportMeta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(tmp, 'meta.json'), 'utf8')) as ImportMeta;
    } catch {
      throw new Error('payload missing meta.json');
    }
    const metaErr = validateImportMeta(meta);
    if (metaErr) throw new Error(metaErr);

    const bundle = path.join(tmp, 'repo.bundle');
    if (!fs.existsSync(bundle)) throw new Error('payload missing repo.bundle');

    fs.mkdirSync(workspaceDir, { recursive: true });
    try {
      // Clone every ref from the bundle without touching the working tree yet
      // (a bundle's HEAD may be unborn/absent; --no-checkout sidesteps that),
      // then materialize the imported branch from its remote-tracking ref.
      await run('git', ['clone', '--no-checkout', bundle, workspaceDir]);
      await run('git', ['checkout', '-B', meta.branch, `origin/${meta.branch}`], workspaceDir);

      // origin currently points at the bundle temp path — repoint it at the
      // real remote so the agent can fetch/push (creds come from the container
      // env per docs/sandbox-env-contract.md), or drop it if there isn't one.
      if (meta.originUrl) {
        await run('git', ['remote', 'set-url', 'origin', meta.originUrl], workspaceDir);
      } else {
        await run('git', ['remote', 'remove', 'origin'], workspaceDir);
      }

      // Overlay: uncommitted/untracked files + the .orchestra/.claude hook dirs.
      // cp -a keeps modes; trailing /. copies contents (incl. dotfiles) onto the
      // checkout, overwriting tracked files the host had modified.
      const overlay = path.join(tmp, 'worktree');
      if (fs.existsSync(overlay)) {
        await run('cp', ['-a', `${overlay}/.`, `${workspaceDir}/`]);
      }

      // Seed the agent's login/config (account credentials, MCP servers,
      // settings, skills) so the sandbox agent runs as the same account the
      // workspace used on the host.
      const claudeConfig = path.join(tmp, 'claude-config');
      if (fs.existsSync(claudeConfig)) {
        await installClaudeConfig(claudeConfig, opts.claudeHome ?? os.homedir(), opts.log);
      }

      const head = await run('git', ['rev-parse', 'HEAD'], workspaceDir);
      const record: ImportRecord = { session: meta.session, branch: meta.branch, head };
      if (opts.metaPath) {
        try {
          fs.mkdirSync(path.dirname(opts.metaPath), { recursive: true });
          fs.writeFileSync(opts.metaPath, JSON.stringify(record));
        } catch {
          /* best-effort — without it a lost-response retry 409s, nothing worse */
        }
      }
      return record;
    } catch (e) {
      // Leave the dir empty so a corrected retry starts clean.
      try {
        emptyDir(workspaceDir);
      } catch {
        /* best-effort */
      }
      throw e;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── Export (backup / eject) — the exact inverse of import ──────────────────
//
// GET /export streams a tgz of everything needed to reconstruct the workspace
// elsewhere: repo.bundle (full history of the container clone) + worktree/
// overlay (uncommitted modifications, untracked files, hook dirs) + meta.json
// {session, branch, head}. The host uses it for periodic BACKUPS (the
// container being the only copy of unpushed work is the scariest property of
// the central-sandbox model) and for EJECT (restore the workspace to a local
// worktree). Same payload grammar as import, so the two flows mirror.

const EXPORT_HOOK_DIRS = ['.orchestra', '.claude'];

/** Stage an export tgz for the provisioned workspace. Returns the tgz path;
 *  the caller removes its containing temp dir when done. */
export async function runExport(
  workspaceDir: string,
  metaPath?: string,
): Promise<{ tmpDir: string; tgzPath: string }> {
  if (!isProvisioned(workspaceDir)) throw new Error('workspace not provisioned');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-export-'));
  const stage = path.join(tmpDir, 'stage');
  const overlayRoot = path.join(stage, 'worktree');
  fs.mkdirSync(overlayRoot, { recursive: true });

  await run('git', ['bundle', 'create', path.join(stage, 'repo.bundle'), '--all'], workspaceDir);

  const listZ = async (args: string[]): Promise<string[]> =>
    (await run('git', args, workspaceDir)).split('\0').filter((p) => p.length > 0);
  const untracked = await listZ(['ls-files', '--others', '--exclude-standard', '-z']);
  const modified = await listZ(['diff', '--name-only', '-z', 'HEAD']);
  const hookDirs = EXPORT_HOOK_DIRS.filter((d) => fs.existsSync(path.join(workspaceDir, d)));
  const seen = new Set<string>();
  for (const rel of [...untracked, ...modified, ...hookDirs]) {
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const src = path.join(workspaceDir, rel);
    try {
      fs.statSync(src); // uncommitted deletions list in diff but have no file
      const dest = path.join(overlayRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    } catch {
      /* skip unreadable/deleted entries */
    }
  }

  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], workspaceDir);
  const head = await run('git', ['rev-parse', 'HEAD'], workspaceDir);
  const record = metaPath ? readImportRecord(metaPath) : null;
  fs.writeFileSync(
    path.join(stage, 'meta.json'),
    JSON.stringify({ session: record?.session ?? 'unknown', branch, head }),
  );

  const tgzPath = path.join(tmpDir, 'export.tgz');
  await run('tar', ['-czf', tgzPath, '-C', stage, 'meta.json', 'repo.bundle', 'worktree']);
  return { tmpDir, tgzPath };
}

/** Build the GET /export handler: stage the tgz and stream it out. */
export function createExportHandler(opts: {
  workspaceDir: string;
  metaPath?: string;
  log?: (...args: unknown[]) => void;
}) {
  const log = opts.log ?? (() => {});
  return (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    void (async () => {
      let tmpDir: string | null = null;
      try {
        const staged = await runExport(opts.workspaceDir, opts.metaPath);
        tmpDir = staged.tmpDir;
        const size = fs.statSync(staged.tgzPath).size;
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': size });
        const stream = fs.createReadStream(staged.tgzPath);
        stream.pipe(res);
        await new Promise<void>((resolve) => {
          stream.on('close', () => resolve());
          stream.on('error', () => resolve());
        });
        log(`exported workspace (${size} bytes)`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('export failed:', msg);
        if (!res.headersSent) {
          res.writeHead(msg.includes('not provisioned') ? 404 : 500, {
            'Content-Type': 'application/json',
          });
          res.end(JSON.stringify({ ok: false, error: msg }));
        } else {
          res.destroy();
        }
      } finally {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    })();
  };
}

/** Default cap on the import payload — a repo bundle plus overlay; imports
 *  bigger than this are almost certainly a mistake (node_modules in the
 *  overlay, …) and would fill the container disk. */
const DEFAULT_MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export interface ImportHandlerOptions {
  workspaceDir: string;
  /** Home dir the claude-config payload entry seeds (~/.claude). */
  claudeHome?: string;
  /** State file recording the last successful import, for idempotent retries. */
  metaPath?: string;
  maxBytes?: number;
  log?: (...args: unknown[]) => void;
}

/** Header the host stamps its workspace id on, letting a provisioned shim
 *  recognize a RETRY of the same import (lost HTTP response) vs. a rival. */
export const IMPORT_SESSION_HEADER = 'x-orchestra-session';

/**
 * Build the POST /import HTTP handler. Streams the request body to a temp
 * file (payloads exceed any sane in-memory cap), then runs the import.
 * Responses: 200 {ok:true,head,branch} (incl. an idempotent replay with
 * alreadyProvisioned:true) | 400 bad payload | 409 already provisioned for a
 * DIFFERENT workspace or import in flight | 413 too large | 500 failed.
 */
export function createImportHandler(opts: ImportHandlerOptions) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_IMPORT_BYTES;
  const log = opts.log ?? (() => {});
  let importing = false;

  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const sendJson = (code: number, obj: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (importing) {
      sendJson(409, { ok: false, error: 'import already in progress' });
      return;
    }
    if (isProvisioned(opts.workspaceDir)) {
      // Idempotency: a retry of the SAME workspace (the success response was
      // lost on the wire) replays the recorded result instead of wedging the
      // host on 409. Anything else really is a rival import — refuse.
      const requested = req.headers[IMPORT_SESSION_HEADER];
      const record = opts.metaPath ? readImportRecord(opts.metaPath) : null;
      if (record && typeof requested === 'string' && requested === record.session) {
        log(`import retry for session=${record.session} — replaying recorded success`);
        req.resume(); // drain the (discarded) payload so the socket closes cleanly
        req.on('end', () => sendJson(200, { ok: true, alreadyProvisioned: true, ...record }));
        return;
      }
      sendJson(409, { ok: false, error: 'workspace already provisioned' });
      return;
    }
    importing = true;

    const tgzPath = path.join(
      os.tmpdir(),
      `orchestra-import-${process.pid}-${Date.now()}.tgz`,
    );
    const out = fs.createWriteStream(tgzPath);
    let received = 0;
    let aborted = false;

    const finish = (code: number, obj: unknown): void => {
      importing = false;
      fs.rm(tgzPath, { force: true }, () => {});
      sendJson(code, obj);
    };

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      received += chunk.length;
      if (received > maxBytes) {
        aborted = true;
        out.destroy();
        req.destroy();
        finish(413, { ok: false, error: `payload exceeds ${maxBytes} bytes` });
      }
    });
    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      out.destroy();
      finish(400, { ok: false, error: 'request stream error' });
    });
    req.pipe(out);

    out.on('finish', () => {
      if (aborted) return;
      void (async () => {
        try {
          const result = await runImport(tgzPath, opts.workspaceDir, {
            claudeHome: opts.claudeHome,
            metaPath: opts.metaPath,
            log,
          });
          log(`imported branch=${result.branch} head=${result.head}`);
          finish(200, { ok: true, ...result });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log('import failed:', msg);
          const bad = /missing|invalid|is not an object/.test(msg);
          finish(bad ? 400 : 500, { ok: false, error: msg });
        }
      })();
    });
    out.on('error', () => {
      if (aborted) return;
      aborted = true;
      finish(500, { ok: false, error: 'failed to buffer payload' });
    });
  };
}
