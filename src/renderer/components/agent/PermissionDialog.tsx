// Native permission approve/deny dialog for the structured agent view. THIS is
// what replaces terminal permission-scraping, so it must be reliable.
//
// Driven purely by AgentSession.pendingPermissions (folded from the event
// stream). Each open request is a parked `canUseTool` call in main; we answer it
// via window.orchestra.agentSdkPermissionReply(wsId, requestId, reply), and the
// store folds clearPendingPermission on that requestId. We also call
// clearPendingPermission-equivalent optimistically via the onReplied callback so
// the UI never shows a stale prompt if the fold is delayed.
//
// SAFETY: Enter does NOT allow. A permission prompt is a deliberate, dangerous
// action — we require an explicit click. Escape is wired to DENY (the safe
// default), not to allow or to a silent dismiss. Allow is never auto-focused.
//
// Multiple queued permissions are shown one at a time, in arrival order.

import { useEffect, useState } from 'react';
import type {
  AgentPermissionReply,
  AgentPermissionRequestEvent,
  AgentSession,
} from '../../../shared/types';
import { ToolInput } from './toolInput';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { ASK_USER_QUESTION, parseAskUserQuestion } from './askUserQuestion';

export function PermissionDialog({
  workspaceId,
  session,
  /** Optional hook so the store can clear the pending entry immediately after a
   *  reply (belt & suspenders — main also clears it). */
  onReplied,
}: {
  workspaceId: string;
  session: AgentSession | undefined;
  onReplied?: (requestId: string) => void;
}) {
  const pending = session?.pendingPermissions ?? [];

  // Track requestIds we have already answered so a lagging fold can't resurrect
  // a prompt we just resolved.
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  // Show the first UNANSWERED pending request (arrival order). Using the first
  // *unanswered* one — not simply pending[0] — matters when the store's clear
  // lags our reply: pending[0] can still be the request we just answered, and
  // the next queued prompt must surface immediately rather than wait for main
  // to fold the clear.
  const active: AgentPermissionRequestEvent | undefined = pending.find(
    (p) => !answered.has(p.requestId),
  );

  const reply = (requestId: string, r: AgentPermissionReply) => {
    setAnswered((prev) => new Set(prev).add(requestId));
    void window.orchestra.agentSdkPermissionReply(workspaceId, requestId, r);
    onReplied?.(requestId);
  };

  // Escape = deny (safe default). Never allow on a keystroke.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        reply(active.requestId, { behavior: 'deny', message: 'Denied by user.' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.requestId, workspaceId]);

  if (!active) return null;

  const isQuestion =
    active.name === ASK_USER_QUESTION && parseAskUserQuestion(active.name, active.input) != null;
  const remaining = pending.filter((p) => !answered.has(p.requestId)).length;

  return (
    <div className="av-permission-backdrop" role="presentation">
      <div
        className="av-permission-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="av-permission-title"
      >
        <div className="av-permission-header">
          <span className="av-permission-eyebrow">
            {isQuestion ? 'The agent is asking' : 'Permission required'}
          </span>
          {remaining > 1 && (
            <span className="av-permission-queue" aria-label={`${remaining} pending requests`}>
              1 of {remaining}
            </span>
          )}
        </div>

        {isQuestion ? (
          <AskUserQuestionCard
            request={active}
            onReply={(r) => reply(active.requestId, r)}
          />
        ) : (
          <PermissionRequestBody
            request={active}
            onAllow={() => reply(active.requestId, { behavior: 'allow' })}
            onDeny={(message) => reply(active.requestId, { behavior: 'deny', message })}
          />
        )}
      </div>
    </div>
  );
}

/** The allow/deny body for a normal (non-question) tool request. */
function PermissionRequestBody({
  request,
  onAllow,
  onDeny,
}: {
  request: AgentPermissionRequestEvent;
  onAllow: () => void;
  onDeny: (message: string) => void;
}) {
  // Two-step deny: reveal a reason field so the model gets a useful message.
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <>
      <h2 id="av-permission-title" className="av-permission-title">
        Allow <code className="av-permission-tool">{request.name}</code>?
      </h2>
      {request.title && <p className="av-permission-subtitle">{request.title}</p>}

      <div className="av-permission-input">
        <ToolInput name={request.name} input={request.input} />
      </div>

      {denying ? (
        <div className="av-permission-deny">
          <label className="av-permission-deny-label" htmlFor="av-permission-reason">
            Reason (sent to the agent)
          </label>
          <textarea
            id="av-permission-reason"
            className="av-permission-reason"
            autoFocus
            rows={2}
            placeholder="Why are you denying this?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="av-permission-actions">
            <button
              type="button"
              className="av-btn av-btn-ghost"
              onClick={() => setDenying(false)}
            >
              Back
            </button>
            <button
              type="button"
              className="av-btn av-btn-danger"
              onClick={() => onDeny(reason.trim() || 'Denied by user.')}
            >
              Confirm deny
            </button>
          </div>
        </div>
      ) : (
        <div className="av-permission-actions">
          {/* Deny is the SAFE default and comes FIRST. Allow is never
              auto-focused and never triggered by Enter. */}
          <button
            type="button"
            className="av-btn av-btn-danger"
            onClick={() => setDenying(true)}
          >
            Deny
          </button>
          <button type="button" className="av-btn av-btn-primary" onClick={onAllow}>
            Allow
          </button>
        </div>
      )}
    </>
  );
}
