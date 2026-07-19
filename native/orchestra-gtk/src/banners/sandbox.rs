//! Sandbox read-only control bar (plan §5.3, anchor `SandboxControlBar.tsx`):
//! a sandbox accepts several attached machines but exactly one — the driver —
//! may type. When THIS machine is not the driver the bar names who is and
//! offers a take-over. Renders nothing for local workspaces, before the first
//! broadcast, or while we hold the drive.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::prelude::*;
use orchestra_rpc::types::{SandboxControlState, Workspace, WorkspaceHost};
use serde_json::json;

use crate::ctx::Ctx;

struct State {
    ws_id: Option<String>,
    /// The workspace's sandbox endpoint, if any (None = local → never shown).
    endpoint: Option<String>,
    control: Option<SandboxControlState>,
}

pub struct SandboxControlBar {
    ctx: Rc<Ctx>,
    state: Rc<RefCell<State>>,
    root: gtk::Box,
    text: gtk::Label,
}

impl SandboxControlBar {
    pub fn new(ctx: Rc<Ctx>) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        root.add_css_class("sandbox-control-bar");
        root.set_widget_name("sandbox-control-bar");
        root.set_visible(false);

        let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        dot.add_css_class("sandbox-control-dot");
        dot.set_valign(gtk::Align::Center);
        let text = gtk::Label::new(None);
        text.set_xalign(0.0);
        text.set_hexpand(true);
        text.set_wrap(true);
        text.add_css_class("sandbox-control-text");
        let take = gtk::Button::with_label("Take control");
        take.add_css_class("sandbox-control-take");
        take.set_widget_name("sandbox-take-control");
        take.set_tooltip_text(Some(
            "Make this machine the driver — the current driver becomes read-only",
        ));

        root.append(&dot);
        root.append(&text);
        root.append(&take);

        let bar = Rc::new(Self {
            ctx,
            state: Rc::new(RefCell::new(State {
                ws_id: None,
                endpoint: None,
                control: None,
            })),
            root,
            text,
        });

        {
            let this = Rc::downgrade(&bar);
            take.connect_clicked(move |_| {
                if let Some(this) = this.upgrade() {
                    this.take_control();
                }
            });
        }

        bar
    }

    pub fn widget(&self) -> &gtk::Widget {
        self.root.upcast_ref()
    }

    pub fn set_workspace(&self, ws: Option<&Workspace>) {
        let endpoint = ws.and_then(|w| match &w.host {
            Some(WorkspaceHost::Sandbox { endpoint }) => Some(endpoint.clone()),
            _ => None,
        });
        {
            let mut st = self.state.borrow_mut();
            st.ws_id = ws.map(|w| w.id.clone());
            st.endpoint = endpoint.clone();
            st.control = None;
        }
        // Seed from the manager's mirror (covers mounting after the broadcast).
        if let Some(id) = ws.map(|w| w.id.to_owned()) {
            if endpoint.is_some() {
                if let Ok(Some(state)) = self.ctx.call_typed::<Option<SandboxControlState>>(
                    "sandboxControlState",
                    vec![json!(id)],
                ) {
                    self.state.borrow_mut().control = Some(state);
                }
            }
        }
        self.render();
    }

    /// A `sandboxControl` event — apply it when it's for our endpoint (state is
    /// per ENDPOINT: one sandbox, one driver).
    pub fn on_control_event(&self, state: SandboxControlState) {
        let matches = self
            .state
            .borrow()
            .endpoint
            .as_deref()
            .is_some_and(|e| e == state.endpoint);
        if matches {
            self.state.borrow_mut().control = Some(state);
            self.render();
        }
    }

    fn take_control(&self) {
        if let Some(id) = self.state.borrow().ws_id.clone() {
            let _ = self.ctx.call("takeSandboxControl", vec![json!(id)]);
        }
    }

    fn render(&self) {
        let st = self.state.borrow();
        // Hidden for local workspaces, before the first broadcast, and while we
        // hold the drive.
        let visible = match (&st.endpoint, &st.control) {
            (Some(_), Some(c)) => !c.is_driver,
            _ => false,
        };
        self.root.set_visible(visible);
        if !visible {
            return;
        }
        let c = st.control.as_ref().unwrap();
        let label = match (&c.driver_id, &c.driver_name) {
            (Some(_), Some(name)) => format!("Read-only — {name} is driving this sandbox"),
            (Some(id), None) => format!("Read-only — {id} is driving this sandbox"),
            (None, _) => "Read-only — nobody is driving this sandbox".into(),
        };
        self.text.set_label(&label);
    }
}
