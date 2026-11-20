#!/bin/bash
# Start the QQ endpoint (as qqrun under Xvfb). Safe to call when already
# running: it exits early if a qq process exists.
if pgrep -u qqrun -f "/opt/QQ/qq" > /dev/null; then
  echo "already running"
  exit 0
fi
rm -f /data/qq-ours/status.json
su qqrun -c "nohup xvfb-run -a /opt/QQ/qq --no-sandbox > /data/qq-ours/run.log 2>&1 &"
echo "started"
