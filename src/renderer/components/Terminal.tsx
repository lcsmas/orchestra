import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  workspaceId: string;
  isActive: boolean;
}

export function TerminalView({ workspaceId, isActive }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Mount xterm once per workspaceId. Never unmounts while the workspace exists.
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
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const { cols, rows } = term;

    // Replay any buffered output that accumulated before this mount, then start
    // the pty (startPty is idempotent on the main side).
    window.orchestra.ptyGetBuffer(workspaceId).then((buf) => {
      if (buf) term.write(buf);
    });

    window.orchestra.ptyStart(workspaceId, cols, rows).catch((e) => {
      term.writeln(`\r\n\x1b[31mFailed to start agent: ${e.message}\x1b[0m`);
    });

    const offData = window.orchestra.onPtyData((id, data) => {
      if (id === workspaceId) term.write(data);
    });
    const offExit = window.orchestra.onPtyExit((id, code) => {
      if (id === workspaceId) {
        term.writeln(`\r\n\x1b[33m[agent exited with code ${code}]\x1b[0m`);
      }
    });

    term.onData((data) => {
      window.orchestra.ptyWrite(workspaceId, data);
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        window.orchestra.ptyResize(workspaceId, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      offData();
      offExit();
      term.dispose();
      termRef.current = null;
    };
  }, [workspaceId]);

  // Re-fit whenever this terminal becomes the visible one. The element has
  // real dimensions only when it is not hidden, so fit() must run after
  // display is restored.
  useEffect(() => {
    if (isActive && fitRef.current && termRef.current) {
      // Use rAF to let the browser apply the style change before measuring.
      requestAnimationFrame(() => {
        try {
          fitRef.current!.fit();
          window.orchestra.ptyResize(
            workspaceId,
            termRef.current!.cols,
            termRef.current!.rows,
          );
        } catch {
          /* ignore */
        }
      });
    }
  }, [isActive, workspaceId]);

  return (
    <div
      ref={containerRef}
      className="terminal-pane"
      style={isActive ? undefined : { display: 'none' }}
    />
  );
}
