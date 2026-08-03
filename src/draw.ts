/**
 * mm-vision draw — 纯文字模型直接生成图片
 * ==========================================
 * 不依赖任何视觉模型：文字提示 → 纯文本 LLM → 输出可执行画图方案 → 渲染成图。
 *
 * 两种生成通道（LLM 自选，JSON 输出）：
 *   1. mode=pil   : LLM 写完整 Python PIL 脚本（零外部文件依赖）→ 子进程执行 → PNG
 *   2. mode=sync  : LLM 输出通感矢量描述（我们渲染器可解析）→ SVG/HTML → PNG
 *
 * 示例：
 *   mm-vision draw "画一张雪山湖景：金色雪山倒映在蓝色湖面，天空渐变"
 *   mm-vision draw "画一个 K 线图：上升趋势，标注支撑位压力位" -o chart.png
 */
import { loadConfig } from "./core.js";
import { renderSynesthesiaToSVG, parsePixelGrid, pixelGridToHTML, pixelGridToSVG } from "./render.js";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import * as zlib from "zlib";

// ==================== 类型 ====================

export interface DrawResult {
  ok: boolean;
  mode: string;
  imagePath: string;
  text?: string;
  error?: string;
}


// ==================== 零依赖 PNG 编码器（Node zlib） ====================

/** RGB 像素数组 → PNG Buffer（无任何第三方依赖） */
export function encodePNG(width: number, height: number, pixels: Uint8Array): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    const crcTable = (() => {
      const t: number[] = [];
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })();
    let c = 0xffffffff;
    for (const byte of Buffer.concat([typeBuf, data])) {
      c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width * 3; x++) raw[o++] = pixels[y * width * 3 + x];
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** RGB 网格（行数组，每行 "R,G,B R,G,B..."）→ PNG 文件 */
export function gridToPNG(rows: string[], outPath: string): { width: number; height: number } {
  const parsed: number[][] = rows.map((r) => {
    const tokens = r.trim().split(/\s+/).filter(Boolean);
    // 支持两种格式：
    //   A) "R,G,B R,G,B ..."（逗号分隔三元组）
    //   B) "R G B R G B ..."（空格分隔三元组）
    if (tokens.length > 0 && tokens[0].includes(",")) {
      return tokens.map((p) => {
        const m = p.match(/^(\d{1,3}),(\d{1,3}),(\d{1,3})$/);
        if (!m) return null;
        return [Math.min(255, parseInt(m[1])), Math.min(255, parseInt(m[2])), Math.min(255, parseInt(m[3]))];
      }).filter((v): v is number[] => !!v).flat();
    }
    // 空格分隔：按 3 个一组
    const nums = tokens.map((t) => parseInt(t)).filter((n) => !isNaN(n) && n >= 0 && n <= 255);
    const out: number[] = [];
    for (let i = 0; i + 2 < nums.length || i < nums.length; i += 3) {
      if (i + 2 < nums.length) out.push(nums[i], nums[i + 1], nums[i + 2]);
    }
    return out;
  }).filter((r) => r.length >= 3);
  if (parsed.length === 0) throw new Error("网格为空");
  // 宽度补齐：所有行统一到最长行（不足补 0,0,0 黑色，超宽截断）
  const maxCells = Math.max(...parsed.map((r) => r.length / 3));
  const width = Math.floor(maxCells);
  const height = parsed.length;
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = parsed[y];
    for (let x = 0; x < width; x++) {
      if (x * 3 + 2 < row.length) {
        pixels[(y * width + x) * 3] = row[x * 3];
        pixels[(y * width + x) * 3 + 1] = row[x * 3 + 1];
        pixels[(y * width + x) * 3 + 2] = row[x * 3 + 2];
      }
    }
  }
  const png = encodePNG(width, height, pixels);
  fs.writeFileSync(outPath, png);
  return { width, height };
}

// ==================== LLM 调用（OpenAI 兼容，纯文本） ====================

interface LLMConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTokens?: number;
}

async function llmText(prompt: string, cfg: LLMConfig, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000); // 300s 超时（思考模型大输出慢）
  const outer = signal;
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onAbort);
  }
  let lastError: string = "";
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const resp = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: cfg.maxTokens ?? 4096,
            temperature: 0.7,
          }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(`LLM 调用失败 (${resp.status}): ${err.slice(0, 300)}`);
        }
        const data: any = await resp.json();
        return data?.choices?.[0]?.message?.content || "";
      } catch (e: any) {
        lastError = String(e?.message || e);
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 2000)); // 重试前等待
          continue;
        }
      }
    }
    throw new Error(`LLM 调用失败（重试后仍失败）: ${lastError.slice(0, 300)}`);
  } finally {
    clearTimeout(timeout);
    if (outer) outer.removeEventListener("abort", onAbort);
  }
}

