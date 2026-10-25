// Copy the pinned Node shipped in the package (`resources/pinned-node/`, #390) OUT of the install dir into a versioned directory under
// `<ORCHESTRA_HOME>/bin/` — the same reason keeper.js is copied out: a detached keeper must not depend on the AppImage mount.
// A dir name carries the version + binary hash and is only ever created by an atomic rename of a fully copied, re-hashed tree, so
// (1) a running keeper's binary is never written to, (2) an interrupted copy is never mistaken for a runtime, (3) an update that
// ships a new Node lands in a NEW dir while keepers launched earlier keep the old one.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

/** `canExec` is the seam for the rare host where `bin/` is a `noexec` mount (default: access(2) X_OK) — a runtime that cannot run there is REFUSED so the launcher falls through, never picked and spawned into EACCES (pre-review #390 M1). */
export function installBundledRuntime(o: { resourcesDir: string | undefined; binDir: string; arch?: string; canExec?: (file: string) => boolean }): InstallRuntimeResult {
  const canExec = o.canExec ?? canExecHere;
  const runnable = (dest: string, manifest: RuntimeManifest, copied: boolean): InstallRuntimeResult =>
    canExec(dest) ? { ok: true, path: dest, manifest, copied } : { ok: false, reason: `the installed runtime ${dest} is not executable here (a noexec mount?) — falling back to another runtime` };
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
    if (usable(dest, manifest)) return runnable(dest, manifest, false);

    fs.mkdirSync(o.binDir, { recursive: true });
    sweepStaleTmp(o.binDir);
    const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const tmpDir = path.join(o.binDir, `.${runtimeDirName(manifest)}.tmp-${tag}`);
    const aside = path.join(o.binDir, `.${runtimeDirName(manifest)}.old-${tag}`);
    try {
      fs.mkdirSync(tmpDir);
      fs.copyFileSync(src, path.join(tmpDir, 'node'));
      fs.chmodSync(path.join(tmpDir, 'node'), 0o755);
      const got = sha256File(path.join(tmpDir, 'node'));
      if (got !== manifest.nodeSha256) return { ok: false, reason: `the bundled node does not hash to its manifest (got ${got.slice(0, 12)}…, expected ${manifest.nodeSha256.slice(0, 12)}…) — refusing to install it` };
      let movedAside = false;
      if (fs.existsSync(destDir)) {
        fs.renameSync(destDir, aside); // a corrupt/partial dir of this exact name: replace by rename, never write into it (a process may be running it)
        movedAside = true;
      }
      try {
        fs.renameSync(tmpDir, destDir);
      } catch (e) {
        if (usable(dest, manifest)) return runnable(dest, manifest, false); // another instance won the race
        throw e;
      } finally {
        if (movedAside) fs.rmSync(aside, { recursive: true, force: true });
      }
      return runnable(dest, manifest, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
