#!/usr/bin/env bash
# Strand 一键安装：装「AI 使用时长」本地统计服务（端口 8788，开机自启）。
# 干的事：探测本机 node → 写 launchd → 起服务自检。
# 不碰：Chrome 扩展加载（需你手动在 chrome://extensions 加载已解压）。
# lark-cli 可选：只是旧版飞书 Base 排行榜的遗留依赖，现排行榜走 Supabase，没装不影响。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"           # usage-tracker 目录
NODE="$(command -v node || true)"
LARK="$(command -v lark-cli || true)"

echo "== Strand 安装 =="
[ -z "$NODE" ] && { echo "✗ 没找到 node。先装 node（brew install node 或 nvm），再重跑。"; exit 1; }
echo "  node:     $NODE"
if [ -n "$LARK" ]; then echo "  lark-cli: $LARK（旧排行榜遗留，可有可无）"; else echo "  lark-cli: 未装（没关系，不影响）"; fi

# 1) lark-cli 路径写进 leaderboard.json（仅旧版遗留接口用；没装就跳过）
CFG="$DIR/leaderboard.json"
if [ -n "$LARK" ]; then
  "$NODE" -e '
const fs=require("fs"), f=process.argv[1];
const j=JSON.parse(fs.readFileSync(f,"utf8"));
j.larkCli=process.argv[2];
fs.writeFileSync(f, JSON.stringify(j,null,2));
' "$CFG" "$LARK"
  echo "  ✓ leaderboard.json 已填本机 lark-cli 路径"
fi

# 2) 生成 launchd 配置（绝对路径，避免 launchd 精简 PATH 找不到 node）
PLIST="$HOME/Library/LaunchAgents/com.strand.usage.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.strand.usage</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/strand-usage.log</string>
  <key>StandardErrorPath</key><string>/tmp/strand-usage.log</string>
</dict>
</plist>
EOF
echo "  ✓ launchd 配置已写：$PLIST"

# 3) 起服务
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 2

# 4) 自检
echo -n "  健康检查 8788 … "
if curl -s --max-time 5 http://127.0.0.1:8788/health | grep -q ok; then
  echo "OK ✓"
else
  echo "失败 ✗（看 /tmp/strand-usage.log）"; exit 1
fi

echo ""
echo "本地服务装好了。还差两步（手动）："
echo "  1. Chrome → chrome://extensions → 右上角开「开发者模式」→「加载已解压的扩展程序」→ 选这个文件夹的上一级（strand-newtab/）"
echo "  2. 开个新标签页 → 排行榜右上角「登录」→「第一次？去注册」，邮箱+密码+昵称头像，注册完即上榜"
echo "完事后开个新标签页就能用。"
