/**
 * Host side of `orchestra browser` (#395, ADR 0009): one loopback CDP proxy per workspace over its
 * panel tabs (`browser-cdp-proxy.ts`), the host-owned agent-browser daemon behind it
 * (`agent-browser-daemon.ts`), and the `/browser` socket route that hands the calling workspace —
 * and only it — its endpoint. The workspace is resolved per call from `{id, session key}` (ADR 0008):
 * there is no argument that names another workspace's panel.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import * as bp from './browser-panel.ts';
import { startCdpProxy, type CdpProxyServer } from './browser-cdp-proxy.ts';
import {
  abEnv,
  abLayout,
  closeDaemon,
  ensureDaemon,
  installBinary,
  listSessions,
  prepareLayout,
  type AbLayout,
} from './agent-browser-daemon.ts';
import { orchestraHome } from './platform/index.ts';
import { sessionKeys } from './session-identity-host.ts';
import { store } from './store.ts';
import { scoped } from './logger.ts';
import { AGENT_BROWSER_VERSION, binaryCandidates } from '../shared/agent-browser-binary.ts';
import type { CdpPanelPort, CdpTab, CdpTabChannel, CdpTabEvent } from '../shared/cdp-proxy-core.ts';
import type { BrowserTabInfo } from '../shared/types.ts';

const blog = scoped('browser-cli');

/** Interim cap until the tab policy (#393/#397) sits in front of `createTab`: the spec's 8 per workspace. */
const INTERIM_TAB_CAP = 8;

const toCdpTab = (t: BrowserTabInfo): CdpTab => ({ id: t.id, url: t.url, title: t.title, active: t.active, openedBy: t.openedBy });

