//! Does replaying scrollback make VTE INJECT replies into the live PTY?
//!
//! `open_terminal` (app.rs:244) feeds the raw PTY scrollback log into the pane
//! on first open. Electron deliberately does NOT (Terminal.tsx:366) — the log
//! contains sequences the CHILD sent expecting the TERMINAL to answer (DA1
//! `ESC[c`, XTVERSION `ESC[>0q`; both present in a real 3 MB log).
//!
//! On replay the terminal answers a question nobody asked, and the answer goes
//! to the PTY as if the user had typed it — landing in Claude's input while it
//! is mid-frame.
//!
//! MEASUREMENT: VTE emits terminal replies on its `commit` signal (the same
//! signal pane.rs forwards to `ptyWrite`). Feed the queries; capture commit.
//!
//! CONTROL: feed ordinary text first and assert it does NOT commit — otherwise
//! "commit fired" would be indistinguishable from a noisy signal.

use gtk::prelude::*;
use gtk::{glib, pango};
use std::cell::RefCell;
use std::rc::Rc;
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

fn main() {
    let app = gtk::Application::builder()
        .application_id("dev.orchestra.scrollback-query")
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

        // Capture exactly what pane.rs would forward to ptyWrite.
        let committed: Rc<RefCell<Vec<u8>>> = Rc::new(RefCell::new(Vec::new()));
        {
            let c = committed.clone();
            term.connect_commit(move |_t, text, size| {
                c.borrow_mut()
                    .extend_from_slice(&text.as_bytes()[..size as usize]);
            });
        }

        glib::timeout_add_local_once(std::time::Duration::from_millis(700), move || {
            println!("=== scrollback query-injection probe ===");

            // CONTROL: plain text must NOT produce a commit.
            committed.borrow_mut().clear();
            term.feed(b"\r\nplain scrollback text, no queries\r\n");
            settle(400);
            let control = committed.borrow().clone();
            println!(
                "control: plain text -> commit bytes = {} {:?}",
                control.len(),
                String::from_utf8_lossy(&control)
            );
            if !control.is_empty() {
                println!(
                    "INSTRUMENT FAILURE: plain text already commits; \
                     cannot attribute any reply below to the queries. Void."
                );
                std::process::exit(2);
            }

            // ARM: the queries a real scrollback log actually contains.
            for (label, seq) in [
                ("DA1  ESC[c", &b"\x1b[c"[..]),
                ("XTVERSION ESC[>0q", &b"\x1b[>0q"[..]),
                ("DSR cursor ESC[6n", &b"\x1b[6n"[..]),
            ] {
                committed.borrow_mut().clear();
                term.feed(seq);
                settle(400);
                let got = committed.borrow().clone();
                println!(
                    "{label:<20} -> injected {} bytes: {:?}",
                    got.len(),
                    String::from_utf8_lossy(&got).replace('\u{1b}', "<ESC>")
                );
            }

            println!();
            println!(
                "Any non-zero injection above is a byte the GTK pane would \
                 forward via ptyWrite into the LIVE Claude session on every \
                 first-open scrollback replay. Electron avoids this by not \
                 replaying at all."
            );
            std::process::exit(0);
        });
    });
    app.run_with_args::<&str>(&[]);
}
