#!/bin/bash
# qqours watchdog v2 — 进程存活 + 登录态双判据（原来只查进程，卡在 qrcode/kicked 也无人知）
# 由 root cron 每 2 分钟调用：*/2 * * * * /data/qq-ours/ops/watchdog.sh
set -u
BASE=/data/qq-ours
ST="$BASE/status.json"
LOG="$BASE/watchdog.log"
ALERT="$BASE/alerts.jsonl"          # 需要人处理的告警，Muse 侧或人看这里
STUCK_QR=600                        # 二维码挂着超过 10 分钟算异常

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
alert() {
  log "ALERT $*"
  printf '{"at":%s,"kind":"%s","detail":"%s"}\n' "$(date +%s)" "$1" "$2" >> "$ALERT"
}

# 单实例锁：防止 cron 重叠 / 手工调用并发启动
exec 9>/run/qqours-watchdog.lock
flock -n 9 || exit 0

# 1) 进程层：systemd 负责拉起，这里只报告；RELAUNCH_ON_DEAD 存在时才兜底重启
if ! pgrep -u qqrun -f "/opt/QQ/qq" >/dev/null; then
  alert process_gone "process not running"
  if [ -f "$BASE/RELAUNCH_ON_DEAD" ]; then
    log "RELAUNCH_ON_DEAD set, relaunching"
    rm -f "$ST"
    su qqrun -c "TZ=Asia/Shanghai LANG=zh_CN.UTF-8 nohup xvfb-run -a -s '-screen 0 1920x1080x24 -dpi 96' /opt/QQ/qq > $BASE/run.log 2>&1 &"
  fi
  exit 0
fi

# 2) 登录态层
phase=$(python3 - <<'PY' 2>/dev/null
import json
try:
    print(json.load(open("/data/qq-ours/status.json")).get("phase", "none"))
except Exception:
    print("none")
PY
)
[ -n "$phase" ] || phase=none
age=$(( $(date +%s) - $(stat -c %Y "$ST" 2>/dev/null || echo 0) ))

case "$phase" in
  online)
    # 在线态超过 10 分钟没更新是正常的（没有 status 写入），此处只看是否被踢
    ;;
  qrcode)
    if [ "$age" -gt "$STUCK_QR" ]; then
      alert stuck_qrcode "phase=qrcode ${age}s, 需要扫码"
    fi
    ;;
  kicked)
    alert kicked "登录态被踢，需要人工重新扫码；进程不会自愈"
    ;;
  need_scan)
    alert need_scan "快登阶梯已用尽，等人工扫码 (age=${age}s)"
    ;;
  login_succeed|session_ok)
    if [ "$age" -gt "$STUCK_QR" ]; then
      alert stuck_session "phase=$phase ${age}s 未进入 online"
    fi
    ;;
  *)
    alert unhealthy "phase=$phase age=${age}s"
    ;;
esac
