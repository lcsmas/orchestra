"""PURE-PAINT: the primary CTA's gradient and the secondary's flat fill."""
from PIL import Image
SP="/tmp/claude-1000/-home-lmas--orchestra-worktrees-orchestra-clever-orca-e97278a5/f49950f7-67d4-46b5-815b-82440ed6d49d/scratchpad"
im=Image.open(f"{SP}/shots/after.png").convert("RGB")
def px(x,y): return im.getpixel((x,y))
def hexs(t): return "#%02x%02x%02x"%t

# Primary button occupies roughly x 406..546, y 366..399 (from the render).
print("PRIMARY CTA vertical scan (styles.css:139 linear-gradient 180deg #7ab4ff -> #4a8cff):")
col=476
vals=[]
for y in range(366,400,4):
    c=px(col,y); vals.append((y,c)); print(f"  y={y}  {hexs(c)}")
top=[c for y,c in vals[:2]]; bot=[c for y,c in vals[-2:]]
print(f"  top≈{hexs(top[0])}  bottom≈{hexs(bot[-1])}")
grad = top[0] != bot[-1]
print(f"  GRADIENT PRESENT: {grad}  (a flat fill would render identical top/bottom)")
# Direction: 180deg means LIGHTER at top, darker at bottom.
print(f"  direction correct (top lighter than bottom): {sum(top[0])>sum(bot[-1])}")

print("\nSECONDARY CTA (styles.css:2455 background var(--bg-3)=#1a1f26):")
# Secondary 'Scratch session' around x 560..700
for x,y in [(600,382),(620,375),(650,390)]:
    print(f"  ({x},{y}) {hexs(px(x,y))}")

print("\nCONTROL known-inert: two points inside the SAME secondary fill must match")
a,b=px(600,382),px(602,384)
print(f"  {hexs(a)} vs {hexs(b)} -> {'RETURNS ZERO' if a==b else 'noisy/at-edge'}")
print("CONTROL known-good: primary vs secondary must DIFFER")
c,d=px(476,382),px(600,382)
print(f"  {hexs(c)} vs {hexs(d)} -> {'DETECTS' if c!=d else 'FAILS'}")
