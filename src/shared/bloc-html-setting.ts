// The Bloc HTML switch (#418, FI-2 of ledger #423): one boolean, ON by default. Absent or malformed ⇒ ON; only a literal `false` turns it off.

/** Env var carried by a session's CLI: ON at ITS start ⇒ the SessionStart hook prints the instruction. Frozen with the CLI, so a flip never reaches a running session. */
export const BLOC_HTML_ENV = 'ORCHESTRA_BLOC_HTML';

export function normalizeBlocHtmlEnabled(raw: unknown): boolean {
  return raw !== false;
}

/** The switch through a reader that may throw: ON unless the human turned it off, and OFF when the read itself fails (no model HTML runs on a guess). */
export function readBlocHtmlEnabled(read: () => unknown): boolean {
  try {
    return normalizeBlocHtmlEnabled(read());
  } catch {
    return false;
  }
}
