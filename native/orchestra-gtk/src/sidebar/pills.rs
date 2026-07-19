//! Row pill/badge state (plan §5.1) — pure ports of the formatting helpers
//! and the per-row pill derivation inline in `Sidebar.tsx` (`formatBytes`,
//! `SIZE_BADGE_MIN_BYTES`, `orderedVisiblePRs`, the released-versions
//! fallback chain, `hasPills`) plus `formatTokens` from `AccountBadge.tsx`
//! (the context badge). No GTK — unit-tested without a display.

use orchestra_rpc::types::{
    DiffStats, LinearIssue, PrInfo, PrState, PrsForBranch, SetupStatus, Workspace,
};

/// Active rows only surface the size badge above this threshold (the archived
/// list always shows sizes — it's the delete-candidates view and has room).
pub const SIZE_BADGE_MIN_BYTES: u64 = 50 * 1024 * 1024;

/// Compact human size for a worktree, e.g. 1536 → "1.5 KB", 2.8e9 → "2.6 GB".
/// Binary units (matches what `du`/file managers report) — `formatBytes`.
pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut val = bytes as f64 / 1024.0;
    let mut i = 0;
    while val >= 1024.0 && i < UNITS.len() - 1 {
        val /= 1024.0;
        i += 1;
    }
    if val < 10.0 {
        format!("{val:.1} {}", UNITS[i])
    } else {
        format!("{} {}", val.round() as u64, UNITS[i])
    }
}

/// Compact token count for the context badge: 41679 → "42k", 1240000 →
/// "1.2M". Whole-thousands below 100k so the figure stays narrow next to the
/// branch (`formatTokens`).
pub fn format_tokens(n: u64) -> String {
    if n < 1000 {
        return n.to_string();
    }
    if n < 1_000_000 {
        let k = n as f64 / 1000.0;
        return if k < 10.0 {
            format!("{k:.1}k")
        } else {
            format!("{}k", k.round() as u64)
        };
    }
    let m = n as f64 / 1_000_000.0;
    if m < 10.0 {
        format!("{m:.1}M")
    } else {
        format!("{}M", m.round() as u64)
    }
}

/// The size badge's honest tooltip: on btrfs the backend reports EXCLUSIVE
/// bytes (what deleting the worktree would reclaim), elsewhere apparent size.
pub fn size_title(exclusive: bool) -> &'static str {
    if exclusive {
        "Worktree size on disk — exclusive bytes, i.e. what deleting it would reclaim (data shared with other worktrees via btrfs reflinks is not counted)"
    } else {
        "Worktree size on disk (apparent; btrfs reflinks are shared between worktrees, so this is not all reclaimable)"
    }
}

/// PRs for a branch, ordered open-first then gh's newest-first, capped at the
/// three we surface (`orderedVisiblePRs`). Returns (visible, hidden count).
pub fn ordered_visible_prs(pr_record: Option<&PrsForBranch>) -> (Vec<PrInfo>, usize) {
    let mut all: Vec<PrInfo> = pr_record.map(|r| r.all.clone()).unwrap_or_default();
    // Stable sort: OPEN first, otherwise keep gh's newest-first order.
    all.sort_by_key(|p| (p.state != PrState::Open) as u8);
    let hidden = all.len().saturating_sub(3);
    all.truncate(3);
    (all, hidden)
}

/// Everything the `.ws-pills` strip renders for one workspace row, derived
/// once so the row builder and the `has_pills` layout decision agree.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RowPills {
    /// "merged" pill — suppressed while a purple merged-PR badge is visible
    /// (that badge already conveys "merged").
    pub merged: bool,
    /// One pill per release containing this branch's work; a lone empty
    /// string is never emitted — `None` text means the bare "released" pill.
    pub released: Option<Vec<String>>,
    /// ↑N commits not yet on origin.
    pub unpushed: Option<u32>,
    /// +A −D over N files, only when something actually changed.
    pub diff: Option<DiffStats>,
    /// setup pill: failed (click focuses the row) or running.
    pub setup: Option<SetupStatus>,
    /// PR badges, open-first, capped at 3.
    pub prs_visible: Vec<PrInfo>,
    pub prs_hidden: usize,
    /// Verified Linear issue badge.
    pub linear: Option<LinearIssue>,
    /// Repo tag pill for a child spawned into a different repo than the
    /// section it renders in.
    pub cross_repo_child: bool,
    /// Size badge bytes (≥ threshold only). `size_in_strip` says whether it
    /// rides at the pill strip's right edge (strip non-empty) or stays inline
    /// on the name row.
    pub size: Option<u64>,
    pub size_in_strip: bool,
}

