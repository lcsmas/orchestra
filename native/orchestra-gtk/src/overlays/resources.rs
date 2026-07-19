//! Resources overlay (plan §5.5, parity: `src/renderer/components/ResourcesView.tsx`).
//!
//! A live monitor of everything Orchestra consumes. The system side (CPU /
//! memory / processes / disk) is polled from `sampleResources` every
//! [`support::SAMPLE_MS`] **only while the overlay is shown** — there is no
//! push channel and no background cost when closed (mirrors the Electron
//! visibility gate). Token usage comes from the account/usage calls, refreshed
//! on a slower cadence.
//!
//! Color discipline (plan §5.5): CPU and memory meters stay on the accent hue;
//! yellow/red are RESERVED for token-limit severity ([`support::Severity`]).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;

use orchestra_rpc::types::{
    AccountUsageStatus, ResourceSnapshot, SessionKind, SessionResourceStat, UsageErrorKind,
    UsageSnapshot, UsageWindow, UsageWindowDetail, Workspace, WorkspaceAccount, WorktreeSizes,
};

use super::support::{
    self, format_bytes, format_cpu, format_resets_in, format_tokens, format_updated_ago,
    login_color, spark_scale, Severity, TraceRing,
};
use crate::backend::Backend;

/// The "fleet CPU" trace key (Electron's `__total__`).
const FLEET_KEY: &str = "__total__";
/// Refresh the slow data (accounts / usage / sizes / workspace pins) every N
/// ticks — they change far slower than CPU, and each is a real RPC round-trip.
const SLOW_EVERY_TICKS: u64 = 8;

/// Cached slow-changing data, refreshed on the slow cadence.
#[derive(Default)]
struct SlowData {
    workspaces: Vec<Workspace>,
    sizes: HashMap<String, u64>,
    accounts: Vec<(String, String)>, // (id, label)
    account_usage: HashMap<String, AccountUsageStatus>,
    global_usage: Option<UsageSnapshot>,
    workspace_accounts: HashMap<String, WorkspaceAccount>,
    context_tokens: HashMap<String, u64>,
}

pub struct ResourcesOverlay {
    root: gtk::Box,
    close_btn: gtk::Button,
    live_label: gtk::Label,
    tiles: gtk::Box,
    fleet_trace_area: gtk::DrawingArea,
    agents_box: gtk::Box,
    app_box: gtk::Box,
    cards_box: gtk::Box,
    disk_box: gtk::Box,

    backend: Rc<dyn Backend>,
    /// CPU trace rings per row key + the fleet key.
    traces: Rc<RefCell<HashMap<String, TraceRing>>>,
    /// Which agent rows are expanded (persist across the per-tick rebuild).
    expanded: Rc<RefCell<HashMap<String, bool>>>,
    slow: Rc<RefCell<SlowData>>,
    tick: Rc<Cell<u64>>,
    /// The running poll timer's source id, so `on_hidden` can cancel it.
    poll_source: RefCell<Option<glib::SourceId>>,
    /// Fleet trace snapshot the DrawingArea reads (avoids borrowing `traces`
    /// inside the draw closure).
    fleet_samples: Rc<RefCell<Vec<f64>>>,
}

impl ResourcesOverlay {
    pub fn new(backend: Rc<dyn Backend>) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.set_widget_name("resources-overlay");
        root.add_css_class("overlay");
        root.add_css_class("res-page");
        root.set_visible(false);

        // Header.
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        header.add_css_class("res-header");
        let title = gtk::Label::new(Some("Resources"));
        title.add_css_class("overlay-title");
        header.append(&title);
        let live_label = gtk::Label::new(Some("sampling…"));
        live_label.set_widget_name("res-live");
        live_label.add_css_class("res-live");
        live_label.set_hexpand(true);
        live_label.set_xalign(0.0);
        header.append(&live_label);
        let close_btn = gtk::Button::with_label("×");
        close_btn.set_widget_name("res-close");
        close_btn.add_css_class("overlay-close");
        close_btn.set_tooltip_text(Some("Back to workspaces (Esc)"));
        header.append(&close_btn);
        root.append(&header);

        // Scroll body.
        let scroll = gtk::ScrolledWindow::new();
        scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        scroll.set_vexpand(true);
        let body = gtk::Box::new(gtk::Orientation::Vertical, 18);
        body.add_css_class("res-scroll");

        let tiles = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        tiles.add_css_class("res-tiles");
        tiles.set_homogeneous(true);
        body.append(&tiles);

        // Fleet trace lives inside the first tile — built once, redrawn each
        // tick from `fleet_samples`.
        let fleet_trace_area = gtk::DrawingArea::new();
        fleet_trace_area.set_content_height(30);
        fleet_trace_area.set_hexpand(true);
        fleet_trace_area.add_css_class("res-tile-spark");

        let agents_box = section(&body, "Agents", "res-agents");
        let app_box = section(&body, "App processes", "res-app");
        let cards_box = section(&body, "Token usage by login", "res-cards");
        let disk_box = section(&body, "Orchestra data on disk", "res-disk-section");

        scroll.set_child(Some(&body));
        root.append(&scroll);

        let overlay = Rc::new(Self {
            root,
            close_btn,
            live_label,
            tiles,
            fleet_trace_area,
            agents_box,
            app_box,
            cards_box,
            disk_box,
            backend,
            traces: Rc::new(RefCell::new(HashMap::new())),
            expanded: Rc::new(RefCell::new(HashMap::new())),
            slow: Rc::new(RefCell::new(SlowData::default())),
            tick: Rc::new(Cell::new(0)),
            poll_source: RefCell::new(None),
            fleet_samples: Rc::new(RefCell::new(Vec::new())),
        });

        // Wire the fleet trace's draw function.
        {
            let samples = overlay.fleet_samples.clone();
            overlay
                .fleet_trace_area
                .set_draw_func(move |_, cr, w, h| {
                    draw_spark(cr, w, h, &samples.borrow());
                });
        }

