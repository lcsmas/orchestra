//! Kept-alive terminal stack (plan §5.2): one [`TerminalPane`] per workspace in
//! a `GtkStack`, so scrollback survives tab switches. Routes `ptyData` frames
//! to the matching pane, lazily builds a pane on first activation, and bounces a
//! repaint when a pane is shown again.

use std::collections::HashMap;
use std::rc::Rc;

use gtk::prelude::*;

use super::pane::{PaneIntent, PaneKind, TerminalPane};

pub struct TerminalStack {
    stack: gtk::Stack,
    panes: HashMap<String, TerminalPane>,
    /// Sink handed to every pane so their intents reach the App.
    sink: Rc<dyn Fn(PaneIntent)>,
    active: Option<String>,
}

impl TerminalStack {
    /// `sink` receives every pane's [`PaneIntent`] (the App owns the backend and
    /// performs the RPC).
    pub fn new(sink: Rc<dyn Fn(PaneIntent)>) -> Self {
        let stack = gtk::Stack::new();
        stack.set_widget_name("terminal-stack");
        stack.set_hexpand(true);
        stack.set_vexpand(true);
        // No cross-fade: terminals should snap, and a transition would animate
        // a fed-but-hidden pane's first frame.
        stack.set_transition_type(gtk::StackTransitionType::None);
        TerminalStack {
            stack,
            panes: HashMap::new(),
            sink,
            active: None,
        }
    }

    /// The `GtkStack` to mount in the main area.
    pub fn widget(&self) -> &gtk::Widget {
        self.stack.upcast_ref()
    }

    /// Whether no pane exists yet for `id` (so the caller seeds scrollback and
    /// the pill exactly once, on first open).
    pub fn is_new(&self, id: &str) -> bool {
        !self.panes.contains_key(id)
    }

    /// Ensure an agent pane exists for `id` (kept alive across switches).
    fn ensure_pane(&mut self, id: &str) -> &TerminalPane {
        self.ensure_kind(id, PaneKind::Agent)
    }

    /// Ensure a pane of a given kind exists (agent `<ws>`, run `<ws>:run`, nvim
    /// `<ws>:nvim`). The GtkStack name is the full pty id, matching ptyData
    /// routing.
    fn ensure_kind(&mut self, id: &str, kind: PaneKind) -> &TerminalPane {
        if !self.panes.contains_key(id) {
            let pane = TerminalPane::with_kind(id, kind, self.sink.clone());
            self.stack.add_named(pane.widget(), Some(id));
            self.panes.insert(id.to_string(), pane);
        }
        self.panes.get(id).expect("pane just inserted")
    }

    /// Show the run-script or nvim pane for a workspace, building it (with the
    /// right kind) on first request. The run pane does NOT auto-start — the
    /// caller's toolbar drives `start_manual`.
    pub fn set_active_kind(&mut self, ws_id: &str, kind: PaneKind) {
        let id = match kind {
            PaneKind::Agent => ws_id.to_string(),
            PaneKind::Run => format!("{ws_id}:run"),
            PaneKind::Nvim => format!("{ws_id}:nvim"),
        };
        self.ensure_kind(&id, kind);
        self.stack.set_visible_child_name(&id);
        if self.active.as_deref() != Some(&id) {
            self.active = Some(id.clone());
            if let Some(pane) = self.panes.get(&id) {
                pane.on_shown();
            }
        }
    }

    /// Toggle the Run pane's PTY via its toolbar (start if stopped, stop if
    /// running is tracked by the caller). Returns false if no run pane exists.
    pub fn run_start(&self, ws_id: &str) {
        if let Some(pane) = self.panes.get(&format!("{ws_id}:run")) {
            pane.start_manual();
        }
    }

    pub fn run_stop(&self, ws_id: &str) {
        if let Some(pane) = self.panes.get(&format!("{ws_id}:run")) {
            pane.stop();
        }
    }

    /// Make `id`'s pane the visible one, creating it if needed. Showing a pane
    /// again bounces a repaint so the child re-converges.
    pub fn set_active(&mut self, id: &str) {
        self.ensure_pane(id);
        self.stack.set_visible_child_name(id);
        if self.active.as_deref() != Some(id) {
            self.active = Some(id.to_string());
            if let Some(pane) = self.panes.get(id) {
                pane.on_shown();
            }
        }
    }

    /// Route a `ptyData` frame to its pane. Only the agent PTY (`<wsId>`) and
    /// its `:run`/`:nvim` siblings map to visible panes; unknown ids (e.g.
    /// `account-login:*`) are dropped here.
    pub fn feed(&mut self, id: &str, bytes: &[u8]) {
        if let Some(pane) = self.panes.get(id) {
            pane.feed(bytes);
        }
    }

    /// Seed a pane's scrollback (decoded backend bytes) before live feed.
    pub fn feed_scrollback(&mut self, id: &str, bytes: &[u8]) {
        self.ensure_pane(id);
        if let Some(pane) = self.panes.get(id) {
            pane.feed_scrollback(bytes);
        }
    }

    /// Show the boot pill on a pane (agent start/resume).
    pub fn show_pill(&mut self, id: &str, resuming: bool) {
        self.ensure_pane(id);
        if let Some(pane) = self.panes.get(id) {
            pane.show_pill(resuming);
        }
    }

    /// A `pty:exit`/`pty:stopped` for `id`.
    pub fn on_exit(&self, id: &str, stopped: bool) {
        if let Some(pane) = self.panes.get(id) {
            pane.on_exit(stopped);
        }
    }

    /// A `pty:restart` for `id` (branch switch).
    pub fn on_restart(&self, id: &str) {
        if let Some(pane) = self.panes.get(id) {
            pane.on_restart();
        }
    }

    /// Drop a pane entirely (workspace removed).
    pub fn remove(&mut self, id: &str) {
        if let Some(pane) = self.panes.remove(id) {
            self.stack.remove(pane.widget());
        }
        if self.active.as_deref() == Some(id) {
            self.active = None;
        }
    }
}
