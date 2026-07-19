//! Row-list derivation (plan §5.1) — the pure heart of the sidebar. Given the
//! backend data and the UI state, compute the flat ordered list of rows the
//! widget layer renders 1:1. This is the Rust equivalent of `Sidebar.tsx`'s
//! render pass (section order, spawn trees, host groups, pills, archived),
//! kept GTK-free so the whole layout logic unit-tests without a display.
//!
//! Section order (ledger): Orchestrator trees → Scratch trees → per-repo
//! groups (workspaces threaded as spawn trees) → Archived (collapsible).
//! Subtree collapse carets exist ONLY in the pinned tree sections — repo
//! sections render their trees expanded, exactly like the Electron sidebar.

use std::collections::{HashMap, HashSet};

use orchestra_rpc::types::{
    AccountUsageStatus, DiffStats, EnvStatusItem, LinearIssue, PrsForBranch, RepoEntry,
    RepoSyncState, UsageSnapshot, Workspace,
};

use crate::accounts::logic::{
    age_text, clamp_pct, error_title, severity, Severity, DEFAULT_LOGIN_LABEL,
};

use super::forest::{
    build_spawn_forest, collect_descendants, group_roots_by_repo, hidden_urgency, visible_rows,
    HiddenUrgency, TreeRow,
};
use super::hosts::{group_by_host, host_label};
use super::pills::{row_pills, RowPills};

/// Everything the sidebar reads from the backend (the Zustand-store subset
/// `Sidebar.tsx` consumes).
#[derive(Debug, Default, Clone)]
pub struct SidebarData {
    pub workspaces: Vec<Workspace>,
    pub repos: Vec<RepoEntry>,
    pub stats: HashMap<String, DiffStats>,
    pub sizes: HashMap<String, u64>,
    pub sizes_exclusive: bool,
    pub prs: HashMap<String, PrsForBranch>,
    pub linear: HashMap<String, LinearIssue>,
    /// Live tool label per running agent (`agent:tool`; None-cleared).
    pub tools: HashMap<String, String>,
    pub repo_sync: HashMap<String, RepoSyncState>,
    /// Live context-token overrides (`agent:context`; the 0 sentinel clears —
    /// stored here as absent). Falls back to `Workspace.contextTokens`.
    pub context_tokens: HashMap<String, u64>,
    pub env_status: Vec<EnvStatusItem>,
    /// Configured accounts by id → label, so the row badge shows the LOGIN
    /// NAME rather than the raw account id (plan §5.4 / `AccountBadge.tsx`).
    pub account_labels: HashMap<String, String>,
    /// Rolling per-account usage, for the badge's severity tint. Keyed by
    /// account id; absent = first poll still in flight.
    pub account_usage: HashMap<String, AccountUsageStatus>,
    /// The default login's usage — the tint source for unpinned workspaces.
    pub global_usage: Option<UsageSnapshot>,
    /// Epoch-ms "now", stamped by the component at rebuild time. Kept on the
    /// data (rather than read from the clock in here) so this module stays
    /// pure and its row computations remain unit-testable.
    pub now_ms: i64,
}

/// Transient + persisted UI state the row list depends on.
#[derive(Debug, Default, Clone)]
pub struct SidebarUi {
    pub active_id: Option<String>,
    pub collapsed_repos: HashSet<String>,
    pub collapsed_hosts: HashSet<String>,
    pub collapsed_subtrees: HashSet<String>,
    pub archived_open: bool,
    pub selected_archived: HashSet<String>,
    pub deleting_ids: HashSet<String>,
    /// (done, total) while a bulk archived delete runs.
    pub bulk_delete: Option<(u64, u64)>,
    pub renaming_id: Option<String>,
}

/// Which pinned tree section a spawn-tree row belongs to — only the
/// hover-title wording differs between them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeVariant {
    Orchestrator,
    Scratch,
}

