//! Insights & Improvements overlay (plan §5.6, parity:
//! `src/renderer/components/Insights.tsx`).
//!
//! Orchestra-native monthly Claude Code self-tuning. Two surfaces:
//!  * [`InsightsSection`] — the sidebar entry (idle summary row, or per-step
//!    status rows while a run is in flight). B1 mounts this at the bottom of
//!    the sidebar; it is exported cleanly and owns no overlay state.
//!  * [`InsightsOverlay`] — the full pane: run history (click to select), the
//!    selected run's step list + lessons diff + live transcript (seeded from
//!    `getSelfTuneOutput`, appended from `selfTuneOutput` events, tail-follow),
//!    Run-now, per-login report buttons, and a read-only LESSONS.md panel with
//!    an "N new" header and added-bullet highlighting.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::glib;
use gtk::pango;
use gtk::prelude::*;

use orchestra_rpc::events::UiEvent;
use orchestra_rpc::types::{
    LessonsDiff, SelfTuneReport, SelfTuneRun, SelfTuneRunStatus, SelfTuneStep, SelfTuneStepKind,
    SelfTuneStepStatus,
};

use crate::backend::Backend;
use crate::sound::{self, SoundPlayer};
use crate::state::UiState;

// ---- time helpers (Insights.tsx fmt* ports) ---------------------------------

fn fmt_day(ts: i64) -> String {
    match glib::DateTime::from_unix_local(ts / 1000) {
        Ok(dt) => dt.format("%b %-d").unwrap_or_default().to_string(),
        Err(_) => String::new(),
    }
}

fn fmt_time(ts: i64) -> String {
    match glib::DateTime::from_unix_local(ts / 1000) {
        Ok(dt) => dt.format("%H:%M").unwrap_or_default().to_string(),
        Err(_) => String::new(),
    }
}

fn fmt_duration(a: i64, b: i64) -> String {
    let s = ((b - a) / 1000).max(0);
    if s < 60 {
        format!("{s}s")
    } else {
        format!("{}m {}s", s / 60, s % 60)
    }
}

/// One-line outcome for a finished run (`runOutcome`).
fn run_outcome(run: &SelfTuneRun) -> String {
    let day = fmt_day(run.finished_at.unwrap_or(run.started_at));
    match run.status {
        SelfTuneRunStatus::Running => format!("{day} · running…"),
        SelfTuneRunStatus::Failed => format!("{day} · failed"),
        SelfTuneRunStatus::Ok => {
            format!("{day} · {}", run.summary.as_deref().unwrap_or("completed"))
        }
    }
}

/// The lesson bullets of a LESSONS.md (`parseLessonBullets`): top-level `- `
/// lines with the marker stripped.
fn parse_lesson_bullets(content: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|l| l.trim().strip_prefix("- ").map(|b| b.trim().to_string()))
        .collect()
}

fn step_status_icon(status: SelfTuneStepStatus) -> gtk::Widget {
    match status {
        SelfTuneStepStatus::Running => {
            let spinner = gtk::Spinner::new();
            spinner.start();
            spinner.add_css_class("insights-step-spinner");
            spinner.upcast()
        }
        SelfTuneStepStatus::Ok => icon_label("✓", "insights-step-icon ok"),
        SelfTuneStepStatus::Failed => icon_label("✕", "insights-step-icon fail"),
        SelfTuneStepStatus::Pending => icon_label("○", "insights-step-icon pending"),
    }
}

fn icon_label(text: &str, class: &str) -> gtk::Widget {
    let l = gtk::Label::new(Some(text));
    for c in class.split_whitespace() {
        l.add_css_class(c);
    }
    l.upcast()
}

fn step_label_text(step: &SelfTuneStep, pane: bool) -> String {
    match (step.kind, pane) {
        (SelfTuneStepKind::Fold, _) => "fold lessons".to_string(),
        (SelfTuneStepKind::Insights, true) => format!("/insights — {}", step.label),
        (SelfTuneStepKind::Insights, false) => step.label.clone(),
    }
}

// ---- sidebar section (exported for B1) --------------------------------------

