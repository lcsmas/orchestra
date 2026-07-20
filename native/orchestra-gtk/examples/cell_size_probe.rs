//! Measure the VTE's actual cell geometry for a given font description.
//!
//! WHY THIS EXISTS. The port requested "JetBrains Mono 11" — 11 PANGO POINTS —
//! against the renderer's `fontSize: 13` CSS PX (Terminal.tsx:100). Those units
//! are not the same: at 96dpi, 11pt = 14.67px, so the terminal ran ~12.5%
//! larger and fewer columns fit a pane. Arithmetic says 9.75pt == 13px exactly,
//! but Pango may round a fractional size, so the arithmetic is a HYPOTHESIS and
//! this probe is what settles it.
//!
//! Run (headless, no window is mapped):
//!   cd native/orchestra-gtk && source ../env.sh && cargo run --release --example cell_size_probe
//!
//! Reports cell width/height per candidate font description, so a change can be
//! judged against a measured baseline rather than against intent.

use gtk::prelude::*;
use vte4::TerminalExt;

/// Candidates, measured in one run so the numbers are directly comparable.
/// The first is what shipped; the rest are the arithmetic's suggestions.
const CANDIDATES: &[&str] = &[
    "JetBrains Mono, Orchestra Symbols 11",
    "JetBrains Mono, Orchestra Symbols 10",
    "JetBrains Mono, Orchestra Symbols 9.75",
    "JetBrains Mono, Orchestra Symbols 9.5",
];

/// The renderer's geometry, measured previously with the same method.
/// Printed beside every result so the target is visible in the output rather
/// than living only in the head of whoever ran it.
const ELECTRON_W: f64 = 8.0;
const ELECTRON_H: f64 = 18.0;

fn main() {
    let app = gtk::Application::builder()
        .application_id("dev.orchestra.gtk.cellprobe")
        .flags(gtk::gio::ApplicationFlags::NON_UNIQUE)
        .build();

    app.connect_activate(|app| {
        // A window is required for the widget to be realized and for Pango to
        // resolve a font; it is never presented, so nothing appears on screen.
        let win = gtk::ApplicationWindow::new(app);
        let term = vte4::Terminal::new();
        win.set_child(Some(&term));
        win.set_default_size(800, 600);

        // Registering the app fonts matters: the symbol subset is only
        // reachable by family name once fontconfig knows it, and an unreachable
        // family silently falls back — which is a different bug that already
        // cost this codebase a release.
        orchestra_gtk::terminal::load_app_fonts();

        println!("target (Electron): {ELECTRON_W:.1} x {ELECTRON_H:.1} px per cell\n");
        println!("{:<40} {:>8} {:>8} {:>10}", "font description", "cell w", "cell h", "vs target");

        for desc in CANDIDATES {
            let fd = gtk::pango::FontDescription::from_string(desc);
            term.set_font(Some(&fd));
            // Force a size negotiation so the cell metrics reflect this font.
            term.measure(gtk::Orientation::Horizontal, -1);
            term.measure(gtk::Orientation::Vertical, -1);

            let w = term.char_width() as f64;
            let h = term.char_height() as f64;
            let dw = (w - ELECTRON_W) / ELECTRON_W * 100.0;
            let dh = (h - ELECTRON_H) / ELECTRON_H * 100.0;
            println!("{desc:<40} {w:>8.1} {h:>8.1}   {dw:>+5.1}% {dh:>+5.1}%");
        }

        println!("\nA candidate matching the target on BOTH axes is the answer.");
        println!("If none matches, Pango is rounding and the nearest is the answer —");
        println!("say which, rather than reporting the intended value as achieved.");

        app.quit();
    });

    app.run_with_args::<&str>(&[]);
}
