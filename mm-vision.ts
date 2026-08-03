/**
 * mm-vision.ts — 通用多模态"通感编码器"扩展
 * ==========================================
 * DeepSeek 等文本模型无视觉能力，本扩展通过"通感编码"补足：
 *   视觉模型看原图 → 输出结构化空间文字（画布/元素/坐标/形状/数值/关系）
 *   → 注入给文本模型 → 文本模型凭文字重建画面，获得像素级空间认知
 *
 * 特性：
 *  - 通感编码（synesthesia）：坐标化描述，一次 API 调用，无外部进程
 *  - 三种模式：brief(快/省) / full(标准) / coords(坐标优先，适合图表盘面)
 *  - 结果缓存（默认 10 分钟），重复贴图零开销
 *  - 零硬编码：模型 / baseUrl / API key / 配置文件全部可配置
 *  - 兼容任意 OpenAI 兼容视觉模型（qwen-vl / gpt-4o / glm-4v / kimi-vl...）
 *
 * 入口：
 *  1. mm_vision 工具（文本模型主动调用，支持本地路径/URL/图片数据）
 *  2. input 事件（用户粘贴图片自动分析并注入）
 *  3. /vision 命令（交互式分析）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const DOT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ascii_dot.py");

/** 扩展文件所在目录（配置/密钥随扩展走，便于分发） */
function extDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

// ==================== 配置解析（无硬编码路径） ====================

interface VisionConfig {
  model: string;
  baseUrl: string;
  maxTokens: number;
  autoDetect: boolean;
  mode: "brief" | "full" | "coords" | "auto";
  cacheTTL: number; // 秒
  cacheMax: number; // 条
  apiKey: string;
  dotMatrix: boolean; // 可选：追加像素点阵
  dotWidth: number;
  dotHeight: number;
  dotInvert: boolean;
}

const DEFAULTS: VisionConfig = {
  model: "qwen-vl-max",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  maxTokens: 2048,
  autoDetect: true,
  mode: "auto",
  cacheTTL: 600,
  cacheMax: 100,
  apiKey: "",
  dotMatrix: false,
  dotWidth: 80,
  dotHeight: 24,
  dotInvert: true,
};

function configCandidates(): string[] {
  const cwd = process.cwd();
  const home = os.homedir();
  const ed = extDir();
  const edParent = path.dirname(ed);
  return [
    process.env.MM_VISION_CONFIG || "",
    path.join(ed, "vision-config.json"),
    path.join(edParent, "vision-config.json"), // 扩展在子目录、配置在根目录的布局
    path.join(home, ".pi", "vision-config.json"),
    path.join(home, ".config", "mm-vision", "config.json"),
    path.join(cwd, "vision-config.json"),
    path.join(cwd, ".vision-config.json"),
  ].filter(Boolean);
}

function loadConfig(): VisionConfig {
  const cfg: VisionConfig = { ...DEFAULTS };
  for (const p of configCandidates()) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
        Object.assign(cfg, parsed);
        break;
      }
    } catch { /* 忽略损坏配置 */ }
  }
  cfg.apiKey = resolveApiKey(cfg);
  return cfg;
}

function resolveApiKey(cfg: VisionConfig): string {
  if (cfg.apiKey) return cfg.apiKey;
  const envKeys = ["MM_VISION_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "OPENAI_API_KEY"];
  for (const k of envKeys) {
    if (process.env[k]) return process.env[k];
  }
  // auth.json 常见位置：{provider: {type, key}} / {provider: {apiKey}} / {apiKey}
  const cwd = process.cwd();
  const home = os.homedir();
  const ed = extDir();
  const edParent = path.dirname(ed);
  const authPaths = [
    path.join(ed, "auth.json"),
    path.join(edParent, "auth.json"), // 扩展在子目录、auth 在根目录的布局
    path.join(home, ".pi", "auth.json"),
    path.join(cwd, "auth.json"),
    path.join(home, ".config", "mm-vision", "auth.json"),
  ];
  for (const p of authPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const auth = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (typeof auth.apiKey === "string" && auth.apiKey) return auth.apiKey;
      for (const [name, v] of Object.entries<any>(auth)) {
        if (typeof v === "object" && v && typeof v.key === "string" && v.key) {
          // 优先视觉/通义相关条目
          if (/vision|qwen|ali|dash|vl|token/i.test(name)) return v.key;
        }
      }
      for (const v of Object.values<any>(auth)) {
        if (typeof v === "object" && v && typeof v.key === "string" && v.key) return v.key;
      }
    } catch { /* 忽略 */ }
  }
  return "";
}

