# Agent-view design system

Styling for the structured (SDK-driven) agent view. Three cascade layers in
`src/renderer/`, imported in this order in `main.tsx` (**last wins**):

1. `agent-view-defaults.css` (A3) — component structural defaults
2. `agent-view-structure.css` (A2) — view layout / DOM scaffolding
3. `agent-view-theme.css` (A5) — the design system: tokens + visual language

The components (`StructuredView.tsx` + `components/agent/*.tsx`) stamp `av-*`
classes; the theme layer keys on those real classes and supersedes the two
structural layers. Everything extends Orchestra's existing token system
(`styles.css`) — it does not introduce a competing look.

> Companion to `docs/plans/sdk-structured-agent-view.md` (Phase 5). The theme
> file's header comment carries the design thesis (the **turn rail** signature).

## Theming — dark unconditional, light explicit

Dark is the UNCONDITIONAL default and matches the app exactly. The OS
preference (`prefers-color-scheme`) is deliberately **not** consulted — the
surrounding chrome is dark-only, and the OS route put a white transcript inside
dark chrome on OS-light machines (caught in a headless verification run, which
reports light). Light applies ONLY when `.av-view` / an ancestor carries
`data-agent-theme="light"` — the hook a future settings toggle sets. There is
no writer today. `monaco-theme.ts` watches the same attribute (MutationObserver)
and switches the editors between `orchestra-dark`/`orchestra-light` live.

The palette matches the **Claude Code / claude.ai desktop** look: a warm greige
canvas (`--av-surface: #262624`), cream text (`#faf9f5` / `#c2c0b6` / `#9c9a92`),
and the **clay** brand accent (`#d97757`) carrying the assistant/interactive
voice and the live edge — NOT a cool blue IDE. Values were traced from the
Claude Desktop app's shipped token sheet (`window-shared.css .darkTheme`). Light
is CC's warm cream paper (`#faf9f5`). Type follows CC's roomier rhythm: 16px
prose, 13px small/code, generous line-height; **code content uses a system mono
stack** (`--av-mono`, claude.ai ships no custom mono), while chrome microlabels
keep JetBrains (`--font-mono`). Prose stays **Inter** (per product decision — we
do not bundle Anthropic Sans).

All colours are `--av-*` tokens defined on `.av-view`. **Reference the tokens,
never raw hex.** Roles: `--av-surface{,-raised,-sunken,-overlay}`,
`--av-hairline{,-strong,-faint}`, `--av-highlight` (inset top sheen),
`--av-text{,-dim,-faint}`, conversation hues `--av-{assistant,thinking,tool,
tool-active,user,task}`, states `--av-{add,remove,error,warn}` (+ `-bg`),
`--av-code-{bg,border}`, `--av-glow` (live-edge halo), `--av-focus-{border,ring}`,
motion `--av-ease{,-out}`, type `--av-fs-*` / `--av-lh-prose` / `--av-measure` /
`--av-mono` (code stack), `--av-radius-xl` (composer field / dialog).

### The live edge (signature)

While the agent works, the view breathes: the streaming/thinking message's rail
glows (`av-breathe` on the `::before` rail, keyed off `:has(.av-cursor)` /
`:has(.av-thinking)`), "Thinking…"/"Working…" shimmer (`av-shimmer`,
background-clip text), the pending tool's status dot and the enabled interrupt
dot pulse (`av-pulse`). Turn end goes still. Row entrance (`av-enter`) animates
ONLY `.av-row:last-child` — a virtualized remount mid-list must not replay it.
All of it sits behind `prefers-reduced-motion` guards.

### Monaco

