//! Does GTK 4.18 actually EASE the CSS properties Electron animates?
//!
//! This exists because "the CSS parsed" is not evidence a property works: GTK4
//! CSS has three outcomes — parser error, works, or PARSES SILENTLY AND DOES
//! NOTHING. The port's hover rules already set background-color/color/
//! border-color (36/26/23 rules); only the `transition` easing is missing. So
//! before adding 40-odd transition declarations we need to know which of those
//! properties GTK will actually interpolate, measured as an OBSERVED
//! DIFFERENCE rather than inferred from the stylesheet.
//!
//! Method: drive the state change by toggling a CSS class (no pointer needed),
//! then sample the widget's rendered colour on successive frame-clock ticks.
//!
//! The verdict rests on intermediate values: a property that EASES paints
//! colours that are neither the start nor the end colour. A property that
//! snaps only ever paints the two endpoints. Both controls are required —
//! the ANIMATED control proves the sampler can see intermediate values at all
//! (without it, every "snaps" verdict is potentially just a blind sampler),
//! and the INSTANT control proves the sampler can return "no intermediates"
//! (without it, every "eases" verdict could be sampling noise).
//!
//! Run: cargo run -p orchestra-gtk --example transition_probe

use gtk::gdk;
use gtk::glib;
use gtk::prelude::*;

/// Each probe: a CSS class pair (base, active) and the property under test.
struct Probe {
    name: &'static str,
    /// The declaration under test, applied with a transition.
    css: &'static str,
    /// The EXACT property to put in the `transition:` shorthand.
    ///
    /// Not `all`. Using `all` made a keyword property (border-style) appear to
    /// ramp, because `all` animates every other property the class touches and
    /// the measured ramp could not be attributed to the property under test.
    /// Naming one property makes each probe a single-variable experiment.
    prop: &'static str,
    /// What we expect: true = should produce intermediate frames.
    expect_eases: Option<bool>,
}

const DURATION_MS: u32 = 400;

fn probes() -> Vec<Probe> {
    vec![
        // --- CONTROLS ---
        // NULL PROBE, and it must run FIRST. The `.active` class sets nothing,
        // so no frame can legitimately differ from any other. If this reports
        // ANY intermediate frame, the sampler is picking up something other
        // than the property under test (frame noise, a blinking cursor, a
        // dirty-region artifact) and EVERY verdict in this run is void.
        //
        // This exists because the first run of this probe reported EASES for
        // all seven probes including a known-inert one. A null probe is the
        // only thing that separates "GTK animates everything" from "the
        // sampler cannot tell frames apart".
        Probe {
            name: "CONTROL-null:no-op",
            css: "/* deliberately empty */",
            prop: "all",
            expect_eases: Some(false),
        },
        // Known-good: opacity is the ONE property the port already animates
        // (.boot-pill), so it is proven to work in this exact GTK build. If
        // this shows no intermediates, the SAMPLER is broken, not the property.
        Probe {
            name: "CONTROL-animated:opacity",
            css: "opacity: 0.15;",
            prop: "opacity",
            expect_eases: Some(true),
        },
        // Known-inert control. `border-style` is a KEYWORD property: there is
        // no continuum between `solid` and `dashed`, so no CSS engine can
        // interpolate it. It must jump.
        //
        // NOTE: border-radius was used here first and FAILED as a control —
        // but re-reading the evidence, its trace showed a smooth decay
        // (0.3749 -> 0.3746 -> 0.0218), which is what interpolation looks
        // like. border-radius IS animatable in GTK4 (an interpolable length),
        // so the CONTROL'S PREMISE was wrong, not the probe. Keeping this note
        // because "the control failed" pointed at the instrument for three
        // iterations when the bug was in my expectation of the control.
        Probe {
            name: "CONTROL-instant:border-style",
            css: "border-style: dashed;",
            prop: "border-style",
            expect_eases: Some(false),
        },
        // --- THE PROPERTIES ELECTRON ANIMATES ---
        Probe { name: "background-color", css: "background-color: rgb(240,60,60);", prop: "background-color", expect_eases: None },
        Probe { name: "color",            css: "color: rgb(240,60,60);",            prop: "color", expect_eases: None },
        Probe { name: "border-color",     css: "border-color: rgb(240,60,60);",     prop: "border-color", expect_eases: None },
        Probe { name: "box-shadow",       css: "box-shadow: 0 0 12px rgb(240,60,60);", prop: "box-shadow", expect_eases: None },
        // Electron animates `transform` 8x. A previous session found `transform`
        // inside a @keyframes block is inert in GTK4 — but a TRANSITION is a
        // different code path, so it must be measured separately rather than
        // assumed to share that verdict.
        Probe { name: "transform",        css: "transform: translateX(40px);",      prop: "transform", expect_eases: None },
        // Three more transform forms. A single negative on translateX would not
        // distinguish "GTK ignores transform" from "GTK ignores THIS transform
        // function" — and Electron uses translateY/rotate/scale, not translateX,
        // so a verdict drawn from translateX alone would not even cover the
        // real usage. Large magnitudes so any effect is unmissable.
        Probe { name: "transform-translateY", css: "transform: translateY(20px);", prop: "transform", expect_eases: None },
        Probe { name: "transform-rotate",     css: "transform: rotate(30deg);",    prop: "transform", expect_eases: None },
        Probe { name: "transform-scale",      css: "transform: scale(1.6);",       prop: "transform", expect_eases: None },
        // Electron writes `background` (the SHORTHAND) in 26 of its 41
        // transition declarations, and times everything with a custom
        // cubic-bezier. Both must be verified in GTK before the port copies
        // them: a shorthand GTK does not accept as a transitionable property,
        // or an easing function it rejects, would parse and do nothing —
        // leaving the port with transitions that silently never run.
        Probe { name: "background-SHORTHAND", css: "background: rgb(240,60,60);", prop: "background", expect_eases: None },
        Probe { name: "cubic-bezier-easing",  css: "background-color: rgb(240,60,60);", prop: "background-color", expect_eases: Some(true) },
    ]
}

