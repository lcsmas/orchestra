// Interrupt + rewind from the phone: the desktop's ■ and the user bubble's ↺, reached over the PRIVATE fd-3 channel only. Electron-free
// (every effect injected) so node --test drives the guards main applies whatever the server already checked.

import { validRewindId } from '../shared/acces-mobile-conversation.ts';
import { previousRewindId, rewindPrefillText } from '../shared/rewind-target.ts';
import type { AgentRewindPreview, AgentSessionRewindEvent, RenderMessage } from '../shared/types.ts';

export interface MobileControlDeps {
  /** The workspace id when it exists and is not archived, else undefined. */
  liveId: (id: unknown) => string | undefined;
  /** The fold the phone sees (loaded like a read). The rewind target must be a user turn of it. */
  fold: (id: string) => Promise<readonly RenderMessage[]>;
  /** Mid-turn right now (the store's status) — the desktop disables rewind then; the teardown would race the stream. */
  isRunning: (id: string) => boolean;
  interrupt: (id: string) => Promise<void>;
  preview: (id: string, rewindId: string) => Promise<AgentRewindPreview>;
  rewind: (id: string, rewindId: string, prevRewindId?: string) => Promise<AgentSessionRewindEvent>;
}

export type MobileControlResult = { ok: false; error: string } | { ok: true; preview?: AgentRewindPreview; text?: string; filesError?: string };

export const REWIND_GONE = 'Ce message n’est plus dans la conversation.';
export const REWIND_RUNNING = 'L’agent travaille : arrête-le avant de revenir en arrière.';

export function createMobileControls(deps: MobileControlDeps) {
  async function interrupt(msg: Record<string, unknown>): Promise<MobileControlResult> {
    const id = deps.liveId(msg.id);
    if (!id) return { ok: false, error: 'unknown or archived workspace' };
    await deps.interrupt(id);
    return { ok: true };
  }

  async function target(msg: Record<string, unknown>): Promise<{ id: string; rewindId: string; msgs: readonly RenderMessage[] } | { ok: false; error: string }> {
    const id = deps.liveId(msg.id);
    if (!id) return { ok: false, error: 'unknown or archived workspace' };
    if (!validRewindId(msg.rewindId)) return { ok: false, error: 'bad rewind id' };
    const rewindId = msg.rewindId;
    const msgs = await deps.fold(id);
    if (!msgs.some((m) => m.role === 'user' && m.rewindId === rewindId && !m.queued)) return { ok: false, error: REWIND_GONE };
    return { id, rewindId, msgs };
  }

  async function preview(msg: Record<string, unknown>): Promise<MobileControlResult> {
    const t = await target(msg);
    if ('ok' in t) return t;
    return { ok: true, preview: await deps.preview(t.id, t.rewindId) };
  }

  async function rewind(msg: Record<string, unknown>): Promise<MobileControlResult> {
    const t = await target(msg);
    if ('ok' in t) return t;
    if (deps.isRunning(t.id)) return { ok: false, error: REWIND_RUNNING };
    // Read BEFORE the rewind: the fold is about to drop the row (the desktop's onRewindConfirm does the same).
    const text = rewindPrefillText(t.msgs, t.rewindId);
    try {
      const ev = await deps.rewind(t.id, t.rewindId, previousRewindId(t.msgs, t.rewindId));
      return { ok: true, text, ...(ev.filesError ? { filesError: ev.filesError } : {}) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { interrupt, preview, rewind };
}
