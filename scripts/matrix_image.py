#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
matrix_image.py — 图像矩阵引擎（声明式 · 通用架构）
==================================================
核心思想：图像 = 矩阵 A ∈ R^(H×W×C)，一切图像操作都是矩阵运算。

★ 声明式：所有能力用 JSON 场景描述（或 CLI 参数）调用，无需写 Python。
   python matrix_image.py render scene.json -o out.png
   python matrix_image.py lathe --base 188,140,96 -o vase.png
   python matrix_image.py cat -o cat.png

场景 JSON 格式：
{
  "size": 800,
  "bg": {"type": "gradient", "c0": [58,66,96], "c1": [96,104,132], "vertical": true},
  "ops": [
    {"type": "lathe", "profile": "0,0;0.06,0.52;...", "base": [188,140,96], "cx": 0.5, "cy": 0.78},
    {"type": "flower", "cx": 0.36, "cy": 0.09, "r": 0.075, "color": [212,96,92]},
    {"type": "ellipse", "cx": 0.5, "cy": 0.83, "rx": 0.32, "ry": 0.03, "color": [52,60,84]}
  ]
}

操作注册表（op 名称 → 类）：
  处理：svd 低秩重建 / inpaint 低秩补全 / crop 裁剪 / flip 翻转 / rotate90 旋转
        resize 缩放 / color 颜色矩阵 / blend 混合 / maskfill 掩码填充 / noise 噪声
  生成：sdf 符号距离场(circle/ellipse/polygon/line/gradient) / curve 参数曲线
        flower 花 / lathe 旋转体(花瓶/碗/杯)
  场景：scene_bg 通用背景 / scene_flowers 花束 / scene_vase 花瓶 / scene_cat 猫
