// First-class UI for an AskUserQuestion request (which arrives via the
// permission path). Renders each question with its options as buttons, supports
// multiSelect and an "Other" free-text answer, and replies with an allow +
// updatedInput carrying the selections (see askUserQuestion.ts for the shape).

import { useState } from 'react';
import type { AgentPermissionRequestEvent } from '../../../shared/types';
import {
  buildAskUserQuestionReply,
  parseAskUserQuestion,
  type AskQuestion,
} from './askUserQuestion';

const OTHER = '__other__';

export function AskUserQuestionCard({
  request,
  onReply,
}: {
  request: AgentPermissionRequestEvent;
  /** Resolves the request with an allow + updatedInput, or a deny. */
  onReply: (
    reply:
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string },
  ) => void;
}) {
  const parsed = parseAskUserQuestion(request.name, request.input);
  // If we somehow got a malformed AskUserQuestion, fall back is handled by the
  // caller (PermissionDialog only routes here when parse succeeds), but guard.
  const questions: AskQuestion[] = parsed?.questions ?? [];

  // selections: question text -> set of chosen option labels.
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  // free text per question, used when "Other" is picked.
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  const toggle = (q: AskQuestion, label: string) => {
    setSelections((prev) => {
      const cur = new Set(prev[q.question] ?? []);
      if (q.multiSelect) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
        cur.clear();
        cur.add(label);
      }
      return { ...prev, [q.question]: cur };
    });
  };

  // Every question needs at least one answer (or an "Other" with text).
  const complete = questions.every((q) => {
    const chosen = selections[q.question];
    if (!chosen || chosen.size === 0) return false;
    if (chosen.has(OTHER) && !(otherText[q.question] ?? '').trim()) return false;
    return true;
  });

  const submit = () => {
    const resolved: Record<string, string[]> = {};
    for (const q of questions) {
      const chosen = selections[q.question];
      if (!chosen) continue;
      const labels: string[] = [];
      for (const label of chosen) {
        if (label === OTHER) {
          const t = (otherText[q.question] ?? '').trim();
          if (t) labels.push(t);
        } else {
          labels.push(label);
        }
      }
      resolved[q.question] = labels;
    }
    onReply({
      behavior: 'allow',
      updatedInput: buildAskUserQuestionReply(request.input, questions, resolved),
    });
  };

  return (
    <div className="av-question" role="group" aria-label="Question from the agent">
      {request.title && <div className="av-question-title">{request.title}</div>}
      {questions.map((q) => {
        const chosen = selections[q.question] ?? new Set<string>();
        return (
          <div className="av-question-block" key={q.question}>
            {q.header && <span className="av-question-header">{q.header}</span>}
            <p className="av-question-text">{q.question}</p>
            <div className="av-question-options">
              {q.options.map((opt) => {
                const active = chosen.has(opt.label);
                return (
                  <button
                    type="button"
                    key={opt.label}
                    className={`av-question-option${active ? ' av-question-option-active' : ''}`}
                    aria-pressed={active}
                    onClick={() => toggle(q, opt.label)}
                  >
                    <span className="av-question-option-label">{opt.label}</span>
                    {opt.description && (
                      <span className="av-question-option-desc">{opt.description}</span>
                    )}
                  </button>
                );
              })}
              {/* "Other" free-text — the SDK always allows a custom answer. */}
              <button
                type="button"
                className={`av-question-option av-question-option-other${
                  chosen.has(OTHER) ? ' av-question-option-active' : ''
                }`}
                aria-pressed={chosen.has(OTHER)}
                onClick={() => toggle(q, OTHER)}
              >
                <span className="av-question-option-label">Other…</span>
              </button>
            </div>
            {chosen.has(OTHER) && (
              <input
                className="av-question-other-input"
                type="text"
                autoFocus
                placeholder="Type your answer"
                value={otherText[q.question] ?? ''}
                onChange={(e) =>
                  setOtherText((prev) => ({ ...prev, [q.question]: e.target.value }))
                }
              />
            )}
          </div>
        );
      })}
      <div className="av-question-actions">
        <button
          type="button"
          className="av-btn av-btn-ghost"
          onClick={() => onReply({ behavior: 'deny', message: 'User dismissed the question.' })}
        >
          Dismiss
        </button>
        <button
          type="button"
          className="av-btn av-btn-primary"
          disabled={!complete}
          onClick={submit}
        >
          Submit answer
        </button>
      </div>
    </div>
  );
}
