//! Kept-alive terminal stack (plan §5.2): one [`TerminalPane`] per pty id in a
//! `GtkStack`, so scrollback survives tab switches. Routes `ptyData` frames to
//! the matching pane, lazily builds panes, and bounces a repaint when a pane is
//! shown again.
//!
//! The stack holds THREE surfaces per workspace — the agent pane (`<ws>`, in
//! B3's terminal slot), the run pane (`<ws>:run`, in B3's run slot), and the
//! nvim pane (`<ws>:nvim`, toggled by B3's toolbar). B3's toolbar owns tab
//! switching and run start/stop; this stack is pure content.

use std::collections::HashMap;
use std::rc::Rc;

use gtk::prelude::*;

use super::pane::{PaneKind, TerminalPane};
use crate::ctx::Ctx;

pub struct TerminalStack {
    /// Agent panes live in a GtkStack (mounted in B3's terminal slot) so one
    /// kept-alive VTE per workspace switches without losing scrollback.
    agent_stack: gtk::Stack,
    /// The run/nvim surfaces (their host boxes are B3's run_slot / a toggled
    /// nvim box); tracked here so ptyData routes and they stay kept-alive.
    panes: HashMap<String, TerminalPane>,
    ctx: Rc<Ctx>,
    active_ws: Option<String>,
}

impl TerminalStack {
    pub fn new(ctx: Rc<Ctx>) -> Self {
        let agent_stack = gtk::Stack::new();
        agent_stack.set_widget_name("terminal-stack");
        agent_stack.set_hexpand(true);
        agent_stack.set_vexpand(true);
        agent_stack.set_transition_type(gtk::StackTransitionType::None);
        TerminalStack {
            agent_stack,
            panes: HashMap::new(),
            ctx,
            active_ws: None,
        }
    }

    /// The agent GtkStack — mount this in B3's `terminal_slot()`.
    pub fn agent_widget(&self) -> &gtk::Widget {
        self.agent_stack.upcast_ref()
    }

    /// Whether no agent pane exists yet for `ws_id` (so the caller seeds
    /// scrollback + shows the pill exactly once, on first open).
    pub fn is_new(&self, ws_id: &str) -> bool {
        !self.panes.contains_key(ws_id)
    }

    /// Ensure a pane of a given kind exists (keyed by the FULL pty id, which is
    /// also the GtkStack name / how ptyData routes).
    fn ensure(&mut self, id: &str, kind: PaneKind) -> &TerminalPane {
        if !self.panes.contains_key(id) {
            let pane = TerminalPane::with_kind(id, kind, self.ctx.clone());
            if kind == PaneKind::Agent {
                self.agent_stack.add_named(pane.widget(), Some(id));
            }
            self.panes.insert(id.to_string(), pane);
        }
        self.panes.get(id).expect("pane just inserted")
    }

    /// Make `ws_id`'s agent pane the visible one in the agent stack, creating it
    /// if needed. Showing a pane again bounces a repaint.
    pub fn set_active(&mut self, ws_id: &str) {
        self.ensure(ws_id, PaneKind::Agent);
        self.agent_stack.set_visible_child_name(ws_id);
        if self.active_ws.as_deref() != Some(ws_id) {
            self.active_ws = Some(ws_id.to_string());
            if let Some(pane) = self.panes.get(ws_id) {
                pane.on_shown();
            }
        }
    }

    /// Route a `ptyData` frame to its pane (agent `<ws>`, run `<ws>:run`, nvim
    /// `<ws>:nvim`). Unknown ids (e.g. `account-login:*`) are dropped here — the
    /// accounts controller owns those.
    pub fn feed(&mut self, id: &str, bytes: &[u8]) {
        if let Some(pane) = self.panes.get(id) {
            pane.feed(bytes);
        }
    }

    /// Seed an agent pane's scrollback (backend bytes) before live feed.
    pub fn feed_scrollback(&mut self, ws_id: &str, bytes: &[u8]) {
        self.ensure(ws_id, PaneKind::Agent);
        if let Some(pane) = self.panes.get(ws_id) {
            pane.feed_scrollback(bytes);
        }
    }

