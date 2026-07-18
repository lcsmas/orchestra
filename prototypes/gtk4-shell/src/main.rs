// Exploratory GTK4 + Relm4 + VTE port of Orchestra's shell.
// Scope: sidebar of workspaces (real store.json data) with status dots, a
// VTE terminal per workspace spawned in its worktree, switchable via a
// GtkStack. Styling approximates src/renderer/styles.css. NOT production code.

use std::collections::HashMap;

use gtk::gdk;
use gtk::glib;
use gtk::pango;
use gtk::prelude::*;
use relm4::prelude::*;
use serde::Deserialize;
use vte4::prelude::*;

// ---- Orchestra store.json (subset we care about) ---------------------------

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct StoreWorkspace {
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    worktree_path: String,
    #[serde(default)]
    archived: bool,
}

#[derive(Deserialize)]
struct Store {
    workspaces: Vec<StoreWorkspace>,
}

fn load_workspaces() -> Vec<StoreWorkspace> {
    let path = std::env::var("ORCHESTRA_STORE").unwrap_or_else(|_| {
        format!(
            "{}/.config/orchestra/orchestra/store.json",
            std::env::var("HOME").unwrap_or_default()
        )
    });
    let parsed = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Store>(&s).ok());
    match parsed {
        Some(store) => {
            let mut ws: Vec<_> = store
                .workspaces
                .into_iter()
                .filter(|w| !w.archived && !w.worktree_path.is_empty())
                .collect();
            // Running agents first, like the real sidebar's activity ordering.
            ws.sort_by_key(|w| match w.status.as_str() {
                "running" => 0,
                "waiting" => 1,
                "error" => 2,
                _ => 3,
            });
            ws
        }
        None => {
            eprintln!("[proto] no readable store.json at {path}; using fixtures");
            ["fixture · alpha", "fixture · beta", "fixture · gamma"]
                .iter()
                .enumerate()
                .map(|(i, n)| StoreWorkspace {
                    name: n.to_string(),
                    status: ["running", "waiting", "idle"][i].to_string(),
                    worktree_path: std::env::var("HOME").unwrap_or_default(),
                    archived: false,
                })
                .collect()
        }
    }
}

// ---- Colors (approximating src/renderer/styles.css) -------------------------

