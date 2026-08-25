/**
 * Pure drag-and-drop drop-target rules for the sidebar, extracted from
 * Sidebar.tsx so the comparison that caused issue #38 exists in exactly ONE
 * place and can be unit tested without rendering React.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 *
 * Every function here defends against one specific trap:
 *
 *     dropRepo?.path === repoPath ? `repo-drop-${dropRepo.pos}` : ''
 *
 * That reads as null-safe and is not. Optional chaining on a `null` object
 * yields `undefined`, so when the RIGHT-hand side is ALSO `undefined` the
 * comparison is `undefined === undefined` → TRUE, the ternary takes the arm
 * that dereferences `dropRepo`, and it throws
 * `TypeError: Cannot read properties of null (reading 'pos')`. React's error
 * boundary catches it and the whole app renders "Something broke in the UI"
 * instead of a sidebar — the #38 boot crash.
 *
 * The right-hand side reached `undefined` because `Workspace` records are
 * deserialized from `store.json` with NO runtime validation, so `repoPath:
 * string` is a claim about writers, not a guarantee about readers.
 *
 * ── WHY IT IS A SEPARATE FILE, AND NOT A GUARD AT EACH SITE ──────────────────
 *
 * There were FOUR sites of this shape in Sidebar.tsx (two class computations,
 * two `setState` updaters). Guarding them individually was tried first and is
 * what the #38 review rejected, for two measured reasons:
 *
 *  1. It does not hold. Two of the four were left unguarded, because "fix the
 *     ones the crash touched" has no mechanical stopping condition. A comment
 *     claiming the sites "cannot drift apart" is not a mechanism.
 *  2. It is not testable. `pnpm run test` strips types but does NOT transform
 *     JSX, and the repo ships no jsdom/testing-library/vitest — so nothing can
 *     assert on an expression that only exists inside a `.tsx` render body.
 *     The first attempt at a regression gate therefore RECONSTRUCTED the buggy
 *     expression inline as literals, which made it a constant: it emitted the
 *     same pass on the fixed build, the unfixed build, and a build with
 *     Sidebar.tsx deleted. Reverting only the render-site guard left that gate
 *     fully green (measured).
 *
 * Moving the rule into `src/shared/` fixes both: there is one implementation to
 * get right, and `matchesDropTarget` is directly callable from a `.ts` test, so
 * a regression at the real decision point actually fails a gate.
 *
 * The invariant every function here maintains: **never compare an identity
 * field without first proving the drop-state object is non-null**, and never
 * let an `undefined` identity match anything.
 */

/** A pending drop target: which row/section the pointer is over, and whether
 * the drop lands before or after it. `null` whenever no drag is in progress —
 * which is the overwhelmingly common case, and the one that crashed. */
export type DropTarget<K extends string> = { readonly key: K; readonly pos: DropPos } | null;

export type DropPos = 'before' | 'after';

/**
 * True when `target` is a live drop target sitting on `key`.
 *
 * This is the ONLY place the identity comparison happens, and it is written to
 * be correct on both halves independently:
 *
 * - `target !== null` FIRST, so `.pos` is never reached on a null object. This
 *   is the direct #38 guard.
 * - `key !== undefined` SECOND, so a malformed record whose identity field is
 *   absent can never match a target. Without this the function would still be
 *   crash-free but would report a spurious HIT whenever both sides happened to
 *   be `undefined` — the same latent wrong-answer the crash was hiding.
 *
 * Callers pass `key` as `string | undefined` deliberately: the TYPE says these
 * are strings, and #38 is precisely the case where the type was wrong at
 * runtime. Accepting `undefined` here is what lets a test express the
 * malformed-store case that the type system claims cannot happen.
 */
export function matchesDropTarget<K extends string>(
  target: DropTarget<K>,
  key: string | undefined,
): boolean {
  if (target === null) return false;
  if (key === undefined) return false;
  return target.key === key;
}

/**
 * The CSS modifier suffix for a row/section under a pending drop, or `''`.
 *
 * `prefix` is the class stem the caller wants (`'repo-drop'` for repo sections,
 * `'drop'` for workspace rows), so both call sites share this function rather
 * than each re-deriving the guarded ternary that crashed.
 *
 * Returns a leading-space-prefixed string ready to concatenate into a
 * `className` template, matching how the call sites already build their class
 * strings.
 */
export function dropTargetClass<K extends string>(
  target: DropTarget<K>,
  key: string | undefined,
  prefix: string,
): string {
  return matchesDropTarget(target, key) ? ` ${prefix}-${target!.pos}` : '';
}

/**
 * The `setState` updater body for an `onDragOver` handler: keep the PREVIOUS
 * object when it already describes this exact target, otherwise produce a new
 * one.
 *
 * Preserving identity matters — returning a fresh object on every `dragover`
 * (which fires continuously while the pointer moves) would re-render the whole
 * sidebar on every pixel. That performance concern is why the original was
 * written as `prev?.key === key && prev.pos === pos`, and it is exactly that
 * shorthand that carried the #38 crash into the drag path: with `prev === null`
 * and `key === undefined` the left side short-circuits TRUE and `prev.pos`
 * throws.
 *
 * Routing it through `matchesDropTarget` keeps the identity optimisation while
 * making the null case unreachable.
 */
export function nextDropTarget<K extends string>(
  prev: DropTarget<K>,
  key: K,
  pos: DropPos,
): DropTarget<K> {
  if (matchesDropTarget(prev, key) && prev!.pos === pos) return prev;
  return { key, pos };
}
