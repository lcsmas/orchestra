# Transient surfaces (dialogs / modals / popovers) — GTK vs Electron

**Verdict report only. Nothing was fixed.** Captured at `ce14f2b`
(`gtk4-native-port` tip) with a release binary rebuilt at that commit.

Scope: the confirm/destructive dialogs, the modal backdrop, the repo-scripts and
Linear modals (never previously compared to Electron), the branch picker, the
account login + accounts settings modals, sound settings, and the setup /
prompt-queue banners.

**Excluded by brief:** toolbar buttons and sidebar header icons (sibling agent
actively rewriting). Also excluded: sidebar/main-pane background and width
findings, which belong to the cross-cutting audit and whose ground is known
contaminated — see "What I deliberately did not measure".

---

## Evidence rules applied

- Every capture is md5-hashed; **12 captures, 12 distinct hashes, zero
  duplicates.** A drive step that silently no-ops still writes a valid PNG.
- Every surface asserts a **proof widget that exists only while that surface is
  open** before capturing. `wait_for` never trusts the click.
- The widget walker is **positively controlled** against `main-window` before
  any absence is believed; a walker keyed on the wrong reply field returns an
  empty set and every absence becomes a lie.
- A **main-window-size guard** rejects captures that silently fell back to the
  main window. This guard was **mutation-tested**: reverting the login-modal
  capture to its unnamed form made it fire and downgrade the surface to
  CANNOT-VERIFY. A check nobody has seen fail is not a check.

---

## Per-surface verdicts

