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
// FIRED.
//
// #118 OWNS THE READ, NOT THE FIRING. This ticket ships the switches, the
// freeze and a read-only pane; it has no mechanism of its own to fire or
// suppress. The counted-not-fired seam therefore lives with the tickets that
// own a mechanism — #116 (mirror counters) and #117 (wake) — and they consume
// this module's `busSwitch()` / `mechanismEnabled()` to decide. Do not go
// looking for a firing site here; there is deliberately none, and an earlier
// draft of this comment pointed at a `src/main/bus-mechanism.ts` that does not
// exist.

/** The mechanisms adopted behind independent switches.
 *
 *  Wave B shipped four (delivery/wake/askGate/liveness). Wave D adds the bus-v2
 *  mechanisms, ONE SWITCH PER MECHANISM (ledger #131 RULING D1 — no shared
 *  bundle, so each promotes and rolls back on its own #108 Q4/Q5 bar): `fencing`
 *  (#128 coordinator generation), `capability` (#129 dispatch capability tokens),
 *  `receipts` (#130 mutation receipts). Growing this enum is ADDITIVE and
 *  store-safe: `run_flags.flags` is a JSON object read back by builds that know
 *  more mechanisms than the writer did (bus.ts MIGRATIONS[3] comment), and
 *  "frozen" is frozen-PER-RUN-at-wave-start, not enum-frozen. */
export type BusMechanism =
  | 'delivery'
  | 'wake'
  | 'askGate'
  | 'liveness'
  | 'fencing' // #128
  | 'capability' // #129
  | 'receipts' // #130
  | 'pause' // #252 fleet Pause (ADR 0003)
  | 'dockerRelay' // #291 keeper Docker relay (ADR 0004)
  | 'memoryCap'; // #320 per-member kernel memory scope (ADR 0005)

/** Every mechanism, in the order the pane renders them. */
export const BUS_MECHANISMS: readonly BusMechanism[] = [
  'delivery',
  'wake',
  'askGate',
  'liveness',
  'fencing', // #128
  'capability', // #129
  'receipts', // #130
  'pause', // #252
  'dockerRelay', // #291
  'memoryCap', // #320
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
  fencing: false, // #128
  capability: false, // #129
  receipts: false, // #130
  pause: false, // #252 — opt-in per run; OFF ⇒ `run pause` refused and no gate ever fires
  dockerRelay: false, // #291 — opt-in per run; OFF ⇒ DOCKER_HOST is never set, containers are not stamped
  memoryCap: false, // #320 — opt-in per run; OFF ⇒ a member's keeper is launched in no scope of its own (no Plafond mémoire)
});

/**
 * Default LIVE setting (what the next run freezes) for a mechanism the human never set.
 * Only `pause` (#258, canaries passed) and `dockerRelay` are ON; DEFAULT_BUS_SWITCHES stays
 * all-OFF because it is also the safe fallback (unreadable store, no run row, bus down).
 */
export const LIVE_SWITCH_DEFAULTS: BusSwitches = Object.freeze({
  ...DEFAULT_BUS_SWITCHES,
  pause: true,
  dockerRelay: true,
});

/** Like {@link normalizeSwitches}, for the LIVE settings only: an absent key (never set, or a
 *  store older than the mechanism) takes LIVE_SWITCH_DEFAULTS; a present key still needs `=== true`.
 *  Never use it on a run row — a frozen row missing a key was frozen OFF. */
export function normalizeLiveSwitches(raw: unknown): BusSwitches {
  const src = (raw ?? {}) as Partial<Record<BusMechanism, unknown>>;
  const out = {} as BusSwitches;
  for (const m of BUS_MECHANISMS) {
    out[m] = src[m] === undefined ? LIVE_SWITCH_DEFAULTS[m] : src[m] === true;
  }
  return out;
}

