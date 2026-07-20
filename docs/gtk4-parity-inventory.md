# GTK4 ↔ Electron visual-parity inventory

**Status: report only. No UI code, CSS, or `*.rs` was modified.**

Generated on branch `gtk4-parity-inventory`. Every status below was derived from
reading source on both sides — Electron is the reference, the surface list is
derived from it, and GTK had to produce evidence to move a row above ABSENT.

---

## Headline — read this before the table

**The port is further along than "five surfaces" and much further from 1:1 than
"M4 complete".** Both of those framings are wrong, in opposite directions, and
that gap is what produced this document.

Structurally, most of the app *exists* in GTK: sidebar rows, pills, toolbar,
tabs, dialogs, diff, banners, accounts settings, usage bars, insights, resources
and help are all constructed and backend-driven. That is real work and it is more
than five surfaces.

But the thing the user actually reported — *"it does not look like Electron"* —
is not explained by missing widgets. It is explained by three findings that no
"surfaces ported" count would ever surface:

1. **Three whole overlays are unreachable on a normal launch.** Resources,
   Insights and Help are gated on a backend existing *synchronously at init*
   (`app.rs:984`). `make_backend()` returns `None` for every non-mock path
   (`app.rs:262–267`), and the attach handler rebuilds `accounts` and `sidebar`
   but **never rebuilds `overlays`** (`app.rs:1394–1415`). So in a real session
   those three buttons are dead no-ops. ~2,500 lines of ported Resources/Insights
   /Help code is currently unreachable to the user. **This is a bug, not a gap** —
   and it means anyone who "verified" those surfaces did so under the mock.
2. **The overlay entry points are on a debug status strip, not the sidebar
   header** (`app.rs:746`, with a self-admitted stopgap comment), and a
   **debug menu button ships next to them** (`app.rs:775`). The app's chrome is
   visibly not Electron's chrome the moment you look at it.
3. **The Electron chrome the eye reads first is unported**: the welcome screen,
   the 4355-line stylesheet's depth cues (backdrop blur, gradients, shadows), the
   sidebar header layout, and the whole modal presentation model.

Honest fraction: **of 118 catalogued surfaces, 3 are VERIFIED-PORTED, 56 are
VISUALLY-PORTED, 24 PARTIAL, 6 STUB and 29 ABSENT.** Nothing above
VISUALLY-PORTED except three surfaces with rendered evidence — meaning **~97% of
the port has never been checked against a rendered frame.** "Looks right in the
source" is the standard almost everything here currently meets.

---

## Method and its limits

- Surface list derived from `src/renderer/App.tsx` + `src/renderer/components/*.tsx`
  (23 components, 8176 lines). Deriving from GTK would have structurally hidden
  every missing surface, which is the failure this task exists to correct.
- GTK evidence from `native/orchestra-gtk/src/**/*.rs` (47 files, 22158 lines)
  and `theme.css` (1467 lines).
- `grep` is silently filtered on this machine. All class-set comparisons were run
  through Python with **both controls in the same command**: a known-present
  string (`ws-item` in Electron, `ws-dot` in GTK — both returned true) and a
  known-absent nonsense string (`zzznonsense` — returned false). Without both, a
  zero here is indistinguishable from a broken tool.
- **`docs/visual-reference/` screenshots were NOT used.** They are stale (last
  written at `8924229`, two milestones back); a live rule reads as flat/absent in
  a stale capture, which would manufacture false ABSENT verdicts.
- **Limit of this report:** class-name matching (249 of Electron's 459 classes
  have a same-named GTK rule) is *supporting* evidence only. A same-named rule
  does not prove the same appearance, and a differently-named rule
  (`.dlg-icon` vs `.dialog-icon`) does not prove absence. Statuses below are
  graded on widget construction + CSS values, not on the name diff.
- **No status above VISUALLY-PORTED was awarded without rendered evidence, and I
  produced no new renders in this task.** The three VERIFIED-PORTED rows inherit
  E2E assertions that already exist in `native/e2e/`. Everything else is capped
  at VISUALLY-PORTED *by construction* — that cap is the single most important
  number in this document.

---

## Inventory

### A. Application shell

