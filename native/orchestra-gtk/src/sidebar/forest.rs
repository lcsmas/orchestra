//! Spawn-forest logic (plan §5.1) — pure port of the tree helpers at the top
//! of `src/renderer/components/Sidebar.tsx` (`buildSpawnForest`,
//! `flattenSubtree`, `collectDescendants`, `groupRootsByRepo`, plus the
//! collapse-filtered render walk and the hidden-subtree urgency summary that
//! live inline in the component there). No GTK — unit-tested without a
//! display.
//!
//! A workspace spawned via `/spawn` carries the `parentId` of the workspace
//! that spawned it; this links them into trees. A "root" is any workspace
//! whose `parentId` is absent or points outside the set (parent deleted or
//! archived) — dangling parents degrade gracefully to roots.

use std::collections::{HashMap, HashSet};

use orchestra_rpc::types::{Workspace, WorkspaceStatus};

/// A workspace paired with its depth in the orchestrator→children tree.
/// Depth 0 is a root (no live parent); each spawned child sits one level
/// deeper than the workspace that spawned it.
#[derive(Debug, Clone, PartialEq)]
pub struct TreeRow {
    pub ws: Workspace,
    pub depth: usize,
}

/// Spawn forest derived from the active workspace set
/// (`Sidebar.tsx` `SpawnForest`).
#[derive(Debug, Default)]
pub struct SpawnForest {
    /// parentId → its direct children, in store order.
    pub children_of: HashMap<String, Vec<Workspace>>,
    /// Workspaces with no live parent, in store order.
    pub roots: Vec<Workspace>,
    /// id → the id of its root ancestor (walking parentId up). A node maps to
    /// itself when it is a root. Cycles (which should never occur) resolve to
    /// the node where the walk first repeats, so the lookup always terminates.
    pub root_of: HashMap<String, String>,
}

pub fn build_spawn_forest(list: &[Workspace]) -> SpawnForest {
    let by_id: HashMap<&str, &Workspace> = list.iter().map(|w| (w.id.as_str(), w)).collect();
    let mut children_of: HashMap<String, Vec<Workspace>> = HashMap::new();
    let mut roots = Vec::new();
    for ws in list {
        let parent = ws
            .parent_id
            .as_deref()
            .and_then(|pid| by_id.get(pid).copied());
        match parent {
            Some(parent) => children_of
                .entry(parent.id.clone())
                .or_default()
                .push(ws.clone()),
            None => roots.push(ws.clone()),
        }
    }
    let mut root_of = HashMap::new();
    for ws in list {
        let mut cur = ws;
        let mut seen: HashSet<&str> = HashSet::from([cur.id.as_str()]);
        loop {
            let parent = cur
                .parent_id
                .as_deref()
                .and_then(|pid| by_id.get(pid).copied());
            match parent {
                Some(p) if !seen.contains(p.id.as_str()) => {
                    seen.insert(p.id.as_str());
                    cur = p;
                }
                _ => break,
            }
        }
        root_of.insert(ws.id.clone(), cur.id.clone());
    }
    SpawnForest {
        children_of,
        roots,
        root_of,
    }
}

/// Flatten one root's subtree into depth-first rows carrying each node's
/// depth, so children render indented under the workspace that spawned them.
/// Iterative walk (deep trees can't blow the stack) with a visited set (a
/// corrupt cycle can't loop forever).
pub fn flatten_subtree(
    root: &Workspace,
    children_of: &HashMap<String, Vec<Workspace>>,
    visited: &mut HashSet<String>,
) -> Vec<TreeRow> {
    let mut rows = Vec::new();
    let mut stack = vec![TreeRow {
        ws: root.clone(),
        depth: 0,
    }];
    while let Some(row) = stack.pop() {
        if !visited.insert(row.ws.id.clone()) {
            continue;
        }
        let kids = children_of.get(&row.ws.id);
        let depth = row.depth;
        rows.push(row);
        if let Some(kids) = kids {
            // Push reversed so children are visited in their natural order.
            for kid in kids.iter().rev() {
                stack.push(TreeRow {
                    ws: kid.clone(),
                    depth: depth + 1,
                });
            }
        }
    }
    rows
}

/// All descendants of a node in the spawn forest, depth-first. Used to
/// summarize a collapsed subtree: how many rows are hidden and whether any of
/// them still demands attention. Guards against corrupt cycles like
/// `flatten_subtree` does.
pub fn collect_descendants(
    id: &str,
    children_of: &HashMap<String, Vec<Workspace>>,
) -> Vec<Workspace> {
    let mut out = Vec::new();
    let mut stack: Vec<Workspace> = children_of
        .get(id)
        .map(|kids| kids.iter().rev().cloned().collect())
        .unwrap_or_default();
    let mut seen = HashSet::new();
    while let Some(w) = stack.pop() {
        if !seen.insert(w.id.clone()) {
            continue;
        }
        if let Some(kids) = children_of.get(&w.id) {
            for kid in kids.iter().rev() {
                stack.push(kid.clone());
            }
        }
        out.push(w);
    }
    out
}

