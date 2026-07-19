//! Per-workspace / per-repo account badges + the migrate menu, and the
//! context-size badge (`AccountBadge.tsx` port). These are the reusable
//! widgets the sidebar workstream mounts next to a workspace's branch name.
//!
//! Each badge is a live view over the controller's state: it registers a
//! repaint hook via [`AccountsController::add_render_listener`] and retints
//! itself whenever usage/account data changes, exactly like the Zustand
//! selectors the TS components subscribe to.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use serde_json::Value;

use orchestra_rpc::types::UsageSnapshot;

use super::logic::{
    age_text, clamp_pct, error_title, format_tokens, login_color_hex, severity, Severity,
    DEFAULT_LOGIN_LABEL,
};
use super::{AccountsController, AccountsState};

/// Shared tint-by-usage label. Mirrors `AccountUsageBadge` in the TS: resolves
/// the pinned account (or the default login) from state, then styles the label
/// by its hotter window with the full multi-line tooltip.
pub struct AccountUsageBadge {
    label: gtk::Label,
}

impl AccountUsageBadge {
    fn new() -> Self {
        let label = gtk::Label::new(None);
        label.add_css_class("account-badge");
        label.set_widget_name("account-badge");
        Self { label }
    }

    pub fn widget(&self) -> &gtk::Label {
        &self.label
    }

    /// Repaint for a given resolved account id (None = default login).
    fn render(&self, account_id: Option<&str>, state: &AccountsState, now_ms: i64) {
        // Reset transient state classes; keep the base "account-badge".
        for c in [
            "pending",
            "err",
            "usage",
            "sev-ok",
            "sev-warn",
            "sev-crit",
        ] {
            self.label.remove_css_class(c);
        }

        // No pinned account (or a dangling id) → default login badge.
        let label = account_id.and_then(|id| state.account_label(id));
        let Some((account_id, label)) = account_id.zip(label) else {
            self.render_default(state.global_usage.as_ref());
            return;
        };

        set_tinted(&self.label, &label, &Self::color_hex(&label));
        match state.account_usage.get(account_id) {
            None => {
                // First poll still in flight.
                self.label.add_css_class("pending");
                self.label
                    .set_tooltip_text(Some(&format!("{label}: fetching usage…")));
            }
            Some(u) => match &u.data {
                // No cached data → hard error (expired keeps last-good data
                // and falls through to the usage render below).
                None => {
                    self.label.add_css_class("err");
                    if let Some(kind) = u.error_kind {
                        self.label.add_css_class(kind_class(kind));
                    } else {
                        self.label.add_css_class("error");
                    }
                    self.label
                        .set_tooltip_text(Some(&error_title(&label, u.error_kind)));
                }
                Some(d) => {
                    let five = clamp_pct(d.five_hour.utilization);
                    let seven = clamp_pct(d.seven_day.utilization);
                    let sev = severity(five.max(seven));
                    self.label.add_css_class("usage");
                    set_sev_class(&self.label, sev);
                    let mut title = format!(
                        "{label} — Claude usage\n5-hour window: {five}%\n7-day window: {seven}%"
                    );
                    if let Some(extra) = d.extra_utilization {
                        title.push_str(&format!("\nextra usage: {}%", extra.round() as i64));
                    }
                    if u.expired.unwrap_or(false) {
                        title.push_str("\n⚠ token expired — re-login (showing cached usage)");
                    }
                    title.push_str(&format!("\nas of {}", age_text(u.fetched_at, now_ms)));
                    self.label.set_tooltip_text(Some(&title));
                }
            },
        }
    }

    /// The default-login badge: reads the global `~/.claude` poller (a bare
    /// `UsageSnapshot`, no error/extra fields).
    fn render_default(&self, usage: Option<&UsageSnapshot>) {
        set_tinted(
            &self.label,
            DEFAULT_LOGIN_LABEL,
            &Self::color_hex(DEFAULT_LOGIN_LABEL),
        );
        let Some(usage) = usage else {
            self.label.add_css_class("pending");
            self.label
                .set_tooltip_text(Some(&format!("{DEFAULT_LOGIN_LABEL}: fetching usage…")));
            return;
        };
        let five = clamp_pct(usage.five_hour.utilization);
        let seven = clamp_pct(usage.seven_day.utilization);
        let sev = severity(five.max(seven));
        self.label.add_css_class("usage");
        set_sev_class(&self.label, sev);
        self.label.set_tooltip_text(Some(&format!(
            "{DEFAULT_LOGIN_LABEL} — Claude usage (Orchestra's default login)\n\
             5-hour window: {five}%\n7-day window: {seven}%\nas of {}",
            age_text(usage.fetched_at, 0.max(usage.fetched_at))
        )));
    }

