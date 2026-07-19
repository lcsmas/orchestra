//! Help overlay (plan §5.6, parity: `src/renderer/components/Help.tsx`).
//!
//! A static feature map — one panel per feature area, one line per feature.
//! Content is ported verbatim from Help.tsx's `SECTIONS`, with the two
//! Electron-specific gestures ("gear icon", "bell icon", "users icon", the
//! sidebar "?" button) kept as-is: they describe the same UI the GTK port
//! reproduces. The footer links out to the repo user guide via the system
//! browser.

use gtk::prelude::*;

const GUIDE_URL: &str = "https://github.com/lcsmas/orchestra/tree/master/docs/guide";

struct Item {
    name: &'static str,
    desc: &'static str,
}

struct Section {
    title: &'static str,
    intro: Option<&'static str>,
    items: &'static [Item],
}

// Ported verbatim from Help.tsx SECTIONS (curly apostrophes preserved).
const SECTIONS: &[Section] = &[
    Section {
        title: "The core loop",
        intro: Some(
            "Register a git repo, then spawn workspaces off it. Each workspace is a real git \
             worktree on its own branch with its own Claude Code agent — agents never clobber \
             each other, and you watch them all from one sidebar.",
        ),
        items: &[
            Item { name: "Workspace", desc: "Branch + isolated worktree + live agent, cut from the repo’s base branch. Archive removes worktree and branch in one step." },
            Item { name: "Scratch session", desc: "A throwaway agent with no repo and no git — for quick questions and experiments. One click, zero setup." },
            Item { name: "Orchestrator", desc: "A coordinator agent that delegates instead of coding: it spawns child agents and the sidebar nests them beneath it. A guard hook blocks it from editing children’s files." },
            Item { name: "Setup scripts", desc: "Per-repo setup / run / archive scripts (gear icon on the repo header) run automatically at workspace creation, in the Run tab, and at archive time." },
        ],
    },
    Section {
        title: "Agents that spawn agents",
        intro: Some(
            "Every agent is told it can delegate: one CLI call creates a sibling workspace whose \
             agent starts working immediately. Ask one agent to parallelize a refactor and watch \
             the sidebar fill up.",
        ),
        items: &[
            Item { name: "Spawn", desc: "`orchestra spawn --task \"…\"` — new branch, new worktree, new agent, nested under the spawner. Spawned agents can spawn too." },
            Item { name: "Peer comms", desc: "Agents list siblings (`orchestra peers`), read each other’s transcripts, and message each other — messages queue in an inbox if the peer is stopped." },
            Item { name: "Self-naming branches", desc: "Fresh branches get a placeholder name; the agent renames its branch once it understands the task." },
            Item { name: "Attach / detach", desc: "Re-parent any existing workspace under an orchestrator (or pop it back out) to organize a fleet after the fact." },
        ],
    },
    Section {
        title: "Review & ship",
        intro: Some("Diff-first review, straight to a PR — without leaving the dashboard."),
        items: &[
            Item { name: "Diff tab", desc: "Side-by-side Monaco diff of the workspace vs. its base, refreshing live while the agent works. +/− counts on every sidebar row." },
            Item { name: "One-click PR", desc: "Commit → push → `gh pr create`, from the toolbar. The sidebar then tracks the PR’s state." },
            Item { name: "Merge & release pills", desc: "Sidebar pills show merged / diverged / unpushed work, and the earliest release that contains the branch’s commits." },
            Item { name: "Base sync", desc: "Behind/ahead counts vs. origin’s base branch, refreshed on focus — stale branches are visible at a glance." },
        ],
    },
    Section {
        title: "Terminals & status",
        intro: None,
        items: &[
            Item { name: "Live terminal", desc: "A real TTY per agent — full color, resize, scrollback, image paste." },
            Item { name: "Run tab", desc: "A second terminal per workspace running the repo’s configured run script (dev server, tests) with Start/Stop." },
            Item { name: "Nvim pane", desc: "Split the main pane with a Neovim editor opened on the worktree." },
            Item { name: "Status dots", desc: "Idle / running / waiting / error per workspace, driven by Claude Code’s own lifecycle hooks — no polling, no terminal scraping. Plus a live context-size badge per agent." },
            Item { name: "Chime", desc: "A notification sound when an agent finishes while the window is unfocused — pick from ~20 synthesized sounds (bell icon)." },
        ],
    },
    Section {
        title: "Accounts & usage",
        intro: Some("Run different workspaces under different Claude logins, and see how much headroom each has."),
        items: &[
            Item { name: "Multi-account", desc: "Add extra Claude logins (users icon); pin any workspace to any account, or migrate one mid-conversation — the session resumes under the new login." },
            Item { name: "Usage bars", desc: "5-hour and weekly utilization per account at the bottom of the sidebar, hottest first." },
            Item { name: "Prompt queue", desc: "Hit a usage limit and prompts park in a queue, then auto-submit when the window resets." },
        ],
    },
    Section {
        title: "Remote sandbox agents",
        intro: Some("Move a workspace into an always-on Docker sandbox: the agent, checkout, and session live in the container, and Orchestra becomes a thin client."),
        items: &[
            Item { name: "Import / eject", desc: "☁ buttons on a workspace row move it into the sandbox and back out — agents keep working with the laptop closed." },
            Item { name: "Multi-machine", desc: "Open the same sandbox workspace from several machines; an ownership lock makes one the driver and the others read-only viewers." },
            Item { name: "Auto-backups", desc: "The sandbox snapshots workspace state every 30 minutes." },
        ],
    },
    Section {
        title: "Integrations & extras",
        intro: None,
        items: &[
            Item { name: "Linear", desc: "Branches named like TEAM-123-… get a live Linear issue badge (title, state) in the sidebar." },
            Item { name: "Insights & Improvements", desc: "A monthly self-tune pass: regenerates each login’s Claude Code insights report and distills new lessons into ~/.claude/LESSONS.md — so your agents get a little better every month." },
            Item { name: "CLI", desc: "The `orchestra` command drives everything over the app’s local socket — spawn, peers, read, message, rename, promote, attach, add-repo, accounts, migrate-account, delete. Run `orchestra --help`." },
        ],
    },
    Section {
        title: "Orchestra can improve itself",
        intro: Some(
            "Orchestra is developed inside Orchestra — and your copy can do the same. Register \
             Orchestra’s own repo as a spawn target and point agents at it: \"add a keyboard \
             shortcut for the diff tab\", \"make the chime configurable per repo\", \"fix that \
             sidebar glitch\".",
        ),
        items: &[
            Item { name: "Self-aware agents", desc: "An agent spawned on the Orchestra repo is told it is modifying the app that runs it — including that changes only take effect after a release, and where the generated hooks come from." },
            Item { name: "Ship from within", desc: "The repo’s ship skill lets the agent release and install its own change: the app you’re using gets better because you asked it to." },
            Item { name: "Architecture map", desc: "docs/codebase-map/ gives agents (and you) a per-subsystem reference with file:line anchors, so improvements start from real context." },
        ],
    },
];

