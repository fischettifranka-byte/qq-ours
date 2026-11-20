#!/bin/bash
# 优雅停止：先 SIGTERM 让 wrapper/mmkv 落盘，超时才 KILL；最后快照登录态
set -u
BASE=/data/qq-ours
PIDS=$(pgrep -u qqrun -f "/opt/QQ/qq" || true)
if [ -z "$PIDS" ]; then echo "not running"; bash "$BASE/ops/backup_login.sh"; exit 0; fi
kill -TERM $PIDS 2>/dev/null || true
for i in $(seq 1 40); do
  pgrep -u qqrun -f "/opt/QQ/qq" >/dev/null || break
  sleep 1
done
if pgrep -u qqrun -f "/opt/QQ/qq" >/dev/null; then
  echo "force kill after 40s"
  pkill -KILL -u qqrun -f "/opt/QQ/qq" || true
  sleep 2
fi
sync
sleep 1
bash "$BASE/ops/backup_login.sh"
echo "stopped"
