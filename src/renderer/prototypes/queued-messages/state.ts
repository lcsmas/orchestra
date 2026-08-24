/**
 * PROTOTYPE — throwaway. Not production code.
 *
 * Question: what should the "messages queued while a turn is running" surface
 * look like in the structured agent view composer?
 *
 * Context: the BACKEND ALREADY QUEUES. `sdkSend` (src/main/agent-sdk.ts:1703)
 * pushes unconditionally onto `session.queue` (:1777) and `promptStream`
 * (:825-853) refuses to yield the next message until the previous turn's
 * `result` lands — "so the SDK never has two turns in flight". The send button
 * already says "Agent is working — message will queue"
 * (StructuredView.tsx:1607). NOTHING RENDERS THE QUEUE. That gap is the whole
 * question here; this prototype does not re-litigate the transport.
 *
 * This module is the one bit worth keeping: a pure reducer over the queue,
 * liftable into the real fold (src/shared/agent-events.ts, near the
 * user-message case at :1702) once a variant wins.
 */

export interface QueuedMessage {
  id: string;
  text: string;
  /** Queued messages the user marked to merge into ONE turn with the next one. */
  coalesceWithNext: boolean;
}

export interface QueueState {
  running: boolean;
  /** Seconds the current turn has been going — drives the "Working…" clock. */
  elapsed: number;
  queue: QueuedMessage[];
  /** Transcript, so variants can be judged against real density, not a vacuum. */
  transcript: { role: 'user' | 'assistant'; text: string }[];
  /** Set when the user interrupts with a non-empty queue — the recovery affordance. */
  lastDiscarded: QueuedMessage[] | null;
}

export type QueueAction =
  | { type: 'queue'; text: string }
  | { type: 'sendNow'; text: string }
  | { type: 'remove'; id: string }
  | { type: 'edit'; id: string; text: string }
  | { type: 'move'; id: string; dir: -1 | 1 }
  | { type: 'toggleCoalesce'; id: string }
  | { type: 'coalesceAll' }
  | { type: 'interrupt' }
  | { type: 'restoreDiscarded' }
  | { type: 'turnEnd' }
  | { type: 'tick' }
  | { type: 'reset' };

let seq = 0;
const nextId = () => `q${++seq}`;

export const initialState: QueueState = {
  running: true,
  elapsed: 47,
  queue: [],
  transcript: [
    { role: 'user', text: 'Refactor the queue banner to use the new tokens.' },
    {
      role: 'assistant',
      text: 'Reading agent-view-theme.css to find the token definitions before I touch the banner…',
    },
  ],
  lastDiscarded: null,
};

/**
 * Drains the queue into the turns the agent will actually see. A run of
 * messages flagged `coalesceWithNext` collapses into ONE turn, joined by blank
 * lines — this is the "three thoughts, one turn" behaviour.
 */
export function drainToTurns(queue: QueuedMessage[]): string[] {
  const turns: string[] = [];
  let buf: string[] = [];
  for (const m of queue) {
    buf.push(m.text);
    if (!m.coalesceWithNext) {
      turns.push(buf.join('\n\n'));
      buf = [];
    }
  }
  if (buf.length) turns.push(buf.join('\n\n'));
  return turns;
}

export function reducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'queue': {
      const text = action.text.trim();
      if (!text) return state;
      // Not running → it just sends; the queue only exists mid-turn.
      if (!state.running) {
        return {
          ...state,
          running: true,
          elapsed: 0,
          transcript: [...state.transcript, { role: 'user', text }],
        };
      }
      return {
        ...state,
        queue: [...state.queue, { id: nextId(), text, coalesceWithNext: false }],
      };
    }

    case 'sendNow': {
      // Shift/Cmd+Enter — interrupt the turn and send immediately. Anything
      // already queued rides along ahead of it, so nothing is silently lost.
      const text = action.text.trim();
      const ahead = drainToTurns(state.queue).map((t) => ({ role: 'user' as const, text: t }));
      return {
        ...state,
        running: true,
        elapsed: 0,
        queue: [],
        transcript: [
          ...state.transcript,
          { role: 'assistant', text: '⎿ Interrupted by user' },
          ...ahead,
          ...(text ? [{ role: 'user' as const, text }] : []),
        ],
      };
    }

    case 'remove':
      return { ...state, queue: state.queue.filter((m) => m.id !== action.id) };

    case 'edit':
      return {
        ...state,
        queue: state.queue.map((m) => (m.id === action.id ? { ...m, text: action.text } : m)),
      };

    case 'move': {
      const i = state.queue.findIndex((m) => m.id === action.id);
      const j = i + action.dir;
      if (i < 0 || j < 0 || j >= state.queue.length) return state;
      const q = [...state.queue];
      [q[i], q[j]] = [q[j], q[i]];
      return { ...state, queue: q };
    }

    case 'toggleCoalesce':
      return {
        ...state,
        queue: state.queue.map((m) =>
          m.id === action.id ? { ...m, coalesceWithNext: !m.coalesceWithNext } : m,
        ),
      };

    case 'coalesceAll':
      return {
        ...state,
        queue: state.queue.map((m, i) => ({ ...m, coalesceWithNext: i < state.queue.length - 1 })),
      };

    case 'interrupt':
      // TODAY'S BUG, faithfully modelled: interrupt discards the queue
      // (interruptCancellingQueued, agent-sdk.ts:2082). The prototype keeps
      // the discarded items so a variant can offer recovery.
      return {
        ...state,
        running: false,
        queue: [],
        lastDiscarded: state.queue.length ? state.queue : state.lastDiscarded,
        transcript: [...state.transcript, { role: 'assistant', text: '⎿ Interrupted by user' }],
      };

    case 'restoreDiscarded':
      return {
        ...state,
        queue: [...state.queue, ...(state.lastDiscarded ?? [])],
        lastDiscarded: null,
      };

    case 'turnEnd': {
      // Turn finished → the queue drains into the next turn(s).
      const turns = drainToTurns(state.queue);
      if (!turns.length) return { ...state, running: false, elapsed: 0 };
      return {
        ...state,
        running: true,
        elapsed: 0,
        queue: [],
        transcript: [
          ...state.transcript,
          { role: 'assistant', text: 'Done — the tokens now come from agent-view-theme.css.' },
          ...turns.map((text) => ({ role: 'user' as const, text })),
        ],
      };
    }

    case 'tick':
      return state.running ? { ...state, elapsed: state.elapsed + 1 } : state;

    case 'reset':
      return { ...initialState, queue: [] };

    default:
      return state;
  }
}
