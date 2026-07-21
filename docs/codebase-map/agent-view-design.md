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

## Theming — light/dark

Dark is the default and matches the app exactly. The view goes light when EITHER
the OS asks (`prefers-color-scheme: light`) OR `.av-view` / an ancestor carries
`data-agent-theme="light"`. An explicit `data-agent-theme="dark"` re-asserts dark
so a settings toggle beats the OS in both directions. Dark is the primary
requirement; light is complete but best-effort (the rest of the app is dark-only).

All colours are `--av-*` tokens defined on `.av-view`. **Reference the tokens,
never raw hex.** Roles: `--av-surface{,-raised,-sunken}`, `--av-hairline{,-strong}`,
`--av-text{,-dim,-faint}`, conversation hues `--av-{assistant,thinking,tool,
tool-active,user,task}`, states `--av-{add,remove,error,warn}` (+ `-bg`),
`--av-code-{bg,border}`, `--av-focus-{border,ring}`, motion `--av-ease{,-out}`,
type `--av-fs-*` / `--av-lh-prose` / `--av-measure`.

## The real class contract (enumerated at integration)

Shell (`StructuredView.tsx`): `.av-view` (+`.active`) → `.av-message-list` →
`.av-message-list-inner` → `.av-row`. Composer `.av-composer` / `.av-composer-input`
/ `.av-composer-send`. Empty state `.av-empty`.

Message (`MessageBubble.tsx`): `.av-message` + role `.av-message-{assistant,user,
system,error}`; body `.av-message-text`; streaming caret `.av-cursor`. The **turn
rail** is the role-tinted left border on `.av-message`. Markdown (`markdown.tsx`):
`.av-md`, `.av-md-{p,h,ul,ol,quote,hr,code-inline,link,strong,em}`.

Thinking (`ThinkingIndicator.tsx`): `.av-thinking` > `.av-thinking-dots` >
`.av-thinking-dot` ×3 + `.av-thinking-label`. (Indicator, not a text panel —
Phase 0 finding #1: Opus redacts cleartext thinking.)

Collapsible (`Collapsible.tsx` — every tool card wraps one): `.av-collapsible`
(`.av-open`/`.av-closed`) > `.av-collapsible-header` (button) > `.av-caret`
(`.av-caret-open`) + `.av-collapsible-title` + `.av-collapsible-aside`; body
`.av-collapsible-body` (conditionally mounted → entrance-animated, not height-
animated).

Tool card (`ToolCard.tsx`): `.av-tool-card` + `.av-tool-<name-lowercased>` +
`.av-tool-errored`. Header `.av-tool-header-inner` > `.av-tool-name` +
`.av-tool-summary`; status `.av-tool-status` + `.av-tool-status-{ok,error,pending}`.
Bodies: `.av-tool-bash{,-desc,-cmd,-out,-prompt}`, `.av-tool-summary{-body,-line}`,
`.av-tool-detail{,-toggle}`, `.av-tool-generic{,-section,-label,-json}`,
`.av-tool-out-error`, `.av-tool-empty`. Todos `.av-tool-todos` > `.av-todo` +
`.av-todo-{completed,in_progress,pending}` > `.av-todo-mark` + `.av-todo-text`.
Task `.av-tool-task{,-meta,-agent,-desc,-prompt,-result}`.

Diff (`ToolDiff.tsx` — **Monaco**, `renderSideBySide:false`): `.av-diff` >
`.av-diff-head` (`.av-diff-path` + `.av-diff-kind`) + `.av-diff-editor`. Code
(`CodeBlock.tsx` — **Monaco**): `.av-code-block` > `.av-code-head` (`.av-code-lang`
+ `.av-code-copy`). The theme skins the frames; Monaco paints the content.

Permission (`PermissionDialog.tsx`): `.av-permission-backdrop` > `.av-permission-dialog`
> `.av-permission-header` (`.av-permission-eyebrow` + `.av-permission-queue`) /
`.av-permission-title` (`.av-permission-tool`) / `.av-permission-subtitle` /
`.av-permission-input` / `.av-permission-actions` / `.av-permission-deny{,-label}`
/ `.av-permission-reason`. **Deny is the safe first action; Allow is never
auto-focused and Escape denies** (component-enforced).

AskUserQuestion (`AskUserQuestionCard.tsx`): `.av-question{,-title,-block,-header,
-text,-options,-option,-option-active,-option-label,-option-desc,-option-other,
-other-input,-actions}`.

Buttons: `.av-btn` + `.av-btn-{primary,danger,ghost}` (permission/question actions
and the interrupt button share this family).

Controls (`AgentControls.tsx`): `.av-controls` > `.av-controls-interrupt`
(+`.av-controls-interrupt-dot`) + `.av-controls-field` (`.av-controls-label` +
`.av-controls-select` `.av-controls-{model,mode}`).

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

## Perf / measurement safety

- Rows are measured by `offsetHeight` and carry `contain: layout style`. Keep
  vertical margin on `.av-message` / `.av-tool-card` (the measured content),
  NEVER on `.av-row`, so a row's height is a pure function of its content.
- Collapsible-body reveal + dialog entrance animate `opacity`/`transform` only.
- A5 runs a CDP performance trace on a long streaming session (hundreds of
  messages, injected via `window.__injectAgentEvent`) to confirm ~60fps —
  virtualization windowing, RAF delta batching, and per-bubble memoization are
  what hold it; the theme layer adds no per-frame cost.