// ==================== 图片解析 ====================

/** 把任意图片输入转成 OpenAI 兼容 image_url content */
function toImageContent(img: any): any {
  if (typeof img === "string") {
    if (img.startsWith("data:") || img.startsWith("http")) {
      return { type: "image_url", image_url: { url: img } };
    }
    const resolved = path.resolve(img);
    if (fs.existsSync(resolved)) {
      const buf = fs.readFileSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mime = ext === ".png" ? "image/png"
        : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
        : ext === ".gif" ? "image/gif"
        : ext === ".webp" ? "image/webp" : "image/png";
      return { type: "image_url", image_url: { url: `data:${mime};base64,${buf.toString("base64")}` } };
    }
    return null;
  }
  if (typeof img === "object" && img !== null) {
    const anyImg = img as any;
    if (anyImg.source?.type === "base64" && anyImg.source?.data) {
      const mt = anyImg.source.mediaType || "image/png";
      return { type: "image_url", image_url: { url: `data:${mt};base64,${anyImg.source.data}` } };
    }
    if (anyImg.data && typeof anyImg.data === "string") {
      const mt = anyImg.mediaType || anyImg.mime || "image/png";
      const d = anyImg.data.startsWith("data:") ? anyImg.data : `data:${mt};base64,${anyImg.data}`;
      return { type: "image_url", image_url: { url: d } };
    }
  }
  return null;
}

// ==================== 通感编码 Prompt ====================

const SYNESTHESIA_PROMPT = `你是"图像通感编码器"：把图片翻译成紧凑的结构化文字，让一个看不见图片的文本模型能据此重建空间认知。

输出要求（用列表/结构化格式，避免散文）：
1. 【画布】宽高比(如 16:9)、主背景色/整体色调
2. 【元素】每个视觉元素一行：[类型 | 位置(百分比 x%,y% 原点左上) | 尺寸(宽x高%) | 颜色 | 关键文本/数值]
3. 【关系】元素间空间关系：上下/左右/重叠/交叉/包含，只说有信息量的
4. 【图表专用】坐标轴范围、每个关键转折点(峰/谷/交叉)的 (x%,y%) 和数值、曲线形状(上升/下降/平台)、标注位置
5. 【自然图专用】主体(位置+特征)、前景/背景、光线方向、构图
6. 不确定的标注 [不确定]，不要编造。

坐标精确到 1%，数值精确到图片可见的最小单位。输出控制在 800 字内。`;

const MODE_TAIL: Record<string, string> = {
  brief: "本次为快速模式：只需输出画布、最核心的 3-5 个元素及坐标、一句话结论。",
  full: "本次为完整模式：输出全部可识别元素。",
  coords: "本次为坐标优先模式：所有关键元素(曲线转折/标注/按钮/文字块)必须给出精确 (x%,y%) 坐标，这是最重要要求。",
  auto: "根据图片类型自适应：图表类侧重坐标与数值，自然图侧重构图与主体。",
};

function buildPrompt(userText: string, mode: string): string {
  const tail = MODE_TAIL[mode] || MODE_TAIL.auto;
  const user = userText.trim() ? `\n用户附加要求：${userText.trim()}` : "";
  return `${SYNESTHESIA_PROMPT}\n\n${tail}${user}`;
}

// ==================== 缓存 ====================

const cache = new Map<string, { ts: number; text: string }>();

function cacheKey(images: any[]): string {
  const parts = images.map((img) => {
    const s = typeof img === "string" ? img : JSON.stringify(img).slice(0, 4000);
    return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
  });
  return parts.join("+");
}

function cacheGet(key: string, ttl: number): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttl * 1000) {
    cache.delete(key);
    return null;
  }
  return hit.text;
}

