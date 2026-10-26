/**
 * What the CDP proxy is told when a workspace's panel changes (#400, seat-2 MAJOR). A tab id names ONE page for a client: when the panel
 * REBUILDS a tab in place (a profile attach / detach / delete keeps the ids but swaps every webContents) the page behind the id is a
 * different one, so it must read as REPLACED — a `changed` leaves the agent-browser daemon on a dead session for good.
 * Pure: the host (`browser-cdp-host.ts`) supplies the view identity (Electron `webContents.id`); `undefined` = unknown, never "replaced".
 */
import type { CdpTab, CdpTabEvent } from './cdp-proxy-core.ts';

export interface DiffTab {
  tab: CdpTab;
  /** Identity of the live view behind the tab (`webContents.id`), or undefined when none can be read. */
  view: number | undefined;
}

export function diffTabs(prev: ReadonlyMap<string, DiffTab>, next: ReadonlyMap<string, DiffTab>): CdpTabEvent[] {
  const events: CdpTabEvent[] = [];
  for (const [id, now] of next) {
    const was = prev.get(id);
    if (!was) {
      events.push({ kind: 'created', tab: now.tab });
    } else if (was.view !== undefined && now.view !== undefined && was.view !== now.view) {
      // same id, different page: the sessions on the old one are dead and the client must learn the page was replaced (a NEW target)
      events.push({ kind: 'replaced', tab: now.tab });
    } else if (was.tab.url !== now.tab.url || was.tab.title !== now.tab.title || was.tab.active !== now.tab.active) {
      events.push({ kind: 'changed', tab: now.tab });
    }
  }
  for (const [id, was] of prev) if (!next.has(id)) events.push({ kind: 'destroyed', tab: was.tab });
  return events;
}
