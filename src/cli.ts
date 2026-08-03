#!/usr/bin/env node
/**
 * mm-vision CLI — 通感编码器命令行入口
 * ======================================
 * 独立使用，不依赖任何 Agent：
 *   mm-vision analyze <image> [prompt...]
 *   mm-vision config             # 显示当前配置（隐藏 key）
 *   mm-vision cache              # 缓存统计
 *
 * 也用于 Agent shell 集成：
 *   Codex / Claude Code 的 hooks 或自定义命令可直接调用本 CLI 并把输出注入上下文。
 *
 * 示例：
 *   mm-vision analyze F:/charts/kline.png
 *   mm-vision analyze https://example.com/chart.png "标出支撑位和压力位坐标"
 *   mm-vision analyze F:/charts/kline.png coords "只输出坐标"
 */
import { analyzeImage, loadConfig, cacheStats, configCandidates, packageRoot } from "./core.js";
import { renderSynesthesiaToSVG, renderSynesthesiaToSVGFile, extractAsciiMatrix, asciiMatrixToPixels, pixelsToSVG } from "./render.js";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "help";

  switch (cmd) {
    case "analyze": {
      const image = args[1];
      if (!image) {
        console.error("用法: mm-vision analyze <image路径|URL|dataURL> [模式] [prompt...]");
        process.exit(2);
      }
      let mode: any;
      let prompt = "";
      const rest = args.slice(2);
      if (rest[0] && ["brief", "full", "coords", "auto"].includes(rest[0])) {
        mode = rest[0];
        prompt = rest.slice(1).join(" ");
      } else {
        prompt = rest.join(" ");
      }
      const cfg = loadConfig();
      const result = await analyzeImage(image, { prompt, mode }, cfg);
      console.log(result.text);
      if (!result.ok) process.exit(1);
      return;
    }

    case "render": {
      // 反向渲染：通感编码文本 → SVG 图片
      const src = args[1];
      if (!src) {
        console.error("用法: mm-vision render <编码文本文件|或直接传文本> [-o out.svg] [--width 960]");
        console.error("示例: mm-vision render encoded.txt -o chart.svg");
        process.exit(2);
      }
      let outPath = "output.svg";
      let width = 960;
      const rest = args.slice(2);
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "-o" && rest[i + 1]) outPath = rest[i + 1];
        if (rest[i] === "--width" && rest[i + 1]) width = parseInt(rest[i + 1]);
      }
      let text = src;
      if (fs.existsSync(src)) text = fs.readFileSync(src, "utf-8");
      const svg = renderSynesthesiaToSVG(text, width);
      if (fs.existsSync(path.dirname(path.resolve(outPath))) || path.dirname(outPath) === ".") {
        fs.writeFileSync(outPath, svg, "utf-8");
        console.log(`✅ 已渲染: ${path.resolve(outPath)} (${svg.length} bytes SVG)`);
      } else {
        console.log(svg);
      }
      return;
    }

    case "pixels": {
      // 像素级：ASCII 点阵 → 像素网格 SVG
      const src = args[1];
      if (!src) {
        console.error("用法: mm-vision pixels <点阵文件> [-o out.svg] [--width 960] [--fg #39d353] [--bg #0d1117]");
        process.exit(2);
      }
      let outPath = "pixels.svg";
      let width = 960, fg = "#39d353", bg = "#0d1117";
      const rest = args.slice(2);
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "-o" && rest[i + 1]) outPath = rest[i + 1];
        if (rest[i] === "--width" && rest[i + 1]) width = parseInt(rest[i + 1]);
        if (rest[i] === "--fg" && rest[i + 1]) fg = rest[i + 1];
        if (rest[i] === "--bg" && rest[i + 1]) bg = rest[i + 1];
      }
      let text = fs.readFileSync(src, "utf-8");
      const matrix = extractAsciiMatrix(text) || text; // 直接点阵文件则全文即矩阵
      const m = asciiMatrixToPixels(matrix);
      const pixelSize = Math.max(1, Math.floor(width / m.width));
      const svg = pixelsToSVG(m, { pixelSize, fg, bg });
      fs.writeFileSync(outPath, svg, "utf-8");
      console.log(`✅ 像素网格已渲染: ${path.resolve(outPath)} (${m.width}x${m.height}, ${m.cells.length} 像素, ${svg.length} bytes)`);
      return;
    }

    case "config": {
      const cfg = loadConfig();
      console.log("mm-vision 配置:");
      console.log(`  模型:        ${cfg.model}`);
      console.log(`  BaseURL:     ${cfg.baseUrl}`);
      console.log(`  模式:        ${cfg.mode} (auto=关键词识别)`);
      console.log(`  缓存:        ${cfg.cacheTTL}s / ${cfg.cacheMax}条`);
      console.log(`  点阵:        ${cfg.dotMatrix ? `ON (${cfg.dotWidth}x${cfg.dotHeight})` : "OFF"}`);
      console.log(`  API key:     ${cfg.apiKey ? cfg.apiKey.slice(0, 6) + "***" : "❌ 未设置"}`);
      console.log(`  配置来源:    ${configCandidates().filter((p) => p && fs.existsSync(p)).join(", ") || "默认值"}`);
      console.log(`  安装目录:    ${packageRoot()}`);
      if (!cfg.apiKey) {
        console.log("\n提示: 设置环境变量 MM_VISION_API_KEY 或创建 ~/.config/mm-vision/config.json");
        process.exit(1);
      }
      return;
    }

    case "cache": {
      console.log(JSON.stringify(cacheStats()));
      return;
    }

    case "help":
    default:
      console.log(`mm-vision — 通感编码器 v2.0.0
让纯文本 LLM 获得图片空间认知（结构化坐标描述）。

用法:
  mm-vision analyze <image> [mode] [prompt]   分析图片并输出通感编码
  mm-vision render <encoded.txt> [-o out.svg]  反向：通感编码 → SVG 图片
  mm-vision config                             查看当前配置
  mm-vision cache                              缓存统计
  mm-vision help                               本帮助

模式: brief(快/省) | full(标准) | coords(坐标优先) | auto(自动识别)
图片: 本地路径 / URL / dataURL`);
      return;
  }
}

main().catch((e) => {
  console.error(`mm-vision CLI 错误: ${e?.message || e}`);
  process.exit(1);
});
