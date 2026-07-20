//! Does VTE RECOVER when a feed() is split mid-escape-sequence?
//!
//! The minimal probe showed the same 64 KiB rendering 35 rows as one feed() and
//! 0 rows as two — with the cut landing inside `ESC[38;2;...m`. Two very
//! different explanations produce that:
//!
//!   (a) VTE correctly holds the partial sequence and resumes when the rest
//!       arrives. Then a 0 after BOTH halves means my READBACK is wrong, and
//!       the app is fine.
//!   (b) VTE loses grid content across the split. Then this is a real bug.
//!
//! Discriminator: feed a SELF-CONTAINED, verifiable payload (not a log tail,
//! whose content depends on scroll position) split at a KNOWN-hostile point,
//! and check the exact expected text.
//!
//! CONTROLS, both arms:
//!   - unsplit  : the payload in one feed() must read back (else readback broken)
//!   - split at a benign boundary (between complete sequences)
//!   - split INSIDE an SGR escape sequence  <- the hostile case

use gtk::prelude::*;
use gtk::{glib, pango};
use vte4::prelude::*;

fn settle(ms: u64) {
    let ctx = glib::MainContext::default();
    for _ in 0..ms {
        while ctx.pending() {
            ctx.iteration(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

fn screen(term: &vte4::Terminal) -> String {
    let (text, _) = term.text_range_format(
        vte4::Format::Text,
        0,
        0,
        term.row_count(),
        term.column_count(),
    );
    text.map(|s| s.to_string()).unwrap_or_default()
}

/// Feed `payload` split at `cut` (0 = no split) and report whether MARKER is on
/// the grid afterwards.
fn run(term: &vte4::Terminal, label: &str, payload: &[u8], cut: usize) -> bool {
    term.reset(true, true);
    settle(200);
    if cut == 0 {
        term.feed(payload);
    } else {
        term.feed(&payload[..cut]);
        settle(300);
        term.feed(&payload[cut..]);
    }
    settle(500);
    let s = screen(term);
    let found = s.contains("ALPHA") && s.contains("OMEGA");
    println!(
        "{label:<46} ALPHA+OMEGA present = {found}{}",
        if found { "" } else { "   <-- CONTENT LOST" }
    );
    found
}

fn main() {
    let app = gtk::Application::builder()
        .application_id("dev.orchestra.split-recovery")
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

        glib::timeout_add_local_once(std::time::Duration::from_millis(700), move |
        | {
            // ALPHA <SGR colour> OMEGA — both words must survive every arm.
            let sgr = b"\x1b[38;2;177;185;249m";
            let mut payload = Vec::new();
            payload.extend_from_slice(b"\r\nALPHA ");
            payload.extend_from_slice(sgr);
            payload.extend_from_slice(b"OMEGA\x1b[39m\r\n");

            // Offset of the SGR introducer, so we can cut INSIDE it.
            let sgr_at = b"\r\nALPHA ".len();
            let inside_sgr = sgr_at + 6; // mid "\x1b[38;2;..."

            println!("=== split-recovery probe (VTE {} ) ===", "0.80.5");
            println!("payload = {:?}", String::from_utf8_lossy(&payload));
            println!();

            let c_unsplit = run(&term, "control: unsplit (readback works?)", &payload, 0);
            if !c_unsplit {
                println!(
                    "\nINSTRUMENT FAILURE: cannot read back an unsplit payload; \
                     every result below is void."
                );
                std::process::exit(2);
            }
            let c_benign = run(
                &term,
                "split at a BENIGN boundary (before ESC)",
                &payload,
                sgr_at,
            );
            let c_hostile = run(
                &term,
                "split INSIDE the SGR escape sequence",
                &payload,
                inside_sgr,
            );

            println!();
            if c_benign && c_hostile {
                println!(
                    "VERDICT: VTE RECOVERS from a mid-sequence split — content survives. \
                     The replay probe's blank grid was a RIG artifact (readback/\
                     scroll position), NOT terminal corruption."
                );
            } else {
                println!(
                    "VERDICT: VTE LOSES CONTENT across a split feed \
                     (benign_ok={c_benign} hostile_ok={c_hostile}). \
                     Feed-splitting is a REAL defect on the GTK path."
                );
            }
            std::process::exit(0);
        });
    });
    app.run_with_args::<&str>(&[]);
}
