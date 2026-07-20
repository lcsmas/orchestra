//! Main-pane toolbar (plan §5.3, anchor `App.tsx` toolbar): base→branch chips
//! with a searchable branch picker, Terminal/Diff/Run tabs, restart-agent, a
//! run start/stop toggle, the PR button, a merge button, and an nvim/file-pane
//! toggle. Reuses [`branch_popover::BranchPopoverPanel`] — the same panel B1's
//! sidebar mounts in its own popovers.
//!
//! The toolbar is a plain widget tree (not a Relm4 component) so the main pane
//! can own it directly and drive it imperatively from backend events; it
//! reports tab changes and nvim toggles back through callbacks the pane wires.

pub mod branch_popover;

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;

use orchestra_rpc::types::{
    DiffStats, PrInfo, PrState, PrsForBranch, RepoScripts, Workspace, WorkspaceKind,
    WorkspaceStatus,
};
use serde_json::json;

use crate::ctx::Ctx;
use crate::dialogs;
use crate::icons;
use branch_popover::BranchPopoverPanel;

/// Which main-pane view a tab selects — mirrors the Electron single global
/// `view: 'terminal' | 'diff' | 'run'` (App.tsx), not a per-workspace flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Terminal,
    Diff,
    Run,
}

/// The `create a PR` prompt injected into the agent PTY, verbatim from App.tsx.
const PR_PROMPT: &str = "Please create a pull request for the current branch: commit any pending changes, push the branch, and open the PR with a concise title and summary.";

struct ToolbarState {
    /// The workspace the toolbar currently reflects (its id drives every call).
    ws: Option<Workspace>,
    /// Whether the active repo has a `run` script configured (Run tab + toggle
    /// only exist when it does — the brief/ledger diverge from Electron here,
    /// which always shows the Run tab with a "· setup" hint).
    has_run: bool,
    /// The run-script PTY is live (drives the play/stop toggle).
    run_live: bool,
    /// Latest open PR for the branch, if any (drives the PR button).
    open_pr: Option<PrInfo>,
    active_tab: Tab,
    nvim_open: bool,
}

pub struct Toolbar {
    ctx: Rc<Ctx>,
    state: Rc<RefCell<ToolbarState>>,
    root: gtk::Box,

    // Title chips ------------------------------------------------------------
    orchestrator_chip: gtk::Box,
    scratch_chip: gtk::Box,
    git_title: gtk::Box,
    base_chip_text: gtk::Label,
    branch_btn: gtk::MenuButton,
    branch_btn_label: gtk::Label,
    chip_text_orchestrator: gtk::Label,
    chip_text_scratch: gtk::Label,
    branch_popover: gtk::Popover,
    branch_panel: Rc<BranchPopoverPanel>,

    // Tabs -------------------------------------------------------------------
    tab_terminal: gtk::ToggleButton,
    tab_diff: gtk::ToggleButton,
    tab_run: gtk::ToggleButton,
    /// The dim "· setup" suffix on the Run tab, shown only when the repo has
    /// no run script configured.
    run_tab_hint: gtk::Label,
    diff_indicator: gtk::Label,

    // Action buttons ---------------------------------------------------------
    run_toggle: gtk::Button,
    run_toggle_icon: gtk::Image,
    pr_btn: gtk::Button,
    /// The PR button's text. Held separately because the button's child is a
    /// custom icon+label+arrow box; `pr_btn.set_label()` would replace it.
    pr_label: gtk::Label,
    /// The trailing external-link arrow, hidden in the "create a PR" state
    /// (Electron: `.pr-link-create::after { display: none }`, styles.css:228).
    pr_ext: gtk::Image,
    merge_btn: gtk::Button,
    merge_pill: gtk::Revealer,
    nvim_toggle: gtk::ToggleButton,

    /// Fired when a tab is picked (the pane swaps its stack + marks seen).
    on_tab: RefCell<Option<TabFn>>,
    /// Fired when the nvim/file-pane toggle flips (B2 owns the pane).
    on_nvim: RefCell<Option<NvimFn>>,
    /// Guards the tab ToggleButton handlers during programmatic sync.
    syncing_tabs: Cell<bool>,
}

/// Callback fired when a toolbar tab is selected.
type TabFn = Box<dyn Fn(Tab)>;
/// Callback fired when the nvim/file-pane toggle flips.
type NvimFn = Box<dyn Fn(bool)>;

