/** PROTOTYPE — throwaway. Three structurally different answers to "where does
 *  the pending queue live". Shared: nothing but the reducer and the tokens. */
import { useEffect, useRef, useState } from 'react';
import type { QueuedMessage, QueueState, QueueAction } from './state';
import { drainToTurns } from './state';

export interface VariantProps {
  state: QueueState;
  dispatch: (a: QueueAction) => void;
}

/* ------------------------------------------------------------------ shared */

function useEditable(initial: string, onCommit: (t: string) => void) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  return {
    editing,
    draft,
    ref,
    setDraft,
    start: () => {
      setDraft(initial);
      setEditing(true);
    },
    commit: () => {
      onCommit(draft.trim() || initial);
      setEditing(false);
    },
    cancel: () => setEditing(false),
  };
}

/** The composer card — real class names, so each variant sits against the
 *  actual chrome instead of a mock. */
function Composer({
  state,
  dispatch,
  children,
  placeholder,
}: VariantProps & { children?: React.ReactNode; placeholder?: string }) {
  const [text, setText] = useState('');
  const running = state.running;
  return (
    <div className="av-composer">
      {children}
      <div className="av-composer-field">
        <textarea
          className="pr-composer-input"
          rows={2}
          value={text}
          placeholder={
            placeholder ?? (running ? 'Message queues until the turn ends…' : 'Reply to the agent…')
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            if (e.shiftKey && !e.metaKey) return; // newline
            e.preventDefault();
            if (e.metaKey || (e.shiftKey && running)) dispatch({ type: 'sendNow', text });
            else dispatch({ type: 'queue', text });
            setText('');
          }}
        />
        <div className="av-composer-bar">
          <span className="pr-chip-flat">{running ? 'working' : 'idle'}</span>
          <span style={{ flex: 1 }} />
          <button
            className="pr-btn-ghost"
            disabled={!running}
            onClick={() => dispatch({ type: 'interrupt' })}
            title="Interrupt (Esc) — today this DISCARDS the queue"
          >
            Interrupt
          </button>
          <button
            className="pr-btn-send"
            disabled={!text.trim()}
            onClick={() => {
              dispatch({ type: running ? 'queue' : 'sendNow', text });
              setText('');
            }}
            title={running ? 'Agent is working — message will queue' : 'Send (Enter)'}
          >
            {running ? '⤶ Queue' : '↑ Send'}
          </button>
        </div>
      </div>
      <div className="pr-hint">
        <b>Enter</b> queues · <b>Shift/Cmd+Enter</b> interrupts &amp; sends now
      </div>
    </div>
  );
}

function Transcript({ state }: { state: QueueState }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [state.transcript.length]);
  return (
    <>
      {state.transcript.map((m, i) =>
        m.role === 'user' ? (
          <div key={i} className="av-message av-message-user">
            {m.text}
          </div>
        ) : (
          <div key={i} className="av-message av-message-assistant">
            {m.text}
          </div>
        ),
      )}
      {state.running && (
        <div className="pr-working">
          <span className="pr-spark" /> Working… {state.elapsed}s
        </div>
      )}
      <div ref={end} />
    </>
  );
}

/** Interrupt-discarded-your-queue recovery. Only variant C ignores it, on
 *  purpose, so you can feel whether it's load-bearing. */
function DiscardedNotice({ state, dispatch }: VariantProps) {
  if (!state.lastDiscarded?.length) return null;
  return (
    <div className="pr-discarded">
      {state.lastDiscarded.length} queued message
      {state.lastDiscarded.length > 1 ? 's were' : ' was'} discarded by the interrupt.
      <button className="pr-btn-ghost" onClick={() => dispatch({ type: 'restoreDiscarded' })}>
        Restore
      </button>
    </div>
  );
}

/* --------------------------------------------------- A — inline transcript */

export function VariantA({ state, dispatch }: VariantProps) {
  return (
    <div className="pr-pane">
      <div className="av-transcript">
        <Transcript state={state} />
        {state.queue.map((m, i) => (
          <InlineGhost
            key={m.id}
            m={m}
            index={i}
            total={state.queue.length}
            dispatch={dispatch}
          />
        ))}
      </div>
      <DiscardedNotice state={state} dispatch={dispatch} />
      <Composer state={state} dispatch={dispatch} />
    </div>
  );
}
VariantA.variantName = 'Inline ghosts in the transcript';

function InlineGhost({
  m,
  index,
  total,
  dispatch,
}: {
  m: QueuedMessage;
  index: number;
  total: number;
  dispatch: (a: QueueAction) => void;
}) {
  const ed = useEditable(m.text, (text) => dispatch({ type: 'edit', id: m.id, text }));
  return (
    <>
      <div className="av-message av-message-user pr-ghost">
        <div className="pr-ghost-eyebrow">
          Queued · #{index + 1} of {total}
        </div>
        {ed.editing ? (
          <textarea
            ref={ed.ref}
            className="pr-edit"
            value={ed.draft}
            onChange={(e) => ed.setDraft(e.target.value)}
            onBlur={ed.commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ed.commit();
              }
              if (e.key === 'Escape') ed.cancel();
            }}
          />
        ) : (
          <div>{m.text}</div>
        )}
        <div className="pr-ghost-actions">
          <button className="pr-btn-ghost" onClick={ed.start}>
            Edit
          </button>
          <button
            className="pr-btn-ghost"
            disabled={index === 0}
            onClick={() => dispatch({ type: 'move', id: m.id, dir: -1 })}
          >
            ↑
          </button>
          <button
            className="pr-btn-ghost"
            disabled={index === total - 1}
            onClick={() => dispatch({ type: 'move', id: m.id, dir: 1 })}
          >
            ↓
          </button>
          <button className="pr-btn-ghost" onClick={() => dispatch({ type: 'remove', id: m.id })}>
            Cancel
          </button>
        </div>
      </div>
      {index < total - 1 && (
        <button
          className={`pr-seam${m.coalesceWithNext ? ' is-merged' : ''}`}
          onClick={() => dispatch({ type: 'toggleCoalesce', id: m.id })}
          title="Merge these two into one turn"
        >
          {m.coalesceWithNext ? '⧉ merged into one turn' : '⋯ separate turns — click to merge'}
        </button>
      )}
    </>
  );
}

