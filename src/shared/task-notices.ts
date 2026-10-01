// Avis de tâche (task notices, #273): the `<task-notification>` turn the Claude
// Code CLI injects when a tâche de fond finishes, fails, is found orphaned after
// a restart, or (Monitor) emits an event. Parsed here into a quiet one-line row
// instead of a user bubble of raw XML. Pure, so it is testable without Electron.
//
// Detection is STRUCTURAL: only a user message whose origin badge is the one
// `originLabel` gives `kind: 'task-notification'` is parsed — never a human
// turn that happens to contain the tag. Any body this parser does not fully
// recognize returns null and keeps the ordinary bubble.

/** The badge `originLabel` (agent-events.ts) gives a task-notification turn. */
export const TASK_NOTICE_ORIGIN = 'task notification';

export type TaskNoticeKind = 'agent' | 'command' | 'monitor' | 'task';
/** ok = finished cleanly · fail = red, reason on the row · stopped = neutral
 *  (deliberate stop or session end) · event = a Monitor event (not terminal). */
export type TaskNoticeTone = 'ok' | 'fail' | 'stopped' | 'event';

export interface TaskNotice {
  kind: TaskNoticeKind;
  tone: TaskNoticeTone;
  /** CLI `<status>` verbatim (completed | failed | killed | stopped); absent on Monitor events. */
  status?: string;
  /** The row's main text, e.g. `Agent "Lens 2" failed`. */
  label: string;
  /** Inline text after the label: failure reason, Monitor event, exit code. */
  detail?: string;
  /** Meta chips for the row (duration, tool uses). */
  meta: string[];
  /** Expanded-only content. */
  result?: string;
  event?: string;
  reason?: string;
  note?: string;
  outputFile?: string;
  worktree?: string;
  /** Real task ids (the CLI's `__orphan_summary__` scan markers removed). */
  taskIds: string[];
  /** True when the notice reports task(s) left unfinished by a previous session. */
  orphan: boolean;
}