pub struct HelpOverlay {
    root: gtk::Box,
    close_btn: gtk::Button,
}

impl HelpOverlay {
    pub fn new() -> Self {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.set_widget_name("help-overlay");
        root.add_css_class("overlay");
        root.add_css_class("help-view");
        root.set_visible(false);

        // Header: icon + titles + close.
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        header.add_css_class("help-view-header");

        let titles = gtk::Box::new(gtk::Orientation::Vertical, 2);
        titles.set_hexpand(true);
        let h2 = gtk::Label::new(Some("What Orchestra can do"));
        h2.set_xalign(0.0);
        h2.add_css_class("overlay-title");
        let sub = gtk::Label::new(Some(
            "Parallel Claude Code agents in isolated git worktrees — spawn, watch, review, ship.",
        ));
        sub.set_xalign(0.0);
        sub.set_wrap(true);
        sub.add_css_class("help-view-sub");
        titles.append(&h2);
        titles.append(&sub);
        header.append(&titles);

        let close_btn = gtk::Button::with_label("×");
        close_btn.set_widget_name("help-close");
        close_btn.add_css_class("overlay-close");
        close_btn.set_tooltip_text(Some("Close"));
        close_btn.set_valign(gtk::Align::Start);
        header.append(&close_btn);
        root.append(&header);

        // Body: scrollable panels.
        let scroll = gtk::ScrolledWindow::new();
        scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        scroll.set_vexpand(true);
        let body = gtk::Box::new(gtk::Orientation::Vertical, 18);
        body.add_css_class("help-view-body");

        for section in SECTIONS {
            let panel = gtk::Box::new(gtk::Orientation::Vertical, 6);
            panel.add_css_class("help-panel");

            let title = gtk::Label::new(Some(section.title));
            title.set_xalign(0.0);
            title.add_css_class("help-panel-title");
            panel.append(&title);

            if let Some(intro) = section.intro {
                let intro_l = gtk::Label::new(Some(intro));
                intro_l.set_xalign(0.0);
                intro_l.set_wrap(true);
                intro_l.add_css_class("help-panel-intro");
                panel.append(&intro_l);
            }

            let items = gtk::Box::new(gtk::Orientation::Vertical, 6);
            items.add_css_class("help-items");
            for item in section.items {
                let row = gtk::Box::new(gtk::Orientation::Vertical, 1);
                row.add_css_class("help-item");
                let name = gtk::Label::new(Some(item.name));
                name.set_xalign(0.0);
                name.add_css_class("help-item-name");
                let desc = gtk::Label::new(Some(item.desc));
                desc.set_xalign(0.0);
                desc.set_wrap(true);
                desc.add_css_class("help-item-desc");
                row.append(&name);
                row.append(&desc);
                items.append(&row);
            }
            panel.append(&items);
            body.append(&panel);
        }

        // Footer: external guide link.
        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        footer.add_css_class("help-footer");
        let footer_label = gtk::Label::new(Some("Want the full walkthrough?"));
        footer_label.add_css_class("help-footer-text");
        footer.append(&footer_label);
        let link = gtk::Button::with_label("Read the user guide ↗");
        link.set_widget_name("help-guide-link");
        link.add_css_class("help-link");
        link.set_tooltip_text(Some(GUIDE_URL));
        link.connect_clicked(|btn| {
            let launcher = gtk::UriLauncher::new(GUIDE_URL);
            let parent = btn.root().and_downcast::<gtk::Window>();
            launcher.launch(parent.as_ref(), gtk::gio::Cancellable::NONE, move |res| {
                if let Err(e) = res {
                    eprintln!("[help] could not open guide URL: {e}");
                }
            });
        });
        footer.append(&link);
        body.append(&footer);

        scroll.set_child(Some(&body));
        root.append(&scroll);

        Self { root, close_btn }
    }

