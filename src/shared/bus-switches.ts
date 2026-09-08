// Per-mechanism flip switches for the fleet bus (#118, ledger #123; #108 Q5a/Q17a).
//
// FOUR booleans, one per adoption mechanism, stored in the app store and READ
// AT WAVE START — then FROZEN on the run row for the life of that run. Flipping
// a switch mid-wave must NOT change what a running run does; the next run picks
// the new value up. That freeze is the whole point of the ticket, and the logic
// that enforces it is `freezeSwitches` / `runFlagsFromRow` below, deliberately
// pure so the unit suite can drive it without SQLite or Electron.
//
// WHY A FREEZE AT ALL: a wave is a distributed agreement. Half a fleet reading
// `wake = on` while the other half reads `wake = off`, because a human toggled
// a checkbox between two agents' boot, is a coexistence violation nobody can
// debug after the fact — the flags are not reconstructible from the transcript.
// Recording them on the run row makes the run self-describing: what the row
// says is what every member of that run obeyed.
//
// COEXISTENCE RULING (ledger #122/#123, inherited): the old channels stay
// AUTHORITATIVE. A switch that is OFF means the mechanism is COUNTED, not
// FIRED — see `src/main/bus-mechanism.ts` for the counted-not-fired seam.

/** The four mechanisms wave B is adopting behind independent switches. */
export type BusMechanism = 'delivery' | 'wake' | 'askGate' | 'liveness';

/** Every mechanism, in the order the pane renders them. */
export const BUS_MECHANISMS: readonly BusMechanism[] = [
  'delivery',
  'wake',
  'askGate',
  'liveness',
];

/** One boolean per mechanism. */
export type BusSwitches = Record<BusMechanism, boolean>;

/**
 * v1 default: EVERY mechanism OFF.
 *
 * Not a timid default — it is the coexistence ruling expressed as data. Wave B
 * ships the mechanisms in shadow mode: the bus records what WOULD have happened
 * while the old channels keep doing it for real. An adopter flips a switch
 * deliberately, per mechanism; nothing flips itself on by shipping.
 */
export const DEFAULT_BUS_SWITCHES: BusSwitches = Object.freeze({
  delivery: false,
  wake: false,
  askGate: false,
  liveness: false,
});

/** Human-facing label per mechanism (French in prose/UI per #108 ruling Q13). */
export const BUS_MECHANISM_LABEL: Record<BusMechanism, string> = {
  delivery: 'Delivery (Lot / Relève)',
  wake: 'Wake-as-turn (Réveil)',
  askGate: 'Ask / Decision gate (Ruling)',
  liveness: 'Liveness + phase',
};

/**
 * Coerce anything read out of the store into a complete, valid switch set.
 *
 * Every field is defaulted independently rather than falling back to
 * DEFAULT_BUS_SWITCHES wholesale, so a store written by a build that knew three
 * mechanisms upgrades cleanly instead of losing the three it DID set. And the
 * coercion is `=== true`, not truthiness: a store hand-edited to `"true"` (the
 * string) must not read as ON — a switch that turns itself on from a typo is
 * exactly the failure the freeze exists to prevent.
 */
export function normalizeSwitches(raw: unknown): BusSwitches {
  const src = (raw ?? {}) as Partial<Record<BusMechanism, unknown>>;
  const out = {} as BusSwitches;
  for (const m of BUS_MECHANISMS) {
    out[m] = src[m] === true;
  }
  return out;
}

/**
 * Serialize the switch set for storage ON A RUN ROW.
 *
 * A stable, sorted, explicit JSON object — never a bitmask and never key order
 * dependent — because this string is read back by a LATER build that may know
 * more mechanisms than the writer did. A bitmask would silently reassign
 * meaning the moment the mechanism list grows.
 */
export function serializeSwitches(s: BusSwitches): string {
  const obj: Record<string, boolean> = {};
  for (const m of BUS_MECHANISMS) obj[m] = s[m] === true;
  return JSON.stringify(obj);
}

