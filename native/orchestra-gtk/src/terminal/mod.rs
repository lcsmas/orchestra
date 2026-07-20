//! Feed-mode terminal stack (plan §5.2).
//!
//! The backend owns every PTY — logging, coalescing (8 ms/64 KiB + 150 ms echo
//! fast-path), scrollback, sandbox transport, `pty:stopped` semantics. The GTK
//! side is a **feed-mode VTE**: NO `spawn_async`. Backend `ptyData` frames are
//! rendered with `vte_terminal_feed`, the `commit` signal forwards keystrokes as
//! `ptyWrite`, and a grid resize calls `ptyResize`. The M2-B2 risk spike
//! confirmed VTE's own scheduler batches feed exactly like PTY reads, so no
//! app-side frame-holding is needed (see `examples/feed_spike.rs`).
//!
//! - [`TerminalStack`] keeps one [`pane::TerminalPane`] alive per workspace in a
//!   `GtkStack` (scrollback survives tab switches), lazily `ptyStart`s each on
//!   its first visible fit, and routes `(id, bytes)` ptyData to the right pane.

mod boot_pill;
mod fonts;
mod pane;
mod stack;

pub use fonts::load_app_fonts;
pub use stack::TerminalStack;

use gtk::gdk;
use gtk::pango;

/// JetBrains Mono at 11pt, matching the Electron renderer. The "Orchestra
/// Symbols" subset (for ①②③ status glyphs) is loaded app-wide via fontconfig at
/// startup (see [`load_app_fonts`]); it participates as a fallback so the
/// circled-number metrics match the web build.
pub fn terminal_font() -> pango::FontDescription {
    pango::FontDescription::from_string("JetBrains Mono 11")
}

fn rgba(hex: &str) -> gdk::RGBA {
    hex.parse().expect("valid hex color")
}

/// Foreground / background used by every pane.
///
/// These MUST track `src/renderer/term-theme.ts` (`TERM_THEME`), which is the
/// source of truth for both frontends' terminal colors — the renderer's
/// `.terminal-pane` background is itself a hardcoded mirror of it
/// (styles.css:2395, with a comment saying so). The background is `--bg-3`,
/// NOT `--bg`: the terminal is the largest surface in the app, so a wrong
/// layer here reads as the whole app being the wrong color.
pub fn term_fg() -> gdk::RGBA {
    rgba("#e6e9ef")
}
pub fn term_bg() -> gdk::RGBA {
    rgba("#1a1f26")
}

/// Cursor and selection, also from `TERM_THEME`. VTE leaves these at its own
/// defaults unless set explicitly, so omitting them is a visible divergence.
pub fn term_cursor() -> gdk::RGBA {
    rgba("#6ea8ff")
}
pub fn term_selection() -> gdk::RGBA {
    rgba("#334155")
}

/// The 16-color ANSI palette — Ghostty's default (Tomorrow Night), ported
/// 1:1 from `TERM_THEME` in `src/renderer/term-theme.ts`.
///
/// Do NOT substitute the app's UI accent tokens here. An earlier version of
/// this function used `@accent`/`@green`/`@red` and matched Electron in 0 of
/// 16 slots (deltas up to 94/255), which is why Claude's TUI rendered with
/// visibly different colors in the two frontends. The renderer picked this
/// palette deliberately: without it xterm.js falls back to a legacy VGA-ish
/// scheme that made the TUI look harsher than a native terminal.
pub fn term_palette() -> [gdk::RGBA; 16] {
    [
        rgba("#1d1f21"),
        rgba("#cc6666"),
        rgba("#b5bd68"),
        rgba("#f0c674"),
        rgba("#81a2be"),
        rgba("#b294bb"),
        rgba("#8abeb7"),
        rgba("#c5c8c6"),
        rgba("#666666"),
        rgba("#d54e53"),
        rgba("#b9ca4a"),
        rgba("#e7c547"),
        rgba("#7aa6da"),
        rgba("#c397d8"),
        rgba("#70c0b1"),
        rgba("#eaeaea"),
    ]
}
