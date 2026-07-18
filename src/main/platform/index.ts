import path from 'node:path';
import os from 'node:os';

// The platform seam: every place the main-process backend used to touch
// Electron UI surfaces (webContents.send, Notification, shell.open*, app
// paths/version/metrics, safeStorage) now goes through this one interface, so
// the identical subsystem modules run in three modes — Electron GUI, Electron
// headless (`Orchestra.AppImage daemon`), and plain Node (`node daemon.js`).
// See docs/gtk4-port-plan.md §4 for the exact touchpoint table.
//
// Two implementations exist: ./electron.ts (today's behavior, routed at the
// real BrowserWindow) and ./headless.ts (xdg-open, env-derived paths, no-ops
// where the table says frontend-side). Entry points select one at boot via
// {@link initPlatform}; nothing in this module imports either implementation,
// so the daemon bundle never pulls `electron` in.
//
// Independently of which implementation is active, ui-rpc clients (the GTK
// app, tests) register a {@link UiClientSink} here; both implementations fan
// every broadcast/PTY chunk/notification out to it, and read client focus /
// attachment through it. The sink registry lives HERE (not in ui-rpc.ts) so
// implementations never import the server and the dependency graph stays
// acyclic.

/** Data for a native "agent finished / needs input" notification. The active
 *  implementation decides how to surface it: Electron posts a Notification
 *  (click focuses the window + workspace); both fan a `ui:notify` event out
 *  to attached ui-rpc clients so a GTK frontend can post its own. */
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
  /** Which host mode is running — also the ui-rpc `backendKind`. */
  readonly kind: 'electron' | 'daemon';
  /** Send a push event to every attached UI: the Electron renderer (same
   *  channel names as ever) and all ui-rpc clients (channel translated per
   *  shared/ui-rpc-protocol.ts). Replaces `window.webContents.send`. */
  broadcast(channel: string, ...args: unknown[]): void;
  /** Deliver one coalesced PTY output chunk to every attached UI. Returns
   *  false when the primary target can't receive right now (Electron window
   *  destroyed/being recreated) — the caller then RETAINS its buffer exactly
   *  as pty.ts always has, so a renderer rebuild never desyncs xterm. */
  broadcastPtyData(id: string, data: string): boolean;
  /** Whether events can currently be delivered at all. Electron mirrors the
   *  old `canSend(window)` guard; headless is always true. */
  canBroadcast(): boolean;
  /** OR of the Electron window's focus and every ui-rpc client's last `focus`
   *  frame — the flag stamped on agentFinished/agentNeedsInput and the gate
   *  for notification suppression. */
  isFocused(): boolean;
  /** Whether ≥1 UI is attached (Electron window alive OR ≥1 ui-rpc client).
   *  Gates the events-spool drain: never consume events no UI can apply. */
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
  /** Route a claude-auth URL for an account login. Electron opens the
   *  isolated per-account BrowserWindow (login-browser.ts) and also emits the
   *  `accounts:loginUrl` event to ui-rpc clients; headless only emits the
   *  event (the GTK frontend owns the OAuth window there). */
  openAccountLoginUrl(accountId: string, url: string, label?: string): void;
  /** Close an account's OAuth window if this platform owns one. */
  closeAccountLogin(accountId: string): void;
  /** The userData root (store.json, login dirs, secrets live under it). Must
   *  resolve identically in both implementations for a given environment, or
   *  app and daemon would read different stores. */
  getUserDataDir(): string;
  /** The diagnostic-log directory (platform-standard per-app logs dir). */
  getLogsDir(): string;
  /** The running backend's version (package.json). */
  getAppVersion(): string;
  /** Per-process resource metrics of the backend itself, Electron-app-metrics
   *  shaped. The daemon self-samples its own process instead. */
  getAppMetrics(): AppProcessMetric[];
  /** safeStorage facade. Headless reports unavailable, which drops secrets.ts
   *  into its existing 0600-plaintext fallback path. */
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

// ─── Active implementation ──────────────────────────────────────────────────

let impl: OrchestraPlatform | null = null;

/** Install the active implementation. Called exactly once, at the top of each
 *  entry point (index.ts → electron impl, daemon.ts → headless impl), before
 *  any subsystem can touch the seam. */
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

// ─── UI-rpc client sink ─────────────────────────────────────────────────────

/** What the ui-rpc server registers so both platform implementations can fan
 *  events/PTY bytes out to attached clients and read their focus state. */
export interface UiClientSink {
  /** Broadcast one event to every handshaken client. `channel` is the
   *  INTERNAL Electron IPC channel name — the sink translates to the wire
   *  name (or drops channels outside the contract). */
  event(channel: string, args: unknown[]): void;
  /** Broadcast one coalesced PTY output chunk as binary ptyData frames. */
  ptyData(id: string, data: string): void;
  /** True when any handshaken client's last `focus` frame said focused. */
  anyFocused(): boolean;
  /** Number of handshaken clients. */
  clientCount(): number;
}

let sink: UiClientSink | null = null;

/** Register (or, with null, clear) the ui-rpc client sink. */
export function setUiClientSink(s: UiClientSink | null): void {
  sink = s;
}

/** Fan one event out to attached ui-rpc clients. For implementations. */
export function sinkEvent(channel: string, args: unknown[]): void {
  sink?.event(channel, args);
}

/** Fan one PTY chunk out to attached ui-rpc clients. For implementations. */
export function sinkPtyData(id: string, data: string): void {
  sink?.ptyData(id, data);
}

/** Whether any attached ui-rpc client reports focus. For implementations. */
export function anyUiClientFocused(): boolean {
  return sink?.anyFocused() ?? false;
}

/** Number of attached ui-rpc clients. For implementations. */
export function uiClientCount(): number {
  return sink?.clientCount() ?? 0;
}

// ─── Shared path helpers ────────────────────────────────────────────────────

/** The Orchestra home root: worktrees, scratch, logs, events spool, hooks
 *  socket pointer, ui-rpc socket pointer, and the backend lock all live under
 *  it. `$ORCHESTRA_HOME` (the dev-isolation override) wins; the packaged
 *  default is `~/.orchestra`. Identical for app and daemon by construction —
 *  which is exactly what lets the backend lock make them mutually exclusive. */
export function orchestraHome(): string {
  return process.env.ORCHESTRA_HOME || path.join(os.homedir(), '.orchestra');
}
