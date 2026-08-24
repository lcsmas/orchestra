// Answerable card for an MCP `onElicitation` request (#21).
//
// An MCP server is asking the USER for input. Two modes (SDK ElicitationRequest):
//   • 'form' — fill `requestedSchema`'s fields and Submit → {action:'accept',content}
//   • 'url'  — visit a URL (browser-based auth), then confirm → {action:'accept'}
//
// Before this existed, an elicitation with no callback wired was AUTO-DECLINED
// by the SDK, so an MCP server needing auth just quietly failed.
//
// Decline vs Cancel are distinct in the MCP contract and both are offered:
// Decline is a considered "no" the server can act on; dismissing (Escape, via
// the slot) is Cancel.
//
// The schema→fields logic lives in src/shared/elicitation-form.ts (unit-tested
// there); this component is a renderer over that output.

import { useMemo, useState } from 'react';
import type {
  AgentElicitationReply,
  AgentElicitationRequestEvent,
  AgentElicitationValue,
} from '../../../shared/types';
import {
  buildElicitationContent,
  initialElicitationValues,
  isElicitationComplete,
  parseElicitationSchema,
} from '../../../shared/elicitation-form';

export function ElicitationCard({
  request,
  onReply,
}: {
  request: AgentElicitationRequestEvent;
  onReply: (reply: AgentElicitationReply) => void;
}) {
  const fields = useMemo(
    () => (request.mode === 'form' ? parseElicitationSchema(request.requestedSchema) : []),
    [request.mode, request.requestedSchema],
  );
  const [values, setValues] = useState<Record<string, AgentElicitationValue>>(() =>
    initialElicitationValues(fields),
  );

  const setField = (name: string, v: AgentElicitationValue) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  const complete = isElicitationComplete(fields, values);
  const isUrl = request.mode === 'url';

  const accept = () => {
    if (isUrl || fields.length === 0) {
      // No form to send: a url-mode confirmation and a message-only
      // elicitation both accept with no content.
      onReply({ action: 'accept' });
      return;
    }
    onReply({ action: 'accept', content: buildElicitationContent(fields, values) });
  };

  return (
    <div
      className="av-permission-dialog av-elicitation-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="av-elicitation-title"
      data-elicitation-mode={request.mode}
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
              <path d="M8 1.8 13 3.6v3.6c0 3.2-2 5.6-5 7-3-1.4-5-3.8-5-7V3.6z" />
              <path d="M8 6v3M8 11h.01" />
            </svg>
          </span>
          {request.displayName || request.serverName || 'MCP server'} needs input
        </span>
      </div>

      <h2 id="av-elicitation-title" className="av-permission-title">
        {request.title || request.message || 'Provide input'}
      </h2>
      {/* Don't repeat the message when it was promoted into the title above. */}
      {request.title && request.message && (
        <p className="av-permission-subtitle">{request.message}</p>
      )}
      {request.description && <p className="av-permission-subtitle">{request.description}</p>}

      {isUrl ? (
        <div className="av-elicitation-url">
          {/* Deliberately NOT auto-opened: an agent-triggered navigation must
              be a user gesture. `noreferrer` keeps the app origin off the
              third-party auth page. */}
          <a href={request.url} target="_blank" rel="noreferrer noopener">
            {request.url}
          </a>
          <p className="av-elicitation-hint">
            Open the link, complete the sign-in, then choose Done.
          </p>
        </div>
      ) : (
        fields.length > 0 && (
          <div className="av-elicitation-fields">
            {fields.map((f) => {
              const id = `av-elicit-${f.name}`;
              const value = values[f.name];
              return (
                <div className="av-elicitation-field" key={f.name}>
                  <label className="av-elicitation-label" htmlFor={id}>
                    {f.label}
                    {f.required && (
                      <span className="av-elicitation-required" aria-hidden="true">
                        {' '}
                        *
                      </span>
                    )}
                  </label>
                  {f.description && <p className="av-elicitation-desc">{f.description}</p>}
                  {f.kind === 'enum' ? (
                    <select
                      id={id}
                      className="av-elicitation-input"
                      value={String(value ?? '')}
                      onChange={(e) => setField(f.name, e.target.value)}
                    >
                      {f.options?.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : f.kind === 'boolean' ? (
                    <input
                      id={id}
                      type="checkbox"
                      className="av-elicitation-checkbox"
                      checked={value === true}
                      onChange={(e) => setField(f.name, e.target.checked)}
                    />
                  ) : (
                    <input
                      id={id}
                      // Kept as a TEXT input for numbers too: the value is
                      // coerced at submit (buildElicitationContent), so the
                      // user can type '-' or '' mid-edit without the control
                      // fighting them or producing NaN.
                      type="text"
                      inputMode={f.kind === 'string' ? undefined : 'numeric'}
                      className="av-elicitation-input"
                      value={String(value ?? '')}
                      onChange={(e) => setField(f.name, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      <div className="av-permission-actions">
        <button
          type="button"
          className="av-btn av-btn-ghost"
          onClick={() => onReply({ action: 'decline' })}
        >
          Decline
        </button>
        <button
          type="button"
          className="av-btn av-btn-primary"
          disabled={!complete}
          onClick={accept}
        >
          {isUrl ? 'Done' : 'Submit'}
        </button>
      </div>
    </div>
  );
}
