//! The usage-bars strip + all-accounts hover panel (`UsageBars.tsx` port).
//!
//! Slim 5h/7d bars (plus a Fable bar when the plan has one) for the active
//! workspace's login, with the account name centered on the 5h bar's head and
//! the "updated Xm ago" stamp on the 7d bar's. Hovering the strip lifts a
//! popover listing every configured account plus the default login, active
//! first then hottest-first — pure render over the controller's state, no
//! polling of its own.

use std::cell::Cell;
use std::rc::Rc;

use gtk::glib;
use gtk::pango;
use gtk::prelude::*;

use orchestra_rpc::types::{UsageErrorKind, UsageWindowDetail};

use super::logic::{
    clamp_pct, error_text, format_resets_in, format_updated_ago, login_color_hex, row_sort_key,
    severity, Severity, DEFAULT_LOGIN_LABEL,
};
use super::{AccountsController, AccountsState};

/// One full-width bar of the strip: head line (window label · note · pct)
/// over a thin severity-tinted track.
struct Bar {
    root: gtk::Box,
    note: gtk::Label,
    pct: gtk::Label,
    track: gtk::ProgressBar,
}

impl Bar {
    fn new(window_label: &str, name: &str) -> Self {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 2);
        root.add_css_class("usage-bar");
        root.set_widget_name(name);

        let head = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        head.add_css_class("usage-bar-head");
        let label = gtk::Label::new(Some(window_label));
        label.add_css_class("usage-bar-label");
        label.set_xalign(0.0);
        let note = gtk::Label::new(None);
        note.add_css_class("usage-bar-note");
        note.set_hexpand(true);
        note.set_ellipsize(pango::EllipsizeMode::End);
        let pct = gtk::Label::new(None);
        pct.add_css_class("usage-bar-pct");
        pct.set_xalign(1.0);
        head.append(&label);
        head.append(&note);
        head.append(&pct);

        let track = gtk::ProgressBar::new();
        track.add_css_class("usage-bar-track");

        root.append(&head);
        root.append(&track);
        Self {
            root,
            note,
            pct,
            track,
        }
    }

    fn update(&self, window: &UsageWindowDetail, note: Option<&str>, title: &str, now_ms: i64) {
        let pct = clamp_pct(window.utilization);
        self.pct.set_label(&format!("{pct}%"));
        self.note.set_label(note.unwrap_or(""));
        self.track.set_fraction(f64::from(pct) / 100.0);
        set_severity_class(&self.track, severity(pct));
        let resets = format_resets_in(&window.resets_at, now_ms);
        let tooltip = if resets.is_empty() {
            title.to_string()
        } else {
            format!("{title} — {resets}")
        };
        self.root.set_tooltip_text(Some(&tooltip));
    }
}

fn set_severity_class(w: &impl IsA<gtk::Widget>, sev: Severity) {
    let w = w.as_ref();
    for c in ["sev-ok", "sev-warn", "sev-crit"] {
        w.remove_css_class(c);
    }
    w.add_css_class(&format!("sev-{}", sev.css()));
}

pub struct UsageBars {
    root: gtk::Box,
    bar5: Bar,
    bar7: Bar,
    fable: Bar,
    panel: gtk::Popover,
    panel_list: gtk::Box,
    /// Whether hovering should lift the panel (false with no configured
    /// accounts — the panel would just repeat the strip).
    has_panel: Cell<bool>,
    /// Generation counter for the delayed close: bumping it cancels the
    /// pending close (the 120 ms flicker guard from the TS).
    close_generation: Rc<Cell<u64>>,
}

impl UsageBars {
    #[allow(clippy::new_without_default)] // constructed only by the controller
    pub fn new() -> Self {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 6);
        root.add_css_class("usage-bars");
        root.set_widget_name("usage-bars");
        root.set_visible(false);

        let bar5 = Bar::new("5h", "usage-bar-5h");
        let bar7 = Bar::new("7d", "usage-bar-7d");
        let fable = Bar::new("Fable", "usage-bar-fable");
        root.append(&bar5.root);
        root.append(&bar7.root);
        root.append(&fable.root);

