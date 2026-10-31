# Orca's sidebar: a portable design spec, and how it differs from Orchestra's

Compiled 2026-10-28. Prerequisite for a `/prototype` run with 3 Orca-inspired sidebar variants. Companion to
[`orca-linux-cannibalize.md`](orca-linux-cannibalize.md), which uses the same conventions.

**Pinned shas** (all read this session):

| Repo | sha | date |
|---|---|---|
| [stablyai/orca](https://github.com/stablyai/orca) (shallow clone, depth 1, read only, nothing executed) | `daf806bb411c087e96961051e171322036cf13e0` | 2026-10-28T05:15-07:00 |
| Orchestra (this repo, branch `sidebar-orca-look`) | `98fe09ff` (v0.5.357) | `git rev-list --count HEAD..origin/master` = **0** |

Orca anchors are GitHub permalinks at `daf806bb`. Unless a path says otherwise, it is relative to `src/renderer/src/`. Orchestra
anchors are `path:line` at `98fe09ff`.

Tags: **VERIFIED** = I read the file or looked at the image this session. **INFERRED** = derived by me, e.g. pixel totals
added up from Tailwind classes. **UNVERIFIED** = not checked.

**Screenshots** (small PNGs, cropped by me):

| File | Source | What it shows |
|---|---|---|
| [`orca-sidebar-ui/hero-sidebar.png`](orca-sidebar-ui/hero-sidebar.png) | `docs/assets/readme-hero.jpg` @ sha (README hero) | Dark theme, default (non-compact) cards, grouped by status (Pinned / In progress). The terminal in the same shot prints `orca@1.4.64-rc.0`, so this is a **~June 2026 build**, older than the code. |
| [`orca-sidebar-ui/site-agent-statuses.png`](orca-sidebar-ui/site-agent-statuses.png) | `https://www.onorca.dev/whats-new/posters/agent-statuses.jpg` (fetched 2026-10-28) | Close-up: yellow working spinner, nested agent rows with brand icons, "just now", PR line |
| [`orca-sidebar-ui/tile12-light-sidebar.png`](orca-sidebar-ui/tile12-light-sidebar.png) | `resources/onboarding/feature-wall/tile-12.poster.jpg` @ sha | Light theme, an **older** build (uppercase `WORKTREES` header, an `All / PR Status / Repo` segmented control). Exact age UNVERIFIED. |

---

## Short answer

Orchestra already copied Orca's **palette**: the Geist font, `letter-spacing: .01em`, and the status-glyph colours
(`styles.css:76-79`, `:94-118`). What it has not copied is Orca's **shape**. The five deltas that matter most:

1. **Rows are cards, not lines.** Orca's default row is a rounded card (10px radius, inset 4px, 6px gap between cards)
   with up to three lines: title (13px/20px), meta (repo chip + branch), and a live agent line (brand icon, "prompt -
   last message", "4h"). Orchestra uses one 24px line.
2. **Selection is a filled rounded card, not a left bar.** Active = foreground at 10% over the sidebar, plus a faint
   border and a 1px shadow. Orchestra uses a flat full-bleed `--bg-3` and a 2px accent left border.
3. **The sidebar is a flat, neutral, *lifted* surface.** In dark mode it is `#2a2a2a` on a `#0a0a0a` canvas, i.e. lighter
   than the canvas, and dividers are white at 7%. The pixel `#2a2a2a` was sampled from the hero. Orchestra uses a
   translucent blue-black gradient with an 18px blur, darker than its canvas neighbours, and `#23272f` borders.
4. **Titles are full-brightness 13px at rest. Unread is bold.** Orchestra uses 12px titles dimmed to `#9aa3ae` until
   hover or active.
5. **Section headers are sentence-case 13px semibold with a coloured repo glyph.** They are 28px tall, sticky, and
   their actions appear on hover. Orchestra uses 10px uppercase, 0.8px letter-spaced dim text, separated by full-width
   rules.

---

## 1. Layout and information hierarchy (VERIFIED unless tagged)

Vertical stack, top to bottom ([`components/sidebar/index.tsx:166-218`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/index.tsx#L166-L218)):

| # | Block | Content | Anchor |
|---|---|---|---|
| 1 | **Nav** | A Search pill first (⌘ keycaps appear on hover), then Setup guide, Tasks, Artifacts, Skills, Automations, Agent dashboard, Mobile. Each optional item can be hidden from its right-click menu. | [`SidebarNav.tsx:87-215`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/SidebarNav.tsx#L87-L215) |
| 2 | **Header** | Title `Workspaces`, or `Projects` when grouped by repo. To its right: an activity bell, plus `FolderPlus` and `Plus` ghost icon buttons. | [`SidebarHeader.tsx:59-66`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/SidebarHeader.tsx#L59-L66), [`sidebar-header-actions.tsx:20-90`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/sidebar-header-actions.tsx#L20-L90) |
| 3 | Banners | Daemon stalled/severed, toolchain scan, startup refresh status | `index.tsx:177-197` |
| 4 | **List** | A virtualized (TanStack) listbox of group headers, worktree cards and lineage groups | [`WorktreeList.tsx`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeList.tsx), [`worktree-list/viewport/virtual-rows.ts:10-96`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/viewport/virtual-rows.ts#L10-L96) |
| 5 | **Footer toolbar** | Behind a `border-t`: help, a scroll-to-current button and a kanban toggle, all `icon-xs` buttons | [`SidebarToolbar.tsx:68-93`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/SidebarToolbar.tsx#L68-L93) |

**Grouping.** The default is `groupBy: 'repo'`, `sortBy: 'recent'` and `projectOrderBy: 'manual'`
([`shared/constants.ts:182-184`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/constants.ts#L182-L184)). The alternatives are PR status
(`Done / In review / In progress / Closed`, each with its own icon and tone,
[`worktree-list/rows/header-visuals.ts:14-50`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/rows/header-visuals.ts#L14-L50)),
workspace status, or none. A **Pinned** group sits on top. Project groups nest up to 6 levels deep, with a 10px header
step ([`rows/indentation.ts:19-34`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/rows/indentation.ts#L19-L34)).

**Nesting, three tiers:** group header → workspace card → (a) **lineage children**, i.e. child workspaces rendered
*inside* the parent card's body ([`worktree-card-surface.tsx:104-112`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-surface.tsx#L104-L112));
(b) **agent rows**, the agents running in that worktree, with sub-agents nested under them
([`WorktreeCardAgents.tsx:300-350`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeCardAgents.tsx#L300-L350)).
This is the tier that maps to Orchestra's orchestrator → child spawn tree.

**Shown versus hidden.** The default card properties are `status, unread, issue, linear-issue, jira-issue, pr, automation,
cli, comment, ports, inline-agents, host` ([`shared/worktree/card-properties.ts:13-24`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/worktree/card-properties.ts#L13-L24)).
`branch` and `ci` are **off by default**. The user toggles each from a "Show properties" menu. Compact mode keeps only
`status` and drops the meta row and the agent rows (`card-properties.ts:142-163`). `experimentalNewWorktreeCardStyle`
and `compactWorktreeCards` both default to `false` ([`shared/default-global-settings.ts:261-265`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/default-global-settings.ts#L261-L265)),
so the spec below describes the **default, legacy-style card**, which is what the hero shows.

**Width.** Default 280px, min 220, max 500 ([`shared/constants.ts:175`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/constants.ts#L175),
[`index.tsx:38-39`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/index.tsx#L38-L39)). Orchestra: default 340, min 240, max 560
(`src/renderer/App.tsx:55-57`).

## 2. Row anatomy: the default worktree card (VERIFIED from classes)

```
┌ card: ml-1 pr-1.5 pt-1.25 pb-1.5 rounded-lg(10px) border-transparent ─────────────┐
│ [status 16px] │ title 13px/20px regular (semibold if unread)  [primary] [trash↗hover] │  row 1
│   pt-2px      │ [■ repo-chip 10px semibold lowercase] branch 11px muted…  [⊙][PR][🔌] │  row 2 (meta)
│               │ [◌ 10px][brand 13px] prompt - last message…   model  4h              │  row 3 (agent, h-6)
└────────────────────────────────────────────────────────────────────────────────────┘   6px gap to next card
```

| Element (in order) | Spec | Anchor |
|---|---|---|
| Card surface | `relative flex flex-col pr-1.5 ml-1 overflow-hidden rounded-lg border border-transparent`. Padding `pt-1.25 pb-1.5` (5/6px), or `py-2` for a title-only card. Transitions bg/border/opacity/shadow over 200ms. Deleting: `opacity-50 grayscale`. | [`worktree-card-surface.tsx:49-70`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-surface.tsx#L49-L70) |
| Status lane | Left column `items-start pt-[2px]`, 2px gap to the content. Holds a 16px button: status glyph at rest, which turns into a muted bell on hover (toggles unread); a filled amber-500 13px bell when unread. | [`worktree-card-parent-content.tsx:145-169`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-parent-content.tsx#L145-L169), [`WorktreeCardStatusSlot.tsx:225-268`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeCardStatusSlot.tsx#L225-L268) |
| Content column | `flex-1 flex-col gap-1.5` (6px between rows) | `parent-content.tsx:171-182` |
| **Title** | `text-[13px] leading-5`, `truncate`, colour `text-foreground`. Unread: `font-semibold`, otherwise `font-normal`. Double-click renames inline. | [`worktree-card-header.tsx:173-188`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-header.tsx#L173-L188), [`WorktreeTitleInlineRename.tsx:327-331`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeTitleInlineRename.tsx#L327-L331) |
| `primary` badge | Only on the main worktree. `h-[16px] px-1.5 text-[10px] font-medium rounded`, `text-foreground/70 border-foreground/20 bg-foreground/[0.06]`. | `worktree-card-header.tsx:220-237` |
| Delete quick action | 16px `Trash2` (14px). `opacity-0`, revealed by `group-hover/worktree-card`; destructive tint on hover. | [`worktree-card-header.tsx:294-313`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-header.tsx#L294-L313) |
| **Repo chip** (meta row) | `px-1.5 py-0.5 rounded-[4px] bg-accent/50 border-border/60` (dark). A 6px **square** colour mark (`RepoBadgeMark size-1.5`), then the name in `text-[10px] font-semibold lowercase leading-none`. Flex-basis 7.625rem, so the branch shrinks first. | [`worktree-card-meta-row.tsx:50-57`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-meta-row.tsx#L50-L57), [`repo/RepoBadgeLabel.tsx:9-13`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/repo/RepoBadgeLabel.tsx#L9-L13) |
| Branch | `text-[11px] text-muted-foreground leading-none`, truncated, with a tooltip unless the details hovercard owns it | `meta-row.tsx:75-81` |
| Right-aligned meta glyphs | Linked issue `CircleDot`, PR icon (state-coloured), `Plug` (ports), `StickyNote` (comment), `CalendarClock` (automation), `SquareTerminal` (CLI). All lucide, muted. | `WorktreeCardMetaBadges.tsx:2,116-186`, `meta-row.tsx:104-106` |
| **Agent row** (exactly 1 agent) | `flex h-6 items-center gap-1 px-1 rounded-sm text-[11px] leading-none text-muted-foreground`. Contents: state glyph (10px box) → brand icon (13px, `AgentTypeIcon`) → `lead - trail` truncated (lead `muted-foreground/90`, or semibold foreground if unvisited; trail `/65`) → model `font-mono 10px max-w-24` → `+N` children → relative time `10px tabular-nums muted-foreground/60`. Focused pane: `bg-worktree-sidebar-accent`. | [`worktree-card-compact-agent-row.tsx:191-298`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L191-L298) |
| Agent **summary pill** (more than 1 agent) | A collapsed `h-6` button with `border-worktree-sidebar-border/70 bg-worktree-sidebar-accent/35`. Agents are clustered **by state**: each cluster is a `rounded-sm bg-worktree-sidebar/70 px-1 py-0.5` chip with a state glyph and up to 3 overlapping 16px brand-icon avatars (`rounded-full border`, `-space-x-0.5`), then `+N`. The chevron is rotated -90° while collapsed. Expanding reveals the agent rows. | [`worktree-card-compact-agents.tsx:75-186`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agents.tsx#L75-L186) |
| Line-2 text priority | Attention line > verdict > "no update for X" > stopping > monitoring > tool preview > program message > last assistant message > agent type | [`compact-agent-row.tsx:36-79`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L36-L79) |
| Lineage chip | An outline `chip` button (`Workflow` icon, short label, `ChevronDown`) that toggles child workspaces | [`worktree-card-secondary-rows.tsx:95-133`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-secondary-rows.tsx#L95-L133) |
| Details hovercard | Hovering the title and meta rows opens a card after 100ms with issue, PR, comment, ports and identity. Status glyphs and agent rows keep their own tooltips. | [`parent-content.tsx:82-132`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-parent-content.tsx#L82-L132) |

**Icons**: lucide-react `^0.577.0` throughout (`package.json`). Agent identity uses brand SVGs (Claude, Codex, OpenCode,
and so on), or a letter glyph for unknown programs ([`lib/agent-type-icon.tsx:8-24`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/lib/agent-type-icon.tsx#L8-L24)).

**Compact mode** (opt-in): title-only cards, `py-2`. The repo identity moves into the title row as a
`RepoIdentityChip`: `h-4 max-w-24 rounded-[4px] border bg-worktree-sidebar-accent/55`, a 12px glyph, and a 10px
lowercase name ([`worktree-card-header.tsx:18-51`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-header.tsx#L18-L51)).
The main worktree gets an amber `Star` instead of the `primary` badge.

## 3. Status indicators (VERIFIED)

Workspace status lives in the card's status lane ([`StatusIndicator.tsx:42-115`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/StatusIndicator.tsx#L42-L115)).
Agent state lives on the agent rows ([`components/AgentStateDot.tsx:111-190`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L111-L190)).

| State | Workspace lane (12px box) | Agent row (10px box) | Colour token |
|---|---|---|---|
| working | ring spinner `size-2`, `border-2 border-agent-working border-t-transparent` | same, `size-1.5` | `--agent-working` = yellow-500 |
| monitoring | lucide `Activity` 12px | `Activity` 10px | yellow-500 |
| permission / waiting | lucide `MessageCircleQuestion` | same | `--agent-question` = **orange-500 (dark) / orange-600 (light)** |
| done / active | **dot** `size-2 bg-emerald-500` | **`CircleCheck`** emerald-500 | emerald-500 |
| failed / blocked | dot `size-1.5 bg-red-500` | same | red-500 |
| interrupted | dot `bg-muted-foreground` | same | muted |
| unconfirmed / unverifiable | `CircleDashed` amber-500 | same | amber-500 |
| idle | dot `size-2 bg-neutral-500/40` | `size-1.5` | neutral-500 at 40% |
| unread (workspace) | filled bell, 13px, amber-500, `drop-shadow-sm` | title goes semibold | amber-500 |
| progress (0–100) | — | filling ring instead of the spinner or glyph | working / attention |

- **Spinner animation**: `agent-spinner-rotate 86400s steps(1036800, end) infinite`. That is one turn per second in
  **12 discrete steps per second**, stays on the compositor, and is phase-synced across rows on `animationstart`. Under
  reduced motion it becomes a filled, static ring
  ([`assets/main.css:1684-1698`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L1684-L1698), [`AgentWorkingSpinner.tsx:6-41`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentWorkingSpinner.tsx#L6-L41)).
- Tokens: [`main.css:228-236`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L228-L236) (light) and `:339-343` (dark). The PR-group tones are
  `--workspace-status-done #c7a594 / review #16a34a / progress #d4a300`.
- **Sleeping** workspaces: text tokens are mixed toward the sidebar colour in oklab (foreground 52%, muted 34%), leaving
  unread amber at full brightness ([`main.css:1406-1420`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L1406-L1420)).
- There is no pulse or glow anywhere. Colour and shape carry the signal.

## 4. Typography (VERIFIED)

| Token | Value | Anchor |
|---|---|---|
| UI family | `'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` (variable 100–900, bundled woff2) | [`main.css:14-20`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L14-L20), `:169-170` |
| Mono | `'SF Mono', SFMono-Regular, ui-monospace, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace` | `main.css:171-173` |
| Body | `letter-spacing: 0.01em`, antialiased. Root font-size is the browser default 16px, so `text-xs` is 12px. | [`main.css:661-678`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L661-L678) |
| Custom sizes | `text-2xs` 11px / lh 16px; `text-3xs` 10px / lh 14px | [`main.css:45-52`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L45-L52) |

| Role | Size / line-height / weight / colour |
|---|---|
| Nav item | 13px, `font-medium tracking-tight`, `fg/60` (active: accent-foreground) |
| Section title ("Workspaces") | 12px `font-semibold`, `muted-foreground/80` |
| Group header label | **13px / 16px `font-semibold`**, foreground, sentence case |
| Card title | **13px / 20px** regular (semibold if unread), foreground |
| Branch | 11px / 1, muted-foreground |
| Repo chip | 10px / 1 semibold, lowercase |
| Agent row | 11px / 1. Lead regular at muted/90; trail at muted/65 |
| Time, counts, model | 10px tabular-nums at muted/60–70; model in mono |
| Badges (`primary`, `sparse`) | 10px `font-medium` |

## 5. Spacing and density (VERIFIED classes; totals INFERRED)

| Measure | Value | Anchor |
|---|---|---|
| Sidebar padding (nav) | `px-2 pt-2 pb-1`, items `px-2 py-1.5`, `gap-0.5` | `SidebarNav.tsx:87,97` |
| Header row | `mt-2 h-8 px-2`. Title `pl-2`. Buttons `icon-xs` = 24px square, icon 12–14px. | `SidebarHeader.tsx:59-63`, [`ui/button.tsx:28-35`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/ui/button.tsx#L28-L35) |
| Group header | **28px** (`h-7`), `pl-10px` (+10px per project depth), `pr-2`, `gap-1.5`, 16px icon box. Sticky with `bg-worktree-sidebar`. 4px top margin between groups. | [`SectionHeader.tsx:191-256`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/rows/SectionHeader.tsx#L191-L256), `virtual-rows.ts:10-14` |
| Gap between cards | **6px** (`WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP`) | [`virtual-rows.ts:13`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/viewport/virtual-rows.ts#L13) |
| Card inset | 4px left margin (`ml-1`), 6px right padding | `worktree-card-surface.tsx:51-53` |
| Tree indent | **18px** per level (`SIDEBAR_TREE_INDENT`), +2px for cards under a project; grouped surface inset 14px per depth | [`rows/indentation.ts:1-18`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/rows/indentation.ts#L1-L18) |
| Agent sub-tree | `margin-left .75rem; padding-left .25rem; border-left 1px fg/22%`; child rows get a 0.35rem tick (`::before`) | [`main.css:1609-1648`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L1609-L1648) |
| Card height, default (title + meta + 1 agent row) | 5 + 20 + 6 + 16 + 6 + 24 + 6 + 2 (border) ≈ **85px**, pitch ≈ 91px. The virtualizer estimates 116. | INFERRED. `virtual-rows.ts:96` |
| Card height, title + meta | 5 + 20 + 6 + 16 + 6 + 2 ≈ **55px** | INFERRED |
| Card height, compact / title-only | 8 + 20 + 8 + 2 ≈ **38px**, pitch 44 | INFERRED |
| Orchestra row, for comparison | **24px** min, 30px with a status note, no gap between rows | `styles.css:1391-1399`, `:1903-1908` |

At 280px wide the hero fits about 9 default cards plus 2 group headers per 1000px of height. INFERRED from the screenshot.

## 6. Colour tokens and states (VERIFIED)

shadcn `new-york-v4`, base colour `neutral`, CSS variables ([`components.json`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/components.json)).
`--radius: 0.625rem` (10px). `rounded-sm` is 6px, `rounded-md` 8px, `rounded-lg` 10px ([`main.css:159-174`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L159-L174)).

| Token | Dark | Light | Anchor |
|---|---|---|---|
| `--background` (canvas) | `#0a0a0a` | `#fff` | `main.css:304`, `:192` |
| **`--worktree-sidebar`** (sidebar fill) | **`#2a2a2a`** (pixel-confirmed in the hero) | `#f5f5f5` | [`main.css:350-357`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L350-L357), [`:242-247`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L242-L247) |
| `--worktree-sidebar-accent` | `#353535` | `#eaeaea` | same |
| `--worktree-sidebar-border` | `rgb(255 255 255 / .07)` | `#e5e5e5` | same |
| `--worktree-sidebar-ring` | `#737373` | `#a1a1a1` | same |
| `--foreground` | `#fafafa` | `#0a0a0a` | `main.css:306` |
| `--muted-foreground` | `#a1a1a1` | `#737373` | `main.css:331` |
| `--accent` (global) | `#404040` | `#f5f5f5` | `main.css:332` |
| `--sidebar-accent` (shadcn) | `#262626` | `#f5f5f5` | `main.css:362` |
| Repo colours | `#737373 #ef4444 #f97316 #eab308 #22c55e #14b8a6 #8b5cf6 #ec4899` (default neutral) | | [`shared/repo-badge-color.ts:1-12`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/repo-badge-color.ts#L1-L12) |

A user setting can retint the sidebar: `default`, `match-terminal`, or `tinted`. Every sidebar token is then derived with
`color-mix`: accent = fg 9%, border = fg 7%, ring = fg 44%
([`lib/left-sidebar-appearance.ts:48-85`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/lib/left-sidebar-appearance.ts#L48-L85)).

**States** ([`main.css:1359-1404`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L1359-L1404)):

| State | Dark | Light |
|---|---|---|
| Card hover | `bg: color-mix(--sidebar-accent 40%, transparent)` | `color-mix(--sidebar-foreground 4%, transparent)` |
| **Card active** | `border: mix(fg 18%, --worktree-sidebar-border)`, `bg: fg 10%` (gives `#3f3f3f` on `#2a2a2a`, pixel-confirmed), `shadow: 0 1px 2px fg 3%` | `border: border 40%`, `bg: fg 8%`, `shadow 0 1px 2px fg 4%` |
| Multi-selected | `border ring 35%`, `bg accent 70%`, `0 0 0 1px ring 30%` | same |
| Lineage drop target | `border fg/40`, `bg accent`, `ring-1 inset ring/60` | `surface.tsx:56-57` |
| Agent row hover / focused | `accent 18%` / `accent 70%` | `fg 1.25%` / `mix(fg 12%, sidebar-accent)` |
| Focus ring | `focus-visible:ring-1 ring-worktree-sidebar-ring` on buttons. Global `outline-ring/50`. | `main.css:654-658` |
| Resize handle | 12px hit area straddling the edge. A 1px line, transparent until hover (`ring/50`) or drag (`ring`). | [`index.tsx:41-44`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/index.tsx#L41-L44) |
| Scrollbar | 8px. Thumb is transparent until the sidebar is hovered, then muted-fg 28%, 48% on thumb hover. | [`main.css:706-738`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L706-L738) |

No gradients, no backdrop blur, no glow on the sidebar.

## 7. Interactions (VERIFIED)

| Interaction | Behaviour | Anchor |
|---|---|---|
| Click / double-click | Activate / inline rename of the title | `worktree-card-surface.tsx:79-80` |
| Hover a card | Trash fades in (when enabled). The status glyph swaps to a "mark unread" bell. The details hovercard opens after 100ms. | `worktree-card-header.tsx:294-313`, `WorktreeCardStatusSlot.tsx:256-265` |
| Hover a group header | Collapse chevron, `…` menu and `+` new workspace all sit in one overlay over the right of the title, on a `bg-worktree-sidebar` plate (no reserved width). It is visible only on hover or focus when the device can hover, and in flow on touch. | [`ProjectHeaderActions.tsx:5-13`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/ProjectHeaderActions.tsx#L5-L13), `repo-header-project-actions.tsx` |
| Context menu (Radix) | Pin/Unpin · Mark Read/Unread · Copy Path / Worktree Name · Open in… · Move to Status · Move to group · Open Parent / Remove from Parent · Sleep · Delete / Delete with Descendants… | `WorktreeContextMenu*.tsx`, `worktree-card-option-items.tsx` |
| Drag | Native card drag to another status lane, to Pin, or onto a card (nests it as a lineage child). Pointer drag reorders repo and project-group headers (`cursor-grab`). Folders can be dropped onto the sidebar to add a project (overlay). | `worktree-list/drag/*`, `SectionHeader.tsx:124-145`, `index.tsx:223-240` |
| Collapse | Group headers (`ChevronDown`, rotated -90° when collapsed), the lineage chip, the agent summary pill, and agent sub-trees (animated grid-rows 180ms) | `SectionHeader.tsx:337-353`, `main.css:1670-1676` |
| Keyboard | The list is `role=listbox` with `option` rows. ↑/↓ navigate, Enter focuses the active terminal, PageUp/Down/Home/End scroll. A global keybinding cycles worktrees; ⌘J opens the jump palette. | [`worktree-list/navigation/use-keyboard.ts:162-198`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/navigation/use-keyboard.ts#L162-L198) |
| Multi-select | A selection gesture adds a ring per card, and batch actions apply | `surface.tsx:61,75-77` |
| Tooltips | Radix, `delayDuration 400`, `side="right" sideOffset 8` | `index.tsx:163` |

## 8. Component stack: what is portable (VERIFIED)

| Layer | Orca | Orchestra | Portability |
|---|---|---|---|
| Styling | Tailwind v4.3 (`@tailwindcss/vite`), tokens in `@theme inline`, `tw-animate-css` | Hand-written `styles.css` (6090 lines), CSS variables | Port the **values** (tokens, px, mixes) into CSS variables and classes. Don't add Tailwind. |
| Primitives | shadcn new-york-v4 on the `radix-ui` umbrella (ContextMenu, Tooltip, HoverCard, Popover, Collapsible), plus `cva` and `tailwind-merge` | Custom components, portal popovers (`RowActionsPopover`) | Context menu and hovercard: behaviour can be rebuilt; no dependency needed for the look |
| Icons | `lucide-react` 0.577 | Inline SVG copies of Lucide paths (`Sidebar.tsx:379` `ICON_PROPS`, 24 viewBox) | Same geometry. Copy paths as today. |
| List | `@tanstack/react-virtual`, sticky headers | Plain DOM | Virtualization is not needed for the look |
| Font | Geist variable, bundled | Geist variable, bundled (`styles.css:28-34`) | Already the same |

---

## Orca vs Orchestra: the deltas that make it look better (ranked by visual impact)

| # | Delta | Orca anchor | Orchestra to change | Effort |
|---|---|---|---|---|
| 1 | **Card rows**: a rounded 10px surface, 4px inset, 6px gap. Two or three lines: title / repo chip + branch / agent line. | `worktree-card-surface.tsx:49-60`, `parent-content.tsx:134-184`, `virtual-rows.ts:13` | `Sidebar.tsx:1443-1641` (pinned trees) and `:2132-2370` (repo sections); `styles.css:1391-1407` `.ws-item` | L |
| 2 | **Active / hover as a filled card**: dark active is fg 10% bg, fg-18% border, 1px shadow. No left accent bar. | `main.css:1359-1391` | `styles.css:1401-1405` (`.ws-item:hover`, `.ws-item.active { border-left-color: accent }`) | S |
| 3 | **Flat lifted neutral surface**: `#2a2a2a` sidebar on a `#0a0a0a` canvas, white-7% dividers, no blur | `main.css:350-357` | `styles.css:481-489` (gradient + `backdrop-filter: blur(18px)`), `--border #23272f` `:83` | S |
| 4 | **Full-brightness 13px/20px titles; unread = semibold** | `worktree-card-header.tsx:178`, `WorktreeTitleInlineRename.tsx:327-331` | `styles.css:1921-1935` (12px/1.3), `:2283-2287` (`#9aa3ae` rest colour), `:1723-1726` (unread = colour + weight 500) | S |
| 5 | **Group headers**: 13px semibold sentence case, a 16px coloured repo glyph, 28px tall, sticky, hover-overlay actions, no rules between groups | `SectionHeader.tsx:234-353`, `ProjectHeaderActions.tsx:5-13` | `styles.css:1168-1177` (10px uppercase, 0.8px tracking), `:1068-1069` (border-top between sections), `:1290-1320` | S–M |
| 6 | **Agent activity line**: brand icon + "prompt - last message" + relative time, 11px, on its own 24px row; a state-clustered avatar pill for more than one agent | `compact-agent-row.tsx:191-298`, `compact-agents.tsx:75-186` | `Sidebar.tsx:1603-1609` / `:2342-2348` (`.ws-status-note` 10.5px, only when `statusText` is set), `styles.css:1941-1950` | M |
| 7 | **Repo identity chip** on every card (6px colour square + 10px lowercase name) and **per-repo colour** (8-colour palette) | `meta-row.tsx:50-57`, `repo-badge-color.ts:1-12` | Orchestra shows `repo-tag-pill` only on cross-repo children (`Sidebar.tsx:2299-2306`); repos have no colour | M |
| 8 | **Header chrome**: a quiet 12px semibold "Workspaces" label, 24px ghost icon buttons, and a Search pill at the top of the nav. No gradient wordmark. | `SidebarHeader.tsx:59-66`, `SidebarNav.tsx:97-123` | `Sidebar.tsx:1647-1660`, `styles.css:490-500` (14×16 padding, bottom rule), `:790-798` (15px gradient h1) | S |
| 9 | **Tree rail for agents**: a 1px fg-22% left rail at 12px plus a tick per child, and an 18px indent step | `main.css:1609-1648`, `indentation.ts:1` | `styles.css:1416-1429` (explicitly no rail, 16px/level clamped at 3) | S |
| 10 | **Status-glyph details**: question glyph in **orange**-500 (not amber); stepped 12fps spinner; done = emerald dot (lane) or `CircleCheck` (agent row) | `main.css:228,339,1684-1698` | `styles.css:115` (`--glyph-attention` = amber-500, labelled "exact Orca parity", now stale), `:1656-1666` (0.8s linear) | XS |
| 11 | **Hover-only sleek scrollbar** instead of an always-hidden one | `main.css:706-738` | `styles.css:71-72`, `:1056-1067` | XS |
| 12 | Default width 280 instead of 340 (follows from the denser type in #4 and #6) | `shared/constants.ts:175` | `App.tsx:55` | XS |

**Not worth porting:** the virtualizer, the kanban drawer, the details hovercard (Orchestra removed PR/Linear badges on
2026-10-26 at the user's request, so cards would carry less metadata than Orca's), and the 14-property "Show
properties" menu.

**Conflict to resolve before porting #6 and #7.** The user asked on 2026-10-26 for less row clutter
(`docs/codebase-map/renderer-ipc-ui.md:294-297`). Orca's looks come from **whitespace and hierarchy**, not from more
badges. The agent line and the repo chip are the two Orca elements that *add* content. Each variant should state whether
it includes them.

## 3 variant directions (input for `/prototype`)

All three share #2, #3, #4, #8, #10 and #11: a flat `#2a2a2a`-style surface, filled-card selection, 13px foreground
titles, a quiet header, and orange question glyphs. They differ in row shape and hierarchy.

| | **A. Faithful port ("Orca cards")** | **B. Hybrid ("our tree, Orca skin")** | **C. Compact ("Orca compact mode")** |
|---|---|---|---|
| Row | Default Orca card: title / repo chip + branch / agent line. About 85px for a lead with an agent line, about 55px without. | One line, **28px**, rounded 6px pill inset 4px. A second 11px line only when `statusText` exists (`note · 4h`). | Title-only card, **38px** (`py-2`), repo chip *inside* the title row (`h-4`, 10px lowercase) |
| Hierarchy | Repo groups → cards; spawned children rendered **inside** the parent card (Orca lineage), agent rows with a rail | Keep the Orchestrators / Scratch / repo sections and the spawn trees. 18px indent plus Orca's 1px rail and ticks. | Same sections as B. Children collapsed by default behind a state-clustered avatar pill (Orca summary pill). |
| Section header | 13px semibold, coloured repo glyph, sticky, hover actions | Same | Same, 24px tall |
| Glyph lane | 16px lane at top-left (`pt-2px`) | 12px glyph centred on line 1 | 12px glyph centred |
| Repo colour | Yes (8-colour palette, square mark) | Repo glyph colour in the header only | Chip in each row |
| Rows per 1000px (no agent line) | ~16 | ~30 | ~22 |
| Risk | Most departure from the "declutter" ask; height doubles | Smallest change. Gets most of the polish (#2–#5, #9) at no density cost. | Mid. Relies on the pill to hide children. |
| Main files | `Sidebar.tsx` both render paths and a new `.ws-card` block in `styles.css` | `styles.css:481-500,1068-1069,1168-1177,1391-1430,1921-1950,2283-2287` | B's files plus the pill component |

---

## VERIFIED

- Orca sha `daf806bb` — `git log -1` in the clone.
- Default card variant: `experimentalNewWorktreeCardStyle: false` and `compactWorktreeCards: false`
  (`shared/default-global-settings.ts:261,265`); default properties from `card-properties.ts:13-24`.
- Every Tailwind class and CSS rule quoted above — read at the cited line.
- Sidebar fill `#2a2a2a` and active card `#3f3f3f` — sampled from the hero pixels at (200,460) and (300,530). Both match
  the tokens (`#2a2a2a` + 10% white = `#3f3f3f`).
- The hero is an older build — its terminal prints `orca@1.4.64-rc.0`; it also shows header counts and Search at the
  bottom of the nav, which differ from current `SidebarNav.tsx:87-123`.
- Stack — `package.json` (`tailwindcss ^4.3.3`, `radix-ui ^1.6.7`, `lucide-react ^0.577.0`, `class-variance-authority`,
  `tailwind-merge`) and `components.json` (`new-york-v4`, `neutral`).
- Orchestra: tokens `styles.css:76-142`, sidebar `:481-500`, rows `:1391-1430`, names `:1921-1950`, `:2283-2287`;
  width `App.tsx:55-57`; no Tailwind, Radix or lucide in `package.json` (grep empty).

## NOT VERIFIED

- **Rendered pixel heights** of Orca cards (≈85/55/38px) — added up from classes, not measured in a running Orca. Orca was
  not executed.
- **Orchestra's rendered sidebar** was not screenshotted this session. Its surface colour (≈`#13171c`) is computed from
  the gradient, not sampled.
- How the current Orca build looks in screenshots — every image is older than `daf806bb`, and no screenshot shows
  1.4.24x.
- Light-theme row details beyond the tokens — `tile12-light-sidebar.png` predates the current code.
- The exact items of the context menu per workspace kind — compiled from label strings, not from rendering the menu.
- Rows-per-1000px figures in the variants table — estimates.
