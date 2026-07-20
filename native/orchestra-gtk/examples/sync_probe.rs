//! Does this VTE honour DEC private mode 2026 (synchronized output)?
//!
//! WHY IT MATTERS: the backend unconditionally sets
//! CLAUDE_CODE_FORCE_SYNC_OUTPUT=1 (pty.ts:262), so Claude Code wraps every TUI
//! redraw in \x1b[?2026h … \x1b[?2026l and trusts the terminal not to paint a
//! half-built frame. Electron does NOT get this from xterm.js (which ignores
//! 2026); it synthesises the atomicity in term-write-queue.ts by never cutting
//! a drain slice inside an open frame. The GTK frontend has no equivalent, so
//! either VTE implements 2026 itself or GTK is unprotected.
//!
//! METHOD — behavioural, not a symbol grep. A terminal that IMPLEMENTS 2026
//! defers applying buffered content until the close marker. So:
//!   open frame, write text, read the grid   -> implemented ? text ABSENT
//!   close frame, read the grid              -> text now PRESENT
//! A terminal that IGNORES 2026 shows the text immediately at step 1.
//!
//! CONTROL (the same write with NO markers) proves the readback can see text
//! at all — without it, "text absent" is indistinguishable from a broken
//! reader and would falsely look like working 2026 support.
//!
//! Run: source ../env.sh && cargo run --release --example sync_probe

use gtk::prelude::*;
use gtk::{glib, pango};
use vte4::prelude::*;

fn settle() {
    let ctx = glib::MainContext::default();
    for _ in 0..300 {
        while ctx.pending() {
            ctx.iteration(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

/// Whole-screen text as VTE currently has it.
fn screen(term: &vte4::Terminal) -> String {
    let (text, _len) = term.text_range_format(
        vte4::Format::Text,
        0,
        0,
        term.row_count(),
        term.column_count(),
    );
    text.map(|s| s.to_string()).unwrap_or_default()
}

fn main() {
    let app = gtk::Application::builder()
        .application_id("dev.orchestra.sync-probe")
        .build();
    app.connect_activate(|app| {
        let win = gtk::ApplicationWindow::new(app);
        let term = vte4::Terminal::new();
        term.set_font(Some(&pango::FontDescription::from_string(
            "JetBrains Mono, Orchestra Symbols 11",
        )));
        term.set_size(80, 24);
        win.set_child(Some(&term));
        win.present();

        glib::timeout_add_local_once(std::time::Duration::from_millis(700), move || {
            println!("=== VTE synchronized-output (DEC 2026) probe ===");

            // --- CONTROL: no markers. Proves the reader can see written text.
            term.reset(true, true);
            settle();
            term.feed(b"\r\nCONTROL_VISIBLE\r\n");
            settle();
            let control_ok = screen(&term).contains("CONTROL_VISIBLE");
            println!("control (plain write is readable) = {control_ok}");
            if !control_ok {
                println!(
                    "INSTRUMENT FAILURE: cannot read back plain text; \
                     every result below is void."
                );
                std::process::exit(2);
            }

            // --- ARM: inside an OPEN 2026 frame.
            term.reset(true, true);
            settle();
            term.feed(b"\x1b[?2026h");
            settle();
            term.feed(b"\r\nINSIDE_OPEN_FRAME\r\n");
            settle();
            let visible_while_open = screen(&term).contains("INSIDE_OPEN_FRAME");

            term.feed(b"\x1b[?2026l");
            settle();
            let visible_after_close = screen(&term).contains("INSIDE_OPEN_FRAME");

            println!("text visible while frame OPEN    = {visible_while_open}");
            println!("text visible after frame CLOSED  = {visible_after_close}");
            println!();
            if visible_while_open {
                println!(
                    "VERDICT: VTE IGNORES mode 2026 — content is applied \
                     immediately inside an open frame."
                );
                println!(
                    "  => Claude Code is told (CLAUDE_CODE_FORCE_SYNC_OUTPUT=1) that \
                     frames are atomic, but nothing on the GTK path provides that \
                     atomicity. Electron provides it in term-write-queue.ts."
                );
            } else if visible_after_close {
                println!(
                    "VERDICT: VTE IMPLEMENTS mode 2026 — content was deferred \
                     until the close marker. GTK needs no write queue."
                );
            } else {
                println!("VERDICT: INCONCLUSIVE — text never appeared even after close.");
            }
            std::process::exit(0);
        });
    });
    app.run_with_args::<&str>(&[]);
}