/// Group git workspaces into repo sections, threaded as spawn trees. Each
/// root is filed under its own `repoPath`; its descendants follow it
/// depth-first in the SAME section, so a child in repo B still appears under
/// its parent in repo A — the spawn relationship wins over repo grouping.
/// Returns sections in first-seen root order (the TS `Map` insertion order).
pub fn group_roots_by_repo(
    roots: &[Workspace],
    forest: &SpawnForest,
) -> Vec<(String, Vec<TreeRow>)> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<TreeRow>> = HashMap::new();
    let mut visited = HashSet::new();
    for root in roots {
        let rows = flatten_subtree(root, &forest.children_of, &mut visited);
        match groups.get_mut(&root.repo_path) {
            Some(existing) => existing.extend(rows),
            None => {
                order.push(root.repo_path.clone());
                groups.insert(root.repo_path.clone(), rows);
            }
        }
    }
    order
        .into_iter()
        .map(|path| {
            let rows = groups.remove(&path).unwrap_or_default();
            (path, rows)
        })
        .collect()
}

/// The collapse-filtered render walk (`Sidebar.tsx` `renderSpawnTreeRows`):
/// rows are depth-first, so a collapsed node hides every deeper row that
/// follows it until the walk climbs back to its depth.
pub fn visible_rows(rows: &[TreeRow], collapsed: &HashSet<String>) -> Vec<TreeRow> {
    let mut visible = Vec::new();
    let mut skip_below: Option<usize> = None;
    for row in rows {
        if let Some(limit) = skip_below {
            if row.depth > limit {
                continue;
            }
        }
        skip_below = None;
        visible.push(row.clone());
        if collapsed.contains(&row.ws.id) {
            skip_below = Some(row.depth);
        }
    }
    visible
}

/// Most urgent status among a collapsed subtree's hidden rows, so a folded
/// subtree can't silently swallow an agent that errored, is waiting for
/// input, or carries the manual unread tag (shown with the same urgency as
/// waiting). error > waiting > running; anything else tints nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HiddenUrgency {
    Error,
    Waiting,
    Running,
}

impl HiddenUrgency {
    /// CSS class suffix on the hidden-count pill.
    pub fn css_class(self) -> &'static str {
        match self {
            HiddenUrgency::Error => "error",
            HiddenUrgency::Waiting => "waiting",
            HiddenUrgency::Running => "running",
        }
    }
}