impl Toolbar {
    pub fn new(ctx: Rc<Ctx>) -> Rc<Self> {
        // 10px spacing matches Electron .toolbar's `gap: 10px`
        // (styles.css:1794); the rest of the strip is styled in theme.css.
        let root = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        root.add_css_class("toolbar");
        root.set_widget_name("toolbar");

        // ---- title: one of three chip layouts ------------------------------
        let title = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        title.add_css_class("toolbar-title");
        title.set_widget_name("toolbar-title");

        // Orchestrator chip.
        let orchestrator_chip = gtk::Box::new(gtk::Orientation::Horizontal, 5);
        orchestrator_chip.add_css_class("branch-chip");
        orchestrator_chip.add_css_class("orchestrator");
        orchestrator_chip.set_widget_name("branch-chip-orchestrator");
        orchestrator_chip
            .set_tooltip_text(Some("Orchestrator session — coordinates spawned agents"));
        // Was the 🌿 literal — an emoji standing in for an icon, which renders
        // in whatever colour/weight the fallback emoji font supplies and so
        // ignores `.branch-chip.orchestrator`'s colour entirely.
        let orch_icon = icons::image_sized(icons::ORCHESTRATOR, 12);
        orch_icon.add_css_class("branch-chip-icon");
        let chip_text_orchestrator = gtk::Label::new(None);
        chip_text_orchestrator.add_css_class("branch-chip-text");
        orchestrator_chip.append(&orch_icon);
        orchestrator_chip.append(&chip_text_orchestrator);

        // Scratch chip.
        let scratch_chip = gtk::Box::new(gtk::Orientation::Horizontal, 5);
        scratch_chip.add_css_class("branch-chip");
        scratch_chip.add_css_class("scratch");
        scratch_chip.set_widget_name("branch-chip-scratch");
        scratch_chip.set_tooltip_text(Some("Scratch session — not tracked by git"));
        // Was the ⚡ literal (see the orchestrator chip above).
        let scratch_icon = icons::image_sized(icons::ZAP, 12);
        scratch_icon.add_css_class("branch-chip-icon");
        let chip_text_scratch = gtk::Label::new(None);
        chip_text_scratch.add_css_class("branch-chip-text");
        scratch_chip.append(&scratch_icon);
        scratch_chip.append(&chip_text_scratch);

        // Git title: base chip → arrow → branch MenuButton.
        let git_title = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        git_title.set_widget_name("branch-title-git");
        let base_chip = gtk::Box::new(gtk::Orientation::Horizontal, 5);
        base_chip.add_css_class("branch-chip");
        base_chip.add_css_class("base");
        base_chip.set_widget_name("branch-chip-base");
        // Was `⑃` U+2443 OCR INVERTED FORK — not a git glyph at all, merely
        // fork-shaped in some fonts. Electron draws a real git-branch mark
        // here (App.tsx `.branch-chip.base`), 12px like this one.
        let base_icon = icons::image_sized(icons::BRANCH, 12);
        base_icon.add_css_class("branch-chip-icon");
        let base_chip_text = gtk::Label::new(None);
        base_chip_text.add_css_class("branch-chip-text");
        base_chip.append(&base_icon);
        base_chip.append(&base_chip_text);
        let arrow = gtk::Label::new(Some("→"));
        arrow.add_css_class("branch-arrow");

        let branch_panel = BranchPopoverPanel::new("switch", "current");
        let branch_popover = gtk::Popover::new();
        branch_popover.set_child(Some(branch_panel.widget()));
        branch_popover.add_css_class("branch-popover");
        branch_popover.set_widget_name("branch-popover");
        let branch_btn = gtk::MenuButton::new();
        branch_btn.set_popover(Some(&branch_popover));
        branch_btn.add_css_class("branch-chip");
        // `head`, not `current`. Electron's accent-tinted chip is
        // `.branch-chip.head` (styles.css:1865-1869); `.branch-chip.current`
        // has NO rule anywhere in styles.css (verified: 0 matches). The port
        // was styling a class that does not exist upstream, which is why this
        // chip rendered flat grey instead of accent-blue. `current` is kept
        // alongside it so the remote-control E2E selectors keep resolving.
        branch_btn.add_css_class("head");
        branch_btn.add_css_class("current");
        branch_btn.set_widget_name("branch-picker-btn");
        // gap: 5px matches .branch-chip's `gap: 5px` (styles.css:1844).
        let branch_btn_box = gtk::Box::new(gtk::Orientation::Horizontal, 5);
        // Was `⎇` U+2387 ALTERNATIVE KEY SYMBOL — a keyboard glyph, not a git
        // one. Same 12px branch mark as the base chip, so the two finally match.
        let branch_btn_icon = icons::image_sized(icons::BRANCH, 12);
        branch_btn_icon.add_css_class("branch-chip-icon");
        let branch_btn_label = gtk::Label::new(None);
        branch_btn_label.add_css_class("branch-chip-text");
        // The dropdown caret Electron draws inside the chip (BranchPicker.tsx
        // renders a 10px chevron after the label). GTK's MenuButton would
        // otherwise supply its own arrow outside our chip layout, so the chip
        // owns the caret and the MenuButton's built-in one stays off.
        let branch_btn_caret = icons::image_sized(icons::CARET_DOWN, 10);
        branch_btn_caret.add_css_class("branch-caret");
        branch_btn_box.append(&branch_btn_icon);
        branch_btn_box.append(&branch_btn_label);
        branch_btn_box.append(&branch_btn_caret);
        branch_btn.set_child(Some(&branch_btn_box));

        git_title.append(&base_chip);
        git_title.append(&arrow);
        git_title.append(&branch_btn);

        title.append(&orchestrator_chip);
        title.append(&scratch_chip);
        title.append(&git_title);
        root.append(&title);

        // ---- tabs (center) -------------------------------------------------
        let tabs = gtk::Box::new(gtk::Orientation::Horizontal, 2);
        tabs.add_css_class("toolbar-tabs");
        tabs.set_widget_name("toolbar-tabs");
        tabs.set_halign(gtk::Align::Center);
        tabs.set_hexpand(true);
        let tab_terminal = gtk::ToggleButton::with_label("Terminal");
        tab_terminal.add_css_class("tab");
        tab_terminal.set_widget_name("tab-terminal");
        tab_terminal.set_active(true);
        let tab_diff = gtk::ToggleButton::with_label("");
        tab_diff.add_css_class("tab");
        tab_diff.set_widget_name("tab-diff");
        // Custom child so the Diff label can carry the +/- indicator.
        let diff_box = gtk::Box::new(gtk::Orientation::Horizontal, 5);
        let diff_label = gtk::Label::new(Some("Diff"));
        let diff_indicator = gtk::Label::new(None);
        diff_indicator.add_css_class("diff-indicator");
        diff_indicator.set_visible(false);
        diff_box.append(&diff_label);
        diff_box.append(&diff_indicator);
        tab_diff.set_child(Some(&diff_box));
        tab_diff.set_group(Some(&tab_terminal));
        // "Run" plus a dim "· setup" hint shown only when the repo has no run
        // script (App.tsx:491) — the tab itself stays visible either way.
        let tab_run = gtk::ToggleButton::new();
        tab_run.add_css_class("tab");
        tab_run.set_widget_name("tab-run");
        let run_box = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        let run_label = gtk::Label::new(Some("Run"));
        let run_tab_hint = gtk::Label::new(Some(" · setup"));
        run_tab_hint.add_css_class("tab-dim");
        run_tab_hint.set_widget_name("tab-run-hint");
        run_tab_hint.set_visible(false);
        run_box.append(&run_label);
        run_box.append(&run_tab_hint);
        tab_run.set_child(Some(&run_box));
        tab_run.set_group(Some(&tab_terminal));
        tabs.append(&tab_terminal);
        tabs.append(&tab_diff);
        tabs.append(&tab_run);
        root.append(&tabs);

        // ---- action buttons (right) ----------------------------------------
        let restart_btn = gtk::Button::new();
        restart_btn.add_css_class("restart-btn");
        restart_btn.set_widget_name("restart-btn");
        // Was the stock `view-refresh-symbolic`, whose shape is whatever the
        // user's system icon theme supplies. Electron draws its own arc+arrow
        // at 14px (App.tsx `.restart-btn`); this is that exact path.
        restart_btn.set_child(Some(&icons::image_sized(icons::RESTART, 14)));
        restart_btn.set_tooltip_text(Some(
            "Restart agent (resumes via --continue, picks up MCP / settings changes)",
        ));

        // Electron uses a 13px play triangle / stop square (App.tsx
        // `.run-toggle-btn`); `apply_state` swaps between icons::PLAY and
        // icons::STOP rather than between two stock media icons.
        let run_toggle_icon = icons::image_sized(icons::PLAY, 13);
        let run_toggle = gtk::Button::new();
        run_toggle.add_css_class("run-toggle-btn");
        run_toggle.set_widget_name("run-toggle-btn");
        run_toggle.set_child(Some(&run_toggle_icon));

        // The PR button is Electron's one *primary* toolbar action: an
        // accent-tinted pill carrying a pull-request mark, and — when it links
        // out to a real PR — a trailing external-link arrow. Both of those are
        // CSS mask pseudo-elements upstream (`button.pr-link::before`,
        // styles.css:201-209, and `::after`, styles.css:210-219). GTK4 has no
        // ::before/::after, so they must be real child widgets; the geometry is
        // the same, lifted from those two mask URLs.
        //
        // `.pr-link-create` (the "ask the agent to open a PR" state) hides the
        // arrow upstream — `::after { display: none }` (styles.css:228) —
        // because that button submits a prompt rather than opening a URL. Here
        // that is `pr_ext.set_visible(false)`, driven in `apply_state`.
        let pr_btn = gtk::Button::new();
        pr_btn.add_css_class("pr-link");
        pr_btn.set_widget_name("pr-btn");
        // gap: 7px — styles.css:190.
        let pr_box = gtk::Box::new(gtk::Orientation::Horizontal, 7);
        // 14px — the ::before mask's width/height (styles.css:203-204).
        let pr_icon = icons::image_sized(icons::PR, 14);
        let pr_label = gtk::Label::new(Some("Open PR"));
        // 10px — the ::after mask's width/height (styles.css:212-213).
        let pr_ext = icons::image_sized(icons::EXTERNAL, 10);
        pr_ext.add_css_class("pr-ext");
        pr_box.append(&pr_icon);
        pr_box.append(&pr_label);
        pr_box.append(&pr_ext);
        pr_btn.set_child(Some(&pr_box));

        let merge_btn = gtk::Button::with_label("Merge");
        merge_btn.add_css_class("merge-btn");
        merge_btn.set_widget_name("merge-btn");
        merge_btn.set_tooltip_text(Some(
            "Merge this worktree into its base branch (the agent commits, merges & pushes)",
        ));

        let merge_pill_label = gtk::Label::new(Some("merge requested — the agent merges & pushes"));
        merge_pill_label.add_css_class("merge-pill-label");
        let merge_pill = gtk::Revealer::new();
        merge_pill.set_child(Some(&merge_pill_label));
        merge_pill.set_widget_name("merge-pill");
        merge_pill.set_transition_type(gtk::RevealerTransitionType::Crossfade);

        let nvim_toggle = gtk::ToggleButton::new();
        nvim_toggle.add_css_class("pane-toggle");
        nvim_toggle.set_widget_name("nvim-toggle");
        // Was the stock `sidebar-show-right-symbolic`. Electron draws a 16px
        // panel outline with a divider (App.tsx `.pane-toggle`).
        nvim_toggle.set_child(Some(&icons::image_sized(icons::PANE, 16)));
        nvim_toggle.set_tooltip_text(Some("Show file pane"));

        root.append(&restart_btn);
        root.append(&run_toggle);
        root.append(&pr_btn);
        root.append(&merge_btn);
        root.append(&merge_pill);
        root.append(&nvim_toggle);

        let toolbar = Rc::new(Self {
            ctx,
            state: Rc::new(RefCell::new(ToolbarState {
                ws: None,
                has_run: false,
                run_live: false,
                open_pr: None,
                active_tab: Tab::Terminal,
                nvim_open: false,
            })),
            root,
            orchestrator_chip,
            scratch_chip,
            git_title,
            base_chip_text,
            branch_btn,
            branch_btn_label,
            chip_text_orchestrator,
            chip_text_scratch,
            branch_popover,
            branch_panel,
            tab_terminal,
            tab_diff,
            tab_run,
            run_tab_hint,
            diff_indicator,
            run_toggle,
            run_toggle_icon,
            pr_btn,
            pr_label,
            pr_ext,
            merge_btn,
            merge_pill,
            nvim_toggle,
            on_tab: RefCell::new(None),
            on_nvim: RefCell::new(None),
            syncing_tabs: Cell::new(false),
        });

        toolbar.wire();
        toolbar.apply_state();
        toolbar
    }

