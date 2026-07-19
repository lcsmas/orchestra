//! The main pane (plan §5.3): toolbar on top, the three workspace-flow banners
//! under it, and a view stack (Terminal | Diff | Run) below. It owns the
//! per-workspace polls the toolbar/diff need — diff stats, PR state, run-script
//! status — each gated on the window being visible, and marks a workspace seen
//! when it's selected (the Electron `setActive` → `markSeen`).
//!
//! The Terminal and Run pages are placeholders here: B2 owns the xterm/PTY
//! surface and drops its widgets into the named slots (`main-terminal-slot`,
//! `main-run-slot`). The Diff page is B3's [`crate::diff::DiffView`].

use std::cell::RefCell;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use orchestra_rpc::types::{DiffStats, PrsForBranch, Workspace};
use serde_json::json;

use crate::banners::Banners;
use crate::ctx::Ctx;
use crate::diff::DiffView;
use crate::toolbar::{Tab, Toolbar};

/// Poll cadences (seconds), matching the Electron visible-polls.
const STATS_POLL_SECS: u32 = 8;
const PR_POLL_SECS: u32 = 12;

struct State {
    ws: Option<Workspace>,
}

pub struct MainPane {
    ctx: Rc<Ctx>,
    state: Rc<RefCell<State>>,
    root: gtk::Box,
    toolbar: Rc<Toolbar>,
    banners: Rc<Banners>,
    diff: Rc<DiffView>,
    stack: gtk::Stack,
    /// Empty-state child shown when no workspace is selected.
    empty: gtk::Box,
    /// B2 mounts the terminal here.
    terminal_slot: gtk::Box,
    /// B2 mounts the run panel here.
    run_slot: gtk::Box,
}

impl MainPane {
    pub fn new(ctx: Rc<Ctx>) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.add_css_class("main-area");
        root.set_widget_name("main-area");
        root.set_hexpand(true);
        root.set_vexpand(true);

        let toolbar = Toolbar::new(ctx.clone());
        let banners = Banners::new(ctx.clone());
        let diff = DiffView::new(ctx.clone());

        // View stack: terminal | diff | run.
        let terminal_slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
        terminal_slot.set_widget_name("main-terminal-slot");
        terminal_slot.set_hexpand(true);
        terminal_slot.set_vexpand(true);
        // Placeholder until B2 mounts the xterm surface.
        let term_hint = gtk::Label::new(Some("Terminal — mounts with the B2 workstream"));
        term_hint.add_css_class("empty-hint");
        term_hint.set_hexpand(true);
        term_hint.set_vexpand(true);
        terminal_slot.append(&term_hint);

        let run_slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
        run_slot.set_widget_name("main-run-slot");
        run_slot.set_hexpand(true);
        run_slot.set_vexpand(true);
        let run_hint = gtk::Label::new(Some("Run script output — mounts with the B2 workstream"));
        run_hint.add_css_class("empty-hint");
        run_hint.set_hexpand(true);
        run_hint.set_vexpand(true);
        run_slot.append(&run_hint);

        // NOTE (M3 gap #2): the "No run script configured" guidance that the
        // always-visible Run tab leads to belongs in the RUN PANE, which B2
        // owns — app.rs mounts `TerminalStack::run_widget()` into this slot and
        // replaces anything B3 puts here. The toolbar half (tab stays visible,
        // dim "· setup" hint, learn-more tooltip, run-toggle still gated on
        // has_run) is B3's and lives in toolbar/mod.rs::apply_state.

        let stack = gtk::Stack::new();
        stack.set_widget_name("main-view-stack");
        stack.set_hexpand(true);
        stack.set_vexpand(true);
        stack.add_named(&terminal_slot, Some("terminal"));
        stack.add_named(diff.widget(), Some("diff"));
        stack.add_named(&run_slot, Some("run"));
        stack.set_visible_child_name("terminal");

        // The content column (toolbar + banners + stack), swapped out for the
        // empty state when no workspace is active.
        let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
        content.set_widget_name("main-content");
        content.set_hexpand(true);
        content.set_vexpand(true);
        content.append(toolbar.widget());
        content.append(banners.widget());
        content.append(&stack);

        let empty = gtk::Box::new(gtk::Orientation::Vertical, 8);
        empty.add_css_class("empty");
        empty.set_widget_name("main-empty");
        empty.set_valign(gtk::Align::Center);
        empty.set_halign(gtk::Align::Center);
        empty.set_hexpand(true);
        empty.set_vexpand(true);
        let empty_title = gtk::Label::new(Some("Select a workspace"));
        empty_title.add_css_class("empty-title");
        let empty_sub = gtk::Label::new(Some(
            "Run parallel Claude Code agents in isolated git worktrees.",
        ));
        empty_sub.add_css_class("empty-hint");
        empty.append(&empty_title);
        empty.append(&empty_sub);

        let outer = gtk::Stack::new();
        outer.set_widget_name("main-outer-stack");
        outer.set_hexpand(true);
        outer.set_vexpand(true);
        outer.add_named(&empty, Some("empty"));
        outer.add_named(&content, Some("content"));
        outer.set_visible_child_name("empty");
        root.append(&outer);

        let pane = Rc::new(Self {
            ctx,
            state: Rc::new(RefCell::new(State { ws: None })),
            root,
            toolbar,
            banners,
            diff,
            stack,
            empty,
            terminal_slot,
            run_slot,
        });

