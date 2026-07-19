//! Setup-script banner (plan §5.3, anchor `SetupBanner.tsx`): visible while the
//! worktree's setup script is running or has failed — or while the user has the
//! log panel open even after it succeeds. Running shows a spinner + "View log";
//! failed shows the error + "View log" + "Retry"; a still-open log after
//! success shows "Setup complete · Showing previous setup log".
//!
//! While the log is open it re-reads on a short timer so the tail keeps growing
//! as the script runs (`readSetupLog`, the Electron effect keyed on status).

use std::cell::RefCell;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use orchestra_rpc::types::{SetupStatus, Workspace};
use serde_json::json;

use crate::ctx::Ctx;

const LOG_POLL_SECS: u32 = 2;

struct State {
    ws: Option<Workspace>,
    log_open: bool,
    retrying: bool,
}

pub struct SetupBanner {
    ctx: Rc<Ctx>,
    state: Rc<RefCell<State>>,
    root: gtk::Box,
    row: gtk::Box,
    spinner: gtk::Spinner,
    icon_fail: gtk::Label,
    title: gtk::Label,
    sub: gtk::Label,
    view_log_btn: gtk::Button,
    retry_btn: gtk::Button,
    log_view: gtk::ScrolledWindow,
    log_label: gtk::Label,
}

impl SetupBanner {
    pub fn new(ctx: Rc<Ctx>) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.add_css_class("setup-banner");
        root.set_widget_name("setup-banner");
        root.set_visible(false);

        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        row.add_css_class("setup-banner-row");

        let spinner = gtk::Spinner::new();
        spinner.add_css_class("setup-banner-spinner");
        let icon_fail = gtk::Label::new(Some("!"));
        icon_fail.add_css_class("setup-banner-x");

        let text_box = gtk::Box::new(gtk::Orientation::Vertical, 1);
        text_box.set_hexpand(true);
        let title = gtk::Label::new(None);
        title.set_xalign(0.0);
        title.add_css_class("setup-banner-title");
        let sub = gtk::Label::new(None);
        sub.set_xalign(0.0);
        sub.set_ellipsize(gtk::pango::EllipsizeMode::End);
        sub.add_css_class("setup-banner-sub");
        text_box.append(&title);
        text_box.append(&sub);

        let view_log_btn = gtk::Button::with_label("View log");
        view_log_btn.set_widget_name("setup-view-log");
        let retry_btn = gtk::Button::with_label("Retry");
        retry_btn.add_css_class("primary");
        retry_btn.set_widget_name("setup-retry");

        row.append(&spinner);
        row.append(&icon_fail);
        row.append(&text_box);
        row.append(&view_log_btn);
        row.append(&retry_btn);

        let log_label = gtk::Label::new(None);
        log_label.set_xalign(0.0);
        log_label.set_yalign(0.0);
        log_label.set_selectable(true);
        log_label.set_wrap(false);
        log_label.add_css_class("setup-banner-log");
        log_label.set_widget_name("setup-banner-log");
        let log_view = gtk::ScrolledWindow::new();
        log_view.set_child(Some(&log_label));
        log_view.set_min_content_height(120);
        log_view.set_max_content_height(240);
        log_view.set_propagate_natural_height(true);
        log_view.set_visible(false);

        root.append(&row);
        root.append(&log_view);

        let banner = Rc::new(Self {
            ctx,
            state: Rc::new(RefCell::new(State {
                ws: None,
                log_open: false,
                retrying: false,
            })),
            root,
            row,
            spinner,
            icon_fail,
            title,
            sub,
            view_log_btn,
            retry_btn,
            log_view,
            log_label,
        });

        {
            let this = Rc::downgrade(&banner);
            banner.view_log_btn.connect_clicked(move |_| {
                if let Some(this) = this.upgrade() {
                    this.toggle_log();
                }
            });
        }
        {
            let this = Rc::downgrade(&banner);
            banner.retry_btn.connect_clicked(move |_| {
                if let Some(this) = this.upgrade() {
                    this.retry();
                }
            });
        }
        // Re-read the log tail while it's open and setup is still working.
        {
            let this = Rc::downgrade(&banner);
            glib::timeout_add_seconds_local(LOG_POLL_SECS, move || {
                let Some(this) = this.upgrade() else {
                    return glib::ControlFlow::Break;
                };
                let (open, running) = {
                    let st = this.state.borrow();
                    (
                        st.log_open,
                        st.ws.as_ref().and_then(|w| w.setup_status) == Some(SetupStatus::Running),
                    )
                };
                if open && running && this.ctx.window.is_visible() {
                    this.reload_log();
                }
                glib::ControlFlow::Continue
            });
        }

