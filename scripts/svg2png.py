#!/usr/bin/env python3
"""mm-vision: SVG → PNG 渲染器（零系统依赖，仅 Pillow）
用法: python svg2png.py input.svg output.png [width]
适用于 mm-render 生成的受控 SVG（rect/circle/ellipse/polygon/line/text）。
"""
from PIL import Image, ImageDraw, ImageFont
import re, sys

def render_svg(svg_path, png_path, width=960):
    svg = open(svg_path, encoding='utf-8').read()
    wm = re.search(r'width="(\d+)"', svg); hm = re.search(r'height="(\d+)"', svg)
    if not wm or not hm:
        raise ValueError("SVG 缺少 width/height")
    W, H = int(wm.group(1)), int(hm.group(1))
    bm = re.search(r'<rect width="\d+" height="\d+" fill="([^"]+)"', svg)
    scale = width / W
    bg = bm.group(1) if bm else '#ffffff'
    img = Image.new('RGB', (int(W*scale), int(H*scale)), bg)
    d = ImageDraw.Draw(img)
    def px(x): return int(float(x)*scale)
    def py(y): return int(float(y)*scale)
    for m in re.finditer(r'<(rect|circle|ellipse|polygon|line|text)([^>]*?)/?>', svg):
        tag, attrs = m.group(1), m.group(2)
        def a(name):
            mm = re.search(name + r'="([^"]*)"', attrs)
            return mm.group(1) if mm else None
        try:
            if tag == 'rect':
                if not a('x') or not a('y'): continue
                x, y, w, h = px(a('x')), py(a('y')), px(a('width')), py(a('height'))
                fill = a('fill')
                if fill == 'none':
                    d.rectangle([x, y, x+w, y+h], outline=a('stroke') or '#888', width=int(a('stroke-width') or 1))
                else:
                    d.rectangle([x, y, x+w, y+h], fill=fill)
            elif tag == 'circle':
                cx, cy, r = px(a('cx')), py(a('cy')), px(a('r'))
                fill = a('fill')
                if fill == 'none':
                    d.ellipse([cx-r, cy-r, cx+r, cy+r], outline=a('stroke') or '#888', width=int(a('stroke-width') or 1))
                else:
                    d.ellipse([cx-r, cy-r, cx+r, cy+r], fill=fill)
            elif tag == 'ellipse':
                cx, cy, rx, ry = px(a('cx')), py(a('cy')), px(a('rx')), py(a('ry'))
                fill = a('fill')
                if fill == 'none':
                    d.ellipse([cx-rx, cy-ry, cx+rx, cy+ry], outline=a('stroke') or '#888', width=int(a('stroke-width') or 1))
                else:
                    d.ellipse([cx-rx, cy-ry, cx+rx, cy+ry], fill=fill)
            elif tag == 'polygon':
                pts = [(px(p.split(',')[0]), py(p.split(',')[1])) for p in a('points').split()]
                fill = a('fill')
                if fill == 'none':
                    d.polygon(pts, outline=a('stroke') or '#888')
                else:
                    d.polygon(pts, fill=fill)
            elif tag == 'line':
                if not a('x1'): continue
                d.line([px(a('x1')), py(a('y1')), px(a('x2')), py(a('y2'))], fill=a('stroke') or '#888', width=max(int(a('stroke-width') or 1), 1))
            elif tag == 'text':
                x, y = px(a('x')), py(a('y'))
                size = int(a('font-size') or 13)
                tm = re.search(r'>([^<]*)</text>', svg[m.start():m.end()+20])
                content = tm.group(1) if tm else ''
                try:
                    f = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", max(int(size*scale*0.85), 9))
                except:
                    f = ImageFont.load_default()
                d.text((x, y - size*scale*0.8), content, fill=a('fill') or '#fff', font=f)
        except Exception:
            continue
    img.save(png_path)
    print(f"saved {png_path} {img.size}")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("用法: python svg2png.py input.svg output.png [width]")
        sys.exit(2)
    render_svg(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 960)