/** 容错 JSON 解析（剥离 markdown 围栏，截取 {} 区间，修复未转义引号） */
function parseJsonLoose(text: string): any {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fallthrough */ }

  // 修复 LLM 常见的未转义 ASCII 引号
  const repaired = t
    .replace(/([：:\s])\"([^\"]{1,30})\"(?=[,}])/g, '$1\\"$2\\"');
  try { return JSON.parse(repaired); } catch { /* fallthrough */ }

  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fallthrough */ }
  }
  // 截断恢复：JSON 尾部不完整（无右括号）时，提取完整行补全 ]}
  if (start >= 0) {
    try {
      const tailEnd = end > start ? end + 1 : t.length;
      const partial = t.slice(start, tailEnd);
      const rowStrs = partial.match(/"([\d,\s]{20,})"/g) || [];
      if (rowStrs.length > 0) {
        const validRows: string[] = [];
        for (const rs of rowStrs) {
          const inner = rs.slice(1, -1).trim();
          const points = inner.split(/\s+/).filter(Boolean);
          const ok = points.length >= 5 && points.every((p) => /^\d{1,3},\d{1,3},\d{1,3}$/.test(p));
          if (ok) validRows.push(inner);
        }
        if (validRows.length >= 5) {
          const rebuilt = `{"mode":"scan","rows":[${validRows.map((r) => `"${r}"`).join(",")}]}`;
          return JSON.parse(rebuilt);
        }
      }
    } catch { /* fallthrough */ }
  }
  return null;
}

// ==================== PIL 通道 ====================

/** 提取 LLM 输出的 Python 代码（```python 围栏或纯代码） */
function extractPython(text: string): string | null {
  const fence = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/);
  if (fence) return fence[1];
  // 无围栏：含 import PIL 的纯代码
  if (text.includes("from PIL import") || text.includes("import PIL")) return text;
  return null;
}

/** 执行 PIL 脚本 → PNG */
function runPILScript(code: string, outPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // 注入输出路径：脚本结尾追加 save
    const wrapped = `${code}\n\n# ==== mm-vision 自动注入 ====\nimport os\n_saved = False\nfor _o in dir():\n    _v = globals()[_o]\n    if isinstance(_v, type) and _v.__name__ == "Image" and not _saved:\n        pass\n`;
    // 更简单可靠：脚本必须自己调用 img.save()，我们在其后兜底
    const final = `${code}\n`;
    const py = execFile("python", ["-c", final + `\nimg.save(r"${outPath}")`], {
      windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024,
      cwd: path.dirname(outPath),
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`PIL 执行失败: ${String(err.message || err).slice(0, 300)}\n${stderr.slice(0, 500)}`));
      resolve(outPath);
    });
  });
}

// ==================== 生成 Prompt ====================

const DRAW_PROMPT = (userPrompt: string, referenceEncoding?: string) => `你是"点阵绘图引擎"。用户描述一张图片，你**逐行扫描输出每个像素的颜色**，由渲染器画出来。你不需要写代码、不需要画图——只需要用常识判断"图片的每个位置应该是什么颜色"。

用户需求：${userPrompt}
${referenceEncoding ? `\n【参考通感编码】（可选，提供空间布局锚点）：\n${referenceEncoding}` : ""}

输出严格 JSON（不要 markdown 围栏，不要多余文字），唯一格式：
{"mode": "scan", "rows": ["R,G,B R,G,B R,G,B ...", "R,G,B ...", "..."]}

扫描规则：
1. **分辨率 40x30**：rows 恰好 30 行，每行恰好 40 个 "R,G,B"（0-255），空格分隔。共 1200 个点。
2. **坐标映射**：行 0 是图片顶部，行 29 是底部；列 0 是左侧，列 39 是右侧。
3. **用常识上色**（关键）：
   - 天空在上部（行 0-10）：蓝色渐变，日出/日落时靠近太阳处暖黄/橙粉
   - 山在中间：山顶白/雪（带淡蓝阴影），山体灰褐/岩石色，受光面偏暖
   - 水面：蓝绿色，山峰倒影区域泛金/橙，波纹处明暗交替
   - 草地/树在下方：绿色系（深绿树、翠绿草）
   - 城市：灰色楼群+黄色窗光；夜晚深蓝背景+黄色亮点
   - 人物：肤色脸部、发色、衣服颜色
   - 抽象图形：按描述用对应颜色
4. **平滑过渡**：相邻点颜色要渐变（差不超过 40），只有物体边界才允许跳变。同一物体内部有明暗变化（光从一侧来）。
5. **全部 1200 点必须输出完整**，不要省略任何行或列。

只输出 JSON`;



