# T2 — Type scale: measured parity between the GTK and Electron frontends

Covers user defects **2 ("font size")** and **3 ("font style")** from
`docs/gtk4-exact-parity-plan.md` §2.

Every number below is **measured on a running app**, never read from a
stylesheet. Both halves ran headless at 1600x1000 against the same fixture
(GTK `ORCHESTRA_GTK_MOCK=1`, Electron seeded by `seed-store.mjs`), with an
isolated `ORCHESTRA_HOME` on both sides.

---

## 1. Harness and tooling claims

*Separated from the findings deliberately: a false claim about a subject costs
one re-measurement, a false claim about an instrument silently invalidates
every result under it.*

**New: `get {prop:"font"}` in the GTK remote-control harness**
(`native/orchestra-gtk/src/remote_control.rs`). Reports family, size in px,
weight, style and stretch from the widget's own `PangoContext` — i.e. **after**
the CSS cascade. It also reports:

- `resolved_family` — the face Pango will actually shape with, obtained by
  loading the description through the context's font map. **This is not the
  same as `family`**, which echoes the declared stack ("Inter,Adwaita Sans,…").
  The distinction is load-bearing: with the family rule on `window` only, every
  label still *declared* Inter while 37 of them *resolved* Adwaita Sans.
- `size_is_absolute` — GTK CSS px yields an absolute description, so
  `size/PANGO_SCALE` is device px. A point-sized description would need the
  context resolution to convert; rather than assume 96dpi and emit a plausible
  wrong number, the flag is reported so a caller can reject the value.

**Deliberately NOT reported: letter-spacing.** It lives on Pango attributes,
not the font description, and there is no widget-level getter reflecting the
CSS-resolved value. Any number cheaply available would be a constant 0 —
indistinguishable from "this role sets no tracking" and wrong for the roles
that do. Letter-spacing below is therefore **read from the stylesheet and
labelled as read, not measured.**

### Instrument controls that ran

| Control | Purpose | Result |
|---|---|---|
| `main-window` present in tree walk | A walker returning empty would report every role NOT-FOUND — a broken instrument wearing the costume of a total-absence finding | PASS (978 nodes) |
| `.ws-item` count > 0 before reading the DOM | An SPA read at `did-finish-load` returns chrome only; "few elements" would look like a small clean result | PASS (14 rows) |
| Binary content grep with a known-present **and** known-absent string | `strings` returning 0 for "absent" and 0 for "instrument broken" are indistinguishable | PASS (new markers 3, control 1, negative 0) |
| CDP target URL checked against this worktree | ~19 sibling agents share this box; a port collision hands you someone else's app | PASS |
| Collapse button asserted on **state change** (14→11→14 rows), not on `ok:true` | A click on an already-correct widget returns ok while doing nothing | PASS |

### Two instruments that FAILED their audit — do not reuse them

1. **`document.fonts.check()` cannot detect a missing font.** It returned
   `true` for all ten families in the body stack, including seven that
   measurably fall back, because fallback always renders something. *A check
   that cannot fail is not evidence.* Replaced with a differential advance-width
   probe against a deliberately-absent family, which was itself audited: three
   independently-named absent families all measured exactly 296.13px while
   Inter, Cantarell and Adwaita Sans each differed.

2. **`fc-list` / `fc-match` gave the wrong answer about Inter.** `fc-match`
   never fails — it substitutes for any name — so it reported Noto Sans and
   looked authoritative. `fc-list` showed **0 Inter entries across 2673 fonts**
   (with a working positive control), which I initially read as "Inter is not
   installed, so Electron falls back too". That was wrong. Settled by
   Chromium's own paint-time oracle, `CSS.getPlatformFontsForNode`:

   ```
   .ws-name → familyName "Inter", postScriptName "Inter_500wght",
              isCustomFont: true, glyphCount 21
   ```

   Inter is loaded **from Google Fonts over the network** by `index.html`
   (`fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700`), which is why
   no Inter file exists on disk and why fontconfig cannot see it.

   **Consequence worth flagging beyond T2: the Electron UI's typeface depends
   on network access at runtime.** Offline or behind a firewall, Electron
   itself falls back to Cantarell — so the two frontends will diverge again on
   such a machine, in the opposite direction. Worth a decision separate from
   this work.

---

## 2. Findings

### 2.1 Root cause of "font style" — no family was declared at all

`theme.css` set `font-size` on `window` but **no `font-family` anywhere**.
Every label therefore inherited the `gtk-font-name` setting (`Adwaita Sans 11`
here) while Electron renders Inter. This is invisible to a CSS diff because the
divergence is in **a rule that is not there** — nothing conflicts, nothing
overrides, there is simply no declaration to find.

Measured: family differed on **21 of 21** text roles the two frontends share.

