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
import { seatAcquire, seatChannel, seatForceDetach, seatRelease, setSeatTrace } from './browser-cdp-seat.ts';
import {
  abEnv,
  abLayout,
  closeDaemon,
  ensureDaemon,
  terminateDaemonsOf,
  removeSocketDir,
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
import { sendOnLease, type CdpPanelPort, type CdpTab, type CdpTabChannel, type CdpTabEvent } from '../shared/cdp-proxy-core.ts';
import { decideAgentCdp } from '../shared/browser-profile.ts';
import type { BrowserTabInfo } from '../shared/types.ts';

const blog = scoped('browser-cli');

/** Interim cap until the tab policy (#393/#397) sits in front of `createTab`: the spec's 8 per workspace. */
const INTERIM_TAB_CAP = 8;

/** How long a tab keeps the agent's CDP state after its last session left (`ORCHESTRA_CDP_RELEASE_GRACE_MS` overrides it for rigs). */
const RELEASE_GRACE_MS = Number(process.env.ORCHESTRA_CDP_RELEASE_GRACE_MS) > 0 ? Number(process.env.ORCHESTRA_CDP_RELEASE_GRACE_MS) : 15_000;

/** A lease command that has not settled by now is abandoned and its lease given back (the legacy tools' own `withTimeout`s are 10 s; this is the backstop for any command). */
const LEASE_SEND_MAX_MS = 120_000;

const toCdpTab = (t: BrowserTabInfo): CdpTab => ({ id: t.id, url: t.url, title: t.title, active: t.active, openedBy: t.openedBy });

/** The proxy's view of one workspace's panel — the only code that maps CDP semantics onto `browser-panel.ts`. */
export function makePanelPort(wsId: string): CdpPanelPort {
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
      // A tab that never navigated (and has no load in flight — a fresh `createTab({url})` must not be overwritten) has no renderer: `Runtime.evaluate` on it hangs, and agent-browser gives up on the connect ("tab is not responding").
      if (!wc.getURL() && !wc.isLoading()) {
        await Promise.race([wc.loadURL('about:blank').catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
      }
      // The proxy is the ONLY attacher (#398): design mode and the legacy tools lease this same attach (`attachLease`). The seat
      // shares it by refcount; the last holder leaving starts the grace period, then the agent's overrides are reset and it detaches.
      const live = bp.tabContents(wsId, tabId);
      if (!live) throw new Error(`browser tab ${tabId} has no live view`);
      const channel = seatChannel(live);
      seatAcquire(live, `seat[${wsId.slice(0, 8)}] ${tabId}`);
      return channel;
    },
    release: (tabId, agentTouched) => {
      const live = bp.tabContents(wsId, tabId);
      if (live) seatRelease(live, RELEASE_GRACE_MS, agentTouched ?? true);
    },
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
      // A never-painted view answers with an EMPTY 0x0 image (browser-panel.md), which must read as a failure, not as a screenshot.
      if (img.isEmpty()) throw new Error('capturePage() returned an empty image (the view has no painted frame)');
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
    // #400: while this workspace's panel runs on a profil navigateur (shared with other workspaces and sites), an agent may not clear its jar or
    // read/alter another site's cookies — judged on the call's params and the TARGETED tab's url (shared/browser-profile.ts decideAgentCdp).
    // Read at call time (`panelProfileId`): a profile attached or deleted mid-session applies to the very next command.
    refuseMethod: (method, params, tab) => {
      const d = decideAgentCdp({ method, params, profileId: bp.panelProfileId(wsId), pageUrl: tab.url, frameUrls: bp.tabFrameUrls(wsId, tab.id) });
      // The core judges TRUTHINESS: a refusal must be a NON-EMPTY string on every path ('' / undefined would fail OPEN) — hence the fallback text.
      return d.ok ? null : d.message || 'refused: the profil navigateur policy of this workspace forbids this command';
    },
  };
}

// ── endpoints (one proxy + one daemon session per workspace) ──────────────────

interface Endpoint {
  wsId: string;
  server: CdpProxyServer;
  /** Unguessable per proxy instance: it is the daemon's socket name. */
  session: string;
  /** `ensureDaemon` ran for this endpoint: only then is there a daemon to close (design mode alone starts none). */
  daemon: boolean;
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
      return { wsId, server, session: randomBytes(6).toString('hex'), daemon: false };
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
  let ep: Endpoint;
  try {
    ep = await p;
  } catch {
    return; // it never came up: nothing to close
  }
  if (ep.daemon) {
    try {
      await closeDaemon(agentBrowserBinary(), layout(), ep.session);
    } catch (e) {
      blog.warn(`closing the agent-browser daemon of ${wsId} failed`, e); // the proxy below must close regardless
    }
  }
  try {
    await ep.server.close();
    blog.info(`cdp proxy for ${wsId} closed`);
  } catch (e) {
    blog.warn(`closing the cdp proxy of ${wsId} failed`, e);
  }
}

export async function disposeAllEndpoints(): Promise<void> {
  // Quit does not wait for the graceful `close` below: SIGTERM our daemons first, synchronously (identity re-read per pid).
  try {
    terminateDaemonsOf(layout());
  } catch (e) {
    blog.warn('terminating agent-browser daemons at quit failed', e);
  }
  await Promise.all([...endpoints.keys()].map((id) => disposeEndpoint(id)));
  try {
    removeSocketDir(layout()); // this ORCHESTRA_HOME's hashed dir only; the daemons are gone, nothing else lives there
  } catch (e) {
    blog.warn('removing the agent-browser socket dir failed', e);
  }
}

// ── in-process access (#398): design mode + the legacy tools ride the proxy's attach ──────────

async function attachLease(wsId: string, tabId: string): Promise<{ channel: CdpTabChannel; release(): void }> {
  // Same tick as `ensureEndpoint`'s `ensurePanel`: a panel destroyed an instant ago (archive/delete) must not be rebuilt for a late poll.
  if (!bp.tabContents(wsId, tabId)) throw new Error(`browser tab ${tabId} has no live view`);
  const ep = await ensureEndpoint(wsId);
  return ep.server.core.lease(tabId);
}

/** What `browser-panel.ts` calls instead of attaching anything itself. */
export const panelCdpSeat: bp.CdpSeat = {
  async send(wsId, tabId, method, params) {
    return sendOnLease(await attachLease(wsId, tabId), method, params, LEASE_SEND_MAX_MS);
  },
  async hold(wsId, tabId) {
    return (await attachLease(wsId, tabId)).release;
  },
};

let started = false;
/** Called once at boot: close daemons left by an earlier app run, and follow panel teardown. */
export function initBrowserCliHost(): void {
  if (started) return;
  started = true;
  bp.setCdpSeat(panelCdpSeat);
  bp.setTabTeardownHook((wc) => seatForceDetach(wc));
  if (process.env.ORCHESTRA_CDP_TRACE) setSeatTrace((line) => blog.info(line));
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
  const ws = store.getWorkspace(id);
  if (!ws) return { ok: false, code: 'unknown-workspace', error: `unknown workspace ${id}` };
  // An archived workspace has no panel any more (destroyPanel): a late call from a leftover shell must not resurrect one.
  if (ws.archived) return { ok: false, code: 'unknown-workspace', error: `workspace ${id} is archived` };
  try {
    const pending = ensureEndpoint(id);
    const ep = await pending;
    // The workspace may have been archived / deleted while the proxy came up (destroyPanel disposes it): do not reveal, connect or resurrect.
    const again = store.getWorkspace(id);
    if (endpoints.get(id) !== pending || !again || again.archived) {
      return { ok: false, code: 'unknown-workspace', error: `workspace ${id} was closed while its browser endpoint was starting` };
    }
    ep.daemon = true; // before ensureDaemon below: a connect that fails after spawning its daemon must still be closed at dispose
    bp.revealForAgent(id);
    const l = layout();
    prepareLayout(l); // idempotent mkdir: a socket dir that vanished (runtime dir cleaned, a rig's teardown) must not fail every call until restart
    const binary = agentBrowserBinary();
    await ensureDaemon(binary, l, ep.session, ep.server.wsUrl);
    const shot = typeof msg.shotDir === 'string' && path.isAbsolute(msg.shotDir) ? msg.shotDir : undefined;
    // the URL travels in the client's ENVIRONMENT (AGENT_BROWSER_CDP), not its argv: cmdline is world-readable on this host, environ is not
    return { ok: true, binary, wsUrl: ep.server.wsUrl, env: { ...abEnv(l, ep.session, shot), AGENT_BROWSER_CDP: ep.server.wsUrl } };
  } catch (e) {
    return { ok: false, code: 'unavailable', error: e instanceof Error ? e.message : String(e) };
  }
}
