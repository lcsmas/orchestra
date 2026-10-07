import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatGb, RELEASE_MARGIN_GB, type MemoryGuardView } from '../../shared/memory-guard';
import { gaugeModel, guardChip, planThresholdCommit } from '../../shared/memory-guard-view';

interface Props {
  onClose: () => void;
}

const POLL_MS = 2000;
const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/**
 * Memory guard settings (#285, mockup A / D-pick1): the two thresholds (GB), the live available memory beside them, the global
 * Admission + fast-Veille toggle. Every change applies HOT — there is no Save and nothing is frozen per run (unlike the bus
 * switches): a valid pair is written on blur / Enter and the sampler re-decides at once. The pure view logic (chip, gauge, commit
 * rule) is src/shared/memory-guard-view.ts; the write path is `setMemoryGuard` → memory-guard-settings.ts.
 */
type Draft = { admission: string; critical: string };

export function MemoryGuardSettings({ onClose }: Props) {
  const [view, setView] = useState<MemoryGuardView | null>(null);
  /** The two inputs while the user is typing; null = show the stored values. */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Applies run ONE AT A TIME in click order and are never dropped (a pending edit commits on blur, and the click that caused the blur
   *  must still reach the toggle — review m2: a `busy` flag disabling the toggle swallowed that click). */
  const queue = useRef<Promise<void>>(Promise.resolve());

  const refresh = useCallback(async () => {
    if (document.hidden) return;
    try {
      setView(await window.orchestra.memoryGuard());
    } catch {
      /* the last good view stays; never render a number the backend did not give */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const settings = view?.settings;
  const typed = draft ?? (settings ? { admission: String(settings.admissionGb), critical: String(settings.criticalGb) } : { admission: '', critical: '' });
  const plan = settings && draft ? planThresholdCommit(draft.admission, draft.critical, settings, view?.totalBytes) : null;
  const liveError = plan?.kind === 'invalid' ? plan.error : null;

  /** `committed` = the draft object this patch came from: the echo clears the inputs only if the user has not typed again since. */
  const apply = (patch: Parameters<typeof window.orchestra.setMemoryGuard>[0], committed: Draft | null = null): Promise<void> => {
    const run = queue.current.then(async () => {
      try {
        const res = await window.orchestra.setMemoryGuard(patch);
        setView(res.view); // the backend's echo wins over any optimistic state
        if (res.ok) {
          setDraft((d) => (committed !== null && d === committed ? null : d));
          setError(null);
        } else {
          setError(cap(res.error));
        }
      } catch (e) {
        setError(`Could not apply the change — ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    queue.current = run;
    return run;
  };

  const commit = () => {
    if (!settings || !draft) return;
    const p = planThresholdCommit(draft.admission, draft.critical, settings, view?.totalBytes);
    if (p.kind === 'unchanged') {
      setDraft(null);
      setError(null);
    } else if (p.kind === 'invalid') {
      setError(p.error);
    } else {
      void apply(p.patch, draft);
    }
  };

  const chip = view ? guardChip(view.snapshot) : null;
  const gauge = view && settings ? gaugeModel(view.liveAvailBytes, view.totalBytes, settings) : null;
  const shownError = error ?? liveError;
  const field = (which: 'admission' | 'critical') => (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setDraft({ ...typed, [which]: e.target.value });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit();
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal sound-settings memory-guard-settings" role="dialog" aria-label="Memory guard">
        <h2>Memory guard</h2>
        <div className="sound-hint">
          Keeps the host from running out of memory while fleets run. <strong>Changes apply at once</strong> — nothing is frozen per run.
        </div>

        <div className="mg-live">
          <span className="mg-live-label">Available memory now</span>
          <span className="mg-live-value" data-mg-live>
            {view?.liveAvailBytes == null ? '—' : formatGb(view.liveAvailBytes)}
          </span>
          {chip && (
            <span className={`mg-chip ${chip.tone}`} data-mg-chip={chip.tone}>
              ● {chip.text}
            </span>
          )}
        </div>
        {gauge && settings && (
          <div className="mg-gauge-wrap" aria-hidden="true">
            <div className="mg-gauge">
              <div className={`mg-gauge-fill ${gauge.tone}`} style={{ width: pct(gauge.fill) }} />
              <span className="mg-tick" style={{ left: pct(gauge.critical) }} />
              <span className="mg-tick" style={{ left: pct(gauge.admission) }} />
              <span className="mg-tick" style={{ left: pct(gauge.reopen) }} />
            </div>
            <div className="mg-ticks">
              {/* one row per label: 1 GB is ~14 px on a 32 GB scale, so neighbouring labels (admission / reopen are always 1 GB apart) can never share a row */}
              <span className="mg-tick-label row1" style={{ left: pct(gauge.critical) }}>{settings.criticalGb} crit</span>
              <span className="mg-tick-label row2" style={{ left: pct(gauge.admission) }}>{settings.admissionGb} admission</span>
              <span className="mg-tick-label row3" style={{ left: pct(gauge.reopen) }}>{settings.admissionGb + RELEASE_MARGIN_GB} reopen</span>
            </div>
          </div>
        )}

        <div className="field">
          <div className="field-head">
            <span className="field-label">Admission threshold</span>
            <span className="field-hint">
              Below it, automatic starts of fleet members wait and idle members go into Veille. Reopens above{' '}
              {settings ? settings.admissionGb + RELEASE_MARGIN_GB : '…'} GB.
            </span>
          </div>
          <div className="mg-input-row">
            <input
              className="mg-input"
              inputMode="decimal"
              aria-label="Admission threshold (GB)"
              data-mg-admission
              value={typed.admission}
              disabled={!settings}
              onChange={field('admission')}
              onBlur={commit}
              onKeyDown={onKey}
            />
            <span className="mg-unit">GB</span>
          </div>
        </div>
        <div className="field">
          <div className="field-head">
            <span className="field-label">Critical threshold</span>
            <span className="field-hint">
              Below it, fleet runs with the <code>pause</code> switch ON are hard-paused; lifted above the Admission threshold.
            </span>
          </div>
          <div className="mg-input-row">
            <input
              className="mg-input"
              inputMode="decimal"
              aria-label="Critical threshold (GB)"
              data-mg-critical
              value={typed.critical}
              disabled={!settings}
              onChange={field('critical')}
              onBlur={commit}
              onKeyDown={onKey}
            />
            <span className="mg-unit">GB</span>
          </div>
        </div>

        <label className="mg-toggle">
          <input
            type="checkbox"
            data-mg-toggle
            checked={settings?.admissionEnabled ?? true}
            disabled={!settings}
            onChange={(e) => void apply({ admissionEnabled: e.target.checked })}
          />
          <span>
            <span className="field-label">Hold fleet starts and fast Veille under low memory</span>
            <span className="field-hint">
              Off = the guard still measures, shows and logs; it holds nothing. Human actions are never held either way.
            </span>
          </span>
        </label>

        {shownError && (
          <div className="mg-error" role="alert" data-mg-error>
            ⚠ {shownError}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
