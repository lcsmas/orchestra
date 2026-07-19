//! Kept-alive terminal stack (plan §5.2): one [`TerminalPane`] per workspace in
//! a `GtkStack`, so scrollback survives tab switches. Routes `ptyData` frames
//! to the matching pane, lazily builds a pane on first activation, and bounces a
//! repaint when a pane is shown again.

use std::collections::HashMap;
use std::rc::Rc;

use gtk::prelude::*;

use super::pane::{PaneIntent, TerminalPane};

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

    /// Ensure a pane exists for `id` (kept alive across switches).
    fn ensure_pane(&mut self, id: &str) -> &TerminalPane {
        if !self.panes.contains_key(id) {
            let pane = TerminalPane::new(id, self.sink.clone());
            self.stack.add_named(pane.widget(), Some(id));
            self.panes.insert(id.to_string(), pane);
        }
        self.panes.get(id).expect("pane just inserted")
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
