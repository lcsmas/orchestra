# Sidebar BODY — GTK4 vs Electron pixel audit

**Commit audited: `ce14f2b`** (integration tip `gtk4-native-port` at time of capture).
**Report only — no `*.rs`, no `theme.css`, no UI code was modified.**

Scope: the sidebar body, everything **below** the header button row. The sidebar
header button row and toolbar icon glyphs are EXCLUDED (a sibling agent was
actively rewriting them; findings there would be stale on arrival).

---

## How this was produced

Both frontends were driven into the **same seeded state at the same window size
(1600×1000)** and captured at the same commit:

- GTK: `orchestra-gtk --remote-control` with `ORCHESTRA_GTK_MOCK=1`, run inside
  its **own headless sway** (never the user's session).
- Electron: `seed-store.mjs` mirrors `mock.rs` into a `store.json`, driven over
  CDP in its own headless sway.
- `docs/visual-reference/recapture.sh` regenerated **both halves together** —
  a half-regenerated set compares a fresh frontend against a stale one.

**Freshness.** `check-fresh.sh` FAILED against the committed set on arrival: those
captures were taken at `bf0b85d` and 24+ rendering files had changed since. Every
verdict below is from captures regenerated at `ce14f2b`. No stale evidence was used.

**Build provenance.** `cargo build -p orchestra-gtk --release` with `RC` captured on
its own line, then the **artifact** verified rather than the exit code: binary mtime
6s before use, and `strings` grep carrying **both** a known-present control
(`ws-row-`, 1 hit) and a known-absent control (`zzznonsensecontrol`, 0 hits) in the
same command, so the probe itself was audited.

### Two harness defects found and worked around

1. **The pinned capture row was stale.** `recapture.sh:24` pins `ws-row-ws-4`, but
   `ws-4` is **auto-selected at boot** on this tip, so the driver's already-active
   guard correctly hard-failed the run. Re-pinned via env override to
   `ws-row-ws-mc-1` (mid-list, verified not-active at boot) — no tracked file edited.
2. **`recapture.sh` is mode 644** while every sibling script is 755 → `./recapture.sh`
   returns RC=126 "Permission denied". Invoked via `bash` instead.

Both are owned by the integration agent and have since been fixed there.

### The measurement rule applied throughout

**Colour claims use regional dominance, never a single sample point**, and each
states its sample size. A point sample cannot characterise a surface that has rows,
hover or selection painted over it — precision on an unrepresentative sample yields
a sharper *wrong* number and more confidence in it. Three separate point-sample
artifacts were propagated across the swarm during this session and all three were
withdrawn after regional re-measurement, including one that would have made a defect
**worse** if acted on (see D3).

### What is NOT comparable, and why

**Selected-state pairs are state-mismatched and no verdict is drawn from them.**
`drive-gtk.py` honours `ORCHESTRA_CAPTURE_ROW`; `drive-electron.mjs` does **not** —
the string does not occur in that file at all (0 occurrences, verified with a
positive control in the same command). It takes the *first inactive row*. So
`*-workspace-selected` / `*-main-pane` / `*-toolbar` silently compare **different
workspaces** while looking perfectly rigorous. All verdicts below are drawn from the
**boot-state full-window pair**, which is genuinely matched.

**Fixture divergence is not a UI defect.** `mock.rs` and `seed-store.mjs` have
drifted, so some text/values differ for reasons that are not rendering bugs. These
are called out explicitly rather than filed as defects (see "Not defects" below).

---

## Ranked defects — worst first by user-visible impact

### D1 — Sidebar is 75px too wide (22%)
**DIFFERS.** Electron sidebar content is **339px**; GTK is **414px**.
Measured as the strongest vertical edge at mid-height, then confirmed by
column-dominance over 780 rows at 100% consistency per column.
This is the single largest geometric difference in the app and it displaces the
origin of every main-pane surface to its right.

### D2 — Section titles lose their colour coding
**DIFFERS.** ORCHESTRATORS and SCRATCH are colour-coded in Electron and grey in GTK.

| Header | Electron | GTK |
|---|---|---|
| ORCHESTRATORS | `(126,231,135)` = `#7ee787` green | `(139,149,167)` = `@text_dim` grey |
| SCRATCH | `(227,179,65)` = `#e3b341` amber | `(139,149,167)` = `@text_dim` grey |
| ORCHESTRA (repo) | `(139,149,167)` grey | `(139,149,167)` grey — **matches** |

**This comparison carries its own positive control**: the repo header is grey on
*both* sides and measured identically, proving the sampler reads colour faithfully
and that the two mismatches above are real rather than instrument error. Glyph pixel
counts are identical between sides (32/10/9), so the type is right and only the hue
is wrong.

**Root cause:** Electron scopes colour per section —
`.orchestrator-section .repo-name { color: #7ee787 }` and
`.scratch-section .repo-name { color: #e3b341 }` (`styles.css`). GTK has
**neither class** (0 occurrences of `orchestrator-section` / `scratch-section`), so
both titles fall through to `.repo-name`'s `@text_dim`.
Note both hex literals *do* exist in `theme.css` (2× each) but only on
`.released-pill` / `.branch-chip` — the values are present, the scoping is not.

### D3 — Sidebar divider is a 3px seam where Electron is 1px
**DIFFERS — and the obvious fix is wrong.** Column dominance over 780 rows, 100%
consistency per column:

| | Electron | GTK |
|---|---|---|
| x=414 | — | `(27,27,27)` neutral grey, 100% |
| x=415–416 | — | `(36,42,51)` **border token, exactly correct**, 100% |
| x=339 | `(36,42,51)` 100% — the entire divider | — |

GTK **does** paint the correct border token. The defects are structural, not
chromatic: an **extra 1px stock `GtkPaned` separator** at x=414 that Electron does
not have at all, plus a border **2px wide where Electron is 1px**.
⚠️ Recolouring the `(27,27,27)` column to the border token — the fix implied by a
"wrong divider colour" report — would produce a **3px-wide border**, i.e. degrade it.
The fix is to suppress the Paned separator and halve the border.

### D4 — Repo git-status line renders as a full-width grey slab
**DIFFERS.** GTK paints a solid **`(56,56,56)` bar, 404px wide × 18px tall**
(x=6→409, y=327→344) across the entire sidebar width under each repo header.
Electron has **no background at all** there — `(18,22,27)`, i.e. the sidebar base,
with only text. This is the most visually intrusive difference in the body: an
unstyled full-bleed grey band with no Electron counterpart.

### D5 — Empty-state renders literal glyphs and loses bold *(user-reported — CONFIRMED)*
**DIFFERS.** The user flagged this from a live screenshot; confirmed at source and
by rendered metrics.

- **GTK** (`sidebar/widgets.rs:277`):
  `"No agents running. Click ⚡ Scratch for a quick throwaway session, or + Repo to map a git repo."`
- **Electron** (`Sidebar.tsx:1421`):
  `No agents running. Click <strong>Scratch</strong> for a quick throwaway session, or <strong>Repo</strong> to map a git repo.`

GTK **invents two glyphs Electron never renders** (`⚡` and `+`) and **loses the bold
emphasis** on "Scratch"/"Repo". Rendered probe against the real `theme.css` confirms
`USE_MARKUP: False`, so bold is structurally impossible as written, and the font
resolves to **Adwaita Sans 13px** where Electron specifies **12px**.
Styling is absent on both sides for `.ws-empty-hint` (0 CSS rules either side,
verified with audited controls); Electron styles it inline —
`padding: 20px; color: var(--text-dim); fontSize: 12`.
*Fix is owned by the icons agent; this entry is the measured before-state.*

### D6 — Workspace list is 27% more vertically compressed
**DIFFERS.** The same 14 rows occupy **430px in GTK vs 588px in Electron**
(**30.7 vs 42.0 px/row**), measured from list top to the env-notice card.
Cross-checked independently by text-baseline span: **473px / 21 text lines (GTK)**
vs **561px / 24 text lines (Electron)**.

Per-line height is nearly identical (22.5 vs 23.4px), so **text size is not the
cause** — GTK renders *fewer* lines. Contributing: `.ws-pills` in GTK is only
`margin-top: 2px`, missing Electron's `gap: 5px` + `flex-wrap: wrap` +
`flex-basis: 100%`, and `.ws-row` has **no base geometry rule** at all where
Electron sets `.ws-item { padding: 4px 14px }`.

### D7 — Env-notice link is a raised button, not an inline link
**DIFFERS.** "Set API key…" geometry:

| | Electron | GTK |
|---|---|---|
| Size | **69×11px** | **258×30px** |
| Style | inline underlined text, accent `(110,168,255)` | raised grey push-button, own line |

Electron renders it **inline inside `.env-notice-detail`**, flowing after the body
text (`Sidebar.tsx:2228`, `.env-notice-link { background: transparent; padding: 0;
text-decoration: underline }`). GTK renders a block `GtkButton` below the text —
~3.7× wider and ~2.7× taller.
Card background itself **MATCHES**: `(32,32,30)` vs `(31,31,30)`, within 1/255.

### D8 — Usage-bar labels are not uppercased
**DIFFERS.** GTK renders `5h / 7d / Fable`; Electron renders `5H / 7D / FABLE`.
**Root cause:** Electron's `.usage-bar-label { text-transform: uppercase;
letter-spacing: 0.04em }`. GTK's rule is
`.usage-bar-label { color: @text; font-weight: 600 }` — **neither property present**.

This is a genuine omission, not the "property parses but does nothing" trap:
`text-transform: uppercase` is **observably working** elsewhere in GTK — `.repo-name`
uses it and the section headers render uppercase from lowercase source strings
(`"Orchestrators"` at `widgets.rs:294` → "ORCHESTRATORS" on screen). That is an
observed positive control, not an assumption.

### D9 — Section count badge is a filled chip, not plain text
**DIFFERS.** Electron's `.repo-count` sets **colour only** (`var(--text-dim)` +
tabular-nums, no background). GTK's `.pill.repo-count` adds
`background-color: @bg_4`, rendering a filled chip.
Confirmed in pixels: the GTK badge region contains **90 samples of `(34,41,51)`**
(the `@bg_4` fill) out of 450; the matching Electron region contains **none** —
only background tones.

### D10 — `.setup-pill.failed` text colour, and `.running` variant missing
**DIFFERS.**
- `failed`: Electron `background: rgba(220,80,80,0.18); color: #ffb4b4` (pale pink
  text). GTK `background-color: alpha(@red,0.2); color: @red` — `@red` is `#ff6b6b`,
  a saturated red. Wrong text colour.