"""
import math
import json
import numpy as np
from PIL import Image

# ==================== 图像即矩阵 ====================

class MatrixImage:
    """图像 = (H,W,C) float64 矩阵，0-255"""

    def __init__(self, arr: np.ndarray):
        arr = np.asarray(arr, dtype=np.float64)
        if arr.ndim == 2:  # 灰度 → RGB
            arr = np.stack([arr] * 3, axis=-1)
        if arr.ndim != 3 or arr.shape[2] not in (1, 3, 4):
            raise ValueError(f"矩阵维度不合法: {arr.shape}")
        self.arr = arr

    # ---- 构造 ----
    @classmethod
    def from_file(cls, path: str) -> "MatrixImage":
        return cls(np.asarray(Image.open(path).convert("RGB"), dtype=np.float64))

    @classmethod
    def zeros(cls, h: int, w: int, bg=(0, 0, 0)) -> "MatrixImage":
        arr = np.zeros((h, w, 3), dtype=np.float64)
        arr[:, :] = bg
        return cls(arr)

    def to_file(self, path: str) -> None:
        Image.fromarray(np.clip(self.arr, 0, 255).astype(np.uint8)).save(path)

    # ---- 矩阵视图 ----
    @property
    def H(self): return self.arr.shape[0]
    @property
    def W(self): return self.arr.shape[1]

    def __getitem__(self, key):  # 切片即裁剪
        return self.arr[key]

    def clone(self) -> "MatrixImage":
        return MatrixImage(self.arr.copy())

    def copy_into(self, other: "MatrixImage", y0=0, x0=0) -> "MatrixImage":
        """矩阵块写入：other 覆盖到本图 (y0,x0) 处"""
        o = self.clone()
        h, w = other.arr.shape[:2]
        o.arr[y0:y0+h, x0:x0+w] = other.arr
        return o

    # ---- 百分比坐标（语义化访问） ----
    def px(self, fx: float) -> int:  return int(fx * self.W)
    def py(self, fy: float) -> int:  return int(fy * self.H)
    def region(self, x0f, x1f, y0f, y1f) -> np.ndarray:
        return self.arr[self.py(y0f):self.py(y1f), self.px(x0f):self.px(x1f)]


# ==================== 操作注册表 ====================

class ImageOp:
    """矩阵操作基类：apply(img) -> MatrixImage"""
    name = "op"

    def apply(self, img: MatrixImage, **kw) -> MatrixImage:
        raise NotImplementedError

    def __call__(self, img: MatrixImage, **kw) -> MatrixImage:
        return self.apply(img, **kw)


REGISTRY: dict[str, type] = {}

def register(cls):
    REGISTRY[cls.name] = cls
    return cls


class Pipeline:
    """操作流水线：按序组合多个矩阵操作"""
    def __init__(self, ops: list):
        self.ops = ops
    def run(self, img: MatrixImage) -> MatrixImage:
        cur = img
        for op in self.ops:
            cur = op(cur)
        return cur
    def __repr__(self):
        return "Pipeline[" + " -> ".join(o.name for o in self.ops) + "]"


# ==================== 解析器 ====================

def parse_regions(spec: str) -> list[tuple[float, float, float, float]]:
    """'8,38,40,88;72,94,45,86'（百分比）→ [(x0,x1,y0,y1), ...]"""
    return [tuple(float(v) for v in r.split(",")) for r in spec.split(";") if r.strip()]


def parse_profile(spec: str) -> list[tuple[float, float]]:
    """'0,0;0.06,0.52;0.42,0.60;1,0.40' → [(y,r), ...]"""
    return [tuple(float(v) for v in p.split(",")) for p in spec.split(";") if p.strip()]


# ==================== 矩阵分解/补全类 ====================

@register
class SVDReconstruct(ImageOp):
    """SVD 低秩重建：A = UΣVᵀ，保留前 k 个奇异值（Eckart-Young 最优近似）"""
    name = "svd"
    def __init__(self, k=32, chunk=64):
        self.k, self.chunk = k, chunk
    def apply(self, img: MatrixImage, **kw):
        arr = img.arr.copy()
        out = np.zeros_like(arr)
        H, W, C = arr.shape
        for y0 in range(0, H, self.chunk):
            for x0 in range(0, W, self.chunk):
                y1, x1 = min(y0+self.chunk, H), min(x0+self.chunk, W)
                for c in range(C):
                    blk = arr[y0:y1, x0:x1, c]
                    if min(blk.shape) < 4 or self.k >= min(blk.shape):
                        out[y0:y1, x0:x1, c] = blk
                    else:
                        U, S, Vt = np.linalg.svd(blk, full_matrices=False)
                        out[y0:y1, x0:x1, c] = (U[:, :self.k] * S[:self.k]) @ Vt[:self.k, :]
        return MatrixImage(out)


@register
class LowRankInpaint(ImageOp):
    """低秩矩阵补全：擦除区域 = 矩阵未知元素，迭代 SVD 填充"""
    name = "inpaint"
    def __init__(self, regions=None, k=12, iters=40):
        self.regions = regions or []   # [(x0,x1,y0,y1) 百分比]
        self.k, self.iters = k, iters
    def apply(self, img: MatrixImage, **kw):
        arr = img.arr.copy()
        H, W = img.H, img.W
        mask = np.zeros((H, W), dtype=bool)
        for x0, x1, y0, y1 in self.regions:
            mask[img.py(y0):img.py(y1), img.px(x0):img.px(x1)] = True
        known = ~mask
        for c in range(3):
            X = arr[:, :, c].copy()
            if known.any():
                X[mask] = X[known].mean()
            for _ in range(self.iters):
                U, S, Vt = np.linalg.svd(X, full_matrices=False)
                Xk = (U[:, :self.k] * S[:self.k]) @ Vt[:self.k, :]
                X[known] = arr[:, :, c][known]
                X[mask] = Xk[mask]
            arr[:, :, c] = X
        return MatrixImage(arr)


# ==================== 矩阵变换类 ====================

@register
class Crop(ImageOp):
    """子矩阵提取（百分比区域）"""
    name = "crop"
    def __init__(self, x0=0.0, x1=1.0, y0=0.0, y1=1.0):
        self.x0, self.x1, self.y0, self.y1 = x0, x1, y0, y1
    def apply(self, img: MatrixImage, **kw):
        return MatrixImage(img.region(self.x0, self.x1, self.y0, self.y1))


@register
class Flip(ImageOp):
    """矩阵反射：axis=0 上下翻 / axis=1 左右翻"""
    name = "flip"
    def __init__(self, axis=1):
        self.axis = axis
    def apply(self, img: MatrixImage, **kw):
        return MatrixImage(np.flip(img.arr, axis=self.axis))


@register
class Rotate90(ImageOp):
    """矩阵旋转 90° 的倍数"""
    name = "rotate90"
    def __init__(self, times=1):
        self.times = times % 4
    def apply(self, img: MatrixImage, **kw):
        return MatrixImage(np.rot90(img.arr, self.times))


@register
class Resize(ImageOp):
    """重采样（线性插值）"""
    name = "resize"
    def __init__(self, w=None, h=None, scale=None):
        self.w, self.h, self.scale = w, h, scale
    def apply(self, img: MatrixImage, **kw):
        w = self.w or (int(img.W * self.scale) if self.scale else img.W)
        h = self.h or (int(img.H * self.scale) if self.scale else img.H)
        return MatrixImage(np.asarray(Image.fromarray(
            np.clip(img.arr, 0, 255).astype(np.uint8)).resize((w, h)), dtype=np.float64))


@register
class ColorMatrix(ImageOp):
    """线性颜色变换：new = rgb @ M + b（矩阵乘法）"""
    name = "color"
    def __init__(self, M=None, b=None):
        self.M = np.asarray(M or np.eye(3), dtype=np.float64)
        self.b = np.asarray(b or [0, 0, 0], dtype=np.float64)
    def apply(self, img: MatrixImage, **kw):
        return MatrixImage(img.arr @ self.M.T + self.b)


# ==================== 矩阵合成类 ====================

@register
class AlphaBlend(ImageOp):
    """加权混合：out = a·img1 + (1-a)·img2"""
    name = "blend"
    def __init__(self, other, alpha=0.5):
        self.other, self.alpha = other, alpha
    def apply(self, img: MatrixImage, **kw):
        o = self.other.arr if isinstance(self.other, MatrixImage) else self.other
        if o.shape != img.arr.shape:
            o = np.asarray(Image.fromarray(np.clip(o, 0, 255).astype(np.uint8)).resize(
                (img.W, img.H)), dtype=np.float64)
        return MatrixImage(img.arr * self.alpha + o * (1 - self.alpha))


@register
class MaskFill(ImageOp):
    """mask 填充：区域内像素替换为颜色/另一图"""
    name = "maskfill"
    def __init__(self, mask: np.ndarray, color=None, other=None):
        self.mask, self.color, self.other = mask, color, other
    def apply(self, img: MatrixImage, **kw):
        o = img.clone()
        if self.other is not None:
            o.arr[self.mask] = self.other.arr[self.mask]
        elif self.color is not None:
            o.arr[self.mask] = self.color
        return o


# ==================== 矩阵生成类 ====================

@register
class SDFShape(ImageOp):
    """符号距离场形状：对每个像素求解析距离 d，smoothstep 抗锯齿填充
    类型：circle / ellipse / polygon / ring / line / gradient
    """
    name = "sdf"
    def __init__(self, shape="circle", color=(255, 255, 255), **params):
        self.shape, self.color = shape, color
        self.params = params
    def _dist(self, x, y, H, W):
        p = self.params
        X, Y = x / W, y / H
        if self.shape == "circle":
            cx, cy, r = p.get("cx", .5), p.get("cy", .5), p.get("r", .3)
            return math.hypot(X - cx, Y - cy) - r
        if self.shape == "ellipse":
            cx, cy, rx, ry = p.get("cx", .5), p.get("cy", .5), p.get("rx", .3), p.get("ry", .2)
            dx, dy = (X - cx) / max(rx, 1e-9), (Y - cy) / max(ry, 1e-9)
            return math.hypot(dx, dy) - 1
        if self.shape == "polygon":
            verts = p["verts"]
            sign = 0
            for i in range(len(verts)):
                x1, y1 = verts[i]; x2, y2 = verts[(i + 1) % len(verts)]
                cross = (x2 - x1) * (Y - y1) - (y2 - y1) * (X - x1)
                if abs(cross) < 1e-12: continue
                s = 1 if cross > 0 else -1
                if sign == 0: sign = s
                elif s != sign: return 1e9
            return -1
        if self.shape == "ring":
            cx, cy, r, thick = p.get("cx", .5), p.get("cy", .5), p.get("r", .3), p.get("thick", .03)
            return abs(math.hypot(X - cx, Y - cy) - r) - thick / 2
        if self.shape == "line":
            x0, y0, x1, y1 = p.get("x0", .1), p.get("y0", .1), p.get("x1", .9), p.get("y1", .9)
            dx, dy = x1 - x0, y1 - y0
            t = max(0, min(1, ((X - x0) * dx + (Y - y0) * dy) / (dx * dx + dy * dy)))
            return math.hypot(X - (x0 + t * dx), Y - (y0 + t * dy)) - p.get("w", .01)
        return 1e9
    def apply(self, img: MatrixImage, **kw):
        o = img.clone()
        H, W = img.H, img.W
        if self.shape == "gradient":
            p = self.params
            x0, x1 = p.get("x0", 0), p.get("x1", 1)
            y0, y1 = p.get("y0", 0), p.get("y1", 1)
            c0, c1 = p.get("c0", (0, 0, 0)), p.get("c1", (255, 255, 255))
            vertical = p.get("vertical", True)
            if vertical:
                t = np.clip((np.mgrid[0:H, 0:W][0] / max(H - 1, 1) - y0) / max(y1 - y0, 1e-9), 0, 1)
            else:
                t = np.clip((np.mgrid[0:H, 0:W][1] / max(W - 1, 1) - x0) / max(x1 - x0, 1e-9), 0, 1)
            for c in range(3):
                o.arr[:, :, c] = c0[c] + (c1[c] - c0[c]) * t
            return o
        ys, xs = np.mgrid[0:H, 0:W]
        d = np.vectorize(lambda a, b: self._dist(int(a), int(b), H, W))(xs, ys)
        alpha = np.clip(0.5 - d * 2.0, 0, 1)
        for c in range(3):
            o.arr[:, :, c] = o.arr[:, :, c] * (1 - alpha) + self.color[c] * alpha
        return o


@register
class ParametricDraw(ImageOp):
    """参数曲线画线：B(t) 采样 → 沿线涂色（矩阵版本）"""
    name = "curve"
    def __init__(self, fn, color=(0, 0, 0), w=0.012, n=200, t0=0.0, t1=1.0):
        self.fn, self.color, self.w = fn, color, w
        self.n, self.t0, self.t1 = n, t0, t1
    @staticmethod
    def bezier_fn(p0, p1, p2, p3):
        def f(t):
            mt = 1 - t
            x = mt**3*p0[0] + 3*mt**2*t*p1[0] + 3*mt*t**2*p2[0] + t**3*p3[0]
            y = mt**3*p0[1] + 3*mt**2*t*p1[1] + 3*mt*t**2*p2[1] + t**3*p3[1]
            return x, y
        return f
    @staticmethod
    def ellipse_fn(cx, cy, rx, ry):
        def f(t):
            return cx + rx * math.cos(2 * math.pi * t), cy + ry * math.sin(2 * math.pi * t)
        return f
    def apply(self, img: MatrixImage, **kw):
        o = img.clone()
        H, W = img.H, img.W
        px_prev = None
        r = max(1, int(self.w * W))
        for i in range(self.n + 1):
            t = self.t0 + (self.t1 - self.t0) * i / self.n
            fx, fy = self.fn(t)
            X, Y = int(fx * W), int(fy * H)
            if 0 <= X < W and 0 <= Y < H:
                o.arr[max(0, Y-r):Y+r+1, max(0, X-r):X+r+1] = self.color
            if px_prev is not None:
                for s in range(1, 8):
                    tx = px_prev[0] + (X - px_prev[0]) * s / 8
                    ty = px_prev[1] + (Y - px_prev[1]) * s / 8
                    X2, Y2 = int(tx), int(ty)
                    if 0 <= X2 < W and 0 <= Y2 < H:
                        o.arr[max(0, Y2-r):Y2+r+1, max(0, X2-r):X2+r+1] = self.color
            px_prev = (X, Y)
        return o


@register
class Noise(ImageOp):
    """随机噪声矩阵（可做纹理基底）"""
    name = "noise"
    def __init__(self, sigma=8, seed=None):
        self.sigma, self.seed = sigma, seed
    def apply(self, img: MatrixImage, **kw):
        rng = np.random.default_rng(self.seed)
        return MatrixImage(img.arr + rng.normal(0, self.sigma, img.arr.shape))


# ==================== 真实物体类（旋转体/花） ====================

@register
class Lathe(ImageOp):
    """旋转体：花瓶/碗/杯/坛通用（轮廓控制点 + 逐像素光照）

    用法：
      Lathe(profile=[(y,r),...], base=(188,140,96), cx=0.5, cy=0.78, max_r=0.30)
      profile: (归一化高度 y∈[0,1], 归一化半径 r∈[0,1]) 控制点，
      Catmull-Rom 样条插值 → 光滑侧影
    光照：漫反射(柱面明暗) + Blinn-Phong 高光 + 菲涅尔边缘暗化 + 竖向渐变
    """
    name = "lathe"
    def __init__(self, profile=None, base=(188, 140, 96), cx=0.5, cy=0.78,
                 max_r=0.30, light_dir=(-0.6, 0.8, 0.3), ambient=0.16,
                 spec_power=24, spec_strength=0.9):
        self.profile = profile or [(0, 0), (0.06, 0.52), (0.10, 0.45), (0.28, 0.62),
                                   (0.42, 0.60), (0.55, 0.52), (0.72, 0.34),
                                   (0.86, 0.26), (0.95, 0.40), (1.0, 0.40)]
        self.base = base; self.cx, self.cy, self.max_r = cx, cy, max_r
        self.L = np.asarray(light_dir, dtype=np.float64)
        self.L = self.L / np.linalg.norm(self.L)
        self.ambient, self.spec_power, self.spec_strength = ambient, spec_power, spec_strength

    def _radius_at(self, y):
        """Catmull-Rom 样条：高度 y(0-1) → 半径 r(0-1)"""
        pts = self.profile
        if y <= pts[0][0]: return max(pts[0][1], 0)
        if y >= pts[-1][0]: return max(pts[-1][1], 0)
        for i in range(len(pts) - 1):
            y0, r0 = pts[i]; y1, r1 = pts[i + 1]
            if y0 <= y <= y1:
                t = (y - y0) / max(y1 - y0, 1e-9)
                p0 = pts[max(i - 1, 0)]; p2 = pts[i + 1]; p3 = pts[min(i + 2, len(pts) - 1)]
                t2, t3 = t * t, t * t * t
                ry = 0.5 * ((2 * r0) + (-p0[1] + r0) * t +
                            (2 * p0[1] - 5 * r0 + 4 * p2[1] - p3[1]) * t2 +
                            (-p0[1] + 3 * r0 - 3 * p2[1] + p3[1]) * t3)
                return max(ry, 0)
        return 0

    def apply(self, img: MatrixImage, **kw):
        o = img.clone()
        H, W = img.H, img.W
        vx0, vy0, vr = self.cx, self.cy, self.max_r
        ys, xs = np.mgrid[0:H, 0:W]
        X = (xs / W - vx0) / vr
        y_norm = (ys[:, 0] / H - vy0) / (vr * 1.1) + 0.5   # 每行标量 (H,)：高度归一化
        radii = np.array([self._radius_at(yy) for yy in np.linspace(0, 1, H)])
        r_at_y = np.clip(radii, 0, 1)
        inside = (np.abs(X) <= r_at_y[:, None]) & (y_norm >= 0) & (y_norm <= 1)

        drdy = np.gradient(radii, vr * 1.1 / H)
        nx = np.where(inside, X / np.maximum(r_at_y[:, None], 1e-6), 0)
        ny = np.where(inside, -np.clip(drdy, -1, 1)[:, None] * 0.35, 0)
        nz = np.sqrt(np.clip(1 - nx**2 - ny**2, 0, 1))
        N = np.stack([nx, ny, nz], axis=-1)
        diff = np.clip(N @ self.L, 0, 1)
        Hv = self.L + np.array([0, 0, 1]); Hv = Hv / np.linalg.norm(Hv)
        spec = np.power(np.clip(N @ Hv, 0, 1), self.spec_power) * self.spec_strength
        rim = np.clip(1 - np.abs(nx) * 1.2, 0.15, 1)
        darken = np.clip(1 - (y_norm[:, None] ** 2) * 0.25, 0.75, 1)[..., None]
        base = np.array(self.base, dtype=np.float64)[None, None, :]
        light = (self.ambient + 0.75 * diff[..., None] + spec[..., None]) * rim[..., None]
        col = np.clip(base * darken * light, 0, 255)
        o.arr[inside] = col[inside]

        # 口沿高光环
        top_r = self._radius_at(0.965)
        ring_y = int((vy0 - 0.5 * vr * 1.1 + 0.965 * vr * 1.1) * H)
        if 0 <= ring_y < H:
            for i in range(W):
                xr = (i / W - vx0) / vr
                if abs(xr) <= top_r and abs(xr) > top_r * 0.82:
                    o.arr[ring_y, i] = [255, 225, 185]
        return o


@register
class Flower(ImageOp):
    """通用花：N 瓣椭圆 + 花心（可叠加多个）"""
    name = "flower"
    def __init__(self, cx=0.5, cy=0.3, r=0.08, color=(212, 96, 92),
                 petals=5, core=(255, 226, 140)):
        self.cx, self.cy, self.r, self.color = cx, cy, r, color
        self.petals, self.core = petals, core
    def apply(self, img: MatrixImage, **kw):
        o = img
        for i in range(self.petals):
            a = i * 2 * math.pi / self.petals
            px = self.cx + self.r * 0.62 * math.cos(a)
            py = self.cy + self.r * 0.62 * math.sin(a)
            o = SDFShape("ellipse", color=self.color, cx=px, cy=py,
                         rx=self.r * 0.52, ry=self.r * 0.52)(o)
        return SDFShape("circle", color=self.core, cx=self.cx, cy=self.cy,
                        r=self.r * 0.30)(o)


# ==================== 声明式场景渲染器 ====================
# JSON 场景 → Pipeline。每个 op 的 type 映射到注册类，参数透传。

def build_op(desc: dict) -> ImageOp:
    """单条 JSON 描述 → ImageOp 实例"""
    t = desc.pop("type")
    if t == "sdf":
        shape = desc.pop("shape", "circle")
        color = tuple(desc.pop("color", [255, 255, 255]))
        if shape == "polygon" and "verts" in desc:
            desc["verts"] = [(v[0], v[1]) for v in desc["verts"]]
        return SDFShape(shape, color=color, **desc)
    if t == "curve":
        kind = desc.pop("kind", "bezier")
        color = tuple(desc.pop("color", [0, 0, 0]))
        if kind == "bezier":
            cps = desc.pop("points")
            fn = ParametricDraw.bezier_fn(*(tuple(p) for p in cps))
        else:  # ellipse
            fn = ParametricDraw.ellipse_fn(desc.pop("cx", .5), desc.pop("cy", .5),
                                           desc.pop("rx", .2), desc.pop("ry", .1))
        return ParametricDraw(fn, color=color, **desc)
    if t == "lathe":
        base = tuple(desc.pop("base", [188, 140, 96]))
        if "profile" in desc and isinstance(desc["profile"], str):
            desc["profile"] = parse_profile(desc["profile"])
        return Lathe(base=base, **desc)
    if t == "flower":
        color = tuple(desc.pop("color", [212, 96, 92]))
        core = tuple(desc.pop("core", [255, 226, 140]))
        return Flower(color=color, core=core, **desc)
    if t == "svd":
        return SVDReconstruct(**desc)
    if t == "inpaint":
        if "regions" in desc and isinstance(desc["regions"], str):
            desc["regions"] = parse_regions(desc["regions"])
        return LowRankInpaint(**desc)
    if t == "crop": return Crop(**desc)
    if t == "flip": return Flip(**desc)
    if t == "rotate90": return Rotate90(**desc)
    if t == "resize": return Resize(**desc)
    if t == "color":
        return ColorMatrix(M=desc.pop("M", None), b=desc.pop("b", None))
    if t == "noise": return Noise(**desc)
    raise ValueError(f"未知操作类型: {t}")


def render_scene(scene: dict) -> MatrixImage:
    """JSON 场景 → 渲染矩阵"""
    size = scene.get("size", 800)
    bg = scene.get("bg", {"type": "sdf", "shape": "gradient",
                          "c0": [40, 46, 68], "c1": [80, 86, 110]})
    img = build_op(dict(bg))(MatrixImage.zeros(size, size))
    for desc in scene.get("ops", []):
        img = build_op(dict(desc))(img)
    return MatrixImage(img.arr)


def render_scene_file(path: str) -> MatrixImage:
    with open(path, encoding="utf-8") as f:
        return render_scene(json.load(f))


# ==================== 内置场景（声明式示例） ====================

VASE_SCENE = {
    "size": 800,
    "bg": {"type": "sdf", "shape": "gradient", "vertical": True,
           "c0": [58, 66, 96], "c1": [96, 104, 132]},
    "ops": [
        {"type": "sdf", "shape": "polygon", "verts": [[0, 0.80], [1, 0.80], [1, 1], [0, 1]],
         "color": [70, 78, 104]},
        {"type": "sdf", "shape": "line", "x0": 0, "y0": 0.802, "x1": 1, "y1": 0.802,
         "color": [120, 128, 156], "w": 0.003},
        {"type": "sdf", "shape": "ellipse", "cx": 0.5, "cy": 0.835, "rx": 0.315,
         "ry": 0.030, "color": [52, 60, 84]},
        {"type": "lathe", "base": [188, 140, 96], "cx": 0.5, "cy": 0.78, "max_r": 0.30},
        {"type": "curve", "kind": "bezier", "points": [[0.472, 0.30], [0.45, 0.21], [0.40, 0.17], [0.37, 0.11]],
         "color": [66, 118, 70], "w": 0.009},
        {"type": "flower", "cx": 0.36, "cy": 0.09, "r": 0.075, "color": [212, 96, 92]},
        {"type": "flower", "cx": 0.51, "cy": 0.055, "r": 0.085, "color": [238, 200, 92]},
        {"type": "flower", "cx": 0.64, "cy": 0.11, "r": 0.07, "color": [228, 148, 168]},
    ],
}

CAT_SCENE = {
    "size": 800,
    "bg": {"type": "sdf", "shape": "gradient", "vertical": True,
           "c0": [36, 50, 92], "c1": [58, 74, 120]},
    "ops": [
        {"type": "sdf", "shape": "polygon", "verts": [[0.08, 0.11], [0.92, 0.11], [0.92, 0.89], [0.08, 0.89]],
         "color": [255, 247, 236]},
        {"type": "curve", "kind": "bezier", "points": [[0.78, 0.72], [0.88, 0.75], [0.92, 0.62], [0.86, 0.54]],
         "color": [217, 164, 92], "w": 0.030},
        {"type": "curve", "kind": "bezier", "points": [[0.78, 0.72], [0.88, 0.75], [0.92, 0.62], [0.86, 0.54]],
         "color": [245, 201, 123], "w": 0.022},
        {"type": "sdf", "shape": "ellipse", "cx": 0.50, "cy": 0.72, "rx": 0.24, "ry": 0.19,
         "color": [245, 201, 123]},
        {"type": "sdf", "shape": "circle", "cx": 0.50, "cy": 0.41, "r": 0.218, "color": [245, 201, 123]},
        {"type": "sdf", "shape": "polygon", "verts": [[0.277, 0.258], [0.433, 0.258], [0.355, 0.085]],
         "color": [245, 201, 123]},
        {"type": "sdf", "shape": "polygon", "verts": [[0.315, 0.250], [0.395, 0.250], [0.355, 0.130]],
         "color": [247, 184, 184]},
        {"type": "sdf", "shape": "polygon", "verts": [[0.567, 0.258], [0.723, 0.258], [0.645, 0.085]],
         "color": [245, 201, 123]},
        {"type": "sdf", "shape": "polygon", "verts": [[0.605, 0.250], [0.685, 0.250], [0.645, 0.130]],
         "color": [247, 184, 184]},
        {"type": "sdf", "shape": "ellipse", "cx": 0.415, "cy": 0.385, "rx": 0.043, "ry": 0.052,
         "color": [255, 255, 255]},
        {"type": "sdf", "shape": "ellipse", "cx": 0.415, "cy": 0.395, "rx": 0.019, "ry": 0.032,
         "color": [61, 90, 30]},
        {"type": "sdf", "shape": "circle", "cx": 0.404, "cy": 0.380, "r": 0.009, "color": [255, 255, 255]},
        {"type": "sdf", "shape": "ellipse", "cx": 0.585, "cy": 0.385, "rx": 0.043, "ry": 0.052,
         "color": [255, 255, 255]},
        {"type": "sdf", "shape": "ellipse", "cx": 0.585, "cy": 0.395, "rx": 0.019, "ry": 0.032,
         "color": [61, 90, 30]},
        {"type": "sdf", "shape": "circle", "cx": 0.574, "cy": 0.380, "r": 0.009, "color": [255, 255, 255]},
        {"type": "sdf", "shape": "polygon", "verts": [[0.50, 0.472], [0.478, 0.442], [0.522, 0.442]],
         "color": [232, 134, 124]},
        {"type": "curve", "kind": "bezier", "points": [[0.50, 0.478], [0.49, 0.505], [0.463, 0.508], [0.440, 0.493]],
         "color": [58, 43, 26], "w": 0.006},
        {"type": "curve", "kind": "bezier", "points": [[0.50, 0.478], [0.51, 0.505], [0.537, 0.508], [0.560, 0.493]],
         "color": [58, 43, 26], "w": 0.006},
        {"type": "sdf", "shape": "line", "x0": 0.435, "y0": 0.452, "x1": 0.535, "y1": 0.448,
         "color": [58, 43, 26], "w": 0.004},
        {"type": "sdf", "shape": "line", "x0": 0.435, "y0": 0.462, "x1": 0.550, "y1": 0.462,
         "color": [58, 43, 26], "w": 0.004},
        {"type": "sdf", "shape": "line", "x0": 0.435, "y0": 0.474, "x1": 0.535, "y1": 0.479,
         "color": [58, 43, 26], "w": 0.004},
        {"type": "sdf", "shape": "line", "x0": 0.565, "y0": 0.452, "x1": 0.465, "y1": 0.448,
         "color": [58, 43, 26], "w": 0.004},
        {"type": "sdf", "shape": "line", "x0": 0.565, "y0": 0.462, "x1": 0.450, "y1": 0.462,
         "color": [58, 43, 26], "w": 0.004},
        {"type": "sdf", "shape": "line", "x0": 0.565, "y0": 0.474, "x1": 0.465, "y1": 0.479,
         "color": [58, 43, 26], "w": 0.004},
        {"type": "sdf", "shape": "ellipse", "cx": 0.375, "cy": 0.475, "rx": 0.030, "ry": 0.017,
         "color": [247, 184, 184]},
        {"type": "sdf", "shape": "ellipse", "cx": 0.625, "cy": 0.475, "rx": 0.030, "ry": 0.017,
         "color": [247, 184, 184]},
        {"type": "sdf", "shape": "ellipse", "cx": 0.435, "cy": 0.885, "rx": 0.052, "ry": 0.032,
         "color": [245, 201, 123]},
        {"type": "sdf", "shape": "ellipse", "cx": 0.565, "cy": 0.885, "rx": 0.052, "ry": 0.032,
         "color": [245, 201, 123]},
    ],
}

BUILTIN_SCENES = {"vase": VASE_SCENE, "cat": CAT_SCENE}


# ==================== CLI ====================

if __name__ == "__main__":
    import argparse, sys
    ap = argparse.ArgumentParser(description="图像矩阵引擎 CLI（声明式）")
    ap.add_argument("op", help="render <scene.json> | " + " | ".join(sorted(REGISTRY.keys())) +
                    " | " + " | ".join(BUILTIN_SCENES.keys()))
    ap.add_argument("-i", "--input", help="输入图片（处理类操作需要）")
    ap.add_argument("-o", "--out", default="out.png")
    ap.add_argument("-k", "--rank", type=int, default=32)
    ap.add_argument("--chunk", type=int, default=64)
    ap.add_argument("--regions", help='百分比区域: "x0,x1,y0,y1;..."')
    ap.add_argument("--base", default="188,140,96", help="lathe 基色 R,G,B")
    ap.add_argument("--cx", type=float, default=0.5)
    ap.add_argument("--cy", type=float, default=0.78)
    ap.add_argument("--max_r", type=float, default=0.30)
    ap.add_argument("--profile", help='lathe 轮廓: "y,r;y,r;..."')
    ap.add_argument("--size", type=int, default=800)
    ap.add_argument("--scene-json", help="内联 JSON 场景（声明式，无需写文件）")
    args = ap.parse_args()

    if args.op == "render":
        if args.scene_json:
            out = render_scene(json.loads(args.scene_json))
        else:
            out = render_scene_file(args.input or args.out.replace(".png", ".json"))
        out.to_file(args.out)
        print(f"✅ 已保存: {args.out}")
        sys.exit(0)

    if args.op in BUILTIN_SCENES:
        out = render_scene(BUILTIN_SCENES[args.op])
        out.to_file(args.out)
        print(f"✅ 已保存: {args.out}")
        sys.exit(0)

    if args.op in ("svd", "inpaint"):
        if not args.input:
            print("❌ 需要 -i 输入图片"); sys.exit(1)
        img = MatrixImage.from_file(args.input)
        if args.op == "svd":
            out = SVDReconstruct(k=args.rank, chunk=args.chunk)(img)
        else:
            out = LowRankInpaint(regions=parse_regions(args.regions or ""), k=args.rank)(img)
    elif args.op == "lathe":
        prof = parse_profile(args.profile) if args.profile else None
        bg = SDFShape("gradient", vertical=True, c0=(58, 66, 96), c1=(96, 104, 132))(
            MatrixImage.zeros(args.size, args.size))
        out = Lathe(profile=prof, base=tuple(map(int, args.base.split(","))),
                    cx=args.cx, cy=args.cy, max_r=args.max_r)(bg)
    else:
        print(f"暂不支持操作: {args.op}"); sys.exit(1)
    out.to_file(args.out)
    print(f"✅ 已保存: {args.out}")
