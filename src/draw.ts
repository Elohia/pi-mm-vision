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

// ==================== 类型 ====================

export interface DrawResult {
  ok: boolean;
  mode: string;
  imagePath: string;
  text?: string;
  error?: string;
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

/** 容错 JSON 解析（剥离 markdown 围栏，截取 {} 区间） */
function parseJsonLoose(text: string): any {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fallthrough */ }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fallthrough */ }
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

const DRAW_PROMPT = (userPrompt: string) => `你是"文字绘图引擎"。根据用户描述，生成一张图片的实现方案。

用户需求：${userPrompt}

输出严格 JSON（不要 markdown 围栏，不要多余文字），格式：
{"mode": "pil", "code": "完整 Python 脚本"} 
或
{"mode": "sync", "description": "通感描述"}

通道说明：
1. mode=pil：写完整、自包含的 Python PIL 脚本。规则：
   - 第一行必须 import（from PIL import Image, ImageDraw, ImageFont 等）
   - 用变量 img = Image.new(...) 创建画布
   - 全部使用纯色/渐变/几何/文字绘制，不要加载外部文件
   - 渐变用逐像素或 ImageDraw 方式实现
   - 脚本末尾必须用 img.save("out.png") 保存（路径变量由系统注入）
   - 代码要能直接运行，不要注释废话
2. mode=sync：输出通感编码描述（我们渲染器解析）：
   【画布】宽高比 + 背景色
   【元素】[矩形 | 位置(10%,10%) | 尺寸(30%x20%) | 颜色#4a90d9 | 圆角 | "文字"]
   【元素】[圆形 | 中心(50%,50%) | 半径10% | 颜色#ff4d4f | 实心]
   【元素】[折线(点(10%,80%)(30%,60%)(50%,70%)(70%,40%)(90%,30%)) | 颜色#f5c542 | 粗]
   【元素】[文本 | 位置(50%,20%) | 内容"标题" | 字号24 | 颜色#ffffff | 粗体]
   【元素】[箭头 | 从(20%,60%)到(80%,40%) | 颜色#ffffff]
   【元素】[多边形 | 点(10%,90%)(25%,95%)(25%,85%) | 颜色#faad14 | 实心]

要求：
- 优先选 pil（代码通道）实现复杂/渐变/自然场景
- 选 sync（通感通道）实现界面/图表/几何示意图
- 只输出 JSON`;

// ==================== 主入口 ====================

export async function drawImage(
  userPrompt: string,
  opts: { outPath?: string; llmConfig?: Partial<LLMConfig>; width?: number; signal?: AbortSignal } = {},
): Promise<DrawResult> {
  const outPath = opts.outPath || path.resolve("mm-draw.png");
  // LLM 配置：优先 draw 专用环境变量，否则复用 mm-vision 视觉配置（同 baseUrl/key，不同模型）
  const vcfg = loadConfig();
  const llm: LLMConfig = {
    model: process.env.MM_DRAW_MODEL || vcfg.model,
    baseUrl: vcfg.baseUrl,
    apiKey: vcfg.apiKey,
    maxTokens: 4096,
    ...opts.llmConfig,
  };
  if (!llm.apiKey) {
    return { ok: false, mode: "none", imagePath: outPath, error: "未找到 API key（MM_VISION_API_KEY / MM_DRAW_API_KEY）" };
  }

  // 1. LLM 生成方案
  const raw = await llmText(DRAW_PROMPT(userPrompt), llm, opts.signal);
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

  if (plan.mode === "sync" && typeof plan.description === "string") {
    try {
      const svg = renderSynesthesiaToSVG(plan.description, opts.width ?? 960);
      // 保存 SVG 并尝试转 PNG（用 svg2png.py）
      const svgPath = outPath.replace(/\.png$/, ".svg");
      fs.writeFileSync(svgPath, svg, "utf-8");
      return { ok: true, mode: "sync", imagePath: svgPath, text: "通感描述已渲染为 SVG（用 scripts/svg2png.py 转 PNG）" };
    } catch (e: any) {
      return { ok: false, mode: "sync", imagePath: outPath, error: String(e?.message || e) };
    }
  }

  return { ok: false, mode: "none", imagePath: outPath, error: `未知模式: ${plan.mode}` };
}