    pub fn widget(&self) -> &gtk::Widget {
        self.root.upcast_ref()
    }

    pub fn connect_tab_selected(&self, f: impl Fn(Tab) + 'static) {
        *self.on_tab.borrow_mut() = Some(Box::new(f));
    }

    pub fn connect_nvim_toggled(&self, f: impl Fn(bool) + 'static) {
        *self.on_nvim.borrow_mut() = Some(Box::new(f));
    }

    /// Point the toolbar at a workspace (or `None` for the empty state). Reads
    /// the repo's run-script config and refreshes every chip/button.
    pub fn set_workspace(&self, ws: Option<Workspace>) {
        let has_run = ws
            .as_ref()
            .map(|w| self.repo_has_run_script(&w.repo_path))
            .unwrap_or(false);
        {
            let mut st = self.state.borrow_mut();
            st.ws = ws;
            st.has_run = has_run;
            // Reset per-workspace, backend-derived state; the pane re-polls.
            st.open_pr = None;
            st.run_live = false;
            // Scratch-like sessions have only the Terminal tab; snap back to it
            // so a Diff/Run selection doesn't leave the pane blank (App.tsx).
            if st.ws.as_ref().is_some_and(|w| w.is_scratch_like()) && st.active_tab != Tab::Terminal
            {
                st.active_tab = Tab::Terminal;
            }
            // The Run tab stays selectable without a run script (it shows the
            // setup guidance), so a missing script no longer snaps away from
            // it — only scratch-like workspaces, handled above, do.
        }
        self.merge_pill.set_reveal_child(false);
        self.apply_state();
        // Surface the (possibly clamped) active tab to the pane.
        let tab = self.state.borrow().active_tab;
        self.emit_tab(tab);
    }

