// The read-only fleet-bus pane (#118, ledger #123 — the human-readable
// projection of #108 Q7a).
//
// READ-ONLY IN v1. Nothing here writes: no gate resolution, no ack, no send.
// The only mutation the component performs is selecting which run to look at,
// which is local React state. The enumeration proving it is
// `BUS_PANE_IPC_CHANNELS` in src/main/bus-pane.ts — the registrar refuses a
// channel marked `writes: true`.
//
// THE UNAVAILABLE STATE IS THE FIRST THING THIS FILE HANDLES, deliberately.
// D1 (LEAD ruling, ledger #122) makes `getBus() === null` a normal condition —
// the bus opens after the window and may never open at all. A pane that renders
// a blank list in that case is indistinguishable from a quiet bus, which is the
// exact failure T118.5 names. So `available: false` renders a loud, diagnosable
// block naming the DB path and the error, not an empty table.

import { useCallback, useEffect, useState } from 'react';
import {
  BUS_MECHANISMS,
  BUS_MECHANISM_LABEL,
  switchStateWord,
  type BusMechanism,
} from '../../shared/bus-switches';
import type {
  BusSnapshot,
  BusRunSummary,
  BusMessageView,
  BusGateView,
  BusMemberLiveness,
  BusDivergenceCounter,
} from '../../shared/bus-view';

function fmtTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * The mission → wave tree. Runs nest through `parentRunId`; a run whose parent
 * is not in the list renders at top level rather than disappearing, because a
 * truncated list (LIMIT on the query) would otherwise silently swallow whole
 * subtrees whose parent fell off the end.
 */
export function BusRunTree({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: BusRunSummary[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
}) {
  const ids = new Set(runs.map((r) => r.id));
  const roots = runs.filter((r) => !r.parentRunId || !ids.has(r.parentRunId));
  const childrenOf = (id: string) => runs.filter((r) => r.parentRunId === id);

  const row = (r: BusRunSummary, depth: number): React.ReactNode => (
    <div key={r.id}>
      <button
        type="button"
        className={`bus-run-row${r.id === selectedRunId ? ' is-selected' : ''}`}
        data-run-id={r.id}
        data-run-kind={r.kind}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(r.id)}
      >
        <span className="bus-run-kind">{r.kind}</span>
        <span className="bus-run-title">{r.title || r.id}</span>
        <span className="bus-run-coordinator">{r.coordinator}</span>
        {/* The FROZEN flags, rendered per run — this is the run's own record of
            what it obeyed, not the live switches. A run started while `wake`
            was on keeps showing wake=ON after the switch is flipped off. */}
        <span className="bus-run-flags">
          {BUS_MECHANISMS.map((m) => (
            <span
              key={m}
              className="bus-run-flag"
              data-mechanism={m}
              data-frozen-state={switchStateWord(r.flags[m])}
              title={`${BUS_MECHANISM_LABEL[m]} — frozen at wave start`}
            >
              {m}={switchStateWord(r.flags[m])}
            </span>
          ))}
        </span>
        {r.closedAt ? <span className="bus-run-closed">closed</span> : null}
      </button>
      {childrenOf(r.id).map((c) => row(c, depth + 1))}
    </div>
  );

  if (!runs.length) {
    return (
      <div className="bus-empty" data-bus-empty="runs">
        No runs on the bus yet.
      </div>
    );
  }
  return <div className="bus-run-tree">{roots.map((r) => row(r, 0))}</div>;
}

