// Accès mobile host (#334, ADR 0006): main's side of the feature. Owns the token file, installs the server bundle out of the
// asar, and spawns/supervises the server process while the setting is on. Main itself opens NO port: the process reaches main
// only through the 0600 hooks socket (`/mobile/*` routes in hooks-server.ts).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { store } from './store';
import { scoped } from './logger';
import { orchestraHome } from './platform';
import { getHookSocketPath } from './hooks-server';
import {
  patchAccesMobileSettings,
  tailscaleServeCommand,
  type AccesMobileHealth,
  type AccesMobileSettings,
  type AccesMobileSetResult,
  type AccesMobileView,
} from '../shared/acces-mobile';

const log = scoped('acces-mobile');

const MAX_BACKOFF_MS = 30_000;
const STABLE_UPTIME_MS = 60_000;

export function accesMobileDir(): string {
  return path.join(orchestraHome(), 'acces-mobile');
}
export function accesMobileTokenPath(): string {
  return path.join(accesMobileDir(), 'token');
}
function installedServerPath(): string {
  return path.join(orchestraHome(), 'bin', 'acces-mobile.js');
}

/** The current token, or null when none was ever generated. */
export function readAccesMobileToken(): string | null {
  try {
    const t = fs.readFileSync(accesMobileTokenPath(), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Write a fresh 256-bit token atomically, 0600 in a 0700 dir. The server reads the file at every request: the old token dies at once. */
export function generateAccesMobileToken(): string {
  const dir = accesMobileDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const token = crypto.randomBytes(32).toString('base64url');
  const tmp = path.join(dir, `.token.${process.pid}.tmp`);
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.renameSync(tmp, accesMobileTokenPath());
  return token;
}

function ensureToken(): string {
  return readAccesMobileToken() ?? generateAccesMobileToken();
}

/** Copy the bundle out of the install dir (asar / AppImage mount) — the server runs under ELECTRON_RUN_AS_NODE, which must not read
 *  from inside the asar. Same reasoning as installKeeper(). Returns the installed path, or null when the bundle is missing. */
function installServer(): string | null {
  const src = path.join(__dirname, 'acces-mobile.js');
  if (!fs.existsSync(src)) {
    log.warn(`server bundle missing at ${src} — Accès mobile unavailable`);
    return null;
  }
  const dst = installedServerPath();
  const body = fs.readFileSync(src);
  try {
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(body)) return dst;
  } catch {
    /* unreadable → rewrite */
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o755 });
  fs.renameSync(tmp, dst);
  return dst;
}

// ---------- supervision ----------

let child: ChildProcess | null = null;
/** The config the running child was started with; a change ⇒ restart. */
let childKey = '';
let health: AccesMobileHealth = { state: 'off' };
let backoffMs = 1000;
let retryTimer: NodeJS.Timeout | null = null;
let desired: AccesMobileSettings | null = null;
let quitting = false;

function configKey(s: AccesMobileSettings): string {
  return `${s.port}|${s.allowedLogin}`;
}

function stopChild(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const c = child;
  child = null;
  childKey = '';
  if (c && c.exitCode === null && c.signalCode === null) {
    log.info(`stopping server (pid=${c.pid})`);
    c.stdin?.end();
    c.kill('SIGTERM');
  }
}

function startChild(s: AccesMobileSettings): void {
  const sock = getHookSocketPath();
  const script = installServer();
  if (!sock || !script) {
    health = { state: 'failed', error: !sock ? 'local socket not ready' : 'server bundle missing', retryInMs: null };
    return;
  }
  ensureToken();
  // Allowlisted env: the network-facing process gets nothing it does not need (no API keys, no CLAUDE_* from main's env).
  const env: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ACCES_MOBILE_PORT: String(s.port),
    ACCES_MOBILE_LOGIN: s.allowedLogin,
    ACCES_MOBILE_TOKEN_FILE: accesMobileTokenPath(),
    ORCHESTRA_SOCK: sock,
  };
  const startedAt = Date.now();
  const c = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child = c;
  childKey = configKey(s);
  health = { state: 'starting', pid: c.pid };
  log.info(`server starting (pid=${c.pid}, 127.0.0.1:${s.port}, login=${s.allowedLogin})`);
  let lastErr = '';
  c.stdout?.setEncoding('utf8');
  c.stdout?.on('data', (chunk: string) => {
    const m = /listening (\d+)/.exec(chunk);
    if (m && child === c) {
      health = { state: 'listening', pid: c.pid ?? 0, port: Number(m[1]) };
      log.info(`server listening on 127.0.0.1:${m[1]} (pid=${c.pid})`);
    }
  });
  c.stderr?.setEncoding('utf8');
  c.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      lastErr = line.replace(/^acces-mobile: /, '').slice(0, 200);
      log.warn(line.slice(0, 300));
    }
  });
  c.stdin?.on('error', () => {});
  c.on('error', (e) => {
    lastErr = e.message;
  });
  c.on('exit', (code, signal) => {
    if (child !== c) return; // a stop/restart we asked for
    child = null;
    childKey = '';
    if (quitting || !desired?.enabled) {
      health = { state: 'off' };
      return;
    }
    if (Date.now() - startedAt > STABLE_UPTIME_MS) backoffMs = 1000;
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    const error = lastErr || `exited (${signal ?? code})`;
    health = { state: 'failed', error, retryInMs: wait };
    log.warn(`server exited (${signal ?? code}): ${error} — restarting in ${wait} ms`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (desired?.enabled && !child && !quitting) startChild(desired);
    }, wait);
  });
}

/** Bring the process in line with the settings: on ⇒ running with this config; off ⇒ stopped. */
export function applyAccesMobile(s: AccesMobileSettings): void {
  desired = s;
  if (!s.enabled || !s.allowedLogin) {
    stopChild();
    health = { state: 'off' };
    return;
  }
  if (child && childKey === configKey(s)) return;
  stopChild();
  backoffMs = 1000;
  startChild(s);
}

/** Boot: called once the hooks socket is listening and the store is loaded. */
export function startAccesMobileHost(): void {
  applyAccesMobile(store.getAccesMobileSettings());
}

export function stopAccesMobileHost(): void {
  quitting = true;
  stopChild();
  health = { state: 'off' };
}

export function accesMobileView(): AccesMobileView {
  const settings = store.getAccesMobileSettings();
  const token = readAccesMobileToken();
  return {
    settings,
    health,
    serveCommand: tailscaleServeCommand(settings),
    pairingFragment: token ? `#t=${token}` : null,
  };
}

export async function setAccesMobileSettings(patch: Partial<AccesMobileSettings>): Promise<AccesMobileSetResult> {
  const current = store.getAccesMobileSettings();
  const res = patchAccesMobileSettings(current, patch);
  if (!res.ok) return { ok: false, error: res.error, view: accesMobileView() };
  await store.setAccesMobileSettings(res.settings);
  log.info(`settings changed — ${current.enabled ? 'ON' : 'OFF'}→${res.settings.enabled ? 'ON' : 'OFF'}, port ${res.settings.port}, tailnet port ${res.settings.servePort}`);
  applyAccesMobile(res.settings);
  return { ok: true, view: accesMobileView() };
}