`components/agent/monaco-theme.ts` defines `orchestra-dark`/`orchestra-light`
(warm CC-tuned syntax over the `#1f1e1d` sunken surface, system-mono
`MONACO_FONT`, **20px lines** — `ToolDiff` derives its frame height from
`MONACO_FONT.lineHeight`, so keep those in sync, never hard-code the row px) —
registered idempotently via each editor's `beforeMount`.
Monaco itself is BUNDLED (`src/renderer/monaco-loader.ts`, imported first in
`main.tsx`): `loader.config({ monaco })` + a local editor worker, so no jsDelivr
CDN fetch at runtime (verified: 0 CDN requests in the e2e run). Inter is also
self-hosted now (`assets/fonts/InterVariable*.woff2`) — no Google Fonts links.

### Scrollbar

The app hides scrollbars globally; `.av-message-list` opts back in with a slim
track-less native thumb (the terminal's gutter-free thumb is TSX-synced; here a
native 10px gutter is invisible inside the centered column). Long tool-output
wells (`av-tool-bash-out` etc., max-height 320px) get an 8px variant.

## The real class contract (enumerated at integration)

Shell (`StructuredView.tsx`): `.av-view` (+`.active`) → `.av-message-list` →
`.av-message-list-inner` → `.av-row`. Composer `.av-composer` >
`.av-composer-field` (textarea + send live inside one framed field). The field is
a flex row of `.av-composer-stack` (a flex **column**, `flex:1 1 auto`) + `.av-composer-send`
(arrow icon + `.av-composer-send-label` "Send"/"Queue"). The stack holds the pasted-image
strip above `.av-composer-input`; the column's `gap:4px` is the ONLY vertical space
between thumbnails and text — attachments used to be a `width:100%` wrapping sibling of
the field row, where the row's `align-items:flex-end` mis-stacked the wrapped strip and
the textarea and the parent `gap` double-applied, producing an oversized/odd gap. The
`.av-composer-input` textarea **auto-grows** — `Composer`
resets its height to `auto` then sets it to `scrollHeight` on every text change
(a `useLayoutEffect`, so it fires on skill-completion `setText` too, not just
keystrokes); CSS gives it `box-sizing:border-box` + `overflow-y:auto` so it scrolls
past the `max-height:200px` cap. **Pasted images** show as a thumbnail strip inside
the field: `.av-composer-attachments` > `.av-composer-attachment` (img +
`.av-composer-attachment-remove` hover ×). Empty state `.av-empty` >
`.av-empty-{mark,title,desc,hint}` (kbd chips in the hint).

Message (`MessageBubble.tsx`): `.av-message` + role `.av-message-{assistant,user,
system,error}`; role microlabel `.av-message-eyebrow` (**"Error" only** now — the
user turn carries NO "You" label, told apart from the agent by bubble shape/tint,
Claude-Code-app style); body `.av-message-text` (prose caps at `--av-measure`);
streaming caret `.av-cursor`. Attached user images render in a
`.av-message-images` > `.av-message-image` strip. The **turn rail** is a rounded
role-tinted `::before` spine on `.av-message` (no longer a border). It is now
**hidden on the assistant** too (`.av-message-assistant::before { display:none }`,
`padding-left` reclaimed) — the agent voice reads as plain prose; the blue rail was
noise. The **user** turn also drops the rail (`::before { display:none }`) and renders as a
self-sized, right-aligned, `--av-user`-tinted bubble (`width: fit-content`,
`margin-left:auto`, capped `max-width`). A message with no text and no thinking
renders `null` (no empty stub). The transcript is **full-width**:
`.av-message-list-inner` has `max-width:none` (no narrow centered column), so tool
cards/diffs span the lane while prose stays readable via the per-message
`--av-measure` cap. Markdown
(`markdown.tsx`): `.av-md`, `.av-md-{p,h,ul,ol,quote,hr,code-inline,link,strong,em}`.