pub fn hidden_urgency(hidden: &[Workspace]) -> Option<HiddenUrgency> {
    if hidden.iter().any(|h| h.status == WorkspaceStatus::Error) {
        Some(HiddenUrgency::Error)
    } else if hidden
        .iter()
        .any(|h| h.status == WorkspaceStatus::Waiting || h.marked_unread == Some(true))
    {
        Some(HiddenUrgency::Waiting)
    } else if hidden.iter().any(|h| h.status == WorkspaceStatus::Running) {
        Some(HiddenUrgency::Running)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Serde-built like the mock fixtures, so new wire fields can't break
    /// the tests (see backend.rs `mock_workspace`).
    fn ws(id: &str, parent: Option<&str>, kind: Option<&str>, repo: &str) -> Workspace {
        let mut v = json!({
            "id": id,
            "name": format!("test · {id}"),
            "repoPath": repo,
            "worktreePath": format!("/w/{id}"),
            "branch": id,
            "baseBranch": "master",
            "status": "idle",
            "createdAt": 1_752_800_000_000_u64,
            "agent": "claude",
        });
        if let Some(p) = parent {
            v["parentId"] = json!(p);
        }
        if let Some(k) = kind {
            v["kind"] = json!(k);
        }
        serde_json::from_value(v).unwrap()
    }

    fn with_status(mut w: Workspace, status: WorkspaceStatus) -> Workspace {
        w.status = status;
        w
    }

    #[test]
    fn roots_children_and_root_of() {
        let list = vec![
            ws("orch", None, Some("orchestrator"), ""),
            ws("a", Some("orch"), None, "/r1"),
            ws("b", Some("a"), None, "/r1"),
            ws("lone", None, None, "/r2"),
            ws("dangling", Some("gone"), None, "/r2"),
        ];
        let f = build_spawn_forest(&list);
        let root_ids: Vec<&str> = f.roots.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(root_ids, vec!["orch", "lone", "dangling"]);
        assert_eq!(
            f.children_of["orch"]
                .iter()
                .map(|w| &w.id)
                .collect::<Vec<_>>(),
            vec!["a"]
        );
        assert_eq!(f.root_of["b"], "orch");
        assert_eq!(f.root_of["orch"], "orch");
        // Dangling parent → the node is its own root.
        assert_eq!(f.root_of["dangling"], "dangling");
    }

    #[test]
    fn cycle_terminates() {
        // Should never occur, but a corrupt store must not hang the UI.
        let list = vec![
            ws("x", Some("y"), None, "/r"),
            ws("y", Some("x"), None, "/r"),
        ];
        let f = build_spawn_forest(&list);
        assert!(f.roots.is_empty());
        assert_eq!(f.root_of["x"], "y"); // walk stops where it first repeats
        let mut visited = HashSet::new();
        let rows = flatten_subtree(&list[0], &f.children_of, &mut visited);
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn flatten_is_depth_first_in_natural_order() {
        let list = vec![
            ws("r", None, None, "/r"),
            ws("c1", Some("r"), None, "/r"),
            ws("c2", Some("r"), None, "/r"),
            ws("g1", Some("c1"), None, "/r"),
        ];
        let f = build_spawn_forest(&list);
        let rows = flatten_subtree(&list[0], &f.children_of, &mut HashSet::new());
        let got: Vec<(&str, usize)> = rows.iter().map(|r| (r.ws.id.as_str(), r.depth)).collect();
        assert_eq!(got, vec![("r", 0), ("c1", 1), ("g1", 2), ("c2", 1)]);
    }

    #[test]
    fn collect_descendants_excludes_self() {
        let list = vec![
            ws("r", None, None, "/r"),
            ws("c1", Some("r"), None, "/r"),
            ws("g1", Some("c1"), None, "/r"),
        ];
        let f = build_spawn_forest(&list);
        let d = collect_descendants("r", &f.children_of);
        let ids: Vec<&str> = d.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["c1", "g1"]);
        assert!(collect_descendants("g1", &f.children_of).is_empty());
    }

    #[test]
    fn spawn_relationship_wins_over_repo_grouping() {
        // A child living in repo B still files under its parent's repo A
        // section; repo B gets no section of its own for it.
        let list = vec![
            ws("pa", None, None, "/repoA"),
            ws("kid-in-b", Some("pa"), None, "/repoB"),
            ws("solo-b", None, None, "/repoB"),
        ];
        let f = build_spawn_forest(&list);
        let roots: Vec<Workspace> = f.roots.clone();
        let groups = group_roots_by_repo(&roots, &f);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].0, "/repoA");
        let a_ids: Vec<&str> = groups[0].1.iter().map(|r| r.ws.id.as_str()).collect();
        assert_eq!(a_ids, vec!["pa", "kid-in-b"]);
        let b_ids: Vec<&str> = groups[1].1.iter().map(|r| r.ws.id.as_str()).collect();
        assert_eq!(b_ids, vec!["solo-b"]);
    }

    #[test]
    fn two_roots_same_repo_merge_into_one_section() {
        let list = vec![
            ws("r1", None, None, "/repoA"),
            ws("r2", None, None, "/repoA"),
        ];
        let f = build_spawn_forest(&list);
        let groups = group_roots_by_repo(&f.roots.clone(), &f);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 2);
    }

    #[test]
    fn visible_rows_hides_collapsed_subtree_only() {
        let rows = vec![
            TreeRow {
                ws: ws("r", None, None, "/r"),
                depth: 0,
            },
            TreeRow {
                ws: ws("c1", None, None, "/r"),
                depth: 1,
            },
            TreeRow {
                ws: ws("g1", None, None, "/r"),
                depth: 2,
            },
            TreeRow {
                ws: ws("c2", None, None, "/r"),
                depth: 1,
            },
        ];
        let collapsed = HashSet::from(["c1".to_string()]);
        let visible = visible_rows(&rows, &collapsed);
        let ids: Vec<&str> = visible.iter().map(|r| r.ws.id.as_str()).collect();
        // c1 itself stays visible (carrying the hidden-count pill); only its
        // deeper descendants disappear. c2 is back at depth 1 → visible.
        assert_eq!(ids, vec!["r", "c1", "c2"]);

        // Collapsing the root hides everything below it.
        let collapsed = HashSet::from(["r".to_string()]);
        let ids: Vec<String> = visible_rows(&rows, &collapsed)
            .iter()
            .map(|r| r.ws.id.clone())
            .collect();
        assert_eq!(ids, vec!["r"]);
    }

    #[test]
    fn urgency_ranks_error_over_waiting_over_running() {
        let idle = ws("i", None, None, "/r");
        let running = with_status(ws("r", None, None, "/r"), WorkspaceStatus::Running);
        let waiting = with_status(ws("w", None, None, "/r"), WorkspaceStatus::Waiting);
        let error = with_status(ws("e", None, None, "/r"), WorkspaceStatus::Error);
        let mut unread = ws("u", None, None, "/r");
        unread.marked_unread = Some(true);

        assert_eq!(hidden_urgency(std::slice::from_ref(&idle)), None);
        assert_eq!(
            hidden_urgency(&[idle.clone(), running.clone()]),
            Some(HiddenUrgency::Running)
        );
        assert_eq!(
            hidden_urgency(&[running.clone(), waiting.clone()]),
            Some(HiddenUrgency::Waiting)
        );
        // The manual unread tag carries waiting-level urgency.
        assert_eq!(
            hidden_urgency(&[running.clone(), unread]),
            Some(HiddenUrgency::Waiting)
        );
        assert_eq!(
            hidden_urgency(&[waiting, running, error]),
            Some(HiddenUrgency::Error)
        );
    }
}