fn main() {
    let app = gtk::Application::builder()
        .application_id("dev.orchestra.transition-probe")
        .build();
    app.connect_activate(build);
    // Ignore CLI args; gtk would otherwise try to open them as files.
    app.run_with_args::<&str>(&[]);
}

fn build(app: &gtk::Application) {
    let probes = probes();

    // Each probe gets its own provider so declarations cannot bleed together.
    let win = gtk::ApplicationWindow::builder()
        .application(app)
        .default_width(200)
        .default_height(80)
        .build();

    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    // An OPAQUE backdrop. A translucent parent is the classic way a colour
    // probe reads a correct tint as something else entirely, so the widget
    // under test always sits on a known solid colour.
    root.add_css_class("probe-root");
    let target = gtk::Box::new(gtk::Orientation::Vertical, 0);
    target.set_size_request(120, 40);
    // The compositor tiles this window to the full output, which would stretch
    // the target across ~1600px and drown the measured region in unrelated
    // repaint. Pinning alignment keeps the target at its requested size
    // regardless of how large the window ends up.
    target.set_halign(gtk::Align::Center);
    target.set_valign(gtk::Align::Center);
    target.set_hexpand(false);
    target.set_vexpand(false);
    target.add_css_class("probe-target");
    // A label so `color:` has ink to act on — a colour transition on a widget
    // with no glyphs would measure nothing and read as "does not ease".
    let label = gtk::Label::new(Some("SAMPLE"));
    target.append(&label);
    root.append(&target);
    win.set_child(Some(&root));
    win.present();

    let results = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));

    glib::spawn_future_local(glib::clone!(
        #[strong] win,
        #[strong] target,
        #[strong] results,
        async move {
            // Let the window map and settle before the first probe: GTK layout
            // is deferred to the frame clock, so sampling too early yields
            // empty render nodes that look like a failed transition.
            glib::timeout_future(std::time::Duration::from_millis(600)).await;

            // ASSERT the geometry has STOPPED MOVING before probing. Setting a
            // size is not holding it: the compositor resizes this window after
            // present(), and a resize mid-probe changes the cropped buffer's
            // LENGTH, which the diff reports as a 100% change. That is exactly
            // how the null control failed with endpoint_delta=1.0000 — an
            // instrument artifact that would otherwise read as a real result.
            let mut stable = 0;
            let (mut lw, mut lh) = (0, 0);
            for _ in 0..60 {
                let (w, h) = (target.width(), target.height());
                if w == lw && h == lh && w > 0 {
                    stable += 1;
                    if stable >= 3 {
                        break;
                    }
                } else {
                    stable = 0;
                }
                lw = w;
                lh = h;
                glib::timeout_future(std::time::Duration::from_millis(50)).await;
            }
            if stable < 3 {
                println!("ABORT: target geometry never settled ({lw}x{lh}) — no verdict is trustworthy");
                win.close();
                return;
            }
            println!("geometry settled: target {lw}x{lh}, window {}x{}\n",
                     win.width(), win.height());

            // Warm-up pass, result discarded. The FIRST probe absorbs the
            // window's initial resize settle, which changes the cropped
            // buffer's length mid-probe and yields an INSTRUMENT FAULT. Rather
            // than let that fault land on whichever probe happens to be first
            // (it landed on the null control, whose failure is the loudest
            // possible signal), spend one throwaway pass on it.
            let _ = run_probe(&win, &target, &probes[0]).await;

            for p in probes.iter() {
                let verdict = run_probe(&win, &target, p).await;
                println!("{verdict}");
                results.borrow_mut().push(verdict);
            }

            println!("\n=== SUMMARY ===");
            for r in results.borrow().iter() {
                println!("{r}");
            }
            win.close();
        }
    ));
}