        banner
    }

    pub fn widget(&self) -> &gtk::Widget {
        self.root.upcast_ref()
    }

    pub fn set_workspace(&self, ws: Option<&Workspace>) {
        {
            let mut st = self.state.borrow_mut();
            let switched = st.ws.as_ref().map(|w| &w.id) != ws.map(|w| &w.id);
            st.ws = ws.cloned();
            if switched {
                st.log_open = false;
                st.retrying = false;
            }
        }
        self.render();
    }

    /// A `workspaceUpdate` for the current workspace — pick up setupStatus /
    /// setupError changes (drives the banner auto-hiding on success).
    pub fn on_workspace_changed(&self, ws: &Workspace) {
        let is_current = self
            .state
            .borrow()
            .ws
            .as_ref()
            .is_some_and(|w| w.id == ws.id);
        if !is_current {
            return;
        }
        self.state.borrow_mut().ws = Some(ws.clone());
        self.render();
        // Refresh the tail immediately on the final status flip.
        if self.state.borrow().log_open {
            self.reload_log();
        }
    }

    fn status(&self) -> Option<SetupStatus> {
        self.state.borrow().ws.as_ref().and_then(|w| w.setup_status)
    }

    fn toggle_log(&self) {
        let open = { self.state.borrow().log_open };
        if open {
            self.state.borrow_mut().log_open = false;
            self.render();
        } else {
            self.state.borrow_mut().log_open = true;
            self.reload_log();
            self.render();
        }
    }

    fn reload_log(&self) {
        let Some(id) = self.state.borrow().ws.as_ref().map(|w| w.id.clone()) else {
            return;
        };
        let text = match self
            .ctx
            .call_typed::<String>("readSetupLog", vec![json!(id)])
        {
            Ok(t) if !t.is_empty() => t,
            Ok(_) => "(no setup log captured yet)".into(),
            Err(e) => format!("failed to read setup log: {e}"),
        };
        self.log_label.set_label(&text);
        // Pin to the tail so a growing log tracks the newest output.
        let adj = self.log_view.vadjustment();
        glib::idle_add_local_once(move || {
            adj.set_value(adj.upper());
        });
    }

    fn retry(&self) {
        let Some(id) = self.state.borrow().ws.as_ref().map(|w| w.id.clone()) else {
            return;
        };
        {
            let mut st = self.state.borrow_mut();
            if st.retrying {
                return;
            }
            st.retrying = true;
        }
        self.render();
        let result = self.ctx.call("retrySetup", vec![json!(id)]);
        {
            let mut st = self.state.borrow_mut();
            st.retrying = false;
            if let Err(e) = &result {
                st.log_open = true;
                let prev = self.log_label.text();
                self.log_label
                    .set_label(&format!("{prev}\n\nretry failed: {e}"));
            }
        }
        // On success, the banner hides when the workspaceUpdate flips
        // setupStatus away from failed; nothing more to do here.
        self.render();
    }

    fn render(&self) {
        let status = self.status();
        let log_open = self.state.borrow().log_open;
        let retrying = self.state.borrow().retrying;
        let visible = matches!(
            status,
            Some(SetupStatus::Running) | Some(SetupStatus::Failed)
        ) || log_open;
        self.root.set_visible(visible);
        if !visible {
            return;
        }

        // Reset the status-token CSS class each render.
        for c in ["running", "failed", "ok"] {
            self.root.remove_css_class(c);
        }

        match status {
            Some(SetupStatus::Running) => {
                self.root.add_css_class("running");
                self.spinner.set_visible(true);
                self.spinner.start();
                self.icon_fail.set_visible(false);
                self.title.set_label("Running setup script…");
                self.sub.set_label("First-time setup for this worktree");
                self.retry_btn.set_visible(false);
            }
            Some(SetupStatus::Failed) => {
                self.root.add_css_class("failed");
                self.spinner.set_visible(false);
                self.spinner.stop();
                self.icon_fail.set_visible(true);
                self.title.set_label("Setup script failed");
                let err = self
                    .state
                    .borrow()
                    .ws
                    .as_ref()
                    .and_then(|w| w.setup_error.clone())
                    .unwrap_or_else(|| "see log for details".into());
                self.sub.set_label(&err);
                self.retry_btn.set_visible(true);
                self.retry_btn.set_sensitive(!retrying);
                self.retry_btn
                    .set_label(if retrying { "Retrying…" } else { "Retry" });
            }
            // Log kept open past success (ok / pending / none).
            _ => {
                self.root.add_css_class("ok");
                self.spinner.set_visible(false);
                self.spinner.stop();
                self.icon_fail.set_visible(false);
                self.title.set_label("Setup complete");
                self.sub.set_label("Showing previous setup log");
                self.retry_btn.set_visible(false);
            }
        }
        self.view_log_btn
            .set_label(if log_open { "Hide log" } else { "View log" });
        self.log_view.set_visible(log_open);
        let _ = &self.row; // row handle kept for tooling/tests
    }
}
