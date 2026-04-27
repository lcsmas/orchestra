import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Props {
  workspaceId: string;
  isActive: boolean;
  /** Whether the repo this workspace belongs to has a `run` script
   * configured. When false, render a hint instead of an xterm. */
  hasRunScript: boolean;
}

/** Long-lived dev-server / run-script terminal. Spawns `bash -lc <script>`
 * with `ORCHESTRA_PORT` etc. injected via the run-pty IPC. Output id is
 * `<workspaceId>:run` so it doesn't collide with the agent PTY or nvim. */
export function RunTerminal({ workspaceId, isActive, hasRunScript }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const startedRef = useRef(false);
  const lastSentRef = useRef({ cols: 0, rows: 0 });
  const [running, setRunning] = useState(false);

  const runId = `${workspaceId}:run`;

  useEffect(() => {
    if (!hasRunScript) return;
    if (!containerRef.current) return;
    const term = new XTerm({
      cursorBlink: false,
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      theme: {
        background: '#1a1f26',
        foreground: '#e6e9ef',
        cursor: '#6ea8ff',
        selectionBackground: '#334155',
      },
      convertEol: true,
      scrollback: 5000,
      linkHandler: {
        activate: (_e, uri) => {
          window.orchestra.openExternal(uri);
        },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        window.orchestra.openExternal(uri);
      }),
    );
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;

    let cancelled = false;

    const refit = () => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
        if (dims.cols !== term.cols || dims.rows !== term.rows) {
          term.resize(dims.cols, dims.rows);
        }
        if (
          startedRef.current &&
          (dims.cols !== lastSentRef.current.cols || dims.rows !== lastSentRef.current.rows)
        ) {
          lastSentRef.current = { cols: dims.cols, rows: dims.rows };
          window.orchestra.ptyResize(runId, dims.cols, dims.rows);
        }
      } catch {
        /* ignore */
      }
    };

    const offData = window.orchestra.onPtyData((id, data) => {
      if (id === runId) term.write(data);
    });
    const offExit = window.orchestra.onPtyExit((id, code) => {
      if (id !== runId) return;
      term.writeln(`\r\n\x1b[33m[run script exited with code ${code}]\x1b[0m`);
      startedRef.current = false;
      setRunning(false);
    });

    term.onData((data) => {
      window.orchestra.ptyWrite(runId, data);
    });

    // Replay any prior scrollback the moment we mount, so re-opening the tab
    // shows what already scrolled by.
    void window.orchestra.runScriptScrollback(workspaceId).then((sb) => {
      if (cancelled) return;
      if (sb) term.write(sb);
    });

    const ro = new ResizeObserver(() => refit());
    ro.observe(containerRef.current);

    const isMac = navigator.platform.toUpperCase().includes('MAC');
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return true;
      const key = e.key.toLowerCase();
      if (key === 'c') {
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          e.preventDefault();
          return false;
        }
        // No selection: forward Ctrl+C to the run script (kill the dev server).
        return true;
      }
      if (key === 'v') {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) window.orchestra.ptyWrite(runId, text);
          })
          .catch(() => {});
        e.preventDefault();
        return false;
      }
      return true;
    });

    return () => {
      cancelled = true;
      ro.disconnect();
      offData();
      offExit();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [workspaceId, runId, hasRunScript]);

  useEffect(() => {
    if (!isActive || !termRef.current) return;
    const raf = requestAnimationFrame(() => {
      try {
        termRef.current?.focus();
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive]);

  const start = useCallback(async () => {
    if (startedRef.current) return;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    let dims: ReturnType<FitAddon['proposeDimensions']> | null = null;
    try {
      dims = fit.proposeDimensions() ?? null;
    } catch {
      dims = null;
    }
    if (!dims || !dims.cols || !dims.rows) return;
    if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    term.resize(dims.cols, dims.rows);
    startedRef.current = true;
    lastSentRef.current = { cols: dims.cols, rows: dims.rows };
    setRunning(true);
    try {
      await window.orchestra.runScriptStart(workspaceId, dims.cols, dims.rows);
    } catch (err) {
      term.writeln(`\r\n\x1b[31mFailed to start run script: ${(err as Error).message}\x1b[0m`);
      startedRef.current = false;
      setRunning(false);
    }
  }, [workspaceId]);

  const stop = useCallback(async () => {
    if (!startedRef.current) return;
    try {
      await window.orchestra.runScriptStop(workspaceId);
    } catch {
      /* best-effort */
    }
    startedRef.current = false;
    setRunning(false);
  }, [workspaceId]);

  if (!hasRunScript) {
    return (
      <div className={`run-pane empty ${isActive ? 'active' : ''}`}>
        <div className="run-empty">
          <h3>No run script configured</h3>
          <p>
            Click the gear icon next to the repo name in the sidebar to add a <code>run</code> script
            (e.g. <code>pnpm dev --port $ORCHESTRA_PORT</code>).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`run-pane ${isActive ? 'active' : ''}`}>
      <div className="run-toolbar">
        <button
          className={`run-action ${running ? 'stop' : 'start'}`}
          onClick={() => {
            if (running) void stop();
            else void start();
          }}
        >
          {running ? '■ Stop' : '▶ Run'}
        </button>
        <span className="run-status">{running ? 'running' : 'stopped'}</span>
      </div>
      <div ref={containerRef} className="run-terminal-container" />
    </div>
  );
}
