# GTK4 Port — M3 Feature-Parity Audit

*2026-07-19. Audit of the §5 parity ledger in `docs/gtk4-port-plan.md`, comparing
the GTK app (`native/orchestra-gtk/`) against the Electron app (`src/renderer/`)
at integration tip `5ba7f08` (M2 COMPLETE, branch `gtk4-native-port`).*

**This document FILES gaps. It fixes nothing.** The coordinator triages; the
B-agents fix.

## How to read this

Per §0 of the plan, the standard is **behavioral parity, not pixel identity**.
The approved substitutions (xterm.js→VTE, Monaco→GtkSourceView,
Chromium-OAuth→WebKitGTK, WebAudio→GStreamer, CDP→remote-control) are *not*
gaps: a substitute that behaves the same is a MATCH, and a substitute that does
something the original could not is an IMPROVEMENT.

| Status | Meaning |
|---|---|
| **MATCH** | Behaviorally equivalent (substitutions allowed). |
| **PARTIAL** | Present but incomplete — the note says exactly what is missing. |
| **MISSING** | No implementation. Verified by grep for the relevant symbols, not assumed. |
| **DIVERGENT** | Implemented, behaves differently. Not always wrong — some are deliberate. |
| **IMPROVEMENT** | GTK deliberately does better than Electron. **Do not "fix" these back.** |

Every `file:line` was read, not inferred. Where a claim was load-bearing it was
independently re-verified at source by the auditor *and* by the coordinator of
this audit (noted inline as "re-verified").

### Verification performed

- **Static**: six parallel auditors, one per §5 subsection, each reading both
  sides in full.
- **Build**: `cargo build --all-targets` green on a rootless `.localdeps` prefix.
- **E2E**: `node native/e2e/run.mjs` → **3 passed, 0 failed, 2 skipped**
  (skips are the documented `backend-lock-mutual-exclusion` daemon-bundle case
  and the `coexistence-live-update` placeholder).
- **Live daemon**: `native/orchestra-gtk/scripts/sidebar_live_drive.sh` → **PASS**
  against a real `node dist-electron/daemon.js` in headless sway. Footer read
  `backend: daemon v0.5.84 · frontend v0.5.84`; a through-daemon `setUnread`
  re-rendered the row via the single-consumer fan-out.

The live screenshot (`native/target/live-drive/after.png`) visually corroborates
four filed gaps: **no Insights row** between the workspace list and the usage bars
(Insights appears only in the bottom status strip); **Resources / Insights / `?`
live in that bottom strip**, not the sidebar footer/header; the **Linear env
notice offers only a dismiss `×`**, no "Set API key…" action link; and VTE is
feeding real agent output with the version-lockstep footer correct.

*Caveat on one gap*: the badge in that screenshot reads `default` because the
seeded workspace has no `account_id`. The raw-UUID rendering is
`s.ws.account_id.as_deref().unwrap_or("default")` (`sidebar/widgets.rs:805`) —
verified **by code**, and reproducible live only with an account assigned.

---

## 5.1 Sidebar

