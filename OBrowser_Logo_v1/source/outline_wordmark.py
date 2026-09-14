"""Emit original vector outlines for the installed Avenir Next Demi Bold font.

No font file is copied into the deliverables. Output is consumed by apply_patch.
"""
import json
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

font = TTFont("/System/Library/Fonts/Avenir Next.ttc", fontNumber=2)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
scale = 76 / font["head"].unitsPerEm
pen = SVGPathPen(glyphs)
x = 0
for char in "OBrowser":
    name = cmap[ord(char)]
    glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))
    x += font["hmtx"].metrics[name][0] * scale - 1.3
print(json.dumps({"path": pen.getCommands(), "advance": round(x + 1.3, 3), "font": font["name"].getDebugName(6)}))
