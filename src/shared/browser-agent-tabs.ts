// Agent tab rules (#397, ADR 0009) — PURE: no Electron, no sockets. The decisions the proxy, the panel and the CLI share when an AGENT
// drives the panel's tabs; the cap and close ownership themselves stay in browser-tab-policy.ts (#393) — this file only adds
//   - WHEN an agent action brings a tab to the front (focused workspace only: a background workspace never attaches or shows a view),
//   - WHICH CDP methods count as an agent "action" on a tab (a domain enable or a session-setup call must not swap the human's tab),
//   - the `orchestra browser tab ...` CLI half: parse the invocation, resolve agent-browser's tab ref, refuse a close of a tab the
//     user opened BEFORE agent-browser sees it (it prints "Tab closed" and drops the tab from its own list whatever the proxy answers).

import { AGENT_OPENER, decideTabClose, type PolicyTab } from './browser-tab-policy.ts';
import type { BrowserTabOpener } from './types.ts';

// ---- bring to front ----------------------------------------------------------------------------------------------------

export type AgentFrontDecision =
  | { act: 'activate' }
  | { act: 'none'; reason: 'unknown-tab' | 'already-active' | 'background-workspace' };

/**
 * An agent acts on `tabId`: does it come to the front? Only in the workspace whose panel the renderer composites
 * (`wsFocused`) — activating in any other workspace would swap a view nobody sees, and the spec's focus rule is that a
 * background agent never attaches or shows its view (user story 44). Until a hidden view can paint (#402) the tab an
 * agent works on must be the one on screen (story 43).
 */
export function decideAgentFront(i: { wsFocused: boolean; activeId: string | null; tabId: string; tabExists: boolean }): AgentFrontDecision {
  if (!i.tabExists) return { act: 'none', reason: 'unknown-tab' };
  if (i.activeId === i.tabId) return { act: 'none', reason: 'already-active' };
  if (!i.wsFocused) return { act: 'none', reason: 'background-workspace' };
  return { act: 'activate' };
}

/** Session-setup / subscription calls `agent-browser` sends when it (re)attaches to a tab: measured on v0.39.2 — they must not swap the human's tab. */
const PASSIVE_METHODS: ReadonlySet<string> = new Set([
  'Runtime.runIfWaitingForDebugger',
  'Target.setAutoAttach',
  'Page.getFrameTree',
]);

/**
 * Does this tab-level CDP method count as an agent ACTION on the tab (and so bring it to the front)? Everything except domain
 * enable/disable and the attach-time calls in {@link PASSIVE_METHODS}: an unknown method is an action, because a tab the
 * agent works on that the human cannot see is the failure story 43 names, while a passive miss only costs one visible swap.
 */
export function isActingCdpMethod(method: string): boolean {
  if (/\.(enable|disable)$/.test(method)) return false;
  return !PASSIVE_METHODS.has(method);
}

// ---- host: ownership view of the panel's tabs ----------------------------------------------------------------------------

export interface AgentTabView {
  /** The proxy's hex target id (what `agent-browser tab list --json` prints as `targetId`). */
  targetId: string;
  openedBy: BrowserTabOpener;
  active: boolean;
  /** May an AGENT close it? (decideTabClose with actor `agent`, so the CLI and the proxy cannot disagree.) */
  closable: boolean;
  /** Why not, when `closable` is false — safe to show the agent as-is. */
  reason?: string;
}

/** The panel's tabs as the agent's CLI needs them: who opened each, and whether the agent may close it. */
export function describeAgentTabs(
  tabs: ReadonlyArray<PolicyTab & { active?: boolean }>,
  activeId: string | null,
  targetIdFor: (tabId: string) => string,
  agent: BrowserTabOpener,
): AgentTabView[] {
  return tabs.map((t) => {
    const d = decideTabClose({ tabs, activeId, tabId: t.id, actor: agent });
    return {
      targetId: targetIdFor(t.id),
      openedBy: t.openedBy,
      active: t.id === activeId,
      closable: d.ok,
      ...(d.ok ? {} : { reason: d.message }),
    };
  });
}

// ---- CLI: `orchestra browser tab ...` -----------------------------------------------------------------------------------

export type TabOp = 'list' | 'new' | 'close' | 'switch';
export interface TabInvocation {
  op: TabOp;
  /**
   * Every candidate tab ref of `close <ref>` / `<ref>` (switch): tN ids, labels or CDP target ids. ALL non-flag tokens, not just the first: agent-browser
   * accepts value-taking globals around the subcommand (`tab close --timeout 3000 t1`), and the CLI cannot know their arity — a ref hiding behind a flag value
   * must still be seen. Empty for `close` of the current tab.
   */
  refs: string[];
  json: boolean;
}

