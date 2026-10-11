import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AccesMobileSettings as Settings, AccesMobileView } from '../../shared/acces-mobile';

interface Props {
  onClose: () => void;
}

const POLL_MS = 2000;

/**
 * Accès mobile (#334, ADR 0006): on/off, the one Tailscale login allowed in, the two ports, the server process health, the one-time
 * `tailscale serve` command and the pairing fragment. Off by default; enabling without a login is refused by main. Applies at once.
 * The QR code / regenerate / install flow is #336.
 */
export function AccesMobileSettings({ onClose }: Props) {
  const [view, setView] = useState<AccesMobileView | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  const [servePort, setServePort] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (document.hidden) return;
    try {
      setView(await window.orchestra.accesMobile());
    } catch {
      /* keep the last good view */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const s = view?.settings;
  const apply = async (patch: Partial<Settings>): Promise<void> => {
    try {
      const res = await window.orchestra.setAccesMobile(patch);
      setView(res.view);
      setError(res.ok ? null : res.error);
      if (res.ok) {
        setLogin(null);
        setServePort(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const draftPatch = (): Partial<Settings> => {
    const p: Partial<Settings> = {};
    if (login !== null) p.allowedLogin = login;
    if (servePort !== null) p.servePort = Number(servePort);
    return p;
  };
  const commit = () => {
    const p = draftPatch();
    if (Object.keys(p).length) void apply(p);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit();
  };

  const h = view?.health;
  const healthText =
    !h || h.state === 'off'
      ? 'Off — nothing listens.'
      : h.state === 'starting'
        ? 'Starting…'
        : h.state === 'listening'
          ? 'Listening on a private local socket only (no network port).'
          : `Failed: ${h.error}${h.retryInMs != null ? ` — retrying in ${Math.round(h.retryInMs / 1000)} s` : ''}`;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal sound-settings acces-mobile-settings" role="dialog" aria-label="Accès mobile">
        <h2>Accès mobile</h2>
        <div className="sound-hint">
          Talk to your workspaces from your phone, through <code>tailscale serve</code> only. Every request needs your Tailscale login{' '}
          <strong>and</strong> the pairing token. Off by default.
        </div>

        <div className="field">
          <div className="field-head">
            <span className="field-label">Your Tailscale login</span>
            <span className="field-hint">
              The only identity let in (see <code>tailscale whoami</code>). Your tailnet may be shared — colleagues are refused.
            </span>
          </div>
          <input
            className="mg-input"
            data-am-login
            aria-label="Tailscale login"
            placeholder="you@example.com"
            value={login ?? s?.allowedLogin ?? ''}
            disabled={!s}
            onChange={(e) => setLogin(e.target.value)}
            onBlur={commit}
            onKeyDown={onKey}
          />
        </div>

        <div className="field">
          <div className="field-head">
            <span className="field-label">Tailnet port</span>
            <span className="field-hint">The HTTPS port tailscale serve exposes on your tailnet.</span>
          </div>
          <div className="mg-input-row">
            <input className="mg-input" data-am-serve-port aria-label="Tailnet port" inputMode="numeric" value={servePort ?? String(s?.servePort ?? '')} disabled={!s} onChange={(e) => setServePort(e.target.value)} onBlur={commit} onKeyDown={onKey} />
            <span className="mg-unit">tailnet</span>
          </div>
        </div>

        <label className="mg-toggle">
          <input
            type="checkbox"
            data-am-toggle
            checked={s?.enabled ?? false}
            disabled={!s}
            onChange={(e) => void apply({ ...draftPatch(), enabled: e.target.checked })}
          />
          <span>
            <span className="field-label">Accès mobile on</span>
            <span className="field-hint" data-am-health={h?.state ?? 'off'}>
              {healthText}
            </span>
          </span>
        </label>

        {view && (
          <div className="field">
            <div className="field-head">
              <span className="field-label">Once, in a terminal</span>
              <span className="field-hint">Orchestra never changes your Tailscale config. The target is a Unix socket only you can open.</span>
            </div>
            <code className="am-cmd" data-am-serve-cmd>
              {view.serveCommand}
            </code>
          </div>
        )}
        {view?.pairingFragment && (
          <div className="field">
            <div className="field-head">
              <span className="field-label">Pairing</span>
              <span className="field-hint">Open https://&lt;this machine&gt;.&lt;tailnet&gt;.ts.net:{s?.servePort} followed by this fragment on the phone.</span>
            </div>
            <button className="btn" data-am-copy onClick={() => void navigator.clipboard.writeText(view.pairingFragment ?? '')}>
              Copy pairing fragment
            </button>
          </div>
        )}

        {error && (
          <div className="mg-error" role="alert" data-am-error>
            ⚠ {error}
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
