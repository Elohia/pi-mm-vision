/**
 * mm-render — 通感编码 → 图像解码器（反向渲染）
 * ==================================================
 * 把通感编码文本（mm_vision 输出）渲染成真实图片（SVG）。
 * 形成双向协议：
 *   encode: 图片 → 通感编码文字（mm_vision）
 *   decode: 通感编码文字 → 图片（mm_render）
 *
 * 这让纯文本 LLM 获得"画图"能力：模型输出坐标化描述 → 渲染成图。
 * 也是编码质量的闭环验证工具：原图 → 编码 → 渲染 → 对比。
 *
 * 零依赖：纯 TypeScript 字符串拼接生成 SVG（文本格式，任何浏览器可看）。
 *
 * 支持的编码元素（解析 SYNESTHESIA 输出格式）：
 *   【画布】宽高比 16:9, 主背景色 #181c28
 *   【元素】[类型 | 位置 | 尺寸 | 颜色 | 文本/数值]
 *   【均线/折线】从(x%,y%)到(x%,y%) | 颜色 | 形状
 *   【水平线】y=42% | 标注 "SUPPORT 275"
 *   【最高点/标注】位于 (x%,y%) | 数值
 *   【K线】x=4%-96% | N根 | 红#xxxxxx阳/绿#xxxxxx阴
 */

// ==================== 画布 ====================

interface Canvas {
  width: number;
  height: number;
  bgColor: string;
}

function parseAspectRatio(s: string): [number, number] {
  const m = s.match(/(\d+)\s*[:：]\s*(\d+)/);
  if (m) return [parseInt(m[1]), parseInt(m[2])];
  if (/16[:：]9|宽屏|横/.test(s)) return [16, 9];
  if (/9[:：]16|竖|手机/.test(s)) return [9, 16];
  if (/1[:：]1|正方/.test(s)) return [1, 1];
  return [4, 3];
}

function parseColor(s: string, fallback = "#888888"): string {
  const m = s.match(/#[0-9a-fA-F]{3,8}/);
  if (m) return m[0];
  const named: Record<string, string> = {
    红: "#e0534b", 绿: "#3fc47f", 蓝: "#5a8cff", 黄: "#f5c542", 青: "#00c8a0",
    白: "#ffffff", 黑: "#111111", 橙: "#ff8c42", 紫: "#a855f7", 灰: "#888888",
    red: "#e0534b", green: "#3fc47f", blue: "#5a8cff", yellow: "#f5c542",
    cyan: "#00c8a0", white: "#ffffff", black: "#111111", orange: "#ff8c42",
    purple: "#a855f7", gray: "#888888",
  };
  for (const [k, v] of Object.entries(named)) {
    if (s.includes(k)) return v;
  }
  return fallback;
}

function parseXY(s: string): { x: number; y: number } | null {
  const m = s.match(/\(?\s*(\d+(?:\.\d+)?)\s*[%,]\s*,\s*(\d+(?:\.\d+)?)\s*[%,]?\s*\)?/);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

// ==================== 元素解析 ====================

interface RenderElement {
  type: "candles" | "line" | "hline" | "vline" | "marker" | "text" | "rect" | "grid" | "circle" | "ellipse" | "polygon" | "arrow" | "label"
    | "pixels" | "polyline" | "path";
  data: any;
}

/** 解析 [类型 | 字段...] 方括号块 */
function parseBracketBody(line: string): string | null {
  const m = line.match(/\[([^\]]+)\]/);
  return m ? m[1] : null;
}

/** 从方括号块中取字段 */
function field(body: string, keys: string[]): string | null {
  for (const k of keys) {
    const m = body.match(new RegExp(k + "\\s*\\(?\\s*([^)|]+)\\)?"));
    if (m && !m[1].includes("到")) return m[1].trim();
  }
  return null;
}

/** 解析百分比坐标对 */
function parseCoords(s: string): { x: number; y: number } | null {
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*%?\s*,?\s*(?:y\s*=\s*)?(\d+(?:\.\d+)?)\s*%?/);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

/** 解析尺寸：30%x15% */
function parseSize(s: string): { w: number; h: number } | null {
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*%?\s*[xX,×]\s*(\d+(?:\.\d+)?)\s*%?/);
  if (!m) return null;
  return { w: parseFloat(m[1]), h: parseFloat(m[2]) };
}

/** 提取方括号内引号文本 */
function quotedText(s: string): string | null {
  const m = s.match(/["“”'‘’]([^"“”'‘’]{1,60})["“”'‘’]/);
  return m ? m[1] : null;
}

/**
 * ASCII 点阵 → 像素网格数据
 * 每字符一格：非空格字符 = 填充像素，空格 = 透明
 * 支持灰度字符映射（@%#*+=-:. 由亮到暗）
 */
export function asciiMatrixToPixels(ascii: string): { width: number; height: number; cells: { x: number; y: number; gray: number }[] } {
  const lines = ascii.split(/\r?\n/);
  const height = lines.length;
  const width = Math.max(...lines.map((l) => l.length));
  const cells: { x: number; y: number; gray: number }[] = [];
  // 灰度字符表（亮→暗）：' ' 0, '.' 1, ':' 2, '-' 3, '=' 4, '+' 5, '*' 6, '#' 7, '%' 8, '@' 9
  const ramp: Record<string, number> = { " ": 0, ".": 1, ":": 2, "-": 3, "=": 4, "+": 5, "*": 6, "#": 7, "%": 8, "@": 9 };

  // 自动检测 invert：统计最暗字符(@)与最亮字符(空格)占比
  // ascii_dot invert=1（暗背景）: @=背景(暗)，空格=前景(亮)，@ 占多数 → 翻转
  // ascii_dot invert=0（亮背景）: 空格=背景(亮)，@=前景(暗)，空格占多数 → 不翻转
  let darkCount = 0, lightCount = 0, total = 0;
  for (const line of lines) {
    for (const ch of line) {
      if (ch === "@" || ch === "%" || ch === "#") darkCount++;
      if (ch === " " || ch === "." || ch === ":") lightCount++;
      total++;
    }
  }
  // 暗字符(含@%#)占多数 → 暗背景 invert=1 → 翻转（@→0 背景，空格→9 前景）
  const inverted = total > 0 && darkCount > total * 0.5;

  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      const ch = line[x];
      let g = ramp[ch] ?? (ch === " " ? 0 : 9);
      if (inverted) g = 9 - g; // 翻转：@→0(暗背景)，空格→9(亮前景)
      if (g > 0) cells.push({ x, y, gray: g / 9 });
    }
  });
  return { width, height, cells };
}

/**
 * 像素网格 → 密集 SVG（每个像素一个 rect）
 * 默认透明背景 + 亮色像素（dark-mode 终端点阵的常规渲染）
 */
export function pixelsToSVG(
  matrix: { width: number; height: number; cells: { x: number; y: number; gray: number }[] },
  opts: { pixelSize?: number; bg?: string; fg?: string; width?: number } = {},
): string {
  const pixelSize = opts.pixelSize ?? 8;
  const W = matrix.width * pixelSize;
  const H = matrix.height * pixelSize;
  const bg = opts.bg ?? "#0d1117";
  const fg = opts.fg ?? "#39d353";
  const parts: string[] = [];
  parts.push(`<svg ${SVG_NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);
  // 灰度色阶：fg 混合到 bg
  for (const c of matrix.cells) {
    const gray = c.gray;
    // 插值颜色
    const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
    const fgr = parseInt(fg.slice(1, 3), 16), fgg = parseInt(fg.slice(3, 5), 16), fgb = parseInt(fg.slice(5, 7), 16);
    const bgr = parseInt(bg.slice(1, 3), 16), bgg = parseInt(bg.slice(3, 5), 16), bgb = parseInt(bg.slice(5, 7), 16);
    const r = mix(bgr, fgr, gray).toString(16).padStart(2, "0");
    const g = mix(bgg, fgg, gray).toString(16).padStart(2, "0");
    const b = mix(bgb, fgb, gray).toString(16).padStart(2, "0");
    const col = `#${r}${g}${b}`;
    parts.push(`<rect x="${c.x * pixelSize}" y="${c.y * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${col}"/>`);
  }
  parts.push(`</svg>`);
  return parts.join("\n");
}

