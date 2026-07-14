import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Props {
  accountId: string;
  label: string;
  onClose: () => void;
}

// A modal hosting an interactive `claude /login` running inside an account's
// config dir. It drives a dedicated login PTY (id `account-login:<accountId>`
// in the main process) over the same pty:write / pty:resize / onPtyData /
// onPtyExit channels the workspace terminal uses — those are keyed purely by
// pty id, so a non-workspace id works without any agent/status machinery.
//
// On exit we ask main to recompute account usage so the freshly-authenticated
// account's badge fills in immediately. The login link Claude prints is an
// OSC-8 / plain URL; WebLinksAddon + the OSC handler route clicks through
// accountLoginOpenUrl, which opens Claude OAuth pages in this account's
// ISOLATED login browser window (its own session partition) — never the system
// browser, whose existing claude.ai session would silently authorize the
// user's main account instead of this one. Claude's automatic browser-open is
// intercepted the same way via a PATH shim in the login PTY (see
// main/cli-shim.ts installLoginBrowserShim).
export function AccountLoginModal({ accountId, label, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyId = `account-login:${accountId}`;
  const [exited, setExited] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"Orchestra Symbols", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      convertEol: true,
      scrollback: 5000,
      theme: { background: '#1a1f26', foreground: '#e6e9ef', cursor: '#6ea8ff' },
      linkHandler: { activate: (_e, uri) => window.orchestra.accountLoginOpenUrl(accountId, uri) },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.orchestra.accountLoginOpenUrl(accountId, uri)));
    term.open(containerRef.current);

    let cancelled = false;
    let started = false;
    let lastCols = 0;
    let lastRows = 0;

    const refit = (force = false) => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
        if (dims.cols !== term.cols || dims.rows !== term.rows) term.resize(dims.cols, dims.rows);
        if (started && (force || dims.cols !== lastCols || dims.rows !== lastRows)) {
          lastCols = dims.cols;
          lastRows = dims.rows;
          window.orchestra.ptyResize(ptyId, dims.cols, dims.rows);
        }
      } catch {
        /* ignore */
      }
    };

    const start = () => {
      if (started || cancelled) return;
      const dims = (() => {
        try {
          return fit.proposeDimensions();
        } catch {
          return null;
        }
      })();
      if (!dims || !dims.cols || !dims.rows) return;
      if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      term.resize(dims.cols, dims.rows);
      started = true;
      lastCols = dims.cols;
      lastRows = dims.rows;
      window.orchestra
        .accountLoginStart(accountId, dims.cols, dims.rows)
        .then(() => {
          if (cancelled) return;
          lastCols = term.cols;
          lastRows = term.rows;
          window.orchestra.ptyResize(ptyId, term.cols, term.rows);
        })
        .catch((e) => {
          term.writeln(`\r\n\x1b[31mFailed to start login: ${(e as Error).message}\x1b[0m`);
        });
    };

    const offData = window.orchestra.onPtyData((id, data) => {
      if (id === ptyId) term.write(data);
    });
    const offExit = window.orchestra.onPtyExit((id, code) => {
      if (id !== ptyId) return;
      term.writeln(`\r\n\x1b[33m[login session ended (code ${code}) — you can close this]\x1b[0m`);
      setExited(true);
      void window.orchestra.refreshAccounts().catch(() => {});
    });
    const offLoginDone = window.orchestra.onAccountLoginDone((id) => {
      if (id !== accountId) return;
      // Token detected — PTY is already dead; close the modal automatically.
      onClose();
    });
    term.onData((data) => window.orchestra.ptyWrite(ptyId, data));

    const ro = new ResizeObserver(() => {
      if (!started) start();
      else refit();
    });
    ro.observe(containerRef.current);
    // Kick an initial start once layout settles.
    const raf = requestAnimationFrame(start);
    term.focus();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      offData();
      offExit();
      offLoginDone();
      // Stop the login PTY if it's still alive (modal closed mid-login).
      void window.orchestra.accountLoginStop(accountId).catch(() => {});
      term.dispose();
    };
  }, [accountId, ptyId]);

  return (
    <div
      className="modal-backdrop account-login-backdrop"
      onMouseDown={(e) => {
        // A stray backdrop click while the login PTY is alive would kill an
        // in-flight OAuth dance (the user is typically off in the sign-in
        // window at that moment) — require the explicit Close button instead.
        if (e.target === e.currentTarget && exited) onClose();
      }}
    >
      <div className="modal account-login-modal" role="dialog" aria-label={`Log in account ${label}`}>
        <div className="modal-header">
          <div>
            <h2>Log in — {label}</h2>
            <div className="modal-sub">
              Running <code>claude /login</code> in this account's config dir — the sign-in page opens
              in an isolated window with its own session, so it won't reuse your browser's claude.ai
              login
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="account-login-term" ref={containerRef} />
        <div className="modal-footer">
          <button className="primary" onClick={onClose}>
            {exited ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
