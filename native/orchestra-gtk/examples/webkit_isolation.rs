//! WebKitGTK OAuth-window isolation proof (plan §5.4 verifier evidence).
//!
//! Opens the per-account login windows for TWO fake accounts against a benign
//! https page, then asserts each account got its OWN persistent partition dir
//! on disk under `$ORCHESTRA_HOME/gtk-login-partitions/<id>` — the whole point
//! of the WebKit substitution (a system browser would reuse one cookie jar and
//! authorize the wrong account). Screenshots each window as visible evidence.
//!
//! Run under a display (headless sway) via scripts/smoke-webkit.sh. The
//! claude.ai consent POST carries attestation and always 400s for automated
//! clicks — we never drive it; the window/navigation/isolation is the proof,
//! the final human click is the documented manual step.
//!
//! Exits 0 on success, 1 on any failed assertion.

use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gtk::glib;
use gtk::prelude::*;

use orchestra_gtk::accounts::login_web::LoginWebManager;
use orchestra_gtk::state;

fn partition_dir(id: &str) -> PathBuf {
    state::orchestra_home()
        .join("gtk-login-partitions")
        .join(id)
}

fn main() {
    let art = std::env::var("ORCH_WEBKIT_ART").unwrap_or_else(|_| "/tmp".into());

    let app = gtk::Application::builder()
        .application_id("dev.orchestra.gtk.webkit-isolation")
        .build();

    let art = Rc::new(art);
    app.connect_activate(move |app| {
        let art = art.clone();
        // A hidden parent to satisfy transient_for.
        let parent = gtk::ApplicationWindow::builder()
            .application(app)
            .default_width(10)
            .default_height(10)
            .build();
        parent.present();

        let mgr = Rc::new(LoginWebManager::default());

        // Two accounts, a benign https target (no claude.ai consent needed).
        mgr.open(
            parent.upcast_ref(),
            "acct-alpha",
            "https://example.com/",
            "alpha",
        );
        mgr.open(
            parent.upcast_ref(),
            "acct-beta",
            "https://example.org/",
            "beta",
        );

        // Give WebKit a beat to create its NetworkSession dirs + first paint,
        // then assert isolation + screenshot + quit.
        let app = app.clone();
        glib::timeout_add_local_once(Duration::from_millis(2500), move || {
            let mut ok = true;

            let alpha = partition_dir("acct-alpha");
            let beta = partition_dir("acct-beta");
            for (label, dir) in [("alpha", &alpha), ("beta", &beta)] {
                let data = dir.join("data");
                let exists = data.is_dir();
                println!(
                    "  {} partition {}: {}",
                    if exists { "ok  " } else { "FAIL" },
                    label,
                    data.display()
                );
                ok &= exists;
            }
            let distinct = alpha != beta;
            println!(
                "  {} two accounts → two distinct partition dirs",
                if distinct { "ok  " } else { "FAIL" }
            );
            ok &= distinct;

            // Screenshot each login window as evidence.
            for (id, name) in [("acct-alpha", "alpha"), ("acct-beta", "beta")] {
                let win_name = format!("account-login-web-window-{id}");
                if let Some(win) = find_toplevel(&win_name) {
                    let path = format!("{art}/webkit-{name}.png");
                    match screenshot(&win.upcast(), &path) {
                        Ok(()) => println!("  ok   screenshot {name}: {path}"),
                        Err(e) => println!("  info screenshot {name} skipped: {e}"),
                    }
                } else {
                    println!("  FAIL login window for {name} not found");
                    ok = false;
                }
            }

            if ok {
                println!("PASS — webkit isolation");
                app.quit();
            } else {
                eprintln!("FAIL — webkit isolation");
                std::process::exit(1);
            }
        });
    });

    // Run without taking over argv (the harness passes none anyway).
    let empty: [String; 0] = [];
    app.run_with_args(&empty);
}

fn find_toplevel(name: &str) -> Option<gtk::Window> {
    let list = gtk::Window::toplevels();
    for i in 0..list.n_items() {
        if let Some(win) = list.item(i).and_downcast::<gtk::Window>() {
            if win.widget_name() == name {
                return Some(win);
            }
        }
    }
    None
}

fn screenshot(widget: &gtk::Widget, path: &str) -> Result<(), String> {
    let (w, h) = (widget.width(), widget.height());
    if w == 0 || h == 0 {
        return Err("zero size (not mapped)".into());
    }
    let paintable = gtk::WidgetPaintable::new(Some(widget));
    let snapshot = gtk::Snapshot::new();
    paintable.snapshot(&snapshot, w as f64, h as f64);
    let node = snapshot.to_node().ok_or("empty render node")?;
    let renderer = widget
        .native()
        .ok_or("no native ancestor")?
        .renderer()
        .ok_or("no GSK renderer")?;
    renderer
        .render_texture(&node, None)
        .save_to_png(path)
        .map_err(|e| e.to_string())
}