// ==================== 布局先行模式 ====================

const LAYOUT_PROMPT = (userPrompt: string) => `你是"图像布局规划器"。用户描述一张图片，你规划它的空间布局——哪些物体在什么区域。

用户需求：${userPrompt}

输出严格 JSON（不要围栏不要多余文字）：
{"layout": [{"name": "物体名", "region": [x1,y1,x2,y2], "color": "颜色描述", "note": "细节提示"}, ...]}

规则：
1. region 用百分比坐标 [左上x, 左上y, 右下x, 右下y]（0-100），覆盖整张图
2. 分层：先天空/背景，再远景（山/建筑），再中景（云/水面），最后近景（草地/道路/人）
3. 物体区域可以有重叠（如云在天空内、倒影在湖内）
4. color 写清楚主色和渐变方向（如"淡蓝到暖黄渐变，日出方向右上"）
5. note 写该物体的细节特征（如"雪山山顶白带淡蓝阴影，山体灰褐岩石"）
6. 4-10 个物体，覆盖全图不留空洞

只输出 JSON`;

const LAYOUT_TILE_PROMPT = (userPrompt: string, layoutText: string, blockIndex: number, totalBlocks: number, blockX: number, blockY: number, gridCols: number, gridRows: number) =>
  `你是"点阵绘图引擎"。整图被分成 ${gridCols}x${gridRows} 网格，你现在绘制第 ${blockX + 1} 列第 ${blockY + 1} 行的一块（块 ${blockIndex + 1}/${totalBlocks}）。逐点输出颜色，不写代码。

整图需求：${userPrompt}

【全局布局】（百分比坐标，左上原点）：
${layoutText}

【本块位置】列 ${blockX + 1}/${gridCols}，行 ${blockY + 1}/${gridRows}（左上 1,1；右下 ${gridCols},${gridRows}）
【本块尺寸】24 列 x 16 行 = 384 点（行 0=块顶，行 19=块底；列 0=块左，列 29=块右）

输出严格 JSON（不要围栏）：
{"rows": ["R,G,B R,G,B ...", "..."]}

规则：
1. rows **必须恰好 16 行**，每行**恰好 24 个色点**，格式 "R,G,B" 逗号分隔、点间空格分隔；禁止 "R G B" 空格三元组；**20x30 一行不能少**
2. 把本块的全局位置换算到布局：本块左上角全局坐标 = (${blockX * 24 / gridCols / 2.4}%, ${blockY * 16 / gridRows / 1.6}%) 附近（块宽=${100 / gridCols}%，高=${100 / gridRows}%）
3. 判断本块覆盖了布局中的哪些物体，按物体颜色逐点着色；物体边界处颜色切换，物体内部渐变
4. 颜色要平滑渐变、有明暗层次（光照方向一致），不要平涂纯色
5. 全部 384 点完整输出

只输出 JSON`;

