//! Diff tab (plan §5.3, anchor `DiffView.tsx`): file list with +/- badges and
//! A/M/D classification, side-by-side GtkSourceView panes with synced
//! scrolling, line add/del backgrounds, intra-line word highlights, language
//! from the extension, read-only, truncation notice, and a 4 s poll that runs
//! ONLY while the diff tab is mapped and the window visible — preserving the
//! user's file selection across refreshes.
//!
//! Monaco → GtkSourceView is a declared substitution (plan §0): same
//! information, different chrome. The alignment invariant (both panes always
//! hold the same row count, filler-padded) is what makes one shared
//! GtkAdjustment give exact scroll lockstep.

pub mod align;
pub mod language;

use std::cell::RefCell;
use std::rc::Rc;

use gtk::glib;
use gtk::pango;
use gtk::prelude::*;
use sourceview5::prelude::*;

use orchestra_rpc::types::{DiffFile, DiffFileStatus};
use serde_json::json;

use crate::ctx::Ctx;
use align::{CellKind, Row};

/// The marker `git.ts:truncate` appends past 300 KB.
const TRUNCATION_MARKER: &str = "... (truncated by Orchestra) ...\n";
const POLL_SECS: u32 = 4;

struct State {
    ws_id: Option<String>,
    files: Vec<DiffFile>,
    /// Selected file path — preserved across polling refreshes; falls back to
    /// the first file only when nothing is selected or the selection vanished.
    active: Option<String>,
    /// True once a first load for `ws_id` finished (drives Loading vs Empty).
    loaded: bool,
    /// Cheap change detector so an unchanged poll never rebuilds the buffers
    /// (a rebuild would reset the scroll position every 4 s).
    rendered_key: Option<String>,
    /// Guards the ListBox row-selected handler during programmatic rebuilds.
    syncing_list: bool,
}

pub struct DiffView {
    ctx: Rc<Ctx>,
    state: Rc<RefCell<State>>,
    root: gtk::Stack,
    status_page: gtk::Box,
    status_title: gtk::Label,
    status_sub: gtk::Label,
    file_list: gtk::ListBox,
    header_path: gtk::Label,
    header_adds: gtk::Label,
    header_dels: gtk::Label,
    trunc_notice: gtk::Revealer,
    old_buf: sourceview5::Buffer,
    new_buf: sourceview5::Buffer,
}

fn make_buffer(line_rgba: &str, word_rgba: &str) -> sourceview5::Buffer {
    let buf = sourceview5::Buffer::new(None);
    buf.set_highlight_syntax(true);
    buf.set_highlight_matching_brackets(false);
    let manager = sourceview5::StyleSchemeManager::default();
    if let Some(scheme) = manager
        .scheme("Adwaita-dark")
        .or_else(|| manager.scheme("classic-dark"))
        .or_else(|| manager.scheme("oblivion"))
    {
        buf.set_style_scheme(Some(&scheme));
    }
    buf.create_tag(Some("line"), &[("paragraph-background", &line_rgba)]);
    buf.create_tag(Some("word"), &[("background", &word_rgba)]);
    buf.create_tag(
        Some("filler"),
        &[("paragraph-background", &"rgba(139,149,167,0.06)")],
    );
    buf
}

fn make_pane(buf: &sourceview5::Buffer, name: &str) -> (sourceview5::View, gtk::ScrolledWindow) {
    let view = sourceview5::View::with_buffer(buf);
    view.set_editable(false);
    view.set_cursor_visible(false);
    view.set_monospace(true);
    view.set_left_margin(8);
    view.set_right_margin(8);
    view.set_top_margin(4);
    view.set_bottom_margin(4);
    view.add_css_class("diff-source");
    view.set_widget_name(name);
    let scroll = gtk::ScrolledWindow::new();
    scroll.set_child(Some(&view));
    scroll.set_hexpand(true);
    scroll.set_vexpand(true);
    (view, scroll)
}

fn status_letter(status: DiffFileStatus) -> (&'static str, &'static str) {
    match status {
        DiffFileStatus::Added => ("A", "added"),
        DiffFileStatus::Modified => ("M", "modified"),
        DiffFileStatus::Deleted => ("D", "deleted"),
        DiffFileStatus::Renamed => ("R", "renamed"),
    }
}

