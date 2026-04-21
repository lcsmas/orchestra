import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  workspaceId: string;
}

export function TerminalView({ workspaceId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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

  return <div ref={containerRef} className="terminal-pane" />;
}
