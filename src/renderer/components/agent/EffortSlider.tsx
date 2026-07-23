// EffortSlider — the deck bar's reasoning-effort control, modeled on the
// Claude Code desktop app's effort popover: a ghost trigger (gauge icon +
// current level) opening a portalled glass panel with "Effort <Level>",
// Faster/Smarter endpoints, and a FLUID five-stop slider (low → max).
//
// Fluidity contract: while a pointer drag is live the thumb tracks the pointer
// 1:1 (no transition — `av-effort-dragging` disables it); on release it snaps
// to the nearest stop with a short eased transition, and a plain click/tap on
// the track animates the thumb to the clicked stop the same way. The header
// label + description preview the would-be level DURING the drag; the choice
// commits (IPC) only on release, so dragging never spams the backend.
//
// Keyboard: the track is a real `role="slider"` — ←/→ (and ↓/↑) step a stop,
// Home/End jump the ends, each committing immediately. Esc / outside click
// close the panel (AvMenu's pattern; the panel is portalled to <body> so the
// controls bar can't clip it, opening upward like every deck-bar menu).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentEffortLevel } from '../../../shared/types';
import {
  EFFORT_LEVELS,
  EFFORT_LABELS,
  EFFORT_DESCRIPTIONS,
  effortFraction,
  effortAtFraction,
  stepEffort,
} from './effort-util';

const PANEL_WIDTH = 264;
/** Horizontal inset of the track's rail inside the pointer-catching strip, so
 *  the 16px thumb never clips the panel edge at the end stops. */
const TRACK_PAD = 10;

/** Small speedometer/gauge glyph for the trigger. */
const gaugeIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 11.5a6 6 0 1 1 11 0" />
    <path d="M8 9.5 10.8 6" />
    <circle cx="8" cy="10.5" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export function EffortSlider({
  value,
  onChange,
  disabled,
}: {
  /** The committed level (persisted ws.sdkEffort, defaulted by the caller). */
  value: AgentEffortLevel;
  onChange: (level: AgentEffortLevel) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  /** Live pointer fraction while a drag is in flight, else null. */
  const [drag, setDrag] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  // Anchor the panel to the trigger; opens upward, clamped to the viewport
  // (same placement logic as AvMenu — the trigger lives at the window's foot).
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      const left = Math.min(Math.max(8, r.right - PANEL_WIDTH), window.innerWidth - PANEL_WIDTH - 8);
      setPos({ left, bottom: window.innerHeight - r.top + 6 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Outside click / Escape close. Two subtrees because the panel is portalled.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const fractionFromClientX = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return effortFraction(value);
    const r = track.getBoundingClientRect();
    return (clientX - r.left - TRACK_PAD) / (r.width - 2 * TRACK_PAD);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Left button / touch / pen only; capture so the drag survives leaving the
    // track (and even the panel) — the release commits wherever it happens.
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    trackRef.current?.setPointerCapture(e.pointerId);
    trackRef.current?.focus();
    setDrag(fractionFromClientX(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag === null) return;
    setDrag(fractionFromClientX(e.clientX));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag === null) return;
    const level = effortAtFraction(fractionFromClientX(e.clientX));
    setDrag(null);
    if (level !== value) onChange(level);
  };

  const onTrackKey = (e: React.KeyboardEvent) => {
    let next: AgentEffortLevel | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = stepEffort(value, -1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = stepEffort(value, 1);
    else if (e.key === 'Home') next = EFFORT_LEVELS[0];
    else if (e.key === 'End') next = EFFORT_LEVELS[EFFORT_LEVELS.length - 1];
    else return;
    e.preventDefault();
    if (next !== value) onChange(next);
  };

  // While dragging, the header/description/fill preview the nearest stop; the
  // thumb itself rides the raw fraction so it feels attached to the pointer.
  const previewLevel = drag !== null ? effortAtFraction(drag) : value;
  const thumbFraction = drag !== null ? Math.min(1, Math.max(0, drag)) : effortFraction(value);
  const pct = (f: number) => `${(f * 100).toFixed(2)}%`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`av-menu-trigger av-effort-trigger ${open ? 'av-menu-trigger-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Effort: ${EFFORT_LABELS[value]}`}
        title="Reasoning effort"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="av-menu-trigger-icon av-effort-trigger-icon" aria-hidden="true">
          {gaugeIcon}
        </span>
        <span className="av-menu-trigger-label">{EFFORT_LABELS[value]}</span>
        <svg
          className="av-menu-chevron"
          width="9"
          height="9"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 10l5-5 5 5" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="av-effort-panel"
            role="dialog"
            aria-label="Reasoning effort"
            style={{ left: pos.left, bottom: pos.bottom, width: PANEL_WIDTH }}
          >
            <div className="av-effort-head">
              <span className="av-effort-title">Effort</span>
              <span className="av-effort-value">{EFFORT_LABELS[previewLevel]}</span>
            </div>
            <div className="av-effort-scale" aria-hidden="true">
              <span>Faster</span>
              <span>Smarter</span>
            </div>
            <div
              ref={trackRef}
              className={`av-effort-track ${drag !== null ? 'av-effort-dragging' : ''}`}
              role="slider"
              tabIndex={0}
              aria-label="Reasoning effort"
              aria-valuemin={0}
              aria-valuemax={EFFORT_LEVELS.length - 1}
              aria-valuenow={EFFORT_LEVELS.indexOf(previewLevel)}
              aria-valuetext={EFFORT_LABELS[previewLevel]}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={onTrackKey}
            >
              {/* Inner strip inset by TRACK_PAD so the % positions live in the
                  same coordinate space as fractionFromClientX. */}
              <div className="av-effort-inner">
                <div className="av-effort-rail" />
                <div className="av-effort-fill" style={{ width: pct(thumbFraction) }} />
                {EFFORT_LEVELS.map((level, i) => (
                  <span
                    key={level}
                    className={[
                      'av-effort-dot',
                      level === 'max' ? 'av-effort-dot-max' : '',
                      i <= EFFORT_LEVELS.indexOf(previewLevel) ? 'av-effort-dot-lit' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ left: pct(i / (EFFORT_LEVELS.length - 1)) }}
                    aria-hidden="true"
                  />
                ))}
                <div className="av-effort-thumb" style={{ left: pct(thumbFraction) }} />
              </div>
            </div>
            <div className="av-effort-desc">{EFFORT_DESCRIPTIONS[previewLevel]}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
