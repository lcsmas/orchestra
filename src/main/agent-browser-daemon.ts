/**
 * Host-owned `agent-browser` daemon (#395, ADR 0009). The client keeps its refs (`@e1`…) in a
 * background daemon between CLI calls. If an agent's first `orchestra browser` call spawned it,
 * the daemon would live in that member's kernel scope as a Reliquat (delays its Veille, gets
 * killed + reported). So the HOST starts it — `agent-browser connect <proxy url>` — outside every
 * member scope, and the agent's CLI only ever runs short-lived clients against its socket.
 * Electron-free; process spawning and the filesystem are injected for the tests.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const AB_NAMESPACE = 'orchestra';
/** A daemon with no command for this long exits by itself (the host re-ensures it on the next call). */
export const AB_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface AbLayout {
  /** Scratch HOME for every agent-browser process: its dot-dir never lands in the user's real home. */
  home: string;
  /** `{}` — keeps a repo's `./agent-browser.json` (plugins!) out of the client. */
  config: string;
  /** Short + hashed: a unix socket path must stay under ~104 chars whatever ORCHESTRA_HOME is. */
  socketDir: string;
  /** Where the binary is copied to run from (never from an AppImage mount that may go away). */
  binDir: string;
}

/** Pure path layout for one ORCHESTRA_HOME. */
export function abLayout(orchestraHome: string, runtimeDir: string | undefined, tmpDir: string = os.tmpdir()): AbLayout {
  const base = path.join(orchestraHome, 'browser-cli');
  const tag = crypto.createHash('sha1').update(orchestraHome).digest('hex').slice(0, 8);
  return {
    home: path.join(base, 'home'),
    config: path.join(base, 'config.json'),
    binDir: path.join(base, 'bin'),
    socketDir: path.join(runtimeDir && runtimeDir.length > 0 ? runtimeDir : tmpDir, `orch-ab-${tag}`),
  };
}

/** The env both the daemon and the agent's client run with (the CLI receives it from the host, not from its own env). */
export function abEnv(layout: AbLayout, session: string, screenshotDir: string | undefined): Record<string, string> {
  return {
    HOME: layout.home,
    AGENT_BROWSER_CONFIG: layout.config,
    AGENT_BROWSER_SOCKET_DIR: layout.socketDir,
    AGENT_BROWSER_NAMESPACE: AB_NAMESPACE,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(AB_IDLE_TIMEOUT_MS),
    // The daemon stays attached for minutes after the last command and by default auto-dismisses alert()/beforeunload dialogs: on a panel the HUMAN
    // shares, that would answer THEIR dialogs unseen. Off: every dialog (like confirm() already) waits for an explicit `dialog accept|dismiss|status`.
    AGENT_BROWSER_NO_AUTO_DIALOG: '1',
    ...(screenshotDir ? { AGENT_BROWSER_SCREENSHOT_DIR: screenshotDir } : {}),
  };
}

export function sockPath(layout: AbLayout, session: string): string {
  return path.join(layout.socketDir, 'namespaces', AB_NAMESPACE, 'run', `${session}.sock`);
}

export interface AbDeps {
  run(binary: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number; out: string }>;
  canConnect(sock: string): Promise<boolean>;
}