/** 布局先行分块生成 */
export async function drawImageLayoutFirst(
  userPrompt: string,
  opts: {
    outPath?: string;
    grid?: { cols: number; rows: number };
    llmConfig?: Partial<LLMConfig>;
    signal?: AbortSignal;
  } = {},
): Promise<DrawResult> {
  const outPath = opts.outPath || path.resolve("mm-draw-layout.png");
  const cols = opts.grid?.cols ?? 2;
  const rows = opts.grid?.rows ?? 2;
  const TILE_W = 24, TILE_H = 16;

  const vcfg = loadConfig();
  const llm: LLMConfig = {
    model: process.env.MM_DRAW_MODEL || vcfg.model,
    baseUrl: vcfg.baseUrl,
    apiKey: vcfg.apiKey,
    maxTokens: 8192,
    ...opts.llmConfig,
  };
  if (!llm.apiKey) {
    return { ok: false, mode: "layout-tiles", imagePath: outPath, error: "未找到 API key" };
  }

  // 第一步：布局
  console.log("  [布局] 规划全局布局...");
  const layoutRaw = await llmText(LAYOUT_PROMPT(userPrompt), llm, opts.signal);
  const layoutPlan = parseJsonLoose(layoutRaw);
  if (!layoutPlan || !Array.isArray(layoutPlan.layout)) {
    return { ok: false, mode: "layout-tiles", imagePath: outPath, error: `布局输出无法解析: ${layoutRaw.slice(0, 200)}` };
  }
  const layoutText = JSON.stringify(layoutPlan.layout, null, 1);
  console.log(`  [布局] ${layoutPlan.layout.length} 个物体: ${layoutPlan.layout.map((o: any) => o.name).join(", ")}`);

  // 第二步：逐块着色
  const total = cols * rows;
  const tileRowData: string[][][] = [];
  for (let by = 0; by < rows; by++) {
    const rowBlocks: string[][] = [];
    for (let bx = 0; bx < cols; bx++) {
      const idx = by * cols + bx;
      const prompt = LAYOUT_TILE_PROMPT(userPrompt, layoutText, idx, total, bx, by, cols, rows);
      const raw = await llmText(prompt, llm, opts.signal);
      const plan = parseJsonLoose(raw);
      if (!plan || !Array.isArray(plan.rows)) {
        return { ok: false, mode: "layout-tiles", imagePath: outPath, error: `块 ${idx} 输出无法解析: ${raw.slice(0, 150)}` };
      }
      const tileRows = plan.rows.filter((r: string) => typeof r === "string" && r.trim());
      console.log(`  [块 ${idx} ${bx + 1}x${by + 1}] 行数: ${tileRows.length}`);
      rowBlocks.push(tileRows);
    }
    tileRowData.push(rowBlocks);
  }

  // 拼装
  const fullRows: string[] = [];
  for (let by = 0; by < rows; by++) {
    for (let ly = 0; ly < TILE_H; ly++) {
      const lineParts: string[] = [];
      for (let bx = 0; bx < cols; bx++) {
        const tileRows = tileRowData[by][bx];
        if (ly < tileRows.length) lineParts.push(tileRows[ly].trim());
      }
      fullRows.push(lineParts.join(" "));
    }
  }

  try {
    const { width, height } = gridToPNG(fullRows, outPath);
    return { ok: true, mode: "layout-tiles", imagePath: outPath, text: `布局先行分块 → PNG (${width}x${height}, ${layoutPlan.layout.length} 物体, ${cols}x${rows} 块)` };
  } catch (e: any) {
    return { ok: false, mode: "layout-tiles", imagePath: outPath, error: String(e?.message || e) };
  }
}

// ==================== 分块矩阵生成 ====================

const TILE_PROMPT = (userPrompt: string, blockIndex: number, totalBlocks: number, blockX: number, blockY: number, gridCols: number, gridRows: number) =>
  `你是"点阵绘图引擎"。整张图片被分成 ${gridCols}x${gridRows} 的网格，你现在绘制第 ${blockX + 1} 列第 ${blockY + 1} 行的一块（块 ${blockIndex + 1}/${totalBlocks}）。你不需要写代码，只需要逐点输出颜色。

整图需求：${userPrompt}

【本块位置】列 ${blockX + 1}/${gridCols}，行 ${blockY + 1}/${gridRows}（左上为 1,1；右下为 ${gridCols},${gridRows}）
【本块尺寸】30 列 x 20 行 = 600 个点

输出严格 JSON（不要围栏不要多余文字）：
{"rows": ["R,G,B R,G,B ...", "..."]}

规则：
1. rows **必须恰好 16 行**，每行**恰好 24 个色点**；**每个色点必须写成 "R,G,B" 逗号分隔**（如 255,214,170），点与点之间用空格分隔；禁止写成 "255 214 170" 空格三元组形式。**30 行 40 列一行都不能少**，宁可重复上一行的颜色也不许省略。
2. 用常识判断本块属于整图的哪个区域并上色：
   - 行 0-7 通常是天空（蓝/渐变），除非本块行号靠下
   - 根据块位置与整图布局对应：例如 3x2 网格中，块(1,2)=左下角可能是草地/地面，块(3,1)=右上角是天空/远景
   - 主体物体（山/建筑/人物）横跨多块时，相邻块边缘颜色要衔接（同一物体在块边界两侧颜色相近）
3. 颜色要平滑渐变，有明暗层次（模拟光照），不要平涂纯色；**同一块内部不同区域（如天空到山）也要渐变过渡**
4. 全部 600 点完整输出

只输出 JSON`;

