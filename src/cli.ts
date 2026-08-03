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
import * as fs from "fs";

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
