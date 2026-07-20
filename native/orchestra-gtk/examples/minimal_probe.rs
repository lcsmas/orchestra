//! Minimal isolation: feed the SAME first 64 KiB of a real log, once as a
//! single feed() and once as two halves, and read the grid after each.
//!
//! This strips the replay probe down to its one unexplained behaviour: the
//! split arm read 0 non-blank rows even on its FIRST chunk, which is a plain
//! prefix of what the whole arm feeds. Something about how the rig reads
//! (not about cutting inside 2026 frames) is producing the blank.

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

fn nonblank(term: &vte4::Terminal) -> usize {
    let (text, _) = term.text_range_format(
        vte4::Format::Text,
        0,
        0,
        term.row_count(),
        term.column_count(),
    );
    text.map(|s| s.to_string())
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count()
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: minimal_probe <log>");
    let app = gtk::Application::builder()
        .application_id("dev.orchestra.minimal-probe")
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
            let tail = &all[all.len().saturating_sub(524288)..];
            let n = 65536.min(tail.len());
            let prefix = &tail[..n];

            println!("=== minimal probe: same {n} bytes, one feed vs two ===");

            term.reset(true, true);
            settle(300);
            println!("after reset, before any feed : {}", nonblank(&term));

            term.feed(prefix);
            settle(600);
            println!("ONE feed({n})            : {}", nonblank(&term));

            term.reset(true, true);
            settle(300);
            let mid = n / 2;
            term.feed(&prefix[..mid]);
            settle(600);
            println!("TWO feeds, after first half  : {}", nonblank(&term));
            term.feed(&prefix[mid..]);
            settle(600);
            println!("TWO feeds, after second half : {}", nonblank(&term));

            std::process::exit(0);
        });
    });
    app.run_with_args::<&str>(&[]);
}
