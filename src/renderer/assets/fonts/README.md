# Bundled fonts

## orchestra-symbols.woff2

A subset of **Adwaita Mono** (GNOME's monospace font, based on Iosevka),
licensed under the SIL Open Font License 1.1 (see `OFL.txt`).

Only the symbol codepoints Claude Code emits in its TUI are kept — circled
numbers (U+2460–24FF), dingbat circled numbers (U+2776–2793), and a handful of
marks/arrows/checks. Latin text is intentionally excluded so the terminal's
primary monospace font is used for everything else; this face is scoped to those
codepoints via `unicode-range` in `styles.css`.

Its circled-number glyphs carry the monospace 0.6em advance, so xterm renders
them at the cell width instead of squishing a proportional fallback glyph
(Noto Sans Symbols, 1em advance) down to fit — the cause of the cramped,
mismatched circled numbers.

Regenerate with:

```sh
pyftsubset /usr/share/fonts/adwaita-mono-fonts/AdwaitaMono-Regular.ttf \
  --unicodes='U+2022,U+2026,U+2192,U+2713,U+2717,U+25B8,U+2460-24FF,U+2776-2793,U+2780-27BF' \
  --layout-features='*' --flavor=woff2 \
  --output-file=orchestra-symbols.woff2
```
