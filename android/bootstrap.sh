#!/data/data/com.termux/files/usr/bin/bash
# ClipRelay Android 一键部署脚本。
# 用法（Termux 里）：
#   curl -fsSL https://raw.githubusercontent.com/ffffhx/cliprelay/main/android/bootstrap.sh \
#     | bash -s -- <Mac的IP或.local主机名>
# 会从 GitHub 下载 receiver.py / send.sh，装依赖，写好对端地址，并启动接收端。

set -e
PEER="${1:-}"
BASE="${CLIPRELAY_BASE_URL:-https://raw.githubusercontent.com/ffffhx/cliprelay/main/android}"

if [ -z "$PEER" ]; then
  echo "用法：bash bootstrap.sh <Mac的IP或.local主机名>"
  exit 2
fi

echo "==> 安装依赖（python curl jq termux-api）"
pkg install -y python curl jq termux-api

echo "==> 下载 ClipRelay 脚本"
mkdir -p ~/cliprelay
curl -fsSL "$BASE/receiver.py" -o ~/cliprelay/receiver.py
curl -fsSL "$BASE/send.sh" -o ~/cliprelay/send.sh
chmod +x ~/cliprelay/send.sh

echo "==> 配置对端：$PEER"
sed -i "s/^PEER=.*/PEER=\"$PEER\"/" ~/cliprelay/send.sh

echo "==> 注册桌面一键发送（~/.shortcuts，配合 Termux:Widget）"
mkdir -p ~/.shortcuts
cp ~/cliprelay/send.sh ~/.shortcuts/send.sh

echo "==> 启动接收端"
termux-wake-lock
pkill -f receiver.py 2>/dev/null || true
nohup python ~/cliprelay/receiver.py > ~/cliprelay/receiver.log 2>&1 &

sleep 1
if pgrep -f receiver.py > /dev/null; then
  echo "✅ ClipRelay 部署完成，接收端已运行（端口 47632）"
  echo "   手机剪贴板发送：~/cliprelay/send.sh（或桌面 Termux:Widget 小部件）"
else
  echo "❌ 接收端启动失败，日志：~/cliprelay/receiver.log"
  exit 1
fi
