/**
 * PROTOTYPE — throwaway UI prototype. Not shipped, not tested, not production.
 *
 * "Three variants of the queued-messages surface, switchable via `?variant=`,
 *  on a standalone prototype route."
 *
 * SUB-SHAPE ASSUMPTION (UI.md prefers sub-shape A — variants inside the real
 * host page). Taken deliberately as sub-shape B: the host (StructuredView)
 * only reaches the state under design with a live Electron main process, a
 * real SDK session and an actually-running turn — a heavy, non-deterministic
 * rig for a "what should this look like" question. This route reproduces the
 * real composer chrome and real theme tokens with faked state instead, so the
 * variants still butt up against true density.
 *
 * Run:  pnpm prototype:queue     → http://localhost:5199/?variant=A
 */
import { StrictMode, useEffect, useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import { reducer, initialState, drainToTurns } from './state';
import { VariantA, VariantB, VariantC, type VariantProps } from './variants';
import './prototype.css';

const VARIANTS: Record<string, React.ComponentType<VariantProps> & { variantName?: string }> = {
  A: VariantA,
  B: VariantB,
  C: VariantC,
};
const KEYS = Object.keys(VARIANTS);

function useVariant(): [string, (k: string) => void] {
  const read = () => {
    const v = new URLSearchParams(location.search).get('variant') ?? 'A';
    return KEYS.includes(v) ? v : 'A';
  };
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const on = () => force();
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const set = (k: string) => {
    const u = new URL(location.href);
    u.searchParams.set('variant', k);
    history.replaceState(null, '', u);
    force();
  };
  return [read(), set];
}

function App() {
  const [variant, setVariant] = useVariant();
  const [state, dispatch] = useReducer(reducer, initialState);
  const Variant = VARIANTS[variant];

  // Turn clock.
  useEffect(() => {
    const t = setInterval(() => dispatch({ type: 'tick' }), 1000);
    return () => clearInterval(t);
  }, []);

  // ← / → cycle variants (not while typing).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el as HTMLElement)?.isContentEditable
      )
        return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = KEYS.indexOf(variant);
      setVariant(KEYS[(i + (e.key === 'ArrowRight' ? 1 : KEYS.length - 1)) % KEYS.length]);
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [variant]);

  const turns = drainToTurns(state.queue);

  return (
    <div className="av-view pr-root">
      <div className="pr-question">
        <b>Prototype — queued messages while a turn runs.</b> The backend already queues
        (<code>session.queue</code> + the <code>promptStream</code> gate); only the UI is missing.
        Which shape lets you see what's pending, cancel or edit it, and merge several messages
        into one turn?
      </div>

      <Variant state={state} dispatch={dispatch} />

      {/* Full relevant state, per the skill's rule 5. */}
      <div className="pr-state">
        <div>
          <span className="pr-k">running</span> {String(state.running)} ·{' '}
          <span className="pr-k">elapsed</span> {state.elapsed}s ·{' '}
          <span className="pr-k">queue</span> {state.queue.length} ·{' '}
          <span className="pr-k">drains to</span> {turns.length} turn
          {turns.length === 1 ? '' : 's'}
        </div>
        {turns.map((t, i) => (
          <div key={i} className="pr-state-turn">
            <b>turn {i + 1}:</b> {t.replace(/\n\n/g, ' ⏎⏎ ')}
          </div>
        ))}
      </div>

      <div className="pr-sim">
        <button onClick={() => dispatch({ type: 'turnEnd' })}>▶ Finish current turn</button>
        <button onClick={() => dispatch({ type: 'reset' })}>↺ Reset</button>
      </div>

      <div className="pr-switcher">
        <button
          onClick={() => setVariant(KEYS[(KEYS.indexOf(variant) + KEYS.length - 1) % KEYS.length])}
        >
          ←
        </button>
        <span className="pr-switcher-label">
          {variant} · {Variant.variantName}
        </span>
        <button onClick={() => setVariant(KEYS[(KEYS.indexOf(variant) + 1) % KEYS.length])}>
          →
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