/** Messages in TOTAL ORDER (by `sequence`) with type + thread. */
export function BusMessageList({ messages }: { messages: BusMessageView[] }) {
  if (!messages.length) {
    return (
      <div className="bus-empty" data-bus-empty="messages">
        No messages in this run yet.
      </div>
    );
  }
  return (
    <table className="bus-messages">
      <tbody>
        {messages.map((m) => (
          <tr key={m.sequence} className="bus-message" data-sequence={m.sequence}>
            <td className="bus-seq">#{m.sequence}</td>
            <td className="bus-kind" data-kind={m.kind}>
              {m.kind}
            </td>
            <td className="bus-thread">{m.threadId ? `↳ ${m.threadId}` : ''}</td>
            <td className="bus-sender">{m.sender}</td>
            <td className="bus-recipient">{m.recipient ? `→ ${m.recipient}` : '→ all'}</td>
            <td className="bus-body">{m.body}</td>
            <td className="bus-at">{fmtTime(m.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Liveness + phase + the pending lot per reader. */
export function BusMemberList({ members }: { members: BusMemberLiveness[] }) {
  if (!members.length) {
    return (
      <div className="bus-empty" data-bus-empty="members">
        No members have spoken in this run yet.
      </div>
    );
  }
  return (
    <table className="bus-members">
      <tbody>
        {members.map((m) => (
          <tr key={m.handle} className="bus-member" data-handle={m.handle}>
            <td className="bus-member-handle">{m.handle}</td>
            <td className="bus-member-phase">{m.phase ?? '—'}</td>
            <td className="bus-member-seen">{fmtTime(m.lastSeenAt)}</td>
            <td className="bus-member-pending" data-pending-count={m.pendingCount}>
              {m.pendingLotId === null
                ? 'no pending lot'
                : `lot ${m.pendingLotId} · ${m.pendingCount} pending`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Open asks / decision gates. READ-ONLY — resolving from here is v2. */
export function BusGateList({ gates }: { gates: BusGateView[] }) {
  const open = gates.filter((g) => g.resolvedAt === null);
  const resolved = gates.filter((g) => g.resolvedAt !== null);
  if (!gates.length) {
    return (
      <div className="bus-empty" data-bus-empty="gates">
        No asks or gates in this run.
      </div>
    );
  }
  return (
    <div className="bus-gates">
      {open.map((g) => (
        <div key={g.id} className="bus-gate is-open" data-gate-id={g.id} data-gate-state="open">
          <span className="bus-gate-badge">OPEN</span>
          <span className="bus-gate-asker">{g.askedBy}</span>
          <span className="bus-gate-question">{g.question}</span>
        </div>
      ))}
      {resolved.map((g) => (
        <div
          key={g.id}
          className="bus-gate is-resolved"
          data-gate-id={g.id}
          data-gate-state="resolved"
        >
          <span className="bus-gate-badge">RULED</span>
          <span className="bus-gate-question">{g.question}</span>
          <span className="bus-gate-ruling">{g.resolution}</span>
          <span className="bus-gate-asker">{g.resolvedBy}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Shadow divergence counters, per mechanism — #116's numbers in the frozen
 * shape (ledger #123 §Seams).
 *
 * An EMPTY list does not render as zeros. "#116 has not landed" and "zero
 * divergence" are the same empty array on the wire, and showing `0 / 0 / 0`
 * for the first would be a fabricated measurement from an instrument that was
 * never connected (carry-forward 4). So the empty case says exactly that.
 */
export function BusCounterTable({ counters }: { counters: BusDivergenceCounter[] }) {
  if (!counters.length) {
    return (
      <div className="bus-empty" data-bus-empty="counters">
        No divergence counters reported for this run — the shadow mirror is not
        publishing counters. This is NOT the same as zero divergence.
      </div>
    );
  }
  return (
    <table className="bus-counters">
      <thead>
        <tr>
          <th>mechanism</th>
          <th>missed</th>
          <th>duplicate</th>
          <th>lost wake</th>
        </tr>
      </thead>
      <tbody>
        {counters.map((c) => (
          <tr key={c.mechanism} className="bus-counter" data-mechanism={c.mechanism}>
            <td>{c.mechanism}</td>
            <td data-counter="missed">{c.missed}</td>
            <td data-counter="duplicate">{c.duplicate}</td>
            <td data-counter="lostWake">{c.lostWake}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * THE BUS-UNAVAILABLE STATE (T118.5, D1).
 *
 * A distinct, loud block — never an empty list. It names the DB path and the
 * underlying error so the condition is diagnosable from the UI alone, and it
 * says the app is otherwise fine, because the whole point of D1 is that a dead
 * bus is not a dead Orchestra.
 */
export function BusUnavailable({ path, error }: { path: string; error: string | null }) {
  return (
    <div className="bus-unavailable" data-bus-state="unavailable" role="alert">
      <div className="bus-unavailable-title">Fleet bus unavailable</div>
      <div className="bus-unavailable-body">
        Orchestra started normally — the bus never blocks boot — but the fleet bus
        could not be opened, so there is nothing to project here. Every other
        subsystem is unaffected.
      </div>
      <div className="bus-unavailable-path">
        <span className="bus-unavailable-label">database</span>
        <code>{path}</code>
      </div>
      {error ? (
        <div className="bus-unavailable-error">
          <span className="bus-unavailable-label">error</span>
          <code>{error}</code>
        </div>
      ) : null}
    </div>
  );
}

/** The live switch values, read-only in this pane (editing lives in Settings). */
export function BusSwitchSummary({ live }: { live: Record<BusMechanism, boolean> }) {
  return (
    <div className="bus-switches" data-bus-switches="live">
      {BUS_MECHANISMS.map((m) => (
        <span
          key={m}
          className="bus-switch"
          data-mechanism={m}
          data-live-state={switchStateWord(live[m])}
        >
          {BUS_MECHANISM_LABEL[m]}: {switchStateWord(live[m])}
        </span>
      ))}
      <span className="bus-switch-note">
        Live values. A run obeys the copy frozen onto its row at wave start —
        flipping a switch never changes a run already in flight.
      </span>
    </div>
  );
}

/** The whole pane. Pure render given a snapshot — `BusPane` fetches. */
export function BusPaneView({
  snapshot,
  onSelectRun,
}: {
  snapshot: BusSnapshot;
  onSelectRun: (id: string) => void;
}) {
  if (!snapshot.available) {
    return (
      <div className="bus-pane" data-bus-pane="root">
        <BusUnavailable path={snapshot.path} error={snapshot.error} />
      </div>
    );
  }
  return (
    <div className="bus-pane" data-bus-pane="root" data-bus-state="available">
      <BusSwitchSummary live={snapshot.liveSwitches} />
      <section className="bus-section" data-section="runs">
        <h3>Runs</h3>
        <BusRunTree
          runs={snapshot.runs}
          selectedRunId={snapshot.selectedRunId}
          onSelect={onSelectRun}
        />
      </section>
      <section className="bus-section" data-section="members">
        <h3>Members</h3>
        <BusMemberList members={snapshot.members} />
      </section>
      <section className="bus-section" data-section="gates">
        <h3>Asks &amp; gates</h3>
        <BusGateList gates={snapshot.gates} />
      </section>
      <section className="bus-section" data-section="counters">
        <h3>Shadow divergence</h3>
        <BusCounterTable counters={snapshot.counters} />
      </section>
      <section className="bus-section" data-section="messages">
        <h3>Messages</h3>
        <BusMessageList messages={snapshot.messages} />
      </section>
    </div>
  );
}

/** Container: polls the read-only snapshot. */
export function BusPane() {
  const [snapshot, setSnapshot] = useState<BusSnapshot | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await window.orchestra.busSnapshot(runId);
      setSnapshot(s);
    } catch (e) {
      // The main handler is written never to throw, so reaching here means the
      // IPC itself failed (main gone, channel unregistered). Render the same
      // unavailable state rather than an empty pane — see T118.5.
      setSnapshot({
        available: false,
        error: e instanceof Error ? e.message : String(e),
        path: '(unknown — the main process did not answer)',
        liveSwitches: { delivery: false, wake: false, askGate: false, liveness: false },
        runs: [],
        selectedRunId: null,
        messages: [],
        gates: [],
        members: [],
        counters: [],
      });
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!snapshot) return <div className="bus-pane" data-bus-pane="loading" />;
  return <BusPaneView snapshot={snapshot} onSelectRun={setRunId} />;
}
