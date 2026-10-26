/**
 * Core of the per-workspace CDP proxy (#395, ADR 0009): fakes the BROWSER-level surface
 * (`Target.*`, `Browser.getVersion`, `/json`) over a workspace's panel tabs and routes every
 * page-level command to that tab's debugger. Electron-free and socket-free — `CdpPanelPort`
 * is the seam to the panel, `CdpClientLink` the seam to a WebSocket (`browser-cdp-proxy.ts`).
 *
 * Electron has no `Target.createTarget`, so "new target" maps onto the panel's own tab creation;
 * `Page.bringToFront` / `Target.activateTarget` activate the tab instead of taking OS focus.
 * Targets are flattened sessions only (`flatten: true`), which is all `agent-browser` speaks.
 */
import { randomBytes, createHash } from 'node:crypto';
import { captureWithFallback } from './cdp-capture.ts';
import { TAB_DESTROYING_METHODS, internalNavigationRefusal, isActingCdpMethod, isBrowserInternalUrl } from './browser-agent-tabs.ts';

export interface CdpTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
  openedBy: 'human' | 'agent';
}
export type CdpEventListener = (method: string, params: unknown, sessionId?: string) => void;
export interface CdpTabChannel {
  /** `sessionId` set only for an auto-attached CHILD session of the tab (iframe, worker). */
  send(method: string, params: Record<string, unknown> | undefined, sessionId?: string): Promise<unknown>;
  subscribe(l: CdpEventListener): () => void;
  /** Fired once when the debugger goes away (tab destroyed, DevTools took it). */
  onDetach(l: (reason: string) => void): () => void;
}
/** `replaced`: the tab id survived but the PAGE behind it did not (an in-place rebuild — #400 profile attach / detach / delete): `tab` is the new page. */
export type CdpTabEvent = { kind: 'created' | 'changed' | 'destroyed' | 'replaced'; tab: CdpTab };
export interface CdpPanelPort {
  listTabs(): CdpTab[];
  subscribeTabs(l: (e: CdpTabEvent) => void): () => void;
  /** Attach the debugger (idempotent per call; the core pairs every acquire with one release). */
  acquire(tabId: string): Promise<CdpTabChannel>;
  /** `agentTouched`: a WebSocket client (an agent's session) attached to this tab while it was held — only then has anything been left on the page that a reset must undo. */
  release(tabId: string, agentTouched?: boolean): void;
  createTab?(url?: string): Promise<CdpTab>;
  closeTab?(tabId: string): Promise<void>;
  /** Bring the tab to the front of the panel (no OS focus). */
  activateTab(tabId: string): void;
  userAgent(): string;
  invalidate(tabId: string): void;
  /** `capturePage()` as base64 in the requested format. */
  captureFallback(tabId: string, format: 'png' | 'jpeg', quality?: number): Promise<string>;
  /** A reason the tab cannot produce frames right now (panel hidden / workspace in background), else null. */
  framesError(tabId: string): string | null;
  /**
   * Policy seam for page-level commands (#400: refuse partition-wide cookie clears while the workspace holds a shared profile).
   * Called for EVERY command a client sends to a tab — root and auto-attached child sessions — before it reaches the debugger;
   * a returned string refuses it (CDP error, the debugger never sees it). `tab` is the target tab AS THE REGISTRY SEES IT NOW (its url
   * scopes origin-bound policies, #400). SYNCHRONOUS and STRICT: only `null` allows; a non-empty string refuses with that text; anything else
   * (empty string, falsy value, undefined, a Promise, an object) or a throw refuses fail-CLOSED. Absent = nothing refused.
   */
  refuseMethod?(method: string, params: Record<string, unknown> | undefined, tab: CdpTab): string | null;
}
export interface CdpClientLink {
  send(msg: Record<string, unknown>): void;
}
/** Debug tap (`ORCHESTRA_CDP_TRACE`): every client request and every reply/event, in order. */
export type CdpTrace = (dir: 'client->proxy' | 'proxy->client' | 'debugger->proxy' | 'proxy->debugger', msg: unknown) => void;
export interface CdpClient {
  /** Feed one raw client message (JSON text). Never throws. */
  message(raw: string): Promise<void>;
  close(): void;
}