Two structural details that a `window`-scoped fix would have missed:

- Popovers, menus and dialogs are **separate GTK toplevels**. With the family
  on `window`, 37 labels (the branch popover and the usage-bars panel) still
  resolved Adwaita Sans — the app rendered two typefaces at once. The rule
  belongs on `*`.
- 17 sites said `font-family: monospace`, which fontconfig resolved to **Noto
  Sans Mono** where Electron uses **JetBrains Mono**.

### 2.2 Size and weight defects (each verified against Electron's computed value)

| Role | GTK before | Electron | Cause |
|---|---|---|---|
| `.ws-name` | 13px / 400 | **12px / 500** | no size or weight set; inherited `window`'s 13px |
| `.ws-context` | 10px / 400 | 10px / **500** | weight missing (styles.css:1650) |
| `.ws-tree-connector` | **12px** / 400 | **11px** / 400 | wrong literal (styles.css:1295) |
| `.host-name` | 10px / **600** | 10px / **500** | shared a rule with `.repo-name`, which is 600/0.8px; host header is 500/0.6px |
| `.repo-count` | **9px / 600** | **10px / 400** | styled as a `.pill`; in Electron these are **not pills** and inherit the header's type |
| `.host-count` | **9px / 600** | **10px / 400** | same cause |
| `.insights-row-sub` | **10px / 400** | **11px / 500** | wrong literal (styles.css:3673) |
| `.repo-sync-base` | Inter | **JetBrains Mono** | `var(--font-mono)` at styles.css:1239 not ported |
| `.caret` | flat 10px everywhere | **9 / 8 / 10 / 9px by parent** | size is parent-scoped in Electron, not set once on the class |

### 2.3 A structural divergence, not just a value

GTK's `ws-collapse` was a `Button::with_label` — the glyph was the button's own
label and carried **no `.caret` class**, so every `.caret` rule missed it by
construction. Electron nests `<span class="caret">` inside `.ws-collapse`
(Sidebar.tsx:1261). Changed to match the convention the repo's own repo/host
collapse buttons already use. The button's behaviour was re-verified by drive
(rows 14→11→14).

### 2.4 A dead rule, annotated rather than deleted

`.sidebar-title` is declared **twice**. The first (11px, dim) is overridden by a
later block (15px/700/0.2px accent) that wins on source order — and the later
one is **correct**, matching Electron's measured 15px/700/0.2px wordmark. The
dead block is kept with a comment: deleting it would destroy the finding, and
editing its values would change nothing while looking like a fix.

### 2.5 Reported, NOT changed

- **`.repo-tag-pill` at 9px** on one instance. This is the `⌘` coordinator
  indicator, which **deliberately reuses the class** (widgets.rs:1000-1004 says
  so) and has **no Electron counterpart** — there is no `⌘` and no
  `canOrchestrate` badge in the renderer. It has no reference value to match, so
  calling it a type defect would be wrong. The three real repo tags measure 8px,
  matching Electron.
- **Pill and dialog typography** were previously reported as matching. Re-derived
  here rather than inherited: `merged-pill`, `released-pill`, `setup-pill`,
  `unpushed-pill` all measure **9px/600 on both sides**. Confirmed.

---

## 3. Result

**20 of 21 shared text roles now match on size + weight + resolved family**
(from 0 of 21). Resolved faces app-wide: **Inter ×292, JetBrains Mono ×11**,
zero Adwaita Sans, zero Noto Sans Mono — the same two families Electron paints.

The one non-match is §2.5's GTK-only indicator.

## 4. Coverage — what this did NOT reach

Silence reads as coverage, so these are named explicitly:

- **Roles absent from the fixture.** The comparison covers the 21 classes
  present on *both* running apps. 54 GTK-only and 18 Electron-only classes were
  measured on their own side but have no counterpart in this state — dialogs and
  modals (separate toplevels, never opened by this drive), the Insights and
  Resources overlays' deeper panes, Linear settings, repo-scripts, and the
  welcome screen. Their GTK values are captured in the JSON artifacts; matching
  them needs a drive that opens each surface.
- **Letter-spacing is unmeasured on the GTK side** (§1). Values were ported by
  reading; a role whose tracking is wrong would not show up here.
- **Hover, focus and active states.** Type rarely changes across states, but
  this was not tested — the plan's §3.3 interaction harness is what would close
  it.
- **The terminal (VTE).** Owned by T6.

## 5. Reproducing

```sh
# GTK half — builds nothing, expects target/release/orchestra-gtk to be current
docs/visual-reference/measure-type-gtk.sh /tmp/type-gtk.json

# Electron half — expects dist-electron/ (npx vite build)
docs/visual-reference/measure-type-electron.sh /tmp/type-electron.json
```

Both launch their own headless sway and tear it down; neither ever puts a
window on the user's desktop.