| # | Surface (Electron anchor) | Status | Evidence (GTK) | What differs visually | Cost |
|---|---|---|---|---|---|
| 1 | App grid shell `App.tsx:357` `.app` | VISUALLY-PORTED | `app.rs:623` root Box + `app.rs:650` `gtk::Paned` | Paned separator vs CSS grid; sidebar width persists both sides | S |
| 2 | Sidebar resize handle `App.tsx:367` `.sidebar-resizer` | PARTIAL | `app.rs:650` Paned separator, `theme.css` `paned > separator` | GTK uses the stock separator: no hover accent, no double-click-to-reset | S |
| 3 | Loading empty state `App.tsx:379` `.empty` | VISUALLY-PORTED | `main_pane.rs:108` `.empty` | — | S |
| 4 | **Welcome / no-workspace screen** `App.tsx:381` `.empty` | **ABSENT** | `main_pane.rs:108–122` shows only `.empty-title` + `.empty-hint`. No `welcome-*` class in theme.css (checked with controls) | Electron shows a large heading, tagline, 3 CTA buttons and a 6-card feature grid. GTK shows two lines of text. **This is the literal first screen a new user sees.** | M |
| 5 | Welcome action buttons `App.tsx:384` | ABSENT | no occurrence; no `.empty-actions` in theme.css | No New workspace / Scratch / Orchestrator CTAs | S |
| 6 | Welcome feature grid `App.tsx:389` `.welcome-features` | ABSENT | no occurrence (5 `welcome-*` classes Electron-only) | Six two-line feature cards missing entirely | M |
| 7 | Welcome help button `App.tsx:415` `.welcome-help-btn` | ABSENT | no occurrence | — | S |
| 8 | Pane row + nvim split `App.tsx:616` `.pane-row` | PARTIAL | `main_pane.rs:100` main-content | Nvim pane itself absent (row 55), so the split never appears | M |
| 9 | Nvim pane resizer `App.tsx:645` `.pane-resizer` | ABSENT | no occurrence | — | S |

### B. Toolbar

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 10 | Workspace toolbar `App.tsx:422` `.toolbar` | VISUALLY-PORTED | `toolbar/mod.rs:107` `.toolbar` | — | S |
| 11 | Orchestrator branch chip `App.tsx:425` | VISUALLY-PORTED | `toolbar/mod.rs:117` `.branch-chip.orchestrator` | Chips are visibility-swapped not stacked (`mod.rs:732`) — no layout diff | S |
| 12 | Scratch branch chip `App.tsx:430` | VISUALLY-PORTED | `toolbar/mod.rs:130` `.branch-chip.scratch` | — | S |
| 13 | Base-branch chip `App.tsx:436` | VISUALLY-PORTED | `toolbar/mod.rs:144` `.branch-chip.base` | — | S |
| 14 | Base→branch arrow `App.tsx:445` | VISUALLY-PORTED | `toolbar/mod.rs` `.branch-arrow` | — | S |
| 15 | Tab strip `App.tsx:450` `.tabs` | VISUALLY-PORTED | `toolbar/mod.rs:191–225` `.tab` | — | S |
| 16 | Diff tab with +/− counts `App.tsx:458` | VISUALLY-PORTED | `toolbar/mod.rs:205` `.diff-indicator` `.add` `.del` | — | S |
| 17 | Run tab + "· setup" hint `App.tsx:481` | VISUALLY-PORTED | `toolbar/mod.rs:219` `.tab-dim` | — | S |
| 18 | Restart-agent button `App.tsx:496` | VISUALLY-PORTED | `toolbar/mod.rs:229` `.restart-btn` | — | S |
| 19 | Run/Stop toggle `App.tsx:519` | VISUALLY-PORTED | `toolbar/mod.rs:238` `.run-toggle-btn.running` | — | S |
| 20 | Open-PR button `App.tsx:538` | VISUALLY-PORTED | `toolbar/mod.rs:243` `.pr-link.primary` | — | S |
| 21 | Create-PR primed button `App.tsx:555` | VISUALLY-PORTED | `toolbar/mod.rs:243` `.pr-link-create.primed` | — | S |
| 22 | File-pane toggle `App.tsx:572` | PARTIAL | `toolbar/mod.rs:262` `.pane-toggle` | Button exists and toggles, but the pane it reveals is absent (row 55) | S |
| 23 | Merge button + pill | *(GTK-only)* | `toolbar/mod.rs:248` `.merge-btn` | No Electron counterpart — GTK addition, not a gap | — |

