//! Does the grid VTE REPORTS (what we send as the PTY winsize) match the grid
//! actually VISIBLE to the user?
//!
//! The GTK pane wraps its VTE in a GtkScrolledWindow (pane.rs:116). A
//! ScrolledWindow allocates its child the child's NATURAL size, not the
//! viewport size. If VTE's natural width exceeds the viewport, `column_count()`
//! — which pane.rs reports to `ptyResize` — describes a grid WIDER than what is
//! painted. The child then wraps at column N while the user can only see N-k
//! columns, so every wrapped line and every cursor-up erase lands in the wrong
//! place: text overwrites text. That is the reported symptom.
//!
//! ARM A (scrolled): the app's real widget tree.
//! ARM B (direct):   VTE parented straight into the window, as Electron does.
//! Both arms run at the SAME window size, so the only variable is the wrapper.
//!
//! Run: source ../env.sh && cargo run --release --example grid_probe
//! ORCHESTRA_PROBE_DIRECT=1 selects arm B.

use gtk::prelude::*;
use gtk::{glib, pango};
use vte4::prelude::*;

fn main() {
    let app = gtk::Application::builder()
        .application_id("dev.orchestra.grid-probe")
        .build();
    app.connect_activate(|app| {
        let direct = std::env::var("ORCHESTRA_PROBE_DIRECT").is_ok();
        let win = gtk::ApplicationWindow::new(app);
        win.set_default_size(900, 600);

        let term = vte4::Terminal::new();
        term.set_font(Some(&pango::FontDescription::from_string(
            "JetBrains Mono, Orchestra Symbols 11",
        )));
        term.set_hexpand(true);
        term.set_vexpand(true);

        if direct {
            win.set_child(Some(&term));
        } else {
            // EXACTLY the app's wrapper (pane.rs:116-120).
            let scrolled = gtk::ScrolledWindow::builder()
                .hscrollbar_policy(gtk::PolicyType::Never)
                .vscrollbar_policy(gtk::PolicyType::Automatic)
                .child(&term)
                .build();
            win.set_child(Some(&scrolled));
        }
        win.present();

        glib::timeout_add_local_once(std::time::Duration::from_millis(900), move || {
            let arm = if direct { "B direct" } else { "A scrolled" };
            let reported_cols = term.column_count();
            let alloc_w = term.allocated_width();
            let cell_w = term.char_width();
            let cell_h = term.char_height();
            // How many columns actually FIT in the painted allocation.
            let visible_cols = if cell_w > 0 {
                alloc_w as i64 / cell_w
            } else {
                -1
            };
            println!("=== grid probe: ARM {arm} ===");
            println!("window inner width      = {}", win.width());
            println!("VTE allocated width px  = {alloc_w}");
            println!("cell size px            = {cell_w} x {cell_h}");
            println!("column_count() REPORTED = {reported_cols}   <- sent as PTY winsize");
            println!("columns that FIT        = {visible_cols}");
            println!("row_count()             = {}", term.row_count());
            let delta = reported_cols - visible_cols;
            println!("DELTA (reported - fits) = {delta}");
            if delta != 0 {
                println!(
                    "MISMATCH: the PTY is told {reported_cols} cols but only \
                     {visible_cols} are visible -> child wraps off-screen"
                );
            } else {
                println!("ok: reported grid matches the visible grid");
            }
            std::process::exit(0);
        });
    });
    app.run_with_args::<&str>(&[]);
}