        pane.wire(&outer);
        pane.start_polls();
        pane
    }

    pub fn widget(&self) -> &gtk::Widget {
        self.root.upcast_ref()
    }

    /// The slot B2 mounts the terminal surface into.
    pub fn terminal_slot(&self) -> &gtk::Box {
        &self.terminal_slot
    }

    /// The slot B2 mounts the run-script panel into.
    pub fn run_slot(&self) -> &gtk::Box {
        &self.run_slot
    }

    /// Register B2's nvim-toggle handler (replaces the internal stub). Fires
    /// with `true` when the toolbar's nvim toggle opens the file pane.
    pub fn connect_nvim_toggled(&self, f: impl Fn(bool) + 'static) {
        self.toolbar.connect_nvim_toggled(f);
    }

    fn wire(self: &Rc<Self>, outer: &gtk::Stack) {
        // Toolbar tab → stack page + (for diff) point the DiffView at the ws.
        {
            let this = Rc::downgrade(self);
            self.toolbar.connect_tab_selected(move |tab| {
                if let Some(this) = this.upgrade() {
                    this.show_tab(tab);
                }
            });
        }
        // Nvim/file-pane toggle is B2's; keep the hook so the state threads
        // through even before the pane exists.
        {
            self.toolbar.connect_nvim_toggled(move |_open| {
                // B2 shows/hides its file pane here.
            });
        }
        let _ = outer; // outer stack handle retained via set_active below
    }

    /// Select (or clear) the active workspace. Mirrors Electron `setActive`:
    /// re-points every child and marks the workspace seen.
    pub fn set_active(&self, ws: Option<Workspace>) {
        let outer = self
            .root
            .first_child()
            .and_downcast::<gtk::Stack>()
            .expect("main-outer-stack is the root's only child");
        match &ws {
            Some(w) => {
                outer.set_visible_child_name("content");
                self.diff.set_workspace(Some(&w.id));
                // markSeen(id) — clears the unread/needs-input dot on select.
                let _ = self.ctx.call("markSeen", vec![json!(w.id)]);
            }
            None => {
                outer.set_visible_child_name("empty");
                self.diff.set_workspace(None);
            }
        }
        self.toolbar.set_workspace(ws.clone());
        self.banners.set_workspace(ws.as_ref());
        self.state.borrow_mut().ws = ws;
        // Restore the (single-global) view onto the stack for the new ws.
        self.show_tab(self.toolbar.active_tab());
        // Fresh polls for the new workspace right away.
        self.poll_stats();
        self.poll_pr();
        self.poll_run_status();
    }

    /// A workspace record changed (workspaceUpdate / a mutation) — refresh the
    /// banners and, if it's the active one, the toolbar chips.
    pub fn on_workspace_changed(&self, ws: &Workspace) {
        self.banners.on_workspace_changed(ws);
        if self
            .state
            .borrow()
            .ws
            .as_ref()
            .is_some_and(|w| w.id == ws.id)
        {
            self.state.borrow_mut().ws = Some(ws.clone());
            self.toolbar.set_workspace(Some(ws.clone()));
        }
    }

    /// A `sandboxControl` event from the backend event pump.
    pub fn on_sandbox_control(&self, state: orchestra_rpc::types::SandboxControlState) {
        self.banners.on_sandbox_control(state);
    }

    /// A `ptyExit` event: clear the run toggle when the run PTY exits (the pty
    /// id the run script uses is `<ws>:run`).
    pub fn on_pty_exit(&self, pty_id: &str) {
        if let Some(ws_id) = self.state.borrow().ws.as_ref().map(|w| w.id.clone()) {
            if pty_id == format!("{ws_id}:run") {
                self.toolbar.set_run_live(false);
            }
        }
    }

    fn show_tab(&self, tab: Tab) {
        let name = match tab {
            Tab::Terminal => "terminal",
            Tab::Diff => "diff",
            Tab::Run => "run",
        };
        self.stack.set_visible_child_name(name);
        let _ = &self.empty; // handle retained for tooling
    }

    // ---- polls -------------------------------------------------------------

    fn start_polls(self: &Rc<Self>) {
        {
            let this = Rc::downgrade(self);
            glib::timeout_add_seconds_local(STATS_POLL_SECS, move || {
                let Some(this) = this.upgrade() else {
                    return glib::ControlFlow::Break;
                };
                if this.ctx.window.is_visible() {
                    this.poll_stats();
                }
                glib::ControlFlow::Continue
            });
        }
        {
            let this = Rc::downgrade(self);
            glib::timeout_add_seconds_local(PR_POLL_SECS, move || {
                let Some(this) = this.upgrade() else {
                    return glib::ControlFlow::Break;
                };
                if this.ctx.window.is_visible() {
                    this.poll_pr();
                }
                glib::ControlFlow::Continue
            });
        }
    }

    fn poll_stats(&self) {
        let Some(id) = self.state.borrow().ws.as_ref().map(|w| w.id.clone()) else {
            self.toolbar.set_diff_stats(None);
            return;
        };
        match self
            .ctx
            .call_typed::<DiffStats>("getDiffStats", vec![json!(id)])
        {
            Ok(stats) => self.toolbar.set_diff_stats(Some(&stats)),
            Err(_) => self.toolbar.set_diff_stats(None),
        }
    }

    fn poll_pr(&self) {
        let Some(id) = self.state.borrow().ws.as_ref().map(|w| w.id.clone()) else {
            self.toolbar.set_prs(None);
            return;
        };
        match self
            .ctx
            .call_typed::<PrsForBranch>("findPR", vec![json!(id)])
        {
            Ok(prs) => self.toolbar.set_prs(Some(&prs)),
            Err(_) => self.toolbar.set_prs(None),
        }
    }

    fn poll_run_status(&self) {
        let Some(id) = self.state.borrow().ws.as_ref().map(|w| w.id.clone()) else {
            return;
        };
        let live = self
            .ctx
            .call_typed::<bool>("runScriptStatus", vec![json!(id)])
            .unwrap_or(false);
        self.toolbar.set_run_live(live);
    }
}
