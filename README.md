# mm-vision — Synesthesia Encoder (通感编码器)

**Give any text-only LLM (DeepSeek, GPT-4 base, Claude…) the ability to "see" images.**

通感编码器 — 让纯文本模型通过**结构化空间文字**获得像素级图片认知：视觉模型看原图 → 输出紧凑的坐标化描述（画布/元素/百分比坐标/形状/数值/关系）→ 注入给文本模型，后者凭文字重建画面、推理位置关系。

![example](examples/kline.png)

## Why 通感编码?

纯文本模型无法处理图片 token。两种朴素方案都有硬伤：

| 方案 | 问题 |
|------|------|
| ASCII 点阵 | 慢（外部进程）、token 爆炸（1200+）、丢失颜色/语义 |
| 自然语言描述 | 模糊散文：模型知道"是K线图"但不知道**峰在哪、支撑在哪、趋势多陡** |

通感编码走中间路线：**一次 API 调用**，视觉模型把图片翻译成**紧凑的坐标化空间描述**（像飞行员按坐标报告地形），文本模型据此重建场景，位置推理精确到像素级。

## ✨ Features

- 🎯 **通感编码**：画布 / 元素 / (x%, y%) 坐标 / 形状 / 数值 / 关系，结构化输出
- 🔢 **可选点阵模式**（`dotMatrix: true`）：追加像素级 ASCII 点阵（带网格标尺），适合曲线细节场景
- ⚡ **4 种模式**：`brief`（快/省 512 tokens）/ `full`（标准）/ `coords`（坐标优先，图表盘面专用）/ `auto`（关键词自动识别）
- 🧠 **缓存**：TTL 内重复分析秒回（默认 600s / 100 条）
- 🔌 **零硬编码**：模型 / baseUrl / API key / 配置路径全可配置；兼容任意 OpenAI 兼容视觉模型（qwen-vl / gpt-4o / glm-4v / kimi-vl / MiniMax-VL…）
- 🖥️ **多宿主接入**：MCP（Claude Code / Codex / Pi / Cursor / opencode）+ CLI + Agent 扩展
- 🎨 **双向协议（mcp_render）**：通感编码 → SVG 图片（矩形/圆/椭圆/多边形/箭头/文本/K线），纯文本 LLM 获得**画图**能力
- 🔬 **像素级渲染**：ASCII 点阵 / RGB三元组 / RGB三通道嵌套 → 像素网格，分块拼接（4×4=5万+像素），**文字→真彩色图片**
- 🌐 **HTML 渲染器**：canvas putImageData 浏览器直接出图（零依赖、可缩放、一键保存 PNG）

## 🚀 安装（3 分钟）

### 方式 A：一键脚本（推荐）

```bash
git clone https://github.com/Elohia/pi-mm-vision.git
cd pi-mm-vision
./install.sh          # 构建 + 自动注册到 Claude Code / Codex / Pi
```

### 方式 B：手动

```bash
npm install && npm run build
```

然后按你的 Agent 注册：

| Agent | 注册命令 |
|-------|----------|
| **Claude Code** | `claude mcp add mm-vision -- node $(pwd)/dist/mcp-server.js` |
| **Codex** | `codex mcp add mm-vision -- node $(pwd)/dist/mcp-server.js` |
| **Pi** | 在 `~/.agents/mcp/mcp.json` 加条目（Pi 网关自动导入） |
| **任何 MCP 宿主** | 以 stdio 方式指向 `dist/mcp-server.js` |
| **无 MCP 环境** | 直接用 CLI：`node dist/cli.js analyze <图片>` |

### Pi 扩展方式（原生）

```bash
cp src/pi-extension.ts ~/.pi/extensions/   # 或 F:/pi-agent/extensions/
```

提供 `mm_vision` 工具 + 粘贴图片自动分析 + `/vision` 命令。

## ⚙️ 配置

API key 解析顺序：

1. 配置文件的 `apiKey` 字段
2. 环境变量：`MM_VISION_API_KEY` → `DASHSCOPE_API_KEY` → `QWEN_API_KEY` → `OPENAI_API_KEY` → `GEMINI_API_KEY`
3. `auth.json`（`~/.config/mm-vision/auth.json` / `~/.pi/auth.json` / 项目根），支持 `{"apiKey":…}` 与 `{"provider":{…}}` 两种形态

配置文件查找顺序（首个命中）：

```
$MM_VISION_CONFIG
~/.config/mm-vision/config.json
~/.mm-vision.json
<项目根>/vision-config.json
<cwd>/vision-config.json
<cwd>/.vision-config.json
```

示例 `vision-config.json`（见 `vision-config.example.json`）：

```json
{
  "model": "qwen-vl-max",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "maxTokens": 2048,
  "autoDetect": true,
  "mode": "auto",
  "cacheTTL": 600,
  "cacheMax": 100,
  "dotMatrix": false,
  "dotWidth": 80,
  "dotHeight": 24,
  "dotInvert": true
}
```

> 用别的视觉模型？改 `model` + `baseUrl` 即可（OpenAI 兼容协议）。没有 DashScope key 也可以用 OPENAI_API_KEY / GEMINI_API_KEY。

## 🔄 双向协议：编码 ⇄ 渲染

通感编码是**图像交换语言**，双向可用：

```
正方向（编码）：图片 → mcp_vision → 结构化坐标文字
反方向（渲染）：坐标文字 → mcp_render → SVG/PNG 图片
```