impl DiffView {
    pub fn new(ctx: Rc<Ctx>) -> Rc<Self> {
        let state = Rc::new(RefCell::new(State {
            ws_id: None,
            files: Vec::new(),
            active: None,
            loaded: false,
            rendered_key: None,
            syncing_list: false,
        }));

        // ---- status page (loading / empty / error) --------------------------
        let status_page = gtk::Box::new(gtk::Orientation::Vertical, 6);
        status_page.set_valign(gtk::Align::Center);
        status_page.set_halign(gtk::Align::Center);
        status_page.add_css_class("diff-status");
        let status_title = gtk::Label::new(None);
        status_title.add_css_class("diff-status-title");
        status_title.set_widget_name("diff-status-title");
        let status_sub = gtk::Label::new(None);
        status_sub.add_css_class("diff-status-sub");
        status_sub.set_widget_name("diff-status-sub");
        status_page.append(&status_title);
        status_page.append(&status_sub);

        // ---- content: [file list | header + panes] --------------------------
        let file_list = gtk::ListBox::new();
        file_list.set_selection_mode(gtk::SelectionMode::Single);
        file_list.set_widget_name("diff-file-list");
        file_list.add_css_class("diff-files");
        let files_scroll = gtk::ScrolledWindow::new();
        files_scroll.set_child(Some(&file_list));
        files_scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        files_scroll.set_width_request(240);
        files_scroll.set_vexpand(true);

        let header_path = gtk::Label::new(None);
        header_path.set_xalign(0.0);
        header_path.set_hexpand(true);
        header_path.set_ellipsize(pango::EllipsizeMode::Middle);
        header_path.add_css_class("diff-header-path");
        header_path.set_widget_name("diff-header-path");
        let header_adds = gtk::Label::new(None);
        header_adds.add_css_class("diff-add");
        let header_dels = gtk::Label::new(None);
        header_dels.add_css_class("diff-del");
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        header.add_css_class("diff-header");
        header.append(&header_path);
        header.append(&header_adds);
        header.append(&header_dels);

        let trunc_label =
            gtk::Label::new(Some("Large file — content truncated to 300 KB for display"));
        trunc_label.set_xalign(0.0);
        let trunc_box = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        trunc_box.add_css_class("diff-trunc-notice");
        trunc_box.append(&trunc_label);
        let trunc_notice = gtk::Revealer::new();
        trunc_notice.set_child(Some(&trunc_box));
        trunc_notice.set_widget_name("diff-trunc-notice");

        // Electron palette: red #ff6b6b for removals, green #5bd68b for adds.
        let old_buf = make_buffer("rgba(255,107,107,0.12)", "rgba(255,107,107,0.32)");
        let new_buf = make_buffer("rgba(91,214,139,0.12)", "rgba(91,214,139,0.30)");
        let (_old_view, old_scroll) = make_pane(&old_buf, "diff-pane-old");
        let (_new_view, new_scroll) = make_pane(&new_buf, "diff-pane-new");
        // The alignment invariant (equal row counts) makes one shared
        // vadjustment an exact scroll sync — no scroll-handler feedback loops.
        new_scroll.set_vadjustment(Some(&old_scroll.vadjustment()));

        let panes = gtk::Box::new(gtk::Orientation::Horizontal, 1);
        panes.add_css_class("diff-panes");
        panes.append(&old_scroll);
        panes.append(&new_scroll);

        let right = gtk::Box::new(gtk::Orientation::Vertical, 0);
        right.append(&header);
        right.append(&trunc_notice);
        right.append(&panes);
        right.set_hexpand(true);

        let content = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        content.append(&files_scroll);
        content.append(&gtk::Separator::new(gtk::Orientation::Vertical));
        content.append(&right);

        let root = gtk::Stack::new();
        root.set_widget_name("diff-view");
        root.add_named(&status_page, Some("status"));
        root.add_named(&content, Some("content"));
        root.set_visible_child_name("status");

        let view = Rc::new(Self {
            ctx,
            state,
            root,
            status_page,
            status_title,
            status_sub,
            file_list,
            header_path,
            header_adds,
            header_dels,
            trunc_notice,
            old_buf,
            new_buf,
        });
        view.show_status("Loading diff…", "");

        // Selection → render, and remember the choice across refreshes.
        {
            let this = Rc::downgrade(&view);
            view.file_list.connect_row_selected(move |_, row| {
                let Some(this) = this.upgrade() else { return };
                if this.state.borrow().syncing_list {
                    return;
                }
                let Some(row) = row else { return };
                let idx = row.index();
                let path = this
                    .state
                    .borrow()
                    .files
                    .get(idx as usize)
                    .map(|f| f.path.clone());
                if let Some(path) = path {
                    this.state.borrow_mut().active = Some(path);
                    this.render_active();
                }
            });
        }

        // First load the moment the tab becomes visible…
        {
            let this = Rc::downgrade(&view);
            view.root.connect_map(move |_| {
                if let Some(this) = this.upgrade() {
                    this.refresh();
                }
            });
        }
        // …then the 4 s visible-poll. Gating on `is_mapped` (tab shown) and
        // the window being visible mirrors the renderer's startVisiblePoll:
        // no diff work while the user looks elsewhere.
        {
            let this = Rc::downgrade(&view);
            glib::timeout_add_seconds_local(POLL_SECS, move || {
                let Some(this) = this.upgrade() else {
                    return glib::ControlFlow::Break;
                };
                if this.root.is_mapped() && this.ctx.window.is_visible() {
                    this.refresh();
                }
                glib::ControlFlow::Continue
            });
        }

        view
    }

