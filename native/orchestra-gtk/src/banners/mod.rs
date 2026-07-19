//! Workspace-flow banners that stack above the main pane (plan §5.3): the
//! setup-script banner, the usage-limit / prompt-queue banner, and the sandbox
//! read-only control bar. Each mirrors its Electron component's visibility
//! rules exactly — they render only when they have something to say, so the
//! common case (a healthy local workspace) shows an empty strip.
//!
//! All three are plain widget trees the main pane owns and feeds; none is a
//! Relm4 component. [`Banners`] bundles them so the pane wires one thing.

pub mod queue;
pub mod sandbox;
pub mod setup;

use std::rc::Rc;

use gtk::prelude::*;
use orchestra_rpc::types::Workspace;

use crate::ctx::Ctx;
use queue::PromptQueueBanner;
use sandbox::SandboxControlBar;
use setup::SetupBanner;

/// The three banners in their stacking order (setup, then queue, then the
/// sandbox bar) — the same top-to-bottom order as the Electron pane.
pub struct Banners {
    root: gtk::Box,
    setup: Rc<SetupBanner>,
    queue: Rc<PromptQueueBanner>,
    sandbox: Rc<SandboxControlBar>,
}

impl Banners {
    pub fn new(ctx: Rc<Ctx>) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.set_widget_name("main-banners");

        let setup = SetupBanner::new(ctx.clone());
        let queue = PromptQueueBanner::new(ctx.clone());
        let sandbox = SandboxControlBar::new(ctx.clone());

        root.append(setup.widget());
        root.append(queue.widget());
        root.append(sandbox.widget());

        Rc::new(Self {
            root,
            setup,
            queue,
            sandbox,
        })
    }

    pub fn widget(&self) -> &gtk::Widget {
        self.root.upcast_ref()
    }

    /// Point every banner at the active workspace (or clear them for `None`).
    pub fn set_workspace(&self, ws: Option<&Workspace>) {
        self.setup.set_workspace(ws);
        self.queue.set_workspace(ws);
        self.sandbox.set_workspace(ws);
    }

    /// A workspace record changed (workspaceUpdate event / mutation): the
    /// setup + queue banners re-read from it (setupStatus, queuedPrompts).
    pub fn on_workspace_changed(&self, ws: &Workspace) {
        self.setup.on_workspace_changed(ws);
        self.queue.on_workspace_changed(ws);
    }

    /// A `sandboxControl` event arrived (channel `sandboxControl`): update the
    /// bar if it's for the active workspace's endpoint.
    pub fn on_sandbox_control(&self, state: orchestra_rpc::types::SandboxControlState) {
        self.sandbox.on_control_event(state);
    }
}