纯文本 LLM 因此获得**画图能力**：输出坐标化描述 → 渲染成真实图片。

```
mcp_render(synesthesia: "【画布】16:9 浅色背景 #f5f6fa
【元素】[矩形 | 位置(10%,10%) | 尺寸(35%x20%) | 颜色#4a90d9 | 圆角 | "登录按钮"]...")
# → SVG 图片（含登录/注册按钮、圆点状态、箭头流程）
```

CLI 反向渲染：

```bash
mm-vision render encoded.txt -o chart.svg      # 通感编码文本 → SVG
mm-vision pixels smile.txt -o smile.svg        # ASCII 点阵 → 像素网格 SVG（像素级）
mm-vision html lake.txt -o lake.html --scale 4    # 点阵/RGB → HTML 画布页（浏览器出图）
# 再用 scripts/svg2png.py 转 PNG
```

支持元素：矩形 / 圆形 / 椭圆 / 多边形 / 箭头 / 文本 / 水平线 / 标注点 / K线蜡烛 / 网格 / **密集折线（点→线）** / **面填充（线→面）** / **像素网格（点阵→像素）**。
已闭环验证：编码 → 渲染 → 再识别，坐标与元素完全一致。

## ⚠️ 诚实声明（先看这里）

**mm-vision draw 画出来的图，丑。** 这不是谦虚，是物理规律：

| 通道 | 原理 | 效果 |
|------|------|------|
| `pil` 通道 | 文字模型写 Python 代码画图 | 几何图形、简单示意图 **能用**；风景/人物/复杂场景 **惨不忍睹**（色块、锯齿、比例失调） |
| `sync` 通道 | 通感描述 → 矢量渲染 | 界面线框、图表 **可用**；自然图 **等于火柴人** |
| 点阵/色块 | 逐像素文字描述 | 分辨率受 token 限制，细节必然丢失 |

**为什么丑？**
1. 文字模型不懂"美"——它没看过像素，只能靠训练数据里的代码模式拼凑
2. PIL 是程序化绘图：渐变靠硬编码、曲线靠数学公式、光影靠想象
3. 输出 token 有限，细节和范围不可兼得

**draw 的真正定位**：
- ✅ 图表、示意图、线框图、UI 草稿——**够用且实用**
- ✅ 快速可视化数据/想法，给人类当草稿
- ❌ 不是文生图（那需要 wan2.7-image / Stable Diffusion 等专用模型）
- ❌ 不是照片级渲染

**与 mm_vision（识别）的关系**：
```
mm_vision = 看图（识别）→ 文字描述     [视觉模型 · 有损但理解力强]
mm-vision draw = 文字 → 程序画图       [文字模型 · 无损但画得丑]
两者互补：识别告诉你"图里有什么"，draw 帮你"把想法画出来"
```

**建议**：需要高质量图片请用专用文生图模型（`wan2.7-image`、SDXL、Midjourney）；mm-vision draw 适合"能看懂就行"的场景。

## 🎯 使用

### MCP（所有接入的 Agent）

```
mcp_vision(image: "F:/charts/kline.png", prompt: "标出支撑压力位坐标")
mcp_vision(image: "https://example.com/chart.png")
```

### CLI

```bash
mm-vision analyze F:/charts/kline.png
mm-vision analyze https://example.com/chart.png "标出支撑压力位" 
mm-vision analyze F:/charts/kline.png coords "只输出关键坐标"
mm-vision config
```

### Pi（原生扩展）

```
mm_vision(image: "F:/charts/kline.png", prompt: "分析这张图")
/vision F:/charts/kline.png 支撑压力位在哪
粘贴图片 → 自动分析并注入描述
```

## 📋 模式

| 模式 | Tokens | 适用 |
|------|--------|------|
| `brief` | 512 | 快速浏览：这是什么图？ |
| `full` | 2048 | 通用：全部可识别元素 |
| `coords` | 2048 | **图表/盘面/UI**：每个关键元素必须带精确 (x%,y%) |
| `auto` | — | 关键词识别（K线/图表/盘面/坐标/曲线/截图 → coords） |

## 🧪 验证

```bash
# 用样例图测试（配置好 API key 后）
mm-vision analyze examples/kline.png
# 期望输出包含: 画布 / 元素 / 支撑位坐标 / 最高点坐标
```

样例输出（`examples/kline.output.txt`）展示了完整编码格式。

## 🔒 安全

- 只把图片发送到**你配置的**视觉模型做描述
- 从不执行图片内容中的命令
- 输出是注入对话的文本——与任何模型输出一样按不可信输入对待

## 🏗 架构

```
src/
├── core.ts           # 纯函数核心（零依赖）：配置/编码/缓存/点阵
├── mcp-server.ts     # MCP server（stdio，JSON-RPC 2.0 手写零依赖）
├── cli.ts            # 独立命令行入口（analyze / render）
├── render.ts         # 反向渲染：通感编码 → SVG（矢量 + 像素级点阵）
└── pi-extension.ts   # Pi Agent 原生适配层
scripts/
└── ascii_dot.py      # 可选点阵生成器（PIL）
examples/
└── kline.png         # 样例 K 线图
```

**集成到其他 Agent？** 直接 `import { analyzeImage } from "mm-vision"`（npm 包形态），或起一个 MCP server。

## 📄 License

MIT