| # | Surface | Verdict | Concrete difference |
|---|---|---|---|
| 1 | Dialog card geometry | **DIFFERS** | GTK **376×239**, Electron **420×215**. Source: `dialogs.rs:118 default_width(380)` vs `styles.css:2521 width:420px`. GTK is 44px narrower and 24px taller. |
| 2 | Dialog detail line | **DIFFERS** | GTK renders the detail paragraph at **(230,233,239)** — full brightness, identical to the message. Electron dims it to **(139,149,167)** via `.dialog-detail` (`styles.css:2573`, 12px + `--text-dim`). GTK merges both paragraphs into one label at 13px/full `@text`. |
| 3 | Dialog backdrop — **DIM** | **DIFFERS (defect)** | GTK paints **nothing**. Region scan (4,320 samples) of the surround, dialog-open vs no-dialog: Electron mean **32.7 → 18.2**, spread **214.7 → 13.7**. GTK **28.9 → 28.9**, spread **211.7 → 211.7** — statistically identical. Electron's `rgba(6,8,12,.6)` is a plain fill that GTK4 *can* paint. |
| 4 | Dialog backdrop — **BLUR** | **CANNOT-BE-IDENTICAL** | `backdrop-filter: blur(14px) saturate(120%)` has no GTK4 equivalent. Declared engine substitution. Filed separately from #3 so the closable half is not laundered by the unclosable one. |
| 5 | Dialog title tint removal | **MATCHES** ✅ | Confirmed **in pixels**, not source: title measures (230,233,239) on both sides on a `tone-error` dialog. Tone lives in the icon chip only. The recent removal was correct. |
| 6 | Dialog card gradient | **MATCHES** ✅ | GTK (28,33,40)→(20,23,29); Electron (27,31,39)→(20,23,28). Within 1/255 at every sampled step. |
| 7 | Dialog tone coverage | **DIFFERS** | Electron has **4** tones (`.dialog-icon-info/-success/-warning/-danger`, `styles.css:2538-2557`). GTK `Tone` enum has **3** (Info/Error/Success, `dialogs.rs:21-32`); `theme.css` defines only `tone-info/-success/-error`. **No `warning` tone exists.** |
| 8 | Dialog tone icons | **DIFFERS** | Electron draws inline SVG `ToneIcon`s. GTK uses **text glyphs** — `ⓘ U+24D8`, `⚠ U+26A0`, `✓ U+2713` (`dialogs.rs:41-43`). Same family of substitution that produced the toolbar-glyph defect. |
| 9 | Destructive button | **MATCHES** ✅ | Filled red gradient present and correct. GTK correctly ports `button.danger-primary` (`styles.css:2650`), *not* the dim outline `button.danger` that DIFF-NOTES G3 wrongly cites. |
| 10 | Repo scripts modal — width | **MATCHES** ✅ | GTK **636px** vs Electron `.repo-scripts-modal` **640px**. |
| 11 | Repo scripts modal — placeholders | **DIFFERS** | Electron shows multi-line bash **placeholder text inside each textarea**. GTK routes the same constants to `set_tooltip_text` (`repo_scripts.rs:157`) — **invisible until hover**; all three boxes render empty. Documented as deliberate (a GtkTextView has no placeholder, and seeding the buffer would persist on save), but the rendered result differs. |
| 12 | Linear settings modal — width | **MATCHES** ✅ | GTK **456px** vs Electron `.linear-settings` **460px**. |
| 13 | Linear settings — inline link | **DIFFERS** | Electron renders "personal API key" as an **inline link inside the sentence** (`LinearSettings.tsx`). GTK renders a **separate full-width button** reading "Open Linear API key settings…" (`linear.rs:101`) — different text, different position, breaks the sentence. |
| 14 | Sound settings — selected row | **DIFFERS** | Electron marks the **row**: `.sound-row.selected` → `background rgba(110,168,255,.1)` + `border-color rgba(110,168,255,.4)` (`styles.css:581`). GTK applies `.selected` **only to the radio dot** (`sound.rs:239-240, 285`). The selected row has **no background or border highlight**. |
| 15 | Sound settings — list chrome | **DIFFERS** | `.sound-list` scroll styling (`scrollbar-width: thin`, accent thumb, `styles.css:537-568`) and `.sound-meta` have **no GTK rules**. |
| 16 | Setup banner (failed + running) | **MATCHES** ✅ | Composited tint correct — see the retraction below. |
| 17 | Prompt queue banner | **MATCHES** ✅ | Renders with list + composer at the expected tint. |
| 18 | Accounts settings modal | **MATCHES** (structurally) | Renders full CRUD, config dir, inherit checkboxes, skills/MCP chips. No geometry defect found. |
| 19 | Account login modal | **MATCHES** (structurally) | Real VTE terminal, header, Close button. Terminal engine substitution is out of scope per brief. |
| 20 | Branch picker popover | **MATCHES** (structurally) | Panel, search field and list render. |
| 21 | New-workspace base popover | **CANNOT-VERIFY** | `base-picker` only exists while the new-workspace form is open; the mock fixture provides no path to open that form from the harness. |
| 22 | Context menus / right-click | **CANNOT-VERIFY** | The remote-control `click` op fires `Button`/`ListBoxRow`/`MenuButton` only; right-click gestures cannot be synthesized without a pointer. Would need a `SimpleActionGroup` hook like the DnD harness. |

---

## RETRACTED — a false defect I caught before filing

I measured `gtk-setup-banner-failed.png` as **(255,107,107) at 88.8% regional
dominance** — fully-saturated pink where Electron uses a 10% tint. That reads as
a clean, specific, actionable defect. **It was wrong.**

The alpha channel says **a=31/255 = exactly 0.12** — the CSS is correct. A
*widget-scoped* snapshot renders the banner with **nothing composited behind
it**, so a correct translucent tint reads as solid colour.

I confirmed the mechanism with an isolated 4-way A/B (`rgba` with and without
spaces, `alpha()`, and a solid control): **all three translucent forms rendered
`a=31`, the solid control `a=255`.** The positive control (MERGED pill, same
idiom, same 0.12 alpha) blends correctly to (44,44,64) in a window-scoped shot.

Banners are now captured **via `main-window`** so the tint composites. The fix
is in the driver, and the finding is a retraction rather than a defect.

**The general trap:** an RGB-only reading of a translucent surface cannot
distinguish "correct tint" from "opaque fill". Read the alpha channel, or
snapshot a parent.

---

## What I deliberately did not measure

The cross-cutting audit reported a wrong main-pane background assignment
(GTK bg vs Electron bg-3), a 75px sidebar width excess, and a divider colour
miss. Two of my captures (`gtk-dialog-over-window.png`, `gtk-branch-popover.png`)
show the whole window and would let me "find" those same defects again.

