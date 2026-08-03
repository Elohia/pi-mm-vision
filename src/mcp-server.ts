/**
 * mm-vision MCP server — 通感编码器 · Model Context Protocol 实现
 * ==============================================================
 * 让任何支持 MCP 的 Agent（Claude Code / Codex / Pi / Cursor / opencode…）
 * 通过标准 mcp_vision 工具获得图片空间认知。
 *
 * 启动方式（stdio 传输，零 HTTP 依赖）：
 *   npx tsx src/mcp-server.ts          # 开发
 *   node dist/mcp-server.js            # 构建后
 *
 * 注册到各 Agent：
 *   Claude Code: claude mcp add mm-vision -- node dist/mcp-server.js
 *   Codex:       codex mcp add mm-vision -- node dist/mcp-server.js
 *   Pi:          在 ~/.agents/mcp/mcp.json 添加条目（Pi 网关自动导入）
 *
 * 实现原则：
 *   - 零第三方依赖（手写 JSON-RPC 2.0 + stdio），避免安装负担
 *   - 工具名 mcp_vision：支持 本地路径 / URL / dataURL / base64 对象
 *   - 图片在服务器进程内转成 base64 dataURL 发给视觉模型，不落盘
 */
import * as readline from "readline";
import { analyzeImage, loadConfig, VisionConfig } from "./core.js";
import { renderSynesthesiaToSVG, synesthesiaToDataURL } from "./render.js";

// ==================== MCP 协议常量 ====================

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "mm-vision";
const SERVER_VERSION = "2.0.0";

// ==================== 工具定义 ====================

const VISION_TOOL = {
  name: "mcp_vision",
  description:
    "视觉代理（通感编码）：分析图片（K线图/盘面截图/报告图表/任何图片），返回结构化空间描述（画布/元素/百分比坐标/数值/关系）。" +
    "纯文本模型（DeepSeek 等）无视觉能力时用它获取图片内容。支持本地路径、URL、dataURL 或 base64 对象。",
  inputSchema: {
    type: "object",
    properties: {
      image: {
        type: "string",
        description: "图片：本地路径（F:/x/kline.png）、URL（https://…）、dataURL（data:image/png;base64,…）",
      },
      prompt: {
        type: "string",
        description: "分析要求（可选）：auto 模式自动识别图表/自然图。如「标出支撑压力位坐标」",
      },
      mode: {
        type: "string",
        enum: ["brief", "full", "coords", "auto"],
        description: "编码模式（可选，默认 auto）",
      },
    },
    required: ["image"],
  },
};

const RENDER_TOOL = {
  name: "mcp_render",
  description:
    "反向渲染（通感编码→图）：把 mcp_vision 输出的通感编码文本渲染成 SVG 图片。" +
    "文本模型可输出坐标化描述（画布/元素/坐标/颜色）→ 生成真实图片，获得画图能力。" +
    "支持 K线/折线/水平线/标注点/网格。返回 SVG 内容或 data URL。",
  inputSchema: {
    type: "object",
    properties: {
      synesthesia: {
        type: "string",
        description: "通感编码文本（mcp_vision 输出格式）",
      },
      width: {
        type: "number",
        description: "输出宽度 px（可选，默认 960）",
      },
      asDataUrl: {
        type: "boolean",
        description: "返回 data URL 而非纯 SVG（可选，默认 false）",
      },
    },
    required: ["synesthesia"],
  },
};

// ==================== JSON-RPC 2.0 辅助 ====================

type Request = {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: any;
};

function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendError(id: any, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendResult(id: any, result: any) {
  send({ jsonrpc: "2.0", id, result });
}

// ==================== 请求处理 ====================

let cfgCache: VisionConfig | null = null;
let cfgLoadedAt = 0;

function getConfig(): VisionConfig {
  // 配置缓存 30s，支持运行中改配置
  if (!cfgCache || Date.now() - cfgLoadedAt > 30_000) {
    cfgCache = loadConfig();
    cfgLoadedAt = Date.now();
  }
  return cfgCache;
}

async function handleRequest(req: Request) {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;

    case "notifications/initialized":
      return; // 通知无 id，不回复

    case "ping":
      sendResult(id, {});
      return;

    case "tools/list":
      sendResult(id, { tools: [VISION_TOOL, RENDER_TOOL] });
      return;

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === "mcp_render") {
        if (!args.synesthesia) {
          sendError(id, -32602, "Missing required argument: synesthesia");
          return;
        }
        const svg = renderSynesthesiaToSVG(args.synesthesia, args.width || 960);
        const out = args.asDataUrl ? synesthesiaToDataURL(args.synesthesia, args.width || 960) : svg;
        sendResult(id, {
          content: [{ type: "text", text: out }],
          isError: false,
          structuredContent: {
            ok: true,
            format: args.asDataUrl ? "data-url" : "svg",
            bytes: svg.length,
          },
        });
        return;
      }

      if (toolName !== "mcp_vision") {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }
      if (!args.image) {
        sendError(id, -32602, "Missing required argument: image");
        return;
      }

      const cfg = getConfig();
      const result = await analyzeImage(
        args.image,
        { prompt: args.prompt || "", mode: args.mode },
        cfg,
      );

      // MCP 工具结果标准格式
      const content = result.ok
        ? [{ type: "text", text: result.text }]
        : [{ type: "text", text: result.text }];
      sendResult(id, {
        content,
        isError: !result.ok,
        structuredContent: {
          ok: result.ok,
          mode: result.mode,
          model: result.model,
          cached: result.cached,
          error: result.error || null,
        },
      });
      return;
    }

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ==================== stdio 入口 ====================

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const req = JSON.parse(trimmed);
    // 通知类（无 id）不回复；避免未定义 id 的响应
    if (req.id === undefined || req.id === null) {
      if (req.method === "notifications/initialized" || req.method?.startsWith("notifications/")) return;
    }
    handleRequest(req).catch((e) => {
      if (req.id !== undefined && req.id !== null) {
        sendError(req.id, -32603, `Internal error: ${String(e?.message || e).slice(0, 300)}`);
      }
    });
  } catch {
    // 非 JSON 行忽略（兼容日志噪声）
  }
});

// 启动横幅 → stderr（避免污染 stdout 协议流）
process.stderr.write(`[mm-vision MCP] ${SERVER_NAME} v${SERVER_VERSION} ready (stdio)\n`);