/// Sidebar entry: idle → one summary row; running → per-step status rows.
/// `on_toggle` fires when the header row is clicked (B1 wires it to open the
/// overlay). Call [`InsightsSection::set_runs`] whenever the run list changes.
pub struct InsightsSection {
    root: gtk::Box,
    row: gtk::Button,
    sub: gtk::Label,
    steps_box: gtk::Box,
    active: RefCell<bool>,
}

impl InsightsSection {
    pub fn new(on_toggle: impl Fn() + 'static) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.add_css_class("insights-section");
        root.set_widget_name("insights-section");

        let row = gtk::Button::new();
        row.set_widget_name("insights-row");
        row.add_css_class("insights-row");
        row.set_tooltip_text(Some(
            "Insights & Improvements — monthly Claude Code self-tuning",
        ));
        let row_box = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        // Was the ✦ literal (U+2726). The renderer draws Lucide `sparkles`
        // here (Insights.tsx `SparkleIcon`), whose geometry the bundled
        // orch-insights-symbolic already reproduces exactly — the asset was
        // registered and simply unused at this call site.
        let icon = crate::icons::image_sized(crate::icons::INSIGHTS, 14);
        icon.add_css_class("insights-row-icon");
        row_box.append(&icon);
        let title = gtk::Label::new(Some("Insights"));
        title.add_css_class("insights-row-title");
        row_box.append(&title);
        let sub = gtk::Label::new(Some("not run yet"));
        sub.set_hexpand(true);
        sub.set_xalign(1.0);
        sub.set_ellipsize(pango::EllipsizeMode::End);
        sub.add_css_class("insights-row-sub");
        row_box.append(&sub);
        row.set_child(Some(&row_box));
        row.connect_clicked(move |_| on_toggle());
        root.append(&row);

        let steps_box = gtk::Box::new(gtk::Orientation::Vertical, 2);
        steps_box.add_css_class("insights-steps");
        steps_box.set_visible(false);
        root.append(&steps_box);

        Rc::new(Self {
            root,
            row,
            sub,
            steps_box,
            active: RefCell::new(false),
        })
    }

    pub fn widget(&self) -> &gtk::Box {
        &self.root
    }

    /// Mark the row active/inactive (overlay open state).
    pub fn set_active(&self, active: bool) {
        *self.active.borrow_mut() = active;
        if active {
            self.row.add_css_class("active");
        } else {
            self.row.remove_css_class("active");
        }
    }

    pub fn set_runs(&self, runs: &[SelfTuneRun]) {
        let last = runs.first();
        let running = last.filter(|r| r.status == SelfTuneRunStatus::Running);
        self.sub.set_text(
            match (running, last) {
                (Some(_), _) => "self-tuning…".to_string(),
                (None, Some(r)) => run_outcome(r),
                (None, None) => "not run yet".to_string(),
            }
            .as_str(),
        );

        clear(&self.steps_box);
        if let Some(run) = running {
            self.steps_box.set_visible(true);
            for step in &run.steps {
                self.steps_box.append(&sidebar_step_row(step));
            }
        } else {
            self.steps_box.set_visible(false);
        }
    }
}

fn sidebar_step_row(step: &SelfTuneStep) -> gtk::Box {
    let r = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    r.add_css_class("insights-step");
    r.append(&step_status_icon(step.status));
    let label = gtk::Label::new(Some(&step_label_text(step, false)));
    label.set_xalign(0.0);
    label.add_css_class("insights-step-label");
    r.append(&label);
    r
}

// ---- overlay ----------------------------------------------------------------

pub struct InsightsOverlay {
    root: gtk::Box,
    close_btn: gtk::Button,
    run_btn: gtk::Button,
    body: gtk::Box,

    backend: Rc<dyn Backend>,
    state: Rc<RefCell<UiState>>,
    player: Rc<SoundPlayer>,

    runs: RefCell<Vec<SelfTuneRun>>,
    /// The run whose transcript is shown; None follows the newest run.
    picked_run_id: RefCell<Option<String>>,
    /// Live transcript text for the shown run.
    transcript: RefCell<String>,
    transcript_view: RefCell<Option<gtk::TextView>>,
    reports: RefCell<Vec<SelfTuneReport>>,
    lessons: RefCell<String>,
}

