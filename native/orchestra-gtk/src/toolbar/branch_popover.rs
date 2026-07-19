//! The searchable branch list that fills a branch popover — port of
//! `BranchPopoverPanel` (BranchPicker.tsx), the panel every branch-choosing
//! surface reuses: the toolbar's workspace branch switch here, the sidebar's
//! new-workspace base pick and repo default-base pick (B1) later. Only the
//! trigger + what `on_pick` does differ; positioning is the parent's job
//! (put the widget inside a `gtk::Popover`).

use std::cell::RefCell;
use std::rc::Rc;

use gtk::glib;
use gtk::pango;
use gtk::prelude::*;

struct PanelState {
    /// None = still loading.
    branches: Option<Vec<String>>,
    /// Branch to sort first and badge (the current / default one).
    highlight: Option<String>,
    filtered: Vec<String>,
    busy: bool,
    error: Option<String>,
}

pub struct BranchPopoverPanel {
    root: gtk::Box,
    entry: gtk::SearchEntry,
    list: gtk::ListBox,
    list_scroll: gtk::ScrolledWindow,
    empty_label: gtk::Label,
    footer: gtk::Box,
    error_label: gtk::Label,
    /// Badge text on the highlighted branch ("current", "default").
    badge_label: String,
    state: RefCell<PanelState>,
    on_pick: RefCell<Option<PickFn>>,
}

/// Callback fired when the user picks a branch.
type PickFn = Box<dyn Fn(String)>;

