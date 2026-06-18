import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

interface Props {
  workspaceId: string;
  isActive: boolean;
}

// Handle Ctrl/Cmd+V. A pasted image (e.g. a screenshot) wins over text:
// Claude Code has no image stdin protocol, but it auto-attaches an absolute
// image path delivered as a bracketed paste. So we read the image bytes from
// the clipboard in this focused document (the only context where the OS grants
// a clipboard read on Wayland), have the main process spill them to a temp
// file, and inject that path wrapped in bracketed-paste markers — typing the
// path char-by-char would NOT trigger Claude's auto-attach. When there's no
// image we fall back to the normal text paste.
async function pasteClipboard(workspaceId: string): Promise<void> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find((t) => t.startsWith('image/'));
      if (!imgType) continue;
      const blob = await item.getType(imgType);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const filePath = await window.orchestra.saveClipboardImage(imgType, bytes);
      if (filePath) {
        window.orchestra.ptyWrite(workspaceId, `\x1b[200~${filePath} \x1b[201~`);
        return;
      }
    }
  } catch {
    // navigator.clipboard.read() can reject (no permission, no items, or an
    // image type the renderer can't decode) — fall through to text paste.
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text) window.orchestra.ptyWrite(workspaceId, text);
  } catch {
    // nothing pasteable
  }
}

