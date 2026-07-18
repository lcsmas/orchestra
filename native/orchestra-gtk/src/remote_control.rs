//! Remote-control harness (plan §8.4) — this project's CDP replacement,
//! compiled in always, activated only by `--remote-control <sock-path>`.
//!
//! Protocol: newline-delimited JSON over a unix socket, one response line per
//! request line. Ops: list_widgets / click / type / key / get / screenshot
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
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
        Op::Get { name, prop } => {
            let Some(w) = find_widget(&name) else {
                return err(format!("no widget named {name:?}"));
            };
            let value = match prop {
                Prop::Visible => json!(w.is_visible()),
                Prop::Css => json!(w
                    .css_classes()
                    .iter()
                    .map(|c| c.to_string())
                    .collect::<Vec<_>>()),
                Prop::Label => {
                    if let Some(win) = w.downcast_ref::<gtk::Window>() {
                        json!(win.title().map(|t| t.to_string()))
                    } else if let Some(label) = w.downcast_ref::<gtk::Label>() {
                        json!(label.text().as_str())
                    } else if let Some(button) = w.downcast_ref::<gtk::Button>() {
                        json!(button.label().map(|l| l.to_string()))
                    } else if let Some(editable) = w.dynamic_cast_ref::<gtk::Editable>() {
                        json!(editable.text().as_str())
                    } else {
                        return err(format!("widget {name:?} has no label-like property"));
                    }
                }
            };
            ok(serde_json::Map::from_iter([("value".into(), value)]))
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
            parse_op(r#"{"op":"screenshot","path":"/tmp/x.png"}"#).unwrap(),
            Op::Screenshot {
                path: "/tmp/x.png".into(),
                name: None
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
