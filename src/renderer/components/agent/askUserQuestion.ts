// AskUserQuestion arrives through the SAME permission path as any other tool:
// the SDK's `canUseTool` fires with toolName 'AskUserQuestion' and an
// `input.questions[]` payload (spike (c) / (e): AskUserQuestion is in the loaded
// tool set). We render it as a first-class question UI and reply with
//   { behavior: 'allow', updatedInput: { ...input, answers, annotations? } }
// so the harness's AskUserQuestion tool records the selection.
//
// Reply shape rationale (documented here so there is ONE source of truth):
//   The AskUserQuestion tool's runtime schema accepts an optional `answers`
//   object keyed by the question TEXT, whose value is the chosen option label
//   (for multiSelect, the labels joined). Supplying it via `updatedInput` is how
//   a selection is conveyed back — the SDK applies `updatedInput` as the tool's
//   input, and the tool reads `answers`. This mirrors how the interactive
//   AskUserQuestion permission component answers.

export const ASK_USER_QUESTION = 'AskUserQuestion';

/** One option within an AskUserQuestion question. */
export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

/** One question within an AskUserQuestion input. */
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

/** True when this permission request is an AskUserQuestion, with a typed view
 *  of its questions. Defensive: returns null unless the shape is well-formed. */
export function parseAskUserQuestion(
  name: string,
  input: Record<string, unknown>,
): { questions: AskQuestion[] } | null {
  if (name !== ASK_USER_QUESTION) return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return null;
  const questions: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const qo = q as Record<string, unknown>;
    const question = typeof qo.question === 'string' ? qo.question : '';
    const opts = Array.isArray(qo.options) ? qo.options : [];
    const options: AskOption[] = opts
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .map((o) => ({
        label: typeof o.label === 'string' ? o.label : String(o.label ?? ''),
        description: typeof o.description === 'string' ? o.description : undefined,
        preview: typeof o.preview === 'string' ? o.preview : undefined,
      }));
    if (!question || options.length === 0) continue;
    questions.push({
      question,
      header: typeof qo.header === 'string' ? qo.header : undefined,
      multiSelect: qo.multiSelect === true,
      options,
    });
  }
  if (questions.length === 0) return null;
  return { questions };
}

/**
 * Build the `updatedInput` for an AskUserQuestion allow-reply from the user's
 * per-question selections. `selections` maps question text → chosen option
 * label(s) (multiSelect → multiple labels). "Other"/free-text answers are passed
 * through verbatim as the value.
 *
 * Pure + exported so it is unit-testable and the reply shape lives in one place.
 */
export function buildAskUserQuestionReply(
  input: Record<string, unknown>,
  questions: AskQuestion[],
  selections: Record<string, string[]>,
): Record<string, unknown> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const picked = selections[q.question] ?? [];
    if (picked.length === 0) continue;
    // Join multi-selections; single selection is just the one label.
    answers[q.question] = picked.join(', ');
  }
  return { ...input, answers };
}