Thinking (`ThinkingIndicator.tsx`): `.av-thinking` > `.av-thinking-dots` >
`.av-thinking-dot` ×3 + `.av-thinking-label`. (Indicator, not a text panel —
Phase 0 finding #1: Opus redacts cleartext thinking.)

Collapsible (`Collapsible.tsx` — every tool card wraps one): `.av-collapsible`
(`.av-open`/`.av-closed`) > `.av-collapsible-header` (button) > `.av-caret`
(SVG chevron, `.av-caret-open` rotates it) + `.av-collapsible-title` +
`.av-collapsible-aside`; body `.av-collapsible-body` (conditionally mounted →
entrance-animated, not height-animated). Todo marks are drawn SVGs
(`TodoMark` in ToolCard.tsx), colored via `currentColor` on `.av-todo-mark`.

**Aggregated tool runs** (`ToolGroup.tsx`): a run of consecutive `tool` messages
collapses into ONE summary row (Claude-Code style), **collapsed by default**.
`.av-tool-group` (`.av-open`/`.av-closed`) > `.av-tool-group-header` (button) >
`.av-caret` + `.av-tool-group-icons` (deduped per-tool SVGs) +
`.av-tool-group-summary` ("2 Read · 1 Bash") + `.av-tool-group-status`
(`-ok`/`-error`/`-pending` > `.av-tool-group-status-dot`) + `.av-tool-group-count`;
expanded body `.av-tool-group-body` holds the individual `.av-tool-card`s. A lone
tool renders as a plain card (no wrapper).

Tool card (`ToolCard.tsx`): `.av-tool-card` + `.av-tool-<name-lowercased>` +
`.av-tool-errored`. Header `.av-tool-header-inner` > `.av-tool-icon` (SVG per
tool, `tool-icons.tsx`) + `.av-tool-name` + `.av-tool-summary`; status
`.av-tool-status` + `.av-tool-status-{ok,error,pending}` > `.av-tool-status-dot`
(+ `.av-tool-progress` "n/m" for TodoWrite, `.av-sr-only` text for a11y).
Bodies: `.av-tool-bash{,-desc,-cmd,-out,-prompt}`, `.av-tool-summary{-body,-line}`,
`.av-tool-detail{,-toggle}`, `.av-tool-generic{,-section,-label,-json}`,
`.av-tool-out-error`, `.av-tool-empty`. Todos `.av-tool-todos` > `.av-todo` +
`.av-todo-{completed,in_progress,pending}` > `.av-todo-mark` + `.av-todo-text`.
Task `.av-tool-task{,-meta,-agent,-desc,-prompt,-result}`.

Diff (`ToolDiff.tsx` — **Monaco**, `renderSideBySide:false`): `.av-diff` >
`.av-diff-head` (`.av-diff-path` + `.av-diff-kind`, which reads
"new file · N lines" for Write) + `.av-diff-editor`. Code (`CodeBlock.tsx` —
**Monaco**): `.av-code-block` > `.av-code-head` (`.av-code-lang` +
`.av-code-copy`, `.av-code-copied` flash). The theme skins the frames; Monaco
paints the content with the `orchestra-dark`/`orchestra-light` themes from
`monaco-theme.ts` (never stock `vs-dark`).

Permission (`PermissionDialog.tsx`): `.av-permission-backdrop` (blurred) >
`.av-permission-dialog` (glass panel, app `.dialog` language; `max-height:
min(80vh,720px)` + flex column so it never overflows the viewport, body scrolls
as a safety net) > `.av-permission-header` (`.av-permission-eyebrow` with
`.av-permission-icon` chip + `.av-permission-queue`) /
`.av-permission-title` (`.av-permission-tool`) / `.av-permission-subtitle` /
`.av-permission-input` / `.av-permission-actions` / `.av-permission-deny{,-label}`
/ `.av-permission-reason`. **Deny is the safe first action; Allow is never
auto-focused and Escape denies** (component-enforced). The dialog gets
`.av-permission-dialog-question` (wider, `max-width:720px`) when it hosts an
AskUserQuestion.

AskUserQuestion (`AskUserQuestionCard.tsx`): `.av-question{,-title,-block,-header,
-text,-options,-option,-option-active,-option-label,-option-desc,-option-other,
-other-input,-actions}` plus paging chrome `.av-question-{steps,step,step-current,
step-done,progress,actions-spacer}`. **Multiple questions PAGE one at a time**
(step-dot rail up top, `N of M` + Back/Next in the footer, Submit only on the
last page once every page is answered); a **single** question renders directly
with no paging chrome. `.av-question-block` is the scrolling region so the
step-rail and actions stay pinned.

Buttons: `.av-btn` + `.av-btn-{primary,danger,ghost}` (permission/question actions
and the interrupt button share this family).

Controls (`AgentControls.tsx`): `.av-controls` > `.av-controls-interrupt`
(+`.av-controls-interrupt-dot`) + `.av-controls-menus` holding two `AvMenu`s
(model / permission mode — no field labels; tinted icons carry the meaning).

AvMenu (`AvMenu.tsx` — the view's dropdown primitive): borderless trigger
`.av-menu-trigger` (+`-open`, `-icon`, `-label`, `.av-menu-chevron`) opening a
PORTALLED `.av-menu-panel` (fixed, opens upward, dark glass in every theme —
it lives outside `.av-view`, so `--av-*` tokens do NOT resolve there; item
tints are literal hexes) > `.av-menu-item` (+`-active`, `-icon`, `-body`,
`-label`, `-desc`) + `.av-menu-check`. Keyboard: arrows/Enter/Escape, roving
highlight while focus stays on the trigger.

Composer skills autocomplete: `.av-ac` (absolute above `.av-composer-field`) >
`.av-ac-item` (+`-active`) > `.av-ac-name` + `.av-ac-desc` +
`.av-ac-source{,-project,-user}`; footer `.av-ac-hint` with kbd chips. The
composer input is MONO at code size (a command line, not a web form).

Turn footer (`TurnFooter.tsx`): `.av-turn-footer` (+`-running`/`-error`/`-live`) >
`.av-turn-stat` (`.av-turn-stat-value` + `.av-turn-stat-label`); `.av-turn-spinner`;
error `.av-turn-{error-icon,error-label,error-detail,error-spinner,running-label}`.

## Accessibility contract

- Every interactive element in `.av-view` gets a visible focus ring (`:focus-visible`
  box-shadow). Do not remove it.
- WCAG AA verified both themes on the real classes: body 15+:1, dim/tool-name
  ≥5.5:1, footer/faint metadata ≥4.7:1.
- All motion is inside `@media (prefers-reduced-motion: reduce)` guards.
- Components own the semantics (`aria-expanded` on collapsible headers,
  `role="dialog"`/`aria-modal` on the permission dialog, `role="status"` on the
  footer); the theme only styles.

## Inactive-pane hiding (Monaco leak guard)

An inactive `.av-view` is `display: none` (`agent-view-theme.css`), NOT just the
A2 layer's `visibility: hidden`. xterm respects ancestor `visibility`, but
Monaco's editors paint into overlay/view layers that set their own `visibility`
and sit in a GPU stacking context — so a Read/Edit tool card's diff kept
painting ON TOP of the terminal when the Structured tab was backgrounded.
`display: none` is the only reliable cross-compositor stop; the pane is inactive
so nothing needs measuring while hidden, and Monaco relayouts from its
ResizeObserver on re-show (verified in the packaged app: diff re-renders full
width after a tab round-trip).

## Perf / measurement safety

- Rows are measured by `offsetHeight` and carry `contain: layout style`. Keep
  vertical margin on `.av-message` / `.av-tool-card` (the measured content),
  NEVER on `.av-row`, so a row's height is a pure function of its content.
- Collapsible-body reveal + dialog entrance animate `opacity`/`transform` only.
- A5 runs a CDP performance trace on a long streaming session (hundreds of
  messages, injected via `window.__injectAgentEvent`) to confirm ~60fps —
  virtualization windowing, RAF delta batching, and per-bubble memoization are
  what hold it; the theme layer adds no per-frame cost.
