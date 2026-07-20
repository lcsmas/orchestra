# T6 — Terminal fidelity: VTE vs xterm.js configuration

**Status: source-derived, UNBUILT.** No build has been attempted in this
worktree (`native/target` does not exist at all). Nothing below depends on a
build or on running the app — every claim is anchored in source or in a probe
of the installed VTE binary. The one claim that would need a running app (that
finding 1 *causes* the user's reported symptom) is labelled as unproven.

The user's report was: *"the VTE is sometime buggy, some time it's scrambled,
maybe it's not configured for claude code"*. **The hypothesis is correct: this
is a configuration gap, not a rendering defect.**

---

## Finding 1 — character-width divergence (predicts the scrambling)

Electron aligns its width accounting to Claude/Ink's:

| | Anchor | Value |
|---|---|---|
| Electron | `src/renderer/components/Terminal.tsx:137` | `new Unicode11Addon()` |
| Electron | `src/renderer/components/Terminal.tsx:139` | `term.unicode.activeVersion = '11'` |
| Electron | `src/renderer/components/Terminal.tsx:109` | `allowProposedApi: true` (required for the above) |
| GTK | `native/orchestra-gtk/src/terminal/pane.rs:100-105` | no width call of any kind |

The renderer carries a comment (`Terminal.tsx:129-136`) written by whoever
debugged this first. Paraphrased: Claude measures with string-width (Unicode
11+), so emoji like ✅/❌ are width 2; xterm.js defaults to a Unicode 6 table
counting them as width 1; the disagreement makes a line wrap in Claude's model
but not in xterm's; Claude then erases its previous frame by the wrong number of
rows and **"old text is left in place and new text lands on top."**

That last clause *is* "sometimes it's scrambled". This is a mechanism that
**predicts** the reported symptom, not merely a plausible-sounding cause, and it
explains the intermittency: it only fires once an ambiguous-width glyph lands
near a wrap column. A screenshot of a healthy moment therefore proves nothing.

VTE's equivalent knob is `vte_terminal_set_cjk_ambiguous_width`, confirmed
exported by the installed library and present as the `cjk-ambiguous-width`
property. **The GTK pane never calls it.** Verified by a scan whose
known-present controls (`set_colors`, `set_font`, `set_scrollback`) were all
detected in the same pass, so the ABSENT result is sound rather than a silent
search failure.

**Caveat that must not be lost in the fix:** VTE's setter is *coarser* than
xterm's Unicode-11 table. It governs CJK ambiguous width; it may not cover the
emoji cases identically. Exact parity may require measuring specific glyph
advances rather than assuming one setter call closes the gap. Do not report this
item closed on the strength of the call alone.

## Finding 2 — the ANSI palette never followed the renderer (17/18 values)

`native/orchestra-gtk/src/terminal/mod.rs:47` claims the palette *"tracks the
renderer's `styles.css` terminal tokens"*. **That comment has rotted.** The
renderer moved to Ghostty's Tomorrow Night palette in
`src/renderer/term-theme.ts:10-31`; the GTK half never followed.

This is the comment-asserting-an-invariant trap: the comment suppresses the very
check that would catch the drift.

Computed mechanically from both sources (not read by eye):

| Role | GTK (`mod.rs:39-67`) | Electron (`term-theme.ts`) |
|---|---|---|
| background | `#0b0d10` | `#1a1f26` |
| foreground | `#e6e9ef` | `#e6e9ef` — **matches** |
| black | `#0b0d10` | `#1d1f21` |
| red | `#ff6b6b` | `#cc6666` |
| green | `#5bd68b` | `#b5bd68` |
| yellow | `#ffc857` | `#f0c674` |
| blue | `#6ea8ff` | `#81a2be` |
| magenta | `#c792ea` | `#b294bb` |
| cyan | `#7fdbca` | `#8abeb7` |
| white | `#e6e9ef` | `#c5c8c6` |
| brightBlack | `#333b47` | `#666666` |
| brightRed | `#ff8f8f` | `#d54e53` |
| brightGreen | `#7fe3a8` | `#b9ca4a` |
| brightYellow | `#ffd77e` | `#e7c547` |
| brightBlue | `#8fbcff` | `#7aa6da` |
| brightMagenta | `#d7b3f0` | `#c397d8` |
| brightCyan | `#a3ebdd` | `#70c0b1` |
| brightWhite | `#ffffff` | `#eaeaea` |

**17 of 18 differ; foreground is the sole match.** (An earlier verbal report of
mine said "all 18" — that was wrong, corrected here by computing the table
rather than eyeballing it.)

The background delta is also an instance of the wrong-background-layer error
class in §1 of the exact-parity plan: GTK paints `#0b0d10` where Electron paints
`#1a1f26`.

Fixable mechanically: port the values from `term-theme.ts`, and **fix the stale
comment in the same change** so the next reader is steered rather than reassured.

## Finding 3 — unset behavioural properties

Unset in the port, all supported by the installed VTE:
`bold_is_bright`, `allow_bold`, `audible_bell`, `text_blink`, `mouse_autohide`.
Lower confidence on user impact than 1 and 2 — listed as leads, not defects,
because I have not established what Electron does for each.

---

## Harness / environment claims

*Stated separately from the findings above, because a false claim about the
environment gets a real gate disabled, while a false claim about the subject
costs one re-measurement.*

- **VTE is not system-installed on this host.** Only `libvterm` (an unrelated
  library) is present. VTE comes solely from the `vte291-gtk4` RPM via
  `native/setup-localdeps.sh`. Consequence for the fleet: a worktree without
  `native/.localdeps` **cannot link VTE and cannot produce this binary at all**
  — so a green build claimed from such a worktree is claiming something
  impossible, which is a stronger constraint than "the build fails".
- **The RPM resolves to VTE 0.80.5**, not the 0.72 implied by the `vte4`
  `v0_72` feature gate (`native/orchestra-gtk/Cargo.toml:24`). Worth stating
  plainly: a feature gate naming a version the host does not ship is exactly the
  kind of thing someone later "fixes" in the wrong direction.
- **DEC 2026 (synchronised output) is NOT the cause.** The inherited project
  note holds at 0.80.5 — no synchronised-output symbols in the export table.
  Recorded because it was suspect 1 and deserves to be closed explicitly rather
  than silently dropped. Note my *string* probe for `2026` returning zero was
  **not** sufficient evidence on its own (a numeric mode need not appear as a
  string literal); the symbol-table check is what carries this.

### An instrument failure I hit, recorded because it is reusable

My first scan for VTE looked in this worktree's `native/.localdeps/prefix` and
returned **zero libraries** — which reads exactly like "VTE is missing from the
prefix". It was actually *the prefix not existing*. A positive control (0 total
`.so` files found; `isdir` → False) exposed it as an instrument failure rather
than a real absence.

**A zero from a path that does not exist is indistinguishable from a real
absence without that control.**

---

## Coverage — what I did NOT reach

Named explicitly, because silence reads as coverage:

- **Not reproduced live.** No PTY log read, no `stty` ground-truth on the child
  fd, no emulator replay. Findings 1 and 2 are confirmed *at source*; the causal
  link from finding 1 to the user's specific symptom is **strong but not
  demonstrated end-to-end.**
- **Font metrics (suspect 4) not measured.** `mod.rs:31` requests "JetBrains
  Mono 11" against Electron's `fontSize: 13` (`Terminal.tsx:100`) — these units
  are not comparable without measuring rendered cell advance, which needs a
  build. Unresolved, not cleared.
- **Finding 3 impact unassessed.**
