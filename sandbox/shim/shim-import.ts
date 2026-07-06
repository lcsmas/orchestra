/**
 * Sandbox-side provisioning: the one-way "import to sandbox" flow.
 *
 * The host POSTs a gzipped tar to /import containing everything needed to make
 * the container OWN the checkout (the central-sandbox model — the work moves in
 * once and never syncs back out):
 *
 *   meta.json     { session, branch, baseBranch?, originUrl? }
 *   repo.bundle   `git bundle create --all` of the host repo (full history)
 *   worktree/     overlay of files git doesn't carry: uncommitted changes,
 *                 untracked files, and the .orchestra/.claude hook dirs the
 *                 host installed into its local worktree
 *
 * We clone the bundle into the (empty) workspace dir, check out the branch,
 * repoint origin at the real remote (the bundle path would dangle), then lay
 * the overlay on top. After this the shim's normal `spawn` path finds a live
 * checkout with hooks at /workspace, exactly like the local case.
 *
 * Everything is deliberately transactional-ish: a failed import wipes the
 * workspace dir back to empty so the host can retry; a second import (or one
 * racing another) is refused with 409 — one container owns ONE workspace.
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

/** Run one import from an already-received payload tarball. Throws on any
 *  failure after wiping the workspace dir back to empty (retryable). */
export async function runImport(tgzPath: string, workspaceDir: string): Promise<{ head: string; branch: string }> {
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

      const head = await run('git', ['rev-parse', 'HEAD'], workspaceDir);
      return { head, branch: meta.branch };
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

/** Default cap on the import payload — a repo bundle plus overlay; imports
 *  bigger than this are almost certainly a mistake (node_modules in the
 *  overlay, …) and would fill the container disk. */
const DEFAULT_MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export interface ImportHandlerOptions {
  workspaceDir: string;
  maxBytes?: number;
  log?: (...args: unknown[]) => void;
}

/**
 * Build the POST /import HTTP handler. Streams the request body to a temp
 * file (payloads exceed any sane in-memory cap), then runs the import.
 * Responses: 200 {ok:true,head,branch} | 400 bad payload | 409 already
 * provisioned or import in flight | 413 too large | 500 provisioning failed.
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
          const result = await runImport(tgzPath, opts.workspaceDir);
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
