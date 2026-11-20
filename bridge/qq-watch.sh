#!/usr/bin/env bash
# qqours bridge watch: poll the server claimer for new owner DMs.
# New owner messages -> merge into pending file and wake; none -> silent.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"
STATE_DIR="$HOME/hooks/state"
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/qq-watch.lock"
if ! flock -n 9; then
  exit 0
fi
touch "$STATE_DIR/qq-heartbeat"
OUT=$(ssh -i /home/SSH_USER/.ssh/id_ed25519 -o UserKnownHostsFile=/home/SSH_USER/.ssh/known_hosts -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=10 root@SERVER_HOST 'python3 /data/qq-ours/bridge/bridge_claim.py' 2>/dev/null || echo "")
PENDING="$STATE_DIR/qq-pending.json"
# merge: existing pending (if any) + new batch; wake whenever pending is non-empty
CNT=$(OUT="${OUT:-[]}" PENDING="$PENDING" python3 - <<'PYEOF'
import json, os
try: new = json.loads(os.environ["OUT"] or "[]")
except Exception: new = []
path = os.environ["PENDING"]
old = []
if os.path.exists(path):
    try: old = json.load(open(path))
    except Exception: old = []
merged = old + [m for m in new if m.get("msgId") not in {x.get("msgId") for x in old}]
tmp = path + ".tmp"
json.dump(merged, open(tmp, "w"), ensure_ascii=False)
os.replace(tmp, path)
print(len(merged))
PYEOF
)
if [ "${CNT:-0}" -gt 0 ]; then
  wake "new_qq_messages" "{\"count\":$CNT,\"pending_file\":\"$PENDING\"}"
else
  silent "no owner qq messages"
fi