export const realAbDeps: AbDeps = {
  run: (binary, args, env, timeoutMs) =>
    new Promise((resolve) => {
      execFile(binary, args, { env, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as unknown as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}`.trim() });
      });
    }),
  canConnect: (sock) =>
    new Promise((resolve) => {
      const s = net.connect(sock);
      const done = (ok: boolean): void => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(500, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    }),
};

/** Prepare the scratch dirs and the `{}` config (idempotent). */
export function prepareLayout(layout: AbLayout): void {
  for (const d of [layout.home, layout.binDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.socketDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(layout.socketDir, 0o700);
  if (!fs.existsSync(layout.config)) fs.writeFileSync(layout.config, '{}\n', { mode: 0o600 });
}

/** Copy the bundled binary next to the app data (recopied when its size differs), return the path to run. */
export function installBinary(src: string, layout: AbLayout, version: string): string {
  const dst = path.join(layout.binDir, `agent-browser-${version}`);
  const want = fs.statSync(src).size;
  let have = -1;
  try {
    have = fs.statSync(dst).size;
  } catch {
    /* absent */
  }
  if (have !== want) {
    const tmp = `${dst}.${process.pid}.tmp`;
    fs.copyFileSync(src, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dst);
  }
  return dst;
}

const ensuring = new Map<string, Promise<void>>();

/**
 * Make sure a live daemon is connected to `wsUrl` for `session`; returns once its socket answers.
 * Single-flight per session: two concurrent `connect`s for one session race each other and one fails
 * ("started concurrently with different daemon configuration", measured on v0.39.2), which made the first
 * two parallel `orchestra browser` calls — or the first after the idle exit — return `unavailable`.
 */
export function ensureDaemon(
  binary: string,
  layout: AbLayout,
  session: string,
  wsUrl: string,
  deps: AbDeps = realAbDeps,
): Promise<void> {
  const key = sockPath(layout, session);
  const inflight = ensuring.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    if (await deps.canConnect(key)) return;
    // The proxy URL carries the token and /proc/<pid>/cmdline is world-readable (environ is 0400): hand it over as AGENT_BROWSER_CDP,
    // never as an argument (`connect <url>` / `--cdp <url>`). `get url` is the cheapest command that makes the client start the daemon
    // and connect it (`connect` insists on an argument). Verified on v0.39.2: the daemon's own cmdline is empty, its environ 0400.
    const r = await deps.run(binary, ['get', 'url'], { ...abEnv(layout, session, undefined), AGENT_BROWSER_CDP: wsUrl }, 20_000);
    if (r.code !== 0) throw new Error(`agent-browser could not connect to the panel (${r.out.slice(0, 300) || `exit ${r.code}`})`);
  })().finally(() => ensuring.delete(key));
  ensuring.set(key, p);
  return p;
}

/**
 * Quit-time best effort that does not wait on anything: SIGTERM every daemon of THIS socket dir whose pid file still names a
 * process that carries this dir in its environment (identity re-read at signal time — a recycled pid is never touched).
 * Returns the pids signalled.
 */
export function terminateDaemonsOf(
  layout: AbLayout,
  io: { readdir(d: string): string[]; read(f: string): string; environ(pid: number): string[] | null; kill(pid: number): void } = {
    readdir: (d) => fs.readdirSync(d),
    read: (f) => fs.readFileSync(f, 'utf8'),
    environ: (pid) => {
      try {
        return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      } catch {
        return null;
      }
    },
    kill: (pid) => process.kill(pid, 'SIGTERM'),
  },
): number[] {
  const dir = path.join(layout.socketDir, 'namespaces', AB_NAMESPACE, 'run');
  const done: number[] = [];
  let names: string[] = [];
  try {
    names = io.readdir(dir).filter((n) => n.endsWith('.pid'));
  } catch {
    return done;
  }
  for (const n of names) {
    const pid = Number(io.read(path.join(dir, n)).trim());
    if (!Number.isInteger(pid) || pid <= 1) continue;
    const env = io.environ(pid);
    if (!env || !env.includes(`AGENT_BROWSER_SOCKET_DIR=${layout.socketDir}`)) continue;
    try {
      io.kill(pid);
      done.push(pid);
    } catch {
      /* already gone */
    }
  }
  return done;
}

/**
 * Remove THIS ORCHESTRA_HOME's socket dir (quit). Refuses anything that is not a hashed `orch-ab-<8 hex>` directory: the runtime dir
 * itself, or a sibling's dir under another name, can never be passed through here.
 */
export function removeSocketDir(layout: AbLayout, rm: (p: string) => void = (p) => fs.rmSync(p, { recursive: true, force: true })): boolean {
  if (!/^orch-ab-[0-9a-f]{8}$/.test(path.basename(layout.socketDir))) return false;
  rm(layout.socketDir);
  return true;
}

/** Ask the daemon to exit (it only disconnects: the proxy turns `Browser.close` into a no-op). Never throws. */
export async function closeDaemon(binary: string, layout: AbLayout, session: string, deps: AbDeps = realAbDeps): Promise<void> {
  await deps.run(binary, ['close'], abEnv(layout, session, undefined), 5_000).catch(() => undefined);
}

/** Sessions that have a socket file under the namespace dir (daemons of an earlier app run). */
export function listSessions(layout: AbLayout): string[] {
  try {
    return fs
      .readdirSync(path.join(layout.socketDir, 'namespaces', AB_NAMESPACE, 'run'))
      .filter((n) => n.endsWith('.sock'))
      .map((n) => n.slice(0, -'.sock'.length));
  } catch {
    return [];
  }
}
