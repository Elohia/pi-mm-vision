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
    return r.split(/\s+/).filter(Boolean).map((p) => {
      const m = p.match(/^(\d{1,3}),(\d{1,3}),(\d{1,3})$/);
      if (!m) return null;
      return [Math.min(255, parseInt(m[1])), Math.min(255, parseInt(m[2])), Math.min(255, parseInt(m[3]))];
    }).filter((v): v is number[] => !!v).flat();
  }).filter((r) => r.length > 0);
  const height = parsed.length;
  const width = parsed[0]?.length ? parsed[0].length / 3 : 0;
  if (width === 0 || height === 0) throw new Error("网格为空");
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = parsed[y];
    for (let x = 0; x < width; x++) {
      pixels[(y * width + x) * 3] = row[x * 3];
      pixels[(y * width + x) * 3 + 1] = row[x * 3 + 1];
      pixels[(y * width + x) * 3 + 2] = row[x * 3 + 2];
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
  const resp = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: cfg.maxTokens ?? 4096,
      temperature: 0.7,
    }),
    signal,
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`LLM 调用失败 (${resp.status}): ${err.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

/** 容错 JSON 解析（剥离 markdown 围栏，截取 {} 区间，修复未转义引号） */
function parseJsonLoose(text: string): any {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fallthrough */ }

  // 修复 LLM 常见的未转义 ASCII 引号：将值内 "中文" 替换为 "中文"
  const repaired = t
    // 只修 description/code 字段值中的裸引号（内容里的 "xxx" 模式）
    .replace(/([：:\s])\"([^\"]{1,30})\"(?=[,}])/g, '$1\\"$2\\"');
  try { return JSON.parse(repaired); } catch { /* fallthrough */ }

  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fallthrough */ }
    // 截断恢复：JSON 尾部不完整时，尝试补全 ]}" 
    try {
      const partial = t.slice(start, end + 1);
      const repaired = partial.replace(/\[\s*$/, '[]').replace(/([^\[\]\{\},:])\s*$/, '$1]}');
      // 简单策略：找到最后一个完整行后补 ]
      const m = partial.match(/^(.*"rows":\s*\[.*?)(?:\n|$)/s);
      if (m) {
        const rowsPart = m[1];
        // 数完整行：每行以 "R,G,B...", 结尾
        const rows = rowsPart.match(/"([\d,\s]+)"/g) || [];
        if (rows.length > 0) {
          const rebuilt = `{"mode":"scan","rows":[${rows.join(",")}]}`;
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

const DRAW_PROMPT = (userPrompt: string, referenceEncoding?: string) => `你是"文字绘图引擎"。根据用户描述，生成一张图片的实现方案。

用户需求：${userPrompt}
${referenceEncoding ? `\n【参考通感编码】（可选，提供空间结构锚点）：\n${referenceEncoding}` : ""}

输出严格 JSON（不要 markdown 围栏，不要多余文字）。三种通道任选其一，**通用优先 pil**：
1. {"mode": "pil", "code": "完整 Python PIL 脚本"}
2. {"mode": "scan", "rows": ["R,G,B R,G,B ...", "..."]}
3. {"mode": "sync", "description": "通感描述"}

通道选择规则：
- **默认选 pil**：PIL 代码是最通用的——任何场景（城市街景、电路图、抽象图案、人物、动物、图表）都能用代码画出来，token 效率最高，不会截断。写完整自包含脚本：from PIL import Image, ImageDraw, ImageFont；用 img = Image.new() 创建；渐变用逐像素或 ImageDraw；脚本末尾 img.save("out.png")。
- 只有当你觉得代码写不出来（需要照片级真实感、大量随机纹理）时才选 scan。
- sync 用于界面/图表/几何示意图。

mode=scan 规则（点阵扫描）：
- 分辨率自适应：复杂场景 40x30（1200点），简单场景 32x24
- rows 每行 "R,G,B" 空格分隔，共 height 行
- 用常识上色：天空蓝渐变在上、山体灰褐带雪白顶、湖水青蓝有倒影、草地绿、城市楼宇灰蓝带窗光
- 相邻点平滑过渡；有参考编码时严格按编码空间布局

只输出 JSON`;

// ==================== 主入口 ====================

export async function drawImage(
  userPrompt: string,
  opts: { outPath?: string; llmConfig?: Partial<LLMConfig>; width?: number; signal?: AbortSignal; referenceEncoding?: string } = {},
): Promise<DrawResult> {
  const outPath = opts.outPath || path.resolve("mm-draw.png");
  // LLM 配置：优先 draw 专用环境变量，否则复用 mm-vision 视觉配置（同 baseUrl/key，不同模型）
  const vcfg = loadConfig();
  const llm: LLMConfig = {
    model: process.env.MM_DRAW_MODEL || vcfg.model,
    baseUrl: vcfg.baseUrl,
    apiKey: vcfg.apiKey,
    maxTokens: 12000,
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
