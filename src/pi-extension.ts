/**
 * pi-extension.ts — mm-vision 通感编码器 · Pi Agent 适配层
 * =========================================================
 * 通过 Pi ExtensionAPI 提供：
 *   1. mm_vision 工具（文本模型主动调用）
 *   2. input 事件（用户粘贴图片自动分析并注入）
 *   3. /vision 命令（交互式分析）
 *
 * 核心逻辑在 src/core.ts（零依赖纯函数），本文件只做 Pi 适配。
 * 非 Pi 用户请看 src/mcp-server.ts（MCP 标准接入）或 src/cli.ts（独立命令行）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyzeImages, loadConfig, resolveMode } from "./core.js";

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
      const result = await analyzeImages([params.image], { prompt: params.prompt || "" }, loadConfig(), signal);
      return {
        content: [{ type: "text", text: result.text }],
        details: { image: params.image, model: result.model, mode: result.mode, cached: result.cached },
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
      const result = await analyzeImages(images, { prompt: text }, cfg);
      if (!result.ok) {
        ctx.ui.notify(`❌ ${result.text.slice(0, 200)}`, "error");
        return { action: "continue" };
      }
      return {
        action: "transform",
        text: `${text}\n\n${result.text}`,
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
        ctx.ui.notify("❌ 未找到 API key（设置 MM_VISION_API_KEY 或配置 apiKey）", "error");
        return;
      }
      ctx.ui.notify(`📷 通感编码中: ${img}`, "info");
      const result = await analyzeImages([img], { prompt }, cfg);
      ctx.ui.notify(result.text.slice(0, 150), "info");
      return result.text;
    },
  });
}
