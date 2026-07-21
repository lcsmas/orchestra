// AvMenu — the structured view's dropdown primitive (replaces native selects).
//
// Linear-style: a borderless ghost trigger (icon + current label + chevron)
// opening a portalled glass panel of icon/label/description items with a
// checkmark on the current value. Modeled on the app's most polished menu
// (BranchPicker's .branch-popover glass language), but themed with the view's
// own --av-* tokens and with full keyboard support:
//   trigger: Enter/Space/ArrowUp/ArrowDown open (arrows pre-focus an item)
//   panel:   ArrowUp/ArrowDown move · Enter/Space select · Escape/blur close
//
// Portalled to document.body with fixed positioning so the bottom controls
// bar can't clip it; it opens UPWARD (the trigger lives at the window's foot).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface AvMenuItem {
  value: string;
  label: string;
  /** One quiet sub-line under the label. */
  description?: string;
  /** 14-16px inline SVG, colored via the item tint. */
  icon?: React.ReactNode;
  /** CSS color for the icon (and the active check). */
  tint?: string;
}

interface Props {
  items: AvMenuItem[];
  value: string;
  onSelect: (value: string) => void;
  ariaLabel: string;
  /** Fallback trigger text when `value` matches no item. */
  placeholder?: string;
  disabled?: boolean;
}

const PANEL_WIDTH = 248;

export function AvMenu({ items, value, onSelect, ariaLabel, placeholder, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const current = items.find((i) => i.value === value);

  // Anchor the panel to the trigger; opens upward, clamped to the viewport.
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

  const openMenu = (startIdx?: number) => {
    const idx = items.findIndex((i) => i.value === value);
    setActiveIdx(startIdx ?? (idx === -1 ? 0 : idx));
    setOpen(true);
  };

  const pick = (v: string) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (v !== value) onSelect(v);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (open) {
      // Roving selection while focus stays on the trigger.
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(items.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const it = items[activeIdx];
        if (it) pick(it.value);
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`av-menu-trigger ${open ? 'av-menu-trigger-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {current?.icon && (
          <span className="av-menu-trigger-icon" style={{ color: current.tint }} aria-hidden="true">
            {current.icon}
          </span>
        )}
        <span className="av-menu-trigger-label">{current?.label ?? placeholder ?? value}</span>
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
            className="av-menu-panel"
            role="menu"
            aria-label={ariaLabel}
            style={{ left: pos.left, bottom: pos.bottom, width: PANEL_WIDTH }}
          >
            {items.map((it, idx) => (
              <button
                key={it.value}
                type="button"
                role="menuitemradio"
                aria-checked={it.value === value}
                className={`av-menu-item ${idx === activeIdx ? 'av-menu-item-active' : ''}`}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pick(it.value)}
                tabIndex={-1}
              >
                {it.icon && (
                  <span className="av-menu-item-icon" style={{ color: it.tint }} aria-hidden="true">
                    {it.icon}
                  </span>
                )}
                <span className="av-menu-item-body">
                  <span className="av-menu-item-label">{it.label}</span>
                  {it.description && <span className="av-menu-item-desc">{it.description}</span>}
                </span>
                {it.value === value && (
                  <svg
                    className="av-menu-check"
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 8.5 6.5 12 13 4.5" />
                  </svg>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
