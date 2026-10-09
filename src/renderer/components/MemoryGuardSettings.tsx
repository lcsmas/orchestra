import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatGb, RELEASE_MARGIN_GB, type MemoryGuardSettings, type MemoryGuardView } from '../../shared/memory-guard';
import { gaugeModel, guardChip, planCapCommit, planReliquatWaitCommit, planThresholdCommit } from '../../shared/memory-guard-view';
import { capSwitchSummary, type CapSwitchSummary } from '../../shared/memory-cap-view';

interface Props {
  onClose: () => void;
  /** Render-smoke seam ONLY (scripts/memcap-settings-render-smoke.mjs): the state a server render shows, since effects do not run there. Never passed by the app. */
  initial?: { view: MemoryGuardView; capSwitch?: CapSwitchSummary | null };
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
/** #323: the two Plafond mémoire inputs while the user is typing (soft / hard level, GB). */
type CapDraft = { soft: string; hard: string };

export function MemoryGuardSettings({ onClose, initial }: Props) {
  const [view, setView] = useState<MemoryGuardView | null>(initial?.view ?? null);
  /** The two inputs while the user is typing; null = show the stored values. */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState<CapDraft | null>(null);
  /** #326: the Reliquat wait (minutes) while the user is typing; null = show the stored value. */
  const [waitDraft, setWaitDraft] = useState<string | null>(null);
  /** #323: the frozen per-run `memory_cap` switch, READ-ONLY here (D-Q1: it is not a setting): the live default for new runs + how many open runs froze it ON. */
  const [capSwitch, setCapSwitch] = useState<CapSwitchSummary | null>(initial?.capSwitch ?? null);
  /** Applies run ONE AT A TIME in click order and are never dropped (a pending edit commits on blur, and the click that caused the blur
   *  must still reach the toggle — review m2: a `busy` flag disabling the toggle swallowed that click). */
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** What the backend will hold once every queued apply has landed (null = nothing in flight): a commit is planned against THAT, not the
   *  stale rendered settings — retyping the value that was in the box before an in-flight commit must still be sent (pre-review of the
   *  follow-up: it planned `unchanged` against the old settings and silently lost the last edit). */
  const inflight = useRef<{ n: number; expected: MemoryGuardSettings | null }>({ n: 0, expected: null });
  const settingsRef = useRef<MemoryGuardSettings | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (document.hidden) return;
    try {
      setView(await window.orchestra.memoryGuard());
    } catch {
      /* the last good view stays; never render a number the backend did not give */
    }
    try {
      const [live, runs] = await Promise.all([window.orchestra.busSwitches(), window.orchestra.busListRuns()]);
      setCapSwitch(capSwitchSummary(live, runs));
    } catch {
      /* the switch line stays as it was (or absent): never a guessed state */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const settings = view?.settings;
  settingsRef.current = settings;
  const typed = draft ?? (settings ? { admission: String(settings.admissionGb), critical: String(settings.criticalGb) } : { admission: '', critical: '' });
  const plan = settings && draft ? planThresholdCommit(draft.admission, draft.critical, settings, view?.totalBytes) : null;
  const liveError = plan?.kind === 'invalid' ? plan.error : null;
  const typedCap = capDraft ?? (settings ? { soft: String(settings.capSoftGb), hard: String(settings.capHardGb) } : { soft: '', hard: '' });
  const capPlan = settings && capDraft ? planCapCommit(capDraft.soft, capDraft.hard, settings, view?.totalBytes) : null;
  const liveCapError = capPlan?.kind === 'invalid' ? capPlan.error : null;
  const typedWait = waitDraft ?? (settings ? String(settings.reliquatWaitMin) : '');
  const waitPlan = settings && waitDraft !== null ? planReliquatWaitCommit(waitDraft, settings, view?.totalBytes) : null;
  const liveWaitError = waitPlan?.kind === 'invalid' ? waitPlan.error : null;

  /** `committed` = the draft object this patch came from: the echo clears the inputs only if the user has not typed again since. */
  const apply = (patch: Parameters<typeof window.orchestra.setMemoryGuard>[0], committed: Draft | null = null, committedCap: CapDraft | null = null, committedWait: string | null = null): Promise<void> => {
    const base = inflight.current.expected ?? settingsRef.current;
    inflight.current.n += 1;
    if (base) inflight.current.expected = { ...base, ...patch };
    const run = queue.current.then(async () => {
      try {
        const res = await window.orchestra.setMemoryGuard(patch);
        setView(res.view); // the backend's echo wins over any optimistic state
        if (res.ok) {
          setDraft((d) => (committed !== null && d === committed ? null : d));
          setCapDraft((d) => (committedCap !== null && d === committedCap ? null : d));
          setWaitDraft((d) => (committedWait !== null && d === committedWait ? null : d));
          setError(null);
        } else {
          inflight.current.expected = null; // the assumed outcome did not happen: plan against the echoed settings again
          setError(cap(res.error));
        }
      } catch (e) {
        inflight.current.expected = null;
        setError(`Could not apply the change — ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        inflight.current.n -= 1;
        if (inflight.current.n === 0) inflight.current.expected = null;
      }
    });
    queue.current = run;
    return run;
  };

  const commit = () => {
    const basis = inflight.current.expected ?? settings;
    if (!basis || !draft) return;
    const p = planThresholdCommit(draft.admission, draft.critical, basis, view?.totalBytes);
    if (p.kind === 'unchanged') {
      setDraft(null);
      setError(null);
    } else if (p.kind === 'invalid') {
      setError(p.error);
    } else {
      void apply(p.patch, draft);
    }
  };

  /** #323: commit the Plafond pair — BOTH levels travel together (hard must stay above soft); an invalid pair is refused inline and NOTHING is written. */
  const commitCap = () => {
    const basis = inflight.current.expected ?? settings;
    if (!basis || !capDraft) return;
    const p = planCapCommit(capDraft.soft, capDraft.hard, basis, view?.totalBytes);
    if (p.kind === 'unchanged') {
      setCapDraft(null);
      setError(null);
    } else if (p.kind === 'invalid') {
      setError(p.error);
    } else {
      void apply(p.patch, null, capDraft);
    }
  };
  /** #326: commit the Reliquat wait — a lone field, planned by the shared pure planner; invalid ⇒ the inline error and nothing sent. */
  const commitWait = () => {
    const basis = inflight.current.expected ?? settings;
    if (!basis || waitDraft === null) return;
    const p = planReliquatWaitCommit(waitDraft, basis, view?.totalBytes);
    if (p.kind === 'unchanged') {
      setWaitDraft(null);
      setError(null);
    } else if (p.kind === 'invalid') {
      setError(p.error);
    } else {
      void apply(p.patch, null, null, waitDraft);
    }
  };
  const capField = (which: 'soft' | 'hard') => (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setCapDraft({ ...typedCap, [which]: e.target.value });
  };

  const chip = view ? guardChip(view.snapshot) : null;
  const gauge = view && settings ? gaugeModel(view.liveAvailBytes, view.totalBytes, settings) : null;
  const shownError = error ?? liveError ?? liveCapError ?? liveWaitError;
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

        {/* #323 (D-Q10 A): the Plafond mémoire — one section under the thresholds, same hot apply (blur / Enter), same inline refusal. The on/off is NOT a setting (D-Q1): the frozen per-run switch is only SHOWN. */}
        <div className="mg-section" data-mg-cap-section>
          <div className="mg-section-title">Plafond mémoire <span className="mg-section-sub">(per fleet member)</span></div>
          <div className="mg-cap-switch field-hint" data-mg-cap-switch={capSwitch ? (capSwitch.liveOn ? 'on' : 'off') : ''}>
            {capSwitch ? capSwitch.text : '…'} — a per-run switch, frozen when the run starts; set it on the Bus page, not here.
          </div>
          <div className="field">
            <div className="field-head">
              <span className="field-label">Soft level</span>
              <span className="field-hint">Warns the member and its coordinator when its working set crosses it. No slowdown.</span>
            </div>
            <div className="mg-input-row">
              <input
                className="mg-input"
                inputMode="decimal"
                aria-label="Memory cap soft level (GB)"
                data-mg-cap-soft
                value={typedCap.soft}
                disabled={!settings}
                onChange={capField('soft')}
                onBlur={commitCap}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitCap();
                }}
              />
              <span className="mg-unit">GB</span>
            </div>
          </div>
          <div className="field">
            <div className="field-head">
              <span className="field-label">Hard level</span>
              <span className="field-hint">The kernel's limit: beyond it the heaviest tool process of the member is killed.</span>
            </div>
            <div className="mg-input-row">
              <input
                className="mg-input"
                inputMode="decimal"
                aria-label="Memory cap hard level (GB)"
                data-mg-cap-hard
                value={typedCap.hard}
                disabled={!settings}
                onChange={capField('hard')}
                onBlur={commitCap}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitCap();
                }}
              />
              <span className="mg-unit">GB</span>
            </div>
          </div>
          <div className="field">
            <div className="field-head">
              <span className="field-label">Reliquat wait</span>
              <span className="field-hint">How long an idle member with live Reliquats waits before the Veille stops them and lists them (default 30). Applied hot.</span>
            </div>
            <div className="mg-input-row">
              <input
                className="mg-input"
                inputMode="decimal"
                aria-label="Reliquat wait (minutes)"
                data-mg-reliquat-wait
                value={typedWait}
                disabled={!settings}
                onChange={(e) => {
                  setError(null);
                  setWaitDraft(e.target.value);
                }}
                onBlur={commitWait}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitWait();
                }}
              />
              <span className="mg-unit">min</span>
            </div>
          </div>
          <div className="field-hint" data-mg-cap-applies>Applies to members started from now on; running sessions keep what they started with.</div>
        </div>

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