    /// Whether the active workspace's repo has a `run` script configured — the
    /// pane reads this to choose the run pane vs the setup guidance.
    pub fn has_run_script(&self) -> bool {
        self.state.borrow().has_run
    }

    /// The currently selected tab (the pane reads this to restore its stack on
    /// workspace switch — the view is a single global, mirroring Electron).
    pub fn active_tab(&self) -> Tab {
        self.state.borrow().active_tab
    }

    /// Feed the Diff-tab +/- indicator from a `getDiffStats` poll.
    pub fn set_diff_stats(&self, stats: Option<&DiffStats>) {
        match stats {
            Some(s) if s.additions > 0 || s.deletions > 0 => {
                let mut parts = Vec::new();
                if s.additions > 0 {
                    parts.push(format!("+{}", s.additions));
                }
                if s.deletions > 0 {
                    parts.push(format!("−{}", s.deletions));
                }
                self.diff_indicator.set_label(&parts.join(" "));
                self.diff_indicator.set_visible(true);
            }
            _ => self.diff_indicator.set_visible(false),
        }
    }

    /// Feed the run-toggle from a `runScriptStatus` result / `ptyExit` event.
    pub fn set_run_live(&self, live: bool) {
        self.state.borrow_mut().run_live = live;
        self.sync_run_toggle();
    }

