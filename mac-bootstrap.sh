#!/bin/bash
# ClipRelay Mac 一键部署脚本。
# 用法（终端里粘贴一条即可）：
#   curl -fsSL https://raw.githubusercontent.com/ffffhx/cliprelay/main/mac-bootstrap.sh \
#     | bash -s -- <对端IP或.local主机名>
# 会装 Homebrew（如缺失）→ 装 Hammerspoon → 下载配置并写好对端地址 → 启动。

set -e
PEER="${1:-peer-mac.local}"
BASE="${CLIPRELAY_BASE_URL:-https://raw.githubusercontent.com/ffffhx/cliprelay/main}"

echo "==> 检查 Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  else
    echo "==> 未检测到 Homebrew，开始安装（可能要求输入开机密码）"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < /dev/tty
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi

echo "==> 安装 Hammerspoon"
brew install --cask hammerspoon

echo "==> 部署 ClipRelay 配置（对端：$PEER）"
mkdir -p ~/.hammerspoon
INIT=~/.hammerspoon/init.lua
if [ -f "$INIT" ]; then
  # 已有配置则不覆盖，追加到末尾
  { echo; echo "-- ===== ClipRelay ====="; curl -fsSL "$BASE/init.lua"; } >> "$INIT"
else
  curl -fsSL "$BASE/init.lua" -o "$INIT"
fi
sed -i '' "s/^local DEFAULT_PEER = .*/local DEFAULT_PEER = \"$PEER\"/" "$INIT"

echo "==> 启动 Hammerspoon"
# 刚装完 LaunchServices 可能还没注册，open -a 按名字会找不到，直接按路径打开
open /Applications/Hammerspoon.app

cat <<EOF
✅ ClipRelay 部署完成！
   还剩最后一步（系统强制要求本人操作）：
   在弹出的「辅助功能」设置里打开 Hammerspoon 的开关。
   之后选中任意文本按 Ctrl+Alt+G 即可发送。
EOF
