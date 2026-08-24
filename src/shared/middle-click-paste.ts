// Middle-click PRIMARY-selection paste guard (pure decision layer).
//
// On Linux a middle click pastes the PRIMARY selection — text merely *selected*
// anywhere on the system, with no copy step — into the focused input. On a
// clickpad that fires by accident: a trackpad using `click_method=clickfinger`
// (the default on Apple hardware) maps a PHYSICAL click with three fingers
// resting on the pad to button 2, so brushing the pad with a third finger while
// clicking silently dumps the last-selected text into the composer.
//
// Chromium exposes no setting for this and CodeMirror has no middle-click paste
// code of its own, so the only interception point is the `paste` event that the
// click triggers. We correlate the two by time: the browser fires them in the
// same user-gesture turn (measured ~2ms apart in the running app).
//
// Kept as a dependency-free module so it is unit-testable — a .tsx file cannot
// be imported by `node --test` here.

/**
 * Max delay between the middle-button mousedown and the paste it triggers.
 * Wide enough to absorb scheduling jitter, far too short to span a separate,
 * deliberate Ctrl+V.
 */
export const MIDDLE_CLICK_PASTE_WINDOW_MS = 1000;

/**
 * Should this paste be swallowed as a middle-click primary-selection paste?
 *
 * @param armedAt `timeStamp` of the last middle-button mousedown, or null if
 *   no middle click is pending (never armed, or already consumed).
 * @param pasteAt `timeStamp` of the paste event.
 *
 * Returns true only for a paste that closely follows a middle click. A paste
 * with no middle click armed (Ctrl+V, Cmd+V, the context menu) returns false
 * and must be handled normally.
 */
export function isMiddleClickPaste(armedAt: number | null, pasteAt: number): boolean {
  if (armedAt === null) return false;
  const dt = pasteAt - armedAt;
  // Guard against a negative delta (clock/timeStamp origin oddities): only a
  // paste at or after the click counts.
  if (dt < 0) return false;
  return dt <= MIDDLE_CLICK_PASTE_WINDOW_MS;
}
