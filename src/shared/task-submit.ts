/** Retry policy for delivering an agent's opening prompt into its TUI.
 *
 * Lives here, dependency-free, because the policy is where the bug was and the
 * caller (`src/main/workspaces.ts`) imports Electron and cannot be unit-tested.
 *
 * THE FAILURE THIS ENCODES. Delivery is two keystrokes — the task text, then a
 * separate `\r` — and each can fail on its own, with DIFFERENT remedies:
 *
 *   - dropped `\r`      → text sits in the box unsent. Resend `\r`.
 *                         Re-typing would duplicate the task.
 *   - text never landed → the box is empty. Resending `\r` submits nothing,
 *                         forever. Only re-typing can recover.
 *
 * Both present identically from outside: the workspace stays `idle`. A real
 * spawn hit the second case and left an agent sitting at a pristine prompt,
 * placeholder still showing, with no idea it had been given a task — while the
 * old flat loop spent its entire budget resending `\r` at an empty box.
 *
 * So the policy escalates: retry `\r` first (cheap, no duplication risk), and
 * only after a full round fails assume the text is missing and re-type.
 */

/** One action to perform against the agent's PTY. */
export type SubmitStep =
  | { kind: 'clear' } // kill whatever is in the input line (Ctrl-U)
  | { kind: 'type' } // write the task text
  | { kind: 'submit' }; // write '\r'

export interface SubmitPlanOptions {
  /** `\r` attempts per typing round before assuming the text never landed. */
  maxSubmitAttempts: number;
  /** Typing rounds. >1 enables re-typing recovery. */
  typeRounds: number;
}

/**
 * The full ordered step list, as if every attempt failed. The caller stops
 * early the moment the workspace leaves `idle`.
 *
 * Exposed as data so the escalation can be asserted directly — the old bug was
 * a policy that *looked* like a retry and could not fix the case it hit.
 */
export function submitPlan(opts: SubmitPlanOptions): SubmitStep[] {
  const steps: SubmitStep[] = [];
  for (let round = 0; round < Math.max(0, opts.typeRounds); round++) {
    // Clear before every retype so a retry cannot concatenate onto a
    // half-delivered prompt. Not before the first: the box is already empty.
    if (round > 0) steps.push({ kind: 'clear' });
    steps.push({ kind: 'type' });
    for (let attempt = 0; attempt < Math.max(0, opts.maxSubmitAttempts); attempt++) {
      steps.push({ kind: 'submit' });
    }
  }
  return steps;
}

/**
 * True when the plan can recover from the text never arriving — i.e. it types
 * more than once. A plan that only ever types once is a `\r` retry wearing a
 * retry's costume: against an empty input box every attempt fails identically
 * and the budget is spent on a remedy that cannot work.
 */
export function canRecoverFromLostText(plan: SubmitStep[]): boolean {
  return plan.filter((s) => s.kind === 'type').length > 1;
}
