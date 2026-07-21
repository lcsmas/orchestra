import React, { useMemo } from 'react';
import type { RenderMessage } from '../../../shared/types';
import { Collapsible } from './Collapsible';
import { ToolDiff } from './ToolDiff';
import { ToolIcon } from './tool-icons';
import {
  resultText,
  inputStr,
  pretty,
  summarizeInput,
  truncate,
  todosFrom,
  toolMessageEqual,
} from './tool-util';

interface Props {
  message: RenderMessage;
}

/**
 * A single tool call rendered as a collapsible card. Dispatches on
 * `toolUse.name` to a specialised body (diff for Edit/Write, command+output for
 * Bash, checklist for TodoWrite, …) and falls back to a generic JSON view for
 * unknown tools. The correlated `toolResult` (when it has arrived) drives error
 * styling and the output region.
 *
 * Memoized on the tool fields that affect output so a streaming delta elsewhere
 * doesn't re-render every card in the transcript.
 */
function ToolCardImpl({ message }: Props) {
  const tool = message.toolUse;
  const result = message.toolResult;
  const name = tool?.name ?? 'tool';
  const input = tool?.input;
  const isError = result?.isError === true;

  // A tool is "pending" until its result lands. TodoWrite/Task have no useful
  // result body; most others do.
  const pending = !result && !message.done;

  const header = (
    <span className="av-tool-header-inner">
      <ToolIcon name={name} />
      <span className="av-tool-name">{name}</span>
      <span className="av-tool-summary" title={summarizeInput(name, input)}>
        {truncate(summarizeInput(name, input))}
      </span>
    </span>
  );

  // TodoWrite gets a live progress fraction next to its status dot.
  const todoProgress = useMemo(() => {
    if (name !== 'TodoWrite') return null;
    const todos = todosFrom(input);
    if (todos.length === 0) return null;
    const done = todos.filter((t) => t.status === 'completed').length;
    return `${done}/${todos.length}`;
  }, [name, input]);

  const statusLabel = isError ? 'failed' : pending ? 'running' : 'done';
  const aside = (
    <span
      className={`av-tool-status ${
        isError ? 'av-tool-status-error' : pending ? 'av-tool-status-pending' : 'av-tool-status-ok'
      }`}
      title={statusLabel}
    >
      {todoProgress && <span className="av-tool-progress">{todoProgress}</span>}
      {/* Status reads as a colored dot; errors also say it in words. */}
      <span className="av-tool-status-dot" aria-hidden="true" />
      {isError ? 'failed' : <span className="av-sr-only">{statusLabel}</span>}
    </span>
  );

  // Edit/Write (the diff IS the point), TodoWrite/Task (the list/brief is the
  // point), and any errored tool default to OPEN; the rest start collapsed.
  const defaultOpen =
    name === 'Edit' ||
    name === 'Write' ||
    name === 'TodoWrite' ||
    name === 'Task' ||
    isError;

  return (
    <div className={`av-tool-card av-tool-${name.toLowerCase()} ${isError ? 'av-tool-errored' : ''}`}>
      <Collapsible header={header} aside={aside} defaultOpen={defaultOpen}>
        <ToolBody name={name} input={input} result={result} />
      </Collapsible>
    </div>
  );
}

/** Per-tool body dispatch. */
function ToolBody({
  name,
  input,
  result,
}: {
  name: string;
  input: Record<string, unknown> | undefined;
  result: RenderMessage['toolResult'];
}) {
  switch (name) {
    case 'Edit':
    case 'Write':
      return (
        <>
          <ToolDiff name={name} input={input} />
          {result?.isError && <ResultBlock result={result} />}
        </>
      );

    case 'Bash':
      return <BashBody input={input} result={result} />;

    case 'Read':
    case 'Grep':
    case 'Glob':
      return <SummaryBody name={name} input={input} result={result} />;

    case 'TodoWrite':
      return <TodoBody input={input} />;

    case 'Task':
      return <TaskBody input={input} result={result} />;

    default:
      return <GenericBody input={input} result={result} />;
  }
}

/** Bash: the command line + monospace stdout/stderr, error-styled when failed. */
function BashBody({
  input,
  result,
}: {
  input: Record<string, unknown> | undefined;
  result: RenderMessage['toolResult'];
}) {
  const command = inputStr(input, 'command');
  const description = inputStr(input, 'description');
  const out = resultText(result?.content);
  return (
    <div className="av-tool-bash">
      {description && <div className="av-tool-bash-desc">{description}</div>}
      <pre className="av-tool-bash-cmd">
        <span className="av-tool-bash-prompt">$</span> {command}
      </pre>
      {out ? (
        <pre className={`av-tool-bash-out ${result?.isError ? 'av-tool-out-error' : ''}`}>{out}</pre>
      ) : null}
    </div>
  );
}

