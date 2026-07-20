//! Full-pane overlays (plan §5.3/§5.5/§5.6): Resources, Insights, and Help.
//!
//! Each overlay is a widget that mounts into A3's `overlay-host` `gtk::Overlay`
//! (app.rs) on top of the main area — never unmounting it. The [`Overlays`]
//! controller owns all three, enforces the mutual-exclusion rules (Help and
//! Insights are mutually exclusive; Escape closes the topmost), and routes the
//! backend events each one needs.
//!
//! The overlays share the backend as an `Rc<dyn Backend>` so the 2s Resources
//! poll and the Insights streaming subscription can each hold their own clone.

pub mod help;
pub mod insights;
pub mod resources;
pub mod support;

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gtk::prelude::*;

use crate::backend::Backend;
use crate::sound::SoundPlayer;
use crate::state::UiState;

/// Which overlay (if any) is currently shown. Resources is independent of the
/// Help/Insights pair; opening either of those closes the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayKind {
    Resources,
    Insights,
    Help,
}

/// Owns the three overlays and mounts them into the shared overlay host.
pub struct Overlays {
    resources: Rc<resources::ResourcesOverlay>,
    insights: Rc<insights::InsightsOverlay>,
    help: help::HelpOverlay,
    /// The overlay currently on top, if any.
    active: Rc<Cell<Option<OverlayKind>>>,
}

impl Overlays {
    /// Build the overlays and add them (hidden) to the host. `state`/`player`
    /// are shared with the app so the Insights sound picker and persistence
    /// use the same instances.
    pub fn new(
        host: &gtk::Overlay,
        backend: Rc<dyn Backend>,
        state: Rc<RefCell<UiState>>,
        player: Rc<SoundPlayer>,
    ) -> Rc<Self> {
        let resources = resources::ResourcesOverlay::new(backend.clone());
        let insights = insights::InsightsOverlay::new(backend.clone(), state, player);
        let help = help::HelpOverlay::new();

        host.add_overlay(resources.widget());
        host.add_overlay(insights.widget());
        host.add_overlay(help.widget());

        let overlays = Rc::new(Self {
            resources,
            insights,
            help,
            active: Rc::new(Cell::new(None)),
        });

        // Each overlay's own close button routes back through the controller
        // so `active` stays in sync.
        overlays.resources.on_close({
            let o = overlays.clone();
            move || o.close()
        });
        overlays.insights.on_close({
            let o = overlays.clone();
            move || o.close()
        });
        overlays.help.on_close({
            let o = overlays.clone();
            move || o.close()
        });

        overlays
    }

    /// Remove all three overlays from the host they were added to.
    ///
    /// The counterpart to the `add_overlay` calls in [`Overlays::new`]: a
    /// backend that disconnects tears its overlays down so the reconnect's
    /// fresh attach can mount a new set, rather than stacking another three
    /// on top of the main pane each time.
    pub fn unmount(&self, host: &gtk::Overlay) {
        host.remove_overlay(self.resources.widget());
        host.remove_overlay(self.insights.widget());
        host.remove_overlay(self.help.widget());
    }

    pub fn active(&self) -> Option<OverlayKind> {
        self.active.get()
    }

    /// Toggle an overlay: showing it if hidden, hiding it if it's the active
    /// one. Opening Help or Insights closes the other (mutual exclusion).
    pub fn toggle(&self, kind: OverlayKind) {
        if self.active.get() == Some(kind) {
            self.close();
        } else {
            self.open(kind);
        }
    }

    pub fn open(&self, kind: OverlayKind) {
        // Hide whatever is up first (also enforces Help/Insights exclusion).
        self.hide_all();
        match kind {
            OverlayKind::Resources => {
                self.resources.widget().set_visible(true);
                self.resources.on_shown();
            }
            OverlayKind::Insights => {
                self.insights.widget().set_visible(true);
                self.insights.on_shown();
            }
            OverlayKind::Help => self.help.widget().set_visible(true),
        }
        self.active.set(Some(kind));
    }

    pub fn close(&self) {
        self.hide_all();
        self.active.set(None);
    }

    fn hide_all(&self) {
        self.resources.widget().set_visible(false);
        self.resources.on_hidden();
        self.insights.widget().set_visible(false);
        self.insights.on_hidden();
        self.help.widget().set_visible(false);
    }

    /// Route a backend event to whichever overlay consumes it (Insights owns
    /// the self-tune stream). Resources polls rather than subscribing.
    pub fn dispatch(&self, ev: &orchestra_rpc::events::UiEvent) {
        self.insights.dispatch(ev);
    }

    /// Escape handler: closes the topmost overlay, returns whether it consumed
    /// the key.
    pub fn on_escape(&self) -> bool {
        if self.active.get().is_some() {
            self.close();
            true
        } else {
            false
        }
    }
}