    /// Feed the PR button from a `findPR` poll.
    pub fn set_prs(&self, prs: Option<&PrsForBranch>) {
        self.state.borrow_mut().open_pr = prs.and_then(|p| p.open.clone());
        self.sync_pr_button();
    }

    fn current_ws_id(&self) -> Option<String> {
        self.state.borrow().ws.as_ref().map(|w| w.id.clone())
    }

    fn repo_has_run_script(&self, repo_path: &str) -> bool {
        // getRepoScripts(repoPath) → RepoScripts; run present == has run.
        self.ctx
            .call_typed::<RepoScripts>("getRepoScripts", vec![json!(repo_path)])
            .map(|s| s.run.is_some())
            .unwrap_or(false)
    }

    // ---- event wiring ------------------------------------------------------

    fn wire(self: &Rc<Self>) {
        // Branch popover: load branches when opened, pick → switchBranch.
        {
            let this = Rc::downgrade(self);
            self.branch_popover.connect_map(move |_| {
                if let Some(this) = this.upgrade() {
                    this.load_branches();
                }
            });
        }
        {
            let this = Rc::downgrade(self);
            self.branch_panel.connect_pick(move |branch| {
                if let Some(this) = this.upgrade() {
                    this.switch_branch(branch);
                }
            });
        }

        // Tabs.
        for (btn, tab) in [
            (&self.tab_terminal, Tab::Terminal),
            (&self.tab_diff, Tab::Diff),
            (&self.tab_run, Tab::Run),
        ] {
            let this = Rc::downgrade(self);
            btn.connect_toggled(move |b| {
                let Some(this) = this.upgrade() else { return };
                if this.syncing_tabs.get() || !b.is_active() {
                    return;
                }
                this.state.borrow_mut().active_tab = tab;
                this.emit_tab(tab);
            });
        }

        // Restart (confirm when running). We didn't keep a handle to the
        // button; look it up by name so the struct stays lean (direct child of
        // `root`).
        if let Some(btn) = self.find_button("restart-btn") {
            let this = Rc::downgrade(self);
            btn.connect_clicked(move |_| {
                if let Some(this) = this.upgrade() {
                    this.on_restart();
                }
            });
        }

        // Run toggle.
        {
            let this = Rc::downgrade(self);
            self.run_toggle.connect_clicked(move |_| {
                if let Some(this) = this.upgrade() {
                    this.on_toggle_run();
                }
            });
        }

        // PR button.
        {
            let this = Rc::downgrade(self);
            self.pr_btn.connect_clicked(move |_| {
                if let Some(this) = this.upgrade() {
                    this.on_pr();
                }
            });
        }

        // Merge button.
        {
            let this = Rc::downgrade(self);
            self.merge_btn.connect_clicked(move |_| {
                if let Some(this) = this.upgrade() {
                    this.on_merge();
                }
            });
        }

        // Nvim / file-pane toggle.
        {
            let this = Rc::downgrade(self);
            self.nvim_toggle.connect_toggled(move |b| {
                let Some(this) = this.upgrade() else { return };
                let open = b.is_active();
                this.state.borrow_mut().nvim_open = open;
                b.set_tooltip_text(Some(if open {
                    "Hide file pane"
                } else {
                    "Show file pane"
                }));
                let cb = this.on_nvim.borrow();
                if let Some(f) = cb.as_ref() {
                    f(open);
                }
                drop(cb);
            });
        }
    }