/* ------------------------------------------------------- B — stacked tray */

export function VariantB({ state, dispatch }: VariantProps) {
  const turns = drainToTurns(state.queue).length;
  return (
    <div className="pr-pane">
      <div className="av-transcript">
        <Transcript state={state} />
      </div>
      <DiscardedNotice state={state} dispatch={dispatch} />
      {state.queue.length > 0 && (
        <div className="pr-tray">
          <div className="pr-tray-head">
            <b>{state.queue.length} queued</b>
            <span className="pr-tray-sub">
              → will run as {turns} turn{turns > 1 ? 's' : ''} after this one
            </span>
            <span style={{ flex: 1 }} />
            <button className="pr-btn-ghost" onClick={() => dispatch({ type: 'coalesceAll' })}>
              Merge all into one turn
            </button>
          </div>
          <div className="pr-tray-list">
            {state.queue.map((m, i) => (
              <TrayRow
                key={m.id}
                m={m}
                index={i}
                total={state.queue.length}
                dispatch={dispatch}
              />
            ))}
          </div>
        </div>
      )}
      <Composer state={state} dispatch={dispatch} />
    </div>
  );
}
VariantB.variantName = 'Stacked tray above the composer';

function TrayRow({
  m,
  index,
  total,
  dispatch,
}: {
  m: QueuedMessage;
  index: number;
  total: number;
  dispatch: (a: QueueAction) => void;
}) {
  const ed = useEditable(m.text, (text) => dispatch({ type: 'edit', id: m.id, text }));
  return (
    <div className={`pr-tray-row${m.coalesceWithNext ? ' is-merged' : ''}`}>
      <span className="pr-tray-num">{index + 1}</span>
      {ed.editing ? (
        <textarea
          ref={ed.ref}
          className="pr-edit"
          value={ed.draft}
          onChange={(e) => ed.setDraft(e.target.value)}
          onBlur={ed.commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ed.commit();
            }
            if (e.key === 'Escape') ed.cancel();
          }}
        />
      ) : (
        <div className="pr-tray-text" onDoubleClick={ed.start} title="Double-click to edit">
          {m.text}
        </div>
      )}
      <div className="pr-tray-actions">
        <button
          className="pr-btn-ghost"
          disabled={index === total - 1}
          onClick={() => dispatch({ type: 'toggleCoalesce', id: m.id })}
          title="Merge with the next message into one turn"
        >
          ⧉
        </button>
        <button
          className="pr-btn-ghost"
          disabled={index === 0}
          onClick={() => dispatch({ type: 'move', id: m.id, dir: -1 })}
        >
          ↑
        </button>
        <button
          className="pr-btn-ghost"
          disabled={index === total - 1}
          onClick={() => dispatch({ type: 'move', id: m.id, dir: 1 })}
        >
          ↓
        </button>
        <button className="pr-btn-ghost" onClick={ed.start}>
          Edit
        </button>
        <button className="pr-btn-ghost" onClick={() => dispatch({ type: 'remove', id: m.id })}>
          ✕
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------- C — chips inside the composer */

export function VariantC({ state, dispatch }: VariantProps) {
  const [open, setOpen] = useState(false);
  const turns = drainToTurns(state.queue).length;
  return (
    <div className="pr-pane">
      <div className="av-transcript">
        <Transcript state={state} />
      </div>
      <Composer
        state={state}
        dispatch={dispatch}
        placeholder={
          state.queue.length ? 'Add another to the queue…' : 'Message queues until the turn ends…'
        }
      >
        {state.queue.length > 0 && (
          <div className="pr-chiprow">
            {state.queue.map((m, i) => (
              <button
                key={m.id}
                className={`pr-chip${m.coalesceWithNext ? ' is-merged' : ''}`}
                onClick={() => setOpen(true)}
                title={m.text}
              >
                <span className="pr-chip-n">{i + 1}</span>
                <span className="pr-chip-t">{m.text}</span>
                <span
                  className="pr-chip-x"
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch({ type: 'remove', id: m.id });
                  }}
                >
                  ✕
                </span>
              </button>
            ))}
            <button className="pr-chip-more" onClick={() => setOpen(true)}>
              {turns} turn{turns > 1 ? 's' : ''} ▸
            </button>
          </div>
        )}
      </Composer>

      {open && (
        <div className="pr-sheet-scrim" onClick={() => setOpen(false)}>
          <div className="pr-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="pr-sheet-head">
              <b>Queue</b>
              <span style={{ flex: 1 }} />
              <button className="pr-btn-ghost" onClick={() => dispatch({ type: 'coalesceAll' })}>
                Merge all
              </button>
              <button className="pr-btn-ghost" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            {state.queue.map((m, i) => (
              <TrayRow
                key={m.id}
                m={m}
                index={i}
                total={state.queue.length}
                dispatch={dispatch}
              />
            ))}
            {!state.queue.length && <div className="pr-tray-sub">Queue is empty.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
VariantC.variantName = 'Chips inside the composer + detail sheet';