/** Input / paint commands hang on a view that is not composited (browser-panel.md): fail fast instead. */
export const FRAME_BOUND_METHODS: ReadonlySet<string> = new Set([
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.dispatchTouchEvent',
  'Input.insertText',
  'Input.synthesizeScrollGesture',
]);

/** Target.* methods that mean the same thing on a tab session as at the browser level (everything else under Target.* — setAutoAttach — is the page's own). */
const TAB_SESSION_BROWSER_LEVEL: ReadonlySet<string> = new Set([
  'Target.closeTarget', 'Target.createTarget', 'Target.activateTarget', 'Target.getTargets', 'Target.getTargetInfo',
  'Target.attachToTarget', 'Target.attachToBrowserTarget', 'Target.detachFromTarget', 'Target.setDiscoverTargets',
  'Target.getBrowserContexts', 'Target.createBrowserContext', 'Target.disposeBrowserContext',
]);

/** Methods that open a second, unfiltered CDP channel inside a flattened session: refused outright (seam review m1). `Target.sendMessageToTarget{message:'{"method":"Network.clearBrowserCookies"}'}`
 *  carried a command past every per-method policy; `Target.exposeDevToolsProtocol` hands the PAGE a `cdp` binding. Nothing legitimate uses either on a flatten-only client. */
const TUNNEL_METHODS: ReadonlySet<string> = new Set(['Target.sendMessageToTarget', 'Target.exposeDevToolsProtocol']);

/**
 * THE shared predicate (#395 final-tip review M4; #397 F1): a method that the faked BROWSER surface owns — never the page debugger.
 * Applies to a tab session AND to every auto-attached CHILD session of it (iframe / worker): a child that sent `Page.close`,
 * `Target.closeTarget` or `Browser.close` used to reach the debugger and skip close ownership. Legit children only send page commands
 * and `Target.setAutoAttach`, so this is safe to apply to all of them. Consumers (e.g. #397's close ownership) call THIS, not a copy.
 */
export function isBrowserLevelMethod(method: string): boolean {
  return method === 'Page.close' || method.startsWith('Browser.') || TAB_SESSION_BROWSER_LEVEL.has(method);
}

const ERR_METHOD = -32601;
const ERR_PARAMS = -32602;
const ERR_SERVER = -32000;

class CdpError extends Error {
  readonly code: number;
  constructor(message: string, code = ERR_SERVER) {
    super(message);
    this.code = code;
  }
}

interface TabState {
  channel: CdpTabChannel;
  refs: number;
  /** A client session (not an in-process lease) attached since the debugger was acquired: sticky until it is released. */
  agent: boolean;
  unsub: Array<() => void>;
  children: Set<string>;
}
interface Session {
  kind: 'tab' | 'browser';
  tabId?: string;
}
interface ClientState {
  link: CdpClientLink;
  sessions: Map<string, Session>;
  discover: boolean;
  closed: boolean;
}

const hex32 = (): string => randomBytes(16).toString('hex').toUpperCase();

/**
 * Run one command on an in-process lease and give the lease back when it settles — or after `maxMs`, so a command that never settles (a view that
 * stopped painting hangs `Page.captureScreenshot`, browser-panel.md) cannot pin the tab's debugger, and the proxy's hold on it, forever.
 */
