// First-class UI for an AskUserQuestion request (which arrives via the
// permission path). Modeled on the Claude Code desktop question card:
//
//   • DOCKED, not modal — rendered by PermissionDialog directly above the
//     composer with NO backdrop/scrim, so the transcript behind stays fully
//     visible. (Real tool permissions still use the dimmed modal.)
//   • A "1/N" progress pill + the question header on one row, with a collapse
//     chevron and a close (✕ = dismiss) on the right.
//   • Full-width numbered option rows: bold label + gray description + a
//     right-aligned number badge (1–9). "Other" is the last numbered row and
//     reveals an inline free-text input inside the card.
//   • Keyboard: 1–9 select an option on the current page; Enter advances (Next)
//     or submits on the last page. The card owns these keys UNLESS focus is in
//     the composer or another text input — click into the composer to type a
//     free-text turn instead.
//   • Footer: right-aligned Skip (ghost) + Next/Submit, each showing its keybind
//     hint chip.
//
// When the agent asks MORE THAN ONE question we page through them one at a time;
// a single question renders with no paging chrome. Reply shape (allow +
// updatedInput.answers) is unchanged — see askUserQuestion.ts.

import { useCallback, useEffect, useState } from 'react';
import type { AgentPermissionRequestEvent } from '../../../shared/types';
import {
  buildAskUserQuestionReply,
  parseAskUserQuestion,
  type AskQuestion,
} from './askUserQuestion';

const OTHER = '__other__';

/** True when this question has a valid answer (a selection, and if "Other" is
 *  chosen, some free text for it). */
function isAnswered(
  q: AskQuestion,
  selections: Record<string, Set<string>>,
  otherText: Record<string, string>,
): boolean {
  const chosen = selections[q.question];
  if (!chosen || chosen.size === 0) return false;
  if (chosen.has(OTHER) && !(otherText[q.question] ?? '').trim()) return false;
  return true;
}

/** Is the user currently typing in a text field (composer, "Other" input, …)?
 *  When true the card yields its number/Enter keys so typing works normally. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

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
  // Which question page is visible (only meaningful when paged, i.e. 2+ Qs).
  const [page, setPage] = useState(0);
  // Collapsed = header only (chevron toggles it), matching the CC desktop chip.
  const [collapsed, setCollapsed] = useState(false);

  const paged = questions.length > 1;
  const current = questions[page];
  const onLastPage = page >= questions.length - 1;

  const toggle = useCallback(
    (q: AskQuestion, label: string) => {
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
    },
    [],
  );

  // Every question needs at least one answer (or an "Other" with text).
  const complete = questions.every((q) => isAnswered(q, selections, otherText));
  // The current page must be answered before you can advance to the next.
  const currentAnswered = current ? isAnswered(current, selections, otherText) : false;

  const submit = useCallback(() => {
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
  }, [onReply, otherText, questions, request.input, selections]);

  const advance = useCallback(() => {
    if (onLastPage) {
      if (complete) submit();
    } else if (currentAnswered) {
      setPage((p) => Math.min(questions.length - 1, p + 1));
    }
  }, [complete, currentAnswered, onLastPage, questions.length, submit]);

  const dismiss = useCallback(
    () => onReply({ behavior: 'deny', message: 'User dismissed the question.' }),
    [onReply],
  );

  // The options rendered on the current page, with "Other" appended as the last
  // numbered row (so number badges cover it too).
  const opts = current?.options ?? [];

  // Card owns 1–9 / Enter unless the user is typing in a field (composer, the
  // Other input, …). Escape dismisses. Window-level so it works before the card
  // is clicked, but yields the moment focus is in a text input.
  useEffect(() => {
    if (collapsed || !current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
        return;
      }
      if (isTypingTarget(e.target)) return; // yield to typing (composer etc.)
      if (e.key === 'Enter') {
        e.preventDefault();
        advance();
        return;
      }
      // Number keys 1..9 select the corresponding row ("Other" is last).
      if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const rows = opts.length + 1; // + Other
        if (idx < rows) {
          e.preventDefault();
          toggle(current, idx < opts.length ? opts[idx].label : OTHER);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, collapsed, current, dismiss, opts, toggle]);

  if (!current) return null;

  const chosen = selections[current.question] ?? new Set<string>();
  const otherActive = chosen.has(OTHER);

  return (
    <div className="av-q" role="group" aria-label="Question from the agent">
      <div className="av-q-head">
        <span className="av-q-pill" aria-label={`Question ${page + 1} of ${questions.length}`}>
          {page + 1}/{questions.length}
        </span>
        <span className="av-q-heading">{current.header || current.question}</span>
        <button
          type="button"
          className="av-q-icon-btn"
          aria-label={collapsed ? 'Expand question' : 'Collapse question'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d={collapsed ? 'M4 6l4 4 4-4' : 'M4 10l4-4 4 4'}
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="av-q-icon-btn"
          aria-label="Dismiss question"
          onClick={dismiss}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Show the full prompt text under the header when it differs from the
              short header chip (the header row shows header||question). */}
          {current.header && current.question && current.header !== current.question && (
            <p className="av-q-prompt">{current.question}</p>
          )}

          <div className="av-q-options">
            {opts.map((opt, i) => {
              const active = chosen.has(opt.label);
              return (
                <button
                  type="button"
                  key={opt.label}
                  className={`av-q-option${active ? ' av-q-option-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => toggle(current, opt.label)}
                >
                  <span className="av-q-option-main">
                    <span className="av-q-option-label">{opt.label}</span>
                    {opt.description && (
                      <span className="av-q-option-desc">{opt.description}</span>
                    )}
                  </span>
                  <span className="av-q-option-key" aria-hidden="true">
                    {i + 1}
                  </span>
                </button>
              );
            })}

            {/* "Other" free-text — the SDK always allows a custom answer. It is
                the LAST numbered row. */}
            <button
              type="button"
              className={`av-q-option av-q-option-other${otherActive ? ' av-q-option-active' : ''}`}
              aria-pressed={otherActive}
              onClick={() => toggle(current, OTHER)}
            >
              <span className="av-q-option-main">
                <span className="av-q-option-label">Other</span>
              </span>
              <span className="av-q-option-key" aria-hidden="true">
                {opts.length + 1}
              </span>
            </button>

            {otherActive && (
              <input
                className="av-q-other-input"
                type="text"
                autoFocus
                placeholder="Type your own answer here"
                value={otherText[current.question] ?? ''}
                onChange={(e) =>
                  setOtherText((prev) => ({ ...prev, [current.question]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    advance();
                  }
                }}
              />
            )}
          </div>

          <div className="av-q-actions">
            <button type="button" className="av-btn av-btn-ghost" onClick={dismiss}>
              Skip
            </button>
            <button
              type="button"
              className="av-btn av-btn-primary av-q-next"
              disabled={onLastPage ? !complete : !currentAnswered}
              onClick={advance}
            >
              {onLastPage ? (paged ? 'Submit' : 'Next') : 'Next'}
              <kbd className="av-q-kbd">Enter</kbd>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