impl BranchPopoverPanel {
    /// `action_verb` fills the ↵ footer hint ("switch", "create");
    /// `badge_label` marks the highlighted branch ("current", "default").
    pub fn new(action_verb: &str, badge_label: &str) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 6);
        root.add_css_class("branch-panel");
        root.set_widget_name("branch-panel");

        let entry = gtk::SearchEntry::new();
        entry.set_placeholder_text(Some("Search branches…"));
        entry.set_widget_name("branch-search");
        root.append(&entry);

        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::Single);
        list.set_widget_name("branch-list");
        list.add_css_class("branch-list");
        let list_scroll = gtk::ScrolledWindow::new();
        list_scroll.set_child(Some(&list));
        list_scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
        list_scroll.set_min_content_height(60);
        list_scroll.set_max_content_height(280);
        list_scroll.set_propagate_natural_height(true);
        root.append(&list_scroll);

        let empty_label = gtk::Label::new(Some("Loading branches…"));
        empty_label.add_css_class("branch-empty");
        empty_label.set_widget_name("branch-empty");
        root.append(&empty_label);

        let error_label = gtk::Label::new(None);
        error_label.set_xalign(0.0);
        error_label.set_wrap(true);
        error_label.add_css_class("branch-error");
        error_label.set_widget_name("branch-error");
        error_label.set_visible(false);
        root.append(&error_label);

        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        footer.add_css_class("branch-footer");
        for hint in ["↑↓ navigate", &format!("↵ {action_verb}"), "esc close"] {
            let l = gtk::Label::new(Some(hint));
            l.add_css_class("branch-hint");
            footer.append(&l);
        }
        root.append(&footer);

        let panel = Rc::new(Self {
            root,
            entry,
            list,
            list_scroll,
            empty_label,
            footer,
            error_label,
            badge_label: badge_label.to_owned(),
            state: RefCell::new(PanelState {
                branches: None,
                highlight: None,
                filtered: Vec::new(),
                busy: false,
                error: None,
            }),
            on_pick: RefCell::new(None),
        });

        // Typing filters; the active row resets to the top like the Electron
        // panel (activeIdx effect on query change).
        {
            let this = Rc::downgrade(&panel);
            panel.entry.connect_search_changed(move |_| {
                if let Some(this) = this.upgrade() {
                    this.rebuild(true);
                }
            });
        }
        // ↑/↓ move the active row from within the entry; Enter picks it.
        {
            let this = Rc::downgrade(&panel);
            let keys = gtk::EventControllerKey::new();
            keys.connect_key_pressed(move |_, key, _, _| {
                let Some(this) = this.upgrade() else {
                    return glib::Propagation::Proceed;
                };
                match key {
                    gtk::gdk::Key::Down => {
                        this.move_active(1);
                        glib::Propagation::Stop
                    }
                    gtk::gdk::Key::Up => {
                        this.move_active(-1);
                        glib::Propagation::Stop
                    }
                    gtk::gdk::Key::Return | gtk::gdk::Key::KP_Enter => {
                        this.pick_active();
                        glib::Propagation::Stop
                    }
                    _ => glib::Propagation::Proceed,
                }
            });
            panel.entry.add_controller(keys);
        }
        {
            let this = Rc::downgrade(&panel);
            panel.list.connect_row_activated(move |_, row| {
                if let Some(this) = this.upgrade() {
                    let idx = row.index();
                    let pick = this.state.borrow().filtered.get(idx as usize).cloned();
                    if let Some(b) = pick {
                        this.emit_pick(b);
                    }
                }
            });
        }

        panel.rebuild(true);
        panel
    }

    pub fn widget(&self) -> &gtk::Widget {
        self.root.upcast_ref()
    }

    pub fn connect_pick(&self, f: impl Fn(String) + 'static) {
        *self.on_pick.borrow_mut() = Some(Box::new(f));
    }

    /// Back to the fresh state: query cleared, loading, no error. Call when
    /// (re)opening the popover, before the branch fetch answers.
    pub fn reset(&self) {
        {
            let mut st = self.state.borrow_mut();
            st.branches = None;
            st.error = None;
            st.busy = false;
        }
        self.entry.set_text("");
        self.rebuild(true);
    }

    pub fn focus_search(&self) {
        self.entry.grab_focus();
    }

    pub fn set_branches(&self, branches: Option<Vec<String>>) {
        self.state.borrow_mut().branches = branches;
        self.rebuild(true);
    }

    pub fn set_highlight(&self, branch: Option<&str>) {
        self.state.borrow_mut().highlight = branch.map(str::to_owned);
        self.rebuild(false);
    }

    pub fn set_error(&self, error: Option<&str>) {
        self.state.borrow_mut().error = error.map(str::to_owned);
        self.sync_footer();
    }

    pub fn set_busy(&self, busy: bool) {
        self.state.borrow_mut().busy = busy;
        self.list.set_sensitive(!busy);
    }

    fn emit_pick(&self, branch: String) {
        if self.state.borrow().busy {
            return;
        }
        if let Some(f) = self.on_pick.borrow().as_ref() {
            f(branch);
        }
    }

    fn move_active(&self, delta: i32) {
        let len = self.state.borrow().filtered.len() as i32;
        if len == 0 {
            return;
        }
        let current = self.list.selected_row().map(|r| r.index()).unwrap_or(0);
        let next = (current + delta).clamp(0, len - 1);
        if let Some(row) = self.list.row_at_index(next) {
            self.list.select_row(Some(&row));
            row.grab_focus();
            self.entry.grab_focus(); // keep typing possible while navigating
        }
    }

    fn pick_active(&self) {
        let idx = self.list.selected_row().map(|r| r.index()).unwrap_or(0);
        let pick = self.state.borrow().filtered.get(idx as usize).cloned();
        if let Some(b) = pick {
            self.emit_pick(b);
        }
    }

    fn sync_footer(&self) {
        let st = self.state.borrow();
        match &st.error {
            Some(e) => {
                self.error_label.set_label(e);
                self.error_label.set_visible(true);
                self.footer.set_visible(false);
            }
            None => {
                self.error_label.set_visible(false);
                self.footer.set_visible(true);
            }
        }
    }

    /// Re-filter + re-render the rows. `reset_active` puts the selection back
    /// on the first row (query/branch-set changed); otherwise it's kept.
    fn rebuild(&self, reset_active: bool) {
        let query = self.entry.text().to_lowercase();
        let (rows, highlight) = {
            let mut st = self.state.borrow_mut();
            let highlight = st.highlight.clone();
            let filtered: Vec<String> = match &st.branches {
                None => Vec::new(),
                Some(list) => {
                    let mut base: Vec<String> = if query.is_empty() {
                        list.clone()
                    } else {
                        list.iter()
                            .filter(|b| b.to_lowercase().contains(&query))
                            .cloned()
                            .collect()
                    };
                    // Highlighted branch sorts first, then alphabetical.
                    base.sort_by(|a, b| {
                        let ah = Some(a) == highlight.as_ref();
                        let bh = Some(b) == highlight.as_ref();
                        bh.cmp(&ah).then_with(|| a.cmp(b))
                    });
                    base
                }
            };
            st.filtered = filtered.clone();
            (filtered, highlight)
        };

        while let Some(row) = self.list.row_at_index(0) {
            self.list.remove(&row);
        }
        let loading = self.state.borrow().branches.is_none();
        if loading {
            self.empty_label.set_label("Loading branches…");
        } else if rows.is_empty() {
            self.empty_label
                .set_label(&format!("No branches match “{}”", self.entry.text()));
        }
        self.empty_label.set_visible(rows.is_empty());
        self.list_scroll.set_visible(!rows.is_empty());

        for b in &rows {
            let icon = gtk::Label::new(Some("⎇"));
            icon.add_css_class("branch-item-icon");
            let name = gtk::Label::new(None);
            name.set_xalign(0.0);
            name.set_hexpand(true);
            name.set_ellipsize(pango::EllipsizeMode::Middle);
            name.add_css_class("branch-item-name");
            name.set_markup(&highlight_markup(b, &query));
            let row_box = gtk::Box::new(gtk::Orientation::Horizontal, 7);
            row_box.append(&icon);
            row_box.append(&name);
            let is_highlighted = Some(b) == highlight.as_ref();
            if is_highlighted {
                let badge = gtk::Label::new(Some(&self.badge_label));
                badge.add_css_class("branch-item-badge");
                row_box.append(&badge);
            }
            let row = gtk::ListBoxRow::new();
            row.set_child(Some(&row_box));
            row.set_widget_name(&format!("branch-item-{b}"));
            if is_highlighted {
                row.add_css_class("current");
            }
            self.list.append(&row);
        }
        if reset_active || self.list.selected_row().is_none() {
            if let Some(first) = self.list.row_at_index(0) {
                self.list.select_row(Some(&first));
            }
        }
        self.sync_footer();
    }
}

