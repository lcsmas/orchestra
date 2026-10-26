// Copy the pinned Node shipped in the package (`resources/pinned-node/`, #390) OUT of the install dir into a versioned directory under
// `<ORCHESTRA_HOME>/bin/` — the same reason keeper.js is copied out: a detached keeper must not depend on the AppImage mount.
// A dir name carries the version + binary hash and is only ever created by an atomic rename of a fully copied, re-hashed tree, so
// (1) a running keeper's binary is never written to, (2) an interrupted copy is never mistaken for a runtime, (3) an update that
// ships a new Node lands in a NEW dir while keepers launched earlier keep the old one.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseRuntimeManifest, runtimeDirName, type RuntimeManifest } from '../shared/keeper-runtime.ts';

export type InstallRuntimeResult =
  | { ok: true; path: string; manifest: RuntimeManifest; copied: boolean }
  /** No pinned Node in this package (dev run, mac/win): not an error — the launcher falls through to the next runtime. */
  | { ok: false; absent: true }
  | { ok: false; absent?: false; reason: string };

const STALE_TMP_MS = 10 * 60_000;

function sha256File(file: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** Can THIS process execute `file` (access(2) X_OK honours a `noexec` mount, which the mode bits do not)? */
function canExecHere(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** An installed runtime is usable when the binary is a regular executable file of the manifest's size. */
function usable(dest: string, manifest: RuntimeManifest): boolean {
  try {
    const st = fs.statSync(dest);
    return st.isFile() && st.size === manifest.nodeBytes && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Remove the leftovers of an install that died mid-copy (hidden `.node-*.tmp-*` dirs older than 10 min) — never a versioned dir. */
function sweepStaleTmp(binDir: string): void {
  try {
    for (const name of fs.readdirSync(binDir)) {
      if (!/^\.node-.*\.(tmp|old)-/.test(name)) continue;
      const p = path.join(binDir, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > STALE_TMP_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* raced with its owner */
      }
    }
  } catch {
    /* no bin dir yet */
  }
}

/** What THIS process has established about an installed runtime (path → null = content-verified, executable, runs; string = why it is refused). One entry per runtime per app run:
 *  the hash (~75 ms warm for 122 MB) and the probe (~50 ms) are paid once at startup, never per keeper launch (pre-review #390 F2). */
export interface RuntimeTrust {
  checked: Map<string, string | null>;
}
export function createRuntimeTrust(): RuntimeTrust {
  return { checked: new Map() };
}

/** The default probe — `node -p 1`: the runtime must EXECUTE. An exec bit and a matching hash prove neither (a missing loader/libstdc++, an LSM deny or rot passes both), and a picked
 *  runtime that cannot run fails EVERY session start where the pre-bundle launcher always ran. Null = fine, else the reason. */
/** A probe reason starting with this is a TRANSIENT failure (timeout, fork/memory pressure, killed by a signal): it is reported but NOT remembered, so the next launch asks again instead of a bad minute
 *  downgrading every keeper of the app run to the AppImage-mount binary (pre-review -fu m2). Deterministic refusals (ENOENT interpreter, loader error, wrong answer, noexec) are remembered. */
export const TRANSIENT_PREFIX = 'transient: ';
const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE', 'EINTR']);

function runProbe(file: string): string | null {
  try {
    const out = execFileSync(file, ['-p', '1'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } }).trim();
    return out === '1' ? null : `printed ${JSON.stringify(out.slice(0, 40))}, expected "1"`;
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string; code?: string; signal?: string | null };
    const why = String(err.stderr || err.message || 'failed').trim().split('\n')[0].slice(0, 160);
    return (err.code && TRANSIENT_CODES.has(err.code)) || err.signal ? `${TRANSIENT_PREFIX}${why}` : why;
  }
}

/** Does the file at `dest` hash to the manifest's `nodeSha256`? (size alone is not content: a same-size corrupted/planted binary passes `usable`.) */
function contentGood(dest: string, manifest: RuntimeManifest): boolean {
  try {
    return sha256File(dest) === manifest.nodeSha256;
  } catch {
    return false;
  }
}

export interface InstallOptions {
  resourcesDir: string | undefined;
  binDir: string;
  arch?: string;
  /** Seam for a `noexec` `bin/` (default: access(2) X_OK) — a runtime that cannot run there is REFUSED so the launcher falls through (pre-review #390 M1). */
  canExec?: (file: string) => boolean;
  /** Seam for "can it run": null = yes, else the reason (default: `node -p 1`, see runProbe). */
  probe?: (file: string) => string | null;
  /** The caller's per-process memory of what it already verified (see RuntimeTrust). Absent = verify (hash + exec + probe) on every call. */
  trust?: RuntimeTrust;
  /** TEST SEAM: runs right before the swap into place, after our copy is verified — where a concurrent instance can win the race (F1). */
  beforeSwap?: () => void;
}

export function installBundledRuntime(o: InstallOptions): InstallRuntimeResult {
  const canExec = o.canExec ?? canExecHere;
  const probe = o.probe ?? runProbe;
  /** Final gate for a runtime that is on disk and content-verified: executable HERE, and it RUNS. Cached per process when the caller gave a `trust`. */
  const finish = (dest: string, manifest: RuntimeManifest, copied: boolean): InstallRuntimeResult => {
    let reason = o.trust?.checked.get(dest);
    if (reason === undefined) {
      let transient = false;
      if (!canExec(dest)) reason = `the installed runtime ${dest} is not executable here (a noexec mount?)`;
      else {
        const p = probe(dest);
        transient = p !== null && p.startsWith(TRANSIENT_PREFIX);
        reason = p === null ? null : `the installed runtime ${dest} does not run (${p})`;
      }
      if (!transient) o.trust?.checked.set(dest, reason);
    }
    return reason === null ? { ok: true, path: dest, manifest, copied } : { ok: false, reason: `${reason} — falling back to another runtime` };
  };
  if (!o.resourcesDir) return { ok: false, absent: true };
  const srcDir = path.join(o.resourcesDir, 'pinned-node');
  const srcManifest = path.join(srcDir, 'manifest.json');
  if (!fs.existsSync(srcManifest)) return { ok: false, absent: true };
  try {
    const parsed = parseRuntimeManifest(fs.readFileSync(srcManifest, 'utf8'));
    if (!parsed.ok) return { ok: false, reason: `bundled runtime manifest is invalid (${parsed.reason})` };
    const manifest = parsed.manifest;
    const arch = o.arch ?? process.arch;
    if (manifest.arch !== arch) return { ok: false, reason: `bundled runtime is ${manifest.arch}, this process is ${arch}` };
    const src = path.join(srcDir, 'node');
    const destDir = path.join(o.binDir, runtimeDirName(manifest));
    const dest = path.join(destDir, 'node');
    // Fast path: right size + mode, and this process has either verified the content already or does so now (a same-size corrupted/planted binary is HEALED below, not trusted — F2).
    if (usable(dest, manifest) && (o.trust?.checked.has(dest) || contentGood(dest, manifest))) return finish(dest, manifest, false);

    fs.mkdirSync(o.binDir, { recursive: true });
    sweepStaleTmp(o.binDir);
    const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const tmpDir = path.join(o.binDir, `.${runtimeDirName(manifest)}.tmp-${tag}`);
    try {
      fs.mkdirSync(tmpDir);
      fs.copyFileSync(src, path.join(tmpDir, 'node'));
      fs.chmodSync(path.join(tmpDir, 'node'), 0o755);
      const got = sha256File(path.join(tmpDir, 'node'));
      if (got !== manifest.nodeSha256) return { ok: false, reason: `the bundled node does not hash to its manifest (got ${got.slice(0, 12)}…, expected ${manifest.nodeSha256.slice(0, 12)}…) — refusing to install it` };
      o.beforeSwap?.();
      o.trust?.checked.delete(dest); // we are about to (maybe) replace what this process may have vouched for
      // F1: the swap is ONE atomic rename that succeeds only when no dir of that name exists. A loser of a race gets ENOTEMPTY and finds the winner's GOOD dir → leaves it alone: renaming a
      // good dir aside (even for µs) makes the runtime vanish under a keeper that is launching from it. Only a dir that is demonstrably corrupt/partial is moved aside.
      try {
        fs.renameSync(tmpDir, destDir);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e;
        if (usable(dest, manifest) && contentGood(dest, manifest)) return finish(dest, manifest, false); // another instance won the race
        // A corrupt/partial dir of this exact name: replace the FILE by an atomic rename of our verified copy over it. The dir is never moved aside or absent — two healers, or a healer and a
        // keeper that is launching, can never observe the runtime missing (pre-review -fu M1) — and a running keeper keeps the old inode.
        fs.renameSync(path.join(tmpDir, 'node'), dest);
      }
      return finish(dest, manifest, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