impl InsightsOverlay {
    pub fn new(
        backend: Rc<dyn Backend>,
        state: Rc<RefCell<UiState>>,
        player: Rc<SoundPlayer>,
    ) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.set_widget_name("insights-overlay");
        root.add_css_class("overlay");
        root.add_css_class("insights-view");
        root.set_visible(false);

        // Header.
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        header.add_css_class("insights-view-header");
        let titles = gtk::Box::new(gtk::Orientation::Vertical, 2);
        titles.set_hexpand(true);
        let h2 = gtk::Label::new(Some("Insights & Improvements"));
        h2.set_xalign(0.0);
        h2.add_css_class("overlay-title");
        let sub = gtk::Label::new(Some(
            "Monthly self-tune: regenerate each login's Claude Code insights report, then \
             distill new friction lessons into ~/.claude/LESSONS.md",
        ));
        sub.set_xalign(0.0);
        sub.set_wrap(true);
        sub.add_css_class("insights-view-sub");
        titles.append(&h2);
        titles.append(&sub);
        header.append(&titles);

        let run_btn = gtk::Button::with_label("Run now");
        run_btn.set_widget_name("insights-run-btn");
        run_btn.add_css_class("primary");
        run_btn.add_css_class("insights-run-btn");
        run_btn.set_valign(gtk::Align::Start);
        header.append(&run_btn);

        let close_btn = gtk::Button::with_label("×");
        close_btn.set_widget_name("insights-close");
        close_btn.add_css_class("overlay-close");
        close_btn.set_tooltip_text(Some("Close"));
        close_btn.set_valign(gtk::Align::Start);
        header.append(&close_btn);
        root.append(&header);

        // Body scroll.
        let scroll = gtk::ScrolledWindow::new();
        scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        scroll.set_vexpand(true);
        let body = gtk::Box::new(gtk::Orientation::Vertical, 16);
        body.add_css_class("insights-view-body");
        scroll.set_child(Some(&body));
        root.append(&scroll);

        let overlay = Rc::new(Self {
            root,
            close_btn,
            run_btn,
            body,
            backend,
            state,
            player,
            runs: RefCell::new(Vec::new()),
            picked_run_id: RefCell::new(None),
            transcript: RefCell::new(String::new()),
            transcript_view: RefCell::new(None),
            reports: RefCell::new(Vec::new()),
            lessons: RefCell::new(String::new()),
        });

        {
            let o = overlay.clone();
            overlay.run_btn.connect_clicked(move |_| o.on_run_now());
        }

