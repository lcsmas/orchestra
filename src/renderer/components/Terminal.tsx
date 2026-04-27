import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Props {
  workspaceId: string;
  isActive: boolean;
}

export function TerminalView({ workspaceId, isActive }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
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
        background: '#1a1f26',
        foreground: '#e6e9ef',
        cursor: '#6ea8ff',
        selectionBackground: '#334155',
      },
      convertEol: true,
      scrollback: 10000,
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

    // Custom overlay scrollbar. The native xterm-viewport scrollbar is hidden
    // via CSS (no reserved gutter), and this thumb floats over the terminal
    // content only while the pane is hovered. Position is synced from the
    // viewport's scrollTop / scrollHeight on every scroll.
    const viewport = containerRef.current.querySelector('.xterm-viewport') as HTMLElement | null;
    const syncThumb = () => {
      const thumb = thumbRef.current;
      if (!thumb || !viewport) return;
      const { scrollHeight, clientHeight, scrollTop } = viewport;
      if (scrollHeight <= clientHeight) {
        thumb.style.opacity = '0';
        return;
      }
      const trackH = clientHeight;
      const thumbH = Math.max(30, (clientHeight / scrollHeight) * trackH);
      const maxTop = trackH - thumbH;
      const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
      thumb.style.height = `${thumbH}px`;
      thumb.style.transform = `translateY(${top}px)`;
      thumb.style.opacity = '';
    };
    viewport?.addEventListener('scroll', syncThumb, { passive: true });
    const thumbSyncRaf = requestAnimationFrame(syncThumb);

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
        const xtermChanged = cols !== term.cols || rows !== term.rows;
        if (xtermChanged) term.resize(cols, rows);
        if (started && (cols !== lastSentCols || rows !== lastSentRows)) {
          lastSentCols = cols;
          lastSentRows = rows;
          window.orchestra.ptyResize(workspaceId, cols, rows);
        }
      } catch {
        /* ignore */
      }
    };

    // Start the PTY only after we have real container dimensions. Inactive
    // workspace tabs render with display:none, which makes proposeDimensions
    // return null/zero and would otherwise spawn the PTY at default 80×24
    // and mis-wrap all scrollback before the tab is ever shown.
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
      const cols = dims.cols;
      const rows = dims.rows;
      lastSentCols = cols;
      lastSentRows = rows;
      // Do NOT replay the raw PTY scrollback log into xterm. Claude/Codex emit
      // escape sequences (synchronized-update queries, device attribute
      // requests, etc.) that xterm.js's parser can't handle and renders as
      // literal `^[[...` garbage when replayed. Agent context is preserved
      // through the agent's own session store (claude --continue / codex
      // resume --last), so we just spawn a fresh TUI that paints itself.
      window.orchestra.ptyStart(workspaceId, cols, rows).catch((e) => {
        term.writeln(`\r\n\x1b[31mFailed to start agent: ${e.message}\x1b[0m`);
      });
    };

    const offData = window.orchestra.onPtyData((id, data) => {
      if (id === workspaceId) term.write(data);
    });
    const offExit = window.orchestra.onPtyExit((id, code) => {
      if (id === workspaceId) {
        term.writeln(`\r\n\x1b[33m[agent exited with code ${code}]\x1b[0m`);
      }
    });
    // Main process stopped the pty and wants us to spawn a fresh one — used
    // on branch switch so the agent starts over against the new branch
    // instead of running with stale in-memory context from the old one.
    const offRestart = window.orchestra.onPtyRestart((id) => {
      if (id !== workspaceId) return;
      term.reset();
      started = false;
      lastSentCols = 0;
      lastSentRows = 0;
      start();
    });

    term.onData((data) => {
      window.orchestra.ptyWrite(workspaceId, data);
    });

    // Clipboard shortcuts. The agent must never receive SIGINT, so plain
    // Ctrl+C is repurposed as copy. Ctrl+Shift+C / Cmd+C also copy; Ctrl+V /
    // Ctrl+Shift+V / Cmd+V paste.
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return true;
      const key = e.key.toLowerCase();
      if (key === 'c') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        e.preventDefault();
        return false;
      }
      if (key === 'v') {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) window.orchestra.ptyWrite(workspaceId, text);
          })
          .catch(() => {});
        e.preventDefault();
        return false;
      }
      return true;
    });

    const ro = new ResizeObserver(() => {
      if (!started) {
        start();
        return;
      }
      refit();
    });
    ro.observe(containerRef.current);

    // Kick a first attempt in case the container already has dimensions.
    const raf = requestAnimationFrame(start);

    // Re-fit when the window becomes visible or regains focus. The container
    // size doesn't change on window show, so ResizeObserver won't fire; xterm
    // can end up rendering smaller than the viewport if the canvas was
    // measured while occluded or at an intermediate layout size.
    const onVisible = () => {
      if (!started || document.visibilityState !== 'visible') return;
      requestAnimationFrame(refit);
    };
    const onFocus = () => {
      if (!started) return;
      requestAnimationFrame(refit);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(thumbSyncRaf);
      viewport?.removeEventListener('scroll', syncThumb);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      ro.disconnect();
      offData();
      offExit();
      offRestart();
      term.dispose();
      termRef.current = null;
    };
  }, [workspaceId]);

  // Focus xterm's input when this tab becomes active so typing goes straight
  // to the agent without requiring a click.
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

  return (
    <div
      ref={containerRef}
      className={`terminal-pane ${isActive ? 'active' : ''}`}
    >
      <div ref={thumbRef} className="term-scroll-thumb" aria-hidden="true" />
    </div>
  );
}
