#!/usr/bin/env python3
"""mm-vision: SVG → PNG 渲染器（零系统依赖，仅 Pillow）
用法: python svg2png.py input.svg output.png [width]
适用于 mm-render 生成的受控 SVG（rect/circle/ellipse/polygon/line/text）。
"""
from PIL import Image, ImageDraw, ImageFont
import re, sys


def _parse_path(d):
    """SVG path 命令 → 点序列（M/C/L 支持，贝塞尔采样 24 段）"""
    import re, math
    tokens = re.findall(r'[MCLZmlz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?', d)
    pts = []
    cur = [0, 0]; start = [0, 0]
    i = 0
    def num():
        nonlocal i
        v = float(tokens[i]); i += 1; return v
    while i < len(tokens):
        cmd = tokens[i]; i += 1
        if cmd in 'Mm':
            x, y = num(), num()
            cur = [x, y]
            if cmd == 'm': cur = [pts[-1][0] + x, pts[-1][1] + y] if pts else [x, y]
            pts.append(tuple(cur))
            start = cur[:]
        elif cmd in 'Ll':
            x, y = num(), num()
            if cmd == 'l':
                x, y = cur[0] + x, cur[1] + y
            cur = [x, y]; pts.append(tuple(cur))
        elif cmd in 'Cc':
            c1x, c1y, c2x, c2y, x, y = num(), num(), num(), num(), num(), num()
            if cmd == 'c':
                c1x, c1y = cur[0] + c1x, cur[1] + c1y
                c2x, c2y = cur[0] + c2x, cur[1] + c2y
                x, y = cur[0] + x, cur[1] + y
            for t in range(1, 25):
                t /= 24
                mt = 1 - t
                bx = mt**3*cur[0] + 3*mt**2*t*c1x + 3*mt*t**2*c2x + t**3*x
                by = mt**3*cur[1] + 3*mt**2*t*c1y + 3*mt*t**2*c2y + t**3*y
                pts.append((bx, by))
            cur = [x, y]
        elif cmd in 'Zz':
            pts.append(tuple(start)); cur = start[:]
        elif cmd == 'Q':
            # 二次贝塞尔（少见，简单处理）
            qx, qy, x, y = num(), num(), num(), num()
            for t in range(1, 25):
                t /= 24; mt = 1 - t
                bx = mt**2*cur[0] + 2*mt*t*qx + t**2*x
                by = mt**2*cur[1] + 2*mt*t*qy + t**2*y
                pts.append((bx, by))
            cur = [x, y]
        else:
            break
    return pts

def _parse_gradients(svg):
    """解析 <linearGradient>/<radialGradient> → {id: [(offset, color), ...]}"""
    grads = {}
    for gm in re.finditer(r'<(?:linear|radial)Gradient[^>]*id="([^"]+)"[^>]*>(.*?)</(?:linear|radial)Gradient>', svg, re.S):
        gid, body = gm.group(1), gm.group(2)
        stops = []
        for sm in re.finditer(r'<stop[^>]*offset="([^"]+)"[^>]*stop-color="([^"]+)"', body):
            off = sm.group(1)
            off = float(off.replace('%', '')) / 100 if '%' in off else float(off)
            stops.append((off, sm.group(2)))
        if stops:
            grads[gid] = stops
    return grads

def _grad_color(grads, gid, x, y, w, h):
    """渐变 id → 该点颜色（线性插值）"""
    stops = grads.get(gid)
    if not stops: return '#888888'
    stops = sorted(stops)
    t = (x / max(w - 1, 1) + y / max(h - 1, 1)) / 2  # 对角
    t = max(0.0, min(1.0, t))
    for i in range(len(stops) - 1):
        o0, c0 = stops[i]; o1, c1 = stops[i + 1]
        if o0 <= t <= o1:
            tt = (t - o0) / max(o1 - o0, 1e-9)
            def hx(c):
                c = c.lstrip('#')
                return tuple(int(c[j:j+2], 16) for j in (0, 2, 4))
            a0, a1 = hx(c0), hx(c1)
            return '#%02x%02x%02x' % tuple(int(a0[k] + (a1[k] - a0[k]) * tt) for k in range(3))
    return stops[-1][1]

def render_svg(svg_path, png_path, width=960):
    svg = open(svg_path, encoding='utf-8').read()
    grads = _parse_gradients(svg)
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
    for m in re.finditer(r'<(rect|circle|ellipse|polygon|line|text|path)([^>]*?)/?>', svg):
        tag, attrs = m.group(1), m.group(2)
        def a(name):
            mm = re.search(name + r'="([^"]*)"', attrs)
            return mm.group(1) if mm else None
        try:
            if tag == 'path':
                d = a('d')
                if not d: continue
                pts = _parse_path(d)
                if len(pts) >= 3:
                    fill = a('fill') or '#000000'
                    if fill.startswith('url(#'):
                        gid = fill[5:-1]
                        fill = _grad_color(grads, gid, sum(p[0] for p in pts)/len(pts), sum(p[1] for p in pts)/len(pts), W, H)
                    stroke = a('stroke')
                    w = float(a('stroke-width') or 1)
                    poly = [(px(x), py(y)) for x, y in pts]
                    if fill != 'none' and not fill.startswith('url('):
                        d_ = ImageDraw.Draw(img)
                        d_.polygon(poly, fill=fill)
                        d_ = d
                    if stroke and stroke != 'none' and not stroke.startswith('url('):
                        d2 = ImageDraw.Draw(img)
                        d2.line(poly, fill=stroke, width=max(1, int(w*scale)))
                        d2 = d
                continue
            if a('fill') and a('fill').startswith('url(#'):
                gid = a('fill')[5:-1]
                cx_ = px(a('x') or 0) if a('x') else 0
                cy_ = py(a('y') or 0) if a('y') else 0
                cw_ = px(a('width') or '1')
                ch_ = py(a('height') or '1')
                attrs = attrs.replace(a('fill'), _grad_color(grads, gid, cx_ + cw_/2, cy_ + ch_/2, W, H))
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