/** 提取 RGB 色块矩阵：每行格式 "R,G,B R,G,B ..."（空格分隔，逗号分隔通道） */
export function parseRGBMatrix(text: string): { width: number; height: number; cells: { x: number; y: number; r: number; g: number; b: number }[] } | null {
  // 支持分块：识别 # TILE tx,ty 头，按块偏移拼接（RGB 真彩色分块）
  const rawLines = text.split(/\r?\n/);
  const cells: { x: number; y: number; r: number; g: number; b: number }[] = [];
  let width = 0, height = 0;
  let tileOx = 0, tileOy = 0, tileW = 0, tileH = 0, curRow = 0;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    const tileHead = line.match(/^#\s*TILE\s*(\d+),(\d+)/);
    if (tileHead) {
      const tx = parseInt(tileHead[1]), ty = parseInt(tileHead[2]);
      // 块尺寸取上一块的行数/列数，偏移累加
      tileOx = tx * Math.max(tileW, 1);
      tileOy = ty * Math.max(tileH, 1);
      curRow = 0;
      continue;
    }
    if (!line.includes(",") || !/^[\d,\s]+$/.test(line)) continue;
    const parts = line.split(/\s+/);
    const y = tileOy + curRow;
    let x = tileOx;
    let found = 0;
    for (const part of parts) {
      const m = part.match(/^(\d{1,3}),(\d{1,3}),(\d{1,3})$/);
      if (m) {
        cells.push({ x, y, r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) });
        found++;
        x++;
      }
    }
    if (found > 0) {
      if (tileW === 0 || found > tileW) tileW = found;
      curRow++;
      if (y + 1 > height) height = y + 1;
      if (tileOx + found > width) width = tileOx + found;
      if (curRow > tileH) tileH = curRow;
    }
  }
  if (cells.length === 0) return null;
  return { width, height, cells };
}

/** RGB 色块 → 密集 SVG（同色横向合并 run-length，避免 rect 爆炸） */
export function pixelsToSVGRGB(
  matrix: { width: number; height: number; cells: { x: number; y: number; r: number; g: number; b: number }[] },
  opts: { pixelSize?: number; bg?: string } = {},
): string {
  const pixelSize = opts.pixelSize ?? 6;
  const W = matrix.width * pixelSize;
  const H = matrix.height * pixelSize;
  const bg = opts.bg ?? "#0d1117";
  const parts: string[] = [];
  parts.push(`<svg ${SVG_NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);
  // 按行分组，行内同色合并
  const byRow = new Map<number, typeof matrix.cells>();
  for (const c of matrix.cells) {
    if (!byRow.has(c.y)) byRow.set(c.y, []);
    byRow.get(c.y)!.push(c);
  }
  for (const [y, row] of byRow) {
    row.sort((a, b) => a.x - b.x);
    let i = 0;
    while (i < row.length) {
      const c = row[i];
      const key = `${c.r},${c.g},${c.b}`;
      let j = i + 1;
      while (j < row.length && `${row[j].r},${row[j].g},${row[j].b}` === key && row[j].x === row[j - 1].x + 1) j++;
      const run = j - i;
      const col = `#${c.r.toString(16).padStart(2, "0")}${c.g.toString(16).padStart(2, "0")}${c.b.toString(16).padStart(2, "0")}`;
      parts.push(`<rect x="${c.x * pixelSize}" y="${y * pixelSize}" width="${run * pixelSize}" height="${pixelSize}" fill="${col}"/>`);
      i = j;
    }
  }
  parts.push(`</svg>`);
  return parts.join("\n");
}

/** 从编码文本提取 RGB 色块段（【色块】或 RGB 矩阵块） */
export function extractRGBMatrix(text: string): string | null {
  // 【色块】段
  const m = text.match(/【[^】]*色块[^】]*】[\s\S]*?(?=【|$)/);
  if (m) {
    const body = m[0].replace(/【[^】]*】/, "");
    const parsed = parseRGBMatrix(body);
    if (parsed) return body;
  }
  // 直接 RGB 矩阵（多行 R,G,B 空格分隔）
  const parsed = parseRGBMatrix(text);
  if (parsed && parsed.cells.length > 20) return text;
  return null;
}

/**
 * 分块点阵解析：# TILE x,y 头 + 数据行 → 带偏移的像素网格
 * 支持 4×4、8×8 等任意分块，组合成大图
 */
export interface TiledMatrix {
  width: number;      // 总宽（点阵格数）
  height: number;     // 总高
  cells: { x: number; y: number; gray: number }[];
  tileW: number;      // 每块宽
  tileH: number;      // 每块高
  tilesX: number;
  tilesY: number;
}

