// The home-listing check of the session-identity rig (#379), PURE so the selftest can prove it can fail. The live `~/.claude*` / `~/.orchestra*` dirs are
// shared with concurrent live sessions, so a depth-1 listing diff is noisy in ONE known way: transient entries they add/remove. Policy:
//   FAIL  an ADDED entry carrying this rig's marks, or ANY removed entry that is not a known transient (a rig that deleted a live config entry must not pass);
//   NOTE  every other added entry, and removals of the known transients.
// Entries are `<top>` (a dir under $HOME) or `<top>/<child>`.
export const RIG_MARKS = /session-keys\.json|keepers|bus\.sqlite|store\.json|orchestra-[0-9a-f]{12}\.sock|ws-(si|sup|att)-/;
export const TRANSIENT_CHILDREN = new Set(['telemetry', 'sessions', 'session-env', 'shell-snapshots']);

/** `{ ok, fail: [...reasons], notes: [...] }` for the before/after listings and the run's scratch-root tokens. */
export function classifyListingDiff(before, after, tokens = []) {
  const added = after.filter((n) => !before.includes(n));
  const removed = before.filter((n) => !after.includes(n));
  const fail = [];
  const notes = [];
  for (const n of added) {
    if (RIG_MARKS.test(n) || tokens.some((t) => n.includes(t))) fail.push(`the rig left ${n}`);
    else notes.push(`+${n}`);
  }
  for (const n of removed) {
    const child = n.includes('/') ? n.split('/').pop() : null;
    // a vanished entry is tolerable only as a known transient CHILD of a live dir (never a top-level dir, never any other child, e.g. settings/credentials)
    if (child !== null && TRANSIENT_CHILDREN.has(child)) notes.push(`-${n}`);
    else fail.push(`an entry of the live dirs was REMOVED: ${n}`);
  }
  return { ok: fail.length === 0, fail, notes };
}
