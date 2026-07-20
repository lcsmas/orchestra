//! Remote-control harness (plan §8.4) — this project's CDP replacement,
//! compiled in always, activated only by `--remote-control <sock-path>`.
//!
//! Protocol: newline-delimited JSON over a unix socket, one response line per
//! request line. Ops: list_widgets / click / type / key / get / measure /
//! screenshot (get supports label/visible/css/font)
//! (see `Op`). Every meaningful widget carries a `widget_name`, and lookups
//! walk ALL toplevels so dialogs are reachable too.
//!
//! Events are synthesized GTK-side (button `emit_clicked`, row selection,
//! the dialogs' dlg.* actions) — NOT via the compositor: headless sway's
//! seat advertises no pointer/keyboard, so compositor-level input never
//! reaches the client (the prototype hit this; it's why this harness exists).
//!
//! Everything runs on the GTK main context via `glib::spawn_future_local`,
//! so touching widgets from the connection handler is safe by construction.

use gtk::gio;
use gtk::glib;
use gtk::prelude::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

// No `Eq`: `Scroll.to` is an f64 (a scroll offset is fractional), and f64 is
// not Eq. Nothing compares an Op with `==`; the parse tests use `matches!`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Full widget-name tree of every toplevel window.
    ListWidgets,
    /// Synthesize a click: Button::emit_clicked, ListBoxRow selection+activate,
    /// MenuButton popup, else Widget::activate.
    Click {
        name: String,
    },
    /// Insert text into the named Editable, or the focus widget if no name.
    Type {
        text: String,
        #[serde(default)]
        name: Option<String>,
    },
    /// Synthesize a key. Supported: "Escape" (cancels the topmost dialog),
    /// "Return"/"Enter" (confirms it, else activates the window default).
    Key {
        name: String,
    },
    Get {
        name: String,
        prop: Prop,
    },
    /// Report the named widget's size-negotiation numbers: MINIMUM and NATURAL
    /// width, plus its current allocation.
    ///
    /// Allocation alone cannot explain a layout floor — it tells you how wide a
    /// widget ENDED UP, not how narrow it was willing to be. A GtkPaned with
    /// `shrink_start_child(false)` clamps its position to the start child's
    /// MINIMUM, so that minimum is the number that decides the sidebar width,
    /// and nothing in the harness could read it. Two hypotheses about this
    /// sidebar died against allocation-only evidence before this op existed.
    Measure {
        name: String,
    },
    /// Report the named widget's bounds IN MAIN-WINDOW COORDINATES.
    ///
    /// `Measure` answers "how wide", never "where" — and a whole-window region
    /// diff needs WHERE, because it crops regions out of one composited window
    /// frame rather than snapshotting each widget. That distinction is not
    /// cosmetic: a widget-scoped snapshot renders OFFSCREEN over nothing, so a
    /// translucent fill composites against transparent black and a correct
    /// low-alpha tint reads as a solid slab (this produced, and had retracted,
    /// an "88.8% dominance" finding in M4). Cropping the real window frame
    /// reads what the compositor actually painted, which is what a user sees.
    ///
    /// Returns 0x0 for a widget that exists but has never been allocated —
    /// deliberately NOT an error, because "present but painting nothing" is a
    /// distinct and more interesting finding than "absent", and collapsing the
    /// two would hide exactly the permanently-invisible-widget class of defect.
    Bounds {
        name: String,
    },
    /// Activate a `group.action` on the named widget (or the main window if no
    /// widget is named), with an optional string parameter. This drives
    /// affordances that have no clickable widget under headless CI — chiefly
    /// the sidebar's `sidebar.drop-ws` / `sidebar.drop-repo` reorder actions,
    /// which stand in for pointer drag-and-drop the seatless compositor can't
    /// synthesize.
    Action {
        /// Fully-qualified `group.name`, e.g. "sidebar.drop-ws".
        action: String,
        #[serde(default)]
        param: Option<String>,
        #[serde(default)]
        name: Option<String>,
    },
    /// Read or set the vertical scroll offset of the ScrolledWindow that
    /// contains (or is) the named widget. Scroll position is an INTERACTION
    /// state: no still screenshot can show it, so verifying "the list did not
    /// jump to the top when a repo collapsed" is impossible without reading the
    /// adjustment as a number. Returns `value`, `upper` and `page_size` so a
    /// caller can tell "offset 0" (jumped) from "nothing was scrollable"
    /// (vacuously 0) — those are indistinguishable from the value alone, and
    /// the second would pass a broken app.
    Scroll {
        name: String,
        /// Absent → read only.
        #[serde(default)]
        to: Option<f64>,
    },
    /// Render the named widget offscreen via WidgetPaintable → GSK
    /// render_texture → PNG (no name: the topmost open dialog, else the main
    /// window). Works without a visible frame, which is exactly what
    /// headless CI needs.
    Screenshot {
        path: String,
        #[serde(default)]
        name: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Prop {
    Label,
    Visible,
    Css,
    /// The RESOLVED font of a text widget: family, size in px, weight, style
    /// and letter-spacing, read back from Pango AFTER the CSS cascade.
    ///
    /// Reading `theme.css` cannot answer this. A rule can be outranked, can
    /// name a family that is not installed (fontconfig silently substitutes),
    /// or can omit `font-family` entirely — in which case the widget inherits
    /// the gtk-font-name SETTING, which appears in no stylesheet at all. All
    /// three produce a rendered face that no amount of source reading reveals,
    /// and the third is exactly how the port ended up on a different typeface
    /// from Electron with no selector conflict to show for it.
    ///
    /// So this asks Pango what it will actually shape with: the widget's own
    /// PangoContext, whose description GTK populates from the resolved style.
    /// Sizes come back in Pango units (1024ths) and are converted to px here so
    /// the number is directly comparable to Electron's getComputedStyle.
    Font,
}

pub fn parse_op(line: &str) -> Result<Op, serde_json::Error> {
    serde_json::from_str(line)
}

fn ok(mut extra: serde_json::Map<String, Value>) -> Value {
    extra.insert("ok".into(), Value::Bool(true));
    Value::Object(extra)
}

fn err(message: impl std::fmt::Display) -> Value {
    json!({ "ok": false, "error": message.to_string() })
}

/// Bind the harness socket and serve connections forever on the GTK main
/// context. Call once, after the main window exists.
pub fn serve(sock_path: PathBuf) {
    let _ = std::fs::remove_file(&sock_path);
    let listener = gio::SocketListener::new();
    let addr = gio::UnixSocketAddress::new(&sock_path);
    if let Err(e) = listener.add_address(
        &addr,
        gio::SocketType::Stream,
        gio::SocketProtocol::Default,
        None::<&glib::Object>,
    ) {
        eprintln!("[remote-control] cannot bind {}: {e}", sock_path.display());
        return;
    }
    eprintln!("[remote-control] listening on {}", sock_path.display());

    glib::spawn_future_local(async move {
        loop {
            match listener.accept_future().await {
                Ok((conn, _)) => {
                    glib::spawn_future_local(handle_connection(conn));
                }
                Err(e) => {
                    eprintln!("[remote-control] accept failed: {e}");
                    break;
                }
            }
        }
    });
}

async fn handle_connection(conn: gio::SocketConnection) {
    let input = gio::DataInputStream::new(&conn.input_stream());
    let output = conn.output_stream();
    loop {
        let line = match input.read_line_utf8_future(glib::Priority::DEFAULT).await {
            Ok(Some(line)) => line,
            Ok(None) => break, // EOF
            Err(e) => {
                eprintln!("[remote-control] read error: {e}");
                break;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let response = match parse_op(line) {
            // Screenshots wait for a frame-clock tick first: a structural
            // rebuild leaves layout pending, and snapshotting the same turn
            // yields an empty render node under headless CI.
            Ok(op @ Op::Screenshot { .. }) => {
                await_frame().await;
                handle_op(op)
            }
            Ok(op) => handle_op(op),
            Err(e) => err(format!("bad request: {e}")),
        };
        let mut bytes = response.to_string().into_bytes();
        bytes.push(b'\n');
        if let Err(e) = output
            .write_all_future(bytes, glib::Priority::DEFAULT)
            .await
        {
            eprintln!("[remote-control] write error: {e:?}");
            break;
        }
    }
}

/// Await one frame-clock tick on the main window so a pending relayout is
/// flushed before a screenshot. Falls back to a short timeout if the window
/// has no frame clock yet (never realized), so this can't hang the connection.
async fn await_frame() {
    let Some(win) = main_window() else { return };
    let (tx, rx) = async_channel::bounded::<()>(1);
    // Two ticks: the first schedules layout, the second paints it.
    let count = std::rc::Rc::new(std::cell::Cell::new(0u8));
    let tx2 = tx.clone();
    win.add_tick_callback(move |_, _| {
        let n = count.get() + 1;
        count.set(n);
        if n >= 2 {
            let _ = tx2.try_send(());
            glib::ControlFlow::Break
        } else {
            glib::ControlFlow::Continue
        }
    });
    // Safety valve: don't wait forever if the frame clock is idle.
    glib::timeout_add_local_once(std::time::Duration::from_millis(200), move || {
        let _ = tx.try_send(());
    });
    let _ = rx.recv().await;
}

// ---- widget-tree plumbing ---------------------------------------------------

fn toplevels() -> Vec<gtk::Window> {
    let list = gtk::Window::toplevels();
    let mut out = Vec::new();
    for i in 0..list.n_items() {
        if let Some(win) = list.item(i).and_downcast::<gtk::Window>() {
            out.push(win);
        }
    }
    out
}

fn main_window() -> Option<gtk::Window> {
    let all = toplevels();
    all.iter()
        .find(|w| w.widget_name() == "main-window")
        .or(all.first())
        .cloned()
}

fn children_of(widget: &gtk::Widget) -> Vec<gtk::Widget> {
    let mut out = Vec::new();
    let mut child = widget.first_child();
    while let Some(c) = child {
        child = c.next_sibling();
        out.push(c);
    }
    out
}

/// Depth-first lookup across all toplevels. A `#N` suffix selects the Nth
/// (0-based) match — needed for anonymous widgets like menu items, whose
/// widget_name is just the GType name ("GtkModelButton#2").
fn find_widget(name: &str) -> Option<gtk::Widget> {
    let (name, index) = match name.rsplit_once('#') {
        Some((base, n)) => match n.parse::<usize>() {
            Ok(n) => (base, n),
            Err(_) => (name, 0),
        },
        None => (name, 0),
    };
    fn walk(w: gtk::Widget, name: &str, remaining: &mut usize, out: &mut Option<gtk::Widget>) {
        if out.is_some() {
            return;
        }
        if w.widget_name() == name {
            if *remaining == 0 {
                *out = Some(w);
                return;
            }
            *remaining -= 1;
        }
        for c in children_of(&w) {
            walk(c, name, remaining, out);
        }
    }
    let mut remaining = index;
    let mut out = None;
    for win in toplevels() {
        walk(win.upcast(), name, &mut remaining, &mut out);
        if out.is_some() {
            break;
        }
    }
    out
}

fn widget_tree(w: &gtk::Widget) -> Value {
    let children: Vec<Value> = children_of(w).iter().map(widget_tree).collect();
    let mut node = serde_json::Map::new();
    // widget_name falls back to the GType name when unset, so unnamed
    // structural widgets still show up meaningfully in the tree.
    node.insert("name".into(), json!(w.widget_name().as_str()));
    node.insert("type".into(), json!(w.type_().name()));
    node.insert("visible".into(), json!(w.is_visible()));
    if !children.is_empty() {
        node.insert("children".into(), Value::Array(children));
    }
    Value::Object(node)
}

// ---- op execution -----------------------------------------------------------

fn handle_op(op: Op) -> Value {
    match op {
        Op::ListWidgets => {
            let widgets: Vec<Value> = toplevels()
                .iter()
                .map(|w| widget_tree(w.upcast_ref()))
                .collect();
            ok(serde_json::Map::from_iter([(
                "widgets".into(),
                Value::Array(widgets),
            )]))
        }
        Op::Click { name } => {
            let Some(w) = find_widget(&name) else {
                return err(format!("no widget named {name:?}"));
            };
            if let Some(button) = w.downcast_ref::<gtk::Button>() {
                button.emit_clicked();
            } else if let Some(menu_button) = w.downcast_ref::<gtk::MenuButton>() {
                menu_button.popup();
            } else if let Some(row) = w.downcast_ref::<gtk::ListBoxRow>() {
                if let Some(list) = row.parent().and_downcast::<gtk::ListBox>() {
                    list.select_row(Some(row));
                }
                row.activate();
            } else if !w.activate() {
                return err(format!("widget {name:?} is not activatable"));
            }
            ok(Default::default())
        }
        Op::Type { text, name } => {
            let target = match &name {
                Some(n) => find_widget(n),
                None => main_window().and_then(|w| GtkWindowExt::focus(&w)),
            };
            let Some(target) = target else {
                return err("no target widget (name it or focus an editable first)");
            };
            let Some(editable) = target.dynamic_cast_ref::<gtk::Editable>() else {
                return err(format!("widget {:?} is not editable", target.widget_name()));
            };
            editable.grab_focus();
            let mut pos = editable.position();
            editable.insert_text(&text, &mut pos);
            editable.set_position(pos);
            ok(Default::default())
        }
        Op::Key { name } => {
            let handled = match name.as_str() {
                "Escape" => crate::dialogs::cancel_topmost(),
                "Return" | "Enter" => {
                    crate::dialogs::confirm_topmost()
                        || main_window()
                            .map(|w| {
                                w.activate_default();
                                true
                            })
                            .unwrap_or(false)
                }
                other => return err(format!("unsupported key {other:?} (Escape/Return only)")),
            };
            ok(serde_json::Map::from_iter([(
                "handled".into(),
                json!(handled),
            )]))
        }
        Op::Action {
            action,
            param,
            name,
        } => {
            // Resolve the widget that carries the action group (a named widget,
            // else the main window — actions bubble up the widget tree, so a
            // group installed on the sidebar root is reachable from either).
            let target: Option<gtk::Widget> = match &name {
                Some(n) => find_widget(n),
                None => main_window().map(|w| w.upcast()),
            };
            let Some(target) = target else {
                return err("no widget to activate the action on");
            };
            let variant = param.map(|p| p.to_variant());
            match target.activate_action(&action, variant.as_ref()) {
                Ok(()) => ok(Default::default()),
                Err(e) => err(format!("action {action:?} failed: {e}")),
            }
        }
        Op::Get { name, prop } => {
            let Some(w) = find_widget(&name) else {
                return err(format!("no widget named {name:?}"));
            };
            let value = match prop {
                // For a GtkRevealer, `is_visible()` is ALWAYS true — the widget
                // exists; what changes is whether its child is revealed. Asking
                // "is the banner visible?" and getting an unconditional true is
                // an answer that looks like evidence and constrains nothing, so
                // revealers report their reveal state instead.
                Prop::Visible => match w.downcast_ref::<gtk::Revealer>() {
                    // `reveals_child()` is the INTENT (has it been asked to
                    // show?), which is what a caller means. Deliberately not
                    // OR'd with `is_child_revealed()`: that stays true through
                    // the hide animation, so a probe taken right after an
                    // attach would report a banner still showing when the app
                    // has already dismissed it — a transient read masquerading
                    // as state.
                    Some(r) => json!(r.reveals_child()),
                    None => json!(w.is_visible()),
                },
                Prop::Css => json!(w
                    .css_classes()
                    .iter()
                    .map(|c| c.to_string())
                    .collect::<Vec<_>>()),
                Prop::Font => {
                    // pango_context() carries the style GTK resolved for THIS
                    // widget, so an inherited size and a locally-set one are
                    // both reported as what will be shaped.
                    let ctx = w.pango_context();
                    let desc = ctx.font_description();
                    let Some(desc) = desc else {
                        return err(format!("widget {name:?} has no font description"));
                    };
                    // Pango stores size in 1024ths; absolute-size descriptions
                    // (what GTK CSS px produces) are already device units,
                    // whereas point sizes must be scaled by the resolution.
                    // Report both the px figure and which path produced it,
                    // because a caller comparing against a CSS px value needs
                    // to know it is not silently reading points.
                    let size_is_absolute = desc.is_size_absolute();
                    // GTK CSS `font-size: Npx` yields an ABSOLUTE description,
                    // so size/SCALE is already device px. A point-sized
                    // description would need the context resolution to convert,
                    // and rather than assume 96dpi (which would silently emit a
                    // plausible wrong number for the one case this cannot
                    // handle), `size_is_absolute` is reported alongside so a
                    // caller can reject the value instead of comparing it to
                    // Electron's px figure as though the units matched.
                    let size_px = desc.size() as f64 / gtk::pango::SCALE as f64;
                    // NOTE: letter-spacing is deliberately NOT reported here.
                    // It lives on Pango attributes, not the font description,
                    // and there is no widget-level getter that reflects the
                    // CSS-resolved value — so any number this op could cheaply
                    // produce would be a constant 0, indistinguishable from
                    // "the role sets no tracking" and wrong for the roles that
                    // do. Compare letter-spacing from the stylesheet instead,
                    // and treat that as READ rather than measured.
                    // `desc.family()` is the DECLARED STACK ("Inter,Adwaita
                    // Sans,…"), not the face that will paint — the same
                    // request-vs-result gap getComputedStyle has on the
                    // Electron side. Loading the description through the
                    // context's font map resolves it the way rendering will,
                    // so the caller learns which family actually won.
                    let resolved_family = ctx
                        .load_font(&desc)
                        .map(|font| font.describe())
                        .and_then(|d| d.family())
                        .map(|f| f.to_string());
                    json!({
                        "resolved_family": resolved_family,
                        "family": desc.family().map(|f| f.to_string()),
                        "size_px": (size_px * 100.0).round() / 100.0,
                        "size_is_absolute": size_is_absolute,
                        "weight": format!("{:?}", desc.weight()),
                        "style": format!("{:?}", desc.style()),
                        "stretch": format!("{:?}", desc.stretch()),
                    })
                }
                Prop::Label => {
                    if let Some(win) = w.downcast_ref::<gtk::Window>() {
                        json!(win.title().map(|t| t.to_string()))
                    } else if let Some(label) = w.downcast_ref::<gtk::Label>() {
                        json!(label.text().as_str())
                    } else if let Some(button) = w.downcast_ref::<gtk::Button>() {
                        json!(button.label().map(|l| l.to_string()))
                    } else if let Some(editable) = w.dynamic_cast_ref::<gtk::Editable>() {
                        json!(editable.text().as_str())
                    } else if let Some(view) = w.downcast_ref::<gtk::TextView>() {
                        // A TextView is NOT a GtkEditable, so without this arm
                        // its content is unreadable to the harness — which is
                        // every multi-line editor in the app (the repo-scripts
                        // modal's setup/run/archive fields). Additive: no
                        // existing arm changes behaviour.
                        let b = view.buffer();
                        json!(b.text(&b.start_iter(), &b.end_iter(), false).as_str())
                    } else {
                        return err(format!("widget {name:?} has no label-like property"));
                    }
                }
            };
            ok(serde_json::Map::from_iter([("value".into(), value)]))
        }
        Op::Scroll { name, to } => {
            let Some(w) = find_widget(&name) else {
                return err(format!("no widget named {name:?}"));
            };
            // The caller names the widget it knows (the ListBox); the
            // adjustment lives on the ScrolledWindow ancestor. Walk up rather
            // than making every caller know the container's name.
            let mut node = Some(w.clone());
            let sw = loop {
                match node {
                    Some(n) => {
                        if let Some(sw) = n.downcast_ref::<gtk::ScrolledWindow>() {
                            break Some(sw.clone());
                        }
                        node = n.parent();
                    }
                    None => break None,
                }
            };
            let Some(sw) = sw else {
                return err(format!("widget {name:?} is not inside a ScrolledWindow"));
            };
            let adj = sw.vadjustment();
            if let Some(v) = to {
                adj.set_value(v);
            }
            ok(serde_json::Map::from_iter([
                ("value".into(), json!(adj.value())),
                ("upper".into(), json!(adj.upper())),
                ("page_size".into(), json!(adj.page_size())),
            ]))
        }
        Op::Measure { name } => {
            let Some(w) = find_widget(&name) else {
                return err(format!("no widget named {name:?}"));
            };
            let (min, nat, _, _) = w.measure(gtk::Orientation::Horizontal, -1);
            ok(serde_json::Map::from_iter([
                ("min_width".into(), json!(min)),
                ("nat_width".into(), json!(nat)),
                ("alloc_width".into(), json!(w.width())),
            ]))
        }
        Op::Bounds { name } => {
            let Some(w) = find_widget(&name) else {
                return err(format!("no widget named {name:?}"));
            };
            let Some(win) = main_window() else {
                return err("no main window");
            };
            // compute_bounds maps the widget's own box into the window's
            // coordinate space, which is the space the frame capture is in.
            // It returns None when the widget is not currently allocated —
            // reported below as an explicit 0x0 rather than an error.
            let (x, y, width, height) = match w.compute_bounds(win.upcast_ref::<gtk::Widget>()) {
                Some(r) => (r.x(), r.y(), r.width(), r.height()),
                None => (0.0, 0.0, 0.0, 0.0),
            };
            ok(serde_json::Map::from_iter([
                ("x".into(), json!(x)),
                ("y".into(), json!(y)),
                ("width".into(), json!(width)),
                ("height".into(), json!(height)),
                ("allocated".into(), json!(w.width() > 0 && w.height() > 0)),
            ]))
        }
        Op::Screenshot { path, name } => {
            // Named targets resolve across ALL toplevels (dialogs included).
            // With no name, prefer the topmost open dialog: dialogs are their
            // own toplevel surfaces, so a main-window capture never shows a
            // modal — "screenshot what I just opened" must work without the
            // caller knowing the dialog's widget name.
            let target: Option<gtk::Widget> = match &name {
                Some(n) => find_widget(n),
                None => crate::dialogs::topmost()
                    .map(|w| w.upcast())
                    .or_else(|| main_window().map(|w| w.upcast())),
            };
            let Some(target) = target else {
                return err("no widget to screenshot");
            };
            match screenshot_widget(&target, &path) {
                Ok((w, h)) => ok(serde_json::Map::from_iter([
                    ("path".into(), json!(path)),
                    ("width".into(), json!(w)),
                    ("height".into(), json!(h)),
                ])),
                Err(e) => err(e),
            }
        }
    }
}

fn screenshot_widget(widget: &gtk::Widget, path: &str) -> Result<(i32, i32), String> {
    // A structural rebuild (the sidebar detaches + re-appends its rows) leaves
    // a pending relayout; snapshotting in the same main-loop turn yields an
    // empty render node. Drain pending main-context work first so the tree is
    // laid out before we snapshot — this is the headless equivalent of waiting
    // a frame.
    let ctx = glib::MainContext::default();
    let mut guard = 0;
    while ctx.pending() && guard < 10_000 {
        ctx.iteration(false);
        guard += 1;
    }

    let (w, h) = (widget.width(), widget.height());
    if w == 0 || h == 0 {
        return Err("widget has zero size (not mapped yet?)".into());
    }
    let paintable = gtk::WidgetPaintable::new(Some(widget));
    let snapshot = gtk::Snapshot::new();
    paintable.snapshot(&snapshot, w as f64, h as f64);
    let node = snapshot
        .to_node()
        .ok_or("widget produced an empty render node")?;
    let renderer = widget
        .native()
        .ok_or("widget has no native ancestor (window not realized?)")?
        .renderer()
        .ok_or("no GSK renderer")?;
    let texture = renderer.render_texture(&node, None);
    texture.save_to_png(path).map_err(|e| e.to_string())?;
    Ok((w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_op() {
        assert_eq!(
            parse_op(r#"{"op":"list_widgets"}"#).unwrap(),
            Op::ListWidgets
        );
        assert_eq!(
            parse_op(r#"{"op":"click","name":"dialog-confirm"}"#).unwrap(),
            Op::Click {
                name: "dialog-confirm".into()
            }
        );
        assert_eq!(
            parse_op(r#"{"op":"type","text":"hi"}"#).unwrap(),
            Op::Type {
                text: "hi".into(),
                name: None
            }
        );
        assert_eq!(
            parse_op(r#"{"op":"type","text":"hi","name":"dialog-entry"}"#).unwrap(),
            Op::Type {
                text: "hi".into(),
                name: Some("dialog-entry".into())
            }
        );
        assert_eq!(
            parse_op(r#"{"op":"key","name":"Escape"}"#).unwrap(),
            Op::Key {
                name: "Escape".into()
            }
        );
        assert_eq!(
            parse_op(r#"{"op":"get","name":"main-window","prop":"label"}"#).unwrap(),
            Op::Get {
                name: "main-window".into(),
                prop: Prop::Label
            }
        );
        assert_eq!(
            parse_op(r#"{"op":"measure","name":"sidebar"}"#).unwrap(),
            Op::Measure {
                name: "sidebar".into()
            }
        );
        assert_eq!(
            parse_op(r#"{"op":"bounds","name":"main-area"}"#).unwrap(),
            Op::Bounds {
                name: "main-area".into()
            }
        );
        assert_eq!(
            parse_op(r#"{"op":"screenshot","path":"/tmp/x.png"}"#).unwrap(),
            Op::Screenshot {
                path: "/tmp/x.png".into(),
                name: None
            }
        );
        assert_eq!(
            parse_op(r#"{"op":"action","action":"sidebar.drop-ws","param":"a|b|before"}"#).unwrap(),
            Op::Action {
                action: "sidebar.drop-ws".into(),
                param: Some("a|b|before".into()),
                name: None,
            }
        );
    }

    #[test]
    fn rejects_unknown_op_and_missing_fields() {
        assert!(parse_op(r#"{"op":"drag"}"#).is_err());
        assert!(parse_op(r#"{"op":"click"}"#).is_err());
        assert!(parse_op(r#"{"op":"get","name":"x","prop":"width"}"#).is_err());
        assert!(parse_op("not json").is_err());
    }

    #[test]
    fn response_builders_shape() {
        assert_eq!(err("boom"), json!({"ok": false, "error": "boom"}));
        let v = ok(serde_json::Map::from_iter([("value".into(), json!(3))]));
        assert_eq!(v, json!({"ok": true, "value": 3}));
    }
}