        let panel_list = gtk::Box::new(gtk::Orientation::Vertical, 8);
        panel_list.add_css_class("usage-bars-panel-list");
        let title = gtk::Label::new(Some("Usage by account"));
        title.add_css_class("usage-bars-panel-title");
        title.set_xalign(0.0);
        let panel_content = gtk::Box::new(gtk::Orientation::Vertical, 8);
        panel_content.append(&title);
        panel_content.append(&panel_list);

        let scroll = gtk::ScrolledWindow::new();
        scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        scroll.set_propagate_natural_height(true);
        scroll.set_propagate_natural_width(true);
        scroll.set_max_content_height(420);
        scroll.set_child(Some(&panel_content));

        let panel = gtk::Popover::new();
        panel.set_widget_name("usage-bars-panel");
        panel.add_css_class("usage-bars-panel");
        panel.set_parent(&root);
        panel.set_position(gtk::PositionType::Top);
        // Hover-driven, not click-driven: autohide would fight the pointer.
        panel.set_autohide(false);
        panel.set_child(Some(&scroll));

        Self {
            root,
            bar5,
            bar7,
            fable,
            panel,
            panel_list,
            has_panel: Cell::new(false),
            close_generation: Rc::new(Cell::new(0)),
        }
    }

    /// Attach the hover wiring. Called once by the controller after it owns us
    /// (the `ctrl` handle is unused today — the panel-open decision reads the
    /// `expandable` CSS class `update()` toggles — but keeps the wiring point
    /// symmetric with the other components should it need controller RPC).
    pub(crate) fn wire(&self, _ctrl: &Rc<AccountsController>) {
        // Enter opens (and cancels a pending close), leave schedules a close
        // after the same 120 ms grace the TS uses so crossing the gap between
        // strip and popover doesn't flicker it shut.
        let motion = gtk::EventControllerMotion::new();
        {
            let panel = self.panel.clone();
            let generation = self.close_generation.clone();
            motion.connect_enter(move |controller, _, _| {
                generation.set(generation.get() + 1);
                let strip = controller.widget();
                // `expandable` is toggled by update() when accounts exist.
                if strip.is_some_and(|w| w.has_css_class("expandable")) {
                    panel.popup();
                }
            });
        }
        {
            let panel = self.panel.clone();
            let generation = self.close_generation.clone();
            motion.connect_leave(move |_| {
                schedule_close(&panel, &generation);
            });
        }
        self.root.add_controller(motion);

        // The popover is its own surface: entering it "leaves" the strip, so
        // it needs the same cancel/schedule pair to stay open while hovered.
        let panel_motion = gtk::EventControllerMotion::new();
        {
            let generation = self.close_generation.clone();
            panel_motion.connect_enter(move |_, _, _| {
                generation.set(generation.get() + 1);
            });
        }
        {
            let panel = self.panel.clone();
            let generation = self.close_generation.clone();
            panel_motion.connect_leave(move |_| {
                schedule_close(&panel, &generation);
            });
        }
        self.panel.add_controller(panel_motion);
    }

    pub fn root(&self) -> &gtk::Box {
        &self.root
    }

    /// Recompute the whole strip + panel from state — the GTK equivalent of
    /// one `UsageBars()` render pass.
    pub fn update(&self, state: &AccountsState, now_ms: i64) {
        // Resolve the active workspace's login exactly like the TS: pinned
        // account → per-account poller data (cached-across-expiry included);
        // no pin → global poller; no data at all → hide the strip.
        let active_ws = state.active_workspace.as_deref();
        let ws_account = active_ws.and_then(|id| state.workspace_accounts.get(id));
        let account_id = ws_account.and_then(|a| a.account_id.as_deref());

        struct StripData {
            five: UsageWindowDetail,
            seven: UsageWindowDetail,
            fable: Option<UsageWindowDetail>,
            label: Option<String>,
            fetched_at: i64,
        }

        let strip: Option<StripData> = if let Some(acct) = account_id {
            state
                .account_usage
                .get(acct)
                .and_then(|s| s.data.as_ref().map(|d| (s, d)))
                .map(|(s, d)| StripData {
                    five: d.five_hour.clone(),
                    seven: d.seven_day.clone(),
                    fable: d.fable.clone(),
                    label: ws_account.map(|a| a.label.clone()),
                    fetched_at: s.fetched_at,
                })
        } else {
            state.global_usage.as_ref().map(|g| StripData {
                five: UsageWindowDetail {
                    utilization: g.five_hour.utilization,
                    resets_at: g.five_hour.resets_at.clone(),
                },
                seven: UsageWindowDetail {
                    utilization: g.seven_day.utilization,
                    resets_at: g.seven_day.resets_at.clone(),
                },
                fable: g.fable.as_ref().map(|f| UsageWindowDetail {
                    utilization: f.utilization,
                    resets_at: f.resets_at.clone(),
                }),
                // The default login is surfaced by name too, so the bars
                // always say which login they measure.
                label: Some(
                    ws_account
                        .map(|a| a.label.clone())
                        .unwrap_or_else(|| DEFAULT_LOGIN_LABEL.into()),
                ),
                fetched_at: g.fetched_at,
            })
        };

        let Some(strip) = strip else {
            self.panel.popdown();
            self.root.set_visible(false);
            return;
        };
        self.root.set_visible(true);

        let label = strip.label.as_deref();
        let ctx = |window: &str| match label {
            Some(l) => format!("Claude usage ({l}) — {window}"),
            None => format!("Claude usage — {window}"),
        };
        self.bar5
            .update(&strip.five, label, &ctx("5-hour session window"), now_ms);
        self.bar7.update(
            &strip.seven,
            Some(&format_updated_ago(strip.fetched_at, now_ms)),
            &ctx("7-day weekly window"),
            now_ms,
        );
        match &strip.fable {
            Some(f) => {
                self.fable.root.set_visible(true);
                self.fable
                    .update(f, None, &ctx("Fable 7-day weekly window"), now_ms);
            }
            None => self.fable.root.set_visible(false),
        }

        // With no custom accounts the panel would just repeat the strip's one
        // default row — skip the hover affordance entirely (TS `hasPanel`).
        let has_panel = !state.accounts.is_empty();
        self.has_panel.set(has_panel);
        if has_panel {
            self.root.add_css_class("expandable");
        } else {
            self.root.remove_css_class("expandable");
            self.panel.popdown();
        }

        self.rebuild_panel(state, account_id, now_ms);
    }

    fn rebuild_panel(&self, state: &AccountsState, active_account: Option<&str>, now_ms: i64) {
        while let Some(child) = self.panel_list.first_child() {
            self.panel_list.remove(&child);
        }

        enum RowState {
            Ok {
                five: UsageWindowDetail,
                seven: UsageWindowDetail,
                fable: Option<UsageWindowDetail>,
                expired: bool,
                fetched_at: i64,
            },
            Pending,
            Error(Option<UsageErrorKind>),
        }
        struct Row {
            label: String,
            is_active: bool,
            hotness: f64,
            state: RowState,
        }

        let mut rows: Vec<Row> = Vec::with_capacity(state.accounts.len() + 1);
        for a in &state.accounts {
            let is_active = active_account == Some(a.id.as_str());
            match state.account_usage.get(&a.id) {
                None => rows.push(Row {
                    label: a.label.clone(),
                    is_active,
                    hotness: -1.0,
                    state: RowState::Pending,
                }),
                Some(u) => match &u.data {
                    // No cached usage → hard error (an expired token keeps
                    // its last-good data and renders as an ok row instead).
                    None => rows.push(Row {
                        label: a.label.clone(),
                        is_active,
                        hotness: -1.0,
                        state: RowState::Error(u.error_kind),
                    }),
                    Some(d) => rows.push(Row {
                        label: a.label.clone(),
                        is_active,
                        hotness: d
                            .five_hour
                            .utilization
                            .max(d.seven_day.utilization)
                            .max(d.fable.as_ref().map_or(0.0, |f| f.utilization)),
                        state: RowState::Ok {
                            five: d.five_hour.clone(),
                            seven: d.seven_day.clone(),
                            fable: d.fable.clone(),
                            expired: u.expired.unwrap_or(false),
                            fetched_at: u.fetched_at,
                        },
                    }),
                },
            }
        }
        let default_active = active_account.is_none();
        match &state.global_usage {
            None => rows.push(Row {
                label: DEFAULT_LOGIN_LABEL.into(),
                is_active: default_active,
                hotness: -1.0,
                state: RowState::Pending,
            }),
            Some(g) => rows.push(Row {
                label: DEFAULT_LOGIN_LABEL.into(),
                is_active: default_active,
                hotness: g
                    .five_hour
                    .utilization
                    .max(g.seven_day.utilization)
                    .max(g.fable.as_ref().map_or(0.0, |f| f.utilization)),
                state: RowState::Ok {
                    five: detail_of(&g.five_hour),
                    seven: detail_of(&g.seven_day),
                    fable: g.fable.as_ref().map(detail_of),
                    expired: false,
                    fetched_at: g.fetched_at,
                },
            }),
        }

        rows.sort_by_key(|r| row_sort_key(r.is_active, r.hotness));

        for row in &rows {
            let row_box = gtk::Box::new(gtk::Orientation::Vertical, 3);
            row_box.add_css_class("usage-bars-row");
            if row.is_active {
                row_box.add_css_class("active");
            }

            let head = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            let name = gtk::Label::new(None);
            name.set_markup(&format!(
                "<span foreground=\"{}\">{}</span>",
                login_color_hex(&row.label),
                glib::markup_escape_text(&row.label),
            ));
            name.add_css_class("usage-bars-row-name");
            name.set_xalign(0.0);
            name.set_hexpand(true);
            name.set_ellipsize(pango::EllipsizeMode::End);
            head.append(&name);

            let status = gtk::Label::new(None);
            status.add_css_class("usage-bars-row-status");
            match &row.state {
                RowState::Pending => status.set_label("fetching usage…"),
                RowState::Error(kind) => {
                    status.set_label(error_text(*kind));
                    row_box.add_css_class("err");
                }
                RowState::Ok {
                    expired,
                    fetched_at,
                    ..
                } => {
                    if *expired {
                        status.set_label(&format!(
                            "token expired · {}",
                            format_updated_ago(*fetched_at, now_ms)
                        ));
                    } else {
                        status.set_label(&format_updated_ago(*fetched_at, now_ms));
                        status.add_css_class("usage-bars-row-updated");
                    }
                }
            }
            head.append(&status);
            row_box.append(&head);

            if let RowState::Ok {
                five, seven, fable, ..
            } = &row.state
            {
                row_box.append(&mini_bar("5h", five, now_ms));
                row_box.append(&mini_bar("7d", seven, now_ms));
                if let Some(f) = fable {
                    row_box.append(&mini_bar("f7d", f, now_ms));
                }
            }
            self.panel_list.append(&row_box);
        }
    }
}

