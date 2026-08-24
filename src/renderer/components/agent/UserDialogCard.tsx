// Answerable card for an `onUserDialog` request (#21).
//
// The CLI asks the host to render a BLOCKING dialog; until this existed the
// session simply parked until the CLI's deadline with nothing on screen — the
// "agent looks busy but is actually stuck" symptom.
//
// RENDERED GENERICALLY, ON PURPOSE. `dialogKind` is an OPEN string union and
// `payload` is defined per kind and transported opaquely (SDK sdk.d.ts), so
// switching on the kind would mean shipping a new component for every kind the
// CLI ever adds — and until then rendering nothing. Instead we read the payload
// for the few conventional presentation keys (title/message/options) and fall
// back to showing the payload itself. That is what makes
// `SUPPORTED_DIALOG_KINDS` safe to extend in agent-sdk.ts without touching UI.
//
// Reply shape mirrors the SDK `UserDialogResult`: an option click completes
// with that option's value; dismissing is `cancelled`, which makes the CLI
// apply the dialog's own default behaviour (a real settlement, not a refusal
// to answer — see the note in agent-sdk.ts).

import type { AgentUserDialogReply, AgentUserDialogRequestEvent } from '../../../shared/types';
import { dialogOptionsFromPayload, dialogTextFromPayload } from './userDialog';

export function UserDialogCard({
  request,
  onReply,
}: {
  request: AgentUserDialogRequestEvent;
  onReply: (reply: AgentUserDialogReply) => void;
}) {
  const { title, message } = dialogTextFromPayload(request.dialogKind, request.payload);
  const options = dialogOptionsFromPayload(request.payload);

  return (
    <div
      className="av-permission-dialog av-dialog-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="av-dialog-title"
      data-dialog-kind={request.dialogKind}
    >
      <div className="av-permission-header">
        <span className="av-permission-eyebrow">
          <span className="av-permission-icon" aria-hidden="true">
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2.5 3.5h11v8h-6l-3 2.5v-2.5h-2z" />
            </svg>
          </span>
          Claude needs an answer
        </span>
      </div>

      <h2 id="av-dialog-title" className="av-permission-title">
        {title}
      </h2>
      {message && <p className="av-permission-subtitle av-dialog-message">{message}</p>}

      {/* No recognized presentation keys: show the raw payload rather than an
          empty card, so the user can still make an informed choice. */}
      {!message && Object.keys(request.payload).length > 0 && (
        <pre className="av-dialog-payload">{JSON.stringify(request.payload, null, 2)}</pre>
      )}

      <div className="av-permission-actions">
        <button
          type="button"
          className="av-btn av-btn-ghost"
          onClick={() => onReply({ behavior: 'cancelled' })}
        >
          Dismiss
        </button>
        {options.length > 0 ? (
          options.map((opt, i) => (
            <button
              key={opt.value}
              type="button"
              className={i === options.length - 1 ? 'av-btn av-btn-primary' : 'av-btn'}
              onClick={() => onReply({ behavior: 'completed', result: opt.value })}
            >
              {opt.label}
            </button>
          ))
        ) : (
          // A dialog with no options in its payload is a simple acknowledge —
          // `true` is the conventional "the user confirmed" result.
          <button
            type="button"
            className="av-btn av-btn-primary"
            onClick={() => onReply({ behavior: 'completed', result: true })}
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
