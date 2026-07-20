#!/usr/bin/env python3
"""Build the coverage ledger honestly, per inventory row.

The brief said "58 surfaces"; rows 24-90 are actually 67, and 87-90 are the
Insights OVERLAY (another agent's region), so the sidebar region is 24-86 = 63.
Reporting a coverage fraction against a wrong denominator would misstate the
result in the flattering direction, so the denominator is derived here rather
than asserted.

COVERED = a verdict in the report backed by rendered evidence (pixels from a
composited frame, per-widget render bytes, or live-DOM ground truth).
NOT-COVERED = named individually in the report; no rendered evidence.
"""
import re

COVERED = {
    24: "sidebar shell — background dominance 81,200 samples (MATCH)",
    25: "sidebar header — rendered; duplicate CSS rule found (W1)",
    26: "Orchestra wordmark — .sidebar-title duplicated rule (W1)",
    29: "Accounts row — rendered in g-bottom.png (W8)",
    30: "header buttons — rendered in both captures",
    31: "workspace list container — sidebar-list 80,419 bytes",
    32: "empty-sidebar hint — GTK rule EXISTS, corrects D5 (MATCH)",
    33: "debug status strip — rendered, GTK-only (W8)",
    34: "orchestrators section+header — colour measured (W4)",
    35: "scratch section+header — colour measured (W4)",
    36: "section count badge — .pill.repo-count fill vs colour-only",
    37: "repo section — 0 GTK rules confirmed (drag states not reached)",
    38: "repo header — rendered, repo-row-orchestra 3196 bytes",
    39: "repo GitHub button — repo-github-orchestra 481 bytes",
    40: "repo scripts button — repo-scripts-* 602 bytes",
    42: "repo remove button — rendered in repo header row",
    43: "repo + add-workspace — repo-add-* 176 bytes",
    44: "repo base-sync pill — 1218-2131 bytes, 4 widgets w/ controls",
    46: "workspace row — 14 rows enumerated w/ classes; row crops",
    47: "status dot — matched-pair row crop (W9)",
    48: "tree connector — visible in both sidebar captures",
    51: "branch/session name — matched-pair row crop (W9)",
    52: "hidden-agents badge — 0 Electron instances (CANNOT-VERIFY, named)",
    55: "context-size badge — visible in rows (412k/85k/127k)",
    57: "pills strip — .ws-pills DOM rect 203px wide, rendered both",
    58: "repo tag pill — rendered (orchestra/mobile-club tags)",
    60: "merged pill — DOM rgba(179,139,255,0.12), matched row crop",
    61: "released pill — DATA-PATH bug isolated via listWorkspaces (W10)",
    64: "setup pills — composited, backdrop-guarded (W5)",
    65: "size badge — 0 Electron instances (CANNOT-VERIFY, named)",
    71: "archived toggle — archived-toggle 1645 bytes",
    75: "env-notice card — env-notices 15,768 bytes; rendered both",
    76: "sidebar footer — name collision x2 confirmed (W2)",
    77: "footer links — rendered text-only, no icons (W7)",
    78: "version stamp — CANNOT-VERIFY, clipping (named, with reason)",
    79: "usage bars strip — usage-bars 7647 bytes",
    80: "usage bar 5h/7d/Fable — rendered; .usage-bar-fill claim CORRECTED",
    81: "all-accounts popover — zero-alloc closed (CANNOT-VERIFY, named)",
    84: "sidebar insights section — insights-slot 3374 bytes",
    85: "insights row button — insights-row 2509 bytes, rendered",
    86: "sidebar step list — .insights-step 0 Electron instances (named)",
}
NOT_COVERED = {
    27: "Help icon button — on status strip, not header; not isolated",
    28: "Sound/bell button — on status strip; not isolated",
    41: "Repo scripts MODAL — stub dialog; opening it not driven",
    45: "Host group + host dot — sandbox rows below the fold",
    49: "Row collapse caret — in tree, not isolated in pixels",
    50: "Inline rename input — needs a rename drive step",
    53: "Row action buttons — hover-revealed states",
    54: "Row spinner — needs a transient-state workspace",
    56: "Delete confirmation tone — needs a destructive drive",
    59: "Orchestrator pill — 0 instances in fixture state",
    62: "Unpushed pill — 0 Electron instances in this state",
    63: "Compact diff indicator — 0 Electron instances",
    66: "PR badge open/merged/closed — 0 instances in fixture",
    67: "+N more PRs badge — 0 instances",
    68: "Linear issue badge — 0 instances",
    69: "Account badge on rows — .account-badge present; sev-* not exercised",
    70: "Account migrate popover — needs right-click",
    72: "Archived selection bar — below fold",
    73: "Archived bulk-delete progress — below fold",
    74: "Archived row — below fold",
    82: "Usage panel account row — inside closed popover",
    83: "Usage panel mini bar — inside closed popover",
}

rows = []
for line in open("/home/lmas/.orchestra/worktrees/orchestra-lunar-valley-aa2170d8/docs/gtk4-parity-inventory.md"):
    m = re.match(r"\|\s*(\d+)\s*\|(.+?)\|", line)
    if m and 24 <= int(m.group(1)) <= 86:
        rows.append((int(m.group(1)), m.group(2).strip()))

ids = {n for n, _ in rows}
cov, notcov = set(COVERED) & ids, set(NOT_COVERED) & ids
unclassified = ids - cov - notcov

print(f"REGION: inventory rows 24-86 = {len(ids)} surfaces")
print(f"  (rows 87-90 are the Insights OVERLAY — another agent's region)")
print(f"COVERED:      {len(cov)}")
print(f"NOT COVERED:  {len(notcov)}")
print(f"UNCLASSIFIED: {len(unclassified)}  {sorted(unclassified)}")
assert not unclassified, "every row must be classified — an omission is a finding"
print(f"\n=> {len(cov)} of {len(ids)} covered ({len(cov)/len(ids)*100:.0f}%)")
print("\nNOT COVERED, by name:")
for n in sorted(notcov):
    d = dict(rows)[n]
    print(f"  {n:3} {d[:52]:54} — {NOT_COVERED[n]}")
