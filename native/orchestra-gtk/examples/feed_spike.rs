//! ?2026 feed-mode spike (plan §5.2, M2-B2 task 1).
//!
//! Replays a recorded Claude Code PTY log through a VTE terminal in one of
//! two modes and captures frames DURING the replay to detect tearing:
//!
//! - `feed`:  bytes go through `vte_terminal_feed` on a timer, at a chosen
//!   chunk size/cadence (the path the real GTK terminal will use — backend
//!   owns the PTY, frames arrive as ptyData).
//! - `spawn`: a VTE-owned child (`bash replay.sh`) writes the same bytes at
//!   the same cadence to its own PTY (the reference path VTE was built for).
//!
//! Every capture computes an "ink ratio" (fraction of pixels differing from
//! the background). Mode 2026's whole point is atomic screen updates: if the
//! sync frame is honored, a full-screen erase+redraw never paints half-done —
//! ink stays high across captures. If it is NOT honored on the feed path,
//! captures land between `2J` and the redraw and ink collapses ("blank
//! flash"). The harness compares both modes on the same stream.
//!
//! Usage:
//!   feed_spike <feed|spawn> <log> <out-dir> [chunk-bytes] [tick-ms] [cols rows]
//!
//! Prints one line per capture (`capture NNN ink=0.xxxx`) and a final
//! `REPORT min=… median=… dips=…` line; exits when the replay ends.

use std::cell::RefCell;
use std::io::Write as _;
use std::rc::Rc;

use gtk::prelude::*;
use gtk::{gdk, glib};
use vte4::prelude::*;

struct Args {
    mode: String,
    log: std::path::PathBuf,
    out: std::path::PathBuf,
    chunk: usize,
    tick_ms: u64,
    cols: i64,
    rows: i64,
    save_every: u32,
}

fn parse_args() -> Args {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 4 {
        eprintln!("usage: feed_spike <feed|spawn> <log> <out-dir> [chunk] [tick-ms] [cols rows]");
        std::process::exit(2);
    }
    Args {
        mode: a[1].clone(),
        log: a[2].clone().into(),
        out: a[3].clone().into(),
        chunk: a.get(4).and_then(|s| s.parse().ok()).unwrap_or(4096),
        tick_ms: a.get(5).and_then(|s| s.parse().ok()).unwrap_or(8),
        cols: a.get(6).and_then(|s| s.parse().ok()).unwrap_or(120),
        rows: a.get(7).and_then(|s| s.parse().ok()).unwrap_or(40),
        // Save every Nth captured PNG (0/1 = all). Long runs pass e.g. 20 to
        // keep the artifact dir sane; the ink series still covers every frame.
        save_every: a.get(8).and_then(|s| s.parse().ok()).unwrap_or(1),
    }
}

fn make_terminal(cols: i64, rows: i64) -> vte4::Terminal {
    let term = vte4::Terminal::new();
    term.set_font(Some(&gtk::pango::FontDescription::from_string(
        "Monospace 11",
    )));
    term.set_size(cols, rows);
    term.set_scrollback_lines(10_000);
    term.set_cursor_blink_mode(vte4::CursorBlinkMode::Off);
    term.set_hexpand(true);
    term.set_vexpand(true);
    term
}