export async function sendOnLease(
  lease: { channel: CdpTabChannel; release(): void },
  method: string,
  params: Record<string, unknown> | undefined,
  maxMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lease.channel.send(method, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} did not settle within ${maxMs} ms (the lease on the tab was given back)`)), maxMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    lease.release();
  }
}

export class CdpProxyCore {
  private readonly port: CdpPanelPort;
  private readonly nonce: string;
  readonly browserTargetId: string;
  readonly browserContextId: string;
  private readonly clients = new Set<ClientState>();
  private readonly tabs = new Map<string, TabState>();
  private readonly acquiring = new Map<string, Promise<TabState>>();
  private readonly unsubTabs: () => void;
  private readonly known = new Map<string, CdpTab>();
  /** Per tab id: how many times the page behind it was replaced. It is part of the target id, so a replacement is a NEW target to the client. */
  private readonly generation = new Map<string, number>();

  private readonly trace: CdpTrace | undefined;

  constructor(port: CdpPanelPort, opts: { nonce?: string; trace?: CdpTrace } = {}) {
    this.port = port;
    this.trace = opts.trace;
    this.nonce = opts.nonce ?? randomBytes(8).toString('hex');
    this.browserTargetId = this.derive('browser');
    this.browserContextId = this.derive('context');
    for (const t of port.listTabs()) this.known.set(t.id, t);
    this.unsubTabs = port.subscribeTabs((e) => this.onTabEvent(e));
  }

  /** Stable, hex-shaped ids (real Chrome's) derived from the proxy nonce: never the registry's `t1`. */
  private derive(what: string): string {
    return createHash('sha1').update(`${this.nonce}:${what}`).digest('hex').slice(0, 32).toUpperCase();
  }
  /** A replaced page gets a NEW target id: agent-browser drops a `targetCreated` for an id it still tracks when it arrives in the same batch as the
   *  `targetDestroyed` of that id, then removes the page — and opens a blank tab (v0.39.2 `drain_cdp_events`). */
  targetIdFor(tabId: string): string {
    const g = this.generation.get(tabId) ?? 0;
    return this.derive(g === 0 ? `tab:${tabId}` : `tab:${tabId}:g${g}`);
  }
  private tabForTarget(targetId: unknown): CdpTab | undefined {
    if (typeof targetId !== 'string') return undefined;
    return this.port.listTabs().find((t) => this.targetIdFor(t.id) === targetId);
  }

  // ── HTTP discovery (/json/*) ────────────────────────────────────────────────
  private tabsOrdered(): CdpTab[] {
    // The active tab FIRST: a client that attaches to "the first page" must land on what the user sees.
    return [...this.port.listTabs()].sort((a, b) => Number(b.active) - Number(a.active));
  }
  private targetInfo(t: CdpTab): Record<string, unknown> {
    const attached = [...this.clients].some((c) => [...c.sessions.values()].some((s) => s.tabId === t.id));
    return {
      targetId: this.targetIdFor(t.id),
      type: 'page',
      title: t.title,
      url: t.url,
      attached,
      canAccessOpener: false,
      browserContextId: this.browserContextId,
    };
  }
  jsonVersion(wsUrl: string): Record<string, string> {
    return {
      Browser: 'Chrome/orchestra-panel',
      'Protocol-Version': '1.3',
      'User-Agent': this.port.userAgent(),
      'V8-Version': '',
      'WebKit-Version': '',
      webSocketDebuggerUrl: wsUrl,
    };
  }
  /** Page-level websocket endpoints are NOT served (only the browser endpoint), so the list does not advertise any. */
  jsonList(_wsBase: string, devtoolsFrontendBase = ''): Array<Record<string, string>> {
    return this.tabsOrdered().map((t) => {
      const id = this.targetIdFor(t.id);
      return {
        description: '',
        devtoolsFrontendUrl: devtoolsFrontendBase,
        id,
        title: t.title,
        type: 'page',
        url: t.url,
      };
    });
  }
  async jsonNew(url?: string): Promise<CdpTab> {
    if (!this.port.createTab) throw new CdpError('creating tabs is not supported here');
    return this.port.createTab(url);
  }
  jsonActivate(targetId: string): boolean {
    const t = this.tabForTarget(targetId);
    if (!t) return false;
    this.port.activateTab(t.id);
    return true;
  }
  async jsonClose(targetId: string): Promise<boolean> {
    const t = this.tabForTarget(targetId);
    if (!t || !this.port.closeTab) return false;
    await this.port.closeTab(t.id);
    return true;
  }

  // ── clients ─────────────────────────────────────────────────────────────────
  connect(link: CdpClientLink): CdpClient {
    const tap = this.trace;
    const traced: CdpClientLink = tap ? { send: (m) => { tap('proxy->client', m); link.send(m); } } : link;
    const client: ClientState = { link: traced, sessions: new Map(), discover: false, closed: false };
    this.clients.add(client);
    return {
      message: (raw) => this.onMessage(client, raw),
      close: () => this.closeClient(client),
    };
  }
  clientCount(): number {
    return this.clients.size;
  }
  /** Tabs currently holding a debugger acquired by this proxy (observability / rig assertions). */
  attachedTabIds(): string[] {
    return [...this.tabs.keys()];
  }

  /**
   * In-process lease on a tab's debugger channel (#398): the app's own callers (design mode, the
   * legacy `mcp__browser__*` tools) ride the proxy's one attach instead of making a second one.
   * Refcounted with the WebSocket clients; `release()` is idempotent and a lease that outlived a
   * detach never decrements a newer attach.
   */
  async lease(tabId: string): Promise<{ channel: CdpTabChannel; release(): void }> {
    const st = await this.acquireTab(tabId);
    let held = true;
    return {
      channel: st.channel,
      release: () => {
        if (!held) return;
        held = false;
        if (this.tabs.get(tabId) === st) this.releaseTab(tabId);
      },
    };
  }

  dispose(): void {
    this.unsubTabs();
    for (const c of [...this.clients]) this.closeClient(c);
  }

  private closeClient(c: ClientState): void {
    if (c.closed) return;
    c.closed = true;
    this.clients.delete(c);
    for (const [, s] of c.sessions) if (s.tabId) this.releaseTab(s.tabId);
    c.sessions.clear();
  }

  private emit(c: ClientState, method: string, params: unknown, sessionId?: string): void {
    if (c.closed) return;
    try {
      c.link.send({ method, params, ...(sessionId ? { sessionId } : {}) });
    } catch {
      /* a dying socket must not break fan-out to the others */
    }
  }

  private reply(c: ClientState, id: unknown, result: unknown, sessionId?: string): void {
    if (c.closed) return;
    try {
      c.link.send({ id, result, ...(sessionId ? { sessionId } : {}) });
    } catch {
      /* closed */
    }
  }
  private replyError(c: ClientState, id: unknown, e: unknown, sessionId?: string): void {
    if (c.closed) return;
    const code = e instanceof CdpError ? e.code : ERR_SERVER;
    const message = e instanceof Error ? e.message : String(e);
    try {
      c.link.send({ id, error: { code, message }, ...(sessionId ? { sessionId } : {}) });
    } catch {
      /* closed */
    }
  }

  private async onMessage(c: ClientState, raw: string): Promise<void> {
    let msg: { id?: unknown; method?: unknown; params?: Record<string, unknown>; sessionId?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // not JSON: nothing to answer to (no id)
    }
    this.trace?.('client->proxy', msg);
    if (typeof msg.method !== 'string' || msg.id === undefined) return;
    const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : undefined;
    try {
      const result = await this.dispatch(c, msg.method, msg.params, sessionId);
      this.reply(c, msg.id, result ?? {}, sessionId);
    } catch (e) {
      this.replyError(c, msg.id, e, sessionId);
    }
  }

  private async dispatch(
    c: ClientState,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
  ): Promise<unknown> {
    if (!sessionId) return this.browserCommand(c, method, params);
    const own = c.sessions.get(sessionId);
    if (own?.kind === 'browser') return this.browserCommand(c, method, params);
    // Which tab does this session belong to — directly (a root tab session) or as an auto-attached child (iframe / worker) of a tab this client holds?
    let tabId: string | undefined;
    let childSessionId: string | undefined;
    if (own?.kind === 'tab') {
      tabId = own.tabId!;
    } else {
      for (const s of c.sessions.values()) {
        if (s.tabId && this.tabs.get(s.tabId)?.children.has(sessionId)) {
          tabId = s.tabId;
          childSessionId = sessionId;
          break;
        }
      }
    }
    if (!tabId) throw new CdpError('Session with given id not found.', ERR_SERVER);
    // Root AND child sessions reach the page's debugger, which would honour browser-level / destructive methods itself (Browser.close, Page.close,
    // Target.closeTarget …): those get the browser-level rules (close ownership, no-op Browser.close) BEFORE the child/root split.
    if (isBrowserLevelMethod(method)) {
      if (method === 'Page.close') return this.browserCommand(c, 'Target.closeTarget', { targetId: this.targetIdFor(tabId) });
      return this.browserCommand(c, method, params);
    }
    return this.tabCommand(tabId, method, params, childSessionId);
  }

  // ── browser-level surface ───────────────────────────────────────────────────
  private async browserCommand(c: ClientState, method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'Target.setDiscoverTargets': {
        c.discover = params?.discover === true;
        const result = {};
        if (c.discover) {
          // Chrome announces every existing target once discovery is on.
          queueMicrotask(() => {
            for (const t of this.port.listTabs()) this.emit(c, 'Target.targetCreated', { targetInfo: this.targetInfo(t) });
          });
        }
        return result;
      }
      case 'Target.getTargets':
        return { targetInfos: this.tabsOrdered().map((t) => this.targetInfo(t)) };
      case 'Target.getTargetInfo': {
        if (params?.targetId === undefined || params.targetId === this.browserTargetId) {
          return {
            targetInfo: { targetId: this.browserTargetId, type: 'browser', title: '', url: '', attached: true, canAccessOpener: false },
          };
        }
        const t = this.tabForTarget(params.targetId);
        if (!t) throw new CdpError('No target with given id found', ERR_SERVER);
        return { targetInfo: this.targetInfo(t) };
      }
      case 'Target.getBrowserContexts':
        return { browserContextIds: [this.browserContextId] };
      case 'Target.attachToTarget': {
        const t = this.tabForTarget(params?.targetId);
        if (!t) throw new CdpError('No target with given id found', ERR_SERVER);
        const sessionId = await this.attachTab(c, t);
        return { sessionId };
      }
      case 'Target.attachToBrowserTarget': {
        const sessionId = hex32();
        c.sessions.set(sessionId, { kind: 'browser' });
        return { sessionId };
      }
      case 'Target.detachFromTarget': {
        const sid = params?.sessionId;
        const s = typeof sid === 'string' ? c.sessions.get(sid) : undefined;
        if (!s || typeof sid !== 'string') throw new CdpError('Session with given id not found.', ERR_SERVER);
        c.sessions.delete(sid);
        if (s.tabId) {
          this.emit(c, 'Target.detachedFromTarget', { sessionId: sid, targetId: this.targetIdFor(s.tabId) });
          this.releaseTab(s.tabId);
        }
        return {};
      }
      case 'Target.activateTarget': {
        const t = this.tabForTarget(params?.targetId);
        if (!t) throw new CdpError('No target with given id found', ERR_SERVER);
        this.port.activateTab(t.id);
        return {};
      }
      case 'Target.createTarget': {
        if (!this.port.createTab) throw new CdpError('Target.createTarget is not supported by this panel', ERR_METHOD);
        const url = typeof params?.url === 'string' && params.url !== '' ? params.url : undefined;
        const tab = await this.port.createTab(url);
        return { targetId: this.targetIdFor(tab.id) };
      }
      case 'Target.closeTarget': {
        const t = this.tabForTarget(params?.targetId);
        if (!t) throw new CdpError('No target with given id found', ERR_SERVER);
        if (!this.port.closeTab) throw new CdpError('Target.closeTarget is not supported by this panel', ERR_METHOD);
        await this.port.closeTab(t.id);
        return { success: true };
      }
      case 'Target.setAutoAttach':
      case 'Target.setRemoteLocations':
        return {};
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: 'Chrome/orchestra-panel',
          revision: '',
          userAgent: this.port.userAgent(),
          jsVersion: '',
        };
      case 'Browser.close':
        return {}; // an agent must never close the human's panel
      // `set viewport` asks for the window around a target and resizes it; erroring here made agent-browser drop its connection.
      // The panel is not a window an agent may resize: answer with a fixed frame and accept (ignore) the resize.
      case 'Browser.getWindowForTarget':
        return { windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' } };
      case 'Browser.setWindowBounds':
      case 'Browser.setContentsSize':
        return {};
      default:
        throw new CdpError(`'${method}' wasn't found`, ERR_METHOD);
    }
  }

  // ── tab sessions ────────────────────────────────────────────────────────────
  /** Single-flight per tab: ONE `port.acquire` however many sessions attach at once (pre-review M1 — a second concurrent acquire used to be
   *  released while the tab was still held, arming the host's reset + detach under a live session). Every caller then takes its own ref. */
  private async acquireTab(tabId: string): Promise<TabState> {
    const have = this.tabs.get(tabId);
    if (have) {
      have.refs++;
      return have;
    }
    let flight = this.acquiring.get(tabId);
    if (!flight) {
      flight = (async () => {
        const channel = await this.port.acquire(tabId);
        const st: TabState = { channel, refs: 0, agent: false, unsub: [], children: new Set() };
        st.unsub.push(channel.subscribe((m, p, sid) => this.onTabEventFromDebugger(tabId, st, m, p, sid)));
        st.unsub.push(channel.onDetach((reason) => this.onDebuggerDetached(tabId, reason)));
        this.tabs.set(tabId, st);
        return st;
      })().finally(() => this.acquiring.delete(tabId));
      this.acquiring.set(tabId, flight);
    }
    const st = await flight;
    st.refs++;
    return st;
  }
  private releaseTab(tabId: string): void {
    const st = this.tabs.get(tabId);
    if (!st) return;
    if (--st.refs > 0) return;
    for (const u of st.unsub) u();
    this.tabs.delete(tabId);
    this.port.release(tabId, st.agent);
  }

  private async attachTab(c: ClientState, t: CdpTab): Promise<string> {
    const gen = this.generation.get(t.id) ?? 0;
    const st = await this.acquireTab(t.id);
    st.agent = true;
    if ((this.generation.get(t.id) ?? 0) !== gen || this.tabs.get(t.id) !== st) {
      // the page was REPLACED while the debugger was being acquired: the hold is on the old one (cleaned up with it, or given back here)
      if (this.tabs.get(t.id) === st) this.releaseTab(t.id);
      throw new CdpError('Target closed.', ERR_SERVER);
    }
    if (c.closed) {
      // the client went away while the debugger was being acquired: nobody will ever detach this session
      this.releaseTab(t.id);
      throw new CdpError('Target closed.', ERR_SERVER);
    }
    const sessionId = hex32();
    c.sessions.set(sessionId, { kind: 'tab', tabId: t.id });
    // Real Chrome announces the new session before answering the attach.
    this.emit(c, 'Target.attachedToTarget', {
      sessionId,
      targetInfo: { ...this.targetInfo(t), attached: true },
      waitingForDebugger: false,
    });
    return sessionId;
  }

  /** Does this navigation land on a browser-internal URL? A history entry is resolved to its URL first; a lookup that fails is refused (fail closed). */
  private async navigatesToInternalUrl(st: TabState, method: string, params: Record<string, unknown> | undefined, childSessionId: string | undefined): Promise<boolean> {
    if (method === 'Page.navigate') return isBrowserInternalUrl(params?.url);
    try {
      const h = (await st.channel.send('Page.getNavigationHistory', {}, childSessionId)) as { entries?: Array<{ id?: unknown; url?: unknown }> } | undefined;
      return isBrowserInternalUrl(h?.entries?.find((e) => e.id === params?.entryId)?.url);
    } catch {
      return true;
    }
  }

  private async tabCommand(
    tabId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    childSessionId: string | undefined,
  ): Promise<unknown> {
    const st = this.tabs.get(tabId);
    if (!st) throw new CdpError('Target closed.', ERR_SERVER);
    if (TUNNEL_METHODS.has(method)) throw new CdpError(`${method} is not supported: this proxy speaks flattened sessions only`, ERR_METHOD);
    if (TAB_DESTROYING_METHODS.has(method)) {
      // Ownership is not only about closing (#397 round-2 INFO): a renderer-killer reaches the tab through the page debugger like any command, root or child session.
      const owner = this.port.listTabs().find((t) => t.id === tabId);
      if (owner && owner.openedBy !== 'agent') {
        throw new CdpError(`${method} is refused: tab ${tabId} was opened by the user — an agent may only destroy the tabs it opened.`, ERR_SERVER);
      }
    }
    if (method === 'Page.navigate' || method === 'Page.navigateToHistoryEntry') {
      // #397 F4: `chrome://crash|kill|hang` / `about:crash` wedge the renderer like Page.crash does — an agent-opened tab may go anywhere, the user's may not (root + child sessions).
      const owner = this.port.listTabs().find((t) => t.id === tabId);
      if (owner && owner.openedBy !== 'agent' && (await this.navigatesToInternalUrl(st, method, params, childSessionId))) {
        throw new CdpError(internalNavigationRefusal(method, tabId), ERR_SERVER);
      }
    }
    if (this.port.refuseMethod) {
      const tab = this.port.listTabs().find((t) => t.id === tabId);
      if (!tab) throw new CdpError('Target closed.', ERR_SERVER);
      // STRICT verdict contract: ONLY `null` allows. A non-empty string refuses with that text; EVERYTHING else — '', 0, false, undefined (a present
      // hook that forgot to return), a Promise (an async hook), an object — and a throw refuse fail-CLOSED with a generic message (the exception text
      // never reaches the agent: it may carry internals).
      let verdict: unknown;
      try {
        verdict = this.port.refuseMethod(method, params, tab);
      } catch {
        throw new CdpError(`${method} refused: the policy check failed`, ERR_SERVER);
      }
      if (verdict === null) {
        /* allowed */
      } else if (typeof verdict === 'string' && verdict !== '') {
        throw new CdpError(verdict, ERR_SERVER);
      } else {
        if (verdict instanceof Promise) verdict.catch(() => undefined); // an async hook must not leave an unhandled rejection behind
        throw new CdpError(`${method} refused: policy returned an invalid verdict`, ERR_SERVER);
      }
    }
    if (!childSessionId && method === 'Page.bringToFront') {
      this.port.activateTab(tabId);
      return {};
    }
    // Story 43 (#397): ANY agent action on a tab nobody looks at brings it to the front (the port applies the focus rule — a
    // background workspace's agent never shows a view); domain enables and attach-time calls are not actions. A CHILD (frame) session
    // is the same tab: its commands count too, and its Input.* meets the same fail-fast (review F3: a hidden pane queues them).
    if (isActingCdpMethod(method)) this.bringToFrontIfBackground(tabId);
    if (FRAME_BOUND_METHODS.has(method)) {
      const why = this.port.framesError(tabId);
      if (why) throw new CdpError(why, ERR_SERVER);
    }
    if (!childSessionId && method === 'Page.captureScreenshot') return this.screenshot(tabId, st, params ?? {});
    this.trace?.('proxy->debugger', { method, params, sessionId: childSessionId });
    return st.channel.send(method, params, childSessionId).then(
      (r) => {
        this.trace?.('debugger->proxy', { method, result: r });
        return r;
      },
      (e) => {
        this.trace?.('debugger->proxy', { method, error: e instanceof Error ? e.message : String(e) });
        throw e;
      },
    );
  }

  /** An agent action on a tab nobody is looking at brings it to the front first (no hidden-view painting yet, ADR 0009). */
  private bringToFrontIfBackground(tabId: string): void {
    const t = this.port.listTabs().find((x) => x.id === tabId);
    if (t && !t.active) this.port.activateTab(tabId);
  }

  private async screenshot(tabId: string, st: TabState, params: Record<string, unknown>): Promise<unknown> {
    this.bringToFrontIfBackground(tabId);
    const why = this.port.framesError(tabId);
    if (why) throw new CdpError(why, ERR_SERVER);
    const format: 'png' | 'jpeg' = params.format === 'jpeg' ? 'jpeg' : 'png';
    const quality = typeof params.quality === 'number' ? params.quality : undefined;
    const canFallback = params.clip === undefined && params.captureBeyondViewport !== true;
    const r = await captureWithFallback({
      primary: async () => ((await st.channel.send('Page.captureScreenshot', params)) as { data: string }).data,
      probe: () =>
        st.channel.send('Page.captureScreenshot', { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } }),
      invalidate: () => this.port.invalidate(tabId),
      fallback: canFallback ? () => this.port.captureFallback(tabId, format, quality) : null,
    });
    return { data: r.data };
  }

  // ── events ──────────────────────────────────────────────────────────────────
  private onTabEventFromDebugger(tabId: string, st: TabState, method: string, params: unknown, sessionId?: string): void {
    if (sessionId) {
      st.children.add(sessionId);
    } else if (method === 'Target.attachedToTarget') {
      const child = (params as { sessionId?: string } | undefined)?.sessionId;
      if (child) st.children.add(child);
    }
    if (method === 'Target.detachedFromTarget') {
      const child = (params as { sessionId?: string } | undefined)?.sessionId;
      if (child) st.children.delete(child);
    }
    for (const c of this.clients) {
      for (const [csid, s] of c.sessions) {
        if (s.kind === 'tab' && s.tabId === tabId) this.emit(c, method, params, sessionId ?? csid);
      }
    }
  }

  private onDebuggerDetached(tabId: string, reason: string): void {
    const st = this.tabs.get(tabId);
    if (st) {
      for (const u of st.unsub) u();
      this.tabs.delete(tabId); // the debugger is gone: nothing to release
    }
    for (const c of this.clients) {
      for (const [csid, s] of [...c.sessions]) {
        if (s.tabId !== tabId) continue;
        c.sessions.delete(csid);
        this.emit(c, 'Target.detachedFromTarget', { sessionId: csid, targetId: this.targetIdFor(tabId), reason });
      }
    }
  }

  /** The page behind a tab id was replaced: its sessions are dead (detach, under the OLD target id), then the client hears the NEW target created BEFORE
   *  the old one is destroyed, so a client that tracks pages never has an empty moment in between. */
  private onTabReplaced(tab: CdpTab): void {
    const oldTarget = this.targetIdFor(tab.id);
    this.onDebuggerDetached(tab.id, 'target closed');
    this.generation.set(tab.id, (this.generation.get(tab.id) ?? 0) + 1);
    this.known.set(tab.id, tab);
    for (const c of this.clients) {
      if (!c.discover) continue;
      this.emit(c, 'Target.targetCreated', { targetInfo: this.targetInfo(tab) });
      this.emit(c, 'Target.targetDestroyed', { targetId: oldTarget });
    }
  }

  private onTabEvent(e: CdpTabEvent): void {
    if (e.kind === 'replaced') return this.onTabReplaced(e.tab);
    if (e.kind === 'created') this.known.set(e.tab.id, e.tab);
    if (e.kind === 'destroyed') {
      this.known.delete(e.tab.id);
      this.onDebuggerDetached(e.tab.id, 'target closed');
    }
    const method = e.kind === 'created' ? 'Target.targetCreated' : e.kind === 'changed' ? 'Target.targetInfoChanged' : 'Target.targetDestroyed';
    for (const c of this.clients) {
      if (!c.discover) continue;
      this.emit(c, method, e.kind === 'destroyed' ? { targetId: this.targetIdFor(e.tab.id) } : { targetInfo: this.targetInfo(e.tab) });
    }
  }
}