/** Parse `argv` of `orchestra browser` when its command is `tab`; null for any other command. */
export function parseTabInvocation(argv: readonly string[]): TabInvocation | null {
  const idx = argv.findIndex((a) => !a.startsWith('-'));
  if (idx === -1 || argv[idx] !== 'tab') return null;
  const json = argv.includes('--json');
  const words = argv.slice(idx + 1).filter((a) => !a.startsWith('-'));
  const opAt = words.findIndex((w) => w === 'list' || w === 'new' || w === 'close');
  if (opAt === -1) return words.length === 0 ? { op: 'list', refs: [], json } : { op: 'switch', refs: words, json };
  const op = words[opAt] as 'list' | 'new' | 'close';
  if (op !== 'close') return { op, refs: [], json };
  return { op, refs: words.filter((_, i) => i !== opAt), json };
}

/** One tab as `agent-browser --json tab list` prints it. */
export interface AbTab {
  tabId: string;
  label: string | null;
  targetId: string;
  active: boolean;
  title?: string;
  url?: string;
}

/** Parse the `--json tab list` document; null when it is not one (the caller then stays out of the way). */
export function parseAbTabList(stdout: string): AbTab[] | null {
  try {
    const doc = JSON.parse(stdout.trim()) as { success?: boolean; data?: { tabs?: unknown } };
    if (doc.success !== true || !Array.isArray(doc.data?.tabs)) return null;
    const tabs: AbTab[] = [];
    for (const t of doc.data!.tabs as Array<Record<string, unknown>>) {
      if (typeof t.tabId !== 'string' || typeof t.targetId !== 'string') return null;
      tabs.push({
        tabId: t.tabId,
        label: typeof t.label === 'string' ? t.label : null,
        targetId: t.targetId,
        active: t.active === true,
        ...(typeof t.title === 'string' ? { title: t.title } : {}),
        ...(typeof t.url === 'string' ? { url: t.url } : {}),
      });
    }
    return tabs;
  } catch {
    return null;
  }
}

/** How agent-browser spells a ref: it trims and case-folds (`T2`, ` t2 `, `t2\t` all name `t2`), so the CLI's gate must read the same spellings or `tab close T2` slips past it as « nothing resolved → the current tab → run » (round-2 F1). */
const normRef = (r: string): string => r.trim().toLowerCase();

/** The tab a `tab close [ref]` / `tab <ref>` names: by tN id, label or target id (trimmed, case-insensitive); no ref = the session's current tab. */
export function resolveAbTab(tabs: readonly AbTab[], ref: string | undefined): AbTab | undefined {
  if (ref === undefined) return tabs.find((t) => t.active);
  const r = normRef(ref);
  if (r === '') return undefined;
  return (
    tabs.find((t) => normRef(t.tabId) === r) ??
    tabs.find((t) => t.label !== null && normRef(t.label) === r) ??
    tabs.find((t) => normRef(t.targetId) === r)
  );
}

/**
 * CDP methods that DESTROY or wedge the renderer of the tab they reach (not browser-level verbs: those are {@link isBrowserLevelMethod}'s in the core). An agent may send them only to a tab it
 * opened; on the user's tab they are refused (round-2 INFO: `Page.crash` through the proxy killed the user's tab renderer). Page-JS `window.close()` is not a CDP method: an accepted gap.
 */
export const TAB_DESTROYING_METHODS: ReadonlySet<string> = new Set(['Page.crash', 'Runtime.terminateExecution']);

export type CloseVerdict = { run: true } | { run: false; message: string };

/**
 * Should `orchestra browser tab close [ref…]` reach agent-browser at all? Refused when the host says ANY tab the command could name is not the
 * agent's to close: every candidate token that resolves to a tab, or — when none resolves (no ref, or only flag values) — the session's current tab.
 * A command naming nothing resolvable and no current tab, or a target the host does not list, passes through: agent-browser's own error is the right
 * one there, and the proxy refuses a forbidden close regardless (defence in depth, never the only gate).
 */