    /// The login color for markup use (`#rrggbb`), remembered so the label's
    /// text and color are set together via one `set_markup`.
    fn color_hex(name: &str) -> String {
        login_color_hex(name)
    }
}

/// Set a label's text tinted with `hex`, via Pango markup (labels support it;
/// it's the non-deprecated way to color one widget without a CSS provider).
fn set_tinted(label: &gtk::Label, text: &str, hex: &str) {
    label.set_markup(&format!(
        "<span foreground=\"{hex}\">{}</span>",
        glib::markup_escape_text(text)
    ));
}

fn kind_class(kind: orchestra_rpc::types::UsageErrorKind) -> &'static str {
    use orchestra_rpc::types::UsageErrorKind::*;
    match kind {
        NoDir => "no-dir",
        NotLoggedIn => "not-logged-in",
        NoScope => "no-scope",
        RateLimited => "rate-limited",
        Error => "error",
    }
}

fn set_sev_class(w: &impl IsA<gtk::Widget>, sev: Severity) {
    w.as_ref().add_css_class(&format!("sev-{}", sev.css()));
}

/// The clickable per-workspace account control (`WorkspaceAccountBadge` with
/// `migratable`). Renders the usage badge; clicking drops a menu of every
/// account plus the default login, and picking one migrates THIS workspace.
pub struct WorkspaceAccountMenu {
    root: gtk::MenuButton,
    badge: AccountUsageBadge,
    popover: gtk::Popover,
    list: gtk::Box,
    workspace_id: String,
    /// The account id this workspace currently resolves to (None = default),
    /// tracked so a migrate to the same account is a no-op.
    current: RefCell<Option<String>>,
}

impl WorkspaceAccountMenu {
    /// Build a migrate menu for `workspace_id` and wire it live to `ctrl`.
    pub fn new(ctrl: &Rc<AccountsController>, workspace_id: &str) -> Rc<Self> {
        let badge = AccountUsageBadge::new();
        let root = gtk::MenuButton::new();
        root.set_widget_name(&format!("ws-account-trigger-{workspace_id}"));
        root.add_css_class("ws-account-trigger");
        root.set_tooltip_text(Some(
            "Click to migrate this workspace to another account",
        ));
        root.set_child(Some(badge.widget()));

        let list = gtk::Box::new(gtk::Orientation::Vertical, 2);
        list.add_css_class("ws-account-popover");
        let popover = gtk::Popover::new();
        popover.set_widget_name("ws-account-popover");
        popover.set_child(Some(&list));
        root.set_popover(Some(&popover));

        let me = Rc::new(Self {
            root,
            badge,
            popover,
            list,
            workspace_id: workspace_id.to_string(),
            current: RefCell::new(None),
        });

        // Repaint badge + rebuild the option list on every store change.
        {
            let me = me.clone();
            let ctrl = ctrl.clone();
            ctrl.clone()
                .add_render_listener(Box::new(move |state, now| {
                    me.render(&ctrl, state, now);
                }));
        }
        me
    }

    pub fn widget(&self) -> &gtk::MenuButton {
        &self.root
    }

    fn render(&self, ctrl: &Rc<AccountsController>, state: &AccountsState, now_ms: i64) {
        let resolved = state
            .workspace_accounts
            .get(&self.workspace_id)
            .and_then(|w| w.account_id.clone());
        *self.current.borrow_mut() = resolved.clone();
        self.badge.render(resolved.as_deref(), state, now_ms);
        self.rebuild_options(ctrl, state, resolved.as_deref());
    }

    fn rebuild_options(
        &self,
        ctrl: &Rc<AccountsController>,
        state: &AccountsState,
        current: Option<&str>,
    ) {
        while let Some(child) = self.list.first_child() {
            self.list.remove(&child);
        }
        // Default login first, then every configured account.
        self.append_option(ctrl, None, DEFAULT_LOGIN_LABEL, current.is_none());
        for a in &state.accounts {
            let is_current = current == Some(a.id.as_str());
            self.append_option(ctrl, Some(a.id.clone()), &a.label, is_current);
        }
    }

