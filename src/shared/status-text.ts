// Pure sanitizer for the agent-updated workspace status note (`orchestra
// status` → Workspace.statusText). Lives in src/shared so it is node-testable
// without Electron and shared by the socket dispatcher (main) and any future
// renderer-side preview.

/** Hard cap on a status note's length. The note is one glanceable sidebar row
 * line — "what am I doing right now", not a progress report; anything longer
 * belongs in the transcript. Truncation at this cap is VISIBLE (ellipsis),
 * never silent. */
export const STATUS_TEXT_MAX_CHARS = 160;

/** Collapse a raw `orchestra status` payload to a single trimmed line.
 *
 * - whitespace runs (incl. newlines/tabs) collapse to one space — the note
 *   renders in a single-line ellipsized div, so an embedded newline would only
 *   hide content;
 * - control characters are stripped (the note travels shell → JSON → DOM);
 * - over-long notes are cut just under {@link STATUS_TEXT_MAX_CHARS} and get a
 *   trailing ellipsis so the cut is visible;
 * - effectively-empty input returns '' — callers treat that as "cleared" and
 *   store the field as absent, never as an empty string.
 */
export function sanitizeStatusText(raw: string): string {
  const collapsed = raw
    // C0 controls (minus \t\n\r, which the \s+ pass below handles) + DEL.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= STATUS_TEXT_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, STATUS_TEXT_MAX_CHARS - 1).trimEnd()}…`;
}