    pub fn widget(&self) -> &gtk::Widget {
        self.root.upcast_ref()
    }

    /// Switch (or clear) the workspace this view diffs. Resets selection and
    /// shows the loading state until the first fetch answers.
    pub fn set_workspace(&self, ws_id: Option<&str>) {
        {
            let mut st = self.state.borrow_mut();
            if st.ws_id.as_deref() == ws_id {
                return;
            }
            st.ws_id = ws_id.map(str::to_owned);
            st.files.clear();
            st.active = None;
            st.loaded = false;
            st.rendered_key = None;
        }
        self.show_status("Loading diff…", "");
        if self.root.is_mapped() {
            self.refresh();
        }
    }

    fn show_status(&self, title: &str, sub: &str) {
        self.status_title.set_label(title);
        self.status_sub.set_label(sub);
        self.status_sub.set_visible(!sub.is_empty());
        self.root.set_visible_child_name("status");
        let _ = &self.status_page; // named page handle kept for tests/tooling
    }

    /// Fetch `getDiff` and reconcile the UI. Synchronous backend seam — see
    /// `Ctx::call`; the B2 transport swap makes this async in one place.
    pub fn refresh(&self) {
        let Some(ws_id) = self.state.borrow().ws_id.clone() else {
            return;
        };
        let result: Result<Vec<DiffFile>, String> =
            self.ctx.call_typed("getDiff", vec![json!(ws_id)]);
        match result {
            Ok(files) => {
                {
                    let mut st = self.state.borrow_mut();
                    // The workspace may have switched while the call ran.
                    if st.ws_id.as_deref() != Some(ws_id.as_str()) {
                        return;
                    }
                    st.loaded = true;
                    // Preserve the current selection when it still exists.
                    let keep = st
                        .active
                        .as_ref()
                        .is_some_and(|a| files.iter().any(|f| &f.path == a));
                    if !keep {
                        st.active = files.first().map(|f| f.path.clone());
                    }
                    st.files = files;
                }
                self.rebuild_file_list();
                self.render_active();
            }
            Err(e) => {
                let st = self.state.borrow();
                if !st.loaded || st.files.is_empty() {
                    drop(st);
                    self.show_status("Diff unavailable", &e);
                }
                // With content already on screen, keep it — next poll retries.
            }
        }
    }

