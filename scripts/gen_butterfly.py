#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_butterfly.py — 矢量贝塞尔精细描画：蝴蝶
===========================================
策略：SVG 矢量路径（贝塞尔曲线精确控制点）→ svg2png.py 转位图。
不对称的细节用参数化生成，保证左右镜像完美。
"""
import math

def bezier_path(pts, close=False, smooth=True):
    """pts: 控制点序列（首尾为端点，中间为控制点，交替 C 命令）"""
    if not pts: return ""
    d = f"M {pts[0][0]:.1f} {pts[0][1]:.1f}"
    i = 1
    while i < len(pts):
        if i + 2 < len(pts) + (0 if close else 0):
            d += f" C {pts[i][0]:.1f} {pts[i][1]:.1f}, {pts[i+1][0]:.1f} {pts[i+1][1]:.1f}, {pts[i+2][0]:.1f} {pts[i+2][1]:.1f}"
            i += 3
        else:
            d += f" L {pts[i][0]:.1f} {pts[i][1]:.1f}"
            i += 1
    if close: d += " Z"
    return d

W = H = 900
BG = "#1a2332"

CX = 450.0  # 画布中心 x（翅膀相对坐标偏移）

def butterfly_wing(base_y, scale_x, scale_y, flip=False):
    """上翅轮廓：贝塞尔控制点（相对坐标，flip=水平镜像）"""
    s = -1 if flip else 1
    # 上翅：从身体出发的完整轮廓
    pts = [
        (0, 0),                              # 起点=身体
        (18*s, -30), (52*s, -58), (96*s, -66),   # 前缘上弧
        (128*s, -52), (140*s, -22), (126*s, 4),  # 外缘
        (92*s, 22), (52*s, 26), (24*s, 12),      # 后缘回身体
    ]
    return [(x * scale_x + CX, y * scale_y + base_y) for x, y in pts]

def lower_wing(base_y, scale_x, scale_y, flip=False):
    s = -1 if flip else 1
    pts = [
        (0, 0),
        (14*s, 18), (36*s, 30), (62*s, 28),     # 下缘
        (78*s, 14), (72*s, -6), (52*s, -14),    # 尾突
        (30*s, -12), (14*s, -6), (0, 0),
    ]
    return [(x * scale_x + CX, y * scale_y + base_y) for x, y in pts]

def gradient_defs():
    return """
  <defs>
    <linearGradient id="w1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ff9a3c"/>
      <stop offset="45%" stop-color="#ff5e62"/>
      <stop offset="100%" stop-color="#a83279"/>
    </linearGradient>
    <linearGradient id="w2" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#ff5e62"/>
      <stop offset="100%" stop-color="#7b2ff7"/>
    </linearGradient>
    <linearGradient id="w3" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#7b2ff7"/>
      <stop offset="100%" stop-color="#2a1e5c"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#ffd76e" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#ffd76e" stop-opacity="0"/>
    </radialGradient>
  </defs>"""

def main():
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">']
    parts.append(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
    parts.append(gradient_defs())

    cx, cy = W / 2, H / 2
    # 背景光晕
    parts.append(f'<ellipse cx="{cx}" cy="{cy}" rx="420" ry="380" fill="url(#glow)" opacity="0.25"/>')
    # 星光点缀
    for sx, sy, r in [(140, 160, 2.5), (760, 140, 2), (700, 760, 3), (180, 700, 2), (450, 90, 2.2), (860, 420, 1.8), (60, 520, 2)]:
        parts.append(f'<circle cx="{sx}" cy="{sy}" r="{r}" fill="#ffffff" opacity="0.5"/>')

    # 翅膀（先画后面一层，再画前面）
    # 后翅（下翅）
    for flip in (False, True):
        pts = lower_wing(cy + 60, 2.6, 2.6, flip)
        parts.append(f'<path d="{bezier_path(pts, close=True)}" fill="url(#w3)" stroke="#1c1333" stroke-width="2.5" opacity="0.95"/>')
        # 下翅尾突斑
        tx = cx + (70 * 2.6 * (-1 if flip else 1))
        parts.append(f'<circle cx="{tx}" cy="{cy + 118}" r="7" fill="#ffd76e" opacity="0.85"/>')

    # 前翅（上翅）
    for flip in (False, True):
        pts = butterfly_wing(cy - 40, 3.0, 3.0, flip)
        parts.append(f'<path d="{bezier_path(pts, close=True)}" fill="url(#w1)" stroke="#5c1e4a" stroke-width="3"/>')
        # 翅脉（3条）
        for i, (mx, my, lx, ly) in enumerate([(0.55, 0.25, 0.9, 0.12), (0.5, 0.5, 0.88, 0.45), (0.55, 0.75, 0.85, 0.78)]):
            sx_ = cx + (30 * (-1 if flip else 1))
            parts.append(f'<path d="M {sx_} {cy + (my - 0.45) * 200} Q {cx + (mx * 120 * (-1 if flip else 1))} {cy + (my - 0.45) * 200 - 40} {cx + (lx * 140 * (-1 if flip else 1))} {cy + (ly - 0.45) * 200}" stroke="#fff" stroke-width="1.8" fill="none" opacity="0.5"/>')
        # 眼斑（前翅大斑）
        bx = CX + (105 * 3.0 * (-1 if flip else 1)) * 0.55
        by = cy - 40 + (-18 * 3.0)
        parts.append(f'<ellipse cx="{bx}" cy="{by}" rx="26" ry="30" fill="#1c1333" opacity="0.9"/>')
        parts.append(f'<ellipse cx="{bx}" cy="{by}" rx="14" ry="16" fill="#ffd76e"/>')
        parts.append(f'<circle cx="{bx}" cy="{by}" r="6" fill="#111"/>')
        parts.append(f'<circle cx="{bx - 4}" cy="{by - 5}" r="2.5" fill="#fff" opacity="0.9"/>')

    # 身体
    body = f'M {cx} {cy - 240} C {cx + 10} {cy - 160}, {cx + 12} {cy - 80}, {cx + 8} {cy + 20} L {cx} {cy + 60} L {cx - 8} {cy + 20} C {cx - 12} {cy - 80}, {cx - 10} {cy - 160}, {cx} {cy - 240} Z'
    parts.append(f'<path d="{body}" fill="#2a1e5c" stroke="#140f33" stroke-width="2"/>')
    # 身体节段线
    for i, yy in enumerate(range(int(cy - 190), int(cy + 40), 32)):
        parts.append(f'<path d="M {cx - 7} {yy} Q {cx} {yy + 6} {cx + 7} {yy}" stroke="#140f33" stroke-width="1.6" fill="none" opacity="0.7"/>')
    # 头
    parts.append(f'<circle cx="{cx}" cy="{cy - 238}" r="16" fill="#2a1e5c" stroke="#140f33" stroke-width="2"/>')
    # 眼睛
    parts.append(f'<circle cx="{cx - 6}" cy="{cy - 242}" r="3.5" fill="#ffd76e"/>')
    parts.append(f'<circle cx="{cx + 6}" cy="{cy - 242}" r="3.5" fill="#ffd76e"/>')
    # 触角（贝塞尔卷曲）
    for s in (-1, 1):
        ant = f'M {cx + s*6} {cy - 252} C {cx + s*46} {cy - 300}, {cx + s*70} {cy - 268}, {cx + s*86} {cy - 292}'
        parts.append(f'<path d="{ant}" stroke="#2a1e5c" stroke-width="4" fill="none" stroke-linecap="round"/>')
        ex, ey = cx + s*86, cy - 292
        parts.append(f'<circle cx="{ex}" cy="{ey}" r="7" fill="#ff5e62"/>')

    # 上翅边缘高光
    for flip in (False, True):
        pts = butterfly_wing(cy - 40, 3.0, 3.0, flip)
        # 只描前缘（前 4 个点）
        edge = pts[:4]
        d = f"M {edge[0][0]:.1f} {edge[0][1]:.1f}"
        for i in range(1, len(edge), 3):
            d += f" C {edge[i][0]:.1f} {edge[i][1]:.1f}, {edge[i+1][0]:.1f} {edge[i+1][1]:.1f}, {edge[i+2][0]:.1f} {edge[i+2][1]:.1f}"
        parts.append(f'<path d="{d}" stroke="#fff" stroke-width="2.5" fill="none" opacity="0.35"/>')

    parts.append("</svg>")
    open("butterfly.svg", "w", encoding="utf-8").write("\n".join(parts))
    print("✅ butterfly.svg 已生成")

if __name__ == "__main__":
    main()