/// The global poller's `UsageWindow` and the per-account `UsageWindowDetail`
/// are the same shape split across two TS types; the panel renders both.
fn detail_of(w: &orchestra_rpc::types::UsageWindow) -> UsageWindowDetail {
    UsageWindowDetail {
        utilization: w.utilization,
        resets_at: w.resets_at.clone(),
    }
}

/// One compact panel-row bar: tiny window label, track, percent on one line.
fn mini_bar(label: &str, window: &UsageWindowDetail, now_ms: i64) -> gtk::Box {
    let pct = clamp_pct(window.utilization);
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    row.add_css_class("usage-row-bar");
    let l = gtk::Label::new(Some(label));
    l.add_css_class("usage-row-bar-label");
    l.set_width_chars(3);
    l.set_xalign(0.0);
    let track = gtk::ProgressBar::new();
    track.add_css_class("usage-bar-track");
    track.set_hexpand(true);
    track.set_valign(gtk::Align::Center);
    track.set_fraction(f64::from(pct) / 100.0);
    set_severity_class(&track, severity(pct));
    let p = gtk::Label::new(Some(&format!("{pct}%")));
    p.add_css_class("usage-row-pct");
    p.set_width_chars(4);
    p.set_xalign(1.0);
    row.append(&l);
    row.append(&track);
    row.append(&p);
    let resets = format_resets_in(&window.resets_at, now_ms);
    if !resets.is_empty() {
        row.set_tooltip_text(Some(&resets));
    }
    row
}

/// Delayed panel close with cancel-on-reenter semantics (the TS closeTimer).
fn schedule_close(panel: &gtk::Popover, generation: &Rc<Cell<u64>>) {
    let expected = generation.get() + 1;
    generation.set(expected);
    let panel = panel.clone();
    let generation = generation.clone();
    glib::timeout_add_local_once(std::time::Duration::from_millis(120), move || {
        if generation.get() == expected {
            panel.popdown();
        }
    });
}
