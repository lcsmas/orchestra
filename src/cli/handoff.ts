// #466 — `orchestra handoff --summary-file <path> | --summary <text>`: end THIS context, continue in a fresh one that opens with the summary.
// Pure arg + shape handling here (testable without a socket); the host (src/main/handoff-host.ts) re-validates — it is the authority.

import { handoffSummaryError, validateHandoffSummary } from '../shared/handoff.ts';

export interface HandoffArgs {
  args: string[];
  readFile: (path: string) => string;
}

/** The summary text to send, or the error to print. Nothing is sent on an error. Checks the shape up front (fast refusal, no socket). */
export function resolveHandoffSummary(i: HandoffArgs): { summary: string } | { error: string } {
  let file: string | undefined;
  let inline: string | undefined;
  const rest: string[] = [];
  for (let k = 0; k < i.args.length; k++) {
    const a = i.args[k];
    if (a === '--summary-file' || a === '--summary') {
      const v = i.args[k + 1];
      if (v === undefined || (v.startsWith('--') && v !== '-')) return { error: `orchestra handoff: ${a} needs a value — nothing was ended.` };
      if (a === '--summary-file') file = v; else inline = v;
      k++;
    } else rest.push(a);
  }
  if (rest.length) return { error: `orchestra handoff: unexpected argument ${rest[0]} — usage: orchestra handoff --summary-file <path> | --summary <text>. Nothing was ended.` };
  if ((file === undefined) === (inline === undefined)) {
    return { error: 'orchestra handoff: pass exactly one of --summary-file <path> (- for stdin) or --summary <text> — nothing was ended.' };
  }
  let summary = inline ?? '';
  if (file !== undefined) {
    try {
      summary = i.readFile(file);
    } catch (e) {
      return { error: `orchestra handoff: cannot read --summary-file ${file}: ${(e as Error).message} — nothing was ended.` };
    }
  }
  const v = validateHandoffSummary(summary);
  if (!v.ok) return { error: handoffSummaryError(v.problems) };
  return { summary: summary.replace(/\s+$/, '') };
}
