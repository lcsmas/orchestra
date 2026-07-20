//! END-TO-END: does feeding a REAL Claude Code stream the way the GTK pane
//! feeds it produce a different grid than feeding it whole?
//!
//! Both arms feed the SAME bytes to the SAME VTE and end at the SAME point in
//! the stream. The ONLY variable is where the byte stream is CUT:
//!
//!   ARM WHOLE  — one feed() of everything. The frame-atomic reference: no cut
//!                can ever fall inside a synchronized-output frame.
//!   ARM SPLIT  — cut at the backend's real flush boundaries (8 ms / 64 KiB,
//!                pty.ts:93), which 95.7% of the time fall INSIDE an open 2026
//!                frame, with a main-loop turn between chunks so VTE can paint
//!                and settle the partial frame exactly as it does live.
//!
//! RESULT (2026-07-20, VTE 0.80.5): THIS PROBE'S COMPARISON IS NOT SOUND, and
//! its own guard says so — keep it only as a cautionary rig.
//!
//! It reported "35 of 48 rows differ", which reads as dramatic proof that
//! mid-frame cuts corrupt the grid. They do not. The split arm's grid came back
//! ENTIRELY BLANK — including the prompt — which is the signature of a broken
//! rig, not of corruption (real corruption garbles text, it does not blank
//! every row). Tracing showed 0 rows after the FIRST chunk, which is a plain
//! prefix of what the whole arm feeds, so no cut had even happened yet: the
//! arms were never comparable (the log tail scrolls different amounts off a
//! 48-row grid depending on chunking).
//!
//! `split_recovery_probe` settles the actual question on a self-contained
//! payload with controls: VTE RECOVERS from split feeds, including splits
//! inside an escape sequence. The 2026 lead is disproved as a grid-corruption
//! cause.
//!
//! Usage: replay_probe <log-path> [byte-limit]

use gtk::prelude::*;
use gtk::{glib, pango};
use vte4::prelude::*;