        overlay
    }

    pub fn widget(&self) -> &gtk::Box {
        &self.root
    }

    pub fn on_close(self: &Rc<Self>, f: impl Fn() + 'static) {
        self.close_btn.connect_clicked(move |_| f());
    }

    /// Load runs/reports/lessons and render when the overlay is shown.
    pub fn on_shown(self: &Rc<Self>) {
        self.refresh_runs();
        self.refresh_reports_and_lessons();
        self.reseed_transcript();
        self.rebuild();
    }

    pub fn on_hidden(&self) {}

    /// Route a backend event: self-tune stream updates the run list, transcript
    /// appends for the shown run. (Agent chimes are handled here too since the
    /// overlay owns the SoundPlayer clone.)
    pub fn dispatch(self: &Rc<Self>, ev: &UiEvent) {
        match ev {
            UiEvent::SelfTuneUpdate(run) => {
                self.apply_run_update((**run).clone());
            }
            UiEvent::SelfTuneOutput { run_id, chunk }
                if self.shown_run_id().as_deref() == Some(run_id.as_str()) =>
            {
                self.transcript.borrow_mut().push_str(chunk);
                self.append_transcript(chunk);
            }
            _ => {}
        }
    }

    fn refresh_runs(&self) {
        if let Ok(v) = self.backend.call("listSelfTuneRuns", vec![]) {
            if let Ok(runs) = serde_json::from_value::<Vec<SelfTuneRun>>(v) {
                *self.runs.borrow_mut() = runs;
            }
        }
    }

    fn refresh_reports_and_lessons(&self) {
        if let Ok(v) = self.backend.call("listSelfTuneReports", vec![]) {
            if let Ok(reports) = serde_json::from_value::<Vec<SelfTuneReport>>(v) {
                *self.reports.borrow_mut() = reports;
            }
        }
        if let Ok(v) = self.backend.call("readSelfTuneLessons", vec![]) {
            if let Ok(s) = serde_json::from_value::<String>(v) {
                *self.lessons.borrow_mut() = s;
            }
        }
    }

    /// The run whose transcript is shown: the picked one if still present, else
    /// the newest.
    fn shown_run_id(&self) -> Option<String> {
        let runs = self.runs.borrow();
        if let Some(picked) = self.picked_run_id.borrow().as_ref() {
            if runs.iter().any(|r| &r.id == picked) {
                return Some(picked.clone());
            }
        }
        runs.first().map(|r| r.id.clone())
    }

    fn reseed_transcript(&self) {
        self.transcript.borrow_mut().clear();
        if let Some(id) = self.shown_run_id() {
            if let Ok(v) = self
                .backend
                .call("getSelfTuneOutput", vec![serde_json::json!(id)])
            {
                if let Ok(s) = serde_json::from_value::<String>(v) {
                    *self.transcript.borrow_mut() = s;
                }
            }
        }
    }

    fn apply_run_update(self: &Rc<Self>, run: SelfTuneRun) {
        {
            let mut runs = self.runs.borrow_mut();
            if let Some(existing) = runs.iter_mut().find(|r| r.id == run.id) {
                *existing = run;
            } else {
                runs.insert(0, run);
            }
        }
        self.rebuild();
    }

    fn on_run_now(self: &Rc<Self>) {
        let running = self
            .runs
            .borrow()
            .first()
            .map(|r| r.status == SelfTuneRunStatus::Running)
            .unwrap_or(false);
        if running {
            return;
        }
        self.run_btn.set_label("Running…");
        self.run_btn.set_sensitive(false);
        let result = self.backend.call("startSelfTune", vec![]);
        // Follow the new run.
        *self.picked_run_id.borrow_mut() = None;
        // Wire contract (ipc.ts:282): resolves with the BARE SelfTuneRun, and
        // REJECTS when a run is already in flight (self-tune.ts:284 throws
        // "A self-tune run is already in progress"). A thrown handler crosses
        // ui-rpc as a frame-level `{ok:false,error}` response, which the client
        // surfaces as Err(RpcError::Backend) — so the conflict lands in the Err
        // arm, never as an Ok envelope.
        match result {
            Ok(v) => match serde_json::from_value::<SelfTuneRun>(v) {
                Ok(run) => self.apply_run_update(run),
                // Shape drift: don't fail silently — the run list refresh below
                // still picks the run up, but the mismatch is worth surfacing.
                Err(e) => eprintln!("[insights] startSelfTune returned an unexpected shape: {e}"),
            },
            Err(e) => self.surface_start_error(&format!("{e}")),
        }
        self.refresh_runs();
        self.reseed_transcript();
        self.rebuild();
    }

    fn surface_start_error(self: &Rc<Self>, msg: &str) {
        let parent = self.root.root().and_downcast::<gtk::Window>();
        let msg = msg.to_string();
        glib::spawn_future_local(async move {
            if let Some(win) = parent {
                crate::dialogs::error(&win, "Could not start self-tune", &msg).await;
            }
        });
    }

    /// Open a login's newest report. `openSelfTuneReport` is declared
    /// `Promise<boolean>` (ipc.ts:290) and resolves **false** when that login
    /// has no report yet — it only rejects when the OS open itself fails
    /// (self-tune.ts:134). Both outcomes must be surfaced: silently discarding
    /// the `false` leaves the user clicking a button that does nothing.
    ///
    /// `has_report` is the cached hint from `listSelfTuneReports`; it can be
    /// stale (report deleted, or the list fetched before a run), so the
    /// server's answer is authoritative and gets the same "no report" message.
    fn on_open_report(self: &Rc<Self>, login_id: &str, has_report: bool) {
        let parent = self.root.root().and_downcast::<gtk::Window>();
        let no_report = |parent: Option<gtk::Window>| {
            glib::spawn_future_local(async move {
                if let Some(win) = parent {
                    crate::dialogs::alert(
                        &win,
                        "No report yet",
                        "This login has no insights report — run self-tune first.",
                    )
                    .await;
                }
            });
        };
        if !has_report {
            no_report(parent);
            return;
        }
        match self
            .backend
            .call("openSelfTuneReport", vec![serde_json::json!(login_id)])
        {
            // Bare `false` on the wire: the login has no report after all.
            Ok(v) if v.as_bool() == Some(false) => no_report(parent),
            Ok(_) => {}
            Err(e) => {
                let msg = format!("{e}");
                glib::spawn_future_local(async move {
                    if let Some(win) = parent {
                        crate::dialogs::error(&win, "Could not open report", &msg).await;
                    }
                });
            }
        }
    }

    fn append_transcript(&self, chunk: &str) {
        if let Some(view) = self.transcript_view.borrow().as_ref() {
            let buffer = view.buffer();
            let mut end = buffer.end_iter();
            buffer.insert(&mut end, chunk);
            // Tail-follow: scroll to the new end.
            let mark = buffer.create_mark(None, &buffer.end_iter(), false);
            view.scroll_mark_onscreen(&mark);
        }
    }

    fn rebuild(self: &Rc<Self>) {
        clear(&self.body);
        let runs = self.runs.borrow();
        let running = runs
            .first()
            .map(|r| r.status == SelfTuneRunStatus::Running)
            .unwrap_or(false);
        // Keep the Run-now button in sync.
        self.run_btn.set_sensitive(!running);
        self.run_btn
            .set_label(if running { "Running…" } else { "Run now" });

        let shown_id = self.shown_run_id();
        let shown = shown_id
            .as_ref()
            .and_then(|id| runs.iter().find(|r| &r.id == id));

        // ---- current/last run panel ----
        if let Some(run) = shown {
            self.body.append(&self.build_run_panel(run));
        } else {
            let panel = panel("No runs yet");
            let hint = gtk::Label::new(Some(
                "The pipeline runs automatically once per calendar month — or start one with \"Run now\".",
            ));
            hint.set_xalign(0.0);
            hint.set_wrap(true);
            hint.add_css_class("insights-empty-hint");
            panel.append(&hint);
            self.body.append(&panel);
        }

        // ---- reports ----
        {
            let panel = panel("Reports");
            let reports = self.reports.borrow();
            let list = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            list.add_css_class("insights-reports");
            if reports.is_empty() {
                let hint = gtk::Label::new(Some("No logins found."));
                hint.add_css_class("insights-empty-hint");
                list.append(&hint);
            }
            for r in reports.iter() {
                let has_report = r.report_path.is_some();
                let btn = gtk::Button::new();
                btn.set_widget_name(&format!("insights-report-{}", r.login_id));
                btn.add_css_class("insights-report-btn");
                btn.set_sensitive(has_report);
                btn.set_tooltip_text(Some(
                    r.report_path
                        .as_deref()
                        .unwrap_or("No report generated yet for this login"),
                ));
                let inner = gtk::Box::new(gtk::Orientation::Horizontal, 6);
                let label = gtk::Label::new(Some(&r.label));
                inner.append(&label);
                let open = gtk::Label::new(Some(if has_report { "open ↗" } else { "no report" }));
                open.add_css_class("insights-report-open");
                inner.append(&open);
                btn.set_child(Some(&inner));
                let this = self.clone();
                let login = r.login_id.clone();
                btn.connect_clicked(move |_| this.on_open_report(&login, has_report));
                list.append(&btn);
            }
            panel.append(&list);
            self.body.append(&panel);
        }

        // ---- history ----
        if runs.len() > 1 {
            let panel = panel("History");
            let list = gtk::Box::new(gtk::Orientation::Vertical, 2);
            list.add_css_class("insights-history");
            for r in runs.iter() {
                list.append(&self.build_history_row(r, shown_id.as_deref()));
            }
            panel.append(&list);
            self.body.append(&panel);
        }

        // ---- LESSONS.md ----
        self.body.append(&self.build_lessons_panel(&runs));
    }

    fn build_run_panel(self: &Rc<Self>, run: &SelfTuneRun) -> gtk::Box {
        let title = if run.status == SelfTuneRunStatus::Running {
            "Current run"
        } else {
            "Last run"
        };
        let p = panel_with_meta(
            title,
            &format!(
                "{} {} · {}{}",
                fmt_day(run.started_at),
                fmt_time(run.started_at),
                trigger_label(run),
                run.finished_at
                    .map(|f| format!(" · {}", fmt_duration(run.started_at, f)))
                    .unwrap_or_default(),
            ),
        );

        let steps = gtk::Box::new(gtk::Orientation::Vertical, 3);
        steps.add_css_class("insights-steps");
        steps.add_css_class("insights-steps-pane");
        for step in &run.steps {
            let r = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            r.add_css_class("insights-step");
            r.append(&step_status_icon(step.status));
            let label = gtk::Label::new(Some(&step_label_text(step, true)));
            label.set_xalign(0.0);
            label.add_css_class("insights-step-label");
            r.append(&label);
            let mut meta = String::new();
            if let (Some(a), Some(b)) = (step.started_at, step.finished_at) {
                meta.push_str(&fmt_duration(a, b));
            }
            if step.status == SelfTuneStepStatus::Failed {
                if let Some(code) = step.exit_code {
                    if code != 0 {
                        meta.push_str(&format!(" · exit {code}"));
                    }
                }
            }
            if let Some(err) = &step.error {
                meta.push_str(&format!(" · {err}"));
            }
            if !meta.is_empty() {
                let m = gtk::Label::new(Some(&meta));
                m.add_css_class("insights-step-meta");
                m.set_hexpand(true);
                m.set_xalign(1.0);
                r.append(&m);
            }
            steps.append(&r);
        }
        p.append(&steps);

        // lessons diff
        if let Some(diff) = &run.lessons {
            if !diff.added.is_empty() || !diff.removed.is_empty() {
                p.append(&build_diff(diff));
            }
        }

        // transcript
        let view = gtk::TextView::new();
        view.set_widget_name("insights-transcript");
        view.set_editable(false);
        view.set_cursor_visible(false);
        view.set_monospace(true);
        view.set_wrap_mode(gtk::WrapMode::WordChar);
        view.add_css_class("insights-transcript");
        let text = self.transcript.borrow();
        let placeholder = if run.status == SelfTuneRunStatus::Running {
            "Waiting for output…"
        } else {
            "No transcript available for this run."
        };
        view.buffer().set_text(if text.is_empty() {
            placeholder
        } else {
            text.as_str()
        });
        let scroll = gtk::ScrolledWindow::new();
        scroll.set_min_content_height(200);
        scroll.set_child(Some(&view));
        scroll.add_css_class("insights-transcript-scroll");
        *self.transcript_view.borrow_mut() = Some(view);
        p.append(&scroll);

        p
    }

    fn build_history_row(
        self: &Rc<Self>,
        run: &SelfTuneRun,
        shown_id: Option<&str>,
    ) -> gtk::Button {
        let btn = gtk::Button::new();
        btn.set_widget_name(&format!("insights-history-{}", run.id));
        btn.add_css_class("insights-history-row");
        if Some(run.id.as_str()) == shown_id {
            btn.add_css_class("selected");
        }
        btn.set_tooltip_text(Some("Show this run's transcript"));
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let status_dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        status_dot.add_css_class("insights-history-status");
        status_dot.add_css_class(run_status_css(run.status));
        status_dot.set_valign(gtk::Align::Center);
        row.append(&status_dot);
        let when = gtk::Label::new(Some(&format!(
            "{} {}",
            fmt_day(run.started_at),
            fmt_time(run.started_at)
        )));
        when.add_css_class("insights-history-when");
        row.append(&when);
        let trig = gtk::Label::new(Some(trigger_label(run)));
        trig.add_css_class("insights-history-trigger");
        row.append(&trig);
        let summary = gtk::Label::new(Some(match run.status {
            SelfTuneRunStatus::Running => "running…",
            SelfTuneRunStatus::Failed => "failed",
            SelfTuneRunStatus::Ok => run.summary.as_deref().unwrap_or("completed"),
        }));
        summary.set_hexpand(true);
        summary.set_xalign(0.0);
        summary.set_ellipsize(pango::EllipsizeMode::End);
        summary.add_css_class("insights-history-summary");
        row.append(&summary);
        btn.set_child(Some(&row));

        let this = self.clone();
        let id = run.id.clone();
        btn.connect_clicked(move |_| {
            *this.picked_run_id.borrow_mut() = Some(id.clone());
            this.reseed_transcript();
            this.rebuild();
        });
        btn
    }

    fn build_lessons_panel(&self, runs: &[SelfTuneRun]) -> gtk::Box {
        let lessons = self.lessons.borrow();
        let count = parse_lesson_bullets(&lessons).len();
        // Newest run that recorded a diff → "what's new".
        let latest_diff: Option<&LessonsDiff> = runs.iter().find_map(|r| r.lessons.as_ref());
        let new_set: std::collections::HashSet<&str> = latest_diff
            .map(|d| d.added.iter().map(|s| s.as_str()).collect())
            .unwrap_or_default();

        let new_note = latest_diff
            .filter(|d| !d.added.is_empty())
            .map(|d| format!(" · {} new since the last run", d.added.len()))
            .unwrap_or_default();
        let meta = format!(
            "~/.claude/LESSONS.md · {count} lesson{}{new_note} · @-imported into every session",
            if count == 1 { "" } else { "s" }
        );
        let p = panel_with_meta("LESSONS.md", &meta);

        let view = gtk::TextView::new();
        view.set_widget_name("insights-lessons");
        view.set_editable(false);
        view.set_cursor_visible(false);
        view.set_monospace(true);
        view.set_wrap_mode(gtk::WrapMode::WordChar);
        view.add_css_class("insights-lessons");
        let buffer = view.buffer();
        if lessons.is_empty() {
            buffer.set_text("No LESSONS.md found.");
        } else {
            // Highlight added bullets with a bold, accent-colored tag (a
            // TextTag isn't a widget, so it can't take a CSS class — style it
            // via tag properties instead).
            let tag = buffer.create_tag(Some("new"), &[]).unwrap();
            tag.set_property("weight", 700i32); // pango::Weight::Bold
            tag.set_property("foreground", "#6ea8ff");
            for line in lessons.split_inclusive('\n') {
                let trimmed = line.trim();
                let is_new = trimmed
                    .strip_prefix("- ")
                    .map(|b| new_set.contains(b.trim()))
                    .unwrap_or(false);
                let mut end = buffer.end_iter();
                if is_new {
                    buffer.insert_with_tags(&mut end, line, &[&tag]);
                } else {
                    buffer.insert(&mut end, line);
                }
            }
        }
        let scroll = gtk::ScrolledWindow::new();
        scroll.set_min_content_height(180);
        scroll.set_child(Some(&view));
        p.append(&scroll);
        p
    }
}

