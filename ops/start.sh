#!/bin/bash
# qqours start v2 — 伪装环境 + 幂等启动（屏幕/时区/语言按普通桌面配置）
set -u
BASE=/data/qq-ours
export TZ=Asia/Shanghai
export QQ_DEV_NAME="${QQ_DEV_NAME:-ubuntu-desktop}"

if pgrep -u qqrun -f "/opt/QQ/qq" >/dev/null; then
  echo "already running"
  exit 0
fi
rm -f "$BASE/status.json"
su qqrun -c "TZ=Asia/Shanghai LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 QQ_DEV_NAME='$QQ_DEV_NAME' \
  nohup xvfb-run -a -s '-screen 0 1920x1080x24 -dpi 96' /opt/QQ/qq > $BASE/run.log 2>&1 &"
echo "started"