I did not, and my verdicts are structurally immune to them:

- Dialogs and modals are **their own toplevels with their own canvas**, so the
  75px sidebar displacement cannot reach an intrinsic card width.
- My text findings are **foreground glyph colours**; a wrong base shifts what is
  behind the text, not the glyph. Built-in control: title and message measured
  byte-identical (230,233,239) on both sides while the third line differed — a
  probe that demonstrably returns MATCH, so its non-match means something.
- **No verdict derives from a selected workspace row**, so the known
  `drive-electron.mjs` / `drive-gtk.py` row-pin mismatch does not apply.

## A near-miss worth recording

I nearly filed **two** width defects (Linear, repo-scripts) against the base
`.modal { width: 520px }` rule. The **operative** rules are
`.linear-settings { width: 460px }` and `.repo-scripts-modal { width: 640px }`,
and GTK renders 456/636 — i.e. both **MATCH**. A cited rule is not the operative
rule; the full cascade for the class the widget actually carries is what counts.

---

## Ranked by user-visible impact

1. **Dialog backdrop dim absent** (#3) — every modal in the app. Nothing dims,
   so a modal reads as a floating window rather than a focused surface, and the
   busy sidebar behind it stays fully legible and competes for attention. This
   is the single largest perceptual gap and **it is closable** — only the blur
   half is engine-limited.
2. **Dialog card 44px too narrow** (#1) — every dialog. Forces earlier text
   wrapping and a visibly taller, boxier card than Electron's.
3. **Detail line not dimmed** (#2) — every dialog with a detail line. The
   message/detail hierarchy collapses; secondary text shouts as loudly as
   primary.
4. **Sound settings selected row invisible** (#14) — the user cannot see which
   chime is selected except by a 7px dot.
5. **Missing `warning` tone** (#7) — any warning dialog silently renders with
   the wrong tone chip.
6. **Repo-scripts placeholders hidden in tooltips** (#11) — new users see three
   empty black boxes with no hint of expected content.
7. **Linear inline link became a separate button** (#13) — different copy and
   layout from Electron.
8. **Tone icons are text glyphs, not SVGs** (#8) — same substitution class as
   the toolbar defect; likely resolvable via the new icon pipeline.
9. **`.sound-list` scroll chrome absent** (#15) — cosmetic.

## Capture manifest

| md5 | file |
|---|---|
| `383f2e04970e1d614d0900eb4f0cbb07` | gtk-account-login-modal.png |
| `7ae863def3d45fba0099b86cd603eed5` | gtk-accounts-settings.png |
| `e250f07a5cda625ea83c4a2470dde393` | gtk-branch-popover.png |
| `4313653a6ca51c0d8f5a5ad07f197756` | gtk-dialog-destructive.png |
| `d3f15b61ac16faa18b78864700d03108` | gtk-dialog-over-window.png |
| `454921fa7cf721c35262ccb2e0a04e92` | gtk-linear-settings.png |
| `7f7b451c63ca7f6680158d36e2056347` | gtk-linear-settings-title.png |
| `d695b286d50f955b674874604f13a328` | gtk-queue-banner.png |
| `217d7921cdb81a96aa760e7c13e1d9af` | gtk-repo-scripts.png |
| `0bf28c2bcd8ace4b616565b45cae441c` | gtk-setup-banner-failed.png |
| `d394a577167b96eb955441cffd30a7b6` | gtk-setup-banner-running.png |
| `cd2ec6f548a1f978120fa7589e56b92c` | gtk-sound-settings.png |

Electron reference: `docs/visual-reference/electron-dialog.png`. It is stale by
`check-fresh.sh`, but **valid for this comparison** — verified that the only
`styles.css` change since its capture commit is +32 lines adding
`.orchestrator-pill`, `.ws-item.attach-target`, `.repo-header.detach-target`.
**Zero dialog/modal/popover selectors changed, and no deletions.**

Driver: `docs/visual-reference/drive-gtk-transients.py`,
harness `docs/visual-reference/capture-gtk-transients.sh`.