export function decideCloseThroughCli(abTabs: readonly AbTab[], refs: readonly string[], hostTabs: readonly AgentTabView[]): CloseVerdict {
  const named = refs.map((r) => resolveAbTab(abTabs, r)).filter((t): t is AbTab => t !== undefined);
  const targets = named.length > 0 ? named : [resolveAbTab(abTabs, undefined)].filter((t): t is AbTab => t !== undefined);
  for (const tab of targets) {
    const view = hostTabs.find((h) => h.targetId === tab.targetId);
    if (view && !view.closable) {
      // the agent-browser id the agent typed (and the page title), never the registry's id
      return { run: false, message: `Tab ${tab.tabId}${tab.title ? ` (${tab.title})` : ''} was opened by the user: an agent may close only the tabs it opened.` };
    }
  }
  return { run: true };
}

export const TAB_NOT_OWNER_CODE = 'browser_tab_not_owner';

/** The refusal `orchestra browser` prints (and its `--json` form) for a forbidden close — agent-browser would have said "closed". */
export function tabCloseRefusal(message: string, json: boolean): { code: number; stdout: string; stderr: string } {
  const text = `${TAB_NOT_OWNER_CODE}: ${message} It is still open. Use \`orchestra browser tab list\` to see which tabs are yours.`;
  if (json) return { code: 1, stdout: JSON.stringify({ success: false, data: null, error: text, code: TAB_NOT_OWNER_CODE }) + '\n', stderr: '' };
  return { code: 1, stdout: '', stderr: `${text}\n` };
}

// (no `{ human: … }` map: pause-gates-wiring.test.ts forbids a property named after the human pause origin outside pause-ui.ts)
const ownerSuffix = (o: BrowserTabOpener): string => (o === AGENT_OPENER ? ' (yours)' : " (the user's)");

/**
 * Decorate agent-browser's plain `tab list` with who opened each tab — lines untouched except for a trailing suffix, so a parser
 * of the native format keeps working. A line it cannot attribute is left alone.
 */
export function annotateTabListText(stdout: string, abTabs: readonly AbTab[], hostTabs: readonly AgentTabView[]): string {
  return stdout
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:→\s*)?)\[([^\]]+)\]/.exec(line);
      if (!m) return line;
      const tab = abTabs.find((t) => t.tabId === m[2] || t.label === m[2]);
      const owner = tab ? hostTabs.find((h) => h.targetId === tab.targetId)?.openedBy : undefined;
      return owner ? line + ownerSuffix(owner) : line;
    })
    .join('\n');
}

/** The tab a `tab <ref>` switch names: the first candidate token that resolves (a flag VALUE such as `3000` resolves to nothing and is skipped). */
export function resolveSwitchTarget(abTabs: readonly AbTab[], refs: readonly string[]): AbTab | undefined {
  for (const r of refs) {
    const t = resolveAbTab(abTabs, r);
    if (t) return t;
  }
  return undefined;
}

/**
 * Say whose tab a `tab <ref>` switch landed on (#397 review F4b / #393 F3): agent-browser ids are session-local and a fresh daemon numbers the ACTIVE tab
 * `t1`, so a `tN` remembered from before an app restart can silently name the USER's tab. Text: the first line gains ` (yours)` / ` (the user's)`;
 * `--json`: `data.openedBy`. Anything it cannot attribute is returned untouched.
 */
export function annotateSwitchOutput(stdout: string, tab: AbTab | undefined, hostTabs: readonly AgentTabView[], json: boolean): string {
  const owner = tab ? hostTabs.find((h) => h.targetId === tab.targetId)?.openedBy : undefined;
  if (!owner) return stdout;
  if (json) {
    try {
      const doc = JSON.parse(stdout.trim()) as { success?: boolean; data?: Record<string, unknown> | null };
      if (doc.success !== true || !doc.data || typeof doc.data !== 'object') return stdout;
      doc.data.openedBy = owner;
      return JSON.stringify(doc) + '\n';
    } catch {
      return stdout;
    }
  }
  const lines = stdout.split('\n');
  const i = lines.findIndex((l) => l.trim() !== '');
  if (i === -1) return stdout;
  lines[i] += ownerSuffix(owner);
  return lines.join('\n');
}

/** `--json tab list` with `openedBy` + `closable` added to each tab (a tab the host does not list is left as agent-browser printed it). */
export function annotateTabListJson(stdout: string, hostTabs: readonly AgentTabView[]): string {
  try {
    const doc = JSON.parse(stdout.trim()) as { data?: { tabs?: Array<Record<string, unknown>> } };
    if (!Array.isArray(doc.data?.tabs)) return stdout;
    for (const t of doc.data!.tabs!) {
      const h = hostTabs.find((x) => x.targetId === t.targetId);
      if (h) {
        t.openedBy = h.openedBy;
        t.closable = h.closable;
      }
    }
    return JSON.stringify(doc) + '\n';
  } catch {
    return stdout;
  }
}