/** The proxy's view of one workspace's panel — the only code that maps CDP semantics onto `browser-panel.ts`. */
export function makePanelPort(wsId: string): CdpPanelPort {
  const channelFor = (tabId: string): CdpTabChannel => {
    const wc = bp.tabContents(wsId, tabId);
    if (!wc) throw new Error(`browser tab ${tabId} has no live view`);
    const dbg = wc.debugger;
    return {
      send: (method, params, sessionId) => dbg.sendCommand(method, params ?? {}, sessionId),
      subscribe: (l) => {
        const f = (_e: unknown, method: string, params: unknown, sessionId?: string): void => l(method, params, sessionId || undefined);
        dbg.on('message', f);
        return () => {
          dbg.off('message', f);
        };
      },
      onDetach: (l) => {
        const f = (_e: unknown, reason: string): void => l(reason);
        dbg.on('detach', f);
        return () => {
          dbg.off('detach', f);
        };
      },
    };
  };

  return {
    listTabs: () => bp.listTabs(wsId).map(toCdpTab),
    subscribeTabs: (listener) => {
      let prev = new Map(bp.listTabs(wsId).map((t) => [t.id, t]));
      return bp.onPanelChange((id, tabs, destroyed) => {
        if (id !== wsId) return;
        const next = new Map(tabs.map((t) => [t.id, t]));
        const events: CdpTabEvent[] = [];
        for (const [tid, t] of next) {
          const was = prev.get(tid);
          if (!was) events.push({ kind: 'created', tab: toCdpTab(t) });
          else if (was.url !== t.url || was.title !== t.title || was.active !== t.active) events.push({ kind: 'changed', tab: toCdpTab(t) });
        }
        for (const [tid, t] of prev) if (!next.has(tid)) events.push({ kind: 'destroyed', tab: toCdpTab(t) });
        prev = next;
        void destroyed;
        for (const e of events) listener(e);
      });
    },
    acquire: async (tabId) => {
      const tab = bp.getTab(wsId, tabId);
      const wc = bp.tabContents(wsId, tabId);
      if (!tab || !wc) throw new Error(`browser tab ${tabId} has no live view`);
      // A tab that never navigated has no renderer: `Runtime.evaluate` on it hangs, and agent-browser gives up on the connect ("tab is not responding").
      if (!wc.getURL()) {
        await Promise.race([wc.loadURL('about:blank').catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
      }
      // Shared with the legacy mcp__browser__* path (one attach per target): attach only if nobody has.
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      tab.debuggerAttached = true;
      wc.debugger.once('detach', () => {
        tab.debuggerAttached = false;
      });
      return channelFor(tabId);
    },
    // The legacy tools and design mode still share this debugger; #398 makes the proxy its only owner and detaches here.
    release: () => undefined,
    createTab: async (url) => {
      if (bp.listTabs(wsId).length >= INTERIM_TAB_CAP) throw new Error(`this workspace already has ${INTERIM_TAB_CAP} browser tabs`);
      const tab = bp.createTab(wsId, { ...(url ? { url } : {}), openedBy: 'agent', activate: true });
      const info = bp.listTabs(wsId).find((t) => t.id === tab.id);
      if (!info) throw new Error('the new browser tab disappeared');
      return toCdpTab(info);
    },
    closeTab: async (tabId) => {
      const tab = bp.getTab(wsId, tabId);
      if (!tab) throw new Error(`browser tab ${tabId} not found`);
      if (tab.openedBy !== 'agent') throw new Error(`browser tab ${tabId} was opened by the user: an agent may only close tabs it opened`);
      bp.closeTab(wsId, tabId);
    },
    activateTab: (tabId) => {
      try {
        bp.activateTab(wsId, tabId);
      } catch {
        /* the tab closed meanwhile */
      }
    },
    userAgent: () => {
      const active = bp.getActiveTab(wsId);
      return (active && bp.tabContents(wsId, active.id)?.getUserAgent()) || 'Mozilla/5.0 Chrome';
    },
    invalidate: (tabId) => {
      try {
        bp.tabContents(wsId, tabId)?.invalidate();
      } catch {
        /* best effort */
      }
    },
    captureFallback: async (tabId, format, quality) => {
      const wc = bp.tabContents(wsId, tabId);
      if (!wc) throw new Error(`browser tab ${tabId} has no live view`);
      const img = await wc.capturePage();
      return (format === 'jpeg' ? img.toJPEG(Math.max(0, Math.min(100, quality ?? 80))) : img.toPNG()).toString('base64');
    },
    framesError: (tabId) => {
      const panel = bp.getPanel(wsId);
      if (!panel) return 'the browser panel is gone';
      if (panel.attachedId === null) {
        return "this workspace's Browser pane is not on screen (the workspace is in the background or its pane is closed): clicks, typing and screenshots need it visible. snapshot, eval, get and open still work — ask the user to open this workspace's Browser pane.";
      }
      if (panel.attachedId !== tabId) return `tab ${tabId} is not on screen`;
      return null;
    },
  };
}

// ── endpoints (one proxy + one daemon session per workspace) ──────────────────

interface Endpoint {
  wsId: string;
  server: CdpProxyServer;
  /** Unguessable per proxy instance: it is the daemon's socket name. */
  session: string;
}
const endpoints = new Map<string, Promise<Endpoint>>();
let layoutCache: AbLayout | null = null;

function layout(): AbLayout {
  if (!layoutCache) {
    layoutCache = abLayout(orchestraHome(), process.env.XDG_RUNTIME_DIR);
    prepareLayout(layoutCache);
  }
  return layoutCache;
}

export function ensureEndpoint(wsId: string): Promise<Endpoint> {
  let p = endpoints.get(wsId);
  if (!p) {
    p = (async () => {
      bp.ensurePanel(wsId);
      const trace = process.env.ORCHESTRA_CDP_TRACE
        ? (dir: string, m: unknown): void => blog.info(`cdp[${wsId.slice(0, 8)}] ${dir} ${JSON.stringify(m).slice(0, 400)}`)
        : undefined;
      const server = await startCdpProxy(makePanelPort(wsId), trace ? { trace } : {});
      blog.info(`cdp proxy for ${wsId} on 127.0.0.1:${server.port}`);
      return { wsId, server, session: randomBytes(6).toString('hex') };
    })();
    endpoints.set(wsId, p);
    p.catch(() => {
      if (endpoints.get(wsId) === p) endpoints.delete(wsId);
    });
  }
  return p;
}

let abBinary: string | null = null;
/** The bundled agent-browser, copied out of the app bundle on first use. Throws a fix-it message when absent. */
export function agentBrowserBinary(): string {
  if (abBinary && fs.existsSync(abBinary)) return abBinary;
  const found = binaryCandidates({
    ...(process.env.ORCHESTRA_AGENT_BROWSER_BIN ? { override: process.env.ORCHESTRA_AGENT_BROWSER_BIN } : {}),
    ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {}),
    appPath: app.getAppPath(),
  }).find((c) => fs.existsSync(c));
  if (!found) {
    throw new Error('the bundled agent-browser is missing from this build (run `pnpm run fetch:agent-browser`, then rebuild)');
  }
  abBinary = installBinary(found, layout(), AGENT_BROWSER_VERSION);
  return abBinary;
}

export async function disposeEndpoint(wsId: string): Promise<void> {
  const p = endpoints.get(wsId);
  if (!p) return;
  endpoints.delete(wsId);
  try {
    const ep = await p;
    await closeDaemon(agentBrowserBinary(), layout(), ep.session);
    await ep.server.close();
    blog.info(`cdp proxy for ${wsId} closed`);
  } catch (e) {
    blog.warn(`closing the browser endpoint of ${wsId} failed`, e);
  }
}

export async function disposeAllEndpoints(): Promise<void> {
  await Promise.all([...endpoints.keys()].map((id) => disposeEndpoint(id)));
}

let started = false;
/** Called once at boot: close daemons left by an earlier app run, and follow panel teardown. */
export function initBrowserCliHost(): void {
  if (started) return;
  started = true;
  bp.onPanelChange((wsId, _tabs, destroyed) => {
    if (destroyed) void disposeEndpoint(wsId);
  });
  void (async () => {
    try {
      const l = layout();
      const stale = listSessions(l);
      if (stale.length === 0) return;
      const bin = agentBrowserBinary();
      await Promise.all(stale.map((s) => closeDaemon(bin, l, s)));
      blog.info(`closed ${stale.length} agent-browser daemon(s) of an earlier run`);
    } catch (e) {
      blog.warn('stale agent-browser sweep failed', e);
    }
  })();
}

// ── the /browser route ────────────────────────────────────────────────────────

export type BrowserReply =
  | { ok: true; binary: string; wsUrl: string; env: Record<string, string> }
  | { ok: false; code: 'superseded' | 'unregistered' | 'unknown-workspace' | 'unavailable'; error: string };

/**
 * `{id, key, shotDir?}` → this workspace's agent-browser endpoint. The host answers only the live
 * session of workspace `id` (hash of its session key, ADR 0008): no key, a stale key or a key of
 * another workspace is REFUSED — unlike the bus there is no env fallback, because a browser command
 * acts on a panel, not on a message queue.
 */
export async function dispatchBrowserRequest(msg: Record<string, unknown>): Promise<BrowserReply> {
  const id = typeof msg.id === 'string' ? msg.id.trim() : '';
  const key = typeof msg.key === 'string' ? msg.key.trim() : '';
  if (!id || !key) {
    return { ok: false, code: 'unregistered', error: 'orchestra browser needs a live Orchestra session (no session key in this shell) — run it from the agent\'s own terminal' };
  }
  const verdict = sessionKeys().verify(id, key);
  if (verdict === 'superseded') {
    return { ok: false, code: 'superseded', error: 'this session was replaced by a newer one for the same workspace — it may not drive the browser panel' };
  }
  if (verdict === 'unregistered') {
    return { ok: false, code: 'unregistered', error: 'the host cannot vouch for this session (it holds no session key for the workspace) — restart the workspace session' };
  }
  if (!store.getWorkspace(id)) return { ok: false, code: 'unknown-workspace', error: `unknown workspace ${id}` };
  try {
    const ep = await ensureEndpoint(id);
    bp.revealForAgent(id);
    const l = layout();
    const binary = agentBrowserBinary();
    await ensureDaemon(binary, l, ep.session, ep.server.wsUrl);
    const shot = typeof msg.shotDir === 'string' && path.isAbsolute(msg.shotDir) ? msg.shotDir : undefined;
    return { ok: true, binary, wsUrl: ep.server.wsUrl, env: abEnv(l, ep.session, shot) };
  } catch (e) {
    return { ok: false, code: 'unavailable', error: e instanceof Error ? e.message : String(e) };
  }
}
