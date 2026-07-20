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

/// JetBrains Mono at 10pt with "Orchestra Symbols" as an explicit second
/// family, mirroring the renderer's `fontFamily` list (`Terminal.tsx:106`).
///
/// THE SIZE IS IN PANGO POINTS, THE RENDERER'S IS IN CSS PIXELS, and copying
/// the number across the unit boundary is what made the terminal 12.5% too
/// large. `Terminal.tsx:100` sets `fontSize: 13` (px); the port asked for 11
/// (pt), which at 96dpi is 14.67px. Fewer columns fit a pane, and the user
/// reported "everything looks bigger".
///
/// MEASURED, not computed — the arithmetic said 9.75pt == 13px exactly, but
/// Pango rounds, so the arithmetic was only a hypothesis
/// (`examples/cell_size_probe`, run against a real VTE):
///
/// ```text
///   font              cell w   cell h   vs Electron 8.0 x 18.0
///   ...Symbols 11        9.0     20.0    +12.5%  +11.1%   <- was
///   ...Symbols 10        8.0     18.0     +0.0%   +0.0%   <- is
///   ...Symbols 9.75      8.0     18.0     +0.0%   +0.0%
///   ...Symbols 9.5       8.0     17.0     +0.0%   -5.6%
/// ```
///
/// 10 and 9.75 both land on the target cell; 10 is chosen as the value a
/// reader can check without recomputing a rounding. Re-run the probe before
/// changing this — the cell, not the point size, is what has to match.
///
/// The second family is NOT decorative. Pango only reaches an app-registered
/// face if something asks for it by family name: registering the subset with
/// fontconfig ([`load_app_fonts`]) makes it *available*, never *preferred*. With
/// a bare "JetBrains Mono" here, the circled-number glyphs the subset exists to
/// fix fell through to a system face and measured 20.0px against a 9.0px cell —
/// 2.22 cells, so every one of them overflowed its cell and shifted the rest of
/// the line. Naming the subset drops U+2460 to exactly 1.00 cell (measured;
/// U+0041 and U+2500 held at 1.00 as controls).
///
/// This only governs TEXT-presentation codepoints. Pango routes
/// Emoji_Presentation glyphs (U+2705 ✅, U+274C ❌ — EAW=W) to an emoji font by
/// presentation, so they ignore this list and still paint ~19px in a 2-cell
/// slot. That is a 1px paint overflow, not a grid desync: those glyphs are
/// width-2 in Claude's accounting too, so VTE reserving 2 cells is correct.
pub fn terminal_font() -> pango::FontDescription {
    pango::FontDescription::from_string("JetBrains Mono, Orchestra Symbols 10")
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