function cacheSet(key: string, text: string, max: number) {
  cache.set(key, { ts: Date.now(), text });
  if (cache.size > max) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

// ==================== 点阵（可选模式） ====================

/** 从图片提取 base64（路径/URL/pi 图片对象） */
function extractBase64(img: any): string | null {
  if (typeof img === "string") {
    if (img.startsWith("data:")) {
      const m = img.match(/^data:[^;]+;base64,(.+)$/s);
      return m ? m[1] : null;
    }
    if (img.startsWith("http")) return null; // URL 无法本地点阵化
    const resolved = path.resolve(img);
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved).toString("base64");
    return null;
  }
  if (typeof img === "object" && img !== null) {
    const anyImg = img as any;
    if (anyImg.source?.type === "base64" && anyImg.source?.data) return anyImg.source.data;
    if (typeof anyImg.data === "string") {
      if (anyImg.data.startsWith("data:")) {
        const m = anyImg.data.match(/^data:[^;]+;base64,(.+)$/s);
        return m ? m[1] : null;
      }
      return anyImg.data;
    }
  }
  return null;
}

/** 调 Python 生成 ASCII 点阵（stdin 传 base64，避免命令行长度限制） */
function dotMatrixFromBase64(b64: string, cfg: VisionConfig): Promise<string> {
  return new Promise((resolve) => {
    const py = execFile("python", [DOT_SCRIPT, "stdin", String(cfg.dotWidth), String(cfg.dotHeight), cfg.dotInvert ? "1" : "0"],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(`# dot-matrix failed: ${String(err.message || err).slice(0, 200)}`);
        resolve(stdout);
      });
    py.stdin?.write(b64);
    py.stdin?.end();
  });
}

/** 生成点阵块（失败不中断主流程） */
async function dotMatrixBlock(img: any, cfg: VisionConfig): Promise<string> {
  try {
    const b64 = extractBase64(img);
    if (!b64) return "# dot-matrix skipped: unsupported image source";
    const out = (await dotMatrixFromBase64(b64, cfg)).trim();
    return [
      "",
      "【图片点阵（像素级形状）】",
      `说明：每字符≈1列；顶部数字为列标尺(每10格)，左侧数字为行标尺(每5行)。坐标格式 (列,行)，原点左上。点阵 ${cfg.dotWidth}x${cfg.dotHeight}：`,
      "```",
      out,
      "```",
      "点阵反映像素级形状走向；与上方通感编码的百分比坐标对应（列=×width/100，行=×height/100）。",
    ].join("\n");
  } catch (e: any) {
    return `# dot-matrix error: ${String(e?.message || e).slice(0, 200)}`;
  }
}

// ==================== 核心：通感编码 ====================

async function visionEncode(images: any[], prompt: string, cfg: VisionConfig): Promise<string> {
  const key = cacheKey(images);
  if (cfg.cacheTTL > 0) {
    const hit = cacheGet(key, cfg.cacheTTL);
    if (hit) return `[缓存命中] ${hit}`;
  }

  const contents: any[] = [{ type: "text", text: prompt }];
  let okCount = 0;
  for (const img of images) {
    const c = toImageContent(img);
    if (c) { contents.push(c); okCount++; }
  }
  if (okCount === 0) return "❌ 无法解析图片数据（images 结构不识别）";

  const body = JSON.stringify({
    model: cfg.model,
    messages: [{ role: "user", content: contents }],
    max_tokens: cfg.maxTokens,
  });
  const resp = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body,
  });
  if (!resp.ok) {
    const err = await resp.text();
    return `❌ 视觉模型调用失败 (${resp.status}): ${err.slice(0, 300)}`;
  }
  const data: any = await resp.json();
  const text = data?.choices?.[0]?.message?.content || "（无输出）";
  if (cfg.cacheTTL > 0) cacheSet(key, text, cfg.cacheMax);
  return text;
}

function resolveMode(cfg: VisionConfig, userText: string): string {
  if (cfg.mode !== "auto") return cfg.mode;
  // auto：图表/坐标类关键词 → coords
  return /k线|K线|走势|图表|盘面|坐标|点位|曲线|分时|蜡烛|指标|截图/i.test(userText) ? "coords" : "full";
}