impl TreeVariant {
    pub fn root_noun(self) -> &'static str {
        match self {
            TreeVariant::Orchestrator => "orchestrator",
            TreeVariant::Scratch => "scratch session",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SectionKind {
    Orchestrators,
    Scratch,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RepoHeaderSpec {
    pub repo_path: String,
    pub label: String,
    /// Row count (incl. spawned descendants) — repo sections count rows;
    /// only the pinned tree sections count roots.
    pub count: usize,
    pub registered: bool,
    /// Registered and holding no workspaces at all (active, archived, or
    /// scratch) — main rejects removal otherwise, so the button gates on the
    /// same rule.
    pub can_remove: bool,
    pub collapsed: bool,
    pub remote_url: Option<String>,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HostHeaderSpec {
    /// `<repoPath>::<hostKey>` — the persisted collapse key.
    pub host_id: String,
    pub label: String,
    pub remote: bool,
    pub collapsed: bool,
    pub count: usize,
}

/// Resolve a workspace's login badge for display — the pure core of
/// `AccountBadge.tsx`'s `AccountUsageBadge` (label, severity tint, tooltip).
///
/// A pinned account reads the per-account poller; an unpinned one (or a
/// dangling id, i.e. the account was deleted) falls back to the default login
/// and the global poller, exactly like the Electron badge. An EXPIRED token
/// keeps its last-good data and stays normally tinted — only the tooltip flags
/// it — so a re-login prompt never hides real consumption.
pub fn resolve_account_badge(
    account_id: Option<&str>,
    data: &SidebarData,
    now_ms: i64,
) -> (String, Option<Severity>, String) {
    let label = account_id.and_then(|id| data.account_labels.get(id).cloned());
    let Some((account_id, label)) = account_id.zip(label) else {
        // Default login: tint by the global poller.
        let label = DEFAULT_LOGIN_LABEL.to_string();
        let Some(u) = data.global_usage.as_ref() else {
            return (label.clone(), None, format!("{label}: fetching usage…"));
        };
        let five = clamp_pct(u.five_hour.utilization);
        let seven = clamp_pct(u.seven_day.utilization);
        let tooltip = format!(
            "{label} — Claude usage (Orchestra's default login)\n\
             5-hour window: {five}%\n7-day window: {seven}%\nas of {}",
            age_text(u.fetched_at, now_ms)
        );
        return (label, Some(severity(five.max(seven))), tooltip);
    };

    let Some(u) = data.account_usage.get(account_id) else {
        // First poll still in flight.
        let tooltip = format!("{label}: fetching usage…");
        return (label, None, tooltip);
    };
    let Some(d) = u.data.as_ref() else {
        // No cached usage at all → a hard error (no dir, no scope, never
        // logged in). Untinted; the tooltip explains.
        let tooltip = error_title(&label, u.error_kind);
        return (label, None, tooltip);
    };
    let five = clamp_pct(d.five_hour.utilization);
    let seven = clamp_pct(d.seven_day.utilization);
    let mut tooltip =
        format!("{label} — Claude usage\n5-hour window: {five}%\n7-day window: {seven}%");
    if let Some(extra) = d.extra_utilization {
        tooltip.push_str(&format!("\nextra usage: {}%", extra.round() as i64));
    }
    if u.expired.unwrap_or(false) {
        tooltip.push_str("\n⚠ token expired — re-login (showing cached usage)");
    }
    tooltip.push_str(&format!("\nas of {}", age_text(u.fetched_at, now_ms)));
    (label, Some(severity(five.max(seven))), tooltip)
}

#[derive(Debug, Clone, PartialEq)]
pub struct WsRowSpec {
    pub ws: Workspace,
    pub depth: usize,
    /// Some for rows in the pinned tree sections, None for repo-section rows.
    pub tree: Option<TreeVariant>,
    /// Tree sections only: this row has children and shows the caret.
    pub collapsible: bool,
    pub collapsed: bool,
    pub hidden_count: usize,
    pub hidden_urgency: Option<HiddenUrgency>,
    /// Tooltip body for the hidden-count pill: "branch, branch (unread), …".
    pub hidden_names: String,
    pub pills: RowPills,
    /// Tree child that is a real git worktree (archivable, shows repo tag).
    pub child_is_git: bool,
    /// Label of `ws.repoPath` for the repo tag pill.
    pub repo_label: String,
    pub tool: Option<String>,
    pub context_tokens: Option<u64>,
    /// The login this agent runs as, resolved for display (plan §5.4): the
    /// account's LABEL, or "default" when unpinned — never the raw account id.
    pub account_label: String,
    /// Severity of that login's hotter rolling window, for the badge tint;
    /// None while the first usage poll is still in flight.
    pub account_severity: Option<Severity>,
    /// Full badge tooltip (windows, extra usage, expiry, age) — the same text
    /// the Electron badge shows.
    pub account_tooltip: String,
    pub sizes_exclusive: bool,
    pub active: bool,
    pub deleting: bool,
    pub renaming: bool,
    /// Only depth-0 repo-section rows reorder by drag.
    pub draggable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArchivedRowSpec {
    pub ws: Workspace,
    pub repo_label: String,
    pub size: Option<u64>,
    pub sizes_exclusive: bool,
    pub selected: bool,
    pub deleting: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArchivedBarSpec {
    pub selected: usize,
    pub all_selected: bool,
    pub some_selected: bool,
    pub bulk_delete: Option<(u64, u64)>,
}

/// One row of the sidebar list, in final render order.
#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    /// "No agents running…" — only when there is nothing at all to show.
    EmptyHint,
    SectionHeader {
        kind: SectionKind,
        count: usize,
    },
    RepoHeader(RepoHeaderSpec),
    /// Base-branch sync pill under an expanded repo header.
    RepoSync(RepoSyncState),
    HostHeader(HostHeaderSpec),
    Workspace(Box<WsRowSpec>),
    ArchivedToggle {
        count: usize,
        open: bool,
    },
    ArchivedBar(ArchivedBarSpec),
    Archived(Box<ArchivedRowSpec>),
}

impl Row {
    /// Stable identity for widget reuse across recomputes.
    pub fn key(&self) -> String {
        match self {
            Row::EmptyHint => "empty".into(),
            Row::SectionHeader { kind, .. } => format!("section:{kind:?}"),
            Row::RepoHeader(s) => format!("repo:{}", s.repo_path),
            Row::RepoSync(s) => format!("sync:{}", s.repo_path),
            Row::HostHeader(s) => format!("host:{}", s.host_id),
            Row::Workspace(s) => format!("ws:{}", s.ws.id),
            Row::ArchivedToggle { .. } => "archived-toggle".into(),
            Row::ArchivedBar(_) => "archived-bar".into(),
            Row::Archived(s) => format!("archived:{}", s.ws.id),
        }
    }
}

fn repo_label(repos: &[RepoEntry], repo_path: &str) -> String {
    if let Some(repo) = repos.iter().find(|r| r.path == repo_path) {
        return repo.name.clone();
    }
    repo_path
        .split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or(repo_path)
        .to_string()
}

/// Effective context tokens for a row: the live `agent:context` figure wins,
/// falling back to the stored `Workspace.contextTokens`; 0/absent → None (a
/// never-run workspace shows only its branch).
fn context_tokens_of(data: &SidebarData, ws: &Workspace) -> Option<u64> {
    data.context_tokens
        .get(&ws.id)
        .copied()
        .or(ws.context_tokens)
        .filter(|t| *t > 0)
}

// Distinct positional inputs — bundling them into a struct would only add
// indirection at the two call sites, so the arg-count lint is silenced here.
#[allow(clippy::too_many_arguments)]
fn ws_row(
    data: &SidebarData,
    ui: &SidebarUi,
    ws: &Workspace,
    depth: usize,
    tree: Option<TreeVariant>,
    cross_repo_child: bool,
    collapsible: bool,
    hidden: &[Workspace],
) -> WsRowSpec {
    let collapsed = collapsible && ui.collapsed_subtrees.contains(&ws.id);
    let hidden_names = hidden
        .iter()
        .map(|h| {
            if h.marked_unread == Some(true) {
                format!("{} (unread)", h.branch)
            } else {
                h.branch.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let pills = row_pills(
        ws,
        data.stats.get(&ws.id),
        data.sizes.get(&ws.id).copied(),
        data.prs.get(&ws.id),
        data.linear.get(&ws.id),
        cross_repo_child,
    );
    let (account_label, account_severity, account_tooltip) =
        resolve_account_badge(ws.account_id.as_deref(), data, data.now_ms);
    WsRowSpec {
        depth,
        tree,
        collapsible,
        collapsed,
        hidden_count: hidden.len(),
        hidden_urgency: hidden_urgency(hidden),
        hidden_names,
        pills,
        child_is_git: depth > 0 && !ws.is_scratch_like(),
        repo_label: repo_label(&data.repos, &ws.repo_path),
        tool: data.tools.get(&ws.id).cloned(),
        context_tokens: context_tokens_of(data, ws),
        account_label,
        account_severity,
        account_tooltip,
        sizes_exclusive: data.sizes_exclusive,
        active: ui.active_id.as_deref() == Some(ws.id.as_str()),
        deleting: ui.deleting_ids.contains(&ws.id),
        renaming: ui.renaming_id.as_deref() == Some(ws.id.as_str()),
        draggable: depth == 0
            && tree.is_none()
            && ui.renaming_id.as_deref() != Some(ws.id.as_str()),
        ws: ws.clone(),
    }
}

/// Rows for one pinned spawn-tree section (Orchestrators or Scratch): each
/// root's subtree depth-first, children indented under their spawner, with
/// the collapse filter applied.
fn tree_section_rows(
    data: &SidebarData,
    ui: &SidebarUi,
    trees: &[Vec<TreeRow>],
    variant: TreeVariant,
    forest: &super::forest::SpawnForest,
    out: &mut Vec<Row>,
) {
    for rows in trees {
        for row in visible_rows(rows, &ui.collapsed_subtrees) {
            let collapsible = forest
                .children_of
                .get(&row.ws.id)
                .is_some_and(|kids| !kids.is_empty());
            let collapsed = collapsible && ui.collapsed_subtrees.contains(&row.ws.id);
            let hidden = if collapsed {
                collect_descendants(&row.ws.id, &forest.children_of)
            } else {
                Vec::new()
            };
            out.push(Row::Workspace(Box::new(ws_row(
                data,
                ui,
                &row.ws,
                row.depth,
                Some(variant),
                false,
                collapsible,
                &hidden,
            ))));
        }
    }
}

/// Compute the full ordered row list.
pub fn compute_rows(data: &SidebarData, ui: &SidebarUi) -> Vec<Row> {
    let mut out = Vec::new();

    let active: Vec<Workspace> = data
        .workspaces
        .iter()
        .filter(|w| w.archived != Some(true))
        .cloned()
        .collect();
    let archived: Vec<&Workspace> = data
        .workspaces
        .iter()
        .filter(|w| w.archived == Some(true))
        .collect();

    let forest = build_spawn_forest(&active);
    let orchestrator_trees: Vec<Vec<TreeRow>> = forest
        .roots
        .iter()
        .filter(|w| w.kind == Some(orchestra_rpc::types::WorkspaceKind::Orchestrator))
        .map(|root| super::forest::flatten_subtree(root, &forest.children_of, &mut HashSet::new()))
        .collect();
    let scratch_trees: Vec<Vec<TreeRow>> = forest
        .roots
        .iter()
        .filter(|w| w.kind == Some(orchestra_rpc::types::WorkspaceKind::Scratch))
        .map(|root| super::forest::flatten_subtree(root, &forest.children_of, &mut HashSet::new()))
        .collect();

    // Repo sections are built from git-worktree ROOTS only (spawn beats repo).
    let repo_roots: Vec<Workspace> = forest
        .roots
        .iter()
        .filter(|w| !w.is_scratch_like())
        .cloned()
        .collect();
    let groups = group_roots_by_repo(&repo_roots, &forest);
    // Every registered repo shows a section (even at 0 workspaces), plus any
    // orphan repoPaths that still have workspaces.
    let mut repo_order: Vec<String> = data.repos.iter().map(|r| r.path.clone()).collect();
    for (path, _) in &groups {
        if !repo_order.contains(path) {
            repo_order.push(path.clone());
        }
    }

    if repo_order.is_empty()
        && archived.is_empty()
        && scratch_trees.is_empty()
        && orchestrator_trees.is_empty()
    {
        out.push(Row::EmptyHint);
    }

    if !orchestrator_trees.is_empty() {
        out.push(Row::SectionHeader {
            kind: SectionKind::Orchestrators,
            count: orchestrator_trees.len(),
        });
        tree_section_rows(
            data,
            ui,
            &orchestrator_trees,
            TreeVariant::Orchestrator,
            &forest,
            &mut out,
        );
    }
    if !scratch_trees.is_empty() {
        out.push(Row::SectionHeader {
            kind: SectionKind::Scratch,
            count: scratch_trees.len(),
        });
        tree_section_rows(
            data,
            ui,
            &scratch_trees,
            TreeVariant::Scratch,
            &forest,
            &mut out,
        );
    }

    for repo_path in &repo_order {
        let items: &[TreeRow] = groups
            .iter()
            .find(|(p, _)| p == repo_path)
            .map(|(_, rows)| rows.as_slice())
            .unwrap_or(&[]);
        let registered = data.repos.iter().any(|r| r.path == *repo_path);
        let can_remove = registered && !data.workspaces.iter().any(|w| w.repo_path == *repo_path);
        let collapsed = ui.collapsed_repos.contains(repo_path);
        let repo = data.repos.iter().find(|r| r.path == *repo_path);
        out.push(Row::RepoHeader(RepoHeaderSpec {
            repo_path: repo_path.clone(),
            label: repo_label(&data.repos, repo_path),
            count: items.len(),
            registered,
            can_remove,
            collapsed,
            remote_url: repo.and_then(|r| r.remote_url.clone()),
            account_id: repo.and_then(|r| r.account_id.clone()),
        }));
        if collapsed {
            continue;
        }
        if let Some(sync) = data.repo_sync.get(repo_path) {
            out.push(Row::RepoSync(sync.clone()));
        }
        let push_ws = |out: &mut Vec<Row>, row: &TreeRow| {
            let cross_repo_child = row.depth > 0 && row.ws.repo_path != *repo_path;
            out.push(Row::Workspace(Box::new(ws_row(
                data,
                ui,
                &row.ws,
                row.depth,
                None,
                cross_repo_child,
                false,
                &[],
            ))));
        };
        match group_by_host(items, |r| r.ws.host.as_ref()) {
            // All-local repo: flat list, byte-for-byte the previous layout.
            None => items.iter().for_each(|r| push_ws(&mut out, r)),
            // Mixed repo: a collapsible header per node, rows beneath.
            Some(node_groups) => {
                for (key, indices) in node_groups {
                    let host_id = format!("{repo_path}::{key}");
                    let host_collapsed = ui.collapsed_hosts.contains(&host_id);
                    out.push(Row::HostHeader(HostHeaderSpec {
                        host_id,
                        label: host_label(&key),
                        remote: key != "local",
                        collapsed: host_collapsed,
                        count: indices.len(),
                    }));
                    if !host_collapsed {
                        indices.iter().for_each(|&i| push_ws(&mut out, &items[i]));
                    }
                }
            }
        }
    }

    if !archived.is_empty() {
        out.push(Row::ArchivedToggle {
            count: archived.len(),
            open: ui.archived_open,
        });
        if ui.archived_open {
            let selected = archived
                .iter()
                .filter(|w| ui.selected_archived.contains(&w.id))
                .count();
            let all_selected = selected > 0 && selected == archived.len();
            out.push(Row::ArchivedBar(ArchivedBarSpec {
                selected,
                all_selected,
                some_selected: selected > 0 && !all_selected,
                bulk_delete: ui.bulk_delete,
            }));
            for w in archived {
                out.push(Row::Archived(Box::new(ArchivedRowSpec {
                    repo_label: repo_label(&data.repos, &w.repo_path),
                    size: data.sizes.get(&w.id).copied(),
                    sizes_exclusive: data.sizes_exclusive,
                    selected: ui.selected_archived.contains(&w.id),
                    deleting: ui.deleting_ids.contains(&w.id),
                    ws: w.clone(),
                })));
            }
        }
    }

    out
}

/// Notices to show below the list: not-ok items the user hasn't dismissed. A
/// resolved item never shows, even if previously dismissed.
pub fn env_notices(status: &[EnvStatusItem], dismissed: &HashSet<String>) -> Vec<EnvStatusItem> {
    status
        .iter()
        .filter(|it| !it.ok && !dismissed.contains(&it.id))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{mock_workspaces, Backend, MockBackend};

    fn mock_data() -> SidebarData {
        let b = MockBackend::default();
        SidebarData {
            workspaces: mock_workspaces(),
            repos: b.list_repos().unwrap(),
            sizes: HashMap::from([
                ("ws-1".into(), 61_000_000),
                ("ws-arch-1".into(), 512_000_000),
            ]),
            sizes_exclusive: true,
            ..Default::default()
        }
    }

    fn keys(rows: &[Row]) -> Vec<String> {
        rows.iter().map(|r| r.key()).collect()
    }

    /// The row badge must show the login's LABEL (never the raw account id),
    /// tinted by the hotter window — the `AccountBadge.tsx` contract. Regression
    /// guard for the M3 gap where the sidebar rendered `account_id` verbatim.
    #[test]
    fn account_badge_resolves_label_not_id() {
        let mut data = mock_data();
        data.now_ms = 1_752_930_000_000;
        data.account_labels = HashMap::from([("acc-work".to_string(), "work".to_string())]);
        data.account_usage = serde_json::from_value(serde_json::json!({
            "acc-work": {
                "accountId": "acc-work", "ok": true, "fetchedAt": 1_752_930_000_000_i64,
                "data": {
                    "fiveHour": { "utilization": 48.0, "resetsAt": "" },
                    "sevenDay": { "utilization": 91.0, "resetsAt": "" },
                    "extraUtilization": null, "fable": null
                }
            }
        }))
        .unwrap();

        // Pinned account → its label, tinted by the HOTTER window (91 → crit).
        let (label, sev, tip) = resolve_account_badge(Some("acc-work"), &data, data.now_ms);
        assert_eq!(label, "work", "must render the label, not the id");
        assert_eq!(sev, Some(Severity::Crit));
        assert!(tip.contains("5-hour window: 48%") && tip.contains("7-day window: 91%"));

        // Unpinned → the default login (global poller absent here → pending).
        let (label, sev, tip) = resolve_account_badge(None, &data, data.now_ms);
        assert_eq!(label, DEFAULT_LOGIN_LABEL);
        assert_eq!(sev, None);
        assert!(tip.contains("fetching usage"));

        // A DANGLING id (account deleted) falls back to the default login
        // rather than leaking the id into the UI.
        let (label, _, _) = resolve_account_badge(Some("acc-gone"), &data, data.now_ms);
        assert_eq!(label, DEFAULT_LOGIN_LABEL);
    }

    /// An expired token keeps its cached usage and stays normally tinted (only
    /// the tooltip flags it); a hard error renders untinted with the reason.
    #[test]
    fn account_badge_expired_stays_tinted_error_does_not() {
        let mut data = mock_data();
        data.now_ms = 1_752_930_000_000;
        data.account_labels = HashMap::from([
            ("acc-exp".to_string(), "perso".to_string()),
            ("acc-err".to_string(), "broken".to_string()),
        ]);
        data.account_usage = serde_json::from_value(serde_json::json!({
            "acc-exp": {
                "accountId": "acc-exp", "ok": true, "fetchedAt": 1_752_930_000_000_i64,
                "expired": true,
                "data": {
                    "fiveHour": { "utilization": 80.0, "resetsAt": "" },
                    "sevenDay": { "utilization": 20.0, "resetsAt": "" },
                    "extraUtilization": null, "fable": null
                }
            },
            "acc-err": {
                "accountId": "acc-err", "ok": false, "fetchedAt": 1_752_930_000_000_i64,
                "data": null, "errorKind": "not-logged-in", "errorMessage": "no login"
            }
        }))
        .unwrap();

        let (label, sev, tip) = resolve_account_badge(Some("acc-exp"), &data, data.now_ms);
        assert_eq!(label, "perso");
        assert_eq!(sev, Some(Severity::Warn), "expired keeps its cached tint");
        assert!(tip.contains("token expired"));

        let (label, sev, tip) = resolve_account_badge(Some("acc-err"), &data, data.now_ms);
        assert_eq!(label, "broken");
        assert_eq!(sev, None, "a hard usage error renders untinted");
        assert!(tip.contains("no login found"), "tooltip explains: {tip}");
    }

    #[test]
    fn section_order_and_tree_threading() {
        let rows = compute_rows(&mock_data(), &SidebarUi::default());
        let ks = keys(&rows);
        // Orchestrators first: root, its git child, that child's cross-repo
        // grandchild, the nested scratch — depth-first.
        let expect_prefix = vec![
            "section:Orchestrators",
            "ws:orch-1",
            "ws:ws-child-a",
            "ws:ws-grandchild",
            "ws:orch-scratch-kid",
            "section:Scratch",
            "ws:scratch-1",
            "ws:ws-from-scratch",
            "repo:/home/user/repos/orchestra",
        ];
        assert_eq!(&ks[..expect_prefix.len()], expect_prefix.as_slice());
        // Repo sections come in registered order; archived trails.
        let orch_pos = ks
            .iter()
            .position(|k| k == "repo:/home/user/repos/orchestra")
            .unwrap();
        let mc_pos = ks
            .iter()
            .position(|k| k == "repo:/home/user/repos/mobile-club")
            .unwrap();
        let arch_pos = ks.iter().position(|k| k == "archived-toggle").unwrap();
        assert!(orch_pos < mc_pos && mc_pos < arch_pos);
        // Spawned children never re-appear as repo-section roots.
        let orchestra_rows: Vec<&String> = ks[orch_pos..mc_pos].iter().collect();
        assert!(!orchestra_rows.iter().any(|k| k.as_str() == "ws:ws-child-a"));
        assert!(!orchestra_rows
            .iter()
            .any(|k| k.as_str() == "ws:ws-from-scratch"));
    }

    #[test]
    fn section_count_is_root_count_not_row_count() {
        let rows = compute_rows(&mock_data(), &SidebarUi::default());
        let Some(Row::SectionHeader { count, .. }) = rows.first() else {
            panic!("first row must be the Orchestrators header");
        };
        // One orchestrator tree (4 rows) → count 1.
        assert_eq!(*count, 1);
    }

    #[test]
    fn host_grouping_only_for_mixed_repos() {
        let rows = compute_rows(&mock_data(), &SidebarUi::default());
        let ks = keys(&rows);
        // orchestra repo is all-local → no host headers under it.
        let orch_pos = ks
            .iter()
            .position(|k| k == "repo:/home/user/repos/orchestra")
            .unwrap();
        let mc_pos = ks
            .iter()
            .position(|k| k == "repo:/home/user/repos/mobile-club")
            .unwrap();
        assert!(!ks[orch_pos..mc_pos].iter().any(|k| k.starts_with("host:")));
        // mobile-club has sandbox rows → local header first, then the node.
        let mc_keys = &ks[mc_pos..];
        let local = mc_keys
            .iter()
            .position(|k| k == "host:/home/user/repos/mobile-club::local")
            .unwrap();
        let sandbox = mc_keys
            .iter()
            .position(|k| k.starts_with("host:/home/user/repos/mobile-club::sandbox:"))
            .unwrap();
        assert!(local < sandbox);
    }

    #[test]
    fn host_collapse_hides_rows_but_keeps_header() {
        let mut ui = SidebarUi::default();
        ui.collapsed_hosts
            .insert("/home/user/repos/mobile-club::sandbox:ws://sandbox-a:8787".to_string());
        let rows = compute_rows(&mock_data(), &ui);
        let ks = keys(&rows);
        assert!(ks
            .iter()
            .any(|k| k.starts_with("host:/home/user/repos/mobile-club::sandbox:")));
        assert!(!ks.iter().any(|k| k == "ws:ws-mc-sb1"));
        assert!(ks.iter().any(|k| k == "ws:ws-mc-1"));
    }

    #[test]
    fn subtree_collapse_summarizes_hidden_urgency() {
        let mut ui = SidebarUi::default();
        ui.collapsed_subtrees.insert("orch-1".into());
        let rows = compute_rows(&mock_data(), &ui);
        let ws_rows: Vec<&WsRowSpec> = rows
            .iter()
            .filter_map(|r| match r {
                Row::Workspace(s) => Some(s.as_ref()),
                _ => None,
            })
            .collect();
        let orch = ws_rows.iter().find(|s| s.ws.id == "orch-1").unwrap();
        assert!(orch.collapsed);
        assert_eq!(orch.hidden_count, 3);
        // The nested scratch child is waiting+unread; the git child running →
        // waiting outranks running.
        assert_eq!(orch.hidden_urgency, Some(HiddenUrgency::Waiting));
        assert!(orch.hidden_names.contains("(unread)"));
        // Its subtree rows are gone from the list.
        assert!(!ws_rows.iter().any(|s| s.ws.id == "ws-child-a"));
    }

    #[test]
    fn repo_collapse_hides_sync_and_rows() {
        let mut data = mock_data();
        data.repo_sync.insert(
            "/home/user/repos/orchestra".into(),
            serde_json::from_value(serde_json::json!({
                "repoPath": "/home/user/repos/orchestra", "baseBranch": "master",
                "behind": 2, "ahead": 0, "hasUpstream": true, "syncedAt": 0, "syncing": false,
            }))
            .unwrap(),
        );
        let open = compute_rows(&data, &SidebarUi::default());
        assert!(keys(&open)
            .iter()
            .any(|k| k == "sync:/home/user/repos/orchestra"));
        let mut ui = SidebarUi::default();
        ui.collapsed_repos
            .insert("/home/user/repos/orchestra".into());
        let closed = compute_rows(&data, &ui);
        let ks = keys(&closed);
        assert!(!ks.iter().any(|k| k == "sync:/home/user/repos/orchestra"));
        assert!(!ks.iter().any(|k| k == "ws:ws-1"));
        // Header itself stays.
        assert!(ks.iter().any(|k| k == "repo:/home/user/repos/orchestra"));
    }

    #[test]
    fn archived_section_selection_and_bulk_bar() {
        let mut ui = SidebarUi {
            archived_open: true,
            ..Default::default()
        };
        ui.selected_archived.insert("ws-arch-1".into());
        let rows = compute_rows(&mock_data(), &ui);
        let bar = rows
            .iter()
            .find_map(|r| match r {
                Row::ArchivedBar(b) => Some(b.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(bar.selected, 1);
        assert!(bar.some_selected && !bar.all_selected);
        let arch_rows: Vec<&ArchivedRowSpec> = rows
            .iter()
            .filter_map(|r| match r {
                Row::Archived(s) => Some(s.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(arch_rows.len(), 3);
        assert!(arch_rows.iter().any(|s| s.selected));
        // Closed section: toggle only.
        let closed = compute_rows(&mock_data(), &SidebarUi::default());
        assert!(keys(&closed).iter().any(|k| k == "archived-toggle"));
        assert!(!keys(&closed).iter().any(|k| k.starts_with("archived:")));
    }

    #[test]
    fn cross_repo_child_gets_repo_tag() {
        let rows = compute_rows(&mock_data(), &SidebarUi::default());
        let grandchild = rows
            .iter()
            .find_map(|r| match r {
                Row::Workspace(s) if s.ws.id == "ws-grandchild" => Some(s),
                _ => None,
            })
            .unwrap();
        // Tree-section git child shows the repo tag (child_is_git).
        assert!(grandchild.child_is_git);
        assert_eq!(grandchild.repo_label, "mobile-club");
        assert_eq!(grandchild.depth, 2);
    }

    #[test]
    fn empty_store_shows_the_empty_hint() {
        let rows = compute_rows(&SidebarData::default(), &SidebarUi::default());
        assert_eq!(keys(&rows), vec!["empty"]);
    }

    #[test]
    fn env_notices_filter_ok_and_dismissed() {
        let items: Vec<EnvStatusItem> = serde_json::from_value(serde_json::json!([
            {"id": "linear", "label": "Linear", "ok": false, "detail": "d"},
            {"id": "gh", "label": "GitHub CLI", "ok": false, "detail": "d"},
            {"id": "resolved", "label": "X", "ok": true, "detail": "d"},
        ]))
        .unwrap();
        let dismissed = HashSet::from(["gh".to_string()]);
        let shown = env_notices(&items, &dismissed);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].id, "linear");
        // A resolved item never shows even when never dismissed.
        assert!(!env_notices(&items, &HashSet::new())
            .iter()
            .any(|i| i.id == "resolved"));
    }

    #[test]
    fn context_tokens_live_override_and_zero_sentinel() {
        let mut data = mock_data();
        let ui = SidebarUi::default();
        // Stored value shows.
        let rows = compute_rows(&data, &ui);
        let ws1 = rows.iter().find_map(|r| match r {
            Row::Workspace(s) if s.ws.id == "ws-1" => Some(s),
            _ => None,
        });
        assert_eq!(ws1.unwrap().context_tokens, Some(127_000));
        // Live override wins.
        data.context_tokens.insert("ws-1".into(), 200_000);
        let rows = compute_rows(&data, &ui);
        let ws1 = rows.iter().find_map(|r| match r {
            Row::Workspace(s) if s.ws.id == "ws-1" => Some(s),
            _ => None,
        });
        assert_eq!(ws1.unwrap().context_tokens, Some(200_000));
    }
}