/** Read/Grep/Glob: a compact summary line + expandable full result. */
function SummaryBody({
  name,
  input,
  result,
}: {
  name: string;
  input: Record<string, unknown> | undefined;
  result: RenderMessage['toolResult'];
}) {
  const out = resultText(result?.content);
  const lines = out ? out.split('\n').length : 0;
  const summary =
    name === 'Read'
      ? `${inputStr(input, 'file_path')}${lines ? ` — ${lines} lines` : ''}`
      : `${inputStr(input, 'pattern')}${lines ? ` — ${lines} matches` : ''}`;

  return (
    <div className="av-tool-summary-body">
      <div className="av-tool-summary-line">{summary}</div>
      {out ? (
        <Collapsible header={<span className="av-tool-detail-toggle">Show detail</span>}>
          <pre className={`av-tool-detail ${result?.isError ? 'av-tool-out-error' : ''}`}>{out}</pre>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** TodoWrite: a checklist with status markers. */
function TodoBody({ input }: { input: Record<string, unknown> | undefined }) {
  const todos = useMemo(() => todosFrom(input), [input]);
  if (todos.length === 0) return <div className="av-tool-empty">No todos.</div>;
  return (
    <ul className="av-tool-todos">
      {todos.map((t, i) => (
        <li key={i} className={`av-todo av-todo-${t.status}`}>
          <span className="av-todo-mark" aria-hidden>
            <TodoMark status={t.status} />
          </span>
          <span className="av-todo-text">
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Check-circle / half-ring / open-ring marks (status is also in the li class
 *  and the text styling, so these stay decorative). */
function TodoMark({ status }: { status: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {status === 'completed' ? (
        <>
          <circle cx="8" cy="8" r="6.25" fill="currentColor" />
          <path
            d="M5.4 8.2 7.2 10l3.4-3.6"
            stroke="var(--av-surface-raised, #1a1f26)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : status === 'in_progress' ? (
        <>
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
          <path
            d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </>
      ) : (
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      )}
    </svg>
  );
}

/** Task: a nested subagent affordance — indented card with the brief + result. */
function TaskBody({
  input,
  result,
}: {
  input: Record<string, unknown> | undefined;
  result: RenderMessage['toolResult'];
}) {
  const description = inputStr(input, 'description');
  const subagent = inputStr(input, 'subagent_type');
  const prompt = inputStr(input, 'prompt');
  const out = resultText(result?.content);
  return (
    <div className="av-tool-task">
      <div className="av-tool-task-meta">
        {subagent && <span className="av-tool-task-agent">{subagent}</span>}
        {description && <span className="av-tool-task-desc">{description}</span>}
      </div>
      {prompt ? (
        <Collapsible header={<span className="av-tool-detail-toggle">Brief</span>}>
          <pre className="av-tool-task-prompt">{prompt}</pre>
        </Collapsible>
      ) : null}
      {out ? (
        <div className="av-tool-task-result">
          <pre className={result?.isError ? 'av-tool-out-error' : ''}>{out}</pre>
        </div>
      ) : null}
    </div>
  );
}

/** Unknown tool: pretty-printed input + result. */
function GenericBody({
  input,
  result,
}: {
  input: Record<string, unknown> | undefined;
  result: RenderMessage['toolResult'];
}) {
  return (
    <div className="av-tool-generic">
      <div className="av-tool-generic-section">
        <div className="av-tool-generic-label">Input</div>
        <pre className="av-tool-generic-json">{pretty(input ?? {})}</pre>
      </div>
      {result ? <ResultBlock result={result} /> : null}
    </div>
  );
}

/** Shared result renderer for the generic/error paths. */
function ResultBlock({ result }: { result: NonNullable<RenderMessage['toolResult']> }) {
  const out = resultText(result.content);
  return (
    <div className="av-tool-generic-section">
      <div className="av-tool-generic-label">Result</div>
      <pre className={`av-tool-generic-json ${result.isError ? 'av-tool-out-error' : ''}`}>
        {out || '(no output)'}
      </pre>
    </div>
  );
}

function areEqual(a: Props, b: Props): boolean {
  return toolMessageEqual(a.message, b.message);
}

export const ToolCard = React.memo(ToolCardImpl, areEqual);
