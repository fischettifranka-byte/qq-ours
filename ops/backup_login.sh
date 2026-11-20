#!/bin/bash
# 登录态快照：nt_data + login record 打包，保留最近 3 份。免扫码靠这个回滚。
set -u
BASE=/data/qq-ours
CFG=/home/qqrun/.config/QQ
SNAP="$BASE/login_snapshots"
mkdir -p "$SNAP"
chown qqrun:qqrun "$SNAP" 2>/dev/null || true
[ -d "$CFG" ] || { echo "no config dir"; exit 0; }
# 登录记录有效性判据：nt_qq_* 目录 + global 下有 mmkv 数据
if ! ls -d "$CFG"/nt_qq_* >/dev/null 2>&1; then echo "no nt_qq_* dir, skip"; exit 0; fi
TS=$(date +%Y%m%d-%H%M%S)
OUT="$SNAP/snap-$TS.tgz"
tar czf "$OUT" -C "$CFG" \
  --exclude='*/nt_temp' --exclude='*/nt_cache' --exclude='*/Cache' --exclude='*/temp' \
  --exclude='*/nt_data/Emoji' --exclude='*/nt_data/Pic' --exclude='*/nt_data/Video' \
  nt_qq_* global 2>/dev/null || true
if [ -s "$OUT" ]; then
  echo "snapshot $(du -h "$OUT" | cut -f1) -> $OUT"
  ls -1t "$SNAP"/snap-*.tgz 2>/dev/null | tail -n +4 | xargs -r rm -f
else
  rm -f "$OUT"; echo "snapshot failed (empty)"
fi