export function TerminalView({ workspaceId, isActive }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Lets the isActive effect re-assert the PTY size when this tab is shown,
  // healing any drift accrued while it was hidden. Set in the mount effect.
  const forceRefitRef = useRef<(() => void) | null>(null);

  // Mount xterm once per workspaceId. Never unmounts while the workspace exists.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      // Required so the unicode11 addon can register its width provider.
      allowProposedApi: true,
      theme: {
        background: '#1a1f26',
        foreground: '#e6e9ef',
        cursor: '#6ea8ff',
        selectionBackground: '#334155',
      },
      convertEol: true,
      scrollback: 10000,
      // Override the default OSC 8 hyperlink activator (a confirm() dialog
      // followed by window.open()) so explicit terminal hyperlinks open in
      // the user's browser via our IPC, same as plain text URLs.
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
    // Match Claude's TUI character-width accounting. Claude (Ink) measures with
    // string-width (Unicode 11+), so emoji like ✅/❌ are width 2. xterm.js
    // defaults to a Unicode 6 table that counts them as width 1. The disagreement
    // makes a line wrap in Claude's model but not in xterm's; Claude then erases
    // its previous frame by the wrong number of rows (cursor-up counted at its
    // own width) and overwrites text that xterm never wrapped — old text is left
    // in place and new text lands on top. Activating Unicode 11 here aligns the
    // two so wrap and erase counts agree.
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
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

    // Drag-to-scroll on the custom thumb. The native xterm-viewport scrollbar
    // is hidden, so without this the thumb is decorative — scroll only works
    // via wheel/keyboard. Translate pointer dy into viewport.scrollTop using
    // the same scrollHeight-vs-track ratio syncThumb uses.
    const thumb = thumbRef.current;
    let dragStartY = 0;
    let dragStartScrollTop = 0;
    const onThumbMove = (e: PointerEvent) => {
      if (!viewport || !thumb) return;
      const { scrollHeight, clientHeight } = viewport;
      const trackH = clientHeight;
      const thumbH = Math.max(30, (clientHeight / scrollHeight) * trackH);
      const maxTop = trackH - thumbH;
      if (maxTop <= 0) return;
      const dy = e.clientY - dragStartY;
      const scrollRange = scrollHeight - clientHeight;
      viewport.scrollTop = dragStartScrollTop + (dy / maxTop) * scrollRange;
    };
    const onThumbUp = (e: PointerEvent) => {
      thumb?.classList.remove('dragging');
      thumb?.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', onThumbMove);
      window.removeEventListener('pointerup', onThumbUp);
      window.removeEventListener('pointercancel', onThumbUp);
    };
    const onThumbDown = (e: PointerEvent) => {
      if (!viewport || !thumb) return;
      e.preventDefault();
      e.stopPropagation();
      dragStartY = e.clientY;
      dragStartScrollTop = viewport.scrollTop;
      thumb.classList.add('dragging');
      thumb.setPointerCapture(e.pointerId);
      window.addEventListener('pointermove', onThumbMove);
      window.addEventListener('pointerup', onThumbUp);
      window.addEventListener('pointercancel', onThumbUp);
    };
    thumb?.addEventListener('pointerdown', onThumbDown);

    let cancelled = false;
    let started = false;
    let lastSentCols = 0;
    let lastSentRows = 0;

    // force: re-send the size to the PTY even if it matches what we last sent.
    // Used by the focus/visibility/activate reconcilers to heal any drift where
    // the PTY's real winsize fell out of sync with xterm (a resize that never
    // reached it). The main process suppresses no-op resizes, so re-asserting
    // an unchanged size can't cause SIGWINCH churn.
    const refit = (force = false) => {
      try {
        const dims = fit.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
        const cols = dims.cols;
        const rows = dims.rows;
        const xtermChanged = cols !== term.cols || rows !== term.rows;
        if (xtermChanged) term.resize(cols, rows);
        if (started && (force || cols !== lastSentCols || rows !== lastSentRows)) {
          lastSentCols = cols;
          lastSentRows = rows;
          window.orchestra.ptyResize(workspaceId, cols, rows);
        }
      } catch {
        /* ignore */
      }
    };
    forceRefitRef.current = () => refit(true);

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
      // Do NOT replay the raw PTY scrollback log into xterm. Claude emits
      // escape sequences (synchronized-update queries, device attribute
      // requests, etc.) that xterm.js's parser can't handle and renders as
      // literal `^[[...` garbage when replayed. Agent context is preserved
      // through Claude's own session store (claude --continue), so we just
      // spawn a fresh TUI that paints itself.
      window.orchestra
        .ptyStart(workspaceId, cols, rows)
        .then(() => {
          // The PTY does not exist in the main process until ptyStart resolves
          // (it awaits installOrchestraHooks first). Any refit() that fired
          // during that spawn window called ptyResize while the session was
          // still absent, so resizePty silently dropped it — yet lastSentCols
          // was advanced, so it is never retried. The PTY then keeps its
          // spawn-time width while xterm settled narrower, and every line
          // Claude draws at the wider width wraps in xterm. Ink erases its live
          // region with cursor-up/erase-line counted at the wider width, moves
          // up too few rows, and overwrites old text instead of clearing it.
          // Re-assert xterm's current size now that the PTY is alive so the two
          // can never diverge across the spawn boundary.
          if (cancelled) return;
          lastSentCols = term.cols;
          lastSentRows = term.rows;
          window.orchestra.ptyResize(workspaceId, term.cols, term.rows);
        })
        .catch((e) => {
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
      // Shift+Enter → insert newline instead of submitting. xterm.js sends a
      // plain `\r` for both Enter and Shift+Enter, so Claude's TUI can't tell
      // them apart. Sending ESC+CR is what Claude Code's `/terminal-setup`
      // configures in VS Code/iTerm2 for the same effect.
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        window.orchestra.ptyWrite(workspaceId, '\x1b\r');
        e.preventDefault();
        return false;
      }
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
        e.preventDefault();
        void pasteClipboard(workspaceId);
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
    // force=true so these heal a PTY whose winsize has drifted out of sync with
    // xterm even when our own bookkeeping thinks the size is unchanged (e.g. a
    // resize whose ptyResize never reached the PTY). Cheap: main drops no-ops.
    const onVisible = () => {
      if (!started || document.visibilityState !== 'visible') return;
      requestAnimationFrame(() => refit(true));
    };
    const onFocus = () => {
      if (!started) return;
      requestAnimationFrame(() => refit(true));
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(thumbSyncRaf);
      viewport?.removeEventListener('scroll', syncThumb);
      thumb?.removeEventListener('pointerdown', onThumbDown);
      window.removeEventListener('pointermove', onThumbMove);
      window.removeEventListener('pointerup', onThumbUp);
      window.removeEventListener('pointercancel', onThumbUp);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      ro.disconnect();
      offData();
      offExit();
      offRestart();
      forceRefitRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [workspaceId]);

  // Focus xterm's input when this tab becomes active so typing goes straight
  // to the agent without requiring a click. Also re-assert the PTY size: a tab
  // switch doesn't change window focus, so onFocus won't fire, and the pane may
  // have drifted out of sync with the PTY while hidden.
  useEffect(() => {
    if (!isActive || !termRef.current) return;
    const raf = requestAnimationFrame(() => {
      try {
        termRef.current?.focus();
        forceRefitRef.current?.();
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
