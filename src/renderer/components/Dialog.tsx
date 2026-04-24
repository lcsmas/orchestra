import { useEffect, useRef } from 'react';
import { create } from 'zustand';

type Tone = 'info' | 'success' | 'warning' | 'danger';
type Kind = 'alert' | 'confirm';

interface DialogOptions {
  title?: string;
  message: string;
  detail?: string;
  tone?: Tone;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface DialogState extends DialogOptions {
  kind: Kind;
  resolve: (value: boolean) => void;
}

interface DialogStore {
  current: DialogState | null;
  show: (state: DialogState) => void;
  resolve: (value: boolean) => void;
}

const useDialogStore = create<DialogStore>((set, get) => ({
  current: null,
  show: (state) => {
    const prev = get().current;
    if (prev) prev.resolve(false);
    set({ current: state });
  },
  resolve: (value) => {
    const cur = get().current;
    if (!cur) return;
    cur.resolve(value);
    set({ current: null });
  },
}));

function open(kind: Kind, opts: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().show({ ...opts, kind, resolve });
  });
}

function normalize(opts: DialogOptions | string): DialogOptions {
  return typeof opts === 'string' ? { message: opts } : opts;
}

export const dialog = {
  alert: (opts: DialogOptions | string) => open('alert', normalize(opts)),
  confirm: (opts: DialogOptions | string) => open('confirm', normalize(opts)),
  error: (message: string, detail?: string) =>
    open('alert', { title: 'Something went wrong', message, detail, tone: 'danger' }),
  success: (message: string, detail?: string) =>
    open('alert', { title: 'Done', message, detail, tone: 'success' }),
};

export function DialogHost() {
  const current = useDialogStore((s) => s.current);
  const resolve = useDialogStore((s) => s.resolve);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!current) return;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolve(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        resolve(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, resolve]);

  if (!current) return null;

  const tone: Tone = current.tone ?? (current.kind === 'confirm' ? 'warning' : 'info');
  const title =
    current.title ?? (current.kind === 'confirm' ? 'Confirm' : 'Notice');
  const confirmLabel =
    current.confirmLabel ?? (current.kind === 'confirm' ? 'Confirm' : 'OK');
  const cancelLabel = current.cancelLabel ?? 'Cancel';
  const primaryClass =
    tone === 'danger' && current.kind === 'confirm' ? 'danger-primary' : 'primary';

  return (
    <div className="dialog-backdrop" onClick={() => resolve(false)}>
      <div
        className={`dialog dialog-${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-message"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`dialog-icon dialog-icon-${tone}`} aria-hidden="true">
          <ToneIcon tone={tone} />
        </div>
        <h2 id="dialog-title" className="dialog-title">{title}</h2>
        <p id="dialog-message" className="dialog-message">{current.message}</p>
        {current.detail && <p className="dialog-detail">{current.detail}</p>}
        <div className="dialog-actions">
          {current.kind === 'confirm' && (
            <button onClick={() => resolve(false)}>{cancelLabel}</button>
          )}
          <button ref={primaryRef} className={primaryClass} onClick={() => resolve(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  width: 22,
  height: 22,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  shapeRendering: 'geometricPrecision',
};

function ToneIcon({ tone }: { tone: Tone }) {
  if (tone === 'danger') {
    return (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6" />
        <path d="M12 16.5v.01" />
      </svg>
    );
  }
  if (tone === 'warning') {
    return (
      <svg {...ICON_PROPS}>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <path d="M12 9v4" />
        <path d="M12 17v.01" />
      </svg>
    );
  }
  if (tone === 'success') {
    return (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.5 2.5 4.5-5.5" />
      </svg>
    );
  }
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.5v.01" />
    </svg>
  );
}
