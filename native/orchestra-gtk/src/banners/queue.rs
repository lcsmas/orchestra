//! Usage-limit / prompt-queue banner (plan §5.3, anchor `PromptQueueBanner.tsx`):
//! shown while the workspace's account is over its usage limit, or while any
//! prompts are still parked on the queue. Offers a composer that queues prompts
//! (`queuePrompt`); the backend's flusher delivers them once a fresh usage
//! reading shows the reset. Limit state comes from the pure port in
//! [`crate::usage_limit`] fed the freshest reading for this login — the pinned
//! account's `getAccountUsage`, or the default login's global `getUsage`.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use orchestra_rpc::types::{
    AccountUsageStatus, QueuedPrompt, UsageSnapshot, Workspace, WorkspaceAccount,
};
use serde_json::json;

use crate::ctx::Ctx;
use crate::usage_limit::{self, UsageWindows};

const COUNTDOWN_SECS: u32 = 30;

struct State {
    ws: Option<Workspace>,
    /// The workspace's resolved login label + pinned account id (getWorkspaceAccounts).
    account_label: String,
    account_id: Option<String>,
    /// (fetched_at_ms, windows) freshest usage for this login, if any.
    usage: Option<(i64, UsageWindows)>,
    busy: bool,
}

pub struct PromptQueueBanner {
    ctx: Rc<Ctx>,
    state: Rc<RefCell<State>>,
    root: gtk::Box,
    title: gtk::Label,
    sub: gtk::Label,
    send_now_btn: gtk::Button,
    list: gtk::ListBox,
    compose: gtk::TextView,
    queue_btn: gtk::Button,
    /// Weak self-handle so `&self` methods can hand per-row delete buttons a
    /// callback without threading an `Rc` through every call site.
    self_weak: RefCell<std::rc::Weak<Self>>,
}

