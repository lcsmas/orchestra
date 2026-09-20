# #161 — Human-directed decision gates: UI mockups (Phase 1)

Selectable UI mockups for surfacing a **fleet question to the HUMAN** as a
first-class ask (issue #161). A gate whose recipient is the user renders in the
app: the question, options, and a reply box; the answer is written on the
`decision_gates` row (`resolved_by = human`) and the asker is re-woken. Amber
"needs your attention, nothing is broken" register (`--av-warn`), never the
modal-steal or the error red — same family as the #145 bus rows and the #64
inbox tray.

All three mirror Orchestra's real `av-*` design system (tokens verbatim from
`src/renderer/agent-view-theme.css`, both dark-default and light opt-in). Each
`.html` is self-contained; each `.png` is the headless render (dark over light).

| Variant | File | One-line tradeoff |
|---|---|---|
| **A — Inline quiet ask row** | [`variant-A-inline-row.html`](variant-A-inline-row.html) · [PNG](variant-A-inline-row.png) | Ask docked above the composer in the workspace that opened it (WakeRow/InboxTray idiom); most native, but only visible when that workspace is focused — the aging badge on its sidebar row is the only cross-workspace signal. |
| **B — Dedicated "Asks" tray** | [`variant-B-asks-tray.html`](variant-B-asks-tray.html) · [PNG](variant-B-asks-tray.png) | Fleet-wide "Asks" section pinned atop the sidebar aggregates every open gate; click → full answer panel. Best when the asker isn't your focus, but adds a new sidebar surface and needs #158 cross-run gates. |
| **C — Badge → panel** | [`variant-C-badge-panel.html`](variant-C-badge-panel.html) · [PNG](variant-C-badge-panel.png) | One quiet toolbar badge (count + oldest age) expands to a floating panel of all asks; smallest footprint, oldest ask expanded inline. Middle ground — a hidden panel is one more click and easy to miss. |

## Design tensions covered

- **Where it surfaces** — inline in the pane (A) vs. a dedicated sidebar section (B) vs. a badge-expanded popover (C).
- **Reply affordance** — inline options + free-text box in every variant; A/C keep it compact, B is a full click-through panel with context.
- **Nudge / aging** — A: gentle amber pill on the sidebar row (`⌛ 22m`, darkening as it ages); B: per-card age + a fleet count pill; C: the badge itself carries count + oldest wait. None steal focus or open a modal.

## Rendering

PNGs rendered offscreen via headless Chromium (`--headless --screenshot`, no
compositor, no visible window — per the `headless-sway-e2e` decision: a pure
static page needs only a headless browser). Re-render:

```bash
cd docs/mockups/161-human-gates
for v in A-inline-row B-asks-tray C-badge-panel; do
  chromium-browser --headless --no-sandbox --hide-scrollbars \
    --force-color-profile=srgb --disable-gpu --window-size=1240,1640 \
    --screenshot="variant-${v}.png" "file://$PWD/variant-${v}.html"
done
```

## Phase 1 only

Mockups for a human pick. No `src/` code, nothing wired. LEAD routes the pick
back; Phase 2 implements the chosen variant.
