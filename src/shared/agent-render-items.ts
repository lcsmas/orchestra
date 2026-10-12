// The structured view's RENDER ITEMS (extracted from StructuredView.tsx so node --test can drive it): the flat RenderMessage[] folded
// into the rows the virtualized list renders. A run of consecutive `tool` messages is ONE `tool-group` item whose rows are the
// phone's tool lines (#374) — each from the shared `toolLine`, never a summary; every other message is its own item. Pure: no React.

import type { RenderMessage } from './types.ts';
import { toolLine, type ToolState } from './tool-line.ts';
import { isPeerMessage } from './peer-messages.ts';
import { isTaskNoticeMessage, parseTaskNotice, type TaskNoticeItem } from './task-notices.ts';
import { computeTurnDivider, type TurnDivider } from './message-time.ts';
import {
  isBusWakeMessage,
  isCheckInvocation,
  isAckInvocation,
  ackedLotId,
  parseCheckOutput,
  foldDelivery,
  type BusDelivery,
} from './bus-rows.ts';

// ── Render-item model ────────────────────────────────────────────────────────
//
// The transcript is a flat RenderMessage[]; we present it as RenderItem[] where a
// run of consecutive `tool` messages becomes ONE `tool-group` item: one always-visible line per tool (#374), a click opens that
// tool's card. A group's id is its first tool message's id — stable across renders, so its measured height survives scrolling.

/** One line of a tool group — the phone's label + state for a `tool` message, plus the message its card opens. */
export interface ToolRow {
  id: string;
  label: string;
  state: ToolState;
  message: RenderMessage;
}

export type RenderItem =
  | { kind: 'message'; id: string; message: RenderMessage; divider?: TurnDivider }
  | { kind: 'tool-group'; id: string; rows: ToolRow[] }
  // A run of consecutive INTER-AGENT messages, collapsed to compact rows so
  // fleet traffic doesn't drown the human's conversation (issue #56).
  | { kind: 'peer-group'; id: string; messages: RenderMessage[] }
  // A run of consecutive AVIS DE TÂCHE (the CLI's <task-notification> turns),
  // parsed into quiet rows instead of raw-XML bubbles (#273).
  | { kind: 'task-notices'; id: string; items: TaskNoticeItem[] }
  // A bus WAKE ORDER — the synthetic "run the check command(s)…" prompt,
  // rendered as a compact dedicated row instead of raw text (issue #145).
  | { kind: 'wake'; id: string; message: RenderMessage; divider?: TurnDivider }
  // A bus DELIVERY — an `orchestra check` lot, folded into a readable lot view
  // with an ACKED/PENDING badge (issue #145).
  | { kind: 'delivery'; id: string; delivery: BusDelivery };

/** Tools that must NOT be folded into the tool lines — they own a first-class,
 *  always-visible surface. TodoWrite is the live task list (Claude-Code shows it
 *  expanded, never buried); it renders as its own always-open ToolCard. */
export function isStandaloneTool(m: RenderMessage): boolean {
  return m.role === 'tool' && m.toolUse?.name === 'TodoWrite';
}