/// Apply the probe's CSS, toggle the class, and sample colours across the
/// transition window. Returns a one-line verdict.
async fn run_probe(win: &gtk::ApplicationWindow, target: &gtk::Box, p: &Probe) -> String {
    let provider = gtk::CssProvider::new();
    // Base state: a known start colour on every axis, so whichever property is
    // under test has a defined "from" value to interpolate away from.
    let css = format!(
        ".probe-root {{ background-color: rgb(20,20,20); }}
         .probe-target {{
             background-color: rgb(30,40,60);
             color: rgb(60,80,120);
             border: 4px solid rgb(30,40,60);
             opacity: 1;
             border-radius: 0px;
             transition: {} {DURATION_MS}ms {};
         }}
         .probe-target.active {{ {} }}",
        p.prop,
        if p.name == "cubic-bezier-easing" { "cubic-bezier(0.3, 0.8, 0.3, 1)" } else { "linear" },
        p.css
    );
    // `load_from_string` is gated behind the v4_12 feature; the workspace pins
    // gtk4 to v4_10, so the unconditional (deprecated-since-4.12) entry point
    // is the one available here.
    #[allow(deprecated)]
    provider.load_from_data(&css);
    let display = gdk::Display::default().expect("display");
    gtk::style_context_add_provider_for_display(
        &display,
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    // Settle in the BASE state before toggling, so the first sample is a true
    // "before" rather than a leftover from the previous probe.
    //
    // A wall-clock sleep is NOT sufficient here and getting this wrong voided
    // an entire run: GTK defers painting to the frame clock, so a `before`
    // grabbed after a plain timeout can still hold the PREVIOUS probe's end
    // state. That made a null probe (which changes nothing) report a 3.2%
    // endpoint delta — a difference with no possible cause in the CSS.
    // Waiting on actual frame ticks is what makes `before` mean "base state".
    target.remove_css_class("active");
    await_frames(win, 3).await;
    glib::timeout_future(std::time::Duration::from_millis(150)).await;
    await_frames(win, 2).await;

    // Pin the crop rect from the SETTLED BASE state, before the toggle.
    let rect = {
        let w = win.width().max(1) as usize;
        let h = win.height().max(1) as usize;
        const PAD: i32 = 60;
        match target.translate_coordinates(win, 0.0, 0.0) {
            Some((tx, ty)) => Some((
                ((tx as i32) - PAD).max(0) as usize,
                ((ty as i32) - PAD).max(0) as usize,
                (((tx as i32) + target.width() + PAD) as usize).min(w),
                (((ty as i32) + target.height() + PAD) as usize).min(h),
            )),
            None => None,
        }
    };
    let before = snapshot_region(win, target.upcast_ref(), rect);

    // Drive the state change. Class toggle, not a pointer: this probe is about
    // whether the ENGINE interpolates, which is independent of what causes the
    // state change, and a class toggle needs no seat.
    target.add_css_class("active");

    // Sample across the transition window. Sampling must finish well before
    // DURATION_MS or a genuinely-easing property would be caught only at its
    // endpoints and misreported as snapping.
    let mut mids = Vec::new();
    for _ in 0..6 {
        glib::timeout_future(std::time::Duration::from_millis(45)).await;
        mids.push(snapshot_region(win, target.upcast_ref(), rect));
    }

    glib::timeout_future(std::time::Duration::from_millis(
        (DURATION_MS as u64) + 250,
    ))
    .await;
    let after = snapshot_region(win, target.upcast_ref(), rect);

    gtk::style_context_remove_provider_for_display(&display, &provider);

    // A frame is "intermediate" if it differs from BOTH endpoints. That is the
    // signature of interpolation; a snapping property only ever shows one of
    // the two endpoint images.
    //
    // Bare byte-inequality is too weak to decide this: a single stray pixel
    // makes a frame "differ" from both endpoints and manufactures a false
    // EASES. So difference is measured as a FRACTION of differing bytes, and a
    // frame must differ from both endpoints by more than NOISE_FLOOR to count.
    const NOISE_FLOOR: f64 = 0.001; // 0.1% of bytes

    // A length mismatch means the widget RESIZED mid-probe, so the two buffers
    // are not comparable at all. Flag it rather than returning a number: a
    // silent 1.0 here is indistinguishable from a real full-surface change and
    // fabricated a false EASES verdict on the null control.
    let mut incomparable = false;
    // MEAN ABSOLUTE CHANNEL DISTANCE, not "fraction of differing pixels".
    //
    // The pixel-count metric cannot tell a BLEND from a STEP, and that is not a
    // tuning problem, it is the wrong quantity: swapping `solid` for `dashed`
    // changes ~37.5% of pixels for the entire duration and then snaps to 0%, so
    // a counting metric sees a large steady "difference" and calls it easing.
    // A known-inert keyword property failed as a control for exactly this
    // reason across three iterations.
    //
    // Interpolation is a statement about VALUES, so the metric must be about
    // values: during a real blend the mean distance to each endpoint moves
    // smoothly from 0 to max, and a mid-transition frame is genuinely partway
    // from both. A stepping property is always AT one endpoint (distance 0).
    let diff = |a: &Vec<u8>, b: &Vec<u8>| -> f64 {
        if a.is_empty() || b.is_empty() || a.len() != b.len() {
            return f64::NAN;
        }
        let sum: u64 = a
            .iter()
            .zip(b.iter())
            .map(|(x, y)| x.abs_diff(*y) as u64)
            .sum();
        sum as f64 / a.len() as f64 / 255.0
    };

    let endpoint_delta = diff(&before, &after);

    // Localise the difference. A verdict built on "some bytes differ" cannot
    // distinguish the property under test from an unrelated repaint elsewhere
    // in the window, so report the bounding box of the differing pixels: if it
    // does not overlap the target box, the probe is measuring the wrong thing.
    let bbox = |a: &Vec<u8>, b: &Vec<u8>| -> String {
        if a.is_empty() || b.is_empty() || a.len() != b.len() {
            return "n/a".into();
        }
        // Region width, not window width: these buffers are cropped.
        let w = rect.map(|(x0,_,x1,_)| x1-x0).unwrap_or(1).max(1);
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0usize, 0usize);
        let mut count = 0usize;
        for i in (0..a.len()).step_by(4) {
            if a[i..i + 4] != b[i..i + 4] {
                let px = (i / 4) % w;
                let py = (i / 4) / w;
                x0 = x0.min(px); y0 = y0.min(py);
                x1 = x1.max(px); y1 = y1.max(py);
                count += 1;
            }
        }
        if count == 0 {
            "none".into()
        } else {
            format!("x{x0}-{x1} y{y0}-{y1} n={count}")
        }
    };
    let endpoint_bbox = bbox(&before, &after);
    let (mut intermediate, mut changed_at_all) = (0, false);
    let mut traces = Vec::new();
    for m in &mids {
        let db = diff(m, &before);
        let da = diff(m, &after);
        if db.is_nan() || da.is_nan() {
            incomparable = true;
        }
        traces.push(format!("{db:.4}/{da:.4}"));
        // Only count as "changed" if the excursion clears the noise floor by a
        // margin; raw jitter otherwise sets this flag and produces the
        // self-contradicting line "property changed" next to endpoint_delta=0.
        if db > NOISE_FLOOR * 3.0 {
            changed_at_all = true;
        }
        // "Differs from both endpoints" is NOT interpolation, and using it as
        // the test made a known-inert keyword property (border-style) report
        // EASES. During a SNAP the widget simply holds the OLD state until it
        // flips, so every pre-flip frame differs from `after` and every
        // post-flip frame differs from `before` — both trivially satisfy that
        // condition without any interpolation happening.
        //
        // Real interpolation means the frame is a BLEND: partway between the
        // two endpoints on both measures. A snapping property's frames always
        // sit AT one endpoint (distance ~0 to one of them). So require the
        // frame to be meaningfully distant from BOTH, as a fraction of the
        // endpoint separation.
        // Guard on the endpoint separation FIRST. When the endpoints are
        // identical the property had no effect at all, and every relative
        // comparison below degenerates (`> 0.0 * 0.15` is true for any
        // jitter), which labelled a property that never moved as EASES —
        // a verdict flatly contradicted by the endpoint_delta printed beside
        // it. No separation, no easing claim.
        let blended = endpoint_delta > NOISE_FLOOR
            && db > endpoint_delta * 0.15
            && da > endpoint_delta * 0.15;
        if blended {
            intermediate += 1;
        }
    }
    if endpoint_delta.is_nan() {
        incomparable = true;
    }
    if endpoint_delta > NOISE_FLOOR {
        changed_at_all = true;
    }

    let eases = intermediate > 0;
    let status = if incomparable {
        "INSTRUMENT FAULT: buffers not comparable (widget resized mid-probe) — NO VERDICT"
    } else if !changed_at_all {
        // The endpoints are identical, so this probe cannot say anything about
        // easing: it never observed the property take effect at all. Reporting
        // "snaps" here would be a verdict the evidence does not support.
        "INERT-OR-NO-EFFECT (endpoints identical — probe cannot judge easing)"
    } else if eases {
        "EASES (intermediate frames observed)"
    } else {
        "SNAPS (property changed, but no intermediate frame)"
    };

    let control_note = match p.expect_eases {
        Some(true) if !eases => "  <<< CONTROL FAILED: sampler cannot see intermediates; every SNAPS verdict below is UNRELIABLE",
        Some(false) if eases => "  <<< CONTROL FAILED: sampler reports easing for a known-inert property; every EASES verdict is UNRELIABLE",
        _ => "",
    };

    // The per-frame trace is printed alongside every verdict so a reader can
    // see the raw evidence rather than trusting the label: the numbers make a
    // broken sampler visible (all-zero or all-huge) where a bare EASES/SNAPS
    // would hide it.
    format!(
        "{:<32} {:<6} inter={}/{} endpoint_delta={:.4} bbox=[{}] frames={} {}{}",
        p.name,
        if eases { "EASES" } else { "SNAPS" },
        intermediate,
        mids.len(),
        endpoint_delta,
        endpoint_bbox,
        traces.join(" "),
        status,
        control_note
    )
}