    fn rebuild_file_list(&self) {
        let files = self.state.borrow().files.clone();
        if files.is_empty() {
            self.show_status(
                "No changes yet",
                "The agent hasn't modified any files in this worktree.",
            );
            return;
        }
        self.root.set_visible_child_name("content");

        self.state.borrow_mut().syncing_list = true;
        while let Some(row) = self.file_list.row_at_index(0) {
            self.file_list.remove(&row);
        }
        for f in &files {
            let (letter, css) = status_letter(f.status);
            let badge = gtk::Label::new(Some(letter));
            badge.add_css_class("diff-file-status");
            badge.add_css_class(css);
            let name = gtk::Label::new(Some(&f.path));
            name.set_xalign(0.0);
            name.set_hexpand(true);
            name.set_ellipsize(pango::EllipsizeMode::Middle);
            name.set_tooltip_text(Some(&f.path));
            name.add_css_class("diff-file-name");
            let adds = gtk::Label::new(Some(&format!("+{}", f.additions)));
            adds.add_css_class("diff-add");
            let dels = gtk::Label::new(Some(&format!("−{}", f.deletions)));
            dels.add_css_class("diff-del");
            let row_box = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            row_box.append(&badge);
            row_box.append(&name);
            row_box.append(&adds);
            row_box.append(&dels);
            let row = gtk::ListBoxRow::new();
            row.set_child(Some(&row_box));
            row.set_widget_name(&format!("diff-file-row-{}", f.path));
            self.file_list.append(&row);
        }
        let active_idx = {
            let st = self.state.borrow();
            st.active
                .as_ref()
                .and_then(|a| st.files.iter().position(|f| &f.path == a))
                .unwrap_or(0)
        };
        if let Some(row) = self.file_list.row_at_index(active_idx as i32) {
            self.file_list.select_row(Some(&row));
        }
        self.state.borrow_mut().syncing_list = false;
    }

    fn render_active(&self) {
        let (file, key) = {
            let st = self.state.borrow();
            let Some(file) = st
                .active
                .as_ref()
                .and_then(|a| st.files.iter().find(|f| &f.path == a))
                .cloned()
            else {
                return;
            };
            // Content lengths + stats make a cheap, reliable change key.
            let key = format!(
                "{}:{}:{}:{}:{}",
                file.path,
                file.old_content.len(),
                file.new_content.len(),
                file.additions,
                file.deletions
            );
            (file, key)
        };
        if self.state.borrow().rendered_key.as_deref() == Some(key.as_str()) {
            return;
        }

        self.header_path.set_label(&file.path);
        self.header_adds.set_label(&format!("+{}", file.additions));
        self.header_dels.set_label(&format!("−{}", file.deletions));
        self.trunc_notice.set_reveal_child(
            file.old_content.ends_with(TRUNCATION_MARKER)
                || file.new_content.ends_with(TRUNCATION_MARKER),
        );

        // Language from the extension via the language manager (guess_language
        // falls back to glob matching for files outside the table).
        let manager = sourceview5::LanguageManager::default();
        let lang = language::language_id_for_path(&file.path)
            .and_then(|id| manager.language(id))
            .or_else(|| manager.guess_language(Some(&file.path), None));
        self.old_buf.set_language(lang.as_ref());
        self.new_buf.set_language(lang.as_ref());

        let rows = align::align(&file.old_content, &file.new_content);
        apply_side(&self.old_buf, &rows, |r| &r.old);
        apply_side(&self.new_buf, &rows, |r| &r.new);

        self.state.borrow_mut().rendered_key = Some(key);
    }
}

/// Fill one pane's buffer from its side of the aligned rows and tag line
/// backgrounds + intra-line word ranges.
fn apply_side<'a>(
    buf: &sourceview5::Buffer,
    rows: &'a [Row],
    side: impl Fn(&'a Row) -> &'a align::Cell,
) {
    let text: String = rows
        .iter()
        .map(|r| side(r).text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    buf.set_text(&text);

    for (line, row) in rows.iter().enumerate() {
        let cell = side(row);
        let line = line as i32;
        let tag = match cell.kind {
            CellKind::Context => None,
            CellKind::Changed => Some("line"),
            CellKind::Filler => Some("filler"),
        };
        let Some(start) = buf.iter_at_line(line) else {
            continue;
        };
        if let Some(tag) = tag {
            let end = buf.iter_at_line(line + 1).unwrap_or_else(|| buf.end_iter());
            buf.apply_tag_by_name(tag, &start, &end);
        }
        for &(b0, b1) in &cell.ranges {
            // similar yields byte offsets; TextIter wants char offsets.
            let c0 = cell.text[..b0].chars().count() as i32;
            let c1 = cell.text[..b1].chars().count() as i32;
            let mut s = start;
            let mut e = start;
            s.forward_chars(c0);
            e.forward_chars(c1);
            buf.apply_tag_by_name("word", &s, &e);
        }
    }
}
