import React, { useState } from 'react';
import type { BusDelivery } from '../../../shared/bus-rows';

interface Props {
  /** The folded bus delivery (a parsed `orchestra check` lot + its ack state). */
  delivery: BusDelivery;
  /** Start expanded. Default false. Exists for the SSR render-smoke (same pattern
   *  as PeerMessageGroup/WakeRow). Production never passes it. */
  defaultOpen?: boolean;
}

/**
 * A bus DELIVERY (an `orchestra check` lot) rendered as a first-class row (issue
 * #145, Variant A — "quiet rows"). Instead of a raw JSON blob buried in a Bash
 * tool card, the lot folds into a readable view:
 *
 *   ✉ › Lot #312 · 2 messages   [wave-g-canary]   [ACKED]
 *       42 · status  impl-144 → ops-g   G1–G6 green, branch pushed…
 *       43 · ask     impl-142 → ops-g   restart path: keep …?
 *
 * The ACKED/PENDING badge flips PENDING→ACKED when a later `orchestra ack <lot>`
 * runs (resolved upstream in buildRenderItems, which sees the full transcript).
 *
 * DETECTED on the CLI invocation (`orchestra check`) + a parseable CheckOutput,
 * never body text (src/shared/bus-rows.ts). IDENTICAL live and backfill: both
 * paths are `tool` messages with the same `toolUse`/`toolResult`, folded through
 * the same shared helpers (the #57 live==backfill lesson).
 */
function DeliveryRowImpl({ delivery, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const { lot, count, run, messages, acked } = delivery;
  const empty = lot === null || count === 0;
  const lotLabel = lot === null ? 'no lot' : `Lot #${lot}`;
  const msgLabel = count === 1 ? '1 message' : `${count} messages`;
  // An empty lot (a check that found no mail) has nothing to ack and nothing to
  // expand — it renders as a quiet "no pending messages" line, no badge, no body.
  const canExpand = !empty && messages.length > 0;

  return (
    <div className={`av-deliv ${open ? 'av-open' : 'av-closed'}`} data-delivery="1">
      <button
        type="button"
        className="av-deliv-header"
        aria-expanded={canExpand ? open : undefined}
        disabled={!canExpand}
        onClick={() => canExpand && setOpen((o) => !o)}
      >
        <span className="av-deliv-icon" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4Zm1.4.5L8 8.2l4.6-3.7" />
          </svg>
        </span>
        {canExpand ? (
          <span className={`av-caret ${open ? 'av-caret-open' : ''}`} aria-hidden>
            <svg
              width="9"
              height="9"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5.5 3 10.5 8 5.5 13" />
            </svg>
          </span>
        ) : null}
        <span className="av-deliv-title">
          {empty ? (
            <>No pending messages · {run}</>
          ) : (
            <>
              {lotLabel} · {msgLabel}
            </>
          )}
        </span>
        {!empty ? <span className="av-deliv-runchip">{run}</span> : null}
        {!empty ? (
          <span
            className={`av-deliv-badge ${acked ? 'av-acked' : 'av-pending'}`}
            data-acked={acked ? '1' : '0'}
          >
            {acked ? 'acked' : 'pending'}
          </span>
        ) : null}
      </button>
      {open && canExpand && (
        <div className="av-deliv-body" data-delivery-body="1">
          {messages.map((m) => (
            <div className="av-deliv-msg" data-delivery-msg="1" key={m.sequence}>
              <div className="av-deliv-msg-meta">
                <span className="av-deliv-msg-seq">{m.sequence}</span>
                <span className="av-deliv-msg-kind">{m.kind}</span>
              </div>
              <div className="av-deliv-msg-route">
                {m.sender}
                {m.recipient ? ` → ${m.recipient}` : ''}
              </div>
              <div className="av-deliv-msg-body">{m.preview}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function sameMessages(a: BusDelivery, b: BusDelivery): boolean {
  if (a.messages.length !== b.messages.length) return false;
  for (let i = 0; i < a.messages.length; i++) {
    if (a.messages[i].sequence !== b.messages[i].sequence) return false;
  }
  return true;
}

function areEqual(a: Props, b: Props): boolean {
  return (
    a.delivery.lot === b.delivery.lot &&
    a.delivery.acked === b.delivery.acked &&
    a.delivery.count === b.delivery.count &&
    a.delivery.run === b.delivery.run &&
    sameMessages(a.delivery, b.delivery)
  );
}

export const DeliveryRow = React.memo(DeliveryRowImpl, areEqual);