/// Offscreen widget render (same recipe as remote_control::screenshot_widget)
/// returning the texture for pixel analysis.
fn capture(widget: &gtk::Widget) -> Result<gdk::Texture, String> {
    let (w, h) = (widget.width(), widget.height());
    if w == 0 || h == 0 {
        return Err("widget has zero size".into());
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
    Ok(renderer.render_texture(&node, None))
}

/// Fraction of pixels visibly differing from the corner (background) color.
fn ink_ratio(texture: &gdk::Texture) -> f64 {
    let (w, h) = (texture.width() as usize, texture.height() as usize);
    let mut buf = vec![0u8; w * h * 4];
    texture.download(&mut buf, w * 4);
    let bg = [buf[0], buf[1], buf[2]];
    let ink = buf
        .chunks_exact(4)
        .filter(|px| {
            (px[0] as i32 - bg[0] as i32).abs() > 12
                || (px[1] as i32 - bg[1] as i32).abs() > 12
                || (px[2] as i32 - bg[2] as i32).abs() > 12
        })
        .count();
    ink as f64 / (w * h) as f64
}

struct Session {
    term: vte4::Terminal,
    out: std::path::PathBuf,
    inks: Vec<f64>,
    captures: u32,
    /// How many times VTE actually invalidated itself (queued a redraw) during
    /// the replay — the true "how much did the screen churn" signal, counted
    /// off VTE's `invalidate`/contents-changed rather than a blind timer.
    redraws: u64,
    save_every: u32,
}

impl Session {
    /// Sample the widget's CURRENT committed pixels. Called on the frame-clock
    /// tick (compositor cadence) so what we measure is what a viewer's frame
    /// would show — not an arbitrary mid-parse instant. A torn `?2026` frame is
    /// only *visible* if a frame-clock tick lands on a partial screen state.
    fn capture_now(&mut self) {
        match capture(self.term.upcast_ref()) {
            Ok(tex) => {
                let ink = ink_ratio(&tex);
                // Keep a subset of PNGs as visual evidence (all of them for
                // short runs; every Nth for long ones) — the ink series is the
                // quantitative signal, the PNGs are for a human to eyeball.
                if self.save_every <= 1 || self.captures.is_multiple_of(self.save_every) {
                    let path = self.out.join(format!("frame-{:04}.png", self.captures));
                    let _ = tex.save_to_png(&path);
                }
                println!("capture {:04} ink={ink:.4}", self.captures);
                self.inks.push(ink);
                self.captures += 1;
            }
            Err(e) => eprintln!("capture failed: {e}"),
        }
    }

    /// Blank-flash detection: a frame-clock capture whose ink collapses below
    /// 40% of the max of its neighbors — the signature of a compositor frame
    /// landing on an un-held (torn) erase+redraw. On a stream whose settled
    /// state is inky, honored `?2026` keeps ink high across every tick; an
    /// unhonored one lets a tick fall between `2J` and the redraw -> a dip.
    fn report(&self) {
        let n = self.inks.len();
        let mut sorted = self.inks.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let median = if n == 0 { 0.0 } else { sorted[n / 2] };
        let min = sorted.first().copied().unwrap_or(0.0);
        let max = sorted.last().copied().unwrap_or(0.0);
        let mut dips = 0u32;
        for i in 1..n.saturating_sub(1) {
            let neighbors = self.inks[i - 1].max(self.inks[i + 1]);
            if neighbors > 0.05 && self.inks[i] < neighbors * 0.4 {
                dips += 1;
                println!(
                    "DIP at capture {:04}: ink {:.4} vs neighbors {:.4}",
                    i, self.inks[i], neighbors
                );
            }
        }
        println!(
            "REPORT captures={n} redraws={} min={min:.4} median={median:.4} max={max:.4} dips={dips}",
            self.redraws
        );
    }
}

fn main() -> glib::ExitCode {
    let args = parse_args();
    std::fs::create_dir_all(&args.out).expect("create out dir");
    let app = gtk::Application::builder()
        .application_id("dev.orchestra.feedspike")
        .flags(gtk::gio::ApplicationFlags::NON_UNIQUE)
        .build();

    app.connect_activate(move |app| {
        let term = make_terminal(args.cols, args.rows);
        let window = gtk::ApplicationWindow::builder()
            .application(app)
            .title("feed-spike")
            .default_width(1180)
            .default_height(760)
            .child(&term)
            .build();
        window.present();

        let data = std::fs::read(&args.log).expect("read log");
        let session = Rc::new(RefCell::new(Session {
            term: term.clone(),
            out: args.out.clone(),
            inks: Vec::new(),
            captures: 0,
            redraws: 0,
            save_every: args.save_every,
        }));

        // Count VTE's own repaint churn: `contents-changed` fires whenever the
        // visible grid model changes. This is the feed-vs-spawn "how much did
        // the screen actually thrash" number, independent of our sampling.
        {
            let session = session.clone();
            term.connect_contents_changed(move |_| {
                session.borrow_mut().redraws += 1;
            });
        }

        // Capture cadence: every 16 ms during the replay (~compositor rate).
        // The snapshot forces VTE's `snapshot()` vfunc, which paints its
        // current committed grid; sampling at frame rate approximates what a
        // viewer's compositor frames would show.
        let cap_src = {
            let session = session.clone();
            glib::timeout_add_local(std::time::Duration::from_millis(16), move || {
                session.borrow_mut().capture_now();
                glib::ControlFlow::Continue
            })
        };
        // Shared so `finish` (invoked from feed-break OR child_exited) can be a
        // clonable Fn that removes the capture source exactly once.
        let cap_src = Rc::new(std::cell::Cell::new(Some(cap_src)));
        let finished = Rc::new(std::cell::Cell::new(false));

        let finish = {
            let session = session.clone();
            let app = app.clone();
            let cap_src = cap_src.clone();
            let finished = finished.clone();
            move || {
                if finished.replace(true) {
                    return; // already finishing
                }
                // Let the last frame settle, then final capture + report.
                let session = session.clone();
                let app = app.clone();
                let cap_src = cap_src.clone();
                glib::timeout_add_local_once(std::time::Duration::from_millis(300), move || {
                    if let Some(src) = cap_src.take() {
                        src.remove();
                    }
                    let mut s = session.borrow_mut();
                    s.capture_now();
                    s.report();
                    app.quit();
                });
            }
        };

        // Watchdog: never let a stuck spawn child hang the run. Force finish
        // after a generous ceiling (spawn PTY replays run slower than feed).
        {
            let finish = finish.clone();
            glib::timeout_add_local_once(std::time::Duration::from_secs(90), move || {
                eprintln!("watchdog: max runtime hit, finishing");
                finish();
            });
        }

        match args.mode.as_str() {
            "feed" => {
                let offset = Rc::new(std::cell::Cell::new(0usize));
                let chunk = args.chunk;
                let term = term.clone();
                glib::timeout_add_local(
                    std::time::Duration::from_millis(args.tick_ms),
                    move || {
                        let start = offset.get();
                        if start >= data.len() {
                            finish();
                            return glib::ControlFlow::Break;
                        }
                        let end = (start + chunk).min(data.len());
                        term.feed(&data[start..end]);
                        offset.set(end);
                        glib::ControlFlow::Continue
                    },
                );
            }
            "spawn" => {
                // Write the replayer next to the artifacts. Single-process
                // Python pacer (NOT a per-chunk dd/sleep shell loop, whose
                // subprocess-spawn overhead dwarfs an 8ms tick and makes spawn
                // mode ~15x slower than feed): read once, write chunk, sleep.
                let script = args.out.join("replay.py");
                {
                    let mut f = std::fs::File::create(&script).expect("write replay.py");
                    writeln!(
                        f,
                        "import sys,time,os,termios\n\
                         log,chunk,tick=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])\n\
                         # raw PTY: no OPOST/ONLCR translation of the log bytes\n\
                         fd=sys.stdout.fileno()\n\
                         a=termios.tcgetattr(fd); a[1]&=~termios.OPOST; termios.tcsetattr(fd,termios.TCSANOW,a)\n\
                         d=open(log,'rb').read()\n\
                         o=0\n\
                         while o<len(d):\n\
                         \x20   os.write(fd,d[o:o+chunk]); o+=chunk\n\
                         \x20   time.sleep(tick/1000.0)\n"
                    )
                    .unwrap();
                }
                let term = term.clone();
                let argv = [
                    "/usr/bin/python3",
                    script.to_str().unwrap(),
                    args.log.to_str().unwrap(),
                    &args.chunk.to_string(),
                    &args.tick_ms.to_string(),
                ];
                term.connect_child_exited(move |_, _| finish());
                term.spawn_async(
                    vte4::PtyFlags::DEFAULT,
                    None,
                    &argv,
                    &[],
                    glib::SpawnFlags::DEFAULT,
                    || {},
                    -1,
                    gtk::gio::Cancellable::NONE,
                    |res| {
                        if let Err(e) = res {
                            eprintln!("spawn failed: {e}");
                            std::process::exit(1);
                        }
                    },
                );
            }
            other => {
                eprintln!("unknown mode: {other}");
                std::process::exit(2);
            }
        }
    });

    app.run_with_args::<&str>(&[])
}