- `running`: Electron has `.setup-pill.running { background: rgba(110,168,255,0.18);
  color: #b8d4ff }`. **GTK has no such rule** — the amber/blue running variant is
  absent (inventory row 64 confirmed).

Base pill geometry **MATCHES** (`font-size: 9px; font-weight: 600; padding: 0 5px;
border-radius: 999px`); GTK letter-spacing is `0.2px` vs Electron `0.3px`.

### D11 — Sidebar footer: no icons, missing Resources link and version stamp
**DIFFERS.** Electron's `.sidebar-footer` has **four icon+label links** —
Resources, `lcsmas/orchestra` (+external-link icon), Logs, Linear — plus a
`.sidebar-footer-version` stamp (`Sidebar.tsx:2264–2307`).
GTK's `build_footer` (`sidebar/mod.rs:1256`) creates **label-only**
`Button::with_label` widgets for **GitHub / Logs / Linear** only:
- **no icons on any footer link**
- **no Resources link** (moved to the sidebar header, `mod.rs:655`)
- **no version stamp** in the footer (version lives in a status strip)
- class is `.footer-link`, Electron's is `.sidebar-footer-link` — so
  `.sidebar-footer-link.active` (accent when the Resources page is open) and the
  `svg:last-child { opacity: 0.6 }` external-link dimming have **no GTK counterpart**
  (0 occurrences each side of the other's name, controls verified).

### D12 — Two competing widgets both named `sidebar-footer`
**DIFFERS (structural).** The live widget tree returns **`sidebar-footer` twice** —
the sidebar's own footer and `app.rs`'s box where usage bars actually mount. This is
inventory row 76's "two competing footers" confirmed **on a running app** rather than
inferred from source, and it makes `sidebar-footer` ambiguous as a harness selector.

---

## Surfaces that MATCH

| Surface | Evidence |
|---|---|
| **Sidebar background** | GTK `(18,21,26)` vs Electron `(18,21,27)` — 1/255. **18,356 samples** GTK region-modal. A swarm claim that GTK was `(26,31,37)` (one token step too light) **did not replicate** and was withdrawn; it came from a single point that landed on the env-notice card, which really is `(32,32,30)` and is the 2nd most common colour in that region. |
| **Active-row accent bar** | Both render a **2px** bar at x=0–1 in `(110,168,255)`. CSS matches: `background: bg-3 + border-left-color: accent` on both. |
| **Env-notice card background** | `(32,32,30)` vs `(31,31,30)`. |
| **MERGED pill** | Purple text/border present and correctly coloured; 176px vs 181px of purple. |
| **Design tokens** | `--red #ff6b6b`, `--text-dim #8b95a7`, `--accent #6ea8ff`, `--green #5bd68b`, `--yellow #ffc857`, `--text #e6e9ef` — **identical literals** both sides. The palette was ported faithfully; the defects above are per-rule application, not wrong tokens. |
| **Insights strip** | Purple sparkle icon, bold title, right-aligned meta — layout matches. |
| **Base `.pill` geometry** | 9px / 600 / `0 5px` / pill radius, matching Electron `.setup-pill`. |

## CANNOT-VERIFY

| Surface | Reason |
|---|---|
| Row **hover** state | No pointer in the headless seat; the remote-control harness cannot synthesize hover. |
| **Selection**-dependent chrome beyond the accent bar | The two drivers select **different workspaces** (see above). Any verdict would be drawn from a state-mismatched pair. |
| Archived rows / bulk-delete progress | With 14 fixture rows the archived block sits **below the visible fold**; reaching it needs a scroll step the current drive does not perform. |
| Sidebar **scroll/width drag** behaviour | Requires pointer drag on the Paned separator — same headless-seat limit as hover. |
| Insights **overlay** (not the strip) | Reachable only recently; treated as never-seen per coordinator instruction and out of the sidebar-body region. |

## NOT defects — fixture divergence, not rendering

These differ between the two captures but are **data**, not UI bugs. Filing them
would send someone to fix a renderer that is behaving correctly:

- **Env-notice body text.** Electron's comes from the real backend
  (`src/main/env-status.ts:20`, a 3-sentence Linear string); GTK's comes from
  `mock.rs:641` (`"Branch names carrying issue keys can link to Linear."`).
  `seed-store.mjs` contains **zero** "Linear" references (control-verified), so the
  Electron side renders backend text the GTK mock never supplies. The
  4-line-vs-1-line difference is fixture drift. **The button-vs-link defect (D7) is
  real and independent of this.**
- **The "GitHub CLI not configured" card** exists only in the GTK mock; the real
  backend emits a single `linear` item.
- **Usage-bar percentages** (41/63/22/12 vs 35/66/98) and the **EX** bar, **Insights
  dates**, **row memory sizes**, **version pills** — all fixture values.
- **Status-dot colours on individual rows** (e.g. `fix-status-dot` green in GTK, grey
  in Electron) — the two fixtures assign different statuses to the same row ids.

⚠️ `mock.rs` and `seed-store.mjs` have drifted apart. The README states "if you
change `mock.rs`, update `seed-store.mjs` in the same change" — that has not held,
and every hour of drift makes this pair weaker evidence.

---

## Capture manifest

All captures regenerated at `ce14f2b`. **10 files, 10 unique md5s, 0 duplicates** —
a drive step that silently no-ops yields a byte-identical screenshot that looks like
a successful capture and proves nothing, so duplicates are a hard failure.

| File | md5 | What it SHOWS |
|---|---|---|
| `gtk-sidebar-fw.png` | `216576061237ad6e98b4246ad4a3c0a1` | GTK sidebar, boot state, cropped from the full-window capture |
| `electron-sidebar-fw.png` | `d50e1c9a187004cd83f69f9d27d0ca9a` | Electron sidebar, same state/size |
| `gtk-rows.png` | `c043ff56d440e83f381cfb6b7a7c948a` | GTK repo workspace rows + pill strips |
| `elec-rows.png` | `71db513d6dd47cc7c5081fff7f940a9a` | Electron repo workspace rows + pill strips |
| `gtk-notices.png` | `92874297a2d4c9156a55b411ae951f82` | GTK env-notice cards (D7 button) |
| `elec-notices.png` | `fb3cef20eb235d96b019effe05414ca9` | Electron env-notice card (D7 inline link) |
| `gtk-bottom.png` | `3cac4d78b192d7905c44fc9a80aaefc1` | GTK usage bars + Accounts + footer |
| `elec-bottom.png` | `79c1aa4ff0a185197f63b2f839b39b42` | Electron usage bars + footer links |
| `gtk-insights.png` | `84e2f9ea72fd52753905ceefc64b318c` | GTK Insights strip |
| `elec-insights.png` | `ec7ab8f041b033ebf13cb193474cc67d` | Electron Insights strip |

Source full-window captures (regenerated by `recapture.sh`, manifest in
`CAPTURED-AT.json`): `gtk-full-window.png` `04b7d1d0c89a63ca9d05e95d1afeb05d`,
`electron-full-window.png` `9085b282b0bd09f1c97185cc8bff160e`.

---

## One correction to a claim about MY region

A cross-cutting audit reported a **systemic background-layer inversion** and
instructed agents *not* to file per-widget colour findings, attributing deltas to
that root cause instead.

Re-measured before applying it. For the sidebar it **does not replicate**: GTK
`(18,21,26)` vs Electron `(18,21,27)` over 18,356 region samples. The claim was
withdrawn after independent re-measurement by two rigs. The main-pane half of it
(GTK `(11,13,16)` vs Electron `(26,31,38)`, two token steps too dark) **is** real,
but lives outside this region.

Recording it because of what the instruction would have done here: attributing
sidebar colour deltas to a phantom root cause would have **suppressed D2, D4, D9 and
D10 as inherited rather than filed as defects**. The sidebar base is correct, so
every colour delta inside it is genuinely its own defect.
