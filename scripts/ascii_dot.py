#!/usr/bin/env python3
"""Image -> ASCII dot-matrix with grid rulers
Usage: python ascii_dot.py <image_path|base64:xxx|stdin> [width] [height] [invert]
stdin mode: echo base64 | python ascii_dot.py stdin <width> <height> [invert]
Output: dot-matrix with top column ruler (digit every 10 cols),
        left row ruler (digit every 5 rows), coords (col,row) origin top-left.
"""
import sys, base64, io
from PIL import Image

CHARS = " .:-=+*#%@"          # bright -> dark (default)
CHARS_INV = "@%#*+=-:. "      # dark -> bright (invert, for dark-background images)

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
    width = int(sys.argv[2]) if len(sys.argv) > 2 else 80
    height = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    invert = (len(sys.argv) > 4 and sys.argv[4] == "1")
    chars = CHARS_INV if invert else CHARS

    img = load_image(src).convert("L")
    ar = img.height / max(img.width, 1)
    h = min(height, max(10, int(width * ar * 0.5)))  # char ~2x pixel height
    img = img.resize((width, h), Image.LANCZOS)
    px = img.load()

    rows = []
    for y in range(h):
        line = "".join(chars[min(9, (255 - px[x, y]) * 10 // 256)] for x in range(width))
        rows.append(line)

    col_ruler = "".join(str((i // 10) % 10) if i % 10 == 0 else " " for i in range(width))
    print(col_ruler)
    print("-" * width)
    for i, line in enumerate(rows):
        marker = str((i // 5) % 10) if i % 5 == 0 else " "
        print(f"{marker}|{line}")
    print(f"# DOTMATRIX {width}x{h} invert={int(invert)} col-ruler=top digit every 10, row-ruler=left digit every 5")
    print("# COORD format: (col,row) e.g. (30,8). Origin top-left.")

if __name__ == "__main__":
    main()
