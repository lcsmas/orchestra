// Shadow mirror — the PURE half (#116, ledger #123).
//
// Shadow mode (#108 Q8a, ADR 0002 "coexistence until proven"): the OLD channel
// (`dispatchMessageRequest` → sdkSend / PTY / wake / inbox) stays AUTHORITATIVE,
// and the host ALSO writes each send into the bus so the two can be compared.
// Agents change nothing. After two complete waves at 0/0/0 divergence a
// mechanism may be promoted (#108 Q4).
//
// THE HARD CONSTRAINT that shapes this file: the mirror is READ-ONLY with
// respect to delivery. It must never change what the old channel does and must
// never block it — a bus failure LOGS and CONTINUES. That is why the decision
// logic lives HERE, pure, in `src/shared`: it can be unit- and mutation-tested
// without an Electron session, so the only thing left in the impure half
// (`src/main/bus-mirror.ts`) is the try/catch and the INSERT.

/** The delivery outcome of the OLD channel, recorded alongside the bus row.
 *
 *  Three values, because the old channel really has three fates and #116's
 *  acceptance 3 requires each one observed in a rig that PRODUCES it:
 *
 *   - `live`      the message became the target's turn (SDK turn started, or
 *                 typed into a running PTY, or a wake started the agent)
 *   - `inbox`     parked in the durable inbox file for the next SessionStart
 *   - `withdrawn` the old channel did NOT deliver at all (`ok: false`) —
 *                 unknown target, empty text, self-send, inbox write failed
 *
 *  An outcome column that only ever holds one value across the three rigs is
 *  the ticket's own stated DISPROOF, so these must be genuinely distinguishable
 *  from a `MessageResult` alone — which is exactly what {@link outcomeFor} is.
 */
export type MirrorOutcome = 'live' | 'inbox' | 'withdrawn';

/** The subset of `MessageResult` the mirror reads. Declared structurally rather
 *  than imported from the main-process types so this module stays free of any
 *  Electron-side import. */
export interface MirrorableResult {
  ok: boolean;
  /** `dispatchMessageRequest`'s own ladder. `started` means a STOPPED agent was
   *  woken and handed the message as its next turn — a real live delivery, so
   *  it maps to `live`, not to a fourth outcome. */
  delivery?: 'live' | 'started' | 'inbox';
}

/**
 * Map the old channel's own report onto the recorded outcome.
 *
 * `ok: false` is `withdrawn` FIRST, before any look at `delivery`: a failed
 * dispatch may still carry a stale `delivery` field from a partial path, and
 * recording that as a delivery is precisely the "reported the stronger false
 * status" defect #57 exists to kill.
 */
export function outcomeFor(result: MirrorableResult): MirrorOutcome {
  if (!result.ok) return 'withdrawn';
  switch (result.delivery) {
    case 'live':
    case 'started':
      return 'live';
    case 'inbox':
      return 'inbox';
    default:
      // ok:true with no delivery field is not a shape dispatchMessageRequest
      // produces today. Recording it as `withdrawn` rather than guessing `live`
      // keeps the honest-weaker-status rule: an unknown disposition is not a
      // delivery.
      return 'withdrawn';
  }
}

// ─── Divergence counters ────────────────────────────────────────────────────

/** The FROZEN inter-ticket contract (ledger #123 §Seams) that #118 renders and
 *  `orchestra bus-status` prints. Scoped to one run. Changing this shape is a
 *  §Open-questions entry, never a unilateral edit. */
export interface DivergenceCounters {
  /** Which coexisting channel these numbers describe (e.g. `peer-message`). */
  mechanism: string;
  /** The old channel delivered, and no bus row exists for that send. */
  missed: number;
  /** More than one bus row exists for a single send. */
  duplicate: number;
  /** The bus says a lot is pending for a reader, and no turn started within the
   *  staleness window. */
  lostWake: number;
}

/** The mechanism name this ticket's mirror reports under. One constant so the
 *  main process, the CLI and #118's pane can never disagree on the spelling. */
export const PEER_MESSAGE_MECHANISM = 'peer-message';

