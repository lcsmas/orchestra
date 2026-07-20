"""PURE-PAINT evidence: sample the SHIPPED pixels for each colour/background
rule, taken from the real `after.png` capture rather than a synthetic widget.

These properties are layout-neutral: a measured delta is the WRONG instrument
and would report zero for a perfectly working rule. What proves them is that
the rendered pixel equals the ported token value.
"""
from PIL import Image
import sys
SP="/tmp/claude-1000/-home-lmas--orchestra-worktrees-orchestra-clever-orca-e97278a5/f49950f7-67d4-46b5-815b-82440ed6d49d/scratchpad"
im=Image.open(f"{SP}/shots/after.png").convert("RGB")
W,H=im.size

def px(x,y): return im.getpixel((x,y))
def hexs(t): return "#%02x%02x%02x"%t
def near(a,b,tol=6): return all(abs(x-y)<=tol for x,y in zip(a,b))

# Expected tokens (styles.css :root, mirrored into theme.css)
BG   =(0x0b,0x0d,0x10)   # --bg
BG2  =(0x12,0x15,0x1a)   # --bg-2  card background
TEXT =(0xe6,0xe9,0xef)   # --text
DIM  =(0x8b,0x95,0xa7)   # --text-dim
BORDER=(0x24,0x2a,0x33)  # --border

checks=[]
# Card interior (card 0 spans roughly x 297..506, y 434..495 in this capture).
checks.append(("card background = --bg-2 (styles.css:4326)", px(480,470), BG2))
# Pane background outside the cards.
checks.append(("pane background = --bg (styles.css:2441 ctx)", px(100,700), BG))
# Card border: sample the 1px edge at the card's left boundary.
for x in range(290,305):
    c=px(x,470)
    if near(c,BORDER,10):
        checks.append((f"card border = --border @x={x} (styles.css:4327)", c, BORDER)); break
else:
    checks.append(("card border = --border (NOT FOUND in scan)", px(297,470), BORDER))

print(f"{'rule':58} {'sampled':9} {'expected':9} verdict")
print("-"*95)
allok=True
for name,got,exp in checks:
    ok=near(got,exp)
    allok&=ok
    print(f"{name:58} {hexs(got):9} {hexs(exp):9} {'MATCH' if ok else 'MISMATCH'}")

# CONTROLS.
# KNOWN-GOOD: two points that MUST differ (card interior vs pane bg) — proves
# the sampler can detect a difference at all.
a,b=px(480,470),px(100,700)
print(f"\nCONTROL known-good (card vs pane bg must DIFFER): {hexs(a)} vs {hexs(b)} -> {'DETECTS' if a!=b else 'FAILS: probe blind'}")
# KNOWN-INERT: two points inside the same flat region MUST match — proves the
# sampler can return zero and is not just reporting noise everywhere.
c,d=px(100,700),px(120,720)
print(f"CONTROL known-inert (two pane-bg points must MATCH): {hexs(c)} vs {hexs(d)} -> {'RETURNS ZERO' if c==d else 'FAILS: noisy'}")