    fn find_button(&self, name: &str) -> Option<gtk::Button> {
        let mut child = self.root.first_child();
        while let Some(c) = child {
            if c.widget_name() == name {
                return c.downcast::<gtk::Button>().ok();
            }
            child = c.next_sibling();
        }
        None
    }

    fn emit_tab(&self, tab: Tab) {
        if let Some(f) = self.on_tab.borrow().as_ref() {
            f(tab);
        }
    }

    // ---- branch switching --------------------------------------------------

    fn load_branches(self: &Rc<Self>) {
        let Some(ws) = self.state.borrow().ws.clone() else {
            return;
        };
        self.branch_panel.reset();
        self.branch_panel.set_highlight(Some(&ws.branch));
        self.branch_panel.focus_search();
        // listBranches(WORKSPACE ID) → string[]: the handler resolves repoPath
        // from the workspace itself (api-handlers.ts:749) and throws
        // "workspace not found" for anything else — passing repo_path here
        // broke the picker against every real backend. Current-first is the
        // panel's job via set_highlight; it sorts the highlighted branch first.
        match self
            .ctx
            .call_typed::<Vec<String>>("listBranches", vec![json!(ws.id)])
        {
            Ok(branches) => self.branch_panel.set_branches(Some(branches)),
            Err(e) => {
                self.branch_panel.set_branches(Some(Vec::new()));
                self.branch_panel.set_error(Some(&e));
            }
        }
    }

    fn switch_branch(self: &Rc<Self>, branch: String) {
        let Some(ws) = self.state.borrow().ws.clone() else {
            return;
        };
        if branch == ws.branch {
            self.branch_popover.popdown();
            return;
        }
        self.branch_panel.set_busy(true);
        // switchBranch(id, branch) → Workspace (the updated record).
        let result: Result<Workspace, String> = self
            .ctx
            .call_typed("switchBranch", vec![json!(ws.id), json!(branch)]);
        self.branch_panel.set_busy(false);
        match result {
            Ok(updated) => {
                self.branch_popover.popdown();
                self.state.borrow_mut().ws = Some(updated.clone());
                self.apply_state();
                // Every surface (sidebar row, this pane) sees the new branch.
                self.ctx.notify_workspace_mutated(updated);
            }
            Err(e) => self.branch_panel.set_error(Some(&e)),
        }
    }

    // ---- restart -----------------------------------------------------------

    fn on_restart(self: &Rc<Self>) {
        let Some(ws) = self.state.borrow().ws.clone() else {
            return;
        };
        let ctx = self.ctx.clone();
        let running = ws.status == WorkspaceStatus::Running;
        let win = self.ctx.window.clone();
        glib::spawn_future_local(async move {
            if running {
                let ok = dialogs::confirm(
                    &win,
                    "Restart agent?",
                    &format!(
                        "{} is mid-turn. Restarting will kill the current response.\n\n\
                         The conversation resumes via `claude --continue`, but in-flight \
                         output is lost.",
                        ws.branch
                    ),
                )
                .await;
                if !ok {
                    return;
                }
            }
            if let Err(e) = ctx.call("restartAgent", vec![json!(ws.id)]) {
                dialogs::error(
                    &win,
                    "Restart failed",
                    &format!("Could not restart agent: {e}"),
                )
                .await;
            }
        });
    }

    // ---- run toggle --------------------------------------------------------