pub fn row_pills(
    ws: &Workspace,
    diff_stats: Option<&DiffStats>,
    size_bytes: Option<u64>,
    pr_record: Option<&PrsForBranch>,
    linear: Option<&LinearIssue>,
    cross_repo_child: bool,
) -> RowPills {
    let (prs_visible, prs_hidden) = ordered_visible_prs(pr_record);
    let has_merged_pr_badge = prs_visible.iter().any(|p| p.state == PrState::Merged);
    let merged =
        ws.merged_at.is_some() && ws.diverged_from_base != Some(true) && !has_merged_pr_badge;
    let released = ws.released_at.map(|_| {
        // One pill per release; fall back to the single releasedVersion for
        // pre-upgrade records, then to a bare "released" (empty vec).
        match (&ws.released_versions, &ws.released_version) {
            (Some(vs), _) if !vs.is_empty() => vs.clone(),
            (_, Some(v)) => vec![v.clone()],
            _ => vec![],
        }
    });
    let unpushed = ws.unpushed_ahead.filter(|n| *n > 0);
    let diff = diff_stats
        .filter(|s| s.additions > 0 || s.deletions > 0)
        .cloned();
    let setup = ws
        .setup_status
        .filter(|s| matches!(s, SetupStatus::Failed | SetupStatus::Running));
    let linear = linear.cloned();

    let has_pills = cross_repo_child
        || merged
        || released.is_some()
        || unpushed.is_some()
        || diff.is_some()
        || setup.is_some()
        || !prs_visible.is_empty()
        || linear.is_some();
    let size = size_bytes.filter(|b| *b >= SIZE_BADGE_MIN_BYTES);

    RowPills {
        merged,
        released,
        unpushed,
        diff,
        setup,
        prs_visible,
        prs_hidden,
        linear,
        cross_repo_child,
        size,
        size_in_strip: has_pills,
    }
}

impl RowPills {
    /// Whether the strip renders anything at all (drives row layout).
    pub fn any(&self) -> bool {
        self.size_in_strip || self.size.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ws(extra: serde_json::Value) -> Workspace {
        let mut v = json!({
            "id": "w1", "name": "n", "repoPath": "/r", "worktreePath": "/w",
            "branch": "b", "baseBranch": "master", "status": "idle",
            "createdAt": 1_752_800_000_000_u64, "agent": "claude",
        });
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    fn pr(number: u64, state: &str) -> PrInfo {
        serde_json::from_value(json!({
            "url": format!("https://github.com/x/y/pull/{number}"),
            "number": number, "state": state, "title": format!("PR {number}"),
        }))
        .unwrap()
    }

    fn prs(list: Vec<PrInfo>) -> PrsForBranch {
        let merged_count = list.iter().filter(|p| p.state == PrState::Merged).count() as u64;
        PrsForBranch {
            all: list,
            open: None,
            latest: None,
            merged_count,
        }
    }

    #[test]
    fn format_bytes_matches_ts() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(2_800_000_000), "2.6 GB");
        assert_eq!(format_bytes(52_428_800), "50 MB");
    }