/// Pango markup for a branch name with the first case-insensitive `query`
/// match emphasized — the `<mark>` of the Electron panel.
fn highlight_markup(name: &str, query_lower: &str) -> String {
    let esc = |s: &str| glib::markup_escape_text(s).to_string();
    if query_lower.is_empty() {
        return esc(name);
    }
    match name.to_lowercase().find(query_lower) {
        None => esc(name),
        Some(i) => {
            let end = i + query_lower.len();
            format!(
                "{}<span foreground=\"#6ea8ff\" weight=\"bold\">{}</span>{}",
                esc(&name[..i]),
                esc(&name[i..end]),
                esc(&name[end..])
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::highlight_markup;

    #[test]
    fn highlight_wraps_the_match() {
        assert_eq!(
            highlight_markup("feature/x", "eat"),
            "f<span foreground=\"#6ea8ff\" weight=\"bold\">eat</span>ure/x"
        );
        assert_eq!(highlight_markup("main", ""), "main");
        assert_eq!(highlight_markup("main", "zzz"), "main");
    }

    #[test]
    fn highlight_escapes_markup_characters() {
        let out = highlight_markup("a<b&c", "b&");
        assert!(out.contains("a&lt;"), "{out}");
        assert!(out.contains("b&amp;"), "{out}");
    }
}
