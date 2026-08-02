#!/data/data/com.termux/files/usr/bin/sh
# ClipRelay Android 开机自启（可选）：安装 Termux:Boot App 后，
# 把本文件放到 ~/.termux/boot/boot-cliprelay.sh，重启手机后接收端自动常驻。
termux-wake-lock
nohup python "$HOME/cliprelay/receiver.py" > "$HOME/cliprelay/receiver.log" 2>&1 &