export function buildRenderItems(messages: RenderMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  let run: RenderMessage[] | null = null;
  // BUS ACK PRE-PASS (issue #145). A delivery row's ACKED/PENDING badge flips
  // when a LATER `orchestra ack <lot>` runs. Scan the whole transcript once up
  // front to collect every acked lot id, so a `check` at position i renders
  // ACKED as soon as its matching ack exists anywhere in the list — the same in
  // live and backfill (both are `tool` Bash cards). Acked lots are then folded
  // into `foldDelivery`; the ack tool cards themselves are dropped from the
  // render (the badge conveys the outcome — a raw `orchestra ack` bash line is
  // exactly the noise #145 removes).
  // A FAILED ack (toolResult.isError — a stale-fence refusal, a wrong lot id)
  // did NOT close the lot, so `ackedLotId` gates on !isError (REVIEW-145 F2):
  // only a successful ack flips the badge to ACKED.
  const ackedLots = new Set<number>();
  for (const m of messages) {
    const lot = ackedLotId(m as Parameters<typeof ackedLotId>[0]);
    if (lot !== null) ackedLots.add(lot);
  }
  // TURN DIVIDER bookkeeping: each USER turn gets a divider above its bubble
  // (time + day-on-change + idle gap ≥ 10 min). `prevAt` is the last stamped
  // message of ANY role, so the gap measures real transcript silence, not just
  // prompt-to-prompt distance. The divider rides INSIDE the user message's
  // virtualized row (rendered by ItemSlot) so row heights stay a pure function
  // of item content.
  const nowMs = Date.now();
  let prevAt: number | undefined;
  // Consecutive peer deliveries group into ONE collapsed item, the same way a
  // run of tools does — a wave of fleet messages reads as one quiet row.
  let peerRun: RenderMessage[] | null = null;
  const flushPeers = () => {
    if (peerRun && peerRun.length > 0) {
      items.push({ kind: 'peer-group', id: `pg:${peerRun[0].id}`, messages: peerRun });
    }
    peerRun = null;
  };
  // Consecutive avis de tâche group the same way (#273).
  let noticeRun: TaskNoticeItem[] | null = null;
  const flushNotices = () => {
    if (noticeRun && noticeRun.length > 0) {
      items.push({ kind: 'task-notices', id: `tn:${noticeRun[0].message.id}`, items: noticeRun });
    }
    noticeRun = null;
  };
  const flush = () => {
    if (run && run.length > 0) {
      items.push({
        kind: 'tool-group',
        id: `tg:${run[0].id}`,
        rows: run.map((message) => ({ id: message.id, ...toolLine(message), message })),
      });
    }
    run = null;
  };
  for (const m of messages) {
    // Peer messages break a tool run and accumulate into their own run. Checked
    // FIRST so a peer delivery never falls through to the user-bubble branch.
    // `isPeerMessage` is structural (the origin tag) — a human turn, whatever
    // its text, can never land here.
    if (isPeerMessage(m)) {
      flush();
      flushNotices();
      (peerRun ??= []).push(m);
      if (m.at !== undefined) prevAt = m.at;
      continue;
    }
    flushPeers();
    // AVIS DE TÂCHE (#273): keyed on the structural origin badge; a body the
    // parser does not fully recognize returns null and keeps the plain bubble.
    if (isTaskNoticeMessage(m)) {
      const notice = parseTaskNotice(m.text);
      if (notice) {
        flush();
        (noticeRun ??= []).push({ message: m, notice });
        if (m.at !== undefined) prevAt = m.at;
        continue;
      }
    }
    flushNotices();
    // BUS WAKE (issue #145): a synthetic `role:'user'` prompt whose text is the
    // wake order (marker-keyed via `isBusWakeMessage`, never body text — a human
    // turn saying "lot pending" fails the structured shape and falls through to
    // the ordinary user bubble below). Breaks a tool run like any user turn and
    // carries its own turn divider.
    if (isBusWakeMessage(m)) {
      flush();
      const divider =
        m.at !== undefined ? computeTurnDivider(m.at, prevAt, nowMs) : undefined;
      items.push({ kind: 'wake', id: m.id, message: m, ...(divider ? { divider } : {}) });
      if (m.at !== undefined) prevAt = m.at;
      continue;
    }
    // BUS ACK (issue #145): an `orchestra ack <lot>` Bash card folds away — its
    // outcome is the delivery row's badge flip (collected in the pre-pass). Drop
    // it from the render so no raw ack bash line survives. Checked BEFORE the
    // tool-run branch so it never joins a collapsed tool group.
    if (isAckInvocation(m as Parameters<typeof isAckInvocation>[0])) {
      flush();
      if (m.at !== undefined) prevAt = m.at;
      continue;
    }
    // BUS DELIVERY (issue #145): an `orchestra check` Bash card whose result
    // parses to the published CheckOutput shape folds into a first-class
    // delivery row. Keyed on the CLI INVOCATION + a parseable result, never body
    // text — a non-bus Bash card, or a check whose output is unparseable, falls
    // through to the ordinary tool run. Same detection live and backfill (both
    // are `tool` Bash cards with the same toolUse/toolResult).
    if (isCheckInvocation(m as Parameters<typeof isCheckInvocation>[0])) {
      const out = parseCheckOutput(m as Parameters<typeof parseCheckOutput>[0]);
      if (out) {
        flush();
        items.push({
          kind: 'delivery',
          id: `bd:${m.id}`,
          delivery: foldDelivery(out, ackedLots),
        });
        if (m.at !== undefined) prevAt = m.at;
        continue;
      }
      // An unparseable check (an error, a truncated stream) is left as a normal
      // tool card so the user still sees SOMETHING went wrong — fall through.
    }
    if (m.role === 'tool' && !isStandaloneTool(m)) {
      (run ??= []).push(m);
    } else {
      // A standalone tool (TodoWrite) and any non-tool message both break the
      // current run and render as their own item.
      flush();
      const divider =
        m.role === 'user' && m.at !== undefined
          ? computeTurnDivider(m.at, prevAt, nowMs)
          : undefined;
      items.push({ kind: 'message', id: m.id, message: m, ...(divider ? { divider } : {}) });
    }
    if (m.at !== undefined) prevAt = m.at;
  }
  flush();
  flushPeers();
  flushNotices();
  return items;
}