    fn on_toggle_run(self: &Rc<Self>) {
        let Some(id) = self.current_ws_id() else {
            return;
        };
        let live = self.state.borrow().run_live;
        let result = if live {
            self.ctx.call("runScriptStop", vec![json!(id)])
        } else {
            // Sane default dims; the Run panel resizes the pty idempotently
            // when the user opens it (App.tsx onToggleRun).
            self.ctx
                .call("runScriptStart", vec![json!(id), json!(80), json!(24)])
        };
        match result {
            Ok(_) => self.set_run_live(!live),
            Err(e) => {
                let win = self.ctx.window.clone();
                let verb = if live { "stop" } else { "start" };
                glib::spawn_future_local(async move {
                    dialogs::error(
                        &win,
                        "Run script",
                        &format!("Could not {verb} run script: {e}"),
                    )
                    .await;
                });
            }
        }
    }

    // ---- PR ---------------------------------------------------------------

    fn on_pr(self: &Rc<Self>) {
        let (open_pr, ws) = {
            let st = self.state.borrow();
            (st.open_pr.clone(), st.ws.clone())
        };
        let Some(ws) = ws else { return };
        match open_pr {
            // Open PR exists → open it locally (frontend-local openExternal).
            Some(pr) => self.ctx.open_external(&pr.url),
            // No PR → inject the create-a-PR prompt into the agent's PTY, then
            // send Enter as a separate keystroke 80 ms later so Claude's TUI
            // submits it (App.tsx: type, then '\r').
            None => {
                self.ctx.pty_write(&ws.id, PR_PROMPT.as_bytes());
                let ctx = self.ctx.clone();
                let id = ws.id.clone();
                glib::timeout_add_local_once(std::time::Duration::from_millis(80), move || {
                    ctx.pty_write(&id, b"\r");
                });
            }
        }
    }

    // ---- merge -------------------------------------------------------------

    fn on_merge(self: &Rc<Self>) {
        let Some(ws) = self.state.borrow().ws.clone() else {
            return;
        };
        let ctx = self.ctx.clone();
        let win = self.ctx.window.clone();
        let merge_pill = self.merge_pill.clone();
        glib::spawn_future_local(async move {
            let ok = dialogs::confirm(
                &win,
                "Merge worktree?",
                &format!(
                    "Merge {} into {}?\n\n\
                     The agent commits any pending changes, merges the branch into \
                     its base, and pushes.",
                    ws.branch, ws.base_branch
                ),
            )
            .await;
            if !ok {
                return;
            }
            // mergeWorktree(id) → {"status":"requested"}; the AGENT performs
            // the merge (index.ts delegates via a PTY prompt).
            match ctx.call("mergeWorktree", vec![json!(ws.id)]) {
                Ok(_) => {
                    merge_pill.set_reveal_child(true);
                    // Auto-hide the transient confirmation after ~6 s.
                    let pill = merge_pill.clone();
                    glib::timeout_add_seconds_local_once(6, move || {
                        pill.set_reveal_child(false);
                    });
                }
                Err(e) => {
                    dialogs::error(
                        &win,
                        "Merge failed",
                        &format!("Could not request merge: {e}"),
                    )
                    .await;
                }
            }
        });
    }

    // ---- rendering ---------------------------------------------------------

    /// Show exactly the widgets the current workspace warrants and refresh
    /// every chip/label. Idempotent — called on set_workspace and after any
    /// state mutation.
    fn apply_state(&self) {
        let st = self.state.borrow();
        let Some(ws) = st.ws.as_ref() else {
            // Empty state: hide everything but keep the toolbar row present.
            self.orchestrator_chip.set_visible(false);
            self.scratch_chip.set_visible(false);
            self.git_title.set_visible(false);
            self.tab_diff.set_visible(false);
            self.tab_run.set_visible(false);
            self.run_toggle.set_visible(false);
            self.pr_btn.set_visible(false);
            self.merge_btn.set_visible(false);
            self.nvim_toggle.set_visible(false);
            return;
        };

        let kind = ws.kind.unwrap_or(WorkspaceKind::Worktree);
        let is_orchestrator = kind == WorkspaceKind::Orchestrator;
        let is_scratch = kind == WorkspaceKind::Scratch;
        let is_scratch_like = ws.is_scratch_like();

        // Title chips: exactly one layout.
        self.orchestrator_chip.set_visible(is_orchestrator);
        self.scratch_chip.set_visible(is_scratch);
        self.git_title.set_visible(!is_scratch_like);
        if is_orchestrator {
            self.chip_text_orchestrator.set_label(&ws.branch);
        } else if is_scratch {
            self.chip_text_scratch.set_label(&ws.branch);
        } else {
            self.base_chip_text.set_label(&ws.base_branch);
            self.branch_btn_label.set_label(&ws.branch);
            self.branch_btn
                .set_tooltip_text(Some(&format!("base branch: {}", ws.base_branch)));
        }

        // Tabs: Diff + Run are git-only. The Run TAB stays visible even without
        // a run script (App.tsx:478) — it's the only affordance that leads a
        // user to the scripts entry point, so hiding it removes the discovery
        // path; it just wears a dim "· setup" hint and a learn-more tooltip.
        self.tab_diff.set_visible(!is_scratch_like);
        self.tab_run.set_visible(!is_scratch_like);
        self.run_tab_hint.set_visible(!st.has_run);
        self.tab_run.set_tooltip_text(Some(if st.has_run {
            "Spawn the configured run script (dev server, etc.)"
        } else {
            "No run script configured for this repo — click to learn more"
        }));

        // Action buttons: PR / merge are git-only. The run TOGGLE stays gated
        // on has_run — a ▶ with no script to spawn would be meaningless.
        self.run_toggle.set_visible(!is_scratch_like && st.has_run);
        self.pr_btn.set_visible(!is_scratch_like);
        self.merge_btn.set_visible(!is_scratch_like);
        self.nvim_toggle.set_visible(true);

        drop(st);
        self.sync_tabs();
        self.sync_run_toggle();
        self.sync_pr_button();
    }