// ---- shared small builders --------------------------------------------------

fn build_diff(diff: &LessonsDiff) -> gtk::Box {
    let d = gtk::Box::new(gtk::Orientation::Vertical, 2);
    d.add_css_class("insights-diff");
    let title = gtk::Label::new(Some("LESSONS.md changes"));
    title.set_xalign(0.0);
    title.add_css_class("insights-diff-title");
    d.append(&title);
    for b in &diff.added {
        d.append(&diff_line("+", b, "added"));
    }
    for b in &diff.removed {
        d.append(&diff_line("−", b, "removed"));
    }
    d
}

fn diff_line(sign: &str, text: &str, class: &str) -> gtk::Box {
    let r = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    r.add_css_class("insights-diff-line");
    r.add_css_class(class);
    let s = gtk::Label::new(Some(sign));
    s.add_css_class("insights-diff-sign");
    s.set_valign(gtk::Align::Start);
    r.append(&s);
    let t = gtk::Label::new(Some(text));
    t.set_xalign(0.0);
    t.set_wrap(true);
    t.set_hexpand(true);
    r.append(&t);
    r
}

fn panel(title: &str) -> gtk::Box {
    let p = gtk::Box::new(gtk::Orientation::Vertical, 8);
    p.add_css_class("insights-panel");
    let t = gtk::Label::new(Some(title));
    t.set_xalign(0.0);
    t.add_css_class("insights-panel-title");
    p.append(&t);
    p
}