const CSS: &str = "
window { background-color: #0b0d10; }
.sidebar { background-color: #12151a; }
.sidebar-title { color: #8b95a7; font-weight: 700; font-size: 11px; padding: 12px 14px 6px 14px; }
listbox { background: transparent; }
listbox row { padding: 7px 12px; border-radius: 8px; margin: 1px 6px; }
listbox row:hover { background-color: #1a1f26; }
listbox row:selected, list row:selected { background-color: #222933; outline: none; }
list row:selected label { color: #e6e9ef; }
.ws-name { color: #e6e9ef; font-size: 13px; }
.ws-path { color: #8b95a7; font-size: 10px; }
.ws-dot { min-width: 9px; min-height: 9px; border-radius: 5px; }
.ws-dot.running { background-color: #5bd68b; }
.ws-dot.waiting { background-color: #ffc857; }
.ws-dot.error   { background-color: #ff6b6b; }
.ws-dot.idle    { background-color: #8b95a7; opacity: 0.55; }
.ws-dot.stopped { background-color: #555555; opacity: 0.6; }
.term-holder { background-color: #0b0d10; }
.empty-hint { color: #8b95a7; font-size: 14px; }
separator { background-color: #242a33; }
";

fn rgba(hex: &str) -> gdk::RGBA {
    hex.parse().expect("bad hex color")
}

fn term_palette() -> [gdk::RGBA; 16] {
    [
        rgba("#0b0d10"), rgba("#ff6b6b"), rgba("#5bd68b"), rgba("#ffc857"),
        rgba("#6ea8ff"), rgba("#c792ea"), rgba("#7fdbca"), rgba("#e6e9ef"),
        rgba("#333b47"), rgba("#ff8f8f"), rgba("#7fe3a8"), rgba("#ffd77e"),
        rgba("#8fbcff"), rgba("#d7b3f0"), rgba("#a3ebdd"), rgba("#ffffff"),
    ]
}

// ---- Relm4 app ---------------------------------------------------------------

struct App {
    workspaces: Vec<StoreWorkspace>,
    // Lazily-created VTE terminals, one per selected workspace (stretch goal:
    // switchable sessions). GTK objects are refcounted handles; keeping them in
    // the model is the pragmatic escape hatch from the declarative view! layer.
    terminals: HashMap<usize, vte4::Terminal>,
    stack: gtk::Stack,
}

#[derive(Debug)]
enum Msg {
    Select(usize),
}

fn make_terminal(ws: &StoreWorkspace) -> vte4::Terminal {
    let term = vte4::Terminal::new();
    term.set_font(Some(&pango::FontDescription::from_string(
        "JetBrains Mono 11",
    )));
    let palette = term_palette();
    let palette_refs: Vec<&gdk::RGBA> = palette.iter().collect();
    term.set_colors(
        Some(&rgba("#e6e9ef")),
        Some(&rgba("#0b0d10")),
        &palette_refs,
    );
    term.set_scrollback_lines(10_000);
    term.set_hexpand(true);
    term.set_vexpand(true);

    let shell = std::env::var("ORCH_GTK_CMD")
        .or_else(|_| std::env::var("SHELL"))
        .unwrap_or_else(|_| "/bin/bash".into());
    let cwd = if std::path::Path::new(&ws.worktree_path).is_dir() {
        ws.worktree_path.clone()
    } else {
        std::env::var("HOME").unwrap_or_else(|_| "/".into())
    };
    let name = ws.name.clone();
    let shell_for_log = shell.clone();
    term.spawn_async(
        vte4::PtyFlags::DEFAULT,
        Some(&cwd),
        &[&shell],
        &[],
        glib::SpawnFlags::DEFAULT,
        || {},
        -1,
        gtk::gio::Cancellable::NONE,
        move |res| match res {
            Ok(pid) => eprintln!("[proto] spawned {shell_for_log} (pid {pid:?}) for {name}"),
            Err(e) => eprintln!("[proto] spawn failed for {name}: {e}"),
        },
    );
    term
}

#[relm4::component]
impl SimpleComponent for App {
    type Init = Vec<StoreWorkspace>;
    type Input = Msg;
    type Output = ();

    view! {
        gtk::ApplicationWindow {
            set_title: Some("Orchestra — GTK4 prototype"),
            set_default_size: (1280, 800),

            gtk::Paned {
                set_orientation: gtk::Orientation::Horizontal,
                set_position: 280,
                set_shrink_start_child: false,

                #[wrap(Some)]
                set_start_child = &gtk::Box {
                    set_orientation: gtk::Orientation::Vertical,
                    add_css_class: "sidebar",
                    set_width_request: 220,

                    gtk::Label {
                        set_label: "WORKSPACES",
                        set_xalign: 0.0,
                        add_css_class: "sidebar-title",
                    },

                    gtk::ScrolledWindow {
                        set_vexpand: true,
                        set_hscrollbar_policy: gtk::PolicyType::Never,

                        #[name = "list"]
                        gtk::ListBox {
                            set_selection_mode: gtk::SelectionMode::Single,
                            connect_row_selected[sender] => move |_, row| {
                                if let Some(row) = row {
                                    sender.input(Msg::Select(row.index() as usize));
                                }
                            },
                        },
                    },
                },

                #[wrap(Some)]
                set_end_child = &gtk::Box {
                    add_css_class: "term-holder",

                    #[name = "stack"]
                    gtk::Stack {
                        set_hexpand: true,
                        set_vexpand: true,
                        set_transition_type: gtk::StackTransitionType::Crossfade,
                        set_transition_duration: 120,

                        add_named[Some("empty")] = &gtk::Label {
                            set_label: "Select a workspace to open a terminal in its worktree",
                            add_css_class: "empty-hint",
                        },
                    },
                },
            },
        }
    }

    fn init(
        workspaces: Self::Init,
        root: Self::Root,
        sender: ComponentSender<Self>,
    ) -> ComponentParts<Self> {
        let widgets = view_output!();

        // Sidebar rows are built imperatively: a Relm4 factory would be the
        // idiomatic way for a live-updating list, but for a static snapshot
        // plain gtk-rs is shorter and shows the escape hatch cost.
        for ws in &workspaces {
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
            dot.add_css_class("ws-dot");
            dot.add_css_class(if ws.status.is_empty() { "idle" } else { &ws.status });
            dot.set_valign(gtk::Align::Center);
            let col = gtk::Box::new(gtk::Orientation::Vertical, 1);
            let name = gtk::Label::new(Some(&ws.name));
            name.set_xalign(0.0);
            name.set_ellipsize(pango::EllipsizeMode::End);
            name.add_css_class("ws-name");
            let path = gtk::Label::new(
                std::path::Path::new(&ws.worktree_path)
                    .file_name()
                    .and_then(|s| s.to_str()),
            );
            path.set_xalign(0.0);
            path.set_ellipsize(pango::EllipsizeMode::End);
            path.add_css_class("ws-path");
            col.append(&name);
            col.append(&path);
            row.append(&dot);
            row.append(&col);
            widgets.list.append(&row);
        }

        // Auto-open the first workspace so the window is never an empty shell.
        if let Some(row) = widgets.list.row_at_index(0) {
            widgets.list.select_row(Some(&row));
        }

        // Headless-testing hook: ORCH_GTK_AUTOCYCLE=<n> selects row n at t+3s
        // and returns to row 0 at t+6s, driving the same row-selected path a
        // real click does (the headless sway seat has no pointer device, so
        // synthetic compositor clicks never reach the client).
        if let Ok(n) = std::env::var("ORCH_GTK_AUTOCYCLE").map(|v| v.parse::<i32>().unwrap_or(1)) {
            let list = widgets.list.clone();
            glib::timeout_add_seconds_local_once(3, move || {
                if let Some(r) = list.row_at_index(n) {
                    list.select_row(Some(&r));
                }
            });
            let list = widgets.list.clone();
            glib::timeout_add_seconds_local_once(6, move || {
                if let Some(r) = list.row_at_index(0) {
                    list.select_row(Some(&r));
                }
            });
        }

        let model = App {
            workspaces,
            terminals: HashMap::new(),
            stack: widgets.stack.clone(),
        };
        ComponentParts { model, widgets }
    }

    fn update(&mut self, msg: Self::Input, _sender: ComponentSender<Self>) {
        match msg {
            Msg::Select(idx) => {
                let Some(ws) = self.workspaces.get(idx) else { return };
                let page_name = format!("ws-{idx}");
                if !self.terminals.contains_key(&idx) {
                    let term = make_terminal(ws);
                    let scrolled = gtk::ScrolledWindow::new();
                    scrolled.set_child(Some(&term));
                    self.stack.add_named(&scrolled, Some(&page_name));
                    self.terminals.insert(idx, term);
                }
                self.stack.set_visible_child_name(&page_name);
                if let Some(term) = self.terminals.get(&idx) {
                    term.grab_focus();
                }
            }
        }
    }
}

fn main() {
    let app = RelmApp::new("dev.orchestra.gtk4proto");
    relm4::set_global_css(CSS);
    app.run::<App>(load_workspaces());
}
