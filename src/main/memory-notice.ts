// #322: tell the member AND its coordinator what the Plafond mémoire did — a command killed (hook: `onMemoryKill`, FI-1 v1.8) or the warning level crossed (`onMemorySoft`, FI-1 v1.10).
//   • the member: one notice row — persisted (`Workspace.sdkMemNotices`, identity (unit, seq): a re-delivery stores once) and, when a session is live, emitted into its event stream;
//   • the coordinator: ONE bus message (workspace, command, level) — `escalation` for a kill, `status` for the warning;
//   • the app log line already exists (keeper-client `deliverMemRecord`).
// Deps are INJECTED (index.ts wires the real store/bus/agent-sdk) so the strip-types test runner and the #320 rig drive THIS code, not a copy.

import type { Workspace } from '../shared/types.ts';
import { isSoftRecord, memBusBody, type MemKillRecord, type MemNoticeRecord, type MemSoftRecord } from '../shared/memory-scope.ts';
import { addMemNotice, memNoticeEntryOf, type MemNoticeEntry } from '../shared/mem-notice.ts';

export interface BusSendInput {
  runId: string;
  sender: string;
  recipient: string;
  kind: 'escalation' | 'status';
  body: string;
}

export interface MemNoticeDeps {
  getWorkspace(id: string): Workspace | undefined;
  patchWorkspace(id: string, patch: Partial<Workspace>): Promise<void>;
  /** Emit the row into the workspace's live event stream (a no-op when no session is live — the persisted entry shows in the backfill). */
  emitLive(wsId: string, entry: MemNoticeEntry): void;
  /** Write ONE message row. THROWS when the bus is unavailable — the record stays undelivered and is retried (keeper-client). Returns `counted` when the run's `liveness` switch is OFF (counted, not fired — the precedents of boot-wedge #197 and the liveness sweep). */
  sendToCoordinator(m: BusSendInput): 'sent' | 'counted' | void;
  /** The workspace's wave run (`$ORCHESTRA_RUN_ID`) — the run the coordinator's `orchestra check` reads. */
  resolveRunId(ws: Workspace): string;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
}

/** Per-workspace write chain: two records in one tick must not both read the same `sdkMemNotices` and overwrite each other. */
const chains = new Map<string, Promise<void>>();

function noticeRow(deps: MemNoticeDeps, wsId: string, rec: MemNoticeRecord): void {
  const entry = memNoticeEntryOf(rec);
  const prev = chains.get(wsId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const ws = deps.getWorkspace(wsId);
    if (!ws) return;
    const list = addMemNotice(ws.sdkMemNotices, entry);
    if (!list) return; // already stored AND emitted by an earlier delivery of this record
    await deps.patchWorkspace(wsId, { sdkMemNotices: list });
    deps.emitLive(wsId, entry);
  });
  chains.set(wsId, next.catch((e) => deps.log.warn(`memory-notice[${wsId}]: could not store/emit the notice row`, e)));
}

/** The workspace's coordinator = its live parent (the same rule as the liveness roster and the boot-wedge escalation). */
function coordinatorOf(deps: MemNoticeDeps, ws: Workspace): string | null {
  const parent = ws.parentId ? deps.getWorkspace(ws.parentId) : undefined;
  return parent && !parent.archived ? parent.id : null;
}

/** Handle one record: the member's row, then the coordinator's message. Throws only when the coordinator's message could not be written (the caller retries; the row is idempotent). */
export function handleMemRecord(deps: MemNoticeDeps, wsId: string, rec: MemKillRecord | MemSoftRecord): void {
  const ws = deps.getWorkspace(wsId);
  if (!ws) return; // a deleted workspace: nobody to tell
  noticeRow(deps, wsId, rec);
  const coordinator = coordinatorOf(deps, ws);
  if (!coordinator) {
    deps.log.info(`memory-notice[${wsId}]: no live coordinator — the member's row only`);
    return;
  }
  const kind = isSoftRecord(rec) ? 'status' : 'escalation';
  const outcome = deps.sendToCoordinator({
    runId: deps.resolveRunId(ws),
    sender: wsId,
    recipient: coordinator,
    kind,
    body: memBusBody(`${ws.name || ws.branch || wsId} (${wsId})`, rec),
  });
  if (outcome === 'counted') deps.log.info(`memory-notice[${wsId}]: would have told ${coordinator} (${kind}; the run's liveness switch is OFF — counted, not fired)`);
}

let active: (() => void) | null = null;

/** Subscribe both hooks; returns the unsubscribe. Idempotent: `createMainWindow` runs again on a macOS `activate`, and a second subscription would send every record's bus message twice (review F8). */
export function startMemoryNotices(
  deps: MemNoticeDeps,
  hooks: { onMemoryKill(fn: (wsId: string, rec: MemKillRecord) => void): () => void; onMemorySoft(fn: (wsId: string, rec: MemSoftRecord) => void): () => void },
): () => void {
  if (active) return active;
  const offKill = hooks.onMemoryKill((wsId, rec) => handleMemRecord(deps, wsId, rec));
  const offSoft = hooks.onMemorySoft((wsId, rec) => handleMemRecord(deps, wsId, rec));
  active = () => {
    offKill();
    offSoft();
    active = null;
  };
  return active;
}

/** Test seam: wait for the pending store/emit writes of a workspace. */
export function __memNoticeIdle(wsId: string): Promise<void> {
  return chains.get(wsId) ?? Promise.resolve();
}
