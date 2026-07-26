import path from 'node:path';
import os from 'node:os';

// The platform seam: every place the main-process backend used to touch
// Electron UI surfaces (webContents.send, Notification, shell.open*, app
// paths/version/metrics, safeStorage) goes through this one interface, so no
// subsystem module holds a BrowserWindow or imports electron directly.
//
// The sole implementation is ./electron.ts, routed at the real main window.
// index.ts installs it at boot via {@link initPlatform}; nothing in this
// module imports it, which keeps the dependency graph acyclic and the seam
// trivially fakeable in tests.

/** Data for a native "agent finished / needs input" notification. The active
 *  implementation decides how to surface it: Electron posts a Notification
 *  (click focuses the window + workspace). */
export interface UiNotification {
  wsId: string;
  kind: 'finished' | 'needsInput';
  title: string;
  body: string;
}

/** One Electron-app-metrics-shaped process sample, as the Resources page
 *  renders it (see shared/resources.ts ResourceSnapshot.app). */
export interface AppProcessMetric {
  type: string;
  pid: number;
  cpuPct: number;
  memBytes: number;
}

/** The seam every backend module talks to instead of Electron. */
export interface OrchestraPlatform {
  /** Which host mode is running. */
  readonly kind: 'electron';
  /** Send a push event to the attached UI (the Electron renderer, on the same
   *  channel names as ever). Replaces `window.webContents.send`. */
  broadcast(channel: string, ...args: unknown[]): void;
  /** Deliver one coalesced PTY output chunk to every attached UI. Returns
   *  false when the primary target can't receive right now (Electron window
   *  destroyed/being recreated) — the caller then RETAINS its buffer exactly
   *  as pty.ts always has, so a renderer rebuild never desyncs xterm. */
  broadcastPtyData(id: string, data: string): boolean;
  /** Whether events can currently be delivered at all. Electron mirrors the
   *  old `canSend(window)` guard; headless is always true. */
  canBroadcast(): boolean;
  /** Whether the Electron window has focus — the flag stamped on
   *  agentFinished/agentNeedsInput and the gate for notification
   *  suppression. */
  isFocused(): boolean;
  /** Whether a UI is attached (the Electron window is alive). Gates the
   *  events-spool drain: never consume events no UI can apply. */
  hasAttachedUi(): boolean;
  /** Surface an agent finished/needs-input notification (see
   *  {@link UiNotification}). Caller has already applied focus suppression. */
  notify(n: UiNotification): void;
  /** Open a URL with the system handler. Callers keep their own http(s)
   *  gating — this is the raw hand-off. */
  openExternal(url: string): Promise<void>;
  /** Reveal a file in the OS file manager. */
  showItemInFolder(p: string): void;
  /** Open a file/dir with the system handler. Resolves to '' on success or an
   *  error string, mirroring Electron's shell.openPath. */
  openPath(p: string): Promise<string>;
  /** Route a claude-auth URL for an account login: Electron opens the
   *  isolated per-account BrowserWindow (login-browser.ts). */
  openAccountLoginUrl(accountId: string, url: string, label?: string): void;
  /** Close an account's OAuth window if this platform owns one. */
  closeAccountLogin(accountId: string): void;
  /** The userData root (store.json, login dirs, secrets live under it). */
  getUserDataDir(): string;
  /** The diagnostic-log directory (platform-standard per-app logs dir). */
  getLogsDir(): string;
  /** The running backend's version (package.json). */
  getAppVersion(): string;
  /** Per-process resource metrics of the backend itself, Electron-app-metrics
   *  shaped. */
  getAppMetrics(): AppProcessMetric[];
  /** safeStorage facade. When it reports unavailable, secrets.ts falls back to
   *  its 0600-plaintext path. */
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

// ─── Active implementation ──────────────────────────────────────────────────

let impl: OrchestraPlatform | null = null;

/** Install the active implementation. Called exactly once, at the top of the
 *  entry point (index.ts → electron impl), before any subsystem can touch the
 *  seam. */
export function initPlatform(p: OrchestraPlatform): void {
  impl = p;
}

function current(): OrchestraPlatform {
  if (!impl) throw new Error('platform not initialized — initPlatform() must run at entry');
  return impl;
}

/** The seam, as a stable importable object — modules call `platform.broadcast`
 *  etc. without caring which implementation the entry point installed. */
export const platform: OrchestraPlatform = {
  get kind() {
    return current().kind;
  },
  broadcast: (channel, ...args) => current().broadcast(channel, ...args),
  broadcastPtyData: (id, data) => current().broadcastPtyData(id, data),
  canBroadcast: () => current().canBroadcast(),
  isFocused: () => current().isFocused(),
  hasAttachedUi: () => current().hasAttachedUi(),
  notify: (n) => current().notify(n),
  openExternal: (url) => current().openExternal(url),
  showItemInFolder: (p) => current().showItemInFolder(p),
  openPath: (p) => current().openPath(p),
  openAccountLoginUrl: (accountId, url, label) =>
    current().openAccountLoginUrl(accountId, url, label),
  closeAccountLogin: (accountId) => current().closeAccountLogin(accountId),
  getUserDataDir: () => current().getUserDataDir(),
  getLogsDir: () => current().getLogsDir(),
  getAppVersion: () => current().getAppVersion(),
  getAppMetrics: () => current().getAppMetrics(),
  isEncryptionAvailable: () => current().isEncryptionAvailable(),
  encryptString: (plain) => current().encryptString(plain),
  decryptString: (cipher) => current().decryptString(cipher),
};

// ─── Shared path helpers ────────────────────────────────────────────────────

/** The Orchestra home root: worktrees, scratch, logs, events spool and the
 *  hooks socket pointer all live under it. `$ORCHESTRA_HOME` (the
 *  dev-isolation override) wins; the packaged default is `~/.orchestra`. */
export function orchestraHome(): string {
  return process.env.ORCHESTRA_HOME || path.join(os.homedir(), '.orchestra');
}
