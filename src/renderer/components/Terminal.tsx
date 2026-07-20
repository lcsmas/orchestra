import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { createTermWriteQueue } from '../term-write-queue';
import { TERM_THEME } from '../term-theme';
import { useStore } from '../store';

interface Props {
  workspaceId: string;
  isActive: boolean;
}

// Cold-boot pill: hidden once the agent has painted a real TUI frame. Claude
// opens a ?2026 sync frame at launch, paints only its small splash header
// (logo + version, ~500 bytes measured from PTY logs), then goes silent while
// `--continue` reloads the session — the restored conversation + input box
// land seconds later as a multi-KiB burst. Cumulative output ≥ this since
// spawn therefore means the real UI is on screen.
const BOOT_PAINT_BYTES = 2048;
// Safety net only: the pill normally clears on the first real frame, a user
// keystroke, or PTY exit. This guards against a stuck pill if none of those
// ever fire (e.g. an agent that quietly hangs before painting).
const BOOT_PILL_MAX_MS = 20_000;

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
  // Lets the isActive effect force a full repaint when this tab is shown. Set
  // in the mount effect (it needs the term + webgl addon in scope).
  const repaintRef = useRef<(() => void) | null>(null);
  // Current isActive, readable from the mount effect's long-lived closures
  // (onVisible/onFocus) without them capturing a stale value.
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // Lazy-start latch: the agent PTY is only spawned once this tab has been
  // shown at least once. Every workspace's TerminalView mounts at app startup
  // (App.tsx renders all of them; inactive panes hide via visibility:hidden,
  // which KEEPS layout dimensions), so without this gate a restart with N
  // workspaces immediately spawned N `claude --continue` processes. Flips
  // true on first activation (isActive effect) or on a main-initiated
  // pty:restart, and never resets — after that, start() behaves as before.
  const allowStartRef = useRef(isActive);
  // Lets the isActive effect trigger the (mount-effect-scoped) start() the
  // first time the tab is shown. Set in the mount effect.
  const startRef = useRef<(() => void) | null>(null);
  // Cold-boot indicator, shown while a freshly-spawned agent loads its session
  // (lazy-start means the first open cold-boots `claude --continue`, which can
  // take a couple of seconds during which Claude paints only its splash
  // header — the pane otherwise reads as broken). null = hidden.
  const [bootLabel, setBootLabel] = useState<string | null>(null);

  // Mount xterm once per workspaceId. Never unmounts while the workspace exists.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      // Bundled fonts (see @font-face in styles.css). "Orchestra Symbols" is a
      // unicode-range-scoped subset that owns only the circled-number / dingbat
      // codepoints Claude emits, so it's reached first for those; "JetBrains
      // Mono" is the primary monospace face we ship so the terminal looks the
      // same on every machine. ui-monospace/Menlo remain as last-resort fallback.
      fontFamily:
        '"Orchestra Symbols", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      // Required so the unicode11 addon can register its width provider.
      allowProposedApi: true,
      theme: TERM_THEME,
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

    // GPU-accelerated rendering. xterm's default DOM renderer repaints heavy
    // output entirely on the main thread, which is the dominant source of the
    // multi-second jank that delays the status dot (see the RAF-batched write
    // below). The WebGL renderer offloads glyph rasterization to the GPU —
    // typically several times faster on a burst — shrinking every jank window.
    // Must be loaded after open() (it needs the attached canvas). On GPU context
    // loss (driver reset, some compositors when occluded) we dispose it so xterm
    // transparently falls back to the DOM renderer rather than rendering nothing.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable (headless, blocklisted GPU, software GL) — the DOM
      // renderer stays active. Functionally identical, just slower on bursts.
      webgl = null;
    }

    termRef.current = term;
    fitRef.current = fit;

    // The WebGL renderer bakes each glyph into a GPU texture atlas the first
    // time it paints. If a bundled font hasn't finished loading by then, the
    // atlas caches the fallback (or tofu) glyph and never re-measures it — this
    // is why circled numbers showed as "@" boxes once WebGL was enabled.
    //
    // Two things matter here:
    //  1. "Orchestra Symbols" is unicode-range-scoped, so the browser only
    //     fetches its woff2 when a glyph IN that range is actually requested.
    //     document.fonts.load() with no sample text does NOT trigger that fetch
    //     — we must pass representative glyphs (the circled numbers) so the file
    //     is genuinely downloaded before we clear the atlas.
    //  2. We clear the atlas only after BOTH faces resolve, so the re-raster
    //     picks up JetBrains Mono and the symbols together.
    if (document.fonts) {
      Promise.all([
        document.fonts.load('13px "JetBrains Mono"'),
        document.fonts.load('bold 13px "JetBrains Mono"'),
        document.fonts.load('13px "Orchestra Symbols"', '①②③⓪❶❷☐✻'),
      ])
        .then(() => {
          if (cancelled) return;
          try {
            term.clearTextureAtlas();
          } catch {
            /* ignore — DOM renderer has no atlas to clear */
          }
        })
        .catch(() => {
          /* font load failed — fall back stack still renders */
        });
    }

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

    // Force a full, correct repaint of the visible screen from xterm's buffer.
    // Called when the tab becomes active again. While a workspace tab is hidden
    // (visibility:hidden) the PTY keeps streaming and drainPending keeps writing
    // into xterm, but the WebGL renderer is painting onto an offscreen/occluded
    // canvas. On some GPUs/compositors that leaves the glyph texture atlas — and
    // the composited canvas — in a stale, half-updated state: on return you get
    // the scrambled glyph soup (fragmented characters, wrong colours) instead of
    // the real TUI frame. xterm's buffer is always authoritative, so we drop the
    // WebGL atlas (rebuilt lazily on the next paint) and ask xterm to redraw
    // every row from that buffer. Cheap: one full-screen redraw, only on show.
    const repaint = () => {
      try {
        webgl?.clearTextureAtlas();
      } catch {
        /* DOM renderer / no atlas — nothing to clear */
      }
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        /* ignore */
      }
    };
    repaintRef.current = repaint;

    // Cold-boot pill bookkeeping (see bootLabel). All state lives in this
    // closure; the pill clears on the first real TUI frame (byte threshold),
    // a user keystroke, PTY exit/spawn failure, or the safety timeout.
    let bootBytes = 0;
    let bootActive = false;
    let bootTimer: ReturnType<typeof setTimeout> | null = null;
    const clearBoot = () => {
      if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
      if (!bootActive) return;
      bootActive = false;
      setBootLabel(null);
    };
    const beginBoot = () => {
      bootBytes = 0;
      bootActive = true;
      // Imperative read, not a subscription — this fires once per spawn and
      // must not re-render every TerminalView on unrelated store churn.
      const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
      setBootLabel(ws?.hasInput ? 'Resuming previous session…' : 'Starting agent…');
      if (bootTimer) clearTimeout(bootTimer);
      bootTimer = setTimeout(clearBoot, BOOT_PILL_MAX_MS);
    };

    // Start the PTY only once the tab has been shown (allowStartRef — the
    // lazy-start latch documented at its declaration) AND we have real
    // container dimensions, so the PTY never spawns at default 80×24 and
    // mis-wraps scrollback before the tab is ever visible. Note inactive
    // panes hide via visibility:hidden and thus still HAVE dimensions —
    // the latch, not the fit probe, is what makes startup lazy.
    const start = () => {
      if (started || cancelled) return;
      if (!allowStartRef.current) return;
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
      beginBoot();
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
          clearBoot();
          term.writeln(`\r\n\x1b[31mFailed to start agent: ${e.message}\x1b[0m`);
        });
    };

    // Feed PTY output to xterm through the shared write queue instead of
    // calling term.write() synchronously inside the IPC callback. The queue
    // frame-paces big bursts (so a tool-result dump can't jank the renderer
    // and stall the status dot's IPC — the old "dot takes ~10s" lag), applies
    // Claude's ?2026 synchronized-output frames atomically (the anti-flicker
    // path; xterm.js itself ignores mode 2026), and fast-paths small idle
    // chunks like keystroke echoes past the RAF wait. Budget tuning and frame
    // semantics are documented in term-write-queue.ts.
    const queue = createTermWriteQueue((data) => term.write(data));
    const offData = window.orchestra.onPtyData((id, data) => {
      if (id !== workspaceId) return;
      if (bootActive) {
        bootBytes += data.length;
        if (bootBytes >= BOOT_PAINT_BYTES) clearBoot();
      }
      queue.push(data);
    });
    const offExit = window.orchestra.onPtyExit((id, code) => {
      if (id === workspaceId) {
        clearBoot();
        // Un-latch like the stopped path below, so a keystroke (or the next
        // activation) relaunches instead of typing into a dead session.
        started = false;
        lastSentCols = 0;
        lastSentRows = 0;
        term.writeln(
          `\r\n\x1b[33m[agent exited with code ${code} — press any key to relaunch]\x1b[0m`,
        );
      }
    });
    // Main process stopped the pty and wants us to spawn a fresh one — used
    // on branch switch so the agent starts over against the new branch
    // instead of running with stale in-memory context from the old one.
    const offRestart = window.orchestra.onPtyRestart((id) => {
      if (id !== workspaceId) return;
      // Drop any output still buffered from the old pty so it can't land after
      // the reset and corrupt the fresh session's first frame.
      queue.reset();
      term.reset();
      started = false;
      lastSentCols = 0;
      lastSentRows = 0;
      // Main explicitly asked for a respawn — bypass the lazy-start latch
      // even if this tab was never shown.
      allowStartRef.current = true;
      start();
    });
    // Main stopped the pty with NO respawn (the Resources page's per-agent
    // stop). Un-latch `started` so the terminal doesn't sit silently dead:
    // the next activation — or a keystroke, via the onData relaunch below —
    // spawns a fresh agent that resumes with `claude --continue`.
    const offStopped = window.orchestra.onPtyStopped((id) => {
      if (id !== workspaceId) return;
      clearBoot();
      queue.reset();
      started = false;
      lastSentCols = 0;
      lastSentRows = 0;
      term.writeln('\r\n\x1b[33m[agent stopped — press any key to relaunch]\x1b[0m');
    });

    term.onData((data) => {
      // A keystroke means the user can already see something worth typing at —
      // never leave the pill floating over a UI they're interacting with.
      clearBoot();
      // Dead-session relaunch: after a stop (or exit), the first keystroke
      // revives the agent instead of being dropped by a writePty no-op. The
      // keystroke itself is intentionally not forwarded — it's the trigger,
      // not input. Never fires pre-first-start: an inactive tab can't be
      // typed into, and activation flips the latch and starts the PTY.
      if (!started && allowStartRef.current) {
        start();
        return;
      }
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
    // Expose start() so the isActive effect can fire it when the lazy-start
    // latch flips on first activation (no resize happens then, so neither the
    // ResizeObserver nor the RAF above would retry).
    startRef.current = start;

    // Re-fit when the window becomes visible or regains focus. The container
    // size doesn't change on window show, so ResizeObserver won't fire; xterm
    // can end up rendering smaller than the viewport if the canvas was
    // measured while occluded or at an intermediate layout size.
    // force=true so these heal a PTY whose winsize has drifted out of sync with
    // xterm even when our own bookkeeping thinks the size is unchanged (e.g. a
    // resize whose ptyResize never reached the PTY). Cheap: main drops no-ops.
    const onVisible = () => {
      if (!started || document.visibilityState !== 'visible') return;
      requestAnimationFrame(() => {
        refit(true);
        // Only the active pane's canvas is composited; the others repaint when
        // they next become active. Repainting the visible one here heals a
        // garbled WebGL frame after the whole window was occluded/minimized.
        if (isActiveRef.current) {
          repaint();
          // Also make the CHILD repaint (SIGWINCH bounce in main). While the
          // window was hidden the pane kept streaming with paint/RAF suspended;
          // if xterm's buffer diverged from Claude's diff-render model in that
          // gap, per-cell diffs never heal it (scattered-words garble) — only
          // a real child repaint reconverges the two. Human-paced + no-op when
          // nothing diverged, so the cost is one extra TUI frame.
          window.orchestra.ptyRepaint(workspaceId, term.cols, term.rows);
        }
      });
    };
    // On Wayland, Chromium has no window-occlusion detection: a window on a
    // hidden sway workspace keeps visibilityState 'visible' and visibilitychange
    // NEVER fires (verified via CDP against a headless-sway instance). Window
    // focus is the signal that actually fires when the user comes back, so the
    // canvas repaint + child repaint-bounce must live here too, not just in
    // onVisible.
    const onFocus = () => {
      if (!started) return;
      requestAnimationFrame(() => {
        refit(true);
        if (isActiveRef.current) {
          repaint();
          window.orchestra.ptyRepaint(workspaceId, term.cols, term.rows);
        }
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      if (bootTimer) clearTimeout(bootTimer);
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
      queue.reset();
      offData();
      offExit();
      offRestart();
      offStopped();
      startRef.current = null;
      forceRefitRef.current = null;
      repaintRef.current = null;
      webgl?.dispose();
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
    // First activation: flip the lazy-start latch and spawn the agent. A
    // no-op on every later activation (start() bails on `started`).
    allowStartRef.current = true;
    startRef.current?.();
    const raf = requestAnimationFrame(() => {
      try {
        termRef.current?.focus();
        forceRefitRef.current?.();
        // Repaint AFTER the refit so we redraw at the final size. Heals the
        // garbled WebGL frame that can result from writing to xterm while the
        // pane was hidden (visibility:hidden / occluded canvas).
        repaintRef.current?.();
        // And ask the CHILD to repaint too (SIGWINCH bounce; no-op if the PTY
        // isn't running). The canvas repaint above redraws xterm's buffer, but
        // if the buffer itself diverged from Claude's diff-render model while
        // this pane was backgrounded, only a child repaint reconverges it.
        const t = termRef.current;
        if (t) window.orchestra.ptyRepaint(workspaceId, t.cols, t.rows);
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
      {bootLabel && (
        <div className="term-boot-pill">
          <span className="term-boot-spinner" aria-hidden="true" />
          {bootLabel}
        </div>
      )}
    </div>
  );
}
