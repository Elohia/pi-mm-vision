# mm-vision

**Synesthesia Encoder** — give any text-only LLM (DeepSeek, etc.) the ability to "see" images via structured spatial text encoding.

通感编码器 — 让纯文本模型（DeepSeek 等）通过"通感编码"获得图片的空间认知：视觉模型看原图 → 输出结构化文字（画布/元素/百分比坐标/形状/数值/关系）→ 注入给文本模型，后者凭文字重建画面。

## Why 通感编码 (Synesthesia)?

Text-only models cannot process image tokens. Two naive fixes fail:

| Approach | Problem |
|----------|---------|
| Dot-matrix (ASCII art) | Slow (spawns external processes), token-heavy (~1200+ tokens), loses color/semantics |
| Plain vision description | Vague prose: model knows "a K-line chart" but not *where* the peak is, *where* support is, *how steep* the trend is |

Synesthesia encoding is a middle path: **one API call**, the vision model translates the image into a **compact, coordinate-based spatial description** (like a pilot describing terrain by coordinates). The text model reconstructs the scene and can reason about positions with pixel-level precision.

## Features

- 🎯 **Synesthesia encoding**: structured spatial description (canvas / elements / (x%, y%) coordinates / shapes / values / relationships)
- 🔢 **Optional dot-matrix mode** (`dotMatrix: true`): appends a pixel-level ASCII dot-matrix (with grid rulers) for shape-precision use cases — off by default to save tokens/time
- ⚡ **3 modes + auto**: `brief` (fast & cheap, 512 tokens) / `full` (standard) / `coords` (coordinate-first, for charts & screenshots) / `auto` (auto-detects charts via keywords → coords)
- 🧠 **Cache**: same image re-analysis within TTL returns instantly (default 600s, 100 entries)
- 🔌 **Zero hardcoding**: model / baseUrl / API key / config path all configurable; works with any OpenAI-compatible vision model (qwen-vl, gpt-4o, glm-4v, kimi-vl, MiniMax-VL…)
- 🖼️ **3 entry points**: `mm_vision` tool (agent-invoked), paste-image auto-detection (input event), `/vision` command (interactive)

## Install

1. Copy `mm-vision.ts` into your Pi extensions directory (e.g. `~/.pi/extensions/` or `F:/pi-agent/extensions/`).
2. Configure API key (see below).
3. Restart Pi. No npm dependencies — uses only the Pi ExtensionAPI and Node built-ins (`fetch`, `fs`, `os`, `path`, `crypto`).

## Configuration

Config file is looked up in order (first found wins):

1. `MM_VISION_CONFIG` env var
2. `~/.pi/vision-config.json`
3. `~/.config/mm-vision/config.json`
4. `<cwd>/vision-config.json`
5. `<cwd>/.vision-config.json`

Example `vision-config.json`:

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

`dotMatrix: true` 时每次分析会额外生成一张 ASCII 点阵（像素级形状，含行列标尺），适合需要看曲线细节抖动的盘面场景；默认关闭省 token。

API key resolution order:

1. `apiKey` in config
2. Env: `MM_VISION_API_KEY` → `DASHSCOPE_API_KEY` → `QWEN_API_KEY` → `OPENAI_API_KEY`
3. `auth.json` (looked up at `~/.pi/auth.json`, `<cwd>/auth.json`, `~/.config/mm-vision/auth.json`), supporting both `{"apiKey": "..."}` and `{"provider": {"type": "...", "key": "..."}}` shapes — vision/qwen/ali/dash/vl/token providers preferred

## Usage

### 1. Agent-invoked tool

The `mm_vision` tool is registered automatically. Text-only agents call it with:

```
mm_vision(image: "F:/path/to/kline.png" | "https://..." | data-url, prompt?: "分析要求")
```

### 2. Paste an image in chat (auto mode)

Paste an image with or without text — the extension intercepts it, encodes it, and injects the description into the conversation. The text model then reasons with the encoded description.

### 3. Interactive command

```
/vision F:/path/to/kline.png 分析这张图的支撑压力位
```

## Modes

| Mode | Tokens | Best for |
|------|--------|----------|
| `brief` | 512 | Quick glance: what is this image about? |
| `full` | 2048 | General purpose, all identifiable elements |
| `coords` | 2048 | **Charts / trading screenshots / UI**: every key element must carry precise (x%, y%) coordinates |
| `auto` | — | Keyword detection: K线/图表/盘面/坐标/曲线/截图 → `coords`, otherwise `full` |

Set `"mode"` in config, or auto mode reacts to prompt keywords (e.g. "分析这张K线图的支撑位" → coords).

## Encoded output format

```
【图片通感编码（mm-vision）】模式:coords · 模型:qwen-vl-max
1. 【画布】宽高比 16:9, 深色背景 #1e1e28
2. 【元素】[K线蜡烛 | x=6%-94% | 24根 | 红#e0534b阳/绿#3fc47f阴]
3. 【趋势线】[黄色虚线 | 从(6%,78%)到(94%,20%) | 斜率≈0.65]
4. 【支撑位】[蓝色水平线 y=42% | 标注 "SUPPORT 275"]
5. 【最高点】[黄色标注 | 位于 (68%,18%) | 对应收盘价 340]
...
（坐标均为百分比 (x%,y%) 原点左上，可直接引用）
```

## Security note

This extension only sends images to the configured vision model for description. It never executes commands from image content. All analysis output is text injected into your conversation — treat it as untrusted input, as with any model output.

## License

MIT
