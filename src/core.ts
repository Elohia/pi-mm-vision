/**
 * mm-vision core — Synesthesia Encoder (通感编码器)
 * ====================================================
 * 纯函数核心：把图片翻译成紧凑的结构化空间文字（画布/元素/坐标/形状/数值/关系），
 * 让任何纯文本 LLM（DeepSeek、GPT-4 base、Claude 等）获得像素级空间认知。
 *
 * 本文件零框架依赖（只用 Node 内置模块 + fetch），可被任意宿主集成：
 *   - MCP server（接入 Pi / Codex / Claude Code / Cursor…）
 *   - CLI（独立命令行）
 *   - Agent 扩展（直接 import）
 *
 * 设计原则：
 *   - 无硬编码：模型 / baseUrl / API key / 配置路径全部可配置
 *   - 失败不崩：任何错误都返回可读文本而非抛异常
 *   - 兼容任意 OpenAI 兼容视觉模型（qwen-vl / gpt-4o / glm-4v / kimi-vl / MiniMax-VL…）
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execFile } from "child_process";

// ==================== 类型 ====================

export interface VisionConfig {
  model: string;
  baseUrl: string;
  maxTokens: number;
  autoDetect: boolean;
  mode: "brief" | "full" | "coords" | "auto";
  cacheTTL: number;   // 秒
  cacheMax: number;   // 条
  apiKey: string;
  dotMatrix: boolean; // 可选：追加像素点阵
  dotWidth: number;
  dotHeight: number;
  dotInvert: boolean;
  /** 自定义配置路径（可选，覆盖默认查找） */
  configPath?: string;
}

export interface AnalyzeOptions {
  prompt?: string;
  mode?: VisionConfig["mode"];
}

export interface AnalyzeResult {
  ok: boolean;
  text: string;
  mode: string;
  model: string;
  cached: boolean;
  error?: string;
}

// ==================== 默认配置 ====================

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

export { DEFAULTS };

/** 扩展所在目录（用于查找随包分发文件） */
export function packageRoot(): string {
  try {
    // 兼容 src/core.ts 与 dist/core.js 两种布局
    return path.dirname(__dirname);
  } catch {
    return process.cwd();
  }
}

// ==================== 配置加载 ====================

export function configCandidates(): string[] {
  const cwd = process.cwd();
  const home = os.homedir();
  const root = packageRoot();
  return [
    process.env.MM_VISION_CONFIG || "",
    path.join(home, ".config", "mm-vision", "config.json"),
    path.join(home, ".mm-vision.json"),
    path.join(root, "vision-config.json"),
    path.join(cwd, "vision-config.json"),
    path.join(cwd, ".vision-config.json"),
  ].filter(Boolean);
}

export function loadConfig(overrides?: Partial<VisionConfig>): VisionConfig {
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
  if (overrides) Object.assign(cfg, overrides);
  cfg.apiKey = resolveApiKey(cfg);
  return cfg;
}

export function resolveApiKey(cfg: VisionConfig): string {
  if (cfg.apiKey) return cfg.apiKey;
  const envKeys = ["MM_VISION_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];
  for (const k of envKeys) {
    if (process.env[k]) return process.env[k];
  }
  // auth.json 常见位置
  const home = os.homedir();
  const root = packageRoot();
  const authPaths = [
    path.join(home, ".config", "mm-vision", "auth.json"),
    path.join(home, ".pi", "auth.json"),
    path.join(root, "auth.json"),
    path.join(process.cwd(), "auth.json"),
  ];
  for (const p of authPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const auth = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (typeof auth.apiKey === "string" && auth.apiKey) return auth.apiKey;
      if (auth.provider && typeof auth.provider.key === "string") return auth.provider.key;
      for (const [name, v] of Object.entries<any>(auth)) {
        if (typeof v === "object" && v && typeof v.key === "string" && v.key) {
          if (/vision|qwen|ali|dash|vl|token|gemini/i.test(name)) return v.key;
        }
      }
      for (const v of Object.values<any>(auth)) {
        if (typeof v === "object" && v && typeof v.key === "string" && v.key) return v.key;
      }
    } catch { /* 忽略 */ }
  }
  return "";
}

// ==================== 图片输入解析 ====================