    #[test]
    fn format_tokens_matches_ts() {
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(41_679), "42k");
        assert_eq!(format_tokens(9_400), "9.4k");
        assert_eq!(format_tokens(1_240_000), "1.2M");
        assert_eq!(format_tokens(15_000_000), "15M");
    }

    #[test]
    fn prs_order_open_first_cap_three() {
        let record = prs(vec![
            pr(4, "MERGED"),
            pr(3, "CLOSED"),
            pr(2, "OPEN"),
            pr(1, "MERGED"),
        ]);
        let (visible, hidden) = ordered_visible_prs(Some(&record));
        let nums: Vec<u64> = visible.iter().map(|p| p.number).collect();
        // OPEN pulls ahead; the rest keep newest-first relative order.
        assert_eq!(nums, vec![2, 4, 3]);
        assert_eq!(hidden, 1);
        assert_eq!(ordered_visible_prs(None), (vec![], 0));
    }

    #[test]
    fn merged_pill_suppressed_by_merged_pr_badge_and_divergence() {
        let w = ws(json!({"mergedAt": 1}));
        assert!(row_pills(&w, None, None, None, None, false).merged);
        let diverged = ws(json!({"mergedAt": 1, "divergedFromBase": true}));
        assert!(!row_pills(&diverged, None, None, None, None, false).merged);
        let with_merged_pr = prs(vec![pr(9, "MERGED")]);
        assert!(!row_pills(&w, None, None, Some(&with_merged_pr), None, false).merged);
        // A merged PR beyond the 3-cap doesn't suppress the pill.
        let hidden_merged = prs(vec![
            pr(1, "OPEN"),
            pr(2, "OPEN"),
            pr(3, "OPEN"),
            pr(4, "MERGED"),
        ]);
        assert!(row_pills(&w, None, None, Some(&hidden_merged), None, false).merged);
    }

    #[test]
    fn released_fallback_chain() {
        let multi = ws(
            json!({"releasedAt": 1, "releasedVersions": ["0.5.1", "0.5.2"], "releasedVersion": "0.5.0"}),
        );
        assert_eq!(
            row_pills(&multi, None, None, None, None, false).released,
            Some(vec!["0.5.1".into(), "0.5.2".into()])
        );
        let single = ws(json!({"releasedAt": 1, "releasedVersion": "0.5.0"}));
        assert_eq!(
            row_pills(&single, None, None, None, None, false).released,
            Some(vec!["0.5.0".into()])
        );
        let bare = ws(json!({"releasedAt": 1}));
        assert_eq!(
            row_pills(&bare, None, None, None, None, false).released,
            Some(vec![])
        );
        let none = ws(json!({}));
        assert_eq!(
            row_pills(&none, None, None, None, None, false).released,
            None
        );
    }

    #[test]
    fn size_badge_threshold_and_placement() {
        let w = ws(json!({}));
        // Below 50 MB: no badge at all on active rows.
        let p = row_pills(&w, None, Some(10 * 1024 * 1024), None, None, false);
        assert_eq!(p.size, None);
        // Above threshold, empty strip: inline on the name row.
        let p = row_pills(&w, None, Some(60 * 1024 * 1024), None, None, false);
        assert_eq!(p.size, Some(60 * 1024 * 1024));
        assert!(!p.size_in_strip);
        // Above threshold with pills: rides the strip's right edge.
        let merged = ws(json!({"mergedAt": 1}));
        let p = row_pills(&merged, None, Some(60 * 1024 * 1024), None, None, false);
        assert!(p.size_in_strip);
    }

    #[test]
    fn diff_pill_needs_actual_changes() {
        let w = ws(json!({}));
        let empty = DiffStats {
            additions: 0,
            deletions: 0,
            files: 0,
        };
        assert_eq!(
            row_pills(&w, Some(&empty), None, None, None, false).diff,
            None
        );
        let some = DiffStats {
            additions: 3,
            deletions: 1,
            files: 2,
        };
        assert!(row_pills(&w, Some(&some), None, None, None, false)
            .diff
            .is_some());
    }

    #[test]
    fn setup_pill_only_for_failed_or_running() {
        for (status, expect) in [
            ("ok", false),
            ("pending", false),
            ("running", true),
            ("failed", true),
        ] {
            let w = ws(json!({"setupStatus": status}));
            assert_eq!(
                row_pills(&w, None, None, None, None, false).setup.is_some(),
                expect,
                "{status}"
            );
        }
    }
}
