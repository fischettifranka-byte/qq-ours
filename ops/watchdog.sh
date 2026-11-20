#!/bin/bash
# QQ endpoint watchdog: relaunch if the process is gone. Kicked state is left
# for the Muse-side checker to report (needs a human re-scan decision).
if ! pgrep -u qqrun -f "/opt/QQ/qq" > /dev/null; then
  echo "[2026-11-20 02:58:18] process gone, relaunching" >> /data/qq-ours/watchdog.log
  rm -f /data/qq-ours/status.json
  su qqrun -c "nohup xvfb-run -a /opt/QQ/qq --no-sandbox > /data/qq-ours/run.log 2>&1 &"
fi