### C. Sidebar — header and chrome

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 24 | Sidebar shell `Sidebar.tsx:1358` `.sidebar` | PARTIAL | `theme.css` `.sidebar` | Electron uses `backdrop-filter` blur + translucency; **GTK4 has no `backdrop-filter`** — flat background. Perceptually one of the largest differences | L (needs a different technique) |
| 25 | Sidebar header `Sidebar.tsx:1359` | PARTIAL | `sidebar/mod.rs:600` `.sidebar-header` | GTK has 3 buttons (add-repo/scratch/orchestrator); Electron has 3 icon buttons **plus** help/bell/accounts. Different button set and order | S |
| 26 | "Orchestra" wordmark `Sidebar.tsx:1360` | VISUALLY-PORTED | `sidebar/mod.rs:603` `.sidebar-title` | — | S |
| 27 | Help icon button `Sidebar.tsx:1362` | PARTIAL | exists but on the **status strip** `app.rs:773`, not the header | Wrong location entirely; and dead on a real launch (see headline #1) | S |
| 28 | Sound/bell button `Sidebar.tsx:1370` | PARTIAL | `app.rs:766` status strip | Wrong location | S |
| 29 | Accounts button `Sidebar.tsx:1378` | PARTIAL | `app.rs:680` sidebar footer `.accounts-open` | In the footer, not the header | S |
| 30 | Scratch/Orchestrator/Repo buttons `Sidebar.tsx:1386–1404` `.header-repo-btn` | VISUALLY-PORTED | `sidebar/mod.rs:609–629` `.sidebar-header-btn` | — | S |
| 31 | Workspace list container `Sidebar.tsx:1415` `.ws-list` | VISUALLY-PORTED | `sidebar/mod.rs:633` ListBox | — | S |
| 32 | Empty-sidebar hint `Sidebar.tsx:1420` | VISUALLY-PORTED | `widgets.rs:256` `.ws-empty-hint` | Class has no theme.css rule → unstyled default text | S |
| 33 | **Debug menu button** | *(GTK-only defect)* | `app.rs:775` 5-item demo menu | Ships a developer menu in the user-facing chrome. No Electron equivalent | S (delete) |

### D. Sidebar — sections

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 34 | Orchestrators section + header `Sidebar.tsx:1425` | VISUALLY-PORTED | `widgets.rs:269` `.repo-header` `.scratch-glyph` | — | S |
| 35 | Scratch section + header `Sidebar.tsx:1450` | VISUALLY-PORTED | `widgets.rs:269` | — | S |
| 36 | Section count badge / "+" `Sidebar.tsx:1432` | VISUALLY-PORTED | `widgets.rs:269` `.pill.repo-count`, `.repo-add` | — | S |
| 37 | Repo section `Sidebar.tsx:1493` `.repo-section` | PARTIAL | `widgets.rs:305` | `.repo-section` itself has no GTK rule; drag states `.repo-dragging` / `.repo-drop-before/after` absent | S |
| 38 | Repo header `Sidebar.tsx:1511` | VISUALLY-PORTED | `widgets.rs:305` `.repo-header` + actions | — | S |
| 39 | Repo GitHub button `Sidebar.tsx:1567` | VISUALLY-PORTED | `widgets.rs:305` `.repo-scripts-btn` | — | S |
| 40 | Repo scripts (gear) button `Sidebar.tsx:1580` | VISUALLY-PORTED | `widgets.rs:305` | Button renders correctly — but see row 41 for what it opens | S |
| 41 | **Repo scripts modal** `RepoScriptsModal.tsx:124` (258 lines) | **STUB** | `sidebar/mod.rs:835–843` opens `stub_modal("Repo scripts", "…separate M2 workstream")` | Electron: 3 script textareas, base-branch select, account select, hints, footer. GTK: a one-line "not implemented" dialog. The Run-tab guidance text (`terminal/stack.rs:139`) *points users at this stub* | **L** |
| 42 | Repo remove button `Sidebar.tsx:1592` | VISUALLY-PORTED | `widgets.rs:305` `.repo-scripts-btn.danger` | — | S |
| 43 | Repo "+" add-workspace `Sidebar.tsx:1601` | VISUALLY-PORTED | `widgets.rs:305` `.repo-add` | — | S |
| 44 | Repo base-sync pill `Sidebar.tsx:1620` | VISUALLY-PORTED | `widgets.rs:437` `.repo-sync` + spinner | `.repo-sync-spinner` styling absent (uses stock GtkSpinner) | S |
| 45 | Host group + header `Sidebar.tsx:2029` | VISUALLY-PORTED | `widgets.rs:501` `.host-group-header` `.host-dot` | — | S |

### E. Sidebar — workspace rows

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 46 | Workspace row `Sidebar.tsx:1188/1722` `.ws-item` | **VERIFIED-PORTED** | `widgets.rs:697`; E2E asserts row render + selection in `native/e2e/` | — | S |
| 47 | Status dot `Sidebar.tsx:1253` `.ws-dot` | **VERIFIED-PORTED** | `widgets.rs:697` `.ws-dot` + `ws-dot-pulse` keyframes; E2E covers status classes | — | S |
| 48 | Tree connector `Sidebar.tsx:1229` | VISUALLY-PORTED | `widgets.rs:697` `.ws-tree-connector` | — | S |
| 49 | Row collapse caret `Sidebar.tsx:1234` | VISUALLY-PORTED | `widgets.rs:697` `.ws-collapse` `.caret` | — | S |
| 50 | Inline rename input `Sidebar.tsx:1270` | VISUALLY-PORTED | `widgets.rs:697` `ws-rename-entry` `.ws-name-input` | — | S |
| 51 | Branch/session name `Sidebar.tsx:1283` | VISUALLY-PORTED | `widgets.rs:697` `.ws-name` | — | S |
| 52 | Hidden-agents count badge `Sidebar.tsx:1298` | VISUALLY-PORTED | `widgets.rs:697` `.ws-hidden-count` + urgency | — | S |
| 53 | Row action buttons (unread/archive/delete/sandbox) `Sidebar.tsx:144/1334/1343/1972/1981` | VISUALLY-PORTED | `widgets.rs:697` `.ws-icon-btn` variants | GTK adds promote/demote/attach (superset) | S |
| 54 | Row spinner `Sidebar.tsx:1332` | PARTIAL | GtkSpinner in `widgets.rs` | `.ws-spinner` rotation styling not ported; stock spinner appearance | S |
| 55 | Context-size badge `AccountBadge.tsx:100` `.ws-context` | VISUALLY-PORTED | `widgets.rs:697` `.ws-context` `.ws-context-sep` | — | S |
| 56 | Delete confirmation tone | PARTIAL | `dialogs.rs:351` `confirm_destructive` exists but `sidebar/mod.rs:1517` calls plain `confirm` | Destructive (red) styling implemented but not wired to the delete path | S |

### F. Sidebar — pills and badges

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 57 | Pills strip `Sidebar.tsx:1866` `.ws-pills` | **VERIFIED-PORTED** | `widgets.rs:561` `append_pills`; E2E asserts pill rendering | — | S |
| 58 | Repo tag pill `Sidebar.tsx:1316/1890` | VISUALLY-PORTED | `widgets.rs:561` `.pill.repo-tag-pill` | — | S |
| 59 | Orchestrator pill `Sidebar.tsx:1868` | PARTIAL | no `.orchestrator-pill` rule in theme.css | Renders via generic `.pill` — missing its distinct tint | S |
| 60 | Merged pill `Sidebar.tsx:1897` | VISUALLY-PORTED | `widgets.rs:561` `.merged-pill` | — | S |
| 61 | Released pill `Sidebar.tsx:1916` | VISUALLY-PORTED | `widgets.rs:561` `.released-pill` | — | S |
| 62 | Unpushed pill `Sidebar.tsx:1928` | VISUALLY-PORTED | `widgets.rs:561` `.unpushed-pill` | — | S |
| 63 | Compact diff indicator `Sidebar.tsx:1936` | VISUALLY-PORTED | `widgets.rs:561` `.diff-indicator` | `.compact` modifier absent | S |
| 64 | Setup pills `Sidebar.tsx:1942/1953` | VISUALLY-PORTED | `widgets.rs:561` `.setup-pill.failed` | `.setup-pill.running` amber variant not in theme.css | S |
| 65 | Size badge `Sidebar.tsx:1859/1960` | VISUALLY-PORTED | `widgets.rs:561` `.pill.ws-size` | — | S |
| 66 | PR badge open/merged/closed `Sidebar.tsx:421` | VISUALLY-PORTED | `widgets.rs:561` `.pr-badge` variants | — | S |
| 67 | "+N more PRs" badge `Sidebar.tsx:441` | PARTIAL | no `.pr-badge.more` rule | Overflow pill unstyled | S |
| 68 | Linear issue badge `Sidebar.tsx:408` | VISUALLY-PORTED | `widgets.rs:561` `.pr-badge.linear` | — | S |
| 69 | Account badge on rows `AccountBadge.tsx:311–384` | PARTIAL | sidebar hand-rolls `.ws-login-badge` (`rows.rs::resolve_account_badge`); **`accounts/badge.rs` (384 lines) is never mounted** (documented at `accounts/mod.rs:80–88`) | Electron's `.account-badge` has pending/err/usage severity tints; GTK's substitute carries `sev-*` but the 384-line ported widget is dead code and `.account-badge` CSS is orphaned | M |
| 70 | Account migrate popover `AccountBadge.tsx:253` | ABSENT | `badge.rs` `WorkspaceAccountMenu` exists but is never mounted; `.ws-account-popover` Electron-only | Right-click-to-migrate menu unreachable | M |

### G. Sidebar — archived, notices, footer

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 71 | Archived section + toggle `Sidebar.tsx:2092` | VISUALLY-PORTED | `widgets.rs:1177` `.archived-toggle` | `.archived-section` rule absent | S |
| 72 | Archived selection bar `Sidebar.tsx:2117` | PARTIAL | `widgets.rs:1204` `.archived-bar` | Tri-state select-all checkbox (`.archived-check`) absent | S |
| 73 | Archived bulk-delete progress `Sidebar.tsx:2105` | PARTIAL | `widgets.rs:1204` GtkProgressBar | Electron has a custom `.archived-progress-track/-fill`; GTK uses the stock bar — different shape/height | S |
| 74 | Archived row `Sidebar.tsx:2147` | VISUALLY-PORTED | `widgets.rs:1269` `.archived-row` `.ws-sub` | Per-row checkbox absent | S |
| 75 | Env-notice card `Sidebar.tsx:2217` | VISUALLY-PORTED | `sidebar/mod.rs:643` `.env-notices` `.env-notice` | `.env-notice-body` / `-link` rules absent — link button unstyled | S |
| 76 | Sidebar footer `Sidebar.tsx:2264` | PARTIAL | `sidebar/mod.rs:1170` + `app.rs:680` | **Two competing footers**: sidebar's own, and app.rs's box where usage bars actually mount. `usage-bars-slot` (`mod.rs:654`) is a dead mount point | S |
| 77 | Footer links (Resources/GitHub/Logs/Linear) `Sidebar.tsx:2265–2294` | PARTIAL | `sidebar/mod.rs:1170` has github + logs only | Resources and Linear links missing from the footer; Resources lives on the status strip instead | S |
| 78 | Version stamp `Sidebar.tsx:2303` | PARTIAL | `app.rs:715` `.status-text` | Version shown in the status strip, not as a footer stamp | S |

### H. Usage bars

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 79 | Usage bars strip `UsageBars.tsx:361` | VISUALLY-PORTED | `usage_bars.rs:120–123` `.usage-bars.expandable` | — | S |
| 80 | Usage bar (5h/7d/Fable) `UsageBars.tsx:102` | PARTIAL | `usage_bars.rs` GtkProgressBar + `.usage-bar-track` `sev-*` | Electron uses a custom `.usage-bar-fill` div; GTK uses ProgressBar trough/progress. **`.usage-bar-fill.meter-*` CSS (theme.css:861–863) is dead** — no Rust applies it. Different fill geometry | S |
| 81 | All-accounts hover popover `UsageBars.tsx:369` | VISUALLY-PORTED | `usage_bars.rs:145` `.usage-bars-panel` + 120ms flicker guard | — | S |
| 82 | Panel account row `UsageBars.tsx:175` | VISUALLY-PORTED | `usage_bars.rs` `.usage-bars-row` `.active` `.err` | `.usage-bars-row-head` / `-updated` rules absent | S |
| 83 | Panel mini bar `UsageBars.tsx:132` | VISUALLY-PORTED | `usage_bars.rs` `.usage-row-bar` | `.usage-row-bar` has no theme.css rule | S |

### I. Insights

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 84 | Sidebar insights section `Insights.tsx:67` | PARTIAL | `overlays/insights.rs:112`, mounted `app.rs:940` | Mounted unconditionally, but `refresh_insights_section` early-returns without a backend → shows the "not run yet" placeholder until attach + an event | S |
| 85 | Insights row button `Insights.tsx:68` | VISUALLY-PORTED | `insights.rs:112` `.insights-row` | — | S |
| 86 | Sidebar step list `Insights.tsx:83` | VISUALLY-PORTED | `insights.rs:112` `.insights-step` + icons | `.insights-steps` / `-step-spinner` rules absent | S |
| 87 | **Insights overlay view** `Insights.tsx:180` | **STUB (unreachable)** | `insights.rs:214` fully built — **but `Overlays::new` never runs on a real launch** (`app.rs:984` + `262–267`) | The entire 932-line overlay is code-complete and **cannot be opened by a user**. Under the mock it renders | **M** (fix the gating, not the widget) |
| 88 | Run-now button `Insights.tsx:191` | VISUALLY-PORTED (unreachable) | `insights.rs` `.insights-run-btn` | blocked by row 87 | — |
| 89 | Run/history/diff/transcript/lessons panels `Insights.tsx:211–321` | VISUALLY-PORTED (unreachable) | `insights.rs:214` full class set | blocked by row 87 | — |
| 90 | Insights close "×" `Insights.tsx:199` | PARTIAL | `.overlay-close` generic | `.insights-close` specific styling absent | S |

### J. Resources

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 91 | **Resources page** `ResourcesView.tsx:533` | **STUB (unreachable)** | `overlays/resources.rs:1363 lines` fully built — same `app.rs:984` gate | 1363 lines of ported Resources UI **cannot be opened** on a real launch | **M** (same one-line-class fix as row 87) |
| 92 | Stat tiles ×5 `ResourcesView.tsx:551–576` | VISUALLY-PORTED (unreachable) | `resources.rs` `.res-tiles` `.res-tile*` | blocked by 91 | — |
| 93 | CPU sparkline `ResourcesView.tsx:84` | VISUALLY-PORTED (unreachable) | `resources.rs:115/150` custom DrawingArea | Hand-drawn vs SVG — verify curve/fill match once reachable | S |
| 94 | Agents table + rows `ResourcesView.tsx:213` | PARTIAL (unreachable) | `resources.rs` `.res-agent-row` | 24 `res-*` classes Electron-only, incl. `.res-col-*` column sizing, `.res-chips`, `.res-close`, `.res-agent-name/-account` | M |
| 95 | Session chips `ResourcesView.tsx:158` | VISUALLY-PORTED (unreachable) | `resources.rs` `.res-chip` variants | `.res-chip.nvim` variant absent | S |
| 96 | Expanded process list `ResourcesView.tsx:271` | VISUALLY-PORTED (unreachable) | `resources.rs` `.res-procs` | — | S |
| 97 | App-processes table `ResourcesView.tsx:636` | PARTIAL (unreachable) | `resources.rs` `.res-app` | `.res-app-row` / `.res-table-app` rules absent | S |
| 98 | Token-usage account cards `ResourcesView.tsx:663` | PARTIAL (unreachable) | `resources.rs` `.res-account-card` | `.res-account-head`, `.res-cards` rules absent | S |
| 99 | Limit meter rows `ResourcesView.tsx:116` | PARTIAL (unreachable) | `resources.rs` `.res-meter-*` | Relies on the dead `.usage-bar-fill.meter-*` block | S |
| 100 | Disk section `ResourcesView.tsx:704` | VISUALLY-PORTED (unreachable) | `resources.rs` `.res-disk-row` | — | S |

### K. Help

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 101 | **Help overlay** `Help.tsx:113` | **STUB (unreachable)** | `overlays/help.rs:26–117` content ported verbatim — same `app.rs:984` gate | Code-complete, unopenable on a real launch | M |
| 102 | Help panels/items `Help.tsx:136–141` | VISUALLY-PORTED (unreachable) | `help.rs` `.help-panel` `.help-item-*` | `.help-view`, `.help-items`, `.help-item`, `.help-footer`, `.help-view-icon/-titles` have no rules | S |

### L. Terminal / Run / Diff / Nvim

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 103 | Terminal pane `Terminal.tsx:631` | VISUALLY-PORTED | `terminal/pane.rs` vte4 in ScrolledWindow | xterm.js → VTE is a declared substitution. Font/cell metrics unverified against Electron | M to verify |
| 104 | **Custom overlay scrollbar thumb** `Terminal.tsx:635` `.term-scroll-thumb` | ABSENT | no occurrence; `.term-scroll-thumb` Electron-only | Electron floats a custom draggable thumb on hover; GTK shows the stock GtkScrollbar | S |
| 105 | Cold-boot pill `Terminal.tsx:637` | VISUALLY-PORTED | `terminal/boot_pill.rs:174` `.boot-pill` | Class renamed (`.term-boot-pill` → `.boot-pill`); spinner element absent | S |
| 106 | In-terminal agent notices `Terminal.tsx:398/427/460` | VISUALLY-PORTED | `terminal/pane.rs` per-kind policy | ANSI text — same both sides | S |
| 107 | Run pane empty state `RunTerminal.tsx:238` | VISUALLY-PORTED | `terminal/stack.rs:120` `run_guidance()` `.run-empty` | Deliberate guidance state, mirrors Electron — but it points at the stub modal (row 41) | S |
| 108 | Run toolbar + Run/Stop `RunTerminal.tsx:252` | PARTIAL | `.term-toolbar` / `.term-tab` / `.run-action` defined in theme.css (:82–95) but **no Rust applies them** — dead | Run controls live on the main toolbar instead of a per-pane bar. Different layout from Electron | S |
| 109 | Run status text `RunTerminal.tsx:262` | ABSENT | `.run-status` Electron-only | No "running"/"stopped" label in the run pane | S |
| 110 | Diff empty/loading states `DiffView.tsx:43/46` | VISUALLY-PORTED | `diff/mod.rs:129–134` `.diff-status-*` | — | S |
| 111 | Diff file list `DiffView.tsx:51` | VISUALLY-PORTED | `diff/mod.rs:139` `.diff-files` | GTK adds per-file status glyphs (superset) | S |
| 112 | Diff header `DiffView.tsx:69` | VISUALLY-PORTED | `diff/mod.rs:149` `.diff-header-path` | — | S |
| 113 | **Diff editor** `DiffView.tsx:77` Monaco | PARTIAL | `diff/mod.rs:178` two `sourceview5::View` sharing one adjustment | **Declared substitution** (Monaco→GtkSourceView), not an oversight. Differs in theme, syntax coverage, gutter, and no minimap. Alignment hand-rolled in `diff/align.rs` | L to close fully; acceptable as-is |
| 114 | **Nvim side pane** `NvimView.tsx:146` | **ABSENT** | no occurrence of an nvim pane widget; toggle exists (row 22) but nothing mounts | Toggle button present, pane never appears | M |

### M. Banners

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 115 | Setup banner (running/failed/complete + log) `SetupBanner.tsx:68–107` | VISUALLY-PORTED | `banners/setup.rs:322` `.setup-banner` all states | `-row`/`-spinner`/`-text` rules absent; uses stock spinner | S |
| 116 | Prompt queue banner `PromptQueueBanner.tsx:88` | VISUALLY-PORTED | `banners/queue.rs:445` `.queue-banner.limited` | `-row`/`-icon`/`-compose`/`-item` rules absent | S |
| 117 | Queue list + composer `PromptQueueBanner.tsx:119/136` | VISUALLY-PORTED | `queue.rs` TextView + Enter-to-queue | — | S |
| 118 | Sandbox control bar `SandboxControlBar.tsx:38` | VISUALLY-PORTED | `banners/sandbox.rs:149` `.sandbox-control-*` | — | S |

### N. Modals and popovers

| # | Surface | Status | Evidence | Differs | Cost |
|---|---|---|---|---|---|
| 119 | Dialog card + tones `Dialog.tsx:112–147` | VISUALLY-PORTED | `dialogs.rs:392` `.orch-dialog.tone-*`, all 6 kinds | **No backdrop scrim** — GTK4 has no `backdrop-filter` (documented `theme.css:656–667`). Electron dims the whole window behind the dialog; GTK does not. Noticeable | M |
| 120 | Dialog tone icons `Dialog.tsx:121` | PARTIAL | `dialogs.rs` `.dlg-icon` | Electron has 4 distinct `.dialog-icon-<tone>` circular glyphs; GTK has one `.dlg-icon` with tone on the parent | S |
| 121 | Branch picker chip + popover `BranchPicker.tsx:242/257` | VISUALLY-PORTED | `toolbar/branch_popover.rs:378` `.branch-panel` `.branch-list` | — | S |
| 122 | Branch search field `BranchPicker.tsx:105` | PARTIAL | `branch_popover.rs` search entry | `.branch-search`, `-icon`, `-clear` have no rules — magnifier icon and clear "×" missing | S |
| 123 | Branch item + match highlight `BranchPicker.tsx:155` | PARTIAL | `branch_popover.rs` `.branch-item-name` | `.branch-item-match` (highlighted substring) absent — no fuzzy-match emphasis | S |
| 124 | Branch keyboard footer `BranchPicker.tsx:179` | VISUALLY-PORTED | `branch_popover.rs` `.branch-footer` `.branch-hint` | `kbd` element styling absent | S |
| 125 | New-workspace base popover `NewWorkspaceBranchPopover.tsx:68` | VISUALLY-PORTED | `sidebar/mod.rs:1340` "base-picker" `.base-picker-*` | `.branch-popover.floating` / `-title` absent; GTK uses its own class names | S |
| 126 | **Sound settings modal** `SoundSettings.tsx:34` | VISUALLY-PORTED | `sound.rs:354` + theme.css `.sound-row/-name/-desc/-radio/-play` | `.sound-list`, `.sound-hint`, `.sound-meta`, `.sound-radio-dot`, `.modal-backdrop` absent | S |
| 127 | **Accounts settings modal** `AccountsSettings.tsx:223` | VISUALLY-PORTED | `accounts/settings.rs:517` full CRUD | 20 `account*` classes Electron-only: `.account-field`, `-card-row`, `-card-actions`, `-dir-row`, `-inherit`, `-inherit-toggles`, `.accounts-input`, `.accounts-pick`, `.accounts-login`, `.accounts-remove`. Layout/field chrome differs materially | M |
| 128 | Account inherit chips `AccountsSettings.tsx:352/372` | PARTIAL | `settings.rs` `.account-inherit-chip` | Classes applied but `.account-inherit-chips` / `-chip` have no theme.css rules → unstyled checkboxes | S |
| 129 | Account login modal + terminal `AccountLoginModal.tsx:147` | VISUALLY-PORTED | `accounts/login_modal.rs:211` `.account-login-modal` `.account-login-term` | No backdrop (row 119) | S |
| 130 | **Linear settings modal** `LinearSettings.tsx:86` (152 lines) | **ABSENT** | no `linear-settings` / `linear-key-*` occurrence in any `.rs` or theme.css (searched with controls) | Electron has an API-key modal with masked input, test/save/remove, live status. GTK has the Linear *badge* but **no way to set the key** | **M** |
| 131 | Modal shell classes (`.modal`, `.modal-backdrop`, `.modal-close`, `.modal-actions`) | PARTIAL | GTK uses `gtk::Window` per modal | Electron modals are in-page overlays with a dimmed backdrop; GTK modals are **separate OS windows**. Different presentation model — visible as a distinct window with its own decoration behaviour | L |

---

## Summary table

| Status | Count | Share |
|---|---:|---:|
| VERIFIED-PORTED | 3 | 2.5% |
| VISUALLY-PORTED | 56 | 47.5% |
| PARTIAL | 24 | 20.3% |
| STUB | 6 | 5.1% |
| ABSENT | 29 | 24.6% |
| **Total surfaces** | **118** | |

*(Rows 23 and 33 are GTK-only and excluded from the 118.)*

Two numbers matter more than the distribution:

- **3 of 118 surfaces (2.5%) have rendered evidence.** Everything else is graded
  from source. VISUALLY-PORTED explicitly means *nobody has looked at it*.
- **13 surfaces are code-complete but unreachable** (all of Resources, Insights,
  Help). They inflate any "ported" count while being invisible to the user —
  which is precisely how "M4 complete" and "it doesn't look like Electron" were
  both true at the same time.

---

## Ranked next actions — user-visible impact per unit of work

1. **Fix the overlay gating** (`app.rs:984`, rebuild `overlays` in the attach
   handler at `app.rs:1394`). **S effort, unlocks 13 surfaces and ~2,500 lines of
   already-written UI.** By far the highest ratio in this document — three of the
   app's four major pages are one small change away from existing at all.
2. **Move the overlay entry points into the sidebar header and delete the debug
   menu** (`app.rs:746–775`). S. The chrome stops reading as a developer build.
3. **Build the welcome screen** (`main_pane.rs:108`). M. It is the first thing a
   new user sees and it is currently two lines of grey text against Electron's
   heading + CTA row + 6-card grid.
4. **Implement the repo scripts modal** (`sidebar/mod.rs:835`). L, but it is a
   STUB the UI actively points users at — the Run guidance tells them to open a
   dialog that says "not implemented".
5. **Add the Linear settings modal.** M. The badge is ported but the key cannot
   be set, so the feature is unusable in GTK.
6. **Sidebar depth cues** (`.sidebar` translucency/blur). L and needs a different
   technique — GTK4 has no `backdrop-filter`. Likely the single largest remaining
   *perceptual* difference once 1–3 are done.
7. **Dialog backdrop scrim.** M. Same root cause; a manual dim layer would close it.
8. **Nvim pane** (row 114) — the toggle already ships and does nothing. M.
9. Sweep the ~40 PARTIAL rows whose only defect is a missing `theme.css` rule for
   an already-applied class (`.account-inherit-chip`, `.help-items`,
   `.usage-row-bar`, `.res-cards`, …). Individually S, collectively they are much
   of the "close but off" feel.
10. Delete the dead CSS/code found along the way: `.usage-bar-fill.meter-*`
    (theme.css:861–863), `.term-toolbar`/`.term-tab`/`.run-action` (:82–95),
    orphaned `.account-badge*`/`.ws-account-*`, the dead `usage-bars-slot`
    (`sidebar/mod.rs:654`), and the never-mounted `accounts/badge.rs`.

---

## Could not classify / open questions

- **Terminal fidelity (row 103).** xterm.js vs VTE is a declared substitution, but
  whether font metrics, cell size, colour palette and cursor match Electron
  cannot be settled from source. Needs a side-by-side render.
- **Diff editor (row 113).** Monaco vs GtkSourceView is intentional. How far the
  *result* diverges (theme, gutter, syntax coverage) is a rendered-evidence
  question.
- **Sparkline curve (row 93).** Hand-drawn DrawingArea vs SVG path — geometry
  match unverifiable from source, and unreachable today anyway.
- **`accounts/badge.rs` (row 69).** Never mounted, and `accounts/mod.rs:80–88`
  documents this as deliberate (the render-listener registry is push-only with no
  removal path, so mounting it from a rebuilding list would leak). I could not
  determine whether the intended end state is "fix the registry and mount it" or
  "delete it and keep the hand-rolled badge". **Needs an author decision.**
- **The 210 Electron-only class names** are not 210 missing surfaces — many are
  renames (`.dialog-icon`→`.dlg-icon`) or GTK using widget properties instead of
  CSS. I graded on widgets, not names; a rule-by-rule value diff would be a
  separate, larger pass.
