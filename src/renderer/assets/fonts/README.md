# Bundled terminal fonts

## jetbrains-mono-{regular,bold}.woff2

**JetBrains Mono** (OFL-1.1, see `JetBrainsMono-OFL.txt`) — the primary monospace
face for the terminal. Bundled so the terminal looks identical on every machine
instead of falling back to whatever the OS provides. xterm uses the bold weight
for bold cells.

## orchestra-symbols.woff2

A subset of **Adwaita Mono** (OFL-1.1, see `OFL.txt`) covering the symbol
codepoints JetBrains Mono lacks — circled numbers (U+2460–24FF), dingbat circled
numbers (U+2776–2793), ballot box (U+2610), dingbat asterisks/stars, and a few
arrows/triangles Claude emits in its TUI. Its glyphs share the monospace cell
advance, so they line up with JetBrains Mono instead of being squished by xterm's
WebGL renderer. Scoped to those codepoints via `unicode-range` in `styles.css`
and listed first in the terminal `fontFamily`.

### Why both

JetBrains Mono has no circled numbers; the symbol face fills exactly the gaps.
Both share the same cell metrics so the terminal grid stays aligned.

### Regenerate

```sh
# primary face
pyftsubset JetBrainsMono-Regular.ttf --output-file=jetbrains-mono-regular.woff2 \
  --flavor=woff2 --unicodes='*'      # (or just convert TTF→woff2 wholesale)

# symbol gap-filler
pyftsubset /usr/share/fonts/adwaita-mono-fonts/AdwaitaMono-Regular.ttf \
  --unicodes='U+2022,U+2026,U+2190-2193,U+2380-23BF,U+23F4-23F7,U+2460-24FF,U+25A0-25FF,U+2610-2612,U+2700-27BF' \
  --layout-features='*' --flavor=woff2 --output-file=orchestra-symbols.woff2
```