        overlay
    }

    pub fn widget(&self) -> &gtk::Box {
        &self.root
    }

    pub fn on_close(self: &Rc<Self>, f: impl Fn() + 'static) {
        self.close_btn.connect_clicked(move |_| f());
    }

    /// Start polling: an immediate sample, then every [`support::SAMPLE_MS`].
    /// Called when the overlay becomes visible.
    pub fn on_shown(self: &Rc<Self>) {
        if self.poll_source.borrow().is_some() {
            return;
        }
        self.poll_once();
        let this = self.clone();
        let source = glib::timeout_add_local(
            std::time::Duration::from_millis(support::SAMPLE_MS as u64),
            move || {
                this.poll_once();
                glib::ControlFlow::Continue
            },
        );
        *self.poll_source.borrow_mut() = Some(source);
    }

    /// Stop polling (no background cost when hidden).
    pub fn on_hidden(&self) {
        if let Some(source) = self.poll_source.borrow_mut().take() {
            source.remove();
        }
    }

    fn poll_once(self: &Rc<Self>) {
        let tick = self.tick.get();
        self.tick.set(tick.wrapping_add(1));

        // Slow data on the first tick and every SLOW_EVERY_TICKS after.
        if tick.is_multiple_of(SLOW_EVERY_TICKS) {
            self.refresh_slow();
        }

        let snap: Option<ResourceSnapshot> = self
            .backend
            .call("sampleResources", vec![])
            .ok()
            .and_then(|v| serde_json::from_value(v).ok());

        let Some(snap) = snap else {
            // Main busy or unwired — skip this tick, like the Electron catch.
            return;
        };

        self.update_traces(&snap);
        self.rebuild(&snap);
        self.live_label.set_text("live");
    }

    fn refresh_slow(self: &Rc<Self>) {
        let mut slow = self.slow.borrow_mut();
        slow.workspaces = self.backend.list_workspaces().unwrap_or_default();
        if let Ok(v) = self.backend.call("getWorktreeSizes", vec![]) {
            if let Ok(sizes) = serde_json::from_value::<WorktreeSizes>(v) {
                slow.sizes = sizes.sizes;
            }
        }
        if let Ok(v) = self.backend.call("listAccounts", vec![]) {
            if let Ok(accs) = serde_json::from_value::<Vec<serde_json::Value>>(v) {
                slow.accounts = accs
                    .into_iter()
                    .filter_map(|a| {
                        Some((
                            a.get("id")?.as_str()?.to_string(),
                            a.get("label")?.as_str()?.to_string(),
                        ))
                    })
                    .collect();
            }
        }
        if let Ok(v) = self.backend.call("getAllAccountUsage", vec![]) {
            slow.account_usage = serde_json::from_value(v).unwrap_or_default();
        }
        if let Ok(v) = self.backend.call("getUsage", vec![]) {
            slow.global_usage = serde_json::from_value(v).ok();
        }
        if let Ok(v) = self.backend.call("getWorkspaceAccounts", vec![]) {
            slow.workspace_accounts = serde_json::from_value(v).unwrap_or_default();
        }
    }

    /// Append CPU samples to the per-row + fleet trace rings, decaying rows
    /// with no live session this tick to 0 (flatline behavior).
    fn update_traces(&self, snap: &ResourceSnapshot) {
        let mut by_key: HashMap<String, f64> = HashMap::new();
        let mut total = 0.0;
        for s in &snap.sessions {
            if s.remote {
                continue;
            }
            total += s.cpu_pct;
            let key = row_key(s);
            *by_key.entry(key).or_insert(0.0) += s.cpu_pct;
        }

        let mut traces = self.traces.borrow_mut();
        traces
            .entry(FLEET_KEY.to_string())
            .or_insert_with(|| TraceRing::with_capacity(support::HISTORY_LEN))
            .push(total);

        // Decay every existing (non-fleet) key not present this tick.
        let existing: Vec<String> = traces
            .keys()
            .filter(|k| *k != FLEET_KEY && !by_key.contains_key(*k))
            .cloned()
            .collect();
        for k in existing {
            if let Some(r) = traces.get_mut(&k) {
                r.decay();
            }
        }
        for (k, v) in by_key {
            traces
                .entry(k)
                .or_insert_with(|| TraceRing::with_capacity(support::HISTORY_LEN))
                .push(v);
        }

        // Publish the fleet snapshot for the DrawingArea, then redraw.
        if let Some(fleet) = traces.get(FLEET_KEY) {
            *self.fleet_samples.borrow_mut() = fleet.samples().to_vec();
        }
        self.fleet_trace_area.queue_draw();
    }

    fn rebuild(self: &Rc<Self>, snap: &ResourceSnapshot) {
        // "now" is the sample timestamp — for the real backend that IS the
        // wall clock (better than a separate Date.now that can drift from the
        // sample), and for the mock it advances deterministically off the tick.
        let now = snap.at;
        let slow = self.slow.borrow();
        let live: Vec<&Workspace> = slow.workspaces.iter().collect();
        let ws_by_id: HashMap<&str, &Workspace> =
            live.iter().map(|w| (w.id.as_str(), *w)).collect();

        // Group sessions into per-workspace rows + login PTYs.
        let mut by_ws: HashMap<String, Vec<SessionResourceStat>> = HashMap::new();
        let mut login_sessions: Vec<SessionResourceStat> = Vec::new();
        for s in &snap.sessions {
            if s.kind == SessionKind::Login {
                login_sessions.push(s.clone());
                continue;
            }
            by_ws.entry(row_key(s)).or_default().push(s.clone());
        }

        let mut rows: Vec<AgentRow> = by_ws
            .into_iter()
            .map(|(key, sessions)| {
                let cpu: f64 = sessions.iter().map(|s| s.cpu_pct).sum();
                let mem: u64 = sessions.iter().map(|s| s.mem_bytes).sum();
                let procs: u64 = sessions.iter().map(|s| s.proc_count).sum();
                let remote = sessions.iter().all(|s| s.remote);
                AgentRow {
                    key,
                    cpu,
                    mem,
                    procs,
                    remote,
                    sessions,
                }
            })
            .collect();
        // Hottest-first (CPU, then memory).
        rows.sort_by(|a, b| {
            b.cpu
                .partial_cmp(&a.cpu)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.mem.cmp(&a.mem))
        });

        // ---- tiles ----
        let agent_cpu: f64 = rows.iter().filter(|r| !r.remote).map(|r| r.cpu).sum();
        let agent_mem: u64 = rows.iter().filter(|r| !r.remote).map(|r| r.mem).sum();
        let agent_procs: u64 = rows.iter().filter(|r| !r.remote).map(|r| r.procs).sum();
        let app_mem: u64 = snap.app.iter().map(|p| p.mem_bytes).sum();
        let app_cpu: f64 = snap.app.iter().map(|p| p.cpu_pct).sum();
        let worktree_bytes: u64 = live
            .iter()
            .map(|w| slow.sizes.get(&w.id).copied().unwrap_or(0))
            .sum();
        let worktree_count = live
            .iter()
            .filter(|w| slow.sizes.contains_key(&w.id))
            .count();
        let agent_count = rows
            .iter()
            .filter(|r| r.sessions.iter().any(|s| s.kind == SessionKind::Agent))
            .count();
        let mem_pct = if snap.mem_total_bytes > 0 {
            ((agent_mem + app_mem) as f64 / snap.mem_total_bytes as f64) * 100.0
        } else {
            0.0
        };
        self.rebuild_tiles(
            agent_cpu,
            snap.cpu_cores,
            agent_mem,
            agent_procs,
            app_mem,
            app_cpu,
            worktree_bytes,
            worktree_count,
            agent_count,
            mem_pct,
        );

        // ---- agents table ----
        clear(&self.agents_box);
        if rows.is_empty() && login_sessions.is_empty() {
            let empty = gtk::Label::new(Some(
                "No agent processes right now — open a workspace terminal and its agent will appear here.",
            ));
            empty.set_xalign(0.0);
            empty.set_wrap(true);
            empty.add_css_class("res-empty");
            self.agents_box.append(&empty);
        } else {
            self.agents_box.append(&agents_head());
            let traces = self.traces.borrow();
            for row in &rows {
                let ws = ws_by_id.get(row.key.as_str()).copied();
                let disk = ws.and_then(|w| slow.sizes.get(&w.id).copied());
                let ctx = ws.and_then(|w| slow.context_tokens.get(&w.id).copied());
                let account_label = ws
                    .and_then(|w| slow.workspace_accounts.get(&w.id))
                    .map(|wa| wa.label.clone());
                let trace = traces
                    .get(&row.key)
                    .map(|r| r.samples().to_vec())
                    .unwrap_or_default();
                let widget =
                    self.build_agent_row(row, ws.cloned(), &trace, disk, ctx, account_label);
                self.agents_box.append(&widget);
            }
            for s in &login_sessions {
                self.agents_box.append(&build_login_row(s));
            }
        }

        // ---- app processes ----
        clear(&self.app_box);
        self.app_box.append(&app_head());
        let mut app = snap.app.clone();
        app.sort_by_key(|p| std::cmp::Reverse(p.mem_bytes));
        for p in &app {
            let r = grid_row("res-app-row");
            r.append(&cell(&app_type_label(&p.process_type), "res-cell"));
            r.append(&cell(&p.pid.to_string(), "res-cell dim"));
            r.append(&cell(&format_cpu(p.cpu_pct), "res-cell"));
            r.append(&cell(&format_bytes(p.mem_bytes), "res-cell"));
            self.app_box.append(&r);
        }

        // ---- token usage cards ----
        self.rebuild_cards(&slow, &live, now);

        // ---- disk ----
        self.rebuild_disk(snap, worktree_bytes, now);
    }

    #[allow(clippy::too_many_arguments)]
    fn rebuild_tiles(
        &self,
        agent_cpu: f64,
        cpu_cores: u32,
        agent_mem: u64,
        agent_procs: u64,
        app_mem: u64,
        app_cpu: f64,
        worktree_bytes: u64,
        worktree_count: usize,
        agent_count: usize,
        mem_pct: f64,
    ) {
        clear(&self.tiles);

        let cpu_tile = tile("Agent CPU", &format_cpu(agent_cpu), &format!("{cpu_cores} cores available"));
        cpu_tile.add_css_class("res-tile-cpu");
        // Reparent the persistent fleet spark into the CPU tile.
        if let Some(parent) = self.fleet_trace_area.parent() {
            if let Some(b) = parent.downcast_ref::<gtk::Box>() {
                b.remove(&self.fleet_trace_area);
            }
        }
        cpu_tile.append(&self.fleet_trace_area);
        self.tiles.append(&cpu_tile);

        self.tiles.append(&tile(
            "Agent memory",
            &format_bytes(agent_mem),
            &format!("{agent_procs} processes"),
        ));
        self.tiles.append(&tile(
            "App memory",
            &format_bytes(app_mem),
            &format!("Electron · {} CPU", format_cpu(app_cpu)),
        ));
        self.tiles.append(&tile(
            "Worktrees on disk",
            &format_bytes(worktree_bytes),
            &format!("{worktree_count} worktrees"),
        ));
        let live_sub = if mem_pct >= 0.5 {
            format!("{mem_pct:.1}% of system RAM")
        } else {
            "idle".to_string()
        };
        self.tiles
            .append(&tile("Live agents", &agent_count.to_string(), &live_sub));
    }

    #[allow(clippy::too_many_arguments)]
    fn build_agent_row(
        self: &Rc<Self>,
        row: &AgentRow,
        ws: Option<Workspace>,
        trace: &[f64],
        disk: Option<u64>,
        ctx: Option<u64>,
        account_label: Option<String>,
    ) -> gtk::Box {
        let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
        container.set_widget_name(&format!("res-agent-{}", row.key));

        // The row is [disclosure-button | stop-button]: a real Button (not a
        // Box+gesture) so the remote-control harness's Click can drive expand,
        // and so keyboard/focus work. The stop control is a SIBLING, never
        // nested inside the button (a button inside a button is invalid).
        let outer = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        let disclosure = gtk::Button::new();
        disclosure.set_widget_name(&format!("res-agent-row-{}", row.key));
        disclosure.add_css_class("res-agent-row");
        disclosure.set_hexpand(true);
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);

        let status = ws
            .as_ref()
            .map(|w| status_css(w.status))
            .unwrap_or("idle");
        let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        dot.add_css_class("ws-dot");
        dot.add_css_class(status);
        dot.set_valign(gtk::Align::Center);
        header.append(&dot);

        // name + sub (repo · account)
        let name_box = gtk::Box::new(gtk::Orientation::Vertical, 1);
        name_box.set_width_request(190);
        let name = ws.as_ref().map(|w| w.branch.clone()).unwrap_or(row.key.clone());
        let name_l = gtk::Label::new(Some(&name));
        name_l.set_xalign(0.0);
        name_l.add_css_class("res-agent-branch");
        name_box.append(&name_l);
        let sub = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let repo = ws
            .as_ref()
            .map(|w| {
                w.repo_path
                    .rsplit('/')
                    .next()
                    .unwrap_or("scratch")
                    .to_string()
            })
            .unwrap_or_default();
        if !repo.is_empty() {
            let repo_l = gtk::Label::new(Some(&repo));
            repo_l.set_xalign(0.0);
            repo_l.add_css_class("res-agent-sub");
            sub.append(&repo_l);
        }
        if let Some(label) = &account_label {
            let acc = gtk::Label::new(Some(label));
            acc.add_css_class("res-agent-account");
            acc.set_tooltip_text(Some(&format!("login: {label}")));
            // Per-login hue as pango markup foreground.
            apply_color(&acc, &hsl_to_hex(&login_color(label)));
            sub.append(&acc);
        }
        name_box.append(&sub);
        header.append(&name_box);

        header.append(&session_chips(&row.sessions));

        if row.remote {
            let note = gtk::Label::new(Some("runs in sandbox — no local footprint"));
            note.add_css_class("res-remote-note");
            note.set_hexpand(true);
            note.set_xalign(0.0);
            header.append(&note);
        } else {
            // trace
            let spark = gtk::DrawingArea::new();
            spark.set_content_width(96);
            spark.set_content_height(22);
            spark.add_css_class("res-spark");
            spark.set_valign(gtk::Align::Center);
            let samples = trace.to_vec();
            spark.set_draw_func(move |_, cr, w, h| draw_spark(cr, w, h, &samples));
            let trace_col = gtk::Box::new(gtk::Orientation::Horizontal, 0);
            trace_col.set_width_request(100);
            trace_col.append(&spark);
            header.append(&trace_col);
            // cpu cell
            header.append(&cpu_cell(row.cpu));
            header.append(&cell(&format_bytes(row.mem), "res-cell"));
            header.append(&cell(&row.procs.to_string(), "res-cell dim res-col-procs"));
        }
        header.append(&cell(&opt_bytes(disk), "res-cell dim res-col-disk"));
        header.append(&cell(&opt_tokens(ctx), "res-cell dim res-col-ctx"));

        disclosure.set_child(Some(&header));
        outer.append(&disclosure);

        // stop button (only for rows with a live agent session) — a SIBLING of
        // the disclosure button, not nested in it.
        let agent_pty = row
            .sessions
            .iter()
            .find(|s| s.kind == SessionKind::Agent)
            .map(|s| s.pty_id.clone());
        let stop_col = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        stop_col.add_css_class("res-col-stop");
        stop_col.set_valign(gtk::Align::Center);
        if let Some(pty) = agent_pty {
            let stop = gtk::Button::new();
            stop.set_widget_name(&format!("res-stop-{}", row.key));
            stop.add_css_class("res-stop-btn");
            stop.set_tooltip_text(Some(
                "Stop this agent's process (conversation resumes on relaunch)",
            ));
            let icon = gtk::Box::new(gtk::Orientation::Horizontal, 0);
            icon.add_css_class("res-stop-icon");
            stop.set_child(Some(&icon));
            let this = self.clone();
            let ws_status = ws.as_ref().map(|w| w.status);
            let name_c = name.clone();
            stop.connect_clicked(move |btn| {
                this.on_stop(&pty, ws_status, &name_c, btn);
            });
            stop_col.append(&stop);
        }
        outer.append(&stop_col);

        container.append(&outer);

        let procs_box = gtk::Box::new(gtk::Orientation::Vertical, 0);
        procs_box.add_css_class("res-procs");
        if !row.remote {
            build_procs(&procs_box, row);
        }
        let expanded = self
            .expanded
            .borrow()
            .get(&row.key)
            .copied()
            .unwrap_or(false);
        procs_box.set_visible(expanded && !row.remote);
        if expanded {
            disclosure.add_css_class("open");
        }
        container.append(&procs_box);

        if !row.remote {
            let key = row.key.clone();
            let expanded_map = self.expanded.clone();
            let procs_box_c = procs_box.clone();
            let disclosure_c = disclosure.clone();
            disclosure.connect_clicked(move |_| {
                let now = !expanded_map.borrow().get(&key).copied().unwrap_or(false);
                expanded_map.borrow_mut().insert(key.clone(), now);
                procs_box_c.set_visible(now);
                if now {
                    disclosure_c.add_css_class("open");
                } else {
                    disclosure_c.remove_css_class("open");
                }
            });
        }

        container
    }

    fn on_stop(
        self: &Rc<Self>,
        pty: &str,
        status: Option<orchestra_rpc::types::WorkspaceStatus>,
        name: &str,
        btn: &gtk::Button,
    ) {
        use orchestra_rpc::types::WorkspaceStatus;
        let backend = self.backend.clone();
        let pty = pty.to_string();
        let name = name.to_string();
        let parent = btn.root().and_downcast::<gtk::Window>();
        glib::spawn_future_local(async move {
            if status == Some(WorkspaceStatus::Running) {
                if let Some(win) = &parent {
                    let ok = crate::dialogs::confirm(
                        win,
                        "Stop agent?",
                        &format!(
                            "{name} is mid-turn. Stopping will kill the current response.\n\n\
                             The agent process exits and frees its CPU/memory. Reopening the \
                             workspace (or pressing a key in its terminal) relaunches it with \
                             `claude --continue`.",
                        ),
                    )
                    .await;
                    if !ok {
                        return;
                    }
                }
            }
            if let Err(e) = backend.call("stopAgent", vec![serde_json::json!(pty)]) {
                if let Some(win) = &parent {
                    crate::dialogs::error(win, "Error", &format!("Could not stop agent: {e}")).await;
                }
            }
        });
    }

    fn rebuild_cards(&self, slow: &SlowData, live: &[&Workspace], now: i64) {
        clear(&self.cards_box);

        // Group workspaces by their pinned account (None = default login).
        let mut ws_by_account: HashMap<Option<String>, Vec<&Workspace>> = HashMap::new();
        for w in live {
            let acc = slow
                .workspace_accounts
                .get(&w.id)
                .and_then(|wa| wa.account_id.clone());
            ws_by_account.entry(acc).or_default().push(w);
        }

        let mut cards: Vec<Card> = Vec::new();
        for (id, label) in &slow.accounts {
            let u = slow.account_usage.get(id);
            let data = u.and_then(|s| s.data.as_ref());
            let hotness = data
                .map(|d| {
                    d.five_hour
                        .utilization
                        .max(d.seven_day.utilization)
                        .max(d.fable.as_ref().map(|f| f.utilization).unwrap_or(0.0))
                })
                .unwrap_or(-1.0);
            cards.push(Card {
                label: label.clone(),
                five_hour: data.map(|d| detail_to_window(&d.five_hour)),
                seven_day: data.map(|d| detail_to_window(&d.seven_day)),
                fable: data.and_then(|d| d.fable.as_ref().map(detail_to_window)),
                extra: data.and_then(|d| d.extra_utilization),
                fetched_at: u.map(|s| s.fetched_at).unwrap_or(0),
                expired: u.and_then(|s| s.expired).unwrap_or(false),
                error: match u {
                    None => CardError::Pending,
                    Some(s) if s.data.is_some() => CardError::None,
                    Some(s) => CardError::Kind(s.error_kind),
                },
                workspaces: ws_by_account
                    .get(&Some(id.clone()))
                    .map(|v| v.iter().map(|w| w.branch.clone()).collect())
                    .unwrap_or_default(),
                hotness,
            });
        }
        // default login card
        {
            let g = slow.global_usage.as_ref();
            let hotness = g
                .map(|d| {
                    d.five_hour
                        .utilization
                        .max(d.seven_day.utilization)
                        .max(d.fable.as_ref().map(|f| f.utilization).unwrap_or(0.0))
                })
                .unwrap_or(-1.0);
            cards.push(Card {
                label: "default".to_string(),
                five_hour: g.map(|d| d.five_hour.clone()),
                seven_day: g.map(|d| d.seven_day.clone()),
                fable: g.and_then(|d| d.fable.clone()),
                extra: g.and_then(|d| d.extra_utilization),
                fetched_at: g.map(|d| d.fetched_at).unwrap_or(0),
                expired: false,
                error: if g.is_some() {
                    CardError::None
                } else {
                    CardError::Pending
                },
                workspaces: ws_by_account
                    .get(&None)
                    .map(|v| v.iter().map(|w| w.branch.clone()).collect())
                    .unwrap_or_default(),
                hotness,
            });
        }
        cards.sort_by(|a, b| {
            b.hotness
                .partial_cmp(&a.hotness)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for c in &cards {
            self.cards_box.append(&build_card(c, now));
        }
    }

    fn rebuild_disk(&self, snap: &ResourceSnapshot, worktree_bytes: u64, now: i64) {
        clear(&self.disk_box);
        let disk = snap.disk.as_ref();
        let items: Vec<(&str, Option<u64>, Option<&str>)> = vec![
            (
                "Worktrees",
                (worktree_bytes > 0).then_some(worktree_bytes),
                Some("apparent size — reflinked extents may be shared"),
            ),
            ("Scratch sessions", disk.and_then(|d| d.scratch_bytes), None),
            ("Terminal logs", disk.and_then(|d| d.logs_bytes), None),
            ("Sandbox backups", disk.and_then(|d| d.backups_bytes), None),
            ("Events spool", disk.and_then(|d| d.events_bytes), None),
        ];
        let max = items.iter().filter_map(|d| d.1).max().unwrap_or(0);
        for (label, bytes, note) in &items {
            let r = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            r.add_css_class("res-disk-row");
            if let Some(n) = note {
                r.set_tooltip_text(Some(n));
            }
            let l = gtk::Label::new(Some(label));
            l.set_xalign(0.0);
            l.set_width_request(160);
            l.add_css_class("res-disk-label");
            r.append(&l);
            let frac = match (max, bytes) {
                (m, Some(b)) if m > 0 => *b as f64 / m as f64,
                _ => 0.0,
            };
            r.append(&meter_track(frac, "meter-accent-2"));
            r.append(&cell(&opt_bytes(*bytes), "res-cell"));
            self.disk_box.append(&r);
        }
        if let Some(d) = disk {
            let ago = now - d.measured_at;
            let note = gtk::Label::new(Some(&format!(
                "directories measured {}",
                format_updated_ago(ago)
            )));
            note.set_xalign(0.0);
            note.add_css_class("res-disk-note");
            self.disk_box.append(&note);
        }
    }
}

// ---- row/card model ---------------------------------------------------------

struct AgentRow {
    key: String,
    cpu: f64,
    mem: u64,
    procs: u64,
    remote: bool,
    sessions: Vec<SessionResourceStat>,
}

enum CardError {
    None,
    Pending,
    Kind(Option<UsageErrorKind>),
}

struct Card {
    label: String,
    five_hour: Option<UsageWindow>,
    seven_day: Option<UsageWindow>,
    fable: Option<UsageWindow>,
    extra: Option<f64>,
    fetched_at: i64,
    expired: bool,
    error: CardError,
    workspaces: Vec<String>,
    hotness: f64,
}

fn row_key(s: &SessionResourceStat) -> String {
    s.workspace_id.clone().unwrap_or_else(|| s.pty_id.clone())
}

fn detail_to_window(d: &UsageWindowDetail) -> UsageWindow {
    UsageWindow {
        utilization: d.utilization,
        resets_at: d.resets_at.clone(),
    }
}

// ---- widget builders --------------------------------------------------------

fn section(parent: &gtk::Box, title: &str, name: &str) -> gtk::Box {
    let sect = gtk::Box::new(gtk::Orientation::Vertical, 8);
    sect.add_css_class("res-section");
    let t = gtk::Label::new(Some(title));
    t.set_xalign(0.0);
    t.add_css_class("res-section-title");
    sect.append(&t);
    let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
    content.set_widget_name(&format!("{name}-content"));
    if name == "res-cards" {
        content.set_orientation(gtk::Orientation::Horizontal);
        content.add_css_class("res-cards");
    }
    sect.append(&content);
    parent.append(&sect);
    content
}

fn tile(label: &str, value: &str, sub: &str) -> gtk::Box {
    let t = gtk::Box::new(gtk::Orientation::Vertical, 2);
    t.add_css_class("res-tile");
    let l = gtk::Label::new(Some(label));
    l.set_xalign(0.0);
    l.add_css_class("res-tile-label");
    let v = gtk::Label::new(Some(value));
    v.set_xalign(0.0);
    v.add_css_class("res-tile-value");
    let s = gtk::Label::new(Some(sub));
    s.set_xalign(0.0);
    s.add_css_class("res-tile-sub");
    t.append(&l);
    t.append(&v);
    t.append(&s);
    t
}

fn agents_head() -> gtk::Box {
    let head = grid_row("res-table-head");
    for (text, class) in [
        ("", ""),
        ("workspace", ""),
        ("sessions", ""),
        ("trace · 3m", "res-col-trace"),
        ("cpu", ""),
        ("memory", ""),
        ("procs", "res-col-procs"),
        ("disk", "res-col-disk"),
        ("ctx", "res-col-ctx"),
        ("", "res-col-stop"),
    ] {
        head.append(&cell(text, class));
    }
    head
}

fn app_head() -> gtk::Box {
    let head = grid_row("res-table-head");
    for text in ["process", "pid", "cpu", "memory"] {
        head.append(&cell(text, ""));
    }
    head
}

fn grid_row(class: &str) -> gtk::Box {
    let r = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    for c in class.split_whitespace() {
        r.add_css_class(c);
    }
    r
}

fn cell(text: &str, class: &str) -> gtk::Label {
    let l = gtk::Label::new(Some(text));
    l.set_xalign(0.0);
    for c in class.split_whitespace() {
        l.add_css_class(c);
    }
    l
}

fn session_chips(sessions: &[SessionResourceStat]) -> gtk::Box {
    let chips = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    chips.add_css_class("res-chips");
    for s in sessions {
        let kind = match s.kind {
            SessionKind::Agent => "agent",
            SessionKind::Run => "run",
            SessionKind::Nvim => "nvim",
            SessionKind::Login => "login",
        };
        let chip = gtk::Label::new(Some(kind));
        chip.add_css_class("res-chip");
        chip.add_css_class(kind);
        chips.append(&chip);
    }
    chips
}

fn cpu_cell(pct: f64) -> gtk::Box {
    let c = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    c.add_css_class("res-cpu-cell");
    let clamped = (pct / 100.0).clamp(0.0, 1.0);
    c.append(&meter_track(clamped, "meter-accent"));
    c.append(&cell(&format_cpu(pct), "res-cell"));
    c
}

/// A slim usage-bar track with a fractional fill (0..1) in the given fill class.
fn meter_track(frac: f64, fill_class: &str) -> gtk::Box {
    let track = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    track.add_css_class("usage-bar-track");
    track.set_width_request(60);
    track.set_valign(gtk::Align::Center);
    let fill = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    fill.add_css_class("usage-bar-fill");
    fill.add_css_class(fill_class);
    fill.set_hexpand(false);
    // Represent the fraction with size groups is overkill; use a fixed width.
    let width = (60.0 * frac.clamp(0.0, 1.0)).round() as i32;
    fill.set_width_request(width.max(if frac > 0.0 { 2 } else { 0 }));
    track.append(&fill);
    track
}

fn build_procs(procs_box: &gtk::Box, row: &AgentRow) {
    let mut procs: Vec<_> = row.sessions.iter().flat_map(|s| s.processes.clone()).collect();
    procs.sort_by_key(|p| std::cmp::Reverse(p.mem_bytes));
    if procs.is_empty() {
        let empty = gtk::Label::new(Some("No live processes."));
        empty.set_xalign(0.0);
        empty.add_css_class("res-procs-empty");
        procs_box.append(&empty);
    }
    for p in &procs {
        let r = grid_row("res-proc");
        r.append(&cell(&p.comm, "res-proc-comm"));
        r.append(&cell(&p.pid.to_string(), "res-cell dim"));
        r.append(&cell(&format_cpu(p.cpu_pct), "res-cell"));
        r.append(&cell(&format_bytes(p.mem_bytes), "res-cell"));
        procs_box.append(&r);
    }
    let shown = procs.len() as u64;
    if row.procs > shown {
        let more = gtk::Label::new(Some(&format!(
            "+{} more (smallest not shown)",
            row.procs - shown
        )));
        more.set_xalign(0.0);
        more.add_css_class("res-procs-empty");
        procs_box.append(&more);
    }
}

fn build_login_row(s: &SessionResourceStat) -> gtk::Box {
    let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    header.add_css_class("res-agent-row");
    header.add_css_class("static");
    let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    dot.add_css_class("ws-dot");
    dot.add_css_class("running");
    dot.set_valign(gtk::Align::Center);
    header.append(&dot);
    let name_box = gtk::Box::new(gtk::Orientation::Vertical, 1);
    name_box.set_width_request(190);
    let name = cell("login", "res-agent-branch");
    let acct = s
        .pty_id
        .strip_prefix("account-login:")
        .unwrap_or(&s.pty_id);
    let sub = cell(acct, "res-agent-sub");
    name_box.append(&name);
    name_box.append(&sub);
    header.append(&name_box);
    header.append(&session_chips(std::slice::from_ref(s)));
    let trace_col = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    trace_col.set_width_request(100);
    header.append(&trace_col);
    header.append(&cpu_cell(s.cpu_pct));
    header.append(&cell(&format_bytes(s.mem_bytes), "res-cell"));
    header.append(&cell(&s.proc_count.to_string(), "res-cell dim res-col-procs"));
    header.append(&cell("—", "res-cell dim res-col-disk"));
    header.append(&cell("—", "res-cell dim res-col-ctx"));
    let stop_col = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    stop_col.add_css_class("res-col-stop");
    header.append(&stop_col);
    header
}

fn build_card(c: &Card, now: i64) -> gtk::Box {
    let card = gtk::Box::new(gtk::Orientation::Vertical, 6);
    card.add_css_class("res-account-card");
    card.set_widget_name(&format!("res-card-{}", c.label));

    let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    head.add_css_class("res-account-head");
    let name = gtk::Label::new(Some(&c.label));
    name.add_css_class("res-account-name");
    apply_color(&name, &hsl_to_hex(&login_color(&c.label)));
    head.append(&name);
    match &c.error {
        CardError::Pending => head.append(&note("fetching…", false)),
        CardError::Kind(kind) => head.append(&note(usage_error_text(*kind), true)),
        CardError::None => {
            if c.expired {
                head.append(&note("token expired", true));
            } else if c.fetched_at > 0 {
                head.append(&note(&format_updated_ago(now - c.fetched_at), false));
            }
        }
    }
    card.append(&head);

    if let Some(w) = &c.five_hour {
        card.append(&limit_row("5h", w, now));
    }
    if let Some(w) = &c.seven_day {
        card.append(&limit_row("7d", w, now));
    }
    if let Some(w) = &c.fable {
        card.append(&limit_row("fable", w, now));
    }
    if let Some(extra) = c.extra {
        card.append(&meter_row(
            "extra",
            extra,
            &format!("{}%", extra.round() as i64),
            Severity::of(extra),
            "pay-as-you-go pool",
        ));
    }

    let ws_text = if c.workspaces.is_empty() {
        "no workspaces".to_string()
    } else {
        let shown: Vec<&str> = c.workspaces.iter().take(3).map(|s| s.as_str()).collect();
        let plural = if c.workspaces.len() == 1 { "" } else { "s" };
        let extra = if c.workspaces.len() > 3 {
            format!(" +{} more", c.workspaces.len() - 3)
        } else {
            String::new()
        };
        format!(
            "{} workspace{}: {}{}",
            c.workspaces.len(),
            plural,
            shown.join(", "),
            extra
        )
    };
    let ws = gtk::Label::new(Some(&ws_text));
    ws.set_xalign(0.0);
    ws.set_wrap(true);
    ws.add_css_class("res-account-ws");
    card.append(&ws);
    card
}

fn note(text: &str, err: bool) -> gtk::Label {
    let l = gtk::Label::new(Some(text));
    l.add_css_class("res-account-note");
    if err {
        l.add_css_class("err");
    }
    l
}

fn limit_row(label: &str, w: &UsageWindow, now: i64) -> gtk::Box {
    let pct = w.utilization.round().clamp(0.0, 100.0);
    let reset = reset_countdown(&w.resets_at, now);
    meter_row(
        label,
        pct,
        &format!("{}%", pct as i64),
        Severity::of(w.utilization),
        &reset,
    )
}

fn meter_row(label: &str, pct: f64, text: &str, sev: Severity, detail: &str) -> gtk::Box {
    let r = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    r.add_css_class("res-meter");
    let l = gtk::Label::new(Some(label));
    l.set_xalign(0.0);
    l.set_width_request(48);
    l.add_css_class("res-meter-label");
    r.append(&l);
    let track = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    track.add_css_class("usage-bar-track");
    track.set_hexpand(true);
    let fill = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    fill.add_css_class("usage-bar-fill");
    fill.add_css_class(sev.meter_class());
    fill.set_hexpand(false);
    // Fraction rendered by a horizontal size ratio via halign+width fraction:
    // approximate with a width_request against a nominal 200px track.
    let width = (200.0 * (pct / 100.0).clamp(0.0, 1.0)).round() as i32;
    fill.set_width_request(width.max(if pct > 0.0 { 2 } else { 0 }));
    track.append(&fill);
    r.append(&track);
    let v = gtk::Label::new(Some(text));
    v.add_css_class("res-meter-value");
    v.set_width_request(44);
    r.append(&v);
    let d = gtk::Label::new(Some(detail));
    d.add_css_class("res-meter-detail");
    d.set_xalign(1.0);
    r.append(&d);
    r
}

fn app_type_label(t: &str) -> String {
    match t {
        "Browser" => "Main process".to_string(),
        "Tab" => "Renderer".to_string(),
        "GPU" => "GPU".to_string(),
        other => other.to_string(),
    }
}

fn usage_error_text(kind: Option<UsageErrorKind>) -> &'static str {
    match kind {
        Some(UsageErrorKind::NoScope) => "no usage scope",
        Some(UsageErrorKind::RateLimited) => "rate limited",
        Some(UsageErrorKind::NotLoggedIn) => "not logged in",
        Some(UsageErrorKind::NoDir) => "no config dir",
        _ => "usage unavailable",
    }
}