export function parseTiledMatrix(text: string): TiledMatrix | null {
  const lines = text.split(/\r?\n/);
  const tiles: { tx: number; ty: number; lines: string[] }[] = [];
  let current: { tx: number; ty: number; lines: string[] } | null = null;
  let tileW = 0, tileH = 0, tilesX = 0, tilesY = 0;
  let maxX = 0, maxY = 0;

  for (const line of lines) {
    const tileHead = line.match(/^#\s*TILE\s*(\d+),(\d+)\s*size=(\d+)x(\d+)/);
    if (tileHead) {
      if (current) tiles.push(current);
      const tx = parseInt(tileHead[1]), ty = parseInt(tileHead[2]);
      tileW = parseInt(tileHead[3]); tileH = parseInt(tileHead[4]);
      tilesX = Math.max(tilesX, tx + 1);
      tilesY = Math.max(tilesY, ty + 1);
      current = { tx, ty, lines: [] };
      continue;
    }
    if (current && line.trim() && !line.startsWith("#")) {
      current.lines.push(line);
    }
  }
  if (current) tiles.push(current);
  if (tiles.length < 2) return null;

  const ramp: Record<string, number> = { " ": 0, ".": 1, ":": 2, "-": 3, "=": 4, "+": 5, "*": 6, "#": 7, "%": 8, "@": 9 };
  const cells: { x: number; y: number; gray: number }[] = [];

  // 全图统一 invert：统计所有块的字符分布，避免分块接缝明暗跳变
  let darkTotal = 0, allTotal = 0;
  for (const tile of tiles) {
    for (const l of tile.lines) for (const ch of l) {
      if ("@%#*".includes(ch)) darkTotal++;
      allTotal++;
    }
  }
  const inverted = allTotal > 0 && darkTotal > allTotal * 0.5;

  for (const tile of tiles) {
    const ox = tile.tx * tileW, oy = tile.ty * tileH;
    tile.lines.forEach((line, y) => {
      for (let x = 0; x < line.length; x++) {
        const ch = line[x];
        let g = ramp[ch] ?? (ch === " " ? 0 : 9);
        if (inverted) g = 9 - g;
        if (g > 0) cells.push({ x: ox + x, y: oy + y, gray: g / 9 });
      }
    });
    maxX = Math.max(maxX, ox + tileW);
    maxY = Math.max(maxY, oy + tileH);
  }

  return { width: maxX, height: maxY, cells, tileW, tileH, tilesX, tilesY };
}

export function tiledToSVG(matrix: TiledMatrix, opts: { pixelSize?: number; bg?: string; fg?: string } = {}): string {
  const pixelSize = opts.pixelSize ?? 4;
  const W = matrix.width * pixelSize;
  const H = matrix.height * pixelSize;
  const bg = opts.bg ?? "#0d1117";
  const fg = opts.fg ?? "#39d353";
  const parts: string[] = [];
  parts.push(`<svg ${SVG_NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);

  const byRow = new Map<number, typeof matrix.cells>();
  for (const c of matrix.cells) {
    if (!byRow.has(c.y)) byRow.set(c.y, []);
    byRow.get(c.y)!.push(c);
  }
  const fgr = parseInt(fg.slice(1, 3), 16), fgg = parseInt(fg.slice(3, 5), 16), fgb = parseInt(fg.slice(5, 7), 16);
  const bgr = parseInt(bg.slice(1, 3), 16), bgg = parseInt(bg.slice(3, 5), 16), bgb = parseInt(bg.slice(5, 7), 16);
  const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

  for (const [y, row] of byRow) {
    row.sort((a, b) => a.x - b.x);
    let i = 0;
    while (i < row.length) {
      const c = row[i];
      const key = c.gray;
      let j = i + 1;
      while (j < row.length && row[j].gray === key && row[j].x === row[j - 1].x + 1) j++;
      const run = j - i;
      const r = mix(bgr, fgr, c.gray).toString(16).padStart(2, "0");
      const g = mix(bgg, fgg, c.gray).toString(16).padStart(2, "0");
      const b = mix(bgb, fgb, c.gray).toString(16).padStart(2, "0");
      parts.push(`<rect x="${c.x * pixelSize}" y="${y * pixelSize}" width="${run * pixelSize}" height="${pixelSize}" fill="#${r}${g}${b}"/>`);
      i = j;
    }
  }
  parts.push(`</svg>`);
  return parts.join("\n");
}

/** 从编码文本提取 ASCII 点阵块（```围栏或【点阵】段） */
export function extractAsciiMatrix(text: string): string | null {
  // 1) ``` 代码围栏
  const fence = text.match(/```[^\n]*\n([\s\S]*?)```/);
  if (fence && fence[1].includes("@") && fence[1].includes("0|")) return fence[1];
  if (fence) return fence[1];
  // 2) 【点阵】段
  const m = text.match(/【[^】]*点阵[^】]*】[\s\S]*?```[^\n]*\n([\s\S]*?)```/);
  if (m) return m[1];
  // 3) 裸点阵文件（ascii_dot.py 输出）：标尺行 + 分隔行 + 数据行
  const lines = text.split(/\r?\n/);
  const dataStart = lines.findIndex((l) => /^\d+\|/.test(l) || /^\s*\|/.test(l));
  if (dataStart >= 0) {
    const data = lines.slice(dataStart).filter((l) => /[|]/.test(l) || /^[-=]+$/.test(l));
    if (data.length >= 3 && data.some((l) => l.includes("@") || l.includes("#") || l.includes("*"))) {
      // 去掉行标（如 0| 1| 和纯分隔行），保留点阵主体
      const body = data
        .filter((l) => /[|]/.test(l))
        .map((l) => l.replace(/^\s*\d*\|/, ""))
        .join("\n");
      if (body.trim()) return body;
    }
  }
  return null;
}

// ==================== 密集图元解析（点→线→面） ====================

/**
 * 密集折线：折线(点(10,20)(12,25)(14,22)...) | 颜色 | 粗细
 * 点坐标可以是百分比或像素（检测到 >100 视为像素）
 */
function parsePolyline(b: string): RenderElement | null {
  const pts = [...b.matchAll(/\(\s*([\d.]+)\s*(?:%|px)?\s*,\s*([\d.]+)\s*(?:%|px)?\s*\)/g)]
    .map((m) => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
  if (pts.length < 2) return null;
  const col = parseColor(b, "#39d353");
  return {
    type: "polyline",
    data: { points: pts, color: col, width: /粗|bold/.test(b) ? 3 : 1.5, pxMode: pts.some((p) => p.x > 100 || p.y > 100) },
  };
}

/**
 * 面填充：面(点(10,10)(50,10)(50,50)(10,50)) | 颜色#xxx | 实心
 * 折线/多边形闭合即面。
 */
function parseFace(b: string): RenderElement | null {
  const pts = [...b.matchAll(/\(\s*([\d.]+)\s*(?:%|px)?\s*,\s*([\d.]+)\s*(?:%|px)?\s*\)/g)]
    .map((m) => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
  if (pts.length < 3) return null;
  const col = parseColor(b, "#39d353");
  const solid = /实心|filled|solid/.test(b);
  return {
    type: "path",
    data: { points: pts, fill: solid ? col : "none", stroke: col, pxMode: pts.some((p) => p.x > 100 || p.y > 100) },
  };
}

/** 解析单行元素描述 → RenderElement（通用矢量语言：矩形/圆/椭圆/多边形/箭头/文本/K线） */
function parseElement(line: string): RenderElement | null {
  const lower = line.toLowerCase();

  // ==================== 通用方括号块优先 ====================
  const b = parseBracketBody(line);
  if (b) {
    // 矩形 / 方块 / 按钮 / 卡片
    if (/矩形|方块|按钮|卡片|box|button|card|rect/i.test(b)) {
      const pos = parseCoords(field(b, ["位置", "pos", "xy", "坐标"]) || "");
      const sz = parseSize(field(b, ["尺寸", "大小", "size"]) || "");
      const col = parseColor(b);
      const solid = /实心|filled|solid/.test(b);
      const label = quotedText(b);
      return {
        type: "rect",
        data: {
          x: pos?.x ?? 10, y: pos?.y ?? 10,
          w: sz?.w ?? 20, h: sz?.h ?? 10,
          fill: solid ? col : "none", stroke: col, strokeW: solid ? 0 : 2,
          rx: /圆角|rounded/.test(b) ? 6 : 0,
          label: label || "",
        },
      };
    }
    // 圆形 / 圆点
    if (/圆形|圆点|球|circle|ball/i.test(b)) {
      const pos = parseCoords(field(b, ["位置", "中心", "pos", "xy"]) || "");
      const col = parseColor(b);
      const radM = b.match(/半径\s*([\d.]+)\s*%?/i) || b.match(/r\s*=\s*([\d.]+)\s*%?/i);
      return {
        type: "circle",
        data: {
          x: pos?.x ?? 50, y: pos?.y ?? 50,
          r: radM ? parseFloat(radM[1]) : 5,
          fill: /实心|filled/.test(b) ? col : "none",
          stroke: col, strokeW: /实心|filled/.test(b) ? 0 : 2,
        },
      };
    }
    // 椭圆
    if (/椭圆|ellipse|oval/i.test(b)) {
      const pos = parseCoords(field(b, ["位置", "中心", "pos"]) || "");
      const sz = parseSize(field(b, ["尺寸", "大小", "size"]) || "");
      const col = parseColor(b);
      return {
        type: "ellipse",
        data: {
          x: pos?.x ?? 50, y: pos?.y ?? 50,
          rx: sz?.w ? sz.w / 2 : 10, ry: sz?.h ? sz.h / 2 : 6,
          fill: /实心|filled/.test(b) ? col : "none",
          stroke: col, strokeW: /实心|filled/.test(b) ? 0 : 2,
        },
      };
    }
    // 多边形 / 三角形
    if (/多边形|三角形|polygon|triangle/i.test(b)) {
      const pts = [...b.matchAll(/\(\s*([\d.]+)\s*%?\s*,\s*([\d.]+)\s*%?\s*\)/g)].map((m) => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
      if (pts.length >= 3) {
        const col = parseColor(b);
        return { type: "polygon", data: { points: pts, fill: /实心|filled/.test(b) ? col : "none", stroke: col } };
      }
    }
    // 箭头
    if (/箭头|arrow/i.test(b)) {
      const fm = b.match(/从\s*\(\s*([\d.]+)\s*%?\s*,\s*([\d.]+)\s*%?\s*\)/i);
      const tm = b.match(/到\s*\(\s*([\d.]+)\s*%?\s*,\s*([\d.]+)\s*%?\s*\)/i);
      if (fm && tm) {
        return {
          type: "arrow",
          data: {
            x0: parseFloat(fm[1]), y0: parseFloat(fm[2]),
            x1: parseFloat(tm[1]), y1: parseFloat(tm[2]),
            color: parseColor(b, "#ffffff"), width: /粗/.test(b) ? 4 : 2,
          },
        };
      }
    }
    // 文本块
    if (/文本|标题|文字|label|text|title/i.test(b) && !/标注|曲线转折|按钮/.test(b)) {
      const pos = parseCoords(field(b, ["位置", "pos"]) || "");
      const col = parseColor(b, "#ffffff");
      const txt = quotedText(b) || b.replace(/^[^|]*[|]\s*/, "").split("|")[0].replace(/^(文本|标题|文字|label|text|title)\s*[:：]?\s*/i, "").trim().slice(0, 60);
      const sizeM = b.match(/字号\s*([\d.]+)/i) || b.match(/size\s*=\s*([\d.]+)/i);
      return {
        type: "text",
        data: {
          x: pos?.x ?? 50, y: pos?.y ?? 50,
          text: txt || "", color: col,
          size: sizeM ? parseFloat(sizeM[1]) : 16,
          bold: /粗|bold/.test(b),
        },
      };
    }
  }

  // ==================== 元素列表格式（mm_vision 真实输出） ====================
  // - 类型|范围(x,y-x,y 或 单点)|尺寸(wxh)|颜色|标注
  // 示例: - 主雪峰|30,19-70,38|40x19|雪白+金色日照|顶点(49,19)
  //       - 湖面|0,58-100,84|100x26|青蓝|-
  //       - 涟漪A|中心(68,64)|半径≈6|同心圆|-
  if (line.startsWith("- ") || line.startsWith("• ") || line.startsWith("* ")) {
    const parts = line.replace(/^[-•*]\s+/, "").split("|").map((p) => p.trim());
    if (parts.length >= 2) {
      const type = parts[0].toLowerCase();
      const range = parts[1];
      const size = parts[2] || "";
      const colorDesc = parts[3] || "";
      const label = parts[4] && parts[4] !== "-" ? parts[4] : "";
      const col = parseColor(colorDesc, "#cccccc");

      // 范围解析：x1,y1-x2,y2 或 中心(x,y) 或 x,y
      let x0: number | null = null, y0: number | null = null, x1: number | null = null, y1: number | null = null;
      const boxMatch = range.match(/(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
      if (boxMatch) {
        x0 = parseFloat(boxMatch[1]); y0 = parseFloat(boxMatch[2]);
        x1 = parseFloat(boxMatch[3]); y1 = parseFloat(boxMatch[4]);
      } else {
        const center = range.match(/中心\s*\(?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
        if (center) {
          x0 = parseFloat(center[1]); y0 = parseFloat(center[2]);
        }
      }

      // 尺寸解析：WxH
      let w: number | null = null, h: number | null = null;
      const sizeMatch = size.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/);
      if (sizeMatch) { w = parseFloat(sizeMatch[1]); h = parseFloat(sizeMatch[2]); }
      // 半径（涟漪/圆）
      const radMatch = size.match(/半径≈?(\d+(?:\.\d+)?)/) || range.match(/半径≈?(\d+(?:\.\d+)?)/);

      // 圆形：涟漪/圆点/球
      if (/涟漪|圆|球|circle|ball/.test(type)) {
        if (x0 !== null && y0 !== null) {
          return {
            type: "circle",
            data: {
              x: x0, y: y0,
              r: radMatch ? parseFloat(radMatch[1]) : (w ? w / 2 : 5),
              fill: "none", stroke: col, strokeW: 2,
            },
          };
        }
      }
      // 矩形/区域：天空/云海/草地/湖面/坡/带/脊/岸
      if (/天空|云海|草地|湖|坡|带|脊|岸|田|区域|rect|band|area/.test(type)) {
        if (x0 !== null && y0 !== null && x1 !== null && y1 !== null) {
          return {
            type: "rect",
            data: {
              x: x0, y: y0,
              w: x1 - x0, h: y1 - y0,
              fill: col, stroke: col, strokeW: 0,
              rx: 0, label: "",
            },
          };
        }
      }
      // 山/峰/三角形：主雪峰/左雪峰/岩脊/三角
      if (/雪峰|峰|山|岩|脊|三角|peak|mountain|ridge/.test(type)) {
        if (x0 !== null && y0 !== null && x1 !== null && y1 !== null) {
          const cx = (x0 + x1) / 2;
          // 顶点：尝试从标注取 (x,y)
          const apex = label.match(/\(?(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)\)?/) || (label.includes("顶点") ? null : null);
          const apexX = apex ? parseFloat(apex[1]) : cx;
          const apexY = apex ? parseFloat(apex[2]) : y0;
          return {
            type: "polygon",
            data: {
              points: [
                { x: x0, y: y1 }, { x: x1, y: y1 }, { x: apexX, y: apexY },
              ],
              fill: col, stroke: col,
            },
          };
        }
      }
      // 溪/路/线
      if (/溪|路|线|river|path|trail/.test(type)) {
        if (x0 !== null && y0 !== null && x1 !== null && y1 !== null) {
          return {
            type: "line",
            data: { x0, y0, x1, y1, color: col, width: /白|white/.test(colorDesc) ? 3 : 2 },
          };
        }
      }
      // 树/瀑布/石/其他：小矩形
      if (x0 !== null && y0 !== null && x1 !== null && y1 !== null) {
        return {
          type: "rect",
          data: {
            x: x0, y: y0, w: x1 - x0, h: y1 - y0,
            fill: col, stroke: col, strokeW: 0, rx: 0, label: "",
          },
        };
      }
      if (x0 !== null && y0 !== null && w && h) {
        return {
          type: "rect",
          data: { x: x0, y: y0, w, h, fill: col, stroke: col, strokeW: 0, rx: 0, label: "" },
        };
      }
    }
  }


  if (b && /折线|polyline/.test(b) && b.includes("(")) {
    const el = parsePolyline(b);
    if (el) return el;
  }
  // 面填充（线→面）
  if (b && /面|face|polygon/.test(b) && b.includes("(") && (b.match(/\(/g) || []).length >= 3) {
    const el = parseFace(b);
    if (el) return el;
  }
  // 像素网格（点阵）
  if (b && /点阵|像素|pixel|matrix/.test(b)) {
    return { type: "pixels", data: { note: b } };
  }


  // K线蜡烛：[K线蜡烛 | x=6%-94% | 24根 | 红#e0534b阳/绿#3fc47f阴]
  if (lower.includes("k线") || lower.includes("蜡烛") || lower.includes("kline")) {
    const xm = line.match(/x\s*=\s*(\d+(?:\.\d+)?)\s*%?\s*-\s*(\d+(?:\.\d+)?)\s*%?/);
    const nm = line.match(/(\d+)\s*根/);
    const up = line.match(/(?:红|阳)[^/#]*?(#[\da-fA-F]{3,8})/) || line.match(/#([\da-fA-F]{3,8})[^\n]*(?:阳|up|红)/i);
    const down = line.match(/(?:绿|阴)[^/#]*?(#[\da-fA-F]{3,8})/) || line.match(/#([\da-fA-F]{3,8})[^\n]*(?:阴|down|绿)/i);
    return {
      type: "candles",
      data: {
        x0: xm ? parseFloat(xm[1]) : 5,
        x1: xm ? parseFloat(xm[2]) : 95,
        count: nm ? parseInt(nm[1]) : 24,
        upColor: up ? (up[1] ? "#" + up[1] : up[0]) : "#e0534b",
        downColor: down ? (down[1] ? "#" + down[1] : down[0]) : "#3fc47f",
      },
    };
  }

  // 均线/趋势线/折线：[MA5 黄色 | 从(4%,72%)到(96%,30%) | 上升趋势]
  if (lower.includes("从") && lower.includes("到") && (lower.includes("线") || lower.includes("均") || lower.includes("趋势"))) {
    const from = line.match(/从\s*\(?\s*(\d+(?:\.\d+)?)\s*[%,]\s*,\s*(\d+(?:\.\d+)?)\s*[%,]?\s*\)?/);
    const to = line.match(/到\s*\(?\s*(\d+(?:\.\d+)?)\s*[%,]\s*,\s*(\d+(?:\.\d+)?)\s*[%,]?\s*\)?/);
    if (from && to) {
      return {
        type: "line",
        data: {
          x0: parseFloat(from[1]), y0: parseFloat(from[2]),
          x1: parseFloat(to[1]), y1: parseFloat(to[2]),
          color: parseColor(line, "#f5c542"),
          width: /粗|bold|thick/.test(lower) ? 4 : 2,
        },
      };
    }
  }

  // 水平线：支撑位/压力位/水平线 y=42% | 标注 "SUPPORT 275"
  if ((lower.includes("支撑") || lower.includes("压力") || lower.includes("水平")) && line.includes("y=")) {
    const ym = line.match(/y\s*=\s*(\d+(?:\.\d+)?)\s*%?/);
    if (ym) {
      const label = line.match(/["""']([^""""']+)["""']/) || line.match(/标注\s*[:：]?\s*([^\s|，,]+)/);
      const isResist = lower.includes("压力") || lower.includes("resist");
      return {
        type: "hline",
        data: {
          y: parseFloat(ym[1]),
          color: isResist ? "#ff8c8c" : "#00c8a0",
          label: label ? label[1] : "",
          isResist,
        },
      };
    }
  }

  // 标注点：最高点/峰值/最低点 位于 (x%,y%) | 数值
  if (line.includes("位于") || line.includes("位置") || lower.includes("peak") || lower.includes("标注")) {
    const pos = line.match(/位于\s*\(?\s*(\d+(?:\.\d+)?)\s*[%,]\s*,\s*(\d+(?:\.\d+)?)\s*[%,]?\s*\)?/)
      || line.match(/\(?\s*(\d+(?:\.\d+)?)\s*[%,]\s*,\s*(\d+(?:\.\d+)?)\s*[%,]?\s*\)?/);
    if (pos) {
      const val = line.match(/["""']([^""""']+)["""']/) || line.match(/(?:数值|值|价)\s*[:：]?\s*([\d.]+)/);
      return {
        type: "marker",
        data: {
          x: parseFloat(pos[1]), y: parseFloat(pos[2]),
          label: val ? val[1] : "",
          color: lower.includes("最低") || lower.includes("bottom") ? "#00c8a0" : "#ffd75e",
        },
      };
    }
  }

  // 坐标轴
  if (lower.includes("坐标轴") || lower.includes("axis")) {
    return { type: "grid", data: { labels: line } };
  }

  return null;
}

// ==================== 渲染 ====================

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function randSeeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * 通感编码文本 → SVG 字符串
 * @param synesthesia 通感编码文本（mm_vision 输出）
 * @param width 输出宽度 px（默认 960）
 */
export function renderSynesthesiaToSVG(synesthesia: string, width = 960): string {
  const lines = synesthesia.split("\n").map((l) => l.trim()).filter(Boolean);

  // ════════ 像素级模式：分块点阵 → RGB 色块 → ASCII 点阵 ════════
  const tiled = parseTiledMatrix(synesthesia);
  if (tiled) {
    // 分块组合渲染：总宽由 width 决定，每格像素 = width / 总列数
    const pixelSize = Math.max(1, Math.floor(width / tiled.width));
    return tiledToSVG(tiled, { pixelSize, bg: "#0d1117", fg: "#39d353" });
  }
  const rgbText = extractRGBMatrix(synesthesia);
  if (rgbText) {
    const matrix = parseRGBMatrix(rgbText)!;
    const pixelSize = Math.max(1, Math.floor(width / matrix.width));
    return pixelsToSVGRGB(matrix, { pixelSize });
  }
  const asciiMatrix = extractAsciiMatrix(synesthesia);
  if (asciiMatrix) {
    const matrix = asciiMatrixToPixels(asciiMatrix);
    // 尺寸：默认 8px/格；可调 width 参数（整幅图目标宽）
    const pixelSize = Math.max(1, Math.floor(width / matrix.width));
    return pixelsToSVG(matrix, { pixelSize, bg: "#0d1117", fg: "#39d353" });
  }

  // 画布解析
  let canvas: Canvas = { width, height: Math.round(width * 9 / 16), bgColor: "#1a1e2c" };
  for (const line of lines) {
    if (line.includes("画布")) {
      const ar = parseAspectRatio(line);
      canvas.width = width;
      canvas.height = Math.round(width * ar[1] / ar[0]);
      canvas.bgColor = parseColor(line, "#1a1e2c");
      break;
    }
  }

  const W = canvas.width, H = canvas.height;
  const px = (x: number) => (x / 100) * W;
  const py = (y: number) => (y / 100) * H;

  // 收集元素
  const elements: RenderElement[] = [];
  for (const line of lines) {
    const body = line.replace(/^\d+\.\s*/, ""); // 去掉序号前缀
    if (!body.startsWith("【") || body.includes("画布")) continue;
    const el = parseElement(body);
    if (el) elements.push(el);
  }

  // 统计 K 线数（供随机种子）
  const candleEl = elements.find((e) => e.type === "candles");
  const rng = randSeeded(candleEl ? candleEl.data.count * 7 + 13 : 42);

  const parts: string[] = [];
  parts.push(`<svg ${SVG_NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${canvas.bgColor}"/>`);
  parts.push(`<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#778"/></marker></defs>`);

  // 坐标轴 + 网格
  const hasGrid = elements.some((e) => e.type === "grid");
  if (hasGrid) {
    parts.push(`<line x1="${px(6)}" y1="${py(90)}" x2="${px(96)}" y2="${py(90)}" stroke="#667" stroke-width="1.5"/>`);
    parts.push(`<line x1="${px(6)}" y1="${py(8)}" x2="${px(6)}" y2="${py(90)}" stroke="#667" stroke-width="1.5"/>`);
    for (let gx = 10; gx <= 90; gx += 10) {
      parts.push(`<line x1="${px(gx)}" y1="${py(8)}" x2="${px(gx)}" y2="${py(90)}" stroke="#2a3044" stroke-width="0.5" stroke-dasharray="3,5"/>`);
    }
    for (let gy = 10; gy <= 80; gy += 10) {
      parts.push(`<line x1="${px(6)}" y1="${py(gy)}" x2="${px(96)}" y2="${py(gy)}" stroke="#2a3044" stroke-width="0.5" stroke-dasharray="3,5"/>`);
    }
    parts.push(`<text x="${px(50)}" y="${py(95)}" fill="#889" font-size="12" text-anchor="middle" font-family="monospace">time</text>`);
    parts.push(`<text x="${px(2)}" y="${py(10)}" fill="#889" font-size="12" font-family="monospace">price</text>`);
  }

  // ── 通用图形：矩形 / 圆形 / 椭圆 / 多边形 / 箭头 / 文本 ──
  for (const e of elements) {
    const d = e.data;
    switch (e.type) {
      case "rect": {
        parts.push(`<rect x="${px(d.x)}" y="${py(d.y)}" width="${px(d.w)}" height="${py(d.h)}" fill="${d.fill}" stroke="${d.stroke}" stroke-width="${d.strokeW}" rx="${d.rx}"/>`);
        if (d.label) parts.push(`<text x="${px(d.x) + px(d.w) / 2}" y="${py(d.y) + py(d.h) / 2 + 5}" fill="${d.stroke}" font-size="13" text-anchor="middle" font-family="monospace">${esc(d.label)}</text>`);
        break;
      }
      case "circle": {
        parts.push(`<circle cx="${px(d.x)}" cy="${py(d.y)}" r="${px(d.r)}" fill="${d.fill}" stroke="${d.stroke}" stroke-width="${d.strokeW}"/>`);
        break;
      }
      case "ellipse": {
        parts.push(`<ellipse cx="${px(d.x)}" cy="${py(d.y)}" rx="${px(d.rx)}" ry="${py(d.ry)}" fill="${d.fill}" stroke="${d.stroke}" stroke-width="${d.strokeW}"/>`);
        break;
      }
      case "polygon": {
        const pts = d.points.map((pt: any) => `${px(pt.x)},${py(pt.y)}`).join(" ");
        parts.push(`<polygon points="${pts}" fill="${d.fill}" stroke="${d.stroke}" stroke-width="2"/>`);
        break;
      }
      case "arrow": {
        const dx = px(d.x1) - px(d.x0), dy = py(d.y1) - py(d.y0);
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / len, uy = dy / len;
        const hx = px(d.x1) - ux * 12, hy = py(d.y1) - uy * 12;
        parts.push(`<line x1="${px(d.x0)}" y1="${py(d.y0)}" x2="${hx}" y2="${hy}" stroke="${d.color}" stroke-width="${d.width}"/>`);
        parts.push(`<polygon points="${px(d.x1)},${py(d.y1)} ${hx - uy * 5},${hy + ux * 5} ${hx + uy * 5},${hy - ux * 5}" fill="${d.color}"/>`);
        break;
      }
      case "polyline": {
        const pts = d.points.map((pt: any) => `${d.pxMode ? pt.x : px(pt.x)},${d.pxMode ? pt.y : py(pt.y)}`).join(" ");
        parts.push(`<polyline points="${pts}" fill="none" stroke="${d.color}" stroke-width="${d.width}"/>`);
        break;
      }
      case "path": {
        const pts = d.points.map((pt: any) => `${d.pxMode ? pt.x : px(pt.x)},${d.pxMode ? pt.y : py(pt.y)}`).join(" ");
        parts.push(`<polygon points="${pts}" fill="${d.fill}" stroke="${d.stroke}" stroke-width="1.5"/>`);
        break;
      }
      case "text": {
        parts.push(`<text x="${px(d.x)}" y="${py(d.y)}" fill="${d.color}" font-size="${d.size}" font-weight="${d.bold ? 700 : 400}" font-family="monospace">${esc(d.text)}</text>`);
        break;
      }
    }
  }

  // 密集折线
  for (const e of elements) {
    if (e.type !== "polyline") continue;
    const d = e.data;
    const pts = d.points.map((pt: any) => `${d.pxMode ? pt.x : px(pt.x)},${d.pxMode ? pt.y : py(pt.y)}`).join(" ");
    parts.push(`<polyline points="${pts}" fill="none" stroke="${d.color}" stroke-width="${d.width}"/>`);
  }

  // 面填充（密集闭合区域）
  for (const e of elements) {
    if (e.type !== "path") continue;
    const d = e.data;
    const pts = d.points.map((pt: any) => `${d.pxMode ? pt.x : px(pt.x)},${d.pxMode ? pt.y : py(pt.y)}`).join(" ");
    parts.push(`<polygon points="${pts}" fill="${d.fill}" stroke="${d.stroke}" stroke-width="1.5"/>`);
  }

  // 折线
  for (const e of elements) {
    if (e.type !== "line") continue;
    const d = e.data;
    parts.push(`<line x1="${px(d.x0)}" y1="${py(d.y0)}" x2="${px(d.x1)}" y2="${py(d.y1)}" stroke="${d.color}" stroke-width="${d.width}"/>`);
    // 箭头（趋势方向）
    parts.push(`<line x1="${px(d.x1)}" y1="${py(d.y1)}" x2="${px(d.x1)}" y2="${py(d.y1)}" stroke="${d.color}" stroke-width="0" marker-end="url(#arr)"/>`);
  }

  // K线蜡烛（合成形态：编码只有范围/数量/颜色，渲染为趋势化蜡烛）
  if (candleEl) {
    const d = candleEl.data;
    const n = Math.min(d.count, 120);
    const x0 = px(d.x0), x1 = px(d.x1);
    const cw = (x1 - x0) / n;
    const bw = Math.max(cw * 0.55, 1);
    // 用随机游走生成温和趋势
    const ys: number[] = [70];
    for (let i = 1; i < n; i++) ys.push(ys[i - 1] + (rng() - 0.45) * 5);
    const ymin = Math.min(...ys), ymax = Math.max(...ys);
    const norm = (v: number) => 80 - ((v - ymin) / Math.max(ymax - ymin, 1)) * 60;
    for (let i = 0; i < n; i++) {
      const cx = x0 + cw * i + cw / 2;
      const o = ys[i];
      const c = ys[Math.min(i + 1, n - 1)];
      const up = c >= o;
      const col = up ? d.upColor : d.downColor;
      const yo = py(norm(o)), yc = py(norm(c));
      const hi = py(norm(Math.max(o, c) + 0.6)), lo = py(norm(Math.min(o, c) - 0.6));
      parts.push(`<line x1="${cx}" y1="${hi}" x2="${cx}" y2="${lo}" stroke="${col}" stroke-width="1.2"/>`);
      parts.push(`<rect x="${cx - bw / 2}" y="${Math.min(yo, yc)}" width="${bw}" height="${Math.max(Math.abs(yo - yc), 1)}" fill="${col}"/>`);
    }
  }

  // 水平线（支撑/压力）
  for (const e of elements) {
    if (e.type !== "hline") continue;
    const d = e.data;
    parts.push(`<line x1="${px(5)}" y1="${py(d.y)}" x2="${px(96)}" y2="${py(d.y)}" stroke="${d.color}" stroke-width="2.5"/>`);
    if (d.label) {
      parts.push(`<text x="${px(70)}" y="${py(d.y) - 10}" fill="${d.color}" font-size="13" font-family="monospace">${esc(d.label)}</text>`);
    }
  }

  // 标注点
  for (const e of elements) {
    if (e.type !== "marker") continue;
    const d = e.data;
    parts.push(`<circle cx="${px(d.x)}" cy="${py(d.y)}" r="6" fill="none" stroke="${d.color}" stroke-width="2"/>`);
    if (d.label) {
      parts.push(`<text x="${px(d.x) + 10}" y="${py(d.y) - 8}" fill="${d.color}" font-size="13" font-family="monospace">${esc(d.label)}</text>`);
    }
  }

  // 原文备注（如果有"关系"描述，作为图注）
  const rel = lines.find((l) => l.includes("关系"));
  if (rel) {
    parts.push(`<text x="${px(50)}" y="${py(97)}" fill="#778" font-size="11" text-anchor="middle" font-family="monospace">${esc(rel.slice(0, 80))}</text>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

/**
 * 通感编码 → PNG（需要 scripts/render_svg.py + Pillow 的 cairosvg，或浏览器）
 * 简化：输出 SVG 文件路径 + 可选 base64 data URL
 */
export function renderSynesthesiaToSVGFile(synesthesia: string, outPath: string, width = 960): string {
  const svg = renderSynesthesiaToSVG(synesthesia, width);
  const fs = require("fs");
  fs.writeFileSync(outPath, svg, "utf-8");
  return outPath;
}

// ==================== CLI 便捷 ====================

export function synesthesiaToDataURL(synesthesia: string, width = 960): string {
  const svg = renderSynesthesiaToSVG(synesthesia, width);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}


// ==================== HTML 渲染器（canvas 真彩色，浏览器零依赖） ====================

/**
 * 像素矩阵 → HTML 页面（canvas + putImageData 渲染）
 * 浏览器打开即得图片，支持缩放/右键保存 PNG
 */
export function pixelsToHTML(
  cells: { x: number; y: number; gray: number }[],
  opts: { width: number; height: number; bg?: string; fg?: string; scale?: number; title?: string },
): string {
  const scale = opts.scale ?? 8;
  const W = opts.width, H = opts.height;
  const bg = opts.bg ?? "#0d1117";
  const fg = opts.fg ?? "#39d353";
  const title = opts.title ?? "mm-vision 渲染";

  // 构建像素数据：JSON 数组 [x,y,gray]
  const data = JSON.stringify(cells.map((c) => [c.x, c.y, c.gray]));
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { margin: 0; background: #111; display: flex; flex-direction: column; align-items: center; padding: 16px; font-family: monospace; }
  #wrap { background: #000; display: inline-block; border: 1px solid #333; }
  canvas { display: block; image-rendering: pixelated; }
  .bar { color: #888; font-size: 12px; margin: 8px 0; }
  button { background: #1d4ed8; color: #fff; border: 0; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
  button:hover { background: #2563eb; }
</style>
</head>
<body>
  <div class="bar">${title} — ${W}×${H} 像素 × ${scale} 缩放（点击保存 PNG）</div>
  <div id="wrap"><canvas id="cv" width="${W}" height="${H}"></canvas></div>
  <div class="bar"><button onclick="save()">💾 保存 PNG</button></div>
<script>
const W = ${W}, H = ${H}, scale = ${scale};
const fgHex = "${fg}", bgHex = "${bg}";
const fg = [parseInt(fgHex.slice(1,3),16), parseInt(fgHex.slice(3,5),16), parseInt(fgHex.slice(5,7),16)];
const bg = [parseInt(bgHex.slice(1,3),16), parseInt(bgHex.slice(3,5),16), parseInt(bgHex.slice(5,7),16)];
const mix = (a,b,t) => Math.round(a + (b-a)*t);
const cv = document.getElementById("cv");
const ctx = cv.getContext("2d");
const img = ctx.createImageData(W, H);
// 背景
for (let i = 0; i < W*H; i++) { img.data[i*4] = bg[0]; img.data[i*4+1] = bg[1]; img.data[i*4+2] = bg[2]; img.data[i*4+3] = 255; }
// 像素
const cells = ${data};
for (const [x, y, g] of cells) {
  const i = (y*W + x) * 4;
  img.data[i] = mix(bg[0], fg[0], g);
  img.data[i+1] = mix(bg[1], fg[1], g);
  img.data[i+2] = mix(bg[2], fg[2], g);
  img.data[i+3] = 255;
}
ctx.putImageData(img, 0, 0);
// 缩放显示
cv.style.width = (W*scale) + "px";
cv.style.height = (H*scale) + "px";
function save() {
  const out = document.createElement("canvas");
  out.width = W*scale; out.height = H*scale;
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  octx.drawImage(cv, 0, 0, out.width, out.height);
  out.toBlob(b => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "mm-vision-${Date.now()}.png";
    a.click();
  });
}
</script>
</body>
</html>`;
}

/** RGB 三元组矩阵 → HTML（真彩色 canvas） */
export function rgbToHTML(
  cells: { x: number; y: number; r: number; g: number; b: number }[],
  opts: { width: number; height: number; bg?: string; scale?: number; title?: string },
): string {
  const scale = opts.scale ?? 4;
  const W = opts.width, H = opts.height;
  const title = opts.title ?? "mm-vision RGB 渲染";
  const data = JSON.stringify(cells.map((c) => [c.x, c.y, c.r, c.g, c.b]));
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { margin: 0; background: #111; display: flex; flex-direction: column; align-items: center; padding: 16px; font-family: monospace; }
  canvas { display: block; image-rendering: pixelated; border: 1px solid #333; }
  .bar { color: #888; font-size: 12px; margin: 8px 0; }
  button { background: #1d4ed8; color: #fff; border: 0; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
</style>
</head>
<body>
  <div class="bar">${title} — ${W}×${H} 像素真彩色（点击保存 PNG）</div>
  <canvas id="cv" width="${W}" height="${H}"></canvas>
  <div class="bar"><button onclick="save()">💾 保存 PNG</button></div>
<script>
const W = ${W}, H = ${H}, scale = ${scale};
const cv = document.getElementById("cv");
const ctx = cv.getContext("2d");
const img = ctx.createImageData(W, H);
const cells = ${data};
for (const [x, y, r, g, b] of cells) {
  const i = (y*W + x) * 4;
  img.data[i] = r; img.data[i+1] = g; img.data[i+2] = b; img.data[i+3] = 255;
}
ctx.putImageData(img, 0, 0);
cv.style.width = (W*scale) + "px";
cv.style.height = (H*scale) + "px";
function save() {
  const out = document.createElement("canvas");
  out.width = W*scale; out.height = H*scale;
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  octx.drawImage(cv, 0, 0, out.width, out.height);
  out.toBlob(b => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "mm-vision-rgb-${Date.now()}.png";
    a.click();
  });
}
</script>
</body>
</html>`;
}

/**
 * RGB 三层嵌套解析：三组点阵分别编码 R/G/B 通道
 * 格式：【R通道】点阵... 【G通道】点阵... 【B通道】点阵...
 * 每通道字符 0-9 级灰度 → 组合成真彩色像素
 */
export function parseRGBChannels(text: string): { width: number; height: number; cells: { x: number; y: number; r: number; g: number; b: number }[] } | null {
  const channelRegex = /【\s*([RrGgBb])\s*通道[^】]*】\s*([\s\S]*?)(?=【|$)/g;
  const channels: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = channelRegex.exec(text)) !== null) {
    const ch = m[1].toUpperCase();
    channels[ch] = m[2];
  }
  if (!channels.R || !channels.G || !channels.B) return null;

  const ramp: Record<string, number> = { " ": 0, ".": 1, ":": 2, "-": 3, "=": 4, "+": 5, "*": 6, "#": 7, "%": 8, "@": 9 };
  const parseChan = (raw: string): { width: number; height: number; vals: Map<string, number> } => {
    const lines = raw.split(/\r?\n/).map((l) => l.replace(/\r$/, "")).filter((l) => l.trim().length > 0);
    const vals = new Map<string, number>();
    let width = 0;
    let realHeight = 0;
    lines.forEach((line) => {
      // 去行首空格 + 去行标（如 0| 或 0|）
      const clean = line.replace(/^\s*/, "").replace(/^\d*\|/, "");
      // 只统计点阵字符行（含 10 级字符），跳过标尺/分隔行
      if (!/^[-=]+$/.test(clean) && !/^[\d\s]+$/.test(clean)) {
        const y = realHeight;
        for (let x = 0; x < clean.length; x++) {
          const g = ramp[clean[x]] ?? (clean[x] === " " ? 0 : 9);
          vals.set(`${x},${y}`, g / 9);
          if (x + 1 > width) width = x + 1;
        }
        realHeight++;
      }
    });
    return { width, height: realHeight, vals };
  };

  const R = parseChan(channels.R), G = parseChan(channels.G), B = parseChan(channels.B);
  const width = Math.max(R.width, G.width, B.width);
  const height = Math.max(R.height, G.height, B.height);
  const cells: { x: number; y: number; r: number; g: number; b: number }[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const key = `${x},${y}`;
      const r = Math.round((R.vals.get(key) ?? 0) * 255);
      const g = Math.round((G.vals.get(key) ?? 0) * 255);
      const b = Math.round((B.vals.get(key) ?? 0) * 255);
      if (r > 4 || g > 4 || b > 4) cells.push({ x, y, r, g, b });
    }
  }
  return { width, height, cells };
}


// ==================== 像素级重建（pixel 模式） ====================

export interface PixelGridCell {
  r: number; g: number; b: number;
  dir: string;   // 渐变方向: ←↑→↓↖↗↘↙ 或 ·
  detail: boolean; // '!' 标记：有细纹理
}

export interface PixelGrid {
  cols: number;
  rows: number;
  cells: PixelGridCell[][];
}

/**
 * 解析 pixel 模式的【色块网格】输出 → 结构化网格
 * 支持格式：R,G,B← / R,G,B / R,G,B! 
 */
export function parsePixelGrid(text: string): PixelGrid | null {
  // 找【色块网格】段或纯 16x12 数字网格
  const section = text.match(/【\s*色块网格[^】]*】\s*([\s\S]*?)(?=【|$)/);
  const body = section ? section[1] : text;
  const lines = body.split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d*\|/, "").trim())
    .filter((l) => l.includes(",") && /^[\d,\s!←↑→↓↖↗↘↙·]+$/.test(l));
  if (lines.length < 2) return null;

  const cells: PixelGridCell[][] = [];
  let cols = 0;
  for (const line of lines) {
    const row: PixelGridCell[] = [];
    // 匹配 R,G,B 后跟方向字符或 !
    const re = /(\d{1,3}),(\d{1,3}),(\d{1,3})([←↑→↓↖↗↘↙·]?)(!?)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      row.push({
        r: Math.min(255, parseInt(m[1])),
        g: Math.min(255, parseInt(m[2])),
        b: Math.min(255, parseInt(m[3])),
        dir: m[4] || "·",
        detail: m[5] === "!",
      });
    }
    if (row.length > 0) {
      cells.push(row);
      cols = Math.max(cols, row.length);
    }
  }
  if (cells.length < 2 || cols < 2) return null;
  return { cols, rows: cells.length, cells };
}

/** 方向字符 → 单位向量（用于块内渐变） */
function dirVector(dir: string): [number, number] {
  switch (dir) {
    case "←": return [-1, 0];
    case "→": return [1, 0];
    case "↑": return [0, -1];
    case "↓": return [0, 1];
    case "↖": return [-0.71, -0.71];
    case "↗": return [0.71, -0.71];
    case "↘": return [0.71, 0.71];
    case "↙": return [-0.71, 0.71];
    default: return [0, 0];
  }
}

/**
 * 色块网格 → 平滑插值渲染
 * 核心：相邻格颜色线性插值（消除块状感）+ 块内渐变方向 + 纹理抖动
 */
export function pixelGridToHTML(grid: PixelGrid, opts: { scale?: number; smooth?: boolean; title?: string } = {}): string {
  const scale = opts.scale ?? 6;
  const smooth = opts.smooth ?? true;
  const W = grid.cols, H = grid.rows;
  const title = opts.title ?? "mm-vision 像素级重建";
  const outW = W * scale, outH = H * scale;

  // 生成像素数据：插值后每个输出像素一个 RGB
  // 先做网格→高清插值（双线性）
  const px = new Array(outW * outH * 4).fill(0);
  const get = (cx: number, cy: number): [number, number, number] => {
    const x = Math.max(0, Math.min(grid.cols - 1, cx));
    const y = Math.max(0, Math.min(grid.rows - 1, cy));
    const c = grid.cells[y][x];
    return [c.r, c.g, c.b];
  };

  for (let py = 0; py < outH; py++) {
    for (let pxx = 0; pxx < outW; pxx++) {
      // 映射回网格坐标（带平滑）
      const gx = (pxx + 0.5) / scale - 0.5;
      const gy = (py + 0.5) / scale - 0.5;
      let r: number, g: number, b: number;
      if (smooth) {
        // 双线性插值
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const fx = gx - x0, fy = gy - y0;
        const c00 = get(x0, y0), c10 = get(x0 + 1, y0), c01 = get(x0, y0 + 1), c11 = get(x0 + 1, y0 + 1);
        r = (c00[0] * (1 - fx) + c10[0] * fx) * (1 - fy) + (c01[0] * (1 - fx) + c11[0] * fx) * fy;
        g = (c00[1] * (1 - fx) + c10[1] * fx) * (1 - fy) + (c01[1] * (1 - fx) + c11[1] * fx) * fy;
        b = (c00[2] * (1 - fx) + c10[2] * fx) * (1 - fy) + (c01[2] * (1 - fx) + c11[2] * fx) * fy;
      } else {
        const c = get(Math.round(gx), Math.round(gy));
        r = c[0]; g = c[1]; b = c[2];
      }
      const i = (py * outW + pxx) * 4;
      px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b); px[i + 3] = 255;
    }
  }

  const data = JSON.stringify(Array.from({ length: outW * outH }, (_, i) => [
    i % outW, Math.floor(i / outW), px[i * 4], px[i * 4 + 1], px[i * 4 + 2]
  ]));

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { margin: 0; background: #111; display: flex; flex-direction: column; align-items: center; padding: 16px; font-family: monospace; }
  canvas { display: block; image-rendering: pixelated; border: 1px solid #333; }
  .bar { color: #888; font-size: 12px; margin: 8px 0; }
  button { background: #1d4ed8; color: #fff; border: 0; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
</style>
</head>
<body>
  <div class="bar">${title} — ${grid.cols}×${grid.rows} 网格 → ${outW}×${outH} 平滑插值（点击保存 PNG）</div>
  <canvas id="cv" width="${outW}" height="${outH}"></canvas>
  <div class="bar"><button onclick="save()">💾 保存 PNG</button></div>
<script>
const W = ${outW}, H = ${outH};
const cv = document.getElementById("cv");
const ctx = cv.getContext("2d");
const img = ctx.createImageData(W, H);
const cells = ${data};
for (const [x, y, r, g, b] of cells) {
  const i = (y * W + x) * 4;
  img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
}
ctx.putImageData(img, 0, 0);
function save() {
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const octx = out.getContext("2d");
  octx.putImageData(img, 0, 0);
  out.toBlob(b => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "mm-vision-pixel-${Date.now()}.png";
    a.click();
  });
}
</script>
</body>
</html>`;
}

/**
 * 色块网格 → SVG（矢量渐变块，无浏览器依赖）
 * 每格一个 rect + linearGradient（方向），detail 格加噪点
 */
export function pixelGridToSVG(grid: PixelGrid, opts: { scale?: number; title?: string } = {}): string {
  const scale = opts.scale ?? 8;
  const W = grid.cols * scale, H = grid.rows * scale;
  const parts: string[] = [];
  parts.push(`<svg ${SVG_NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  const defs: string[] = [];
  let gid = 0;
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      const c = grid.cells[y][x];
      const [dx, dy] = dirVector(c.dir);
      const col = `#${c.r.toString(16).padStart(2, "0")}${c.g.toString(16).padStart(2, "0")}${c.b.toString(16).padStart(2, "0")}`;
      if (c.dir !== "·" && (dx !== 0 || dy !== 0)) {
        // 渐变：沿方向从亮到暗（模拟光照）
        const gidNow = `g${gid++}`;
        const x1 = 50 + dx * 50, y1 = 50 + dy * 50;
        const x2 = 50 - dx * 50, y2 = 50 - dy * 50;
        const light = `#${Math.min(255, c.r + 40).toString(16).padStart(2, "0")}${Math.min(255, c.g + 40).toString(16).padStart(2, "0")}${Math.min(255, c.b + 40).toString(16).padStart(2, "0")}`;
        const dark = `#${Math.max(0, c.r - 40).toString(16).padStart(2, "0")}${Math.max(0, c.g - 40).toString(16).padStart(2, "0")}${Math.max(0, c.b - 40).toString(16).padStart(2, "0")}`;
        defs.push(`<linearGradient id="${gidNow}" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"><stop offset="0%" stop-color="${light}"/><stop offset="100%" stop-color="${dark}"/></linearGradient>`);
        parts.push(`<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}" fill="url(#${gidNow})"/>`);
      } else {
        parts.push(`<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}" fill="${col}"/>`);
      }
    }
  }
  return parts.join("\n").replace('<svg ', `<svg ${SVG_NS} `) ? `<svg ${SVG_NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${defs.join("\n")}
${parts.slice(1).join("\n")}` : "";
}
