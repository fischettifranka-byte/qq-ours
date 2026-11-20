#!/bin/bash
# apply_p1.sh — 安装 P1：免扫码登录阶梯 + 设备伪装 + systemd 托管 + 登录态快照
# 用法（服务器上）：bash /data/qq-ours/apply_p1.sh [--restart]
set -euo pipefail
BASE=/data/qq-ours
APP=/opt/QQ/resources/app
TS=$(date +%Y%m%d-%H%M%S)

echo "[1/7] 备份"
cp -a "$APP/qqours_main.js" "$APP/qqours_main.js.p1bak.$TS"
cp -a "$BASE/ops/watchdog.sh" "$BASE/ops/watchdog.sh.p1bak.$TS" 2>/dev/null || true

echo "[2/7] 装 v2 源码（含 P0 队列/白名单）"
cp "$BASE/src/qqours_main.v2.js" "$APP/qqours_main.js"
node --check "$APP/qqours_main.js"

echo "[3/7] 装 ops 脚本"
chmod 755 "$BASE/ops/start.sh" "$BASE/ops/stop.sh" "$BASE/ops/backup_login.sh" "$BASE/ops/restore_login.sh"
cp -f "$BASE/ops/watchdog.sh.new" "$BASE/ops/watchdog.sh" && chmod 755 "$BASE/ops/watchdog.sh"
for f in start stop backup_login restore_login watchdog; do bash -n "$BASE/ops/$f.sh"; done
chown qqrun:qqrun "$BASE/ops/start.sh" "$BASE/ops/backup_login.sh" 2>/dev/null || true

echo "[4/7] camel: 宿主机伪装（主机名/时区/locale/家目录）"
bash "$BASE/ops/camouflage.sh" ubuntu-desktop || echo "伪装脚本部分失败，可手动跑"

echo "[5/7] systemd 托管（替换 cron 拉起）"
install -m 644 "$BASE/ops/qqours.service" /etc/systemd/system/qqours.service
touch "$BASE/RELAUNCH_ON_DEAD"   # 进程死了由 watchdog 兜底拉起（systemd 不追踪 detach 的子进程）
systemctl daemon-reload
systemctl enable qqours.service >/dev/null 2>&1 || true
systemctl daemon-reload
# cron 只保留看门狗做告警，重启交给 systemd
( crontab -l 2>/dev/null | grep -v 'watchdog.sh' ; echo "*/2 * * * * $BASE/ops/watchdog.sh" ) | crontab -

echo "[6/7] 登录态快照目录"
mkdir -p "$BASE/login_snapshots"; chown qqrun:qqrun "$BASE/login_snapshots"

echo "[7/7] 结果"
echo "  源码: $APP/qqours_main.js ($(wc -l < "$APP/qqours_main.js") 行)"
echo "  回滚: cp -a $APP/qqours_main.js.p1bak.$TS $APP/qqours_main.js && systemctl restart qqours"
echo "  cron: $(crontab -l | grep -c watchdog.sh) 条 watchdog"
if [ "${1:-}" = "--restart" ]; then
  echo "重启中（会走快登阶梯，只在前端记录失效时才要扫码）"
  systemctl restart qqours
  sleep 8
  systemctl is-active qqours; tail -5 "$BASE/boot.log" 2>/dev/null || true
else
  echo "  未启动。等机房恢复后：systemctl start qqours"
fi