export interface ImageInput {
  /** 最终传给视觉模型的 OpenAI 兼容 content */
  content: any;
  /** 用于缓存的原始描述 */
  cacheKey: string;
  /** 可本地读取的 base64（供点阵等本地处理用），无法本地读取时为 null */
  base64: string | null;
}

/** 把任意图片输入规范化为 ImageInput */
export function normalizeImage(img: any): ImageInput | null {
  if (typeof img === "string") {
    if (img.startsWith("data:")) {
      const m = img.match(/^data:([^;]+);base64,(.+)$/s);
      return m
        ? { content: { type: "image_url", image_url: { url: img } }, cacheKey: img.slice(0, 4000), base64: m[2] }
        : null;
    }
    if (img.startsWith("http")) {
      return { content: { type: "image_url", image_url: { url: img } }, cacheKey: img, base64: null };
    }
    const resolved = path.resolve(img);
    if (fs.existsSync(resolved)) {
      const buf = fs.readFileSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mime = ext === ".png" ? "image/png"
        : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
        : ext === ".gif" ? "image/gif"
        : ext === ".webp" ? "image/webp" : "image/png";
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      return { content: { type: "image_url", image_url: { url: dataUrl } }, cacheKey: dataUrl.slice(0, 4000), base64: buf.toString("base64") };
    }
    return null;
  }
  if (typeof img === "object" && img !== null) {
    const anyImg = img as any;
    // MCP / pi 常见形态: { source: { type: "base64", data, mediaType } }
    if (anyImg.source?.type === "base64" && anyImg.source?.data) {
      const mt = anyImg.source.mediaType || "image/png";
      const dataUrl = `data:${mt};base64,${anyImg.source.data}`;
      return { content: { type: "image_url", image_url: { url: dataUrl } }, cacheKey: dataUrl.slice(0, 4000), base64: anyImg.source.data };
    }
    if (typeof anyImg.data === "string") {
      const mt = anyImg.mediaType || anyImg.mime || "image/png";
      const d = anyImg.data.startsWith("data:") ? anyImg.data : `data:${mt};base64,${anyImg.data}`;
      const b64 = d.startsWith("data:") ? (d.match(/^data:[^;]+;base64,(.+)$/s)?.[1] ?? null) : anyImg.data;
      return { content: { type: "image_url", image_url: { url: d } }, cacheKey: d.slice(0, 4000), base64: b64 };
    }
    if (anyImg.url || anyImg.path || anyImg.file) {
      return normalizeImage(anyImg.url || anyImg.path || anyImg.file);
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

export function buildPrompt(userText: string, mode: string): string {
  const tail = MODE_TAIL[mode] || MODE_TAIL.auto;
  const user = userText.trim() ? `\n用户附加要求：${userText.trim()}` : "";
  return `${SYNESTHESIA_PROMPT}\n\n${tail}${user}`;
}

export function resolveMode(cfg: VisionConfig, userText: string): string {
  if (cfg.mode !== "auto") return cfg.mode;
  // auto：图表/坐标类关键词 → coords
  return /k线|K线|走势|图表|盘面|坐标|点位|曲线|分时|蜡烛|指标|截图|chart|kline|graph|plot/i.test(userText) ? "coords" : "full";
}

// ==================== 缓存 ====================

const cache = new Map<string, { ts: number; text: string }>();

export function cacheKey(images: ImageInput[]): string {
  const parts = images.map((i) => crypto.createHash("sha256").update(i.cacheKey).digest("hex").slice(0, 16));
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

/** 供宿主导出缓存统计（可选） */
export function cacheStats(): { size: number } {
  return { size: cache.size };
}

// ==================== 点阵（可选模式） ====================

const DOT_SCRIPT = path.join(packageRoot(), "scripts", "ascii_dot.py");

/** 调 Python 生成 ASCII 点阵（stdin 传 base64，避免命令行长度限制） */
export function dotMatrixFromBase64(b64: string, cfg: VisionConfig): Promise<string> {
  return new Promise((resolve) => {
    try {
      const py = execFile(
        "python",
        [DOT_SCRIPT, "stdin", String(cfg.dotWidth), String(cfg.dotHeight), cfg.dotInvert ? "1" : "0"],
        { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(`# dot-matrix failed: ${String(err.message || err).slice(0, 200)}`);
          resolve(stdout);
        },
      );
      py.stdin?.write(b64);
      py.stdin?.end();
    } catch (e: any) {
      resolve(`# dot-matrix error: ${String(e?.message || e).slice(0, 200)}`);
    }
  });
}

/** 生成点阵块（失败不中断主流程） */
export async function dotMatrixBlock(img: ImageInput, cfg: VisionConfig): Promise<string> {
  try {
    if (!img.base64) return "# dot-matrix skipped: unsupported image source (URL/remote)";
    const out = (await dotMatrixFromBase64(img.base64, cfg)).trim();
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

async function visionEncode(
  images: ImageInput[],
  prompt: string,
  cfg: VisionConfig,
  signal?: AbortSignal,
): Promise<{ text: string; cached: boolean }> {
  const key = cacheKey(images);
  if (cfg.cacheTTL > 0) {
    const hit = cacheGet(key, cfg.cacheTTL);
    if (hit) return { text: `[缓存命中] ${hit}`, cached: true };
  }

  const contents: any[] = [{ type: "text", text: prompt }];
  for (const img of images) contents.push(img.content);

  const body = JSON.stringify({
    model: cfg.model,
    messages: [{ role: "user", content: contents }],
    max_tokens: cfg.maxTokens,
  });
  const resp = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body,
    signal,
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`视觉模型调用失败 (${resp.status}): ${err.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  const text = data?.choices?.[0]?.message?.content || "（无输出）";
  if (cfg.cacheTTL > 0) cacheSet(key, text, cfg.cacheMax);
  return { text, cached: false };
}

function maxTokensFor(mode: string, cfg: VisionConfig): number {
  if (cfg.maxTokens) return cfg.maxTokens;
  return mode === "brief" ? 512 : 2048;
}

/**
 * 统一入口：分析一张或多张图片，返回注入文本（含通感编码说明）
 * 任何错误都以 { ok:false } 返回，绝不抛出。
 */
export async function analyzeImages(
  images: any[],
  options: AnalyzeOptions = {},
  cfg?: VisionConfig,
  signal?: AbortSignal,
): Promise<AnalyzeResult> {
  const config = cfg || loadConfig();
  const promptText = options.prompt || "";
  const mode = options.mode || resolveMode(config, promptText);
  const prompt = buildPrompt(promptText, mode);
  const cfg2 = { ...config, maxTokens: maxTokensFor(mode, config) };

  if (!cfg2.apiKey) {
    return {
      ok: false,
      text: "❌ 未找到 API key（设置 MM_VISION_API_KEY / DASHSCOPE_API_KEY 环境变量，或配置 apiKey / auth.json）",
      mode, model: cfg2.model, cached: false,
      error: "missing_api_key",
    };
  }

  const normalized: ImageInput[] = [];
  for (const img of images) {
    const n = normalizeImage(img);
    if (n) normalized.push(n);
  }
  if (normalized.length === 0) {
    return { ok: false, text: "❌ 无法解析图片数据（支持：本地路径 / URL / dataURL / {source:{type:base64}}）", mode, model: cfg2.model, cached: false, error: "unparsable_image" };
  }

  try {
    const { text: encoded, cached } = await visionEncode(normalized, prompt, cfg2, signal);
    let out = [
      `【图片通感编码（mm-vision）】模式:${mode} · 模型:${cfg2.model}`,
      encoded,
      "（以上是图片的结构化空间描述，坐标均为百分比 (x%,y%) 原点左上，可直接引用）",
    ].join("\n");

    // 可选：追加像素点阵
    if (cfg2.dotMatrix && normalized.length > 0) {
      const dot = await dotMatrixBlock(normalized[0], cfg2);
      out += `\n${dot}`;
    }
    return { ok: true, text: out, mode, model: cfg2.model, cached };
  } catch (e: any) {
    return {
      ok: false,
      text: `❌ ${e?.message || String(e)}`,
      mode, model: cfg2.model, cached: false,
      error: String(e?.message || e).slice(0, 300),
    };
  }
}

/** 单图便捷入口（CLI / MCP / Agent 最常用） */
export async function analyzeImage(
  image: any,
  options: AnalyzeOptions = {},
  cfg?: VisionConfig,
  signal?: AbortSignal,
): Promise<AnalyzeResult> {
  return analyzeImages([image], options, cfg, signal);
}
