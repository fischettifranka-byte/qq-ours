#!/usr/bin/env python3
# qqours bridge claimer: emit new owner DMs from inbox.jsonl, advancing a durable offset.
import json, os
BASE = "/data/qq-ours"
INBOX = os.path.join(BASE, "inbox.jsonl")
STATE = os.path.join(BASE, "bridge_state.json")
OWNER = "OWNER_UIN"
def load_state():
    try: return json.load(open(STATE))
    except Exception: return {"offset": None, "seen": []}
def save_state(st):
    tmp = STATE + ".tmp"
    json.dump(st, open(tmp, "w"))
    os.replace(tmp, STATE)
def main():
    st = load_state()
    size = os.path.getsize(INBOX) if os.path.exists(INBOX) else 0
    if st.get("offset") is None:
        st["offset"] = size
        st["seen"] = []
        save_state(st)
        print("[]")
        return
    off = st["offset"]
    if off > size: off = 0
    msgs = []
    seen = set(st.get("seen", []))
    newoff = off
    if os.path.exists(INBOX):
        with open(INBOX, "rb") as f:
            f.seek(off)
            data = f.read()
            newoff = off + len(data)
        for line in data.decode("utf-8", "replace").splitlines():
            line = line.strip()
            if not line: continue
            try: r = json.loads(line)
            except Exception: continue
            if r.get("src") != "recv": continue
            if r.get("chatType") != 1: continue
            if str(r.get("senderUin")) != OWNER: continue
            mid = r.get("msgId")
            if mid in seen: continue
            seen.add(mid)
            msgs.append({"msgId": mid, "time": r.get("time"), "peerUid": r.get("peerUid"), "text": r.get("text", "")})
    st["offset"] = newoff
    st["seen"] = list(seen)[-300:]
    save_state(st)
    print(json.dumps(msgs, ensure_ascii=False))
main()