export function isTaskNoticeMessage(m: { role?: string; origin?: string }): boolean {
  return m.role === 'user' && m.origin === TASK_NOTICE_ORIGIN;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'" };
function decode(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#39);/g, (_, e: string) => ENTITIES[e]);
}

function tag(body: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? decode(m[1]).trim() : undefined;
}

/** First line, capped — task names can be whole multi-line shell descriptions. */
export function shortName(s: string, max = 80): string {
  const first = (s.split('\n').find((l) => l.trim()) ?? '').trim();
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

export function formatDurationMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function q(name: string): string {
  return `“${shortName(name)}”`;
}

interface Shape {
  kind: TaskNoticeKind;
  tone: TaskNoticeTone;
  label: string;
  detail?: string;
  reason?: string;
  orphan?: boolean;
}

/** Map a CLI `<summary>` to our own label. Order matters: specific before generic.
 *  Every form here was observed in real transcripts (#273). */
function shapeFromSummary(summary: string, event: string | undefined): Shape | null {
  let m: RegExpExecArray | null;
  const ev = event ? shortName(event, 140) : undefined;
  // ── Agents
  if ((m = /^Agent "([\s\S]*?)" failed: ([\s\S]*)$/.exec(summary)))
    return { kind: 'agent', tone: 'fail', label: `Agent ${q(m[1])} failed`, detail: shortName(m[2], 140), reason: m[2] };
  if ((m = /^Agent "([\s\S]*)" finished$/.exec(summary)))
    return { kind: 'agent', tone: 'ok', label: `Agent ${q(m[1])} finished` };
  if ((m = /^Agent "([\s\S]*)" was stopped(?: by ([\s\S]*))?$/.exec(summary)))
    return { kind: 'agent', tone: 'stopped', label: `Agent ${q(m[1])} stopped`, ...(m[2] ? { detail: `by ${m[2]}` } : {}) };
  if ((m = /^Background agent "([\s\S]*)" didn't finish before the previous session ended$/.exec(summary)))
    return { kind: 'agent', tone: 'stopped', label: `Agent ${q(m[1])} interrupted`, detail: 'previous session ended', orphan: true };
  if ((m = /^No completion record was found for background agent "([\s\S]*?)" from the previous session/.exec(summary)))
    return { kind: 'agent', tone: 'stopped', label: `Agent ${q(m[1])} interrupted`, detail: 'previous session ended', orphan: true };
  if ((m = /^No completion record was found for (\d+) background agents from the previous session/.exec(summary)))
    return { kind: 'agent', tone: 'stopped', label: `${m[1]} agents interrupted`, detail: 'previous session ended', orphan: true };
  // ── Background shell commands
  if ((m = /^Background command "([\s\S]*)" completed \(exit code (\d+)(?::[^)]*)?\)$/.exec(summary)))
    return {
      kind: 'command',
      tone: m[2] === '0' ? 'ok' : 'fail',
      label: `Command ${q(m[1])} ${m[2] === '0' ? 'finished' : 'failed'}`,
      detail: `exit ${m[2]}`,
    };
  if ((m = /^Background command "([\s\S]*)" failed with exit code (\d+)$/.exec(summary)))
    return { kind: 'command', tone: 'fail', label: `Command ${q(m[1])} failed`, detail: `exit ${m[2]}` };
  if ((m = /^Background command "([\s\S]*)" was stopped$/.exec(summary)))
    return { kind: 'command', tone: 'stopped', label: `Command ${q(m[1])} stopped` };
  if (/^Background shell command didn't finish before the previous session ended$/.test(summary))
    return { kind: 'command', tone: 'stopped', label: 'Command interrupted', detail: 'previous session ended', orphan: true };
  if ((m = /^(\d+) background shell command tasks didn't finish before the previous session ended/.exec(summary)))
    return { kind: 'command', tone: 'stopped', label: `${m[1]} commands interrupted`, detail: 'previous session ended', orphan: true };
  // ── Monitors
  if ((m = /^Monitor event: "([\s\S]*)"$/.exec(summary)))
    return { kind: 'monitor', tone: 'event', label: `Monitor ${q(m[1])}`, ...(ev ? { detail: ev } : {}) };
  if ((m = /^Monitor "([\s\S]*)" stream ended$/.exec(summary)))
    return { kind: 'monitor', tone: 'ok', label: `Monitor ${q(m[1])} ended`, ...(ev ? { detail: ev } : {}) };
  if ((m = /^Monitor "([\s\S]*)" script failed \(exit (\d+)\)$/.exec(summary)))
    return { kind: 'monitor', tone: 'fail', label: `Monitor ${q(m[1])} failed`, detail: `exit ${m[2]}` };
  if ((m = /^Monitor "([\s\S]*)" stopped$/.exec(summary)))
    return { kind: 'monitor', tone: 'stopped', label: `Monitor ${q(m[1])} stopped` };
  // ── Generic
  if ((m = /^Task "([\s\S]*)" was stopped by the user$/.exec(summary)))
    return { kind: 'task', tone: 'stopped', label: `Task ${q(m[1])} stopped`, detail: 'by you' };
  return null;
}

function toneFromStatus(status: string | undefined): TaskNoticeTone {
  if (status === 'failed') return 'fail';
  if (status === 'killed' || status === 'stopped') return 'stopped';
  if (status === 'completed') return 'ok';
  return 'event';
}

/** Parse a task-notification turn body. Null when the body is not exactly one
 *  `<task-notification>` element, or carries no summary — the caller then keeps
 *  the raw bubble, so an unknown future shape is never hidden. */
export function parseTaskNotice(text: string | undefined): TaskNotice | null {
  const t = (text ?? '').trim();
  const m = /^<task-notification>([\s\S]*)<\/task-notification>$/.exec(t);
  if (!m || m[1].includes('<task-notification>')) return null;
  const body = m[1];
  const summary = tag(body, 'summary');
  if (!summary) return null;
  const status = tag(body, 'status');
  const event = tag(body, 'event');
  const shape: Shape = shapeFromSummary(summary, event) ?? {
    // Recognized envelope, unrecognized summary wording: our row, CLI's words.
    kind: 'task',
    tone: toneFromStatus(status),
    label: shortName(summary, 140),
    ...(event ? { detail: shortName(event, 140) } : {}),
  };
  const taskIds = [...body.matchAll(/<task-id>([\s\S]*?)<\/task-id>/g)]
    .map((x) => decode(x[1]).trim())
    .filter((id) => id && !id.startsWith('__orphan_summary'));
  const meta: string[] = [];
  const usage = tag(body, 'usage');
  if (usage) {
    const dur = Number(tag(usage, 'duration_ms'));
    const tools = Number(tag(usage, 'tool_uses'));
    if (Number.isFinite(dur) && dur > 0) meta.push(formatDurationMs(dur));
    if (Number.isFinite(tools) && tools > 0) meta.push(`${tools} ${tools === 1 ? 'tool' : 'tools'}`);
  }
  const result = tag(body, 'result');
  const note = tag(body, 'note');
  const outputFile = tag(body, 'output-file');
  const worktree = tag(body, 'worktree');
  return {
    kind: shape.kind,
    tone: shape.tone,
    ...(status ? { status } : {}),
    label: shape.label,
    ...(shape.detail ? { detail: shape.detail } : {}),
    meta,
    ...(result ? { result } : {}),
    ...(event ? { event } : {}),
    ...(shape.reason ? { reason: shape.reason } : {}),
    ...(note ? { note } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(worktree ? { worktree } : {}),
    taskIds,
    orphan: shape.orphan === true,
  };
}

/** Group label for a run of ≥2 consecutive notices: "4 task notices · 1 failed".
 *  The failure count is never folded away — a failure must survive the collapse. */
export function describeTaskNoticeRun(notices: Pick<TaskNotice, 'tone'>[]): { label: string; failed: number } {
  const failed = notices.filter((n) => n.tone === 'fail').length;
  return { label: `${notices.length} task notices`, failed };
}