/** Human-facing label per mechanism (French in prose/UI per #108 ruling Q13). */
export const BUS_MECHANISM_LABEL: Record<BusMechanism, string> = {
  delivery: 'Delivery (Lot / Relève)',
  wake: 'Wake-as-turn (Réveil)',
  askGate: 'Ask / Decision gate (Ruling)',
  liveness: 'Liveness + phase',
  fencing: 'Fencing (coordinator generation)', // #128
  capability: 'Capability tokens (dispatch)', // #129
  receipts: 'Mutation receipts (idempotence)', // #130
  pause: 'Pause (host-enforced fleet pause)', // #252
  dockerRelay: 'Docker relay (containers stamped with their workspace + run)', // #291
  memoryCap: 'Memory cap (each member session in its own kernel memory scope)', // #320
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

/**
 * THE WIRE NAMES, frozen with #117 on ledger #123 (OPS-B, wave B).
 *
 * `busSwitch(runId, mechanism)` takes `'delivery' | 'wake' | 'ask_gate' |
 * 'liveness'` — snake_case for `ask_gate`, because that is the string #117 is
 * coding against and a contract is worth more than a naming preference. The
 * INTERNAL key stays `askGate` (it is a TS object key), so this is the one place
 * the two vocabularies meet. Everything else reads through here.
 *
 * Two mappings and no third: if you find yourself writing `'ask_gate'` anywhere
 * outside this file, route it through `mechanismFromWire` instead — N copies of
 * a mapping is how the wire and the enum drift apart.
 */
export type BusMechanismWire =
  | 'delivery'
  | 'wake'
  | 'ask_gate'
  | 'liveness'
  | 'fencing' // #128 (wire == key)
  // #129 — capability's wire name equals its key (no snake/camel split), but it
  // MUST still route through this map so busSwitch(db,runId,'capability') and the
  // startup notice agree with everything else.
  | 'capability'
  | 'receipts' // #130 (wire == key)
  | 'pause' // #252 (wire == key)
  | 'docker_relay' // #291 (snake wire, camel key — like ask_gate)
  | 'memory_cap'; // #320 (snake wire, camel key)

const WIRE_TO_MECHANISM: Record<BusMechanismWire, BusMechanism> = {
  delivery: 'delivery',
  wake: 'wake',
  ask_gate: 'askGate',
  liveness: 'liveness',
  fencing: 'fencing', // #128
  capability: 'capability', // #129
  // #130: wire name == internal key (both `receipts`); no snake/camel split, but
  // it still routes through this ONE map — the file header forbids writing the
  // literal anywhere else.
  receipts: 'receipts',
  pause: 'pause', // #252 (wire == key; same single-map rule)
  docker_relay: 'dockerRelay', // #291
  memory_cap: 'memoryCap', // #320
};

/** Wire name → internal key. Returns null for an unknown name (never a guess). */
export function mechanismFromWire(name: string): BusMechanism | null {
  return WIRE_TO_MECHANISM[name as BusMechanismWire] ?? null;
}

/** Internal key → wire name, for anything that publishes the contract. */
export function mechanismToWire(m: BusMechanism): BusMechanismWire {
  const found = (Object.keys(WIRE_TO_MECHANISM) as BusMechanismWire[]).find(
    (w) => WIRE_TO_MECHANISM[w] === m,
  );
  if (!found) throw new Error(`bus: mechanism ${m} has no wire name`);
  return found;
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
    // Emit the WIRE name (`ask_gate`), never the internal camel key (`askGate`).
    // The fleet skill greps this notice for the contract names it was frozen on
    // (Q1, ledger #123: 'delivery'|'wake'|'ask_gate'|'liveness'); an internal
    // `askGate` line reads to it as "no such switch in this build" — absence,
    // which is the failure carry-forward 2 warns about. `mechanismToWire` is the
    // one mapping; writing `ask_gate` here by hand is what the file header forbids.
    const wire = mechanismToWire(m);
    // #252 (review D1a F4): `pause` has no "old channel" and nothing is "counted" — the generic OFF/ON wording would be FALSE for it.
    if (m === 'pause') {
      lines.push(
        on
          ? `- bus switch ${wire}=ON — a fleet Pause of this run is enforced by the host (a refused start says "run en pause"; lift with orchestra run resume).`
          : `- bus switch ${wire}=OFF — fleet Pause is not enforced in this run (orchestra run pause is refused).`,
      );
      continue;
    }
    // #291: `docker_relay` is not a bus mechanism either — say what it does, not "the bus is authoritative".
    if (m === 'dockerRelay') {
      lines.push(
        on
          ? `- bus switch ${wire}=ON — your keeper routes docker through a relay that stamps orchestra.ws / orchestra.run on every container you create — when $DOCKER_HOST points at a keepers/*.docker.sock, leave it alone and do not use another socket path.`
          : `- bus switch ${wire}=OFF — docker is used directly; containers you create are not stamped.`,
      );
      continue;
    }
    // #320: `memory_cap` is not a bus mechanism either. Applies at each session START — a running session keeps what it started with.
    if (m === 'memoryCap') {
      lines.push(
        on
          ? `- bus switch ${wire}=ON — each of your session starts (spawn, restart, wake) runs in its own memory scope with a hard limit: a tool command that overflows it is killed by the kernel and your session survives. Keep tests and rigs light; a session that started before this was ON is not capped.`
          : `- bus switch ${wire}=OFF — your session runs in no memory scope of its own; no per-member memory limit applies.`,
      );
      continue;
    }
    lines.push(
      on
        ? `- bus switch ${wire}=ON — the bus is AUTHORITATIVE for this mechanism in this run; use it.`
        : `- bus switch ${wire}=OFF — the OLD channel stays authoritative; the bus only COUNTS this mechanism, it does not fire it.`,
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

/** How many mechanisms are ON, and the total — for the run-less "N/7 ON" line.
 *  Total is `BUS_MECHANISMS.length`, never a hardcoded 7, so a new mechanism
 *  moves both numbers together. */
export function countSwitchesOn(s: BusSwitches): { on: number; total: number } {
  let on = 0;
  for (const m of BUS_MECHANISMS) if (s[m] === true) on += 1;
  return { on, total: BUS_MECHANISMS.length };
}

/**
 * #182 — THE PURE NOTICE DECISION the effectful `writeBusSwitchState` calls.
 *
 * The "standalone" signal is `!anchorCanOrchestrate && !runExists`, NOT the
 * frozen flags and NOT `!runExists` alone. A workspace that anchors no run has no
 * run row, and `runFlags` collapses that to all-OFF — indistinguishable from a
 * run whose wave genuinely froze every mechanism OFF. The field bug (#182): a
 * fresh standalone workspace with the live store at 7/7 ON printed seven `=OFF`
 * "frozen at wave start" lines, misread by a human ("switches un-ticked") and an
 * agent ("shadow rollout") as a real frozen-OFF wave.
 *
 * THE CONFLATION (reviewer-182, confirmed at source): `!runExists` alone ALSO
 * matches a GENUINE fleet member/orchestrator whose run row is not started YET —
 * at the reparent (workspaces.ts:1937) and adopt (:2459) sites the notice is
 * written BEFORE `maybeStartRunAtAnchor`, so `getRun(anchorId)` is transiently
 * null for a real member. Claiming "standalone — not part of a fleet" there is
 * actively FALSE (and persists to disk on a notice-only reparent). The honest
 * standalone signal is that the anchor CANNOT orchestrate: a real member's anchor
 * is its OPS (an orchestrator), a genuine top-level standalone is its own
 * non-orchestrator anchor. So the "no run" line requires BOTH.
 *
 *  - !anchorCanOrchestrate && !runExists → the single "anchors no run" line,
 *    naming the LIVE switch count, and ZERO `=OFF` lines. (Genuine standalone.)
 *  - otherwise → the frozen-flags notice, UNCHANGED. A member/orchestrator with a
 *    momentarily-unstarted row (anchorCanOrchestrate) falls back to the all-OFF
 *    frozen notice (pre-#182 behaviour), never the false standalone line; a run
 *    that exists prints its frozen ON/OFF lines and NEVER the "no run" line.
 *
 * Pure so the unit suite drives the exact decision the writer runs — no
 * re-implementation. MUTATIONS: invert `runExists` → a frozen-ON run prints the
 * "no run" line; drop the `anchorCanOrchestrate` gate → an orchestrator-anchored
 * member with an unstarted row prints the false standalone line. Each reddens its
 * named arm.
 */
export function busSwitchNoticeDecision(args: {
  runExists: boolean;
  anchorCanOrchestrate: boolean;
  frozen: BusSwitches;
  live: BusSwitches;
}): string | null {
  if (!args.anchorCanOrchestrate && !args.runExists) {
    const { on, total } = countSwitchesOn(args.live);
    return [
      '[orchestra] Fleet-bus switches for this workspace:',
      `- fleet bus: this workspace anchors no run (standalone — not part of a fleet). Switches will be frozen from the live settings (currently ${on}/${total} ON) when it is promoted or dispatched into a run.`,
    ].join('\n');
  }
  return busSwitchNotice(args.frozen);
}