function maxTokensFor(mode: string, cfg: VisionConfig): number {
  if (cfg.maxTokens) return cfg.maxTokens;
  return mode === "brief" ? 512 : 2048;
}

/** 统一入口：返回注入文本（含通感编码说明） */
async function analyzeImages(images: any[], userText: string, cfg: VisionConfig): Promise<string> {
  const mode = resolveMode(cfg, userText);
  const prompt = buildPrompt(userText, mode);
  const maxTokens = maxTokensFor(mode, cfg);
  const cfg2 = { ...cfg, maxTokens };
  const encoded = await visionEncode(images, prompt, cfg2);
  if (encoded.startsWith("❌")) return encoded;

  let out = [
    `【图片通感编码（mm-vision）】模式:${mode} · 模型:${cfg.model}`,
    encoded,
    "（以上是图片的结构化空间描述，坐标均为百分比 (x%,y%) 原点左上，可直接引用）",
  ].join("\n");

  // 可选：追加像素点阵（dotMatrix: true 时）
  if (cfg.dotMatrix && images.length > 0) {
    const dot = await dotMatrixBlock(images[0], cfg);
    out += `\n${dot}`;
  }
  return out;
}

// ==================== 扩展 ====================

export default function (pi: ExtensionAPI) {
  // 1. mm_vision 工具
  pi.registerTool({
    name: "mm_vision",
    label: "多模态通感分析",
    description:
      "视觉代理：分析图片（K线图/盘面截图/报告图表/任何图片），返回结构化通感编码（坐标化文字描述）。DeepSeek 无视觉能力，需要看图时调用。支持本地路径、URL 或图片数据。",
    parameters: Type.Object({
      image: Type.String({ description: "图片路径（如 F:/xxx/kline.png）或 URL" }),
      prompt: Type.Optional(Type.String({ description: "分析要求（可选，auto 模式自动识别图表/自然图）" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cfg = loadConfig();
      if (!cfg.apiKey) {
        return { content: [{ type: "text", text: "❌ 未找到 API key（检查 MM_VISION_API_KEY / auth.json / 配置 apiKey）" }] };
      }
      const text = await analyzeImages([params.image], params.prompt || "", cfg);
      return {
        content: [{ type: "text", text }],
        details: { image: params.image, model: cfg.model, mode: cfg.mode },
      };
    },
  });

  // 2. input 事件：用户粘贴图片 → 自动通感编码 → transform 注入
  pi.on("input", async (event: any, ctx: any) => {
    const cfg = loadConfig();
    if (!cfg.autoDetect) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    const images = event.images;
    if (!images || images.length === 0) return { action: "continue" };
    if (!cfg.apiKey) {
      ctx.ui.notify("❌ mm-vision: 未找到 API key", "error");
      return { action: "continue" };
    }

    const text = typeof event.text === "string" ? event.text : "";
    const mode = resolveMode(cfg, text);
    ctx.ui.notify(`📷 通感编码 ${images.length} 张图片 (${cfg.model}/${mode})...`, "info");
    try {
      const result = await analyzeImages(images, text, cfg);
      return {
        action: "transform",
        text: `${text}\n\n${result}`,
      };
    } catch (e: any) {
      ctx.ui.notify(`❌ 视觉分析失败: ${String(e?.message || e)}`, "error");
      return { action: "continue" };
    }
  });

  // 3. /vision 命令
  pi.registerCommand("vision", {
    description: "通感分析图片：/vision <图片路径或URL> [分析要求]",
    handler: async (args: string, ctx: any) => {
      const parts = (args || "").split(/\s+/);
      const img = parts[0];
      if (!img) {
        ctx.ui.notify("用法: /vision <图片路径或URL> [分析要求]", "info");
        return;
      }
      const prompt = parts.slice(1).join(" ");
      const cfg = loadConfig();
      if (!cfg.apiKey) {
        ctx.ui.notify("❌ 未找到 API key", "error");
        return;
      }
      ctx.ui.notify(`📷 通感编码中: ${img}`, "info");
      const result = await analyzeImages([img], prompt, cfg);
      ctx.ui.notify(result.slice(0, 150), "info");
      return result;
    },
  });
}
