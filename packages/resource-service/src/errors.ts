// Exit codes (freeze): 0 ok · 1 failure · 2 usage · 3 refused/conflict · 64 not implemented.
export const EXIT = { ok: 0, failure: 1, usage: 2, refused: 3, notImplemented: 64 } as const;

/** Thrown by a verb; the dispatcher prints the message on stderr and exits with `code`. */
export class CliError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
export const usageError = (m: string): CliError => new CliError(EXIT.usage, m);
export const refused = (m: string): CliError => new CliError(EXIT.refused, m);
