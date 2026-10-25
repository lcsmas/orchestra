// Which runtime a detached keeper runs on (#390) — pure, so `node --test` covers every branch without Electron or a filesystem.
// Policy: the pinned Node shipped with the app (copied out of the AppImage mount) > a PATH `node` (AppImage only) > the app's own binary.

/** What the build writes beside the bundled Node (`resources/pinned-node/manifest.json`) and the launcher trusts after re-hashing. */
export interface RuntimeManifest {
  version: string;
  arch: 'arm64' | 'x64';
  tarballSha256: string;
  nodeSha256: string;
  nodeBytes: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Parse + validate the manifest text; a malformed one is a refusal with the reason, never a guess. */
export function parseRuntimeManifest(raw: string): { ok: true; manifest: RuntimeManifest } | { ok: false; reason: string } {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (typeof m !== 'object' || m === null) return { ok: false, reason: 'not an object' };
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) return { ok: false, reason: 'bad version' };
  if (m.arch !== 'arm64' && m.arch !== 'x64') return { ok: false, reason: 'bad arch' };
  if (typeof m.tarballSha256 !== 'string' || !HEX64.test(m.tarballSha256)) return { ok: false, reason: 'bad tarballSha256' };
  if (typeof m.nodeSha256 !== 'string' || !HEX64.test(m.nodeSha256)) return { ok: false, reason: 'bad nodeSha256' };
  if (typeof m.nodeBytes !== 'number' || !Number.isInteger(m.nodeBytes) || m.nodeBytes <= 0) return { ok: false, reason: 'bad nodeBytes' };
  return { ok: true, manifest: { version: m.version, arch: m.arch, tarballSha256: m.tarballSha256, nodeSha256: m.nodeSha256, nodeBytes: m.nodeBytes } };
}

/** The versioned directory the runtime is installed in under `<ORCHESTRA_HOME>/bin/`: a new pin (or a re-built binary) gets a NEW dir, so a running keeper's binary is never overwritten. */
export function runtimeDirName(m: Pick<RuntimeManifest, 'version' | 'nodeSha256'>): string {
  return `node-${m.version}-${m.nodeSha256.slice(0, 12)}`;
}

export type KeeperRuntimeKind = 'bundled' | 'path' | 'app';

export interface KeeperRuntimeInputs {
  /** The installed pinned Node (absolute path under ORCHESTRA_HOME) when it is present and executable; null otherwise. */
  bundledNode: string | null;
  /** Launched from an AppImage: the mount vanishes at quit, so a stable on-disk runtime matters. */
  appImage: boolean;
  /** A `node` found on PATH (only consulted under an AppImage — elsewhere the app's own binary is already stable on disk). */
  pathNode: string | null;
  /** This very executable (Electron / the AppImage's binary). */
  execPath: string;
}

export interface KeeperRuntimePick {
  kind: KeeperRuntimeKind;
  cmd: string;
  /** True only for the app's own binary: Electron needs ELECTRON_RUN_AS_NODE=1 to behave as node. */
  electronRunAsNode: boolean;
  /** Set when the pick is a known-fragile one (the AppImage binary on a vanishing mount). */
  warn?: string;
}

/** The only place the launcher's host facts become pick inputs: a PATH `node` is looked up (via `findOnPath`) ONLY under an AppImage. */
export function gatherRuntimeInputs(o: { bundledNode: string | null; appImagePath: string; findOnPath: (name: string) => string | null; execPath: string }): KeeperRuntimeInputs {
  const appImage = !!o.appImagePath;
  return { bundledNode: o.bundledNode, appImage, pathNode: appImage ? o.findOnPath('node') : null, execPath: o.execPath };
}

export function pickKeeperRuntime(i: KeeperRuntimeInputs): KeeperRuntimePick {
  if (i.bundledNode) return { kind: 'bundled', cmd: i.bundledNode, electronRunAsNode: false };
  if (i.appImage) {
    if (i.pathNode) return { kind: 'path', cmd: i.pathNode, electronRunAsNode: false };
    return { kind: 'app', cmd: i.execPath, electronRunAsNode: true, warn: 'AppImage without a bundled or PATH node — keeper rides the mount and may die at quit' };
  }
  return { kind: 'app', cmd: i.execPath, electronRunAsNode: true };
}
