#!/data/data/com.termux/files/usr/bin/bash
# ClipRelay Android 发送端：把手机剪贴板内容 POST 给对端（Mac / Windows / 另一台手机）。
# 依赖：pkg install curl jq termux-api（并安装 Termux:API App）
# 一键发送：把本文件放到 ~/.shortcuts/send.sh，用 Termux:Widget 加桌面小部件点一下即发。

PEER="192.168.1.100"   # 对端 IP 或 .local 主机名
PORT=47632

TEXT=$(termux-clipboard-get)
if [ -z "$TEXT" ]; then
  termux-toast "ClipRelay：剪贴板为空"
  exit 1
fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  --data "$(printf '%s' "$TEXT" | jq -Rs '{text: .}')" \
  "http://$PEER:$PORT/push")

if [ "$CODE" = "200" ]; then
  termux-toast "ClipRelay：已发送"
else
  termux-toast "ClipRelay：发送失败 ($CODE)"
  exit 1
fi