fn panel_with_meta(title: &str, meta: &str) -> gtk::Box {
    let p = gtk::Box::new(gtk::Orientation::Vertical, 8);
    p.add_css_class("insights-panel");
    let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let t = gtk::Label::new(Some(title));
    t.set_xalign(0.0);
    t.add_css_class("insights-panel-title");
    head.append(&t);
    let m = gtk::Label::new(Some(meta));
    m.set_hexpand(true);
    m.set_xalign(1.0);
    m.set_ellipsize(pango::EllipsizeMode::End);
    m.add_css_class("insights-panel-meta");
    head.append(&m);
    p.append(&head);
    p
}

fn trigger_label(run: &SelfTuneRun) -> &'static str {
    use orchestra_rpc::types::SelfTuneTrigger as T;
    match run.trigger {
        T::Auto => "auto",
        T::Manual => "manual",
    }
}

fn run_status_css(status: SelfTuneRunStatus) -> &'static str {
    match status {
        SelfTuneRunStatus::Running => "running",
        SelfTuneRunStatus::Ok => "ok",
        SelfTuneRunStatus::Failed => "failed",
    }
}

fn clear(b: &gtk::Box) {
    while let Some(child) = b.first_child() {
        b.remove(&child);
    }
}

// Reference the sound module so the overlay can offer the chime picker from its
// own header in a later iteration (kept wired now to avoid an unused-field lint
// on `player`/`state`). The picker itself is opened from the sidebar bell in
// the Electron app; here we expose a helper the app shell can call.
impl InsightsOverlay {
    /// Open the notification-sound picker, persisting the choice into shared
    /// UI state. Exposed for the app shell / sidebar bell.
    pub fn open_sound_picker(self: &Rc<Self>) {
        let Some(win) = self.root.root().and_downcast::<gtk::Window>() else {
            return;
        };
        let selected = sound::selected_sound_id(&self.state.borrow()).to_string();
        let state = self.state.clone();
        crate::sound::open_sound_settings(&win, self.player.clone(), &selected, move |id| {
            state.borrow_mut().notification_sound = Some(id.to_string());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lesson_bullets_counts_top_level() {
        let md = "# Header\n\nprose line\n- first bullet\n-notabullet\n  - indented still counts\n- second\n";
        let bullets = parse_lesson_bullets(md);
        assert_eq!(
            bullets,
            vec!["first bullet", "indented still counts", "second"]
        );
    }

    #[test]
    fn run_outcome_reflects_status() {
        let mut run: SelfTuneRun = serde_json::from_value(serde_json::json!({
            "id": "r", "trigger": "auto", "status": "ok",
            "startedAt": 1_752_840_000_000i64, "finishedAt": 1_752_840_100_000i64,
            "steps": [], "summary": "2 lessons added",
        }))
        .unwrap();
        assert!(run_outcome(&run).ends_with("2 lessons added"));
        run.status = SelfTuneRunStatus::Failed;
        assert!(run_outcome(&run).ends_with("failed"));
        run.status = SelfTuneRunStatus::Running;
        assert!(run_outcome(&run).ends_with("running…"));
    }

    #[test]
    fn duration_formats_minutes_and_seconds() {
        assert_eq!(fmt_duration(0, 45_000), "45s");
        assert_eq!(fmt_duration(0, 125_000), "2m 5s");
        assert_eq!(fmt_duration(100, 50), "0s"); // clamps negatives
    }
}