    fn append_option(
        &self,
        ctrl: &Rc<AccountsController>,
        target_id: Option<String>,
        target_label: &str,
        is_current: bool,
    ) {
        let button = gtk::Button::new();
        button.add_css_class("ws-account-option");
        button.add_css_class("flat");
        if is_current {
            button.add_css_class("current");
        }
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        // Login-color dot as a tinted glyph (a CSS-provider background would be
        // deprecated per-widget styling; markup on a label is not).
        let dot = gtk::Label::new(None);
        dot.add_css_class("dot");
        dot.set_valign(gtk::Align::Center);
        dot.set_markup(&format!(
            "<span foreground=\"{}\">\u{25cf}</span>",
            login_color_hex(target_label)
        ));
        let name = gtk::Label::new(Some(target_label));
        name.add_css_class("ws-account-label");
        name.set_xalign(0.0);
        row.append(&dot);
        row.append(&name);
        button.set_child(Some(&row));

        let ctrl = ctrl.clone();
        let popover = self.popover.clone();
        let workspace_id = self.workspace_id.clone();
        let current = self.current.borrow().clone();
        let target_label = target_label.to_string();
        button.connect_clicked(move |_| {
            popover.popdown();
            // Same account → nothing to do.
            if current.as_deref() == target_id.as_deref() {
                return;
            }
            migrate(
                &ctrl,
                &workspace_id,
                target_id.clone(),
                &target_label,
            );
        });
        self.list.append(&button);
    }
}

/// Confirm → migrate → busy → error, mirroring `WorkspaceAccountMenu.migrate`.
/// The badge repaints itself once the `workspaceAccounts` broadcast lands.
fn migrate(
    ctrl: &Rc<AccountsController>,
    workspace_id: &str,
    target_id: Option<String>,
    target_label: &str,
) {
    let ctrl = ctrl.clone();
    let workspace_id = workspace_id.to_string();
    let target_label = target_label.to_string();
    glib::spawn_future_local(async move {
        let win = ctrl.main_window().clone();
        let ok = crate::dialogs::confirm(
            &win,
            "Migrate account",
            &format!(
                "Migrate this workspace to \u{201c}{target_label}\u{201d}?\n\n\
                 Its Claude conversation moves into that account and the agent restarts \
                 (resuming where it left off if it was running)."
            ),
        )
        .await;
        if !ok {
            return;
        }
        // migrateWorkspaceAccount(workspaceId, accountId|null).
        let arg = match &target_id {
            Some(id) => Value::from(id.as_str()),
            None => Value::Null,
        };
        let res = ctrl.call_typed::<orchestra_rpc::types::MigrateAccountResult>(
            "migrateWorkspaceAccount",
            vec![Value::from(workspace_id.as_str()), arg],
        );
        match res {
            Ok(r) if r.ok => {}
            Ok(r) => {
                crate::dialogs::error(
                    &win,
                    "Could not migrate account",
                    &r.error.unwrap_or_else(|| "migrate failed".into()),
                )
                .await;
            }
            Err(e) => {
                crate::dialogs::error(&win, "Could not migrate account", &e).await;
            }
        }
    });
}

/// `WorkspaceContextBadge` (`AccountBadge.tsx:95`): the live context-window
/// size next to the branch name, in the same discreet yellow. Ephemeral — the
/// sidebar workstream drives it from `agent:context` (0/absent → hidden).
pub struct ContextBadge {
    root: gtk::Box,
    value: gtk::Label,
}

impl ContextBadge {
    pub fn new() -> Self {
        let root = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        root.add_css_class("ws-context");
        root.set_widget_name("ws-context");
        root.set_visible(false);
        let sep = gtk::Label::new(Some("\u{b7}"));
        sep.add_css_class("ws-context-sep");
        let value = gtk::Label::new(None);
        root.append(&sep);
        root.append(&value);
        Self { root, value }
    }

    pub fn widget(&self) -> &gtk::Box {
        &self.root
    }

    /// Set the token count; 0/absent hides the badge (the reset sentinel).
    pub fn set_tokens(&self, tokens: Option<u64>) {
        match tokens.filter(|&t| t > 0) {
            Some(t) => {
                self.value.set_label(&format_tokens(t));
                self.root
                    .set_tooltip_text(Some(&format!("Context size: {t} tokens")));
                self.root.set_visible(true);
            }
            None => self.root.set_visible(false),
        }
    }
}

impl Default for ContextBadge {
    fn default() -> Self {
        Self::new()
    }
}
