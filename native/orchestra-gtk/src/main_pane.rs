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
    /// Welcome-screen CTAs; app.rs routes these at its overlay/spawn `Msg`s.
    ctas: WelcomeCtas,
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

        let (empty, ctas) = build_welcome();

        let outer = gtk::Stack::new();
        outer.set_widget_name("main-outer-stack");
        outer.set_hexpand(true);
        outer.set_vexpand(true);
        outer.add_named(&empty, Some("empty"));
        outer.add_named(&content, Some("content"));
        outer.set_visible_child_name("empty");
        // Initial state, kept in step with set_active's reflection below.
        root.add_css_class("showing-empty");
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
            ctas,
            terminal_slot,
            run_slot,
        });

        pane.wire(&outer);
        pane.install_harness_actions();
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

    /// The welcome screen's CTA buttons (`App.tsx:384-388`, `:415`). app.rs owns
    /// the actions these fire (new-workspace dialog, scratch, orchestrator, help
    /// overlay), so it connects them the same way it wires the status strip.
    /// Until it does they are inert — the layout is complete, the routing is not.
    pub fn welcome_ctas(&self) -> &WelcomeCtas {
        &self.ctas
    }

    /// Register B2's nvim-toggle handler (replaces the internal stub). Fires
    /// with `true` when the toolbar's nvim toggle opens the file pane.
    pub fn connect_nvim_toggled(&self, f: impl Fn(bool) + 'static) {
        self.toolbar.connect_nvim_toggled(f);
    }

    /// `mainpane.clear-active` for the remote-control harness: drop the active
    /// workspace so the WELCOME SCREEN is on stage.
    ///
    /// The app auto-selects a workspace at launch (`app.rs`: persisted-or-first),
    /// and the mock fixture always has rows, so under the E2E harness the
    /// welcome screen is otherwise UNREACHABLE — there is no user affordance
    /// that deselects. Without this the only "evidence" available for the
    /// welcome screen would be a source reading, which is exactly the standard
    /// the parity inventory found wanting.
    ///
    /// Installed on `root` (actions resolve UP the widget tree, so the harness
    /// must name a widget inside this pane, e.g. `main-empty`).
    fn install_harness_actions(self: &Rc<Self>) {
        let group = gtk::gio::SimpleActionGroup::new();
        let clear = gtk::gio::SimpleAction::new("clear-active", None);
        let this = Rc::downgrade(self);
        clear.connect_activate(move |_, _| {
            if let Some(this) = this.upgrade() {
                this.set_active(None);
            }
        });
        group.add_action(&clear);
        self.root.insert_action_group("mainpane", Some(&group));
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
        // Reflect which branch of the outer stack is on stage as a CSS class on
        // the pane root. The harness can read `visible`, but GTK reports
        // `is_visible() == true` for a Stack's OFF-SCREEN child as well as its
        // current one (measured: both `main-empty` and `main-content` report
        // true simultaneously), so visibility cannot discriminate the two states
        // and an assertion on it passes whichever branch is showing. This class
        // is authoritative and self-resetting, so a drive can assert the
        // welcome screen is genuinely on stage rather than merely instantiated.
        self.root.remove_css_class("showing-empty");
        self.root.remove_css_class("showing-content");
        self.root.add_css_class(if ws.is_some() {
            "showing-content"
        } else {
            "showing-empty"
        });
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

/// The welcome / no-workspace screen's clickable affordances, handed to
/// `app.rs` so it can route them at the same `Msg`s the status-strip buttons
/// use. The actions themselves (new-workspace dialog, scratch, orchestrator,
/// help overlay) live in app.rs — this pane only owns the widgets.
pub struct WelcomeCtas {
    pub new_workspace: gtk::Button,
    pub scratch: gtk::Button,
    pub orchestrator: gtk::Button,
    pub help: gtk::Button,
}

/// The six feature cards — copy is 1:1 from `App.tsx:389-411`.
const WELCOME_FEATURES: [(&str, &str); 6] = [
    (
        "Isolated worktrees",
        "Each agent gets its own branch and directory — no clobbering",
    ),
    (
        "Agents spawn agents",
        "Ask one agent to parallelize; the sidebar fills up",
    ),
    (
        "Diff-first review",
        "Live side-by-side diff, then a one-click PR",
    ),
    (
        "Accounts & usage",
        "Multiple Claude logins with live usage bars",
    ),
    (
        "Remote sandbox",
        "Agents keep working in Docker with the laptop closed",
    ),
    (
        "Improves itself",
        "Point agents at Orchestra's own repo and ship the change",
    ),
];

/// Build the welcome screen, porting `App.tsx:381-418` and the styles.css rules
/// it resolves to. Layout values that GTK expresses in Rust rather than CSS are
/// set here with their styles.css anchor; everything paint-side lives in the
/// `.welcome-*` block appended to theme.css.
fn build_welcome() -> (gtk::Box, WelcomeCtas) {
    // `.empty` (styles.css:2441): flex column, centered both axes, gap 12px.
    // GTK Box spacing is the flex `gap`.
    let empty = gtk::Box::new(gtk::Orientation::Vertical, 12);
    empty.add_css_class("empty");
    empty.set_widget_name("main-empty");
    empty.set_valign(gtk::Align::Center);
    empty.set_halign(gtk::Align::Center);
    empty.set_hexpand(true);
    empty.set_vexpand(true);

    // `<h2>Welcome to Orchestra</h2>` — `.empty h2` (styles.css:2450) sets
    // margin 0 / color var(--text) / font-weight 600; the SIZE comes from the
    // UA default h2 (1.5em) against body 13px (styles.css:92) = 19.5px, and
    // `h1,h2,h3` (styles.css:100) adds letter-spacing -0.01em.
    let title = gtk::Label::new(Some("Welcome to Orchestra"));
    title.add_css_class("welcome-title");

    // The tagline is a bare <div> inside `.empty`, so it inherits
    // color var(--text-dim) and the 13px body size from `.empty` itself.
    let tagline = gtk::Label::new(Some(
        "Run parallel Claude Code agents in isolated git worktrees — each on its own branch, all in one dashboard.",
    ));
    tagline.add_css_class("welcome-tagline");

    // `.empty-actions` (styles.css:2451): flex row, gap 10px, margin-top 4px.
    let actions = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    actions.add_css_class("empty-actions");
    actions.set_widget_name("welcome-actions");
    actions.set_halign(gtk::Align::Center);
    actions.set_margin_top(4);

    let new_workspace = gtk::Button::with_label("+ New workspace");
    new_workspace.set_widget_name("welcome-new-workspace");
    new_workspace.add_css_class("primary");
    let scratch = gtk::Button::with_label("⚡ Scratch session");
    scratch.set_widget_name("welcome-scratch");
    scratch.add_css_class("secondary");
    let orchestrator = gtk::Button::with_label("🌿 Orchestrator");
    orchestrator.set_widget_name("welcome-orchestrator");
    orchestrator.add_css_class("secondary");
    actions.append(&new_workspace);
    actions.append(&scratch);
    actions.append(&orchestrator);

    // `.welcome-features` (styles.css:4317): grid, repeat(3, minmax(160px,
    // 210px)), gap 10px, margin-top 18px. GTK Grid has no minmax, so the cards
    // carry the width bounds themselves (see the theme.css .welcome-feature
    // rule) and the Grid supplies the 3 columns + 10px gaps.
    let features = gtk::Grid::new();
    features.add_css_class("welcome-features");
    features.set_widget_name("welcome-features");
    features.set_row_spacing(10);
    features.set_column_spacing(10);
    features.set_margin_top(18);
    features.set_halign(gtk::Align::Center);
    for (i, (name, desc)) in WELCOME_FEATURES.iter().enumerate() {
        // `.welcome-feature` (styles.css:4323): flex column, gap 3px,
        // bg var(--bg-2), 1px var(--border), radius var(--radius)=8px,
        // padding 10px 12px, text-align left.
        let card = gtk::Box::new(gtk::Orientation::Vertical, 3);
        card.add_css_class("welcome-feature");
        card.set_widget_name(&format!("welcome-feature-{i}"));
        // minmax(160px, 210px) (styles.css:4319): CSS caps the track at 210px.
        // GTK Grid columns are homogeneous-by-content and would otherwise let
        // the cards stretch to the pane width, so the 210px MAXIMUM is enforced
        // by giving each card a fixed request at the cap — GTK CSS has no
        // max-width. `min-width: 160px` in theme.css is the lower bound; at
        // this size request it does not bind, which is expected, not dead.
        card.set_size_request(210, -1);
        card.set_halign(gtk::Align::Center);

        // `.welcome-feature-name` (styles.css:4333): 12px / 600 / var(--text).
        let name_label = gtk::Label::new(Some(name));
        name_label.add_css_class("welcome-feature-name");
        // text-align: left
        name_label.set_xalign(0.0);
        // `.welcome-feature-desc` (styles.css:4338): 11px / line-height 1.45 /
        // var(--text-dim). The desc wraps inside the card's max width.
        let desc_label = gtk::Label::new(Some(desc));
        desc_label.add_css_class("welcome-feature-desc");
        desc_label.set_xalign(0.0);
        desc_label.set_wrap(true);
        desc_label.set_wrap_mode(gtk::pango::WrapMode::WordChar);
        // Wrap inside the 210px card rather than widening it (padding 10/12 →
        // 210 - 24 = 186px of text column).
        desc_label.set_max_width_chars(1);
        desc_label.set_justify(gtk::Justification::Left);

        card.append(&name_label);
        card.append(&desc_label);
        features.attach(&card, (i % 3) as i32, (i / 3) as i32, 1, 1);
    }

    // `.welcome-help-btn` (styles.css:4343): inline-flex, gap 6px,
    // margin-top 14px, 12px, transparent bg, 1px var(--border),
    // color var(--text-dim), no shadow. The HelpIcon is a 14px glyph here.
    let help = gtk::Button::with_label("? Everything Orchestra can do");
    help.set_widget_name("welcome-help-btn");
    help.add_css_class("welcome-help-btn");
    help.set_halign(gtk::Align::Center);
    help.set_margin_top(14);

    empty.append(&title);
    empty.append(&tagline);
    empty.append(&actions);
    empty.append(&features);
    empty.append(&help);

    (
        empty,
        WelcomeCtas {
            new_workspace,
            scratch,
            orchestrator,
            help,
        },
    )
}