| Feature | Electron ref | GTK ref | Status | Note |
|---|---|---|---|---|
| Section order (orchestrators → scratch → repos → archived) | `Sidebar.tsx:1325,1350,1375,1881` | `sidebar/rows.rs:366-485` | MATCH | Same four-section order in `compute_rows`; asserted `rows.rs:524-558`. |
| SpawnForest semantics, dangling-parent float, root-count badges | `Sidebar.tsx:476-503,556-566` | `sidebar/forest.rs:40-81,150-174` | MATCH | Cycle-guarded `root_of`; section badge counts trees, repo badge counts rows. |
| Subtree collapse + hidden-count pill tint + persist | `Sidebar.tsx:1093-1153,779-791` | `forest.rs:179-232`, `widgets.rs:646-670` | MATCH | Identical error>waiting>running ranking incl. `markedUnread`-as-waiting. |
| Host grouping (all-local ⇒ flat) | `Sidebar.tsx:1808-1841` | `sidebar/hosts.rs:11-74` | MATCH | `group_by_host` returns `None` when all-local, so the flat list is identical. |
| Status dot colors, unread accent, tool label, ctx badge | `Sidebar.tsx:1634-1647,1676` | `widgets.rs:674-682,796-802` | PARTIAL | Colors/accent/0-sentinel match; unread name lacks `font-weight:700` and the running dot has no pulse (`styles.css:1256` keyframes unported). |
| Row pills (merge-state, released, PR, Linear, size) | `Sidebar.tsx:1574-1583,1691-1769` | `sidebar/pills.rs:110-163` | MATCH | Thresholds, merged-pill suppression, PR open-first-cap-3 all ported + unit-tested. |
| Row actions (rename, unread, archive, delete, sandbox, account) | `Sidebar.tsx:798-1023` | `widgets.rs:691-735,878-968` | PARTIAL | All present **except the setup gear, which opens a stub alert** (`sidebar/mod.rs:727-735`) — RepoScriptsModal unreachable. |
| Drag-reorder workspaces and repos | `Sidebar.tsx:723-749,1590-1627` | `widgets.rs:109-177,990-1003` | PARTIAL | Full DnD + persist, but **omits Electron's same-repo restriction** (`Sidebar.tsx:1613`): cross-repo drops reorder instead of no-op'ing. |
| Repo header (sync pill, "+", gear) | `Sidebar.tsx:1412-1534` | `widgets.rs:242-372` | PARTIAL | Structure matches; sync tooltip says "Last synced Nm ago" vs Electron's wall clock (`Sidebar.tsx:1510`), and the base picker lacks `defaultBranch` emphasis. |
| Archived section (multi-select, bulk delete progress) | `Sidebar.tsx:1881-2002` | `rows.rs:457-485`, `widgets.rs:1007-1097` | PARTIAL | Selection + determinate progress match. Electron clears selection on collapse (`:855-857`); GTK does not. (Persistence is at parity — Electron's `archivedOpen` is also non-persisted `useState` at `:602`.) |
| New scratch / orchestrator / add-repo | `Sidebar.tsx:1287-1313` | `sidebar/mod.rs:501-521,1095-1109` | DIVERGENT | Scratch/orchestrator match. GTK's "+ Repo" opens a folder picker → `addRepo`; Electron's opens the new-workspace-from-repo modal. Same label, different destination. |
| Env notices (`getEnvStatus`) | `Sidebar.tsx:681-712,2004-2051` | `rows.rs:492-498`, `mod.rs:299-337` | PARTIAL | Filter + persisted dismissals match. **Missing the action links** ("Set API key…", "Get a key" `docsUrl`, `:2015-2037`) and the 60 s refresh — the notice reports a problem with no path to fix it. |
| Insights section row | `Sidebar.tsx:2052` | `overlays/insights.rs:112` (defined), `sidebar/mod.rs:543-545` (empty slot) | **MISSING** | Re-verified: `InsightsSection` has **zero constructors** crate-wide; `insights-slot` is created, named, appended, never populated. |
| Usage bars + Resources + Help buttons | `Sidebar.tsx:2053-2064` | `app.rs:606-619,651-676` | PARTIAL | All three work but live on a bottom status strip, not the sidebar footer/header; the sidebar's own `usage-bars-slot` (`mod.rs:546-548`) is dead. |
| Welcome empty state | `App.tsx:389-416` | `main_pane.rs:101-115` | PARTIAL | Two-line state; the six-card `welcome-features` grid and Help button are absent. |
| Sidebar width drag-resize + persist | `App.tsx:161-194,360-376` | `app.rs:575-585`, `state.rs:14,105` | MATCH | GtkPaned handle; persists to `UiState.sidebar_width`. |

## 5.2 Terminal stack

| Feature | Electron ref | GTK ref | Status | Note |
|---|---|---|---|---|
| Kept-alive VTE per workspace, lazy `ptyStart` on first fit | `Terminal.tsx:352-400,511-525` | `terminal/stack.rs:58-80`, `pane.rs:277-296` | MATCH | First non-zero mapped fit fires `ptyStart` exactly once. |
| Agent scrollback replay | `Terminal.tsx:370-375` (Electron **deliberately does not** replay) | `app.rs:185-192`, `stack.rs:92-97` | **IMPROVEMENT** | Electron's refusal is an **xterm-parser constraint** ("sequences xterm.js's parser can't handle… renders as literal `^[[` garbage"), not a product decision. It does not transfer to VTE, and B2's spike disproved it empirically (2 real Claude logs + hostile synthetic ?2026, feed ≡ spawn, pixel-identical, `dips=0`). **Knowing, justified reversal — do not revert.** |
| Run scrollback replay | `RunTerminal.tsx:137-140` (Electron **does** replay) | — | PARTIAL | Re-verified: `run_script_scrollback` exists at `orchestra-rpc/src/client.rs:1107` with **zero GTK call sites**. Reopening the Run tab shows an empty pane. |
| ?2026 / no RAF batching | `term-write-queue.ts` (retired §10) | `pane.rs:156-164` raw `feed()` | MATCH | Approved substitution; VTE's GdkFrameClock replaces the write queue. |
| Boot pill (label, 4 clear conditions, 250 ms fade) | `Terminal.tsx:320-344,411-418` | `terminal/boot_pill.rs:89-104`, `pane.rs:174-196` | PARTIAL | All four clear conditions and the fade match. Missing the animated spinner; Resuming/Starting keys off `ws.status != Idle` (`app.rs:203`) instead of `ws.hasInput` (`Terminal.tsx:340-341`), so a never-run workspace can read "Resuming previous session…". |
| `pty:stopped` → "press any key to relaunch" | `Terminal.tsx:419-477` | `pane.rs:200-211,246-261` | MATCH | First keystroke starts and is swallowed. Cosmetic: GTK omits the exit code, colors the notice grey vs yellow. |
| `pty:restart` → clear + respawn | `Terminal.tsx:435-448` | `pane.rs:215-219`, `app.rs:1325-1328` | PARTIAL | Clears and re-arms the pill but never calls `kind.start(...)`; `started` is already latched so no new fit fires and no `ptyStart` is issued. |
| Repaint-on-show (`ptyRepaint`) | `Terminal.tsx:534-568` (visibility **and** window focus) **and** `:603-628` | `pane.rs:223-233` | PARTIAL | Re-verified: `pty_repaint` has **exactly one call site** (tab activation). No window-focus path — `app.rs:814-815` feeds `Msg::FocusChanged` to the chime only. Returning to an occluded window leaves the child diverged. |
| Ctrl+C copy-else-forward | `Terminal.tsx:497-502`, `RunTerminal.tsx:151-160` | `pane.rs:36-40,335-349` | MATCH | Per-kind policy replicated incl. the agent's no-SIGINT swallow. |
| Ctrl+V text / image → `saveClipboardImage` → bracketed paste | `Terminal.tsx:36-60` | `pane.rs:363-390` | MATCH | Same marker format incl. trailing space. |
| Shift+Enter → ESC+CR | `Terminal.tsx:489-493` | `pane.rs:327-330` | MATCH | Identical bytes and modifier guard. |
| URL matching → open externally | `Terminal.tsx:120-132` (OSC-8 + `WebLinksAddon`) | `pane.rs:394-410` | PARTIAL | Regex registered (underline cue appears) but the click handler resolves only `check_hyperlink_at` (OSC-8). Plain-text URLs look clickable and are inert. |
| Floating scrollbar | `Terminal.tsx:203-264` | `pane.rs:114-119`, `theme.css:37-44` | MATCH | Ledger explicitly permits approximation. |
| Run terminal Start/Stop, 5 k scrollback | `RunTerminal.tsx:28,44,199-234` | `toolbar/mod.rs:600-612`, `pane.rs:105` | PARTIAL | Start/Stop/Status match; scrollback is 10 000 not 5 000 (shared constant). |
| Nvim pane (`:nvim` PTY, resizable split, persisted width) | `App.tsx:21-27,130-137,643-657` | `stack.rs:119-140`, `pane.rs:31-33` | PARTIAL | PTY + toggle correct, but **not a split** — `set_nvim_open` swaps the GtkStack's visible child, so nvim fully replaces the agent terminal. No resizer, no width persistence. |
| Font (JetBrains Mono + Orchestra Symbols subset) | `Terminal.tsx:105-106,184-201` | `terminal/fonts.rs:18,33-55` | MATCH | Subset TTF embedded and registered via `FcConfigAppFontAddFile`. |
| Terminal palette from styles.css tokens | `Terminal.tsx:109-114` (bg `#1a1f26`) | `terminal/mod.rs:39-67` (bg `#0b0d10`) | PARTIAL | Full 16-color ANSI palette matches; background is the prototype value, not the renderer token. |

## 5.3 Main pane, toolbar, diff, dialogs

| Feature | Electron ref | GTK ref | Status | Note |
|---|---|---|---|---|
| Base→feature branch chip + BranchPicker | `App.tsx:436-447`, `BranchPicker.tsx:50-269` | `toolbar/mod.rs:136-178,514-559` | **PARTIAL (functional break)** | Re-verified: `toolbar/mod.rs:525` calls `listBranches` with `ws.repo_path`, but `api-handlers.ts:749-751` does `store.getWorkspace(id)` and **throws "workspace not found"**. The GTK comment at `:521-522` asserts the wrong signature. Picker errors/empties on every open against a real backend. |
| Tabs Terminal/Diff/Run | `App.tsx:450-495` | `toolbar/mod.rs:186-209,744-745` | **DIVERGENT (gap — ruled)** | GTK's `set_visible(!is_scratch_like && st.has_run)` hides the Run tab without a run script; Electron **deliberately keeps it visible** with a "· setup" hint and a tailored tooltip, per an explicit intent comment at `App.tsx:475-494` ("so users notice the affordance and discover the gear-icon entry point"). **Coordinator ruling: Electron wins** — the ledger was wrong. GTK removes the only entry point a user without a run script would find. See gap 12b. |
| Restart-agent | `App.tsx:297-313,496-517` | `toolbar/mod.rs:213-219,563-596` | MATCH | Same confirm-when-running gate and `--continue` copy. |
| Run start/stop toggle | `App.tsx:317-354,518-536` | `toolbar/mod.rs:600-628`, `main_pane.rs:313-322` | MATCH | Same 80×24 defaults and pty-exit clearing. |
| PR button (`findPR`) | `App.tsx:288,537-571` | `toolbar/mod.rs:632-653,786-819` | MATCH | Identical `unpushedAhead` priming and the 80 ms type-then-`\r` split. |
| Nvim toggle + workspace title | `App.tsx:423-449,572-595` | `toolbar/mod.rs:246-252,728-741` | MATCH | Three title layouts reproduced with the same tooltips. |
| Diff file list, +/- badges, A/M/D | `DiffView.tsx:51-65` | `diff/mod.rs:104-111,362-386` | **IMPROVEMENT** | Electron never renders A/M/D despite `DiffFile.status` existing (`types.ts:233`); GTK adds the badge (incl. `R`), satisfying the ledger. |
| Side-by-side, synced scroll, word highlights, language, read-only | `DiffView.tsx:77-107` | `diff/mod.rs:86-102,453-491`, `align.rs:83-115` | MATCH | Row-count-equal alignment makes one shared vadjustment exact lockstep; word highlights scoped to `Replace` pairs as Monaco does. |
| 300 KB truncation notice | backend truncates `git.ts:259-260`; **no notice in Electron** | `diff/mod.rs:429-432` | **IMPROVEMENT** | Marker string matches `git.ts:260` exactly. Electron shows truncated text silently. |
| 4 s visible-poll preserving selection | `DiffView.tsx:14-38` | `diff/mod.rs:258-269,322-331` | **IMPROVEMENT** | Selection preserved on both sides; GTK additionally gates on mapped+visible and adds a `rendered_key` guard (`:411-424`) so an unchanged poll never resets scroll. |
| Empty state | `DiffView.tsx:42-47` | `diff/mod.rs:349-355` | MATCH | Same two strings; GTK adds a "Diff unavailable" error state Electron lacks. |
| Merge button (`mergeWorktree`) | **no Electron renderer caller** (handler only: `api-handlers.ts:757-779`) | `toolbar/mod.rs:232-244,657-700` | **IMPROVEMENT** | Verified by grep across `src/renderer/`: Electron never calls `mergeWorktree`. GTK implements the ledger item from the handler contract; the "same toast/pill flow" clause has no Electron referent. |
| Dialogs (5 kinds, tone, Enter/Esc, promise-shaped) | `Dialog.tsx:57-160` | `dialogs.rs:78-300` | PARTIAL | All five kinds + keys + promise shape present. Missing: the **`warning`/danger tone** (`Tone` has only Info/Error/Success at `:20-25`; `confirm()` hardcodes `Tone::Info` at `:271`, so `App.tsx:304`'s danger restart-confirm loses its red styling), backdrop-click-cancel, prompt `initialValue`, and whitespace-only→null. |
| SetupBanner (log tail + retry) | `SetupBanner.tsx:19-65` | `banners/setup.rs:134-153,231-257` | **IMPROVEMENT** | GTK's 2 s timer is a genuine live tail; Electron only re-reads on status change (`:35` dep array). Same states and strings. |
| PromptQueueBanner | `PromptQueueBanner.tsx:40-155` | `banners/queue.rs:145-423` | PARTIAL | All four capabilities + correct keyed-object wire shape. **Usage is fetched only on `set_workspace` (`:191`)**; the 30 s timer re-renders a stale reading, so the banner won't auto-clear when the limit resets, nor appear if the limit is hit while already selected. Minor: Queue button not disabled on empty draft. |
| SandboxControlBar | `SandboxControlBar.tsx:23-58` | `banners/sandbox.rs:83-148` | MATCH | Identical three-way hide condition and per-endpoint event filter. |
| Overlays never unmount terminals | `App.tsx:616-671` | `app.rs:628-631,866-878` | MATCH | Main pane is the GtkOverlay's permanent base child; overlays only toggle `set_visible`, so VTE widgets are never unrealized. |
| Esc closes topmost overlay; mutual exclusion | `App.tsx:666-667` (store-enforced) | `app.rs:890-901`, `overlays/mod.rs:101-146` | MATCH | Exclusion is stronger than Electron's (all three mutually exclusive). |
| View state (activeId, tab, markSeen, unread auto-clear) | `store.ts:96,155-174`, `App.tsx:236-279` | `app.rs:1109-1123`, `main_pane.rs:186-213` | PARTIAL | activeId, global-tab semantics, and markSeen-on-select all correct. **Missing the focus-driven unread auto-clear**: no port of `App.tsx:267-279` or `:242-244`, so a yellow dot on the already-active workspace persists until the user re-clicks the row. |

## 5.4 Accounts, usage, login, queue

| Feature | Electron ref | GTK ref | Status | Note |
|---|---|---|---|---|
| UsageBars 5h/7d/Fable, name, "updated Xm ago" | `UsageBars.tsx:377-398` | `accounts/usage_bars.rs:291-306` | MATCH | Same resolution order (pinned → global → hide); `format_updated_ago` parity-tested. |
| Severity tint ≥75 / ≥90 | `UsageBars.tsx:23-27` | `logic.rs:83-91` | MATCH | Thresholds unit-tested. |
| `loginColor` stable HSL hash | `AccountBadge.tsx:39-46` | `logic.rs:19-65` | MATCH | UTF-16 i32-wrap hash with 13 node-derived parity vectors. |
| Hover panel, all accounts, hottest-first | `UsageBars.tsx:285-353` | `usage_bars.rs:340-503` | MATCH | Active-first then hotness desc; 120 ms close grace. |
| Per-row expiry composition | `UsageBars.tsx:186-193` | `usage_bars.rs:466-471` | DIVERGENT (cosmetic) | Electron replaces the age stamp with "token expired"; GTK concatenates both. Same information. |
| usage-bar-extra-credits (EX/ex, conditional, no-reset tooltip, hotness) | `10460f7` | `usage_bars.rs:123,309-324,493-500` | MATCH | Verified against the commit's diff (`10460f7` is not an ancestor of this branch). Both exclude `extra` from hotness. Clean port. |
| AccountsSettings add/remove, label→dir suggestion, inheritance chips | `AccountsSettings.tsx:65-148,319-384` | `settings.rs:100-165,254-287` | MATCH | `default_dir_for` parity-tested; dir stops tracking once hand-edited. |
| configDir `~`/`${VAR}` expansion preview | *(none in Electron)* | `logic.rs:223-290`, `settings.rs:240-245` | **IMPROVEMENT** | The ledger asks for a preview Electron lacks; expansion is a faithful port of `accounts.ts:expandConfigDir` with 13 vectors. |
| configDir picker button | `AccountsSettings.tsx:150-153,296-303` | — | MISSING | No browse button; the user must type the path. |
| Scratch-default checkbox | `AccountsSettings.tsx:165-166` | `settings.rs:248-251,351-364` | PARTIAL | Radio semantics correct; missing the explanatory sub-caption. |
| Save → `setAccounts` | `AccountsSettings.tsx:170-199` | `settings.rs:449-513` | PARTIAL | Same filter and `inherit` omission, but does not re-hydrate rows from the returned list (`:456-458` admits it). |
| Escape closes settings | `AccountsSettings.tsx:109-117` | — | PARTIAL | Cancel works; Escape does not. The "don't close mid-login" hazard is structurally avoided (separate modal window). |
| Per-repo `setRepoAccount` | `RepoScriptsModal.tsx:93` | — | MISSING | Unreachable — the Repo scripts modal is a stub (`sidebar/mod.rs:727-734`). |
| AccountLoginModal feed-VTE + start/stop | `AccountLoginModal.tsx:30,71-132` | `login_modal.rs:77-190`, `accounts/mod.rs:219-315` | PARTIAL | Feed/commit/stop paths correct. **No `ptyResize` is ever sent** for the login PTY (Electron resizes on settle and on every container resize, `:55-119`), so resizing garbles the `claude /login` TUI. |
| Login-terminal link routing (`accountLoginOpenUrl`) | `AccountLoginModal.tsx:43,47` | — | MISSING | No handler; the printed fallback URL is inert. (The PATH-shim `accounts:loginUrl` path still works — this is the fallback link only.) |
| Closes on `onAccountLoginDone` → `refreshAccounts` | `AccountLoginModal.tsx:106-112` | `accounts/mod.rs:255-295` | MATCH | Also closes on PTY exit. |
| `exited` gates dismissal / "Close"→"Done" | `AccountLoginModal.tsx:31,144,164` | `login_modal.rs:194-203` | PARTIAL | Label flips correctly, but `exited` is never read to gate dismissal; a WM close mid-OAuth still kills the PTY. |
| OAuth window: per-account persistent session | `login-browser.ts:27-29,64` | `login_web.rs:142-165` | MATCH | Approved §0 substitution; `NetworkSession` under `gtk-login-partitions/<id>`, ids sanitized against path escape. |
| OAuth window: UA stripping | `login-browser.ts:35-38` | `login_web.rs:171-231` | MATCH | Port of the Electron/Orchestra regex with 7 node-derived vectors. |
| OAuth window: opens on `accounts:loginUrl`, IdP popups, right-click escape hatch, closes on done | `login-browser.ts:42-101` | `login_web.rs:51-135,245-306` | MATCH | Re-navigates an existing window per account; all four context-menu items; all three close paths. |
| Workspace account badge (label, login color, usage tint, tooltip) | `AccountBadge.tsx:292-355` | `accounts/badge.rs:28-132` **(dead)** / live `sidebar/widgets.rs:805-808` | **MISSING (effective)** | Re-verified: grep for `accounts::badge`/`badge::` returns **zero consumers**. The live badge is `gtk::Button::with_label(s.ws.account_id)` — raw **UUID**, no color, no tint, static tooltip. A correct 384-line port exists, unmounted. |
| Default-login badge | `AccountBadge.tsx:363-393` | `badge.rs:103-125` (dead) | PARTIAL | Literal "default" is right; tint and usage tooltip are not rendered. (Latent bug in the dead path: `badge.rs:123` passes a degenerate `now` to `age_text`, always yielding "just now".) |
| Repo-header account badge | `AccountBadge.tsx:109-114` | — | MISSING | No GTK consumer. |
| Migrate menu options | `AccountBadge.tsx:260-282` | `sidebar/mod.rs:1343-1381` | PARTIAL | Built, but labeled by **account id** not `a.label` (`:1360`), and no login-color dots. `badge.rs:241-285` does it correctly — unused. |
| Migrate confirm dialog | `AccountBadge.tsx:214-221` | `sidebar/mod.rs:801-806` | **MISSING** | Re-verified: `Msg::MigrateAccount` is `fire_and_forget` with **no confirmation**. One click stops the agent and relocates the conversation. |
| Migrate busy state | `AccountBadge.tsx:224-242` | — | MISSING | Nothing prevents a second migrate while one is in flight. |
| Migrate error surfacing | `AccountBadge.tsx:226-229` | `sidebar/mod.rs:1004-1014` | PARTIAL | Transport errors surface; `fire_and_forget` discards the `{ok:false,error}` shape, so a **logical** failure is silent. |
| Same-account click no-op | `AccountBadge.tsx:213` | `sidebar/mod.rs:1368` | MATCH | Achieved by disabling the row. |
| `WorkspaceContextBadge` token formatting | `AccountBadge.tsx:80-107` | `sidebar/pills.rs:38`, `widgets.rs:797-802` | MATCH | Parity-tested twice. Cosmetic: tooltip renders `1240000` vs Electron's `1,240,000`. |

## 5.5 Resources, Insights, Help, Sound

| Feature | Electron ref | GTK ref | Status | Note |
|---|---|---|---|---|
| Resources 2 s visible-gated poll | `ResourcesView.tsx:16,332-389` | `overlays/resources.rs:168-189` | MATCH | Overlay-visibility gate replaces document-visibility; same no-cost-when-closed behavior. |
| Stat tiles (5) | `ResourcesView.tsx:550-581` | `resources.rs:429-482` | MATCH | All five tiles, same labels/subs. |
| Sparklines (90-sample ring, `max(100,peak)`, decay) | `ResourcesView.tsx:19,69-96` | `support.rs:137-198`, `resources.rs:1308-1363` | MATCH | Cairo port incl. 0.14 area fill; adds an endpoint dot (cosmetic). |
| Agents table (dot, branch, chips, cpu/mem/procs) | `ResourcesView.tsx:169-269` | `resources.rs:485-583` | MATCH | Same columns and hottest-first sort. |
| `ctx` (context tokens) column | `ResourcesView.tsx:254,319,611` | `resources.rs:46,391` | PARTIAL | Field declared but `refresh_slow` (`:216-246`) never writes it — the column always renders "—". The data exists in the sidebar (`sidebar/mod.rs:419-421`); pure wiring omission. |
| Expand → process list | `ResourcesView.tsx:270-287` | `resources.rs:618-650` | MATCH | Expansion survives the per-tick rebuild; same "+N more" tail. |
| Per-row stop + mid-turn confirm | `ResourcesView.tsx:188-208` | `resources.rs:588-613,655-693` | MATCH | Same target, confirm copy, and running-only gate. |
| Remote "runs in sandbox" note | `ResourcesView.tsx:241-243` | `resources.rs:556-561` | MATCH | Same string and column suppression. |
| App processes table | `ResourcesView.tsx:636-657` | `resources.rs:409-420,1186-1193` | MATCH | Same Browser→Main / Tab→Renderer mapping. |
| Token usage cards | `ResourcesView.tsx:448-512,662-701` | `resources.rs:695-780,1064-1152` | MATCH | Full card model incl. pending/error/expired and hotness sort. |
| Data-on-disk section | `ResourcesView.tsx:514-526` | `resources.rs:782-826` | MATCH | Same five rows and relative bar scaling. |
| Color discipline | `ResourcesView.tsx:41-48,130-143` | `support.rs:54-83`, `resources.rs:970-977` | MATCH | Severity classes only on limit rows; CPU/disk use accent. |
| Byte/token formatting | `ResourcesView.tsx:21-39` | `support.rs:18-52` | DIVERGENT (cosmetic) | `3.2 GB` vs `3.20 GB`; `12.3k` vs `12k`. Rust unit tests pin the divergent values, so it won't drift back on its own. |
| Insights sidebar section row | `Insights.tsx:59-96` | `insights.rs:112-210` (zero callers) | **MISSING** | Same finding as §5.1, reached independently. No at-a-glance summary or live per-step rows without opening the overlay. |
| Insights overlay (history, steps, live transcript, Run-now, reports, LESSONS panel, diff) | `Insights.tsx:120-334` | `insights.rs:334-813` | MATCH | Full port; adds handling for the backend's `{ok:false,error}` shape. Highlight via TextTag instead of a CSS class. |
| Help overlay (8 sections + docs link) | `Help.tsx:28-156` | `overlays/help.rs:26-223` | MATCH | Copy ported verbatim incl. curly apostrophes; test at `help.rs:256-272`. |
| Chime: 23 recipes → WAV | `chime.ts:456-484` (23 incl. `none`) | `chime-gen/src/recipes.rs:130-480` (23, same order) | MATCH | Test asserts 23 + RIFF (`sound.rs:330-341`). |
| Chime: GStreamer playback | `chime.ts:507-513` (Web Audio) | `sound.rs:115-141` | MATCH | Approved §0 substitution; audio-init failure degrades to silence. |
| Chime on `agent:finished` when unfocused | `App.tsx:236-248` | `app.rs:1088-1091` | DIVERGENT | Electron skips only when the window is focused **and** the finished workspace is the active one; GTK suppresses whenever the window is focused at all. In a multi-workspace fleet, background completions go unannounced. |
| Chime on `agent:needsInput` | `App.tsx:250-261` | — | **MISSING** | Re-verified: **zero** references to `AgentNeedsInput` in `native/orchestra-gtk/` (the variant is decoded at `orchestra-rpc/src/events.rs:130`). An agent asking for input is silent. |
| SoundSettings picker + preview + persist | `SoundSettings.tsx:21-69` | `sound.rs:183-324`, `app.rs:1137-1150` | MATCH | Persists to `gtk-ui-state.json`; fallback semantics tested. |
| Desktop notifications (finished/needs-input, click-to-focus, focus-suppressed) | `activity.ts:70` + main-side gates | `notify.rs:18-41`, `app.rs:1080-1084` | MATCH | Per-workspace notification id; backend owns the focus gate, so every `uiNotify` reaching GTK is meant to show. |

## 5.6 App shell & persistence

### Persistence: the plan's list vs the real localStorage keys

**The plan's §5.6 list is wrong in two ways** — it omits `orchestra.lastSandboxEndpoint`
and `orchestra:debug`, and collapses three independent "collapsed" keys into one.
The authoritative set is 8:

| # | localStorage key | Electron ref | GTK field | Status |
|---|---|---|---|---|
| 1 | `orchestra.sidebarWidthPx` | `App.tsx:30,190` | `state.rs:14` | MATCH |
| 2 | `orchestra.nvimPaneWidthPx` | `App.tsx:21,151` | **none** | **MISSING** |
| 3 | `orchestra.collapsedRepos` | `Sidebar.tsx:607,757` | `state.rs:26` | MATCH |
| 4 | `orchestra.collapsedHosts` | `Sidebar.tsx:632,771` | `state.rs:30` | MATCH |
| 5 | `orchestra.collapsedOrchestrators` | `Sidebar.tsx:643,785` | `state.rs:34` (renamed) | MATCH |
| 6 | `orchestra.dismissedEnvNotices` | `Sidebar.tsx:620,701` | `state.rs:38` | MATCH |
| 7 | `orchestra.lastSandboxEndpoint` | `Sidebar.tsx:950,957` | `state.rs:40` | MATCH |
| 8 | `orchestra:debug` | `debug.ts:18,47` | **none** | **MISSING** (see g) |

Plus two GTK items with no localStorage origin: `notification_sound` and window geometry — both MATCH the plan's intent.

| Feature | Electron ref | GTK ref | Status | Note |
|---|---|---|---|---|
| a. App id + single instance | `index.ts:413,440` | `main.rs:37-40` | PARTIAL | DBus id set, but no `activate`-on-second-launch focus handler — Electron raises the existing window; GTK exits silently. (`--remote-control` correctly downgrades to `NON_UNIQUE`, `main.rs:32-36`.) |
| b. `gtk-ui-state.json` | table above | `state.rs:11-41`, `app.rs:1383-1393` | PARTIAL | 7/8 keys + 2 extras; nvim width missing. Atomic tmp+rename write and corrupt→defaults are better than localStorage. |
| c. Theme tokens, dark-only | `styles.css:44-64` | `theme.css:13-25` | PARTIAL | 13/14 tokens identical. **`--accent-2` drifts**: `#8b7cff` (`styles.css:54`) vs `#7c6ef2` (`theme.css:513`) — re-verified. Visible on the nvim chip, insights icons, usage meters. |
| d. Startup dependency warning | `index.ts:356-376` (Continue Anyway / Quit) | — | **MISSING** | Re-verified: zero `deps:status`/`deps_status` calls in the GTK app. The method is served (`api-handlers.ts:843`) and typed in the client, but never called — a user missing `git`/`claude` gets no warning. |
| e. Version + backend-kind footer | n/a (Electron has none) | `app.rs:219-238,1233` | MATCH | `backend: … vX.Y.Z · frontend vX.Y.Z`; lockstep via `build.rs:19-30` → `lib.rs:30`, drift test at `lib.rs:39-44`. Confirmed live. |
| f. `log` forwarding + `revealLogs` | `ipc.ts:136` → `logger.ts:113` | `sidebar/mod.rs:724`; `client.rs:890` (unused) | PARTIAL | `revealLogs` works. Log **forwarding** does not: all 10 diagnostic sites in `app.rs` are `eprintln!`, so GTK warnings never reach the shared `orchestra.log`. |
| g. `ORCHESTRA_GTK_DEBUG` toggle | `debug.ts:16-45` | — | MISSING | No such env var under `native/`; `ORCHESTRA_GTK_MOCK` is unrelated. Logging is unconditional `eprintln!` — the inverse of Electron's off-by-default design. |

### §1.1 coexistence lifecycle

| Rule | GTK ref | Status | Note |
|---|---|---|---|
| 1. One backend per home (lock) | `app.rs:333-379` | MATCH | Correct by design: GTK is a pure frontend, never takes the lock; it interprets a spawned daemon's refusal with distinct dialogs incl. stale-lock guidance. |
| 2. Electron is a valid backend host | `app.rs:337-338,1236-1251` | MATCH | Daemon losing the lock to a running Electron is the designed outcome, not an error. |
| 3a. Discovery (`ORCHESTRA_UI_SOCK` → `ui-sock`) | `backend.rs:151-163` | MATCH | Exact order the protocol doc specifies. |
| 3b. Daemon auto-spawn | `app.rs:257-318` | MATCH | All three fallbacks; worker thread so first paint isn't blocked; exit diagnosis distinguishes lock-held from crash. E2E-verified. |
| 3c. Exit leaves daemon running; `--stop-daemon-on-exit` | `main.rs:21-25`, `app.rs:1174-1176` | MATCH | Only a daemon we spawned is eligible for the opt-out kill. |
| 5. Version handshake refusal, both directions | `app.rs:411-413,1253-1277`; `client.rs:707-711` | MATCH | Fatal for **protocol** skew (does not attach); non-fatal warning for **product-version** skew (`app.rs:1177-1201`) — a correct reading of rule 5. Both E2E-verified. |

---

## GAP LIST — prioritized by user-visibility

Only PARTIAL / MISSING / DIVERGENT. IMPROVEMENTs are excluded by design.

### P0 — functional breaks and destructive-action gaps

1. **`listBranches` called with the wrong argument — branch picker is broken.**
   `toolbar/mod.rs:525` passes `ws.repo_path`; `api-handlers.ts:749-751` does
   `store.getWorkspace(id)` and throws "workspace not found". Errors on **every**
   open against a real backend. → **B3**. Fix: pass the workspace id.

   **Root cause — two sibling methods take different argument types:**

   | Method | Handler | Takes | GTK call site | OK? |
   |---|---|---|---|---|
   | `listRepoBranches` | `api-handlers.ts:274-277` (`store.repos.some(r => r.path === repoPath)`) | a **repo path** | `sidebar/mod.rs:1059` passes `repo_path` | ✅ |
   | `listBranches` | `api-handlers.ts:749-751` (`store.getWorkspace(id)`) | a **workspace id** | `toolbar/mod.rs:525` passes `ws.repo_path` | ❌ |

   The GTK comment at `toolbar/mod.rs:521-522` documents the *other* method's
   signature ("listBranches(repoPath) → string[]"), which is likely how the
   confusion arose — fix the comment with the code.

   **Why no test caught it**: both mock arms (`mock.rs:632`, `mock.rs:958`) return
   the *same* hardcoded branch list and **ignore their params entirely**, so the
   mock cannot distinguish an id from a path. Contrast `runScriptStatus`
   (`mock.rs:962-964`), which does extract its arg via `Self::arg(&params, 0)?` —
   the correct pattern already exists in the same file. Making mock arms validate
   their arguments would close this whole bug class (see CONTRACT-MISMATCH below).

2. **Account migration has no confirmation.**
   `sidebar/mod.rs:801-806` is `fire_and_forget("migrateWorkspaceAccount")` — one
   click stops the agent and relocates the conversation, where Electron always
   confirms (`AccountBadge.tsx:214-221`). No busy state blocks a double-click.
   → **B4**.

   *Corrected during the sweep*: this is **not** a silent failure. The handler
   (`api-handlers.ts:355-357`) throws on `!res.ok` and `fire_and_forget` does show
   a dialog on throw (`sidebar/mod.rs:1008-1023`). The defect is (a) the **missing
   confirm** on a destructive action — the genuine safety issue — and (b)
   **inconsistent handling**: `accounts/badge.rs:319-336` handles the same method
   correctly via `call_typed`, checking `r.ok` and surfacing `r.error`, while the
   discarded result here cannot distinguish "migrated but not resumed" from full
   success.

3. **`accounts/badge.rs` is a complete 384-line port with zero consumers.**
   The live badge (`sidebar/widgets.rs:805`) renders the raw **account UUID** with
   no login color, no severity tint, and a static tooltip. Mounting `badge.rs`
   fixes this *and* items 2's confirm/error/busy handling *and* the migrate-menu
   labeling — it is mostly a wiring job, not a rewrite. → **B4**.

4. **No startup dependency warning.** Zero `deps:status` calls in the GTK app,
   though the method is served (`api-handlers.ts:843`) and typed in the client. A
   user missing `git`/`claude` gets no warning where Electron shows a blocking
   Continue/Quit dialog (`index.ts:356-376`). → **B6**.

### P1 — missing surfaces users will look for

5. **Insights sidebar section row never mounted.** `InsightsSection`
   (`overlays/insights.rs:112`) has zero constructors; `insights-slot`
   (`sidebar/mod.rs:543-545`) is created and never filled. Found independently by
   two auditors. Loses the persistent summary and live per-step rows. → **B5**.

6. **No `agent:needsInput` chime.** Zero references to `AgentNeedsInput` in the
   GTK app. Half the audible notification surface is gone — and it is the trigger
   users most rely on to return to a blocked workspace. → **B5**.

7. **Nvim pane is not a split.** `set_nvim_open` (`stack.rs:119-140`) swaps the
   GtkStack's visible child, so nvim *replaces* the agent terminal instead of
   docking beside it, defeating the feature's purpose. The persisted width
   (`orchestra.nvimPaneWidthPx`) has no GTK equivalent either. → **B2**.

8. **Repo scripts modal is a stub** (`sidebar/mod.rs:727-735`) — a visible,
   tooltipped gear on every repo header opens an alert. Also makes per-repo
   `setRepoAccount` unreachable. → **B1/B4**.

9. **Unread dot never auto-clears on the active workspace.** No port of
   `App.tsx:267-279`/`:242-244`; the yellow dot sticks until the row is re-clicked.
   Visible on every agent turn. → **B3**.

10. **Run-terminal scrollback never replayed.** `run_script_scrollback` has zero
    GTK call sites; reopening the Run tab shows an empty pane while the dev server
    keeps logging. → **B2**.

### P2 — degraded behaviors and stale state

11. **Daemon-restart reconnect stall (~3 min).** *(The known M2-surfaced gap —
    root-caused here.)* `RpcBackend::connect` (`backend.rs:256`) uses
    `RpcClient::connect` → `Source::Explicit` (`client.rs:301`), pinning the dead
    PID-keyed path through the full backoff (`client.rs:56-61`: 1 s→×2→30 s cap,
    `max_elapsed_ms` 180 000). **The fix already exists, unused**:
    `RpcClient::discover` (`client.rs:308`) → `Source::Discovered`, which `dial()`
    re-resolves per attempt (`client.rs:451-455`), self-healing on the first retry
    (~1 s). `backend.rs:245-247`'s own doc comment already describes this stall as
    a known cost path.
    **`probe_backend` (`backend.rs:180`) must stay `Explicit`** — it is a one-shot
    `reconnect: false` probe (`backend.rs:176`) of a caller-chosen socket.
    Worst case is ~180 s + ≤3 s (the retry loop at `app.rs:1374` then rediscovers),
    so it self-heals; there is no permanent hang. → **B6**.

11b. **"Open report" silently does nothing when a login has no report.**
    `openSelfTuneReport` returns `Promise<boolean>` (`ipc.ts:290`) where `false`
    means "no report yet"; `overlays/insights.rs:472-474` inspects only `Err(_)`,
    so `Ok(false)` reads as success — no window, no message, no log. Fix requires
    **both** the call site and `mock.rs:748` (which returns an object where the
    contract says a bare boolean, making the branch untestable). → **B5**.

11c. **`startSelfTune` parses an envelope the daemon never sends.**
    `insights.rs:420` reads `{ok, run}`; `ipc.ts:282` returns a bare `SelfTuneRun`
    and *throws* on an in-flight run. The `ok:false` branch is dead against the
    real backend. Confirm the daemon's rejection shape live before changing.
    → **B5**.

12b. **Run tab hidden without a run script — removes a discovery affordance.**
    `toolbar/mod.rs:745` gates the tab on `st.has_run`; Electron deliberately keeps
    it visible with a "· setup" hint and tailored tooltip
    (`App.tsx:475-494`, explicit intent comment). A user with no run script
    configured loses the only entry point to the scripts modal.
    **Ruled by the coordinator: Electron wins; the ledger text was wrong** — this
    is a gap, not a sanctioned divergence (same class as the §5.6 persistence
    list). → **B3**.

12. **Prompt-queue limit state goes stale.** Usage is fetched only on
    `set_workspace` (`banners/queue.rs:191`); the 30 s timer re-renders a stale
    reading. The banner keeps saying "Usage limit reached" after a reset, and won't
    appear if the limit is hit while the workspace is already selected. → **B3**.

13. **Repaint-on-show missing the window-focus path.** `pty_repaint` has exactly
    one call site (`pane.rs:230`, tab activation). Returning to an occluded window
    leaves the child's diff model diverged — the exact garble Electron added two
    focus handlers to heal (`Terminal.tsx:534-568`). → **B2**.

14. **`pty:restart` never re-issues `ptyStart`.** `pane.rs:215-219` clears and
    re-arms the pill but relies on the backend re-emitting; `started` is already
    latched so no new fit fires. After a branch switch the pill can sit over a dead
    terminal until its 20 s timeout. → **B2**.

15. **Login PTY is never resized.** No `ptyResize` for `account-login:<id>`
    (`login_modal.rs:137-166`); resizing the login window garbles the
    `claude /login` TUI. → **B4**.

16. **Resources `ctx` column always renders "—".** `resources.rs:46,391` declares
    the field; `refresh_slow` (`:216-246`) never writes it. The data exists in the
    sidebar (`sidebar/mod.rs:419-421`). → **B5**.

17. **No GTK-side `log` forwarding.** All 10 diagnostic sites in `app.rs` are
    `eprintln!`; GTK warnings never reach the shared `orchestra.log`, leaving
    nothing to debug a user-reported GTK bug from. The typed wrapper exists unused
    (`client.rs:890`). → **B6**.

18. **Env notices have no action links.** The "Set API key…" / "Get a key"
    buttons (`Sidebar.tsx:2015-2037`) are absent, so the notice reports a problem
    with no path to fix it. No 60 s refresh either. → **B1**.

19. **Plain-text URLs in the terminal are inert.** The regex is registered (so the
    underline cue appears) but only OSC-8 hyperlinks resolve on click
    (`pane.rs:394-410`) — it looks clickable and isn't. Same class:
    login-terminal link clicks don't route through `accountLoginOpenUrl`. → **B2/B4**.

20. **Chime focus gate is coarser than Electron's.** `app.rs:1088` suppresses
    whenever the window is focused; Electron also requires the finished workspace
    to be the active one (`App.tsx:242-246`). Background completions go
    unannounced in the app's core multi-workspace use case. → **B5**.

### P3 — cosmetic and low-frequency

21. **Dialog `warning`/danger tone missing** — `Tone` has only Info/Error/Success
    (`dialogs.rs:20-25`); `confirm()` hardcodes `Tone::Info` (`:271`), so danger
    confirms lose their red styling. Also: no backdrop-click-cancel, no prompt
    `initialValue`, no whitespace-only→null. → **B3**.
22. **Welcome empty state** — two lines instead of the six-card
    `welcome-features` grid (`App.tsx:389-416`). High visibility (first screen) but
    degrades gracefully. → **B1**.
23. **`--accent-2` hue drift** — `#7c6ef2` vs `#8b7cff` (`theme.css:513`). One-line fix. → **B1**.
24. **Terminal background** — `#0b0d10` (prototype) vs the renderer token `#1a1f26`. → **B2**.
25. **No second-instance window focus** — relaunching appears to do nothing
    instead of raising the window (`main.rs:37-40`). → **B6**.
26. **`ORCHESTRA_GTK_DEBUG` missing** — logging is unconditional `eprintln!`
    rather than off-by-default with a toggle. → **B6**.
27. **Resources/Help/usage-bars placement** — bottom status strip rather than the
    sidebar footer/header; the sidebar's own slots are inert. → **B1/B5**.
28. **"+ Repo" semantics** — folder picker → `addRepo` vs Electron's
    new-workspace modal. Same label, different destination. → **B1**.
29. **Cross-repo drag-drop permitted** — GTK omits Electron's same-repo
    restriction (`Sidebar.tsx:1613`), so a cross-repo drop persists an unintended
    reorder. → **B1**.
30. **Boot pill**: no spinner; Resuming/Starting keys off `status != Idle` instead
    of `hasInput`, so a never-run workspace can read "Resuming previous session…". → **B2**.
31. **Run scrollback 10 000 vs 5 000 lines** (shared constant, `pane.rs:105`). → **B2**.
32. **AccountsSettings**: no configDir picker button, no Escape-to-close, no
    re-hydrate from `setAccounts`' return, missing scratch-default sub-caption. → **B4**.
33. **Login modal `exited` never gates dismissal** (`login_modal.rs:194-203`). → **B4**.
34. **Migrate menu labels by account id, not label; no color dots**
    (`sidebar/mod.rs:1360`) — fixed by mounting `badge.rs` (gap 3). → **B4**.
35. **Byte/token formatting digits** — `3.2 GB` vs `3.20 GB`, `12.3k` vs `12k`
    (`support.rs:18-52`). Rust tests pin the divergent values. → **B5**.
36. **Expired usage rows** merge status and age into one label
    (`usage_bars.rs:466-471`) where Electron uses two spans. Same information. → **B4**.
37. **Context tooltip** renders `1240000` vs `1,240,000`. → **B4**.
38. **Archived section** doesn't clear selection on collapse (`Sidebar.tsx:855-857`). → **B1**.
39. **Status dot** lacks unread `font-weight:700` and the running pulse animation. → **B1**.
40. **Repo sync tooltip** says "Last synced Nm ago" vs Electron's wall clock; base
    picker lacks `defaultBranch` emphasis. → **B1**.

### Ledger corrections surfaced by this audit

Two places where **the plan's own ledger was wrong**, and everything downstream
trusted it. Both are now corrected in `docs/gtk4-port-plan.md`:

- **§5.3 Run tab** — the ledger implied hiding it without a run script; Electron
  deliberately keeps it visible as a discovery affordance. Ruled: Electron wins
  (gap 12b).
- **§5.6 persistence list** — omitted `orchestra.lastSandboxEndpoint` and
  `orchestra:debug`, and collapsed three independent `collapsed*` keys into one.
  The authoritative 8-key table is in §5.6 above.

A parity ledger that under-specifies is worse than useless when several agents
code against it: it converts a spec bug into N implementation bugs.

---

## CONTRACT-MISMATCH — wire-contract bugs invisible to every existing test

A dedicated sweep of all 22 `call_typed` / `call` sites and 13 `fire_and_forget`
sites, comparing each against its `api-handlers.ts` handler signature **and** its
`mock.rs` arm.

**Why this class matters most:** the mock backend is *more permissive than the
wire contract*. Many mock arms return a constant and ignore their parameters, so
a GTK call site can pass the wrong argument shape — or deserialize the wrong
return shape — and per-branch verification passes while only a live daemon fails.

| Method | GTK call site | Handler ref | Mock arm | Severity | Concrete failure |
|---|---|---|---|---|---|
| `listBranches` | `toolbar/mod.rs:525` (passes `ws.repo_path`) | `api-handlers.ts:749-753` (`store.getWorkspace(id)`); typed `ipc.ts:257` `(id: string)` | `mock.rs:958` — returns a constant list, **params ignored** | **BROKEN-LIVE** | Handler throws `workspace not found`; `load_branches` takes the `Err` arm (`toolbar/mod.rs:159-162`), so the popover opens **empty with an error on every open**. See P0 #1. |
| `openSelfTuneReport` | `overlays/insights.rs:472-474` — inspects only `Err(_)` | `ipc.ts:290` → `Promise<boolean>`, where **`false` = "no report yet"**; `api-handlers.ts:837` | `mock.rs:748` — returns `json!({"ok": true})`, an **object where the contract says bare boolean** | **SUSPICIOUS** (real logical bug) | A successful `Ok(false)` is treated as success: the user clicks "open report" and **nothing happens — no window, no message, no log**. The mock's object return makes the `false` branch structurally untestable. Fix requires **both** sides. |
| `startSelfTune` | `overlays/insights.rs:420` — branches on `v.get("ok") == Some(false)`, reads `{ok, run}` | `ipc.ts:282` → bare `SelfTuneRun`, and **rejects (throws)** when a run is in flight | `mock.rs:750` → `start_fake_self_tune` returns `{ok:false,error}` / `{ok:true,run}` — **an envelope the real handler never emits** | **SUSPICIOUS** | The `ok:false` branch is **dead** against the real daemon, and the success path reads the wrong shape. Symptom is degraded messaging, not a hard break (the `Err` path still catches the conflict). Confirm the daemon's rejection shape live before changing. |

**Verified NOT mismatches** (filed to prevent false positives): `getWorkspaceAccounts`
(both `banners/queue.rs:229` and `accounts/mod.rs:126` correctly use
`HashMap<String, WorkspaceAccount>`, matching `ipc.ts:112` — **the previously
reported Vec-vs-Map bug is already fixed**), `stopAgent` (`resources.rs:686`, correctly
uses an `Agent`-filtered `pty_id`), `listRepoBranches` (`sidebar/mod.rs:1059`, genuinely
takes a path), `getRepoScripts`, `switchBranch`, `renameBranch`, `queuePrompt`,
`removeQueuedPrompt`, `importToSandbox`, `migrateWorkspaceAccount`,
`sandboxControlState`, `getDiff`/`getDiffStats`/`findPR`/`runScriptStatus`, and all
PTY methods.

### Systemic root cause — param-ignoring mock arms

`listBranches` (`mock.rs:958`), `listRepoBranches`, `openSelfTuneReport`
(`mock.rs:748`), `stopAgent`, `takeSandboxControl`, `restartAgent`, and
`mergeWorktree` all return constants regardless of input. **Any argument-shape
error in these methods is untestable by construction.** The correct pattern
already exists in the same file — `runScriptStatus` (`mock.rs:962-964`) extracts
its argument via `Self::arg(&params, 0)?`.

**Recommendation**: every mock arm standing in for a keyed lookup should validate
its key even when returning a fixture. That single change would have caught the
`listBranches` P0 in the existing test suite.

## SILENT-FAILURE — `fire_and_forget` call sites

**Correction to a common assumption**: `Sidebar::fire_and_forget`
(`sidebar/mod.rs:1004-1025`) is **not** fully silent — it *does* surface
transport/throw errors in a dialog (`:1008-1023`). What it discards is the
**return value**, so only failures encoded in a *successful* reply are invisible.

| Method | Call site | Destructive? | Failable? | On failure the user sees |
|---|---|---|---|---|
| `migrateWorkspaceAccount` | `sidebar/mod.rs:802` | **Yes** — relocates a transcript, restarts the agent | Yes — returns `{ok,error}` | Handler `api-handlers.ts:355-357` **throws** on `!res.ok`, so the dialog *does* fire. But the result is discarded, so "migrated but not resumed" is indistinguishable from success — and `accounts/badge.rs:319-336` handles the *same method* correctly via `call_typed`. **Inconsistent handling, not silent failure.** The real defect remains the missing confirm (P0 #2). |
| `openExternal` | `sidebar/mod.rs:720` | No | **Yes, silently** | `api-handlers.ts:301`'s `isSafeHttpUrl` (`:233-240`) drops any non-http(s) URL and **resolves successfully** → nothing opens, no dialog, no log. The one genuinely silent path found. |
| `renameBranch` | `sidebar/mod.rs:751` | Yes — moves a git branch | Yes (throws) | Dialog shown; the returned updated `Workspace` (`ipc.ts:180`) is dropped, UI relies on the event pump. |
| `archiveWorkspace` / `unarchiveWorkspace` | `mod.rs:766`, `:770` | Yes | Yes (throws) | Dialog shown; handler returns `void` — acceptable. |
| `createWorkspace` / `createScratch…` / `createOrchestrator…` | `mod.rs:1044`, `:1026` | No | Yes | Dialog shown; returned `Workspace` dropped (event pump renders it). |
| `addRepo` / `syncRepoBase` / `reorderWorkspaces` / `reorderRepos` / `setUnread` / `revealLogs` | `mod.rs:716`, `:741`, `:1404`, `:1427`, `:762`, `:724` | No | Low | Dialog shown on throw — acceptable. |

---

## IMPROVEMENTS — GTK deliberately exceeds Electron

**Do not file these as regressions or "fix" them back.**

| Improvement | Refs | Why |
|---|---|---|
| Agent scrollback **is** replayed | `Terminal.tsx:370-375` vs `app.rs:185-192` | Electron's refusal is an xterm-parser constraint ("sequences xterm.js's parser can't handle"), not a product decision. It does not transfer to VTE, and B2's spike proved feed ≡ spawn pixel-identically on two real Claude logs plus a hostile ?2026 stream (`dips=0`). Knowing, justified reversal. |
| A/M/D file-status badges | `diff/mod.rs:104-111` | Electron has `DiffFile.status` (`types.ts:233`) and renders nothing. |
| 300 KB truncation notice | `diff/mod.rs:429-432` | Electron shows truncated content silently. |
| Diff error state + `rendered_key` scroll preservation + visible-gated poll | `diff/mod.rs:258-269,411-424` | Electron swallows the throw and uses a plain unguarded `setInterval`. |
| Live 2 s setup-log tail | `banners/setup.rs:134-153` | Electron only re-reads on status change (`SetupBanner.tsx:35`). |
| Merge button | `toolbar/mod.rs:232-244` | `mergeWorktree` has **zero** Electron renderer callers; GTK implements the ledger item from the handler contract. |
| configDir expansion preview | `settings.rs:240-245` | The ledger asks for a preview Electron lacks. |
| Overlay mutual exclusion | `overlays/mod.rs:101-103` | Stronger than Electron's help-vs-insights-only rule. |
| Atomic state write + corrupt→defaults | `state.rs:70-86` | Safer than localStorage. |

---

## Conclusions

**The port is a contract test for the Electron API surface.** Until now the
React renderer was the *only* consumer of `OrchestraAPI`, so ambiguities in that
surface were never stressed — a method's real contract was whatever its single
caller happened to pass. The GTK app is the first independent consumer, and it is
surfacing latent ambiguity that the single-consumer era structurally could not
reveal.

The `listBranches` P0 is the clearest instance, and it is a **class, not a slip**:
`listBranches(id)` and `listRepoBranches(repoPath)` share a return shape
(`string[]`), sit one word apart in name, and validate against *different* stores
(`store.getWorkspace` vs `store.repos.some`). Nothing in the type system or the
tests distinguishes them, and both mock arms return identical hardcoded lists.

Generalizing: **any two API methods that share a return shape but differ in key
type are a standing hazard for a second frontend.** Three countermeasures fall out
of this audit, all cheap:

### Testing policy (recommended, permanent)

> **A mock arm must be at least as strict as the contract it stands in for.**
>
> 1. **Validate the key.** Any arm standing in for a keyed lookup must extract and
>    validate its argument via `Self::arg(&params, N)?` even when returning a
>    fixture — `mock.rs:962-964` already shows the pattern. This alone would have
>    caught the `listBranches` P0 in the existing suite.
> 2. **Match the wire shape exactly.** Return what the contract returns — a bare
>    `boolean`, a bare struct — never an invented `{ok, …}` envelope. Both
>    `openSelfTuneReport` (`mock.rs:748`) and `startSelfTune` (`mock.rs:750`)
>    violate this, and in each case the looser mock is precisely what makes the
>    real bug untestable.

This is a standing policy change, not a one-off fix: a mock looser than its
contract converts live-only bugs into passing tests, and every future frontend
inherits the problem.

A third countermeasure sits on the Electron side: **prefer distinguishable key
types or names** where sibling methods take an id vs a path. The ambiguity lives
in the API surface, not only in the GTK caller.

This is an argument *for* the port beyond the port itself: a second frontend
hardens the backend contract for both.

**The ledger itself needed correcting twice.** This audit found two places where
`docs/gtk4-port-plan.md` §5 misstated the target — the Run tab's visibility
(ruled: Electron wins, gap 12b) and the §5.6 persistence key list. When N agents
implement against a shared spec, a spec bug becomes N implementation bugs, so an
audit's job includes checking the ledger against the source of truth, not only
the code against the ledger.

## Fixture-corpus note (plan §M3)

The plan asks M3 to close the two highest-drift-risk uncaptured fixture shapes: a
recorded-`gh`-response seam for `findPR`, and a fake-sandbox endpoint for the
import/eject/control shapes. **Neither was in this audit's scope** (this pass
walked §5 behavior); both remain open.
