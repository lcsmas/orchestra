// Accès mobile (#337): the phone's view of a conversation — a pure projection of the folded AgentSession (the same fold the
// desktop's structured view renders), cut down to what reads on a phone: user + assistant text in full, each tool call as ONE
// line, pending questions. No fs, no Electron: node --test drives it with real folded fixtures.

import type { AgentAnswerableEvent, AgentImage, AgentSession, RenderMessage } from './types.ts';
import { clip, oneLine, toolLabel, toolLine, type ToolState } from './tool-line.ts';

// The label function lives in tool-line.ts (the desktop's render-item builder calls the same one — #374); re-exported for callers.
export { toolLabel };

export type PhoneLine =
  | { id: string; kind: 'user'; text: string; at?: number; attachments?: ('image' | 'pdf')[] }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean; at?: number }
  | { id: string; kind: 'tool'; label: string; state: ToolState; at?: number }
  | { id: string; kind: 'notice'; text: string; error: boolean; at?: number }
  | { id: string; kind: 'command'; label: string; state: ToolState; at?: number };

/** A question the agent is blocked on. `askUser` = AskUserQuestion (answerable from the phone in #339); anything else is shown
 *  with « à traiter sur le bureau ». */
export type PhoneAsk =
  | { requestId: string; kind: 'askUser'; questions: { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] }[] }
  | { requestId: string; kind: 'desktop'; title: string };

export interface PhoneConversation {
  ok: true;
  id: string;
  /** Bumps on every folded event — the phone refetches when the stream announces a newer one. */
  version: number;
  running: boolean;
  /** Lines dropped from the head (only the last MAX_PHONE_LINES are sent). */
  truncated: number;
  lines: PhoneLine[];
  asks: PhoneAsk[];
}

export const MAX_PHONE_LINES = 200;
/** A message typed on the phone (#338): at most this many characters, and this many bytes of JSON on the wire. */
export const MOBILE_SEND_MAX_CHARS = 32_000;
export const MOBILE_SEND_MAX_BODY = 131_072;
/** Files attached on the phone (Lucas 2026-10-12): images + PDFs, the desktop composer's `AgentImage` path. A send that carries
 *  some may weigh up to MOBILE_ATTACH_MAX_BODY (every other route keeps MOBILE_SEND_MAX_BODY); the RPC line cap is above it. */
export const MOBILE_ATTACH_MAX_COUNT = 8;
export const MOBILE_ATTACH_MAX_BODY = 20 * 1_048_576;
/** The media types the Messages API takes as `image` / `document` blocks — nothing else reaches sdkSend from the phone. */
export const MOBILE_ATTACH_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];

/** Validate the phone's `attachments` field: absent ⇒ none; else ≤ MOBILE_ATTACH_MAX_COUNT `{ mediaType, dataBase64 }` of an
 *  allowed type with canonical, non-empty base64. Run by the server (shape) AND by main (before sdkSend). */
export function parseMobileAttachments(raw: unknown): { ok: true; images: AgentImage[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'attachments must be a list' };
  if (raw.length > MOBILE_ATTACH_MAX_COUNT) return { ok: false, error: `at most ${MOBILE_ATTACH_MAX_COUNT} attachments` };
  const images: AgentImage[] = [];
  for (const a of raw) {
    const mediaType = a && typeof a === 'object' ? (a as { mediaType?: unknown }).mediaType : undefined;
    const data = a && typeof a === 'object' ? (a as { dataBase64?: unknown }).dataBase64 : undefined;
    if (typeof mediaType !== 'string' || !MOBILE_ATTACH_TYPES.includes(mediaType)) return { ok: false, error: 'only images (png, jpeg, gif, webp) and PDFs' };
    if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { ok: false, error: 'attachment is not base64' };
    images.push({ mediaType, dataBase64: data });
  }
  return { ok: true, images };
}
export const MAX_PHONE_TEXT = 4000;

function textOf(m: RenderMessage): string {
  return typeof m.text === 'string' ? m.text : '';
}

function lineOf(m: RenderMessage): PhoneLine | null {
  const at = m.at;
  switch (m.role) {
    case 'user': {
      const t = textOf(m).trim();
      const atts = (m.images ?? []).map((i) => (i.mediaType === 'application/pdf' ? ('pdf' as const) : ('image' as const)));
      if (!t && !atts.length) return null;
      const line: Extract<PhoneLine, { kind: 'user' }> = { id: m.id, kind: 'user', text: clip(t, MAX_PHONE_TEXT), at };
      if (atts.length) line.attachments = atts;
      return line;
    }
    case 'assistant': {
      if (m.thinking) return null;
      const t = textOf(m).trim();
      return t ? { id: m.id, kind: 'assistant', text: clip(t, MAX_PHONE_TEXT), streaming: m.done === false, at } : null;
    }
    case 'tool': {
      if (!m.toolUse) return null;
      return { id: m.id, kind: 'tool', ...toolLine(m), at };
    }
    case 'local-command': {
      const lc = m.localCommand;
      if (!lc) return null;
      const state = lc.running ? 'running' : lc.exitCode === 0 || lc.exitCode == null ? 'ok' : 'error';
      return { id: m.id, kind: 'command', label: `! ${oneLine(lc.command, 100)}`, state, at };
    }
    case 'system':
    case 'error': {
      const t = textOf(m).trim();
      return t ? { id: m.id, kind: 'notice', text: oneLine(t, 300), error: m.role === 'error', at } : null;
    }
    default:
      return null;
  }
}

function askOf(a: AgentAnswerableEvent): PhoneAsk {
  if (a.type === 'permission-request' && a.name === 'AskUserQuestion') {
    const qs = Array.isArray(a.input?.questions) ? (a.input.questions as unknown[]) : [];
    return {
      requestId: a.requestId,
      kind: 'askUser',
      questions: qs
        .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
        .map((q) => ({
          // The FULL text: main matches answers on the exact question / option text (final review m4); CSS wraps it on the phone.
          question: typeof q.question === 'string' ? q.question : '',
          header: typeof q.header === 'string' ? oneLine(q.header, 40) : undefined,
          multiSelect: q.multiSelect === true,
          options: (Array.isArray(q.options) ? (q.options as unknown[]) : [])
            .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof (o as Record<string, unknown>).label === 'string')
            .map((o) => ({ label: o.label as string, description: typeof o.description === 'string' ? oneLine(o.description, 200) : undefined })),
        })),
    };
  }
  const title =
    a.type === 'elicitation-request' ? `${a.serverName} : ${oneLine(a.message, 200)}` : a.type === 'permission-request' ? `Permission : ${a.title ?? a.name}` : `Dialogue : ${a.dialogKind}`;
  return { requestId: a.requestId, kind: 'desktop', title };
}

export function projectConversation(id: string, session: AgentSession, version: number): PhoneConversation {
  const all: PhoneLine[] = [];
  for (const m of session.messages) {
    const l = lineOf(m);
    if (l) all.push(l);
  }
  const lines = all.length > MAX_PHONE_LINES ? all.slice(-MAX_PHONE_LINES) : all;
  const seen = new Set<string>();
  const asks: PhoneAsk[] = [];
  for (const a of [...session.pendingAnswerables, ...session.pendingPermissions]) {
    if (seen.has(a.requestId)) continue;
    seen.add(a.requestId);
    asks.push(askOf(a));
  }
  return { ok: true, id, version, running: session.running, truncated: all.length - lines.length, lines, asks };
}

/** Workspace ids are uuids (or the legacy short ids): never let anything else reach a route. */
export function validWorkspaceId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
}