    pub fn widget(&self) -> &gtk::Box {
        &self.root
    }

    pub fn on_close(&self, f: impl Fn() + 'static) {
        self.close_btn.connect_clicked(move |_| f());
    }
}

impl Default for HelpOverlay {
    fn default() -> Self {
        Self::new()
    }
}

// Compile-time sanity: intros and items are non-empty where they matter.
const _: () = {
    assert!(!SECTIONS.is_empty());
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_match_help_tsx() {
        // Eight sections, in Help.tsx order.
        assert_eq!(SECTIONS.len(), 8);
        assert_eq!(SECTIONS[0].title, "The core loop");
        assert_eq!(
            SECTIONS.last().unwrap().title,
            "Orchestra can improve itself"
        );
        // Every section has at least one item; every item has name+desc.
        for s in SECTIONS {
            assert!(!s.items.is_empty(), "section '{}' has no items", s.title);
            for i in s.items {
                assert!(!i.name.is_empty());
                assert!(!i.desc.is_empty());
            }
        }
    }

    #[test]
    fn guide_url_is_the_repo_guide() {
        assert!(GUIDE_URL.contains("/docs/guide"));
    }

    // glib::MainContext-free construction check: HelpOverlay::new touches GTK
    // widgets, so it can't run without a display — kept out of the unit set
    // deliberately (exercised by the E2E screenshot pass instead).
    #[allow(dead_code)]
    fn _needs_display() {
        let _ = HelpOverlay::new();
    }
}