/// Await `n` frame-clock ticks.
///
/// GTK layout and paint are deferred to the frame clock, so "has the widget
/// actually repainted?" cannot be answered by a wall-clock sleep — only by
/// observing ticks. Used to settle state between probes.
async fn await_frames(win: &gtk::ApplicationWindow, n: usize) {
    for _ in 0..n {
        let (tx, rx) = async_channel::bounded(1);
        let Some(clock) = win.frame_clock() else { return };
        let id = clock.connect_after_paint(move |_| {
            let _ = tx.try_send(());
        });
        clock.request_phase(gdk::FrameClockPhase::AFTER_PAINT);
        // Safety valve: a window that stops producing frames (unmapped,
        // occluded) would otherwise hang the whole probe run indefinitely.
        // The sender is dropped after the ceiling elapses, which closes the
        // channel and releases the recv.
        let guard = tx_guard(rx.clone());
        let _ = rx.recv().await;
        drop(guard);
        clock.disconnect(id);
    }
}

/// Close `rx` after a 500ms ceiling so a stalled frame clock cannot hang the run.
fn tx_guard(rx: async_channel::Receiver<()>) -> glib::SourceId {
    glib::timeout_add_local_once(std::time::Duration::from_millis(500), move || {
        rx.close();
    })
}

/// Render the window and return ONLY the bytes inside the target widget's
/// allocation (plus a small margin for outset effects like box-shadow).
///
/// Two separate reasons this is not a whole-window capture:
///
/// 1. The compositor tiles this window to the full output (1600px), so a
///    whole-window comparison is dominated by chrome and background that have
///    nothing to do with the property under test. Measured: a NULL probe that
///    changes no CSS at all repainted 65,436 pixels spanning the entire window
///    width — swamping any property-specific signal and making every verdict
///    meaningless.
/// 2. It is still a WINDOW render, not a widget render: a widget-scoped
///    snapshot composites against nothing, so translucent fills and shadows
///    misreport. Rendering the window and then CROPPING keeps the opaque
///    backdrop while removing the irrelevant area.
fn snapshot_region(
    win: &gtk::ApplicationWindow,
    target: &gtk::Widget,
    pinned: Option<(usize, usize, usize, usize)>,
) -> Vec<u8> {
    let full = snapshot_pixels(win);
    if full.is_empty() {
        return full;
    }
    let w = win.width().max(1) as usize;
    let h = win.height().max(1) as usize;

    // Target allocation in window coordinates, padded so outset box-shadow is
    // included — a shadow-only change would otherwise fall outside the crop and
    // read as "no effect".
    //
    // Anchored to the widget's position but with a FIXED size, which is the
    // combination that survives a transform.
    //
    // Two failed alternatives, both caught by the controls:
    //  - Following the live allocation: a transform changes the allocation, so
    //    the buffer changed LENGTH mid-probe and translateY/rotate/scale all
    //    came back as INSTRUMENT FAULT (uncomparable), not as results.
    //  - Anchoring to the window centre: the target is centred by LAYOUT, not
    //    at the window's geometric centre, so the crop landed on empty
    //    background and even the known-good opacity control read zero — the
    //    rig reporting, correctly, that it had gone blind.
    //
    // Taking the position once (from the settled base state) and holding the
    // SIZE constant keeps every frame the same shape while still framing the
    // widget, so motion into and out of the box is measurable.
    const PAD: i32 = 60;
    let (x0, y0, x1, y1) = match pinned {
        // The rect is computed ONCE per probe from the settled base state and
        // reused for every frame. Recomputing per frame is what let a
        // transform change the buffer's length mid-probe.
        Some(r) => r,
        None => {
            let Some((tx, ty)) = target.translate_coordinates(win, 0.0, 0.0) else {
                return full;
            };
            let (tw, th) = (target.width(), target.height());
            (
                ((tx as i32) - PAD).max(0) as usize,
                ((ty as i32) - PAD).max(0) as usize,
                (((tx as i32) + tw + PAD) as usize).min(w),
                (((ty as i32) + th + PAD) as usize).min(h),
            )
        }
    };
    let (x1, y1) = (x1.min(w), y1.min(h));
    if x1 <= x0 || y1 <= y0 {
        return Vec::new();
    }

    let mut out = Vec::with_capacity((x1 - x0) * (y1 - y0) * 4);
    for y in y0..y1 {
        let row = y * w * 4;
        out.extend_from_slice(&full[row + x0 * 4..row + x1 * 4]);
    }
    out
}

/// Render the whole window to pixels and return the raw bytes.
fn snapshot_pixels(win: &gtk::ApplicationWindow) -> Vec<u8> {
    let paintable = gtk::WidgetPaintable::new(Some(win));
    let w = win.width().max(1);
    let h = win.height().max(1);
    let snapshot = gtk::Snapshot::new();
    paintable.snapshot(&snapshot, w as f64, h as f64);
    let Some(node) = snapshot.to_node() else {
        return Vec::new();
    };
    let renderer = win.native().and_then(|n| n.renderer());
    let Some(renderer) = renderer else {
        return Vec::new();
    };
    let texture = renderer.render_texture(&node, None);
    let mut buf = vec![0u8; (w * h * 4) as usize];
    texture.download(&mut buf, (w * 4) as usize);
    buf
}
