// Message-body assembly shared by the verbs whose trailing words become a body
// (`send`, `ask`, `gate open`, `status`). An unknown `--option` used to be glued
// into the body and sent with rc 0 (2026-10-04: `send … --file x` delivered the
// text "--file x"), so it is now refused before anything is written.

/** Split argv at the first `--`: options may only appear before it; everything
 *  after it is body text, verbatim. */
export function splitAtSeparator(args: string[]): { flagArgs: string[]; tail: string[] } {
  const i = args.indexOf('--');
  return i < 0 ? { flagArgs: args, tail: [] } : { flagArgs: args.slice(0, i), tail: args.slice(i + 1) };
}

export interface BodyInput {
  /** Verb name for messages, e.g. `send` or `gate open`. */
  verb: string;
  /** Tokens left after the verb consumed its known options (before `--`). */
  rest: string[];
  /** Tokens after `--` (never option-checked). */
  tail: string[];
  /** The verb's option vocabulary, listed in the refusal. */
  knownFlags: string[];
  /** `--body-file` was given (with or without a value). */
  bodyFilePresent: boolean;
  bodyFile?: string;
  /** Reads a path (`-` = stdin). Injected so the rule is testable. */
  readFile: (path: string) => string;
}

/** The body, or the refusal to print. Never both. */
export function resolveBody(i: BodyInput): { body: string } | { error: string } {
  const unknown = i.rest.find((t) => t.startsWith('--') && t.length > 2);
  if (unknown !== undefined) {
    return {
      error:
        `orchestra ${i.verb}: unknown option ${unknown} — nothing was sent. ` +
        `Options: ${i.knownFlags.join(' ')}. ` +
        `Text that starts with "--" goes after a "--" separator; ` +
        `a long body goes in --body-file <path> (- for stdin).`,
    };
  }
  const inline = [...i.rest, ...i.tail];
  if (!i.bodyFilePresent) return { body: inline.join(' ') };
  if (!i.bodyFile || i.bodyFile.startsWith('--')) {
    return { error: `orchestra ${i.verb}: --body-file needs a path (or - for stdin) — nothing was sent.` };
  }
  if (inline.length > 0) {
    return {
      error: `orchestra ${i.verb}: pass the body either as text or with --body-file, not both — nothing was sent.`,
    };
  }
  let content: string;
  try {
    content = i.readFile(i.bodyFile);
  } catch (e) {
    return { error: `orchestra ${i.verb}: cannot read --body-file ${i.bodyFile}: ${(e as Error).message} — nothing was sent.` };
  }
  if (!content.trim()) {
    return { error: `orchestra ${i.verb}: --body-file ${i.bodyFile} is empty — nothing was sent.` };
  }
  return { body: content.replace(/\s+$/, '') };
}