/**
 * Read the frozen flags back off a run row.
 *
 * A row whose `flags` is NULL/absent/corrupt reads as ALL OFF, never as "use
 * the live switches" — falling back to live would reintroduce exactly the
 * mid-wave mutation the freeze forbids, and it would do so invisibly, on the
 * rows where the evidence is already missing.
 */
export function parseSwitches(raw: string | null | undefined): BusSwitches {
  if (!raw) return { ...DEFAULT_BUS_SWITCHES };
  try {
    return normalizeSwitches(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BUS_SWITCHES };
  }
}

/**
 * THE FREEZE. Take a snapshot of the live switches to record on a NEW run row.
 *
 * Returns a fresh object, deliberately: handing back the caller's live settings
 * object would let a later store mutation reach through the reference and
 * change a run's recorded flags after the fact — the bug this function exists
 * to make impossible, and one no test of the happy path would ever see.
 *
 * D1 RECONCILIATION (LEAD, ledger #123 §Briefing): when the bus is DOWN, a
 * mechanism whose authority the bus would carry reads as OFF for the run.
 * `busAvailable === false` therefore forces every mechanism off in the snapshot
 * — recorded on the row, so the run stays self-describing about WHY it behaved
 * as unadopted.
 */
export function freezeSwitches(live: BusSwitches, busAvailable = true): BusSwitches {
  const snapshot = normalizeSwitches(live);
  if (!busAvailable) {
    for (const m of BUS_MECHANISMS) snapshot[m] = false;
  }
  return snapshot;
}

/**
 * Is `mechanism` allowed to FIRE for this run?
 *
 * Takes the run's FROZEN flags, never the live switches — the type is the
 * guard: callers physically cannot pass the store's live object without having
 * gone through a run row first. Inverting this to read live is C10's mutant for
 * #118 and must turn T118.2 red.
 */
export function mechanismEnabled(frozen: BusSwitches, mechanism: BusMechanism): boolean {
  return frozen[mechanism] === true;
}

/** The startup-notice wording for one mechanism — see busSwitchNoticeLines. */
export function switchStateWord(on: boolean): 'ON' | 'OFF' {
  return on ? 'ON' : 'OFF';
}

/**
 * The lines injected into a spawned worktree's startup notice so the fleet
 * skill can BRANCH on the switch states (#118 acceptance 3).
 *
 * Every mechanism emits a line in BOTH states — `delivery=ON (bus is
 * authoritative…)` or `delivery=OFF (…counted, not fired)`. Never "print the
 * ON ones and stay silent otherwise": absence is unreadable to an agent, which
 * cannot distinguish "the switch is off" from "this build has no switches" from
 * "the notice was truncated". T118.3 asserts exactly that asymmetry — positive
 * control AND a negative control that requires the OPPOSITE string, not merely
 * the absence of the first (carry-forward 2).
 */
export function busSwitchNoticeLines(s: BusSwitches): string[] {
  const lines: string[] = [];
  for (const m of BUS_MECHANISMS) {
    const on = s[m] === true;
    lines.push(
      on
        ? `- bus switch ${m}=ON — the bus is AUTHORITATIVE for this mechanism in this run; use it.`
        : `- bus switch ${m}=OFF — the OLD channel stays authoritative; the bus only COUNTS this mechanism, it does not fire it.`,
    );
  }
  return lines;
}

/**
 * The whole notice block, or null when there is nothing to say.
 *
 * Returns null ONLY when the caller passes no switches at all (a build with the
 * feature compiled out). An all-OFF set still prints — see busSwitchNoticeLines.
 */
export function busSwitchNotice(s: BusSwitches | null | undefined): string | null {
  if (!s) return null;
  return [
    '[orchestra] Fleet-bus switches for this run (frozen at wave start — a mid-wave flip does NOT change them):',
    ...busSwitchNoticeLines(s),
  ].join('\n');
}