fn opt_bytes(b: Option<u64>) -> String {
    b.map(format_bytes).unwrap_or_else(|| "—".to_string())
}

fn opt_tokens(t: Option<u64>) -> String {
    t.map(format_tokens).unwrap_or_else(|| "—".to_string())
}

fn status_css(status: orchestra_rpc::types::WorkspaceStatus) -> &'static str {
    use orchestra_rpc::types::WorkspaceStatus as S;
    match status {
        S::Idle => "idle",
        S::Running => "running",
        S::Waiting => "waiting",
        S::Error => "error",
        S::Stopped => "stopped",
    }
}

fn clear(b: &gtk::Box) {
    while let Some(child) = b.first_child() {
        b.remove(&child);
    }
}

/// Apply a per-login hue to a label via pango markup (per-widget CSS was
/// deprecated in gtk 4.10; markup colors the text without a stylesheet class).
fn apply_color(label: &gtk::Label, color: &str) {
    let text = glib::markup_escape_text(&label.text());
    label.set_markup(&format!("<span foreground=\"{color}\">{text}</span>"));
}

/// Resolve a login-color hsl() string to a `#rrggbb` pango accepts. gdk::RGBA
/// parses hsl() poorly across versions, so convert here.
fn hsl_to_hex(hsl: &str) -> String {
    // Expect "hsl(H, 55%, 68%)".
    let nums: Vec<f64> = hsl
        .trim_start_matches("hsl(")
        .trim_end_matches(')')
        .split(',')
        .filter_map(|p| p.trim().trim_end_matches('%').parse::<f64>().ok())
        .collect();
    if nums.len() != 3 {
        return "#e6e9ef".to_string();
    }
    let (h, s, l) = (nums[0] / 360.0, nums[1] / 100.0, nums[2] / 100.0);
    let hue = |p: f64, q: f64, mut t: f64| -> f64 {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    let (r, g, b) = if s == 0.0 {
        (l, l, l)
    } else {
        let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
        let p = 2.0 * l - q;
        (
            hue(p, q, h + 1.0 / 3.0),
            hue(p, q, h),
            hue(p, q, h - 1.0 / 3.0),
        )
    };
    format!(
        "#{:02x}{:02x}{:02x}",
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8
    )
}

/// Convert an ISO-8601 reset timestamp into "resets in …" relative to `now`
/// (epoch ms). Falls back to the raw string if it can't be parsed.
fn reset_countdown(resets_at: &str, now: i64) -> String {
    match glib::DateTime::from_iso8601(resets_at, Some(&glib::TimeZone::utc())) {
        Ok(dt) => {
            let reset_ms = dt.to_unix() * 1000;
            format!("resets in {}", format_resets_in(reset_ms - now))
        }
        Err(_) => String::new(),
    }
}

// ---- cairo sparkline --------------------------------------------------------

/// Draw a CPU sparkline into a cairo context: faint baseline, area fill at
/// 0.14 alpha, accent polyline, endpoint dot (Electron `Spark` port). Scale is
/// `max(100, peak)`.
fn draw_spark(cr: &gtk::cairo::Context, width: i32, height: i32, values: &[f64]) {
    let w = width as f64;
    let h = height as f64;
    // faint baseline
    cr.set_source_rgba(0.55, 0.60, 0.68, 0.18);
    cr.set_line_width(1.0);
    cr.move_to(0.0, h - 1.5);
    cr.line_to(w, h - 1.5);
    let _ = cr.stroke();

    if values.len() < 2 {
        return;
    }
    let peak = values.iter().cloned().fold(0.0, f64::max);
    let max = spark_scale(peak);
    let step = w / (support::HISTORY_LEN as f64 - 1.0);
    let n = values.len();
    let point = |i: usize| -> (f64, f64) {
        let x = w - (n - 1 - i) as f64 * step;
        let y = h - 1.5 - (values[i].min(max) / max) * (h - 3.0);
        (x, y)
    };

    // area fill
    let (x0, y0) = point(0);
    cr.move_to(x0, y0);
    for i in 1..n {
        let (x, y) = point(i);
        cr.line_to(x, y);
    }
    let (xl, _) = point(n - 1);
    cr.line_to(xl, h);
    cr.line_to(x0, h);
    cr.close_path();
    // accent ~ #6ea8ff
    cr.set_source_rgba(0.431, 0.659, 1.0, 0.14);
    let _ = cr.fill();

    // polyline
    cr.set_source_rgba(0.431, 0.659, 1.0, 1.0);
    cr.set_line_width(1.5);
    cr.set_line_join(gtk::cairo::LineJoin::Round);
    cr.set_line_cap(gtk::cairo::LineCap::Round);
    let (x0, y0) = point(0);
    cr.move_to(x0, y0);
    for i in 1..n {
        let (x, y) = point(i);
        cr.line_to(x, y);
    }
    let _ = cr.stroke();

    // endpoint emphasis
    let (xe, ye) = point(n - 1);
    cr.arc(xe, ye, 2.0, 0.0, std::f64::consts::TAU);
    let _ = cr.fill();
}
