//! Measure the CELL WIDTH VTE charges for a codepoint, by reading VTE's own
//! cursor arithmetic — the same accounting Claude Code's TUI cursor math must
//! agree with.
//!
//! Method: park the cursor at column 0 with CR, feed exactly one codepoint,
//! read `cursor_position().0`. The delta IS the number of cells VTE charged.
//! This is grid accounting, NOT glyph pixel advance — a font fallback that
//! paints 2.2 cells wide still charges 1 cell here, and it is the CHARGE that
//! desyncs a TUI.
//!
//! Controls (both arms, every run):
//!   U+0041 'A'      expect 1  — probe can report 1 (else every 2 is false)
//!   U+2500 '─'      expect 1  — box-drawing, the glyph Claude's frames are
//!                              built from; a 2 here would wreck every box
//!   U+4E00 '一'     expect 2  — CJK wide, proves the probe CAN report 2
//!                              (else every 1 is a false negative)
//!
//! Run under: source ../env.sh && cargo run --release --example width_probe
//! Needs a display; use the headless-sway recipe.

use gtk::prelude::*;
use gtk::{glib, pango};
use vte4::prelude::*;

/// (label, codepoint string, expected-under-Unicode-11)
/// Expectations are Claude Code's accounting (Ink/string-width, Unicode 11+),
/// which is the model the TUI positions against.
const CASES: &[(&str, &str, i64)] = &[
    // --- controls ---
    ("U+0041 A  (control, narrow)", "A", 1),
    ("U+2500 ─  (control, box-draw)", "\u{2500}", 1),
    ("U+4E00 一 (control, CJK wide)", "\u{4E00}", 2),
    // --- the glyphs Claude Code actually emits in its TUI ---
    ("U+2705 ✅ (emoji, EAW=W)", "\u{2705}", 2),
    ("U+274C ❌ (emoji, EAW=W)", "\u{274C}", 2),
    ("U+2713 ✓  (check, EAW=A)", "\u{2713}", 1),
    ("U+2717 ✗  (ballot, EAW=A)", "\u{2717}", 1),
    ("U+25CF ●  (bullet, EAW=A)", "\u{25CF}", 1),
    ("U+2022 •  (bullet, EAW=A)", "\u{2022}", 1),
    ("U+2460 ①  (circled 1, EAW=A)", "\u{2460}", 1),
    ("U+2192 →  (arrow, EAW=A)", "\u{2192}", 1),
    ("U+23F3 ⏳ (hourglass, EAW=W)", "\u{23F3}", 2),
    ("U+1F914 🤔 (emoji, EAW=W)", "\u{1F914}", 2),
    ("U+256D ╭  (box round, EAW=A)", "\u{256D}", 1),
    ("U+2502 │  (box vert, EAW=A)", "\u{2502}", 1),
];

fn main() {
    let app = gtk::Application::builder()
        .application_id("dev.orchestra.width-probe")
        .build();
    app.connect_activate(|app| {
        let win = gtk::ApplicationWindow::new(app);
        let term = vte4::Terminal::new();
        // EXACTLY the app's font config — width accounting is independent of
        // font, but we measure under the real config so nothing is confounded.
        term.set_font(Some(&pango::FontDescription::from_string(
            "JetBrains Mono, Orchestra Symbols 11",
        )));
        term.set_size(80, 24);
        win.set_child(Some(&term));
        win.present();

        // Let VTE allocate a real grid before probing.
        glib::timeout_add_local_once(std::time::Duration::from_millis(600), move || {
            // A/B arm: ORCHESTRA_PROBE_CJK=2 applies the "obvious fix" so its
            // effect is MEASURED rather than assumed.
            if let Ok(v) = std::env::var("ORCHESTRA_PROBE_CJK") {
                if let Ok(w) = v.parse::<i32>() {
                    term.set_cjk_ambiguous_width(w);
                }
            }
            let cjk = term.cjk_ambiguous_width();
            println!("=== VTE width probe ===");
            println!("cjk_ambiguous_width (as configured) = {cjk}");
            println!("grid = {}x{}", term.column_count(), term.row_count());
            println!();
            println!("{:<34} {:>8} {:>8}  {}", "codepoint", "charged", "expect", "verdict");
            println!("{}", "-".repeat(70));

            let mut mismatches = 0;
            let mut probe_broken = true;
            // VTE's feed() is ASYNCHRONOUS: bytes are queued and parsed on the
            // main loop, so reading cursor_position() straight after feed()
            // samples the grid BEFORE a single byte is processed (every case
            // reads 0 — caught by the CJK control). Pump the main context until
            // the parser has drained.
            let settle = || {
                let ctx = glib::MainContext::default();
                for _ in 0..200 {
                    while ctx.pending() {
                        ctx.iteration(false);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            };

            for (label, s, expect) in CASES {
                term.feed(b"\r");
                settle();
                let before = term.cursor_position().0;
                term.feed(s.as_bytes());
                settle();
                let after = term.cursor_position().0;
                let charged = after - before;
                // If ANY case reports 2, the probe is capable of reporting 2.
                if charged == 2 {
                    probe_broken = false;
                }
                let ok = charged == *expect;
                if !ok {
                    mismatches += 1;
                }
                println!(
                    "{:<34} {:>8} {:>8}  {}",
                    label,
                    charged,
                    expect,
                    if ok { "ok" } else { "MISMATCH" }
                );
            }
            println!();
            // Negative control on the instrument itself: the CJK case MUST
            // charge 2. If nothing ever charged 2, the probe cannot distinguish
            // widths at all and every "1" above is meaningless.
            if probe_broken {
                println!(
                    "INSTRUMENT FAILURE: no case charged 2 cells, including the \
                     U+4E00 CJK control. The probe cannot measure width — \
                     every result above is void."
                );
            } else {
                println!("instrument ok: probe reported both 1 and 2 (controls live)");
            }
            println!("mismatches vs Claude's accounting: {mismatches}");
            std::process::exit(if probe_broken { 2 } else { 0 });
        });
    });
    // Do not let GTK eat our argv.
    app.run_with_args::<&str>(&[]);
}