/** 分块生成：逐块请求 LLM，最后拼装成完整图片 */
export async function drawImageTiled(
  userPrompt: string,
  opts: {
    outPath?: string;
    grid?: { cols: number; rows: number };
    llmConfig?: Partial<LLMConfig>;
    signal?: AbortSignal;
  } = {},
): Promise<DrawResult> {
  const outPath = opts.outPath || path.resolve("mm-draw-tiled.png");
  const cols = opts.grid?.cols ?? 2;
  const rows = opts.grid?.rows ?? 2;
  const TILE_W = 24, TILE_H = 16;  // 24x16=384点，快且完整

  const vcfg = loadConfig();
  const llm: LLMConfig = {
    model: process.env.MM_DRAW_MODEL || vcfg.model,
    baseUrl: vcfg.baseUrl,
    apiKey: vcfg.apiKey,
    maxTokens: 8192,
    ...opts.llmConfig,
  };
  if (!llm.apiKey) {
    return { ok: false, mode: "tiles", imagePath: outPath, error: "未找到 API key" };
  }

  const total = cols * rows;
  const allRows: string[] = [];  // 每块 30 行，按块顺序收集
  const tileRowData: string[][][] = []; // [blockY][blockX] = rows[]

  for (let by = 0; by < rows; by++) {
    const rowBlocks: string[][] = [];
    for (let bx = 0; bx < cols; bx++) {
      const idx = by * cols + bx;
      const prompt = TILE_PROMPT(userPrompt, idx, total, bx, by, cols, rows);
      const raw = await llmText(prompt, llm, opts.signal);
      const plan = parseJsonLoose(raw);
      if (!plan || !Array.isArray(plan.rows)) {
        return { ok: false, mode: "tiles", imagePath: outPath, error: `块 ${idx} 输出无法解析: ${raw.slice(0, 150)}` };
      }
      const tileRows = plan.rows.filter((r: string) => typeof r === "string" && r.trim());
      console.log(`  [块 ${idx} ${bx + 1}x${by + 1}] 行数: ${tileRows.length}, 首行点数: ${(tileRows[0] || "").trim().split(/\s+/).filter(Boolean).length}`);
      rowBlocks.push(tileRows);
    }
    tileRowData.push(rowBlocks);
  }

  // 拼装：全图 = rows*30 行 × cols*40 列
  const fullRows: string[] = [];
  for (let by = 0; by < rows; by++) {
    for (let ly = 0; ly < TILE_H; ly++) {
      const lineParts: string[] = [];
      for (let bx = 0; bx < cols; bx++) {
        const tileRows = tileRowData[by][bx];
        if (ly < tileRows.length) lineParts.push(tileRows[ly].trim());
      }
      fullRows.push(lineParts.join(" "));
    }
  }

  try {
    const { width, height } = gridToPNG(fullRows, outPath);
    return { ok: true, mode: "tiles", imagePath: outPath, text: `分块矩阵 → PNG (${width}x${height}, ${cols}x${rows} 块)` };
  } catch (e: any) {
    return { ok: false, mode: "tiles", imagePath: outPath, error: String(e?.message || e) };
  }
}

// ==================== 主入口 ====================

