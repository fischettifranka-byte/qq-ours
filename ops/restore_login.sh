#!/bin/bash
# 快速登录失败时，把最近一份快照盖回去再试（进程必须已停止，脚本自行守护）
set -u
BASE=/data/qq-ours
CFG=/home/qqrun/.config/QQ
SNAP=$(ls -1t "$BASE"/login_snapshots/snap-*.tgz 2>/dev/null | head -1)
if [ -z "$SNAP" ]; then echo "no snapshot"; exit 1; fi
if pgrep -u qqrun -f "/opt/QQ/qq" >/dev/null; then echo "refuse: qq still running"; exit 1; fi
# 先把当前态留个底，再套用快照
CUR="$BASE/login_snapshots/before-restore-$(date +%Y%m%d-%H%M%S).tgz"
tar czf "$CUR" -C "$CFG" nt_qq_* global 2>/dev/null || true
tar xzf "$SNAP" -C "$CFG"
chown -R qqrun:qqrun "$CFG"
echo "restored $SNAP (prev saved: $CUR)"