    /// Push the model's active tab onto the ToggleButtons without re-emitting.
    fn sync_tabs(&self) {
        let tab = self.state.borrow().active_tab;
        self.syncing_tabs.set(true);
        self.tab_terminal.set_active(tab == Tab::Terminal);
        self.tab_diff.set_active(tab == Tab::Diff);
        self.tab_run.set_active(tab == Tab::Run);
        self.syncing_tabs.set(false);
    }

    fn sync_run_toggle(&self) {
        let live = self.state.borrow().run_live;
        // Both arms name our own assets. They previously swapped to the stock
        // `media-playback-*-symbolic` pair, so the button rendered our play
        // triangle at construction and then jumped to a system-theme icon of a
        // different shape and weight the first time the run state changed —
        // a mismatch only visible after driving the toggle.
        if live {
            self.run_toggle_icon.set_icon_name(Some(icons::STOP));
            self.run_toggle.add_css_class("running");
            self.run_toggle
                .set_tooltip_text(Some("Stop the run script"));
        } else {
            self.run_toggle_icon.set_icon_name(Some(icons::PLAY));
            self.run_toggle.remove_css_class("running");
            self.run_toggle
                .set_tooltip_text(Some("Run the app (run script)"));
        }
    }

    /// Refresh the PR button's label, tone and trailing arrow.
    ///
    /// Sets `pr_label`, never `pr_btn.set_label()`: the button's child is our
    /// own icon+label+arrow box (Electron draws those two icons as `::before`
    /// / `::after` masks, which GTK4 cannot do), and `set_label` REPLACES the
    /// child with a plain label — silently discarding both icons. That failure
    /// looks like "the icons never worked" rather than "something removed
    /// them", so it is worth the explicit note.
    fn sync_pr_button(&self) {
        let st = self.state.borrow();
        match &st.open_pr {
            // OPEN PR → "PR #N" primary link. This is the arm that opens a URL,
            // so it is the only one showing the external-link arrow
            // (styles.css:228 hides it for .pr-link-create).
            Some(pr) if pr.state == PrState::Open => {
                self.pr_label.set_label(&format!("PR #{}", pr.number));
                self.pr_ext.set_visible(true);
                self.pr_btn.add_css_class("primary");
                self.pr_btn.remove_css_class("pr-link-create");
                self.pr_btn.remove_css_class("primed");
                self.pr_btn
                    .set_tooltip_text(Some(&format!("OPEN · {}", pr.title)));
            }
            // No open PR → prime when there are unpushed commits. This arm
            // submits a prompt rather than opening a URL, so no arrow.
            _ => {
                let unpushed = st.ws.as_ref().and_then(|w| w.unpushed_ahead).unwrap_or(0);
                let primed = unpushed > 0;
                self.pr_ext.set_visible(false);
                self.pr_btn.remove_css_class("primary");
                self.pr_btn.add_css_class("pr-link-create");
                if primed {
                    self.pr_label.set_label(&format!("Open PR · ↑{unpushed}"));
                    self.pr_btn.add_css_class("primed");
                    self.pr_btn.set_tooltip_text(Some(&format!(
                        "{unpushed} commit{} ready to push — ask the agent to push and open a PR",
                        if unpushed == 1 { "" } else { "s" }
                    )));
                } else {
                    self.pr_label.set_label("Open PR");
                    self.pr_btn.remove_css_class("primed");
                    self.pr_btn
                        .set_tooltip_text(Some("Ask the focused Claude Code agent to create a PR"));
                }
            }
        }
    }
}