export async function drawImage(
  userPrompt: string,
  opts: { outPath?: string; llmConfig?: Partial<LLMConfig>; width?: number; signal?: AbortSignal; referenceEncoding?: string; tiled?: boolean; layoutFirst?: boolean; grid?: { cols: number; rows: number } } = {},
): Promise<DrawResult> {
  // 分块高清模式：tiled=true 或 prompt 含"高清/分块/大图"关键词
  if (opts.layoutFirst || /布局先行|layout-first|layoutfirst/i.test(userPrompt)) {
    let grid: { cols: number; rows: number } | undefined = opts.grid;
    if (!grid) {
      const gridEnv = process.env.MM_DRAW_GRID;
      if (gridEnv && gridEnv.includes("x")) {
        const [gc, gr] = gridEnv.split("x").map((n) => parseInt(n.trim()));
        if (gc && gr) grid = { cols: gc, rows: gr };
      }
    }
    return drawImageLayoutFirst(userPrompt, { outPath: opts.outPath, llmConfig: opts.llmConfig, signal: opts.signal, grid });
  }
  if (opts.tiled || /高清|分块|大图|高分辨率|tiled|hi-res/i.test(userPrompt)) {
    return drawImageTiled(userPrompt, { outPath: opts.outPath, llmConfig: opts.llmConfig, signal: opts.signal, grid: opts.grid });
  }
  const outPath = opts.outPath || path.resolve("mm-draw.png");
  // LLM 配置：优先 draw 专用环境变量，否则复用 mm-vision 视觉配置（同 baseUrl/key，不同模型）
  const vcfg = loadConfig();
  const llm: LLMConfig = {
    model: process.env.MM_DRAW_MODEL || vcfg.model,
    baseUrl: vcfg.baseUrl,
    apiKey: vcfg.apiKey,
    maxTokens: 8192,
    ...opts.llmConfig,
  };
  if (!llm.apiKey) {
    return { ok: false, mode: "none", imagePath: outPath, error: "未找到 API key（MM_VISION_API_KEY / MM_DRAW_API_KEY）" };
  }

  // 1. LLM 生成方案
  const raw = await llmText(DRAW_PROMPT(userPrompt, opts.referenceEncoding), llm, opts.signal);
  const plan = parseJsonLoose(raw);
  if (!plan || !plan.mode) {
    // 尝试直接提取 PIL 代码
    const py = extractPython(raw);
    if (py) {
      try {
        await runPILScript(py, outPath);
        return { ok: true, mode: "pil", imagePath: outPath, text: "从自由文本提取 PIL 代码" };
      } catch (e: any) {
        return { ok: false, mode: "none", imagePath: outPath, error: String(e?.message || e) };
      }
    }
    return { ok: false, mode: "none", imagePath: outPath, error: `LLM 输出无法解析: ${raw.slice(0, 200)}` };
  }

  // 2. 按模式执行
  if (plan.mode === "pil" && typeof plan.code === "string") {
    try {
      await runPILScript(plan.code, outPath);
      return { ok: true, mode: "pil", imagePath: outPath };
    } catch (e: any) {
      return { ok: false, mode: "pil", imagePath: outPath, error: String(e?.message || e) };
    }
  }

  if (plan.mode === "scan" && Array.isArray(plan.rows)) {
    try {
      const { width, height } = gridToPNG(plan.rows, outPath);
      return { ok: true, mode: "scan", imagePath: outPath, text: `扫描点阵 → PNG (${width}x${height})` };
    } catch (e: any) {
      // 部分行损坏时：保留完整行（补齐宽度）
      try {
        const valid = plan.rows.filter((r: string) => typeof r === "string" && r.trim());
        const w = Math.max(...valid.map((r: string) => r.trim().split(/\s+/).filter(Boolean).length)) / 3;
        if (valid.length > 5 && w > 5) {
          const { width, height } = gridToPNG(valid, outPath);
          return { ok: true, mode: "scan", imagePath: outPath, text: `扫描点阵（部分行）→ PNG (${width}x${height})` };
        }
      } catch { /* fallthrough */ }
      return { ok: false, mode: "scan", imagePath: outPath, error: String(e?.message || e) };
    }
  }

  if (plan.mode === "sync" && typeof plan.description === "string") {
    try {
      const svg = renderSynesthesiaToSVG(plan.description, opts.width ?? 960);
      const svgPath = outPath.replace(/\.png$/, ".svg");
      fs.writeFileSync(svgPath, svg, "utf-8");
      // 尝试转 PNG（svg2png.py 随包分发）
      const script = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts", "svg2png.py");
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("python", [script, svgPath, outPath, String(opts.width ?? 960)], {
            windowsHide: true, timeout: 30000,
          }, (err) => err ? reject(err) : resolve());
        });
        return { ok: true, mode: "sync", imagePath: outPath, text: `通感描述 → SVG → PNG（${svg.length} bytes SVG）` };
      } catch {
        return { ok: true, mode: "sync", imagePath: svgPath, text: "通感描述已渲染为 SVG（svg2png.py 未找到，可用浏览器打开 SVG）" };
      }
    } catch (e: any) {
      return { ok: false, mode: "sync", imagePath: outPath, error: String(e?.message || e) };
    }
  }

  return { ok: false, mode: "none", imagePath: outPath, error: `未知模式: ${plan.mode}` };
}
