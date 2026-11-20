#!/bin/bash
# Deploy the canonical source from this repo into the QQ install and
# (optionally) restart the endpoint.
#   ./deploy.sh           copy source only
#   ./deploy.sh restart   copy + restart
set -e
cd "$(dirname "$0")"
node --check src/qqours_main.js
cp src/qqours_main.js /opt/QQ/resources/app/qqours_main.js
python3 - <<PYEOF
import json
p = "/opt/QQ/resources/app/package.json"
d = json.load(open(p))
if d.get("main") != "./qqours_main.js":
    d["main"] = "./qqours_main.js"
    json.dump(d, open(p, "w"), indent=2)
    print("package.json main -> ./qqours_main.js")
else:
    print("package.json main already set")
PYEOF
node --check /opt/QQ/resources/app/qqours_main.js
echo "deployed OK"
if [ "$1" = "restart" ]; then
  pkill -u qqrun -f /opt/QQ/qq || true
  sleep 3
  ./ops/start.sh
fi
