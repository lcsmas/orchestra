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
pub use pane::{PaneIntent, PaneKind};
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

/// Foreground / background used by every pane (prototype palette).
pub fn term_fg() -> gdk::RGBA {
    rgba("#e6e9ef")
}
pub fn term_bg() -> gdk::RGBA {
    rgba("#0b0d10")
}

/// The 16-color ANSI palette, lifted verbatim from the GTK prototype (which in
/// turn tracks the renderer's `styles.css` terminal tokens).
pub fn term_palette() -> [gdk::RGBA; 16] {
    [
        rgba("#0b0d10"),
        rgba("#ff6b6b"),
        rgba("#5bd68b"),
        rgba("#ffc857"),
        rgba("#6ea8ff"),
        rgba("#c792ea"),
        rgba("#7fdbca"),
        rgba("#e6e9ef"),
        rgba("#333b47"),
        rgba("#ff8f8f"),
        rgba("#7fe3a8"),
        rgba("#ffd77e"),
        rgba("#8fbcff"),
        rgba("#d7b3f0"),
        rgba("#a3ebdd"),
        rgba("#ffffff"),
    ]
}
