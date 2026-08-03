#!/usr/bin/env python3
"""Image -> ASCII dot-matrix with grid rulers (hi-res edition)
Usage: python ascii_dot.py <image_path|base64:xxx|stdin> [width] [height] [invert] [charset]
  charset: 10 = classic 10-level (@%#*+=-:. ), 16 = 16-level (full precision)
stdin mode: echo base64 | python ascii_dot.py stdin <width> <height> [invert] [charset]
Output: dot-matrix with top column ruler (digit every 10 cols),
        left row ruler (digit every 5 rows), coords (col,row) origin top-left.
"""
import sys, base64, io
from PIL import Image

CHARS10 = " .:-=+*#%@"           # 10-level, bright -> dark (default)
CHARS10_INV = "@%#*+=-:. "       # 10-level inverted (dark backgrounds)
CHARS16 = " .'`^,:;Il!i><~+_-?][}{1)(|\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"  # 16 sampled
CHARS16_INV = "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunrxjft/\|()1{}[]?-_+~<>i!lI;:,'`. "  # 16 inverted

def load_image(src: str):
    if src.startswith("base64:"):
        b64 = src[len("base64:"):]
        return Image.open(io.BytesIO(base64.b64decode(b64)))
    elif src == "stdin":
        return Image.open(io.BytesIO(base64.b64decode(sys.stdin.read().strip())))
    else:
        return Image.open(src)

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "stdin"
    width = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    height = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    invert = (len(sys.argv) > 4 and sys.argv[4] == "1")
    level = int(sys.argv[5]) if len(sys.argv) > 5 else 10

    if level == 16:
        chars = CHARS16_INV if invert else CHARS16
        levels = 16
    else:
        chars = CHARS10_INV if invert else CHARS10
        levels = 10

    img = load_image(src).convert("L")
    ar = img.height / max(img.width, 1)
    # hi-res: char aspect ~0.5, so h = width * ar * 0.5; cap at requested height
    h = min(height, max(10, int(width * ar * 0.5)))
    img = img.resize((width, h), Image.LANCZOS)
    px = img.load()

    rows = []
    for y in range(h):
        line = "".join(chars[min(levels - 1, (255 - px[x, y]) * levels // 256)] for x in range(width))
        rows.append(line)

    col_ruler = "".join(str((i // 10) % 10) if i % 10 == 0 else " " for i in range(width))
    print(col_ruler)
    print("-" * width)
    for i, line in enumerate(rows):
        marker = str((i // 5) % 10) if i % 5 == 0 else " "
        print(f"{marker}|{line}")
    print(f"# DOTMATRIX {width}x{h} invert={int(invert)} level={levels} col-ruler=top digit every 10, row-ruler=left digit every 5")
    print("# COORD format: (col,row) e.g. (30,8). Origin top-left.")


def tile_mode(src, tiles_x, tiles_y, w_per, h_per, invert=1):
    """分块点阵：把图切成 tiles_x × tiles_y 块，每块输出独立点阵块。
    输出格式：每块一行头部注释 # TILE x,y 后跟该块点阵（10级字符）。
    """
    img = load_image(src).convert("L")
    W, H = img.size
    bw = max(1, W // tiles_x)
    bh = max(1, H // tiles_y)
    chars = CHARS10_INV if invert else CHARS10
    out = []
    for ty in range(tiles_y):
        for tx in range(tiles_x):
            box = (tx * bw, ty * bh, min((tx + 1) * bw, W), min((ty + 1) * bh, H))
            tile = img.crop(box).resize((w_per, h_per), Image.LANCZOS)
            px = tile.load()
            rows = []
            # 块主色（RGB 平均，用于渲染调色）
            tile_rgb = tile.convert("RGB").resize((1, 1), Image.LANCZOS).getpixel((0, 0))
            for y in range(h_per):
                rows.append("".join(chars[min(9, (255 - px[x, y]) * 10 // 256)] for x in range(w_per)))
            out.append(f"# TILE {tx},{ty} size={w_per}x{h_per} color=#{tile_rgb[0]:02x}{tile_rgb[1]:02x}{tile_rgb[2]:02x}")
            out.extend(rows)
    print("\n".join(out))



if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "tile":
        # python ascii_dot.py tile <img> <tiles_x> <tiles_y> <w_per> <h_per> [invert]
        tile_mode(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]),
                  int(sys.argv[7]) if len(sys.argv) > 7 else 1)
    else:
        main()