    /// Show the boot pill on an agent pane (agent start/resume).
    pub fn show_pill(&mut self, ws_id: &str, resuming: bool) {
        self.ensure(ws_id, PaneKind::Agent);
        if let Some(pane) = self.panes.get(ws_id) {
            pane.show_pill(resuming);
        }
    }

    /// Build (if needed) and return the run pane's widget for `ws_id`, to mount
    /// into B3's `run_slot()`. The run PTY is started by B3's toolbar; this pane
    /// just feeds + resizes it.
    pub fn run_widget(&mut self, ws_id: &str) -> gtk::Widget {
        let id = format!("{ws_id}:run");
        self.ensure(&id, PaneKind::Run).widget().clone()
    }

    /// The "no run script configured" guidance shown in the run slot instead of
    /// a dead terminal (Electron `RunTerminal.tsx`'s `!hasRunScript` branch).
    /// B3's toolbar keeps the Run TAB reachable even without a script — this is
    /// the other half of that discovery path, so the copy names the same entry
    /// point (the repo's gear in the sidebar) the tab's tooltip promises.
    pub fn run_guidance() -> gtk::Widget {
        let col = gtk::Box::new(gtk::Orientation::Vertical, 8);
        col.set_widget_name("run-empty");
        col.add_css_class("run-empty");
        col.set_valign(gtk::Align::Center);
        col.set_halign(gtk::Align::Center);
        col.set_hexpand(true);
        col.set_vexpand(true);

        let title = gtk::Label::new(Some("No run script configured"));
        title.set_widget_name("run-empty-title");
        title.add_css_class("empty-title");

        // Same wording as the renderer, with the inline <code> bits rendered as
        // monospace via pango markup.
        let body = gtk::Label::new(None);
        body.set_widget_name("run-empty-hint");
        body.add_css_class("empty-hint");
        body.set_markup(
            "Click the gear icon next to the repo name in the sidebar to add a \
             <tt>run</tt> script (e.g. <tt>pnpm dev --port $ORCHESTRA_PORT</tt>).",
        );
        body.set_wrap(true);
        body.set_justify(gtk::Justification::Center);
        body.set_max_width_chars(52);

        col.append(&title);
        col.append(&body);
        col.upcast()
    }

    /// Toggle the nvim file pane for the active workspace within the agent
    /// stack (B3's toolbar nvim toggle drives this). `open` reveals the nvim
    /// pane (built + auto-started on first open); `false` returns to the agent
    /// pane. Both stay kept-alive so scrollback/session survive the toggle.
    pub fn set_nvim_open(&mut self, open: bool) {
        let Some(ws_id) = self.active_ws.clone() else {
            return;
        };
        if open {
            let nvim_id = format!("{ws_id}:nvim");
            if !self.panes.contains_key(&nvim_id) {
                let pane = TerminalPane::with_kind(&nvim_id, PaneKind::Nvim, self.ctx.clone());
                self.agent_stack.add_named(pane.widget(), Some(&nvim_id));
                self.panes.insert(nvim_id.clone(), pane);
            }
            self.agent_stack.set_visible_child_name(&nvim_id);
            if let Some(pane) = self.panes.get(&nvim_id) {
                pane.on_shown();
            }
        } else {
            self.agent_stack.set_visible_child_name(&ws_id);
            if let Some(pane) = self.panes.get(&ws_id) {
                pane.on_shown();
            }
        }
    }

    /// A `ptyExit`/`ptyStopped` for `id`.
    pub fn on_exit(&self, id: &str, stopped: bool) {
        if let Some(pane) = self.panes.get(id) {
            pane.on_exit(stopped);
        }
    }

    /// A `ptyRestart` for `id` (branch switch).
    pub fn on_restart(&self, id: &str) {
        if let Some(pane) = self.panes.get(id) {
            pane.on_restart();
        }
    }

    /// Drop a workspace's panes entirely (workspace removed).
    pub fn remove(&mut self, ws_id: &str) {
        for suffix in ["", ":run", ":nvim"] {
            let id = format!("{ws_id}{suffix}");
            if let Some(pane) = self.panes.remove(&id) {
                if suffix.is_empty() {
                    self.agent_stack.remove(pane.widget());
                }
            }
        }
        if self.active_ws.as_deref() == Some(ws_id) {
            self.active_ws = None;
        }
    }
}
