// The per-workspace disk TMPDIR (src/shared/agent-tmpdir.ts): create it safely in the world-writable
// /var/tmp, put it in a session's env, remove it with the workspace, sweep the dead ones at boot.
import fs from 'node:fs';
import path from 'node:path';
import { orchestraHome } from './platform/index.ts';
import { log } from './logger.ts';
import { AGENT_TMPDIR_ENV, AGENT_TMPDIR_MAX_LEN, agentTmpDir, agentTmpRoot, planAgentTmpSweep } from '../shared/agent-tmpdir.ts';

/** `ORCHESTRA_AGENT_TMP_BASE` replaces /var/tmp (rigs); `off` disables the feature. Under `node --test`
 *  it is OFF unless a base is given: each test's scratch ORCHESTRA_HOME would leave its own root (130 per suite run). */
function rootPath(): string | null {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return null;
  const base = process.env.ORCHESTRA_AGENT_TMP_BASE;
  if (base === 'off' || (!base && process.env.NODE_TEST_CONTEXT)) return null;
  return agentTmpRoot(process.getuid(), orchestraHome(), base || '/var/tmp');
}

let warned = false;
function warnOnce(msg: string): void {
  if (warned) return;
  warned = true;
  log.warn(`agent-tmpdir: ${msg} — agent sessions keep the inherited TMPDIR`);
}

/** The root, created 0700 — or null when it exists but is not OURS (a symlink, another owner,
 *  group/other access): /var/tmp is world-writable, a pre-planted root must never be used. */
function ownedRoot(): string | null {
  const root = rootPath();
  if (!root) return null;
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { warnOnce(`cannot create ${root}: ${(e as Error).message}`); return null; }
  }
  try {
    const st = fs.lstatSync(root);
    // lstat: a symlink is never isDirectory() — a planted link is refused here.
    if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) {
      warnOnce(`${root} is not a private directory of this user (refused)`);
      return null;
    }
  } catch (e) {
    warnOnce(`cannot stat ${root}: ${(e as Error).message}`);
    return null;
  }
  return root;
}

/** The workspace's TMPDIR, created — or null (feature off, unsafe root, path too long for sockets). */
export function ensureAgentTmpDir(wsId: string): string | null {
  const root = ownedRoot();
  if (!root) return null;
  const dir = agentTmpDir(root, wsId);
  if (dir.length > AGENT_TMPDIR_MAX_LEN) { warnOnce(`${dir} is longer than ${AGENT_TMPDIR_MAX_LEN} bytes`); return null; }
  try {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  } catch (e) {
    warnOnce(`cannot create ${dir}: ${(e as Error).message}`);
    return null;
  }
  return dir;
}

/** Point a LOCAL session's env at the workspace's TMPDIR. Unavailable ⇒ the inherited TMPDIR stays,
 *  but an inherited marker is dropped (it would arm the /tmp guard with no disk dir to point at). */
export function applyAgentTmpEnv(env: Record<string, string>, wsId: string): void {
  delete env[AGENT_TMPDIR_ENV];
  const dir = ensureAgentTmpDir(wsId);
  if (!dir) return;
  env.TMPDIR = dir;
  env[AGENT_TMPDIR_ENV] = dir;
}

/** Delete the workspace's TMPDIR (hard delete / prune). Best-effort. */
export function removeAgentTmpDir(wsId: string): void {
  const root = ownedRoot();
  if (!root) return;
  const dir = agentTmpDir(root, wsId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log.warn(`agent-tmpdir: could not remove ${dir}`, e);
  }
  try {
    fs.rmdirSync(root); // only when empty (ENOTEMPTY otherwise): a rig's scratch home leaves no root behind
  } catch { /* other workspaces' dirs remain */ }
}

/** Boot: remove the dirs of workspaces that no longer exist (deleted while the app was down, a crash). */
export function sweepAgentTmpDirs(workspaceIds: string[]): void {
  const root = ownedRoot();
  if (!root) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  const dead = planAgentTmpSweep(entries, workspaceIds);
  for (const name of dead) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch (e) {
      log.warn(`agent-tmpdir: sweep could not remove ${name}`, e);
    }
  }
  if (dead.length) log.info(`agent-tmpdir: swept ${dead.length} dir(s) of deleted workspaces from ${root}`);
}
