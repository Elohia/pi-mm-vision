#!/usr/bin/env bash
# mm-vision 一键安装：构建 + 注册到 Claude Code / Codex / Pi 共享 MCP
set -e
cd "$(dirname "$0")/.."

echo "🔧 [1/3] 构建..."
npm install --no-audit --no-fund >/dev/null 2>&1 || true
npm run build

echo "🔧 [2/3] 注册 MCP..."
SERVER="node $(pwd)/dist/mcp-server.js"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove mm-vision >/dev/null 2>&1 || true
  claude mcp add mm-vision -- $SERVER && echo "  ✅ Claude Code"
fi
if command -v codex >/dev/null 2>&1; then
  codex mcp remove mm-vision >/dev/null 2>&1 || true
  codex mcp add mm-vision -- $SERVER && echo "  ✅ Codex"
fi

echo "🔧 [3/3] Pi 共享 MCP（~/.agents/mcp/mcp.json）..."
MCP_DIR="$HOME/.agents/mcp"
MCP_FILE="$MCP_DIR/mcp.json"
mkdir -p "$MCP_DIR"
if [ -f "$MCP_FILE" ]; then
  python - "$MCP_FILE" "$SERVER" <<'PY'
import json, sys
file, server = sys.argv[1], sys.argv[2]
data = json.load(open(file, encoding="utf-8"))
data.setdefault("mcpServers", {})["mm-vision"] = {"command": "node", "args": [server.split("node ")[1]]}
json.dump(data, open(file, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
  echo "  ✅ Pi (~/.agents/mcp/mcp.json 已更新，重启 Pi 生效)"
else
  cat > "$MCP_FILE" <<JSON
{
  "mcpServers": {
    "mm-vision": {"command": "node", "args": ["$SERVER"]}
  }
}
JSON
  echo "  ✅ Pi (新建 ~/.agents/mcp/mcp.json)"
fi

echo ""
echo "✅ 完成！配置 API key 后即可使用："
echo "   export MM_VISION_API_KEY=你的key"
echo "   或创建 ~/.config/mm-vision/config.json（见 vision-config.example.json）"
echo ""
echo "测试: mm-vision analyze examples/kline.png"