impl PromptQueueBanner {
    pub fn new(ctx: Rc<Ctx>) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 6);
        root.add_css_class("queue-banner");
        root.set_widget_name("queue-banner");
        root.set_visible(false);

        // Header row: icon + text + "Send now".
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        row.add_css_class("queue-banner-row");
        let icon = gtk::Label::new(Some("⏳"));
        icon.add_css_class("queue-banner-icon");
        let text_box = gtk::Box::new(gtk::Orientation::Vertical, 1);
        text_box.set_hexpand(true);
        let title = gtk::Label::new(None);
        title.set_xalign(0.0);
        title.add_css_class("queue-banner-title");
        let sub = gtk::Label::new(None);
        sub.set_xalign(0.0);
        sub.set_wrap(true);
        sub.add_css_class("queue-banner-sub");
        text_box.append(&title);
        text_box.append(&sub);
        let send_now_btn = gtk::Button::with_label("Send now");
        send_now_btn.add_css_class("primary");
        send_now_btn.set_widget_name("queue-send-now");
        row.append(&icon);
        row.append(&text_box);
        row.append(&send_now_btn);

        // Queued-prompt list.
        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::None);
        list.add_css_class("queue-banner-list");
        list.set_widget_name("queue-banner-list");

        // Composer: multi-line entry + Queue button.
        let compose_row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        compose_row.add_css_class("queue-banner-compose");
        let compose = gtk::TextView::new();
        compose.set_widget_name("queue-compose");
        compose.set_accepts_tab(false);
        compose.set_wrap_mode(gtk::WrapMode::WordChar);
        compose.add_css_class("queue-banner-textarea");
        let compose_scroll = gtk::ScrolledWindow::new();
        compose_scroll.set_child(Some(&compose));
        compose_scroll.set_hexpand(true);
        compose_scroll.set_min_content_height(44);
        compose_scroll.set_max_content_height(120);
        let queue_btn = gtk::Button::with_label("Queue");
        queue_btn.set_widget_name("queue-add");
        queue_btn.set_valign(gtk::Align::End);
        compose_row.append(&compose_scroll);
        compose_row.append(&queue_btn);

        root.append(&row);
        root.append(&list);
        root.append(&compose_row);

        let banner = Rc::new(Self {
            ctx,
            state: Rc::new(RefCell::new(State {
                ws: None,
                account_label: "default".into(),
                account_id: None,
                usage: None,
                busy: false,
            })),
            root,
            title,
            sub,
            send_now_btn,
            list,
            compose,
            queue_btn,
            self_weak: RefCell::new(std::rc::Weak::new()),
        });
        *banner.self_weak.borrow_mut() = Rc::downgrade(&banner);

        {
            let this = Rc::downgrade(&banner);
            banner.queue_btn.connect_clicked(move |_| {
                if let Some(this) = this.upgrade() {
                    this.queue_draft();
                }
            });
        }
        {
            let this = Rc::downgrade(&banner);
            banner.send_now_btn.connect_clicked(move |_| {
                if let Some(this) = this.upgrade() {
                    this.send_now();
                }
            });
        }
        // Enter queues; Shift+Enter inserts a newline — the agent-TUI gesture.
        {
            let this = Rc::downgrade(&banner);
            let keys = gtk::EventControllerKey::new();
            keys.connect_key_pressed(move |_, key, _, mods| {
                let is_enter = matches!(key, gtk::gdk::Key::Return | gtk::gdk::Key::KP_Enter);
                let shift = mods.contains(gtk::gdk::ModifierType::SHIFT_MASK);
                if is_enter && !shift {
                    if let Some(this) = this.upgrade() {
                        this.queue_draft();
                    }
                    return glib::Propagation::Stop;
                }
                glib::Propagation::Proceed
            });
            banner.compose.add_controller(keys);
        }
        // Keep the countdown moving while visible; a minute of drift is fine.
        {
            let this = Rc::downgrade(&banner);
            glib::timeout_add_seconds_local(COUNTDOWN_SECS, move || {
                let Some(this) = this.upgrade() else {
                    return glib::ControlFlow::Break;
                };
                if this.root.is_visible() {
                    this.refresh_ui();
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
            st.ws = ws.cloned();
            st.account_label = "default".into();
            st.account_id = None;
            st.usage = None;
        }
        self.reload_account_and_usage();
        self.refresh_ui();
    }

    /// A `workspaceUpdate` for the current workspace — pick up queuedPrompts.
    pub fn on_workspace_changed(&self, ws: &Workspace) {
        let is_current = self
            .state
            .borrow()
            .ws
            .as_ref()
            .is_some_and(|w| w.id == ws.id);
        if is_current {
            self.state.borrow_mut().ws = Some(ws.clone());
            self.refresh_ui();
        }
    }

    fn queue(&self) -> Vec<QueuedPrompt> {
        self.state
            .borrow()
            .ws
            .as_ref()
            .and_then(|w| w.queued_prompts.clone())
            .unwrap_or_default()
    }

    /// Resolve this workspace's login and its freshest usage reading, mirroring
    /// the flusher's source selection: pinned account → per-account poller,
    /// default login → global poller.
    fn reload_account_and_usage(&self) {
        let Some(id) = self.state.borrow().ws.as_ref().map(|w| w.id.clone()) else {
            return;
        };
        // getWorkspaceAccounts() → WorkspaceAccount[]; find ours.
        if let Ok(accounts) = self
            .ctx
            .call_typed::<Vec<WorkspaceAccount>>("getWorkspaceAccounts", vec![])
        {
            if let Some(wa) = accounts.into_iter().find(|a| a.workspace_id == id) {
                let mut st = self.state.borrow_mut();
                st.account_label = wa.label;
                st.account_id = wa.account_id;
            }
        }
        let account_id = self.state.borrow().account_id.clone();
        let usage = match account_id {
            Some(acc) => self
                .ctx
                .call_typed::<AccountUsageStatus>("getAccountUsage", vec![json!(acc)])
                .ok()
                .and_then(|status| {
                    status
                        .data
                        .as_ref()
                        .map(|d| (status.fetched_at, UsageWindows::from(d)))
                }),
            None => self
                .ctx
                .call_typed::<UsageSnapshot>("getUsage", vec![])
                .ok()
                .map(|snap| (snap.fetched_at, UsageWindows::from(&snap))),
        };
        self.state.borrow_mut().usage = usage;
    }

    fn limited_until(&self, now: i64) -> Option<i64> {
        let st = self.state.borrow();
        st.usage
            .as_ref()
            .and_then(|(_, w)| usage_limit::usage_limited_until(w, now))
    }

    fn queue_draft(&self) {
        if self.state.borrow().busy {
            return;
        }
        let buf = self.compose.buffer();
        let text = buf
            .text(&buf.start_iter(), &buf.end_iter(), false)
            .trim()
            .to_string();
        let Some(id) = self.state.borrow().ws.as_ref().map(|w| w.id.clone()) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        self.state.borrow_mut().busy = true;
        let result = self.ctx.call("queuePrompt", vec![json!(id), json!(text)]);
        self.state.borrow_mut().busy = false;
        match result {
            Ok(_) => buf.set_text(""),
            Err(e) => self.error(&format!("Could not queue prompt: {e}")),
        }
        // The queue itself refreshes when the workspaceUpdate arrives; render
        // now so the busy state clears.
        self.refresh_ui();
    }

    fn send_now(&self) {
        if self.state.borrow().busy {
            return;
        }
        let Some(id) = self.state.borrow().ws.as_ref().map(|w| w.id.clone()) else {
            return;
        };
        self.state.borrow_mut().busy = true;
        // flushQueuedPrompts(id) → { ok, delivered, error? }.
        let result = self
            .ctx
            .call_typed::<orchestra_rpc::types::FlushQueuedPromptsResult>(
                "flushQueuedPrompts",
                vec![json!(id)],
            );
        self.state.borrow_mut().busy = false;
        match result {
            Ok(res) if !res.ok => self.error(&format!(
                "Could not send queued prompts: {}",
                res.error.as_deref().unwrap_or("unknown error")
            )),
            Ok(_) => {}
            Err(e) => self.error(&format!("Could not send queued prompts: {e}")),
        }
        self.refresh_ui();
    }

    fn remove(&self, prompt_id: &str) {
        let Some(id) = self.state.borrow().ws.as_ref().map(|w| w.id.clone()) else {
            return;
        };
        let _ = self
            .ctx
            .call("removeQueuedPrompt", vec![json!(id), json!(prompt_id)]);
        self.refresh_ui();
    }

    fn error(&self, msg: &str) {
        let win = self.ctx.window.clone();
        let msg = msg.to_owned();
        glib::spawn_future_local(async move {
            crate::dialogs::error(&win, "Prompt queue", &msg).await;
        });
    }

    fn refresh_ui(&self) {
        let now = usage_limit::now_ms();
        let limited_until = self.limited_until(now);
        let limited = limited_until.is_some();
        let queue = self.queue();
        let visible = limited || !queue.is_empty();
        self.root.set_visible(visible);
        if !visible {
            return;
        }
        if limited {
            self.root.add_css_class("limited");
        } else {
            self.root.remove_css_class("limited");
        }

        let label = self.state.borrow().account_label.clone();
        if limited {
            let resets = limited_until
                .map(|until| {
                    // format_resets_in takes an ISO string; feed it the target
                    // as an epoch by round-tripping through the parser's inverse
                    // is overkill — reuse the same "resets in …" wording via a
                    // direct duration format.
                    format_resets_in_ms(until, now)
                })
                .unwrap_or_default();
            let suffix = if resets.is_empty() {
                String::new()
            } else {
                format!(" — {resets}")
            };
            self.title
                .set_label(&format!("Usage limit reached ({label}){suffix}"));
            self.sub.set_label(
                "Queue prompts below — they're sent automatically when the limit resets.",
            );
        } else {
            let n = queue.len();
            self.title.set_label(&format!(
                "{n} queued prompt{}",
                if n == 1 { "" } else { "s" }
            ));
            self.sub
                .set_label("Sending automatically once a fresh usage check confirms the reset.");
        }
        self.send_now_btn.set_visible(!queue.is_empty());
        self.send_now_btn.set_sensitive(!self.state.borrow().busy);
        self.queue_btn.set_sensitive(!self.state.borrow().busy);

        // Rebuild the queued-prompt rows.
        self.list.set_visible(!queue.is_empty());
        while let Some(row) = self.list.row_at_index(0) {
            self.list.remove(&row);
        }
        for (i, p) in queue.iter().enumerate() {
            let row_box = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            row_box.add_css_class("queue-banner-item");
            let n = gtk::Label::new(Some(&format!("{}", i + 1)));
            n.add_css_class("queue-banner-item-n");
            let text = gtk::Label::new(Some(&p.text));
            text.set_xalign(0.0);
            text.set_hexpand(true);
            text.set_ellipsize(gtk::pango::EllipsizeMode::End);
            text.set_tooltip_text(Some(&p.text));
            text.add_css_class("queue-banner-item-text");
            let del = gtk::Button::with_label("✕");
            del.add_css_class("queue-banner-item-x");
            del.set_tooltip_text(Some("Remove from queue"));
            {
                let this = self.self_weak.borrow().clone();
                let pid = p.id.clone();
                del.connect_clicked(move |_| {
                    if let Some(this) = this.upgrade() {
                        this.remove(&pid);
                    }
                });
            }
            row_box.append(&n);
            row_box.append(&text);
            row_box.append(&del);
            let row = gtk::ListBoxRow::new();
            row.set_child(Some(&row_box));
            row.set_selectable(false);
            self.list.append(&row);
        }
    }
}

/// "resets in 1d 2h" / "2h 5m" / "12m" / "resets now" for an epoch-ms target —
/// the same wording as [`usage_limit::format_resets_in`], for a target we
/// already hold as ms (avoids an ISO round-trip).
fn format_resets_in_ms(target_ms: i64, now_ms: i64) -> String {
    let ms = target_ms - now_ms;
    if ms <= 0 {
        return "resets now".into();
    }
    let mins = ms / 60_000;
    let days = mins / 1440;
    let hours = (mins % 1440) / 60;
    let m = mins % 60;
    if days > 0 {
        format!("resets in {days}d {hours}h")
    } else if hours > 0 {
        format!("resets in {hours}h {m}m")
    } else {
        format!("resets in {m}m")
    }
}
