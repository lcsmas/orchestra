import { useEffect, useReducer, useState } from 'react';
import { appUpdateTitle, type AppUpdateState } from '../../shared/app-update';

/** « Nouvelle version installée » (Lucas 2026-10-12): the installed AppImage was replaced on disk; this running app keeps the old code
 *  until it is relaunched. « Relancer » quits, then the installed app starts (the agents keep running in their keepers); « Plus tard »
 *  hides it until another install. State: the pull `appUpdate:state` + the push `appUpdate:update`, kept here (one per renderer). */
let state: AppUpdateState = { kind: 'none' };
let dismissedKey = '';
let started = false;
const subs = new Set<() => void>();

function apply(s: AppUpdateState): void {
  // the monitor only ever goes none → installed (→ installed with a version / a newer install): a late « none » pull never hides a push
  if (s.kind === 'none' && state.kind === 'installed') return;
  state = s;
  subs.forEach((f) => f());
}
function ensureStarted(): void {
  if (started) return;
  started = true;
  window.orchestra.onAppUpdate(apply);
  window.orchestra.appUpdateState().then(apply).catch(() => {});
}

export function AppUpdateBanner() {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [relaunching, setRelaunching] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    ensureStarted();
    subs.add(rerender);
    return () => {
      subs.delete(rerender);
    };
  }, []);
  if (state.kind !== 'installed' || state.key === dismissedKey) return null;
  const key = state.key;
  const relaunch = () => {
    setRelaunching(true);
    setError('');
    window.orchestra
      .relaunchInstalled()
      .then((r) => {
        if (!r.ok) {
          setRelaunching(false);
          setError(r.error ?? 'échec');
        }
      })
      .catch((e) => {
        setRelaunching(false);
        setError(String(e));
      });
  };
  return (
    <div className="memory-banner info app-update-banner" role="status" aria-live="polite" data-app-update={state.version ?? ''}>
      <span className="memory-banner-ico" aria-hidden="true">↻</span>
      <span className="memory-banner-text">
        <span className="memory-banner-title">
          <strong>{appUpdateTitle(state)}</strong>
        </span>
        <span className="memory-banner-sub">
          {error ? `Relance impossible : ${error}` : 'Relance Orchestra pour l’utiliser — les agents continuent pendant le redémarrage.'}
        </span>
      </span>
      <button className="app-update-relaunch" data-app-update-relaunch onClick={relaunch} disabled={relaunching}>
        {relaunching ? 'Relance…' : 'Relancer'}
      </button>
      <button
        className="memory-banner-dismiss"
        data-app-update-later
        onClick={() => {
          dismissedKey = key;
          rerender();
        }}
      >
        Plus tard
      </button>
    </div>
  );
}
