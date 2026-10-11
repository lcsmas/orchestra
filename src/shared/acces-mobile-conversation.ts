// Accès mobile (#337): the phone's view of a conversation — a pure projection of the folded AgentSession (the same fold the
// desktop's structured view renders), cut down to what reads on a phone: user + assistant text in full, each tool call as ONE
// line, pending questions. No fs, no Electron: node --test drives it with real folded fixtures.

import type { AgentAnswerableEvent, AgentSession, RenderMessage } from './types.ts';

export type PhoneLine =
  | { id: string; kind: 'user'; text: string; at?: number }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean; at?: number }
  | { id: string; kind: 'tool'; label: string; state: 'running' | 'ok' | 'error'; at?: number }
  | { id: string; kind: 'notice'; text: string; error: boolean; at?: number }
  | { id: string; kind: 'command'; label: string; state: 'running' | 'ok' | 'error'; at?: number };

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
export const MAX_PHONE_TEXT = 4000;

const clip = (s: string, n = MAX_PHONE_TEXT): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string, n = 120): string => clip(s.replace(/\s+/g, ' ').trim(), n);

/** The one thing worth reading about a tool call, per well-known tool; else the first string input. */
export function toolLabel(name: string, input: Record<string, unknown> | undefined): string {
  const s = (k: string): string | undefined => (typeof input?.[k] === 'string' ? (input[k] as string) : undefined);
  const base = (p: string | undefined): string | undefined => (p ? p.split('/').filter(Boolean).slice(-2).join('/') : undefined);
  let detail: string | undefined;
  switch (name) {
    case 'Bash':
      detail = s('description') ?? s('command');
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      detail = base(s('file_path') ?? s('notebook_path'));
      break;
    case 'Grep':
    case 'Glob':
      detail = s('pattern');
      break;
    case 'WebFetch':
      detail = s('url');
      break;
    case 'WebSearch':
      detail = s('query');
      break;
    case 'Task':
    case 'Agent':
      detail = s('description');
      break;
    case 'Skill':
      detail = s('skill');
      break;
    default:
      detail = input ? (Object.values(input).find((v) => typeof v === 'string') as string | undefined) : undefined;
  }
  const short = name.startsWith('mcp__') ? name.split('__').slice(1).join('.') : name;
  return detail ? `${short} · ${oneLine(detail, 100)}` : short;
}

function textOf(m: RenderMessage): string {
  return typeof m.text === 'string' ? m.text : '';
}

function lineOf(m: RenderMessage): PhoneLine | null {
  const at = m.at;
  switch (m.role) {
    case 'user': {
      const t = textOf(m).trim();
      return t ? { id: m.id, kind: 'user', text: clip(t), at } : null;
    }
    case 'assistant': {
      if (m.thinking) return null;
      const t = textOf(m).trim();
      return t ? { id: m.id, kind: 'assistant', text: clip(t), streaming: m.done === false, at } : null;
    }
    case 'tool': {
      if (!m.toolUse) return null;
      const state = !m.toolResult ? 'running' : m.toolResult.isError ? 'error' : 'ok';
      return { id: m.id, kind: 'tool', label: toolLabel(m.toolUse.name, m.toolUse.input), state, at };
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
          question: typeof q.question === 'string' ? clip(q.question, 1000) : '',
          header: typeof q.header === 'string' ? oneLine(q.header, 40) : undefined,
          multiSelect: q.multiSelect === true,
          options: (Array.isArray(q.options) ? (q.options as unknown[]) : [])
            .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof (o as Record<string, unknown>).label === 'string')
            .map((o) => ({ label: oneLine(o.label as string, 120), description: typeof o.description === 'string' ? oneLine(o.description, 200) : undefined })),
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