/**
 * How ONE send was mirrored, as the counter accumulator sees it.
 *
 * `rows` is the number of bus rows the mirror actually produced for this send —
 * 0 when the insert failed (or the bus was down), 1 in the healthy case, 2+ only
 * if something mirrored twice. Counting ROWS rather than "did it throw" is
 * deliberate: absence of an exception is not presence of a row (carry-forward
 * 3), and the duplicate counter has to be able to see a value it cannot reach
 * from an error flag.
 */
export interface MirrorAttempt {
  mechanism: string;
  /** What the OLD channel did. */
  outcome: MirrorOutcome;
  /** Bus rows written for this one send. */
  rows: number;
}

/**
 * Per-run, per-mechanism divergence tallies.
 *
 * Deliberately a plain in-memory accumulator rather than a SQL aggregate: D1
 * says `getBus()` can be null at ANY moment, and the counter that has to record
 * "the bus was down for this send" cannot itself live in the bus. A run's
 * numbers therefore survive a bus outage — which is the whole point, since a
 * bus outage is the single largest source of `missed`.
 */
export class DivergenceLedger {
  private readonly byMechanism = new Map<string, DivergenceCounters>();

  readonly runId: string;

  // Written out longhand, NOT as a parameter property: the repo's test runner is
  // `node --test --experimental-strip-types`, which rejects `constructor(readonly
  // x)` with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. tsc accepts it, so the shorthand
  // typechecks clean and fails only at test time.
  constructor(runId: string) {
    this.runId = runId;
  }

  private slot(mechanism: string): DivergenceCounters {
    let c = this.byMechanism.get(mechanism);
    if (!c) {
      c = { mechanism, missed: 0, duplicate: 0, lostWake: 0 };
      this.byMechanism.set(mechanism, c);
    }
    return c;
  }

  /** Ensure a mechanism appears in the report with explicit zeros.
   *
   *  Load-bearing for T116.4's second half: a counter whose ZERO is unobservable
   *  is as useless as one that never moves. A mechanism that is mirroring
   *  cleanly must still show up as `0/0/0` — otherwise "no divergence" and "the
   *  mirror never ran" are the same observable. */
  register(mechanism: string): void {
    this.slot(mechanism);
  }

  /**
   * Record one mirrored send.
   *
   * `missed` fires when the OLD CHANNEL DELIVERED (live or inbox — both are
   * real deliveries the bus was supposed to shadow) and NO bus row landed.
   * A `withdrawn` send is deliberately NOT a miss: the old channel delivered
   * nothing, so the bus having nothing is agreement, not divergence. Counting
   * it would make the counter permanently non-zero for every self-send typo and
   * drown the signal the promotion bar reads.
   */
  record(attempt: MirrorAttempt): void {
    const c = this.slot(attempt.mechanism);
    const delivered = attempt.outcome === 'live' || attempt.outcome === 'inbox';
    if (delivered && attempt.rows === 0) c.missed++;
    if (attempt.rows > 1) c.duplicate += attempt.rows - 1;
  }

  /** A reader had a pending lot and no turn started inside the window. Recorded
   *  by the host's staleness sweep, not by the send path. */
  recordLostWake(mechanism: string, n = 1): void {
    this.slot(mechanism).lostWake += n;
  }

  /** The frozen contract shape, sorted by mechanism so two reads of an
   *  unchanged ledger are byte-identical (a pane diffing them must not see
   *  spurious churn from Map insertion order). */
  snapshot(): DivergenceCounters[] {
    return [...this.byMechanism.values()]
      .map((c) => ({ ...c }))
      .sort((a, b) => a.mechanism.localeCompare(b.mechanism));
  }
}

/** What the IPC method and `orchestra bus-status` both return — the counters
 *  plus the run they are scoped to, and whether the bus is reachable at all.
 *
 *  `busAvailable: false` is a first-class value, not an error: D1 says the app
 *  runs fine with no bus, so "the bus is down" must be REPORTABLE. Without it a
 *  reader cannot tell an all-zero report on a healthy run from an all-zero
 *  report taken while nothing could be written — the same observable for two
 *  opposite states. */
export interface BusDivergenceReport {
  runId: string;
  busAvailable: boolean;
  counters: DivergenceCounters[];
}
