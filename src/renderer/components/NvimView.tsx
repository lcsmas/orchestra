import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Props {
  workspaceId: string;
  isActive: boolean;
}

export function NvimView({ workspaceId, isActive }: Props) {
  const sessionId = `${workspaceId}:nvim`;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      theme: {
        background: '#000000',
        foreground: '#e6e9ef',
        cursor: '#6ea8ff',
        selectionBackground: '#334155',
      },
      convertEol: true,
      scrollback: 2000,
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

    let cancelled = false;
    let started = false;
    let lastSentCols = 0;
    let lastSentRows = 0;

    const refit = () => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
        const cols = dims.cols;
        const rows = dims.rows;
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
        if (started && (cols !== lastSentCols || rows !== lastSentRows)) {
          lastSentCols = cols;
          lastSentRows = rows;
          window.orchestra.ptyResize(sessionId, cols, rows);
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
      lastSentCols = dims.cols;
      lastSentRows = dims.rows;
      window.orchestra.nvimStart(workspaceId, dims.cols, dims.rows).catch((e) => {
        term.writeln(`\r\n\x1b[31mFailed to start nvim: ${e.message}\x1b[0m`);
      });
    };

    const offData = window.orchestra.onPtyData((id, data) => {
      if (id === sessionId) term.write(data);
    });
    const offExit = window.orchestra.onPtyExit((id, code) => {
      if (id === sessionId) {
        term.writeln(`\r\n\x1b[33m[nvim exited with code ${code}]\x1b[0m`);
      }
    });
    const offRestart = window.orchestra.onPtyRestart((id) => {
      if (id !== sessionId) return;
      term.reset();
      started = false;
      lastSentCols = 0;
      lastSentRows = 0;
      start();
    });

    term.onData((data) => {
      window.orchestra.ptyWrite(sessionId, data);
    });

    const ro = new ResizeObserver(() => {
      if (!started) {
        start();
        return;
      }
      refit();
    });
    ro.observe(containerRef.current);

    const raf = requestAnimationFrame(start);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      offData();
      offExit();
      offRestart();
      term.dispose();
      termRef.current = null;
    };
  }, [workspaceId, sessionId]);

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

  return <div ref={containerRef} className="nvim-inner" />;
}
