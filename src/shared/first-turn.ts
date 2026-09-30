// What one stream message says about the FIRST TURN's outcome (#227 D7). A CLI that inits and then fails its first turn — a bad
// `--model`, no auth — emits `system/init` FIRST (so init is NOT proof the brief was received), then an API-error assistant message and
// a `result` with `is_error`, then exits 1. MEASURED on real claude 2.1.284: scripts/fixtures/real-cli-badmodel-2.1.284.jsonl.
// Pure (no Electron), so the classification is unit-tested against that capture.

/** The session flags that make an end / interruption ON PURPOSE (stop, Restart, /clear, hibernate, user interrupt). */
export interface IntentFlags {
  stopping?: boolean;
  cleared?: boolean;
  hibernating?: boolean;
  restartRequested?: unknown;
  interruptRequested?: boolean;
}

/** The ONE predicate for "this end is on purpose", shared by the first-turn judgement (an interrupted / stopped first turn is not a failed
 *  start) and consume's `finally` (#227 round-3 F3). `endedByInterrupt` = the stream ended because of a user interrupt. */
export function isIntentionalEnd(s: IntentFlags, endedByInterrupt = false): boolean {
  return (
    s.stopping === true ||
    s.cleared === true ||
    s.hibernating === true ||
    s.restartRequested !== undefined ||
    s.interruptRequested === true ||
    endedByInterrupt
  );
}

export type TurnSignal =
  | { kind: 'output' } // the model produced something (assistant / tool output, a streamed block, a non-error result)
  | { kind: 'error'; text: string; terminal: boolean } // an API-error assistant message (NOT the end: the result follows), or a result with is_error (the turn's errored END)
  | { kind: 'none' }; // system / hook / rate-limit / other noise — says nothing about the turn

interface Blockish { type?: string; text?: unknown }
interface StreamMsg {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  error?: unknown;
  is_api_error_message?: unknown;
  message?: { model?: unknown; content?: unknown };
  event?: { type?: unknown };
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Blockish[]).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n').trim()
    : typeof content === 'string'
      ? content.trim()
      : '';

/** Classify ONE stream message. An assistant message is an ERROR (never output, but not `terminal` — the `result` that follows ends the
 *  turn and the normalizer renders THAT as the error row) when the CLI flags it (`error`, `is_api_error_message`) or it is the
 *  synthetic-model stand-in the CLI writes for an API failure; any other assistant message is real output. */
export function classifyTurnMessage(msg: StreamMsg): TurnSignal {
  switch (msg.type) {
    case 'assistant': {
      const flagged = !!msg.error || msg.is_api_error_message === true || msg.message?.model === '<synthetic>';
      return flagged
        ? { kind: 'error', text: textOf(msg.message?.content) || String(msg.error ?? 'the API returned an error'), terminal: false }
        : { kind: 'output' };
    }
    case 'stream_event': {
      const t = msg.event?.type;
      return t === 'content_block_start' || t === 'content_block_delta' ? { kind: 'output' } : { kind: 'none' };
    }
    case 'result':
      return msg.is_error === true
        ? { kind: 'error', text: (typeof msg.result === 'string' && msg.result.trim()) || 'the first turn ended in an error', terminal: true }
        : { kind: 'output' };
    default:
      return { kind: 'none' };
  }
}