const OPEN: &[u8] = b"\x1b[?2026h";
const CLOSE: &[u8] = b"\x1b[?2026l";
/// pty.ts:93 FLUSH_BYTES.
const FLUSH: usize = 64 * 1024;

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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .get(1)
        .cloned()
        .expect("usage: replay_probe <log-path> [byte-limit]");
    let limit: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(512 * 1024);

    let app = gtk::Application::builder()
        .application_id("dev.orchestra.replay-probe")
        .build();
    app.connect_activate(move |app| {
        let path = path.clone();
        let win = gtk::ApplicationWindow::new(app);
        let term = vte4::Terminal::new();
        term.set_font(Some(&pango::FontDescription::from_string(
            "JetBrains Mono, Orchestra Symbols 11",
        )));
        term.set_size(177, 48);
        win.set_child(Some(&term));
        win.present();

        glib::timeout_add_local_once(std::time::Duration::from_millis(700), move || {
            let all = std::fs::read(&path).expect("read log");
            // Take the LAST `limit` bytes: the tail is live TUI frames, whereas
            // the head is session boot. Start at a frame OPEN so both arms
            // begin from the same parser state.
            let start = all.len().saturating_sub(limit);
            let data = &all[start..];
            let first_open = data
                .windows(OPEN.len())
                .position(|w| w == OPEN)
                .unwrap_or(0);
            let data = &data[first_open..];

            println!("=== replay probe ===");
            println!("log   = {path}");
            println!("bytes = {} (from first frame open)", data.len());
            let frames = data.windows(OPEN.len()).filter(|w| *w == OPEN).count();
            println!("2026 frames in slice = {frames}");
            if frames == 0 {
                println!("INSTRUMENT FAILURE: no frames in slice; arms cannot differ. Void.");
                std::process::exit(2);
            }

            // --- ARM WHOLE ---
            term.reset(true, true);
            settle(50);
            term.feed(data);
            settle(400);
            let whole = screen(&term);

            // --- ARM SPLIT ---
            term.reset(true, true);
            settle(50);
            let mut cuts_in_frame = 0usize;
            let mut in_frame = false;
            let mut i = 0usize;
            while i < data.len() {
                let mut end = (i + FLUSH).min(data.len());
                // The backend buffers DECODED text (`s.outBuf` is a JS string,
                // pty.ts:193), so a real flush can never cut mid-UTF-8. Cutting
                // at a raw byte offset splits multi-byte glyphs and blanks the
                // whole grid — an artifact of the RIG that looks exactly like a
                // spectacular app bug. Advance to a char boundary to reproduce
                // what the backend actually does.
                while end < data.len() && (data[end] & 0xC0) == 0x80 {
                    end += 1;
                }
                let chunk = &data[i..end];
                // Track frame state across the chunk to report how many cuts
                // actually fell inside an open frame.
                let mut j = i;
                while j < end {
                    if data[j..].starts_with(OPEN) {
                        in_frame = true;
                    } else if data[j..].starts_with(CLOSE) {
                        in_frame = false;
                    }
                    j += 1;
                }
                term.feed(chunk);
                if std::env::var("ORCHESTRA_PROBE_TRACE").is_ok() {
                    settle(400);
                    let nb = screen(&term).lines().filter(|l| !l.trim().is_empty()).count();
                    println!(
                        "  [trace] after chunk {}..{} ({} B): non-blank rows = {nb}",
                        i,
                        end,
                        end - i
                    );
                }
                // A real main-loop turn between flushes — VTE paints here.
                // ORCHESTRA_PROBE_NOSETTLE isolates whether the inter-chunk
                // main-loop turn (rather than the CUT itself) drives any
                // difference between the arms.
                if std::env::var("ORCHESTRA_PROBE_NOSETTLE").is_err() {
                    settle(12);
                }
                if end < data.len() && in_frame {
                    cuts_in_frame += 1;
                }
                i = end;
            }
            settle(400);
            let split = screen(&term);

            // INSTRUMENT AUDIT. A uniformly EMPTY split grid is the signature of
            // a broken rig, not of corruption: real corruption garbles text, it
            // does not blank every row including the prompt. Fail loudly rather
            // than reporting a spectacular false positive.
            let split_nonblank = split.lines().filter(|l| !l.trim().is_empty()).count();
            let whole_nonblank = whole.lines().filter(|l| !l.trim().is_empty()).count();
            println!("non-blank rows: whole={whole_nonblank} split={split_nonblank}");
            if whole_nonblank > 0 && split_nonblank == 0 {
                println!(
                    "INSTRUMENT FAILURE: the split arm's grid is entirely blank while \
                     the whole arm has {whole_nonblank} non-blank rows. That is a rig \
                     artifact (the arms are not comparable), NOT evidence of \
                     corruption. Every row-diff below would be void."
                );
                std::process::exit(2);
            }

            println!("chunk cuts landing inside an open frame = {cuts_in_frame}");
            println!();
            if whole == split {
                println!("VERDICT: grids IDENTICAL — mid-frame cuts did NOT corrupt the grid.");
                println!("  => the 2026 lead is DISPROVED as a grid-corruption cause.");
            } else {
                let wl: Vec<&str> = whole.lines().collect();
                let sl: Vec<&str> = split.lines().collect();
                let diff = wl
                    .iter()
                    .zip(sl.iter())
                    .filter(|(a, b)| a.trim_end() != b.trim_end())
                    .count();
                println!(
                    "VERDICT: grids DIFFER — {diff} of {} compared rows differ.",
                    wl.len().min(sl.len())
                );
                println!("  => cutting inside a 2026 frame CORRUPTS THE GRID.");
                for (n, (a, b)) in wl.iter().zip(sl.iter()).enumerate() {
                    if a.trim_end() != b.trim_end() {
                        println!("  row {n}:");
                        println!("    whole: {:?}", a.trim_end());
                        println!("    split: {:?}", b.trim_end());
                    }
                }
            }
            std::process::exit(0);
        });
    });
    app.run_with_args::<&str>(&[]);
}
