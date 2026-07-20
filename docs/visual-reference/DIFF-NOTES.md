# Visual diff notes — Electron vs GTK (M4-V0)

Walked from the committed reference pair in this directory: both frontends
showing the **same fixture state** at the **same window size (1600×1000)**.
Electron is the visual source of truth (`src/renderer/styles.css`, 4322 lines);
GTK is `native/orchestra-gtk/src/theme.css` (1109 lines).

This is the V1–V4 work list. Each item cites the rule on **both** sides so the
owner can see what to change, not just that something differs. Line anchors are
from the tip this pair was captured at — verify before editing, they drift.

**Scope note:** V0 captured and analysed only. Nothing here has been restyled.

---

## A. Sidebar rows and density — *highest visual impact*

> **STATUS: DONE (M4-V1).** All five items were still unfixed at tip when V1
> started — none had been silently resolved. Two corrections to the notes
> below, both found while porting; they are left inline rather than rewritten
> so the original claim and its correction stay comparable.
>
> - **A1 named the wrong rule.** `.ws-item { padding: 0 }` is not what governed
>   row geometry. Sidebar rows are `ListBoxRow`s under the *generic*
>   `listbox row { padding: 7px 12px; border-radius: 8px; margin: 1px 6px }`
>   (theme.css:110-114) — so GTK rows were rounded, margined **cards** where
>   Electron rows are full-bleed **strips**. Setting `.ws-item` padding alone
>   would not have fixed it.
> - **A2 was also a wrong-token bug.** Beyond the missing accent bar, the active
>   background used `@bg_4` (#222933); `styles.css:1138` is `--bg-3` (#1a1f26).
>   Confirmed by pixel sampling: (34,41,51) → (26,31,38).
> - **A4 needs NO deviation.** The note speculates GTK CSS has no `animation`.
>   It does: GTK4 CSS supports `@keyframes`, so `ws-dot-pulse` was ported
>   verbatim and *proved* to animate (6 captures at 220 ms, 6 distinct hashes).
>
> Because a 2px left border on a rounded, margined card floats inset instead of
> reading as an edge marker, the sidebar list opts out of the generic rule via
> `#sidebar-list` — scoped, so the queue / diff file list / sound picker /
> branch popover keep the card look.

**A1. Rows have no vertical padding of their own.**
Electron `.ws-item { padding: 4px 14px }` (styles.css:1128) gives every row 4px
top/bottom and a 14px text inset. GTK `.ws-item { padding: 0 }`
(theme.css:233) — all row spacing is whatever the inner box happens to
contribute. In the pair this reads as GTK rows sitting tighter and starting
further left; the whole list loses the calm rhythm the Electron sidebar has.
The 14px horizontal inset is the single biggest alignment difference: GTK
content starts at roughly the container edge, Electron is indented.

**A2. No active-row accent bar.** *(Directly visible in the
`*-sidebar-selected.png` pair, where a row is selected on both sides.)*
Electron `.ws-item.active` gets `background: var(--bg-3)` **plus**
`border-left-color: var(--accent)` against a always-present
`border-left: 2px solid transparent` (styles.css:1130,1137-1140) — so selecting
a row never shifts its text, the transparent border reserves the space. GTK
`.ws-row.active { background-color: @bg_4 }` (theme.css:328) — background only,
no accent edge. Add the 2px transparent-by-default left border to the GTK row
or the selected row reads as "slightly lighter" rather than "selected".

**A3. Row hover state is missing.**
Electron `.ws-item:hover { background: var(--bg-3) }` (styles.css:1136). No
`.ws-row:hover` background rule exists in theme.css — the only hover rules are
on the child icon buttons (`.ws-icon-btn:hover`, theme.css:324). Rows feel dead
under the pointer in GTK.

**A4. Status dots: wrong size, no glow, no pulse.**
| | Electron (styles.css:1223-1236) | GTK (theme.css:134-144) |
|---|---|---|
| size | `8px × 8px`, `border-radius: 50%` | `9px × 9px`, `border-radius: 5px` |
| running | `box-shadow` + `animation: ws-dot-pulse 1.6s ease-out infinite` | flat `background-color: @green` |
| waiting | `box-shadow: 0 0 8px rgba(255,200,87,.55)` | flat |
| error | `box-shadow: 0 0 8px rgba(255,107,107,.5)` | flat |
| align | `margin-top: 4px` (aligns to first text line) | none |

GTK dots are 1px larger and entirely flat. The running-dot pulse is the
sidebar's main sign of life in Electron and is absent in GTK. GTK CSS has no
`animation` for this; if the pulse can't be done in CSS it needs a tick-driven
redraw or an explicit recorded deviation (plan §0).

**A5. Dot has no top-alignment, so it centres against multi-line rows.**
Electron pairs `.ws-item { align-items: flex-start }` with the dot's
`margin-top: 4px`. GTK has neither, so on rows that wrap to a pill line the dot
floats mid-row instead of tracking the name. Visible on `fix-status-dot` and
`chime-volume` in the pair.

---

## B. The pill zoo — shape and colour both differ

**B1. Pills are rounded rectangles, not lozenges.**
Electron `.merged-pill` / `.released-pill` use `border-radius: 999px`
(styles.css:311,329) — full capsules. GTK `.pill { border-radius: 6px }`
(theme.css:280). Every pill in the GTK sidebar is a soft rectangle. This is the
most obvious single difference in the sidebar crop.

**B2. Pills have no border, and the fills are the wrong hue.**
| pill | Electron | GTK |
|---|---|---|
| merged | `color #c4a8ff`, `background rgba(179,139,255,.12)`, `border 1px rgba(179,139,255,.32)` (styles.css:316-318) | `alpha(@accent,.18)` + `@accent` — **blue, not purple**, no border (theme.css:290) |
| released | `color #7ee787`, `background rgba(126,231,135,.10)`, `border 1px rgba(126,231,135,.32)` (styles.css:333-335) | `alpha(@green,.18)` + `@green`, no border (theme.css:291) |

The 1px translucent border is what makes Electron's pills read as objects
rather than colour blocks. GTK has none on any pill. The merged pill is also
plainly the wrong colour family — purple in Electron, accent-blue in GTK.

**B3. Pill typography is a size too big and not uppercase.**
Electron: `font-size: 9px`, `font-weight: 600`, `letter-spacing: .2px`,
`text-transform: uppercase` (styles.css:312-315) → renders "MERGED". GTK:
`font-size: 10px`, no weight/letter-spacing/transform (theme.css:281) →
renders "merged". Compare the two sidebar crops at `usage-poll-retry`: Electron
shows a small uppercase `MERGED`, GTK a larger lowercase `merged`.

**B4. Pill horizontal padding differs.** Electron `padding: 0 5px` +
`margin-left: 6px` (styles.css:309-310); GTK `padding: 0 6px` (theme.css:282)
with the gap left to the box. Minor next to B1–B3 but worth doing in the same
pass.

---

## C. Account badge — barely styled in GTK

Electron `.account-badge` (styles.css:3101-3115) is a pill:
`padding: 1px 7px`, `border-radius: 999px`, `font-size: 10.5px`,
`background: rgba(255,255,255,.05)`, `border: 1px solid transparent`,
`color: var(--text-dim)`, `gap: 4px`, `font-variant-numeric: tabular-nums`.
GTK `.account-badge { font-size: 12px; font-weight: 600 }` (theme.css:1056-1059)
— **no background, no radius, no padding, and 1.5px larger type**.

In the pair the `work` / `perso` / `default` badges are plain bold text in GTK
and subtle grey chips in Electron. Because the fixture pins accounts on ws-1 and
ws-2, this is fully exercised — it is not a missing-data artifact.

---

## D. Repo / section headers

**D1. Headers are not uppercase and are too large.**
Electron `.repo-header { font-size: 10px; text-transform: uppercase;
letter-spacing: .8px; color: var(--text-dim) }` (styles.css:942-951) →
`ORCHESTRA`, `MOBILE-CLUB`. GTK `.repo-name { font-size: 12px; font-weight:600;
color: @text }` (theme.css:176-180) → `orchestra` in full-brightness 12px text.
Electron's headers recede as labels; GTK's compete with the row names. Clearly
visible comparing the two sidebar crops.

**D2. Header padding.** Electron `padding: 4px 14px 3px` (asymmetric bottom,
14px inset matching the rows); GTK `.repo-header { padding: 3px 6px }`
(theme.css:173-175) — again the ~8px inset shortfall from A1.

---

## E. Env-notice tray

Electron `.env-notice` is a flat tinted band: `padding: 9px 12px`,
`background: rgba(255,200,87,.06)`, **no border, no radius**, with siblings
separated by `border-top: 1px solid var(--border)` (styles.css:816-825), an
icon (`.env-notice-icon`, yellow), a `.env-notice-title` at 11.5px, and body
text plus a link.

GTK `.env-notice` is a **bordered rounded card**: `border: 1px solid
alpha(@yellow,.3)`, `border-radius: 6px`, `background alpha(@yellow,.1)`,
`padding: 4px 8px` (theme.css:365-370), and the content is a single dim 11px
label (theme.css:371) — no icon, no bold title line, no link affordance.

Net: Electron shows a titled notice with an icon ("**Linear not configured**" +
explanatory body + "Set API key…"); GTK shows a boxed one-line sentence. Both
the container treatment (band vs card) and the internal hierarchy differ.

---

## F. Toolbar

Electron `.toolbar` (styles.css:1787-1799): fixed `height: 48px`,
`padding: 0 14px`, `gap: 10px`, `border-bottom: 1px solid var(--border)`, and a
`linear-gradient` background plus `backdrop-filter: blur(14px) saturate(140%)`.
The GTK toolbar crop is a flat dark strip: no gradient, no blur, and the
branch chip is the only styled element.

GTK CSS cannot do `backdrop-filter`. The gradient and the 1px bottom border
**can** be matched; the blur is a candidate for a recorded §0 deviation rather
than an attempted emulation. Note the Electron toolbar's translucency is what
lets the terminal tint through — matching the gradient alone gets most of the
way.

---

## G. Dialog — the largest single-surface gap

Compare `electron-dialog.png` with `gtk-dialog.png`:

**G1. No backdrop.** Electron `.dialog-backdrop` dims and blurs the whole
window (`background: rgba(6,8,12,.6)` + `backdrop-filter: blur(14px)`,
styles.css:2465-2469) — the app is visibly behind the dialog. The GTK dialog is
its own toplevel with no scrim, so there is no depth cue at all.

**G2. No icon chip.** Electron renders a circular red-tinted warning glyph
above the title. GTK has none; the dialog opens straight onto the title.

**G3. The confirm button is generic, not destructive.** Electron's reads
**"Delete 3"** in a filled red destructive style. GTK's reads **"Confirm"** in
default chrome with a focus ring. Two separate causes:
  - the label: `dialogs.rs:273` uses the plain `confirm` helper with
    `confirm_label: "Confirm"` — `confirm_labeled` already exists
    (`dialogs.rs:286`) and takes a custom label, so the call site simply isn't
    using it;
  - the tone: theme.css has `.orch-dialog.tone-error .dlg-title { color: @red }`
    (theme.css:475) which tints the *title*, but there is no destructive
    **button** style at all. Electron's `button.danger` is styles.css:165-173.

**G4. Container chrome.** Electron `.dialog` (styles.css:2478-2492) is
`width: 420px`, `padding: 22px 22px 18px`, `border-radius: var(--radius-lg)`,
a layered `box-shadow` (`0 24px 64px rgba(0,0,0,.65)` + inset highlight), and a
`dialog-pop` entry animation. The GTK dialog is smaller, more tightly padded,
square-shouldered, and has no shadow or entry animation.

**G5. Typography.** Electron: title 15px/600 with `letter-spacing: -.01em`,
message 13px `line-height 1.5`, detail in dim 8px-offset text
(styles.css:2526-2547). GTK's title/message/detail are closer in size to each
other, flattening the hierarchy.

---

## H. Usage bars / footer

In the full-window pair the Electron usage strip labels read `5H` / `7D` /
`FABLE` (uppercase, small) against GTK's `5h` / `7d` / `Fable` / `EX` — the
same uppercase-label convention as D1. GTK also surfaces a fourth `EX` row
where Electron folds extra-usage differently, and the GTK footer carries a
`backend: mock v0.1.0 · frontend v0.5.84` debug strip Electron has no analogue
for (expected — that one is a GTK-only affordance, **not** a defect).

---

## Suggested split for V1–V4

Roughly equal-weight, minimal file contention (all in `theme.css` except G3):

- **V1 — rows & dots (A1–A5).** Highest perceived impact. Row padding/inset,
  hover, active accent border, dot geometry + glow, dot alignment.
- **V2 — pills & account badge (B1–B4, C).** Radius, borders, uppercase
  typography, merged-pill hue, badge chip.
- **V3 — headers, env-notice, toolbar (D, E, F).** Uppercase header treatment,
  notice band vs card, toolbar gradient/border. Record the `backdrop-filter`
  deviation.
- **V4 — dialog (G1–G5).** Needs both `theme.css` work and the `dialogs.rs`
  call-site change for the destructive label; the backdrop may need a
  structural decision (scrim window vs accepted deviation).

Every V-agent should re-run both capture scripts (see `README.md`) after its
change and diff its surface against the committed Electron reference — the
fixture is deterministic, so a same-size recapture is directly comparable.

---

## ⚠️ CORRECTIONS — read before acting on ANY item above

Four anchors in this document were found wrong during M4-V execution, all the
same class: **the rule cited is not the rule in effect.** Porting a cited rule
produces a change that "matches the citation" and renders wrong — which passes
a careless review because a rule *was* cited.

**Before porting any value, confirm which rule actually governs the widget**
(cascade, specificity and generic element selectors can outrank the cited one),
and check the item is still true at tip.

| Item | Cited | Actually in effect | Found by |
|---|---|---|---|
| A1 | `.ws-item { padding: 0 }` (theme.css:233) | generic `listbox row { padding: 7px 12px; border-radius: 8px; margin: 1px 6px }` (theme.css:110-114) — GTK rows are rounded margined CARDS, Electron rows are full-bleed STRIPS | V1 |
| A2 | (accent bar only) | ALSO the wrong token: GTK `@bg_4` #222933 vs Electron `--bg-3` #1a1f26 (styles.css:1138) | V1 |
| D2 | `.repo-header { padding: 3px 6px }` (theme.css:173) | same generic `listbox row` — headers are ListBoxRows inside `#sidebar-list` | V3 |
| G3 | `button.danger` (styles.css:165-173) — a DIM OUTLINE | `button.danger-primary` (styles.css:2618-2626) — a FILLED RED GRADIENT; `Dialog.tsx:109` selects it via `tone==='danger' && kind==='confirm'` | V4 |
| **C** | `.account-badge` (styles.css:3101-3115) — a 999px chip | **`.account-badge.inline` (styles.css:3163-3191) CANCELS the chip**: `padding: 0`, no background/border/radius, 10px/500. Sidebar renders `account-badge inline` (AccountBadge.tsx:308,323,348). **The fix is the OPPOSITE of what this document says** — porting the chip makes GTK diverge from Electron while looking like parity work | V2 |

**One false limit, also corrected:** this document claims GTK CSS has no
animation and that the status-dot pulse needs a deviation. **It does support
`@keyframes`/`animation`** — V1 ported the Electron keyframes verbatim and
proved it animates (6 timed captures, 6 distinct hashes). *A deviation recorded
for a capability that exists is worse than no note: it teaches a false limit
that later gets cited as precedent.* Test before recording any deviation.

**Genuine GTK gaps confirmed so far:** `backdrop-filter` (blur/saturate) does
not exist in GTK4 CSS — affects the toolbar (F) and the dialog backdrop (G1).

**Method notes earned during execution:**
- The committed `gtk-*.png` have drifted behind tip. Capture your own BEFORE;
  the committed `electron-*.png` ARE current (`git log b3ac930..HEAD --
  src/renderer/ src/main/` is empty).
- Prove a baseline binary is uncontaminated by **grepping an embedded string**
  you introduced — mtimes are not enough, a rebuild can land between build and
  capture. Include a **known-present positive control in the same command**:
  zero hits alone is equally consistent with "strings found nothing at all".
- `drive-gtk.py` picked its target row nondeterministically (boot race). Pin it
  with `ORCHESTRA_CAPTURE_ROW`, which fails loudly if the row is absent.
- Run with `G_MESSAGES_DEBUG=all` to confirm zero CSS parse warnings — a rule
  that fails to parse is discarded silently and looks applied in source.
