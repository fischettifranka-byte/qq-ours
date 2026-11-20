#!/usr/bin/env python3
"""P1 patch: 免扫码登录阶梯 + 登录态快照 + 存在感伪装（状态随作息漂移）"""
import io, sys

SRC = "/root/workspace/qq-review/src/qqours_main.patched.js"
DST = "/root/workspace/qq-review/src/qqours_main.v2.js"
s = io.open(SRC, encoding="utf-8").read()
applied = []

def rep(old, new, tag):
    global s
    n = s.count(old)
    if n != 1:
        print("!! %s : expected 1 hit, got %d" % (tag, n)); sys.exit(2)
    s = s.replace(old, new); applied.append(tag)

# 1) 设备名可配置（伪装成普通桌面主机名）
rep('''  clientVer: clientVer, hostName: "ubuntu", externalVersion: false''',
    '''  clientVer: clientVer, hostName: DEV_NAME, externalVersion: false''',
    "1 initConfig hostName")

# 2) 设备信息里的 devName 同步
rep('''      deviceInfo: { guid: guid, buildVer: clientVer, localId: 2052, devName: "ubuntu", devType: "Linux", vendorName: "", osVer: os.release(), vendorOsName: "Linux", setMute: false, vendorType: 0 },''',
    '''      deviceInfo: { guid: guid, buildVer: clientVer, localId: 2052, devName: DEV_NAME, devType: "Linux", vendorName: "LENOVO", osVer: os.release(), vendorOsName: "Ubuntu", setMute: false, vendorType: 0 },''',
    "2 deviceInfo devName/vendor")

# 3) 顶部加 DEV_NAME 常量
rep('''const FILES_BASE = path.join(OUT, "files");''',
    '''const DEV_NAME = process.env.QQ_DEV_NAME || "ubuntu-desktop";
const FILES_BASE = path.join(OUT, "files");''',
    "3 DEV_NAME const")

# 4) 登录成功 -> 45s 后快照登录态（下次免扫码全靠它）
rep('''onQRCodeLoginSucceed: (res) => { if (loginDone) return; loginDone = true; selfInfo = res; log("LOGIN SUCCEED", JSON.stringify(res)); status({ phase: "login_succeed", result: res }); initSession(res); },''',
    '''onQRCodeLoginSucceed: (res) => { if (loginDone) return; loginDone = true; selfInfo = res; log("LOGIN SUCCEED", JSON.stringify(res)); status({ phase: "login_succeed", result: res }); initSession(res);
    setTimeout(() => { try { require("child_process").execFileSync("/bin/bash", ["/data/qq-ours/ops/backup_login.sh"], { encoding: "utf8" }); log("login snapshot saved"); } catch (e) { log("snapshot err", e.message); } }, 45000); },''',
    "4 snapshot on login")

# 5) 快速登录阶梯，替代"一看 isQuickLogin=false 就直接要人扫码"
old_quick = '''  const quick = list && list.LocalLoginInfoList && list.LocalLoginInfoList.find(x => x.isQuickLogin);
  if (quick) {
    log("try quick login uin", quick.uin);
    try {
      const r = await loginService.quickLoginWithUin(String(quick.uin));
      log("quickLoginWithUin ->", JSON.stringify(r).slice(0, 200));
    } catch (e) { log("quick login call err", e.message); }
    setTimeout(() => { if (!loginDone) { log("quick login timeout, fallback to QR"); try { loginService.getQRCodePicture(); } catch (e) {} } }, 20000);
  } else {
    log("no quick login entry, request QR");
    loginService.getQRCodePicture();
  }'''
new_quick = '''  const ql = (list && list.LocalLoginInfoList) || [];
  const cand = ql.find(x => x.isQuickLogin) || ql[0];
  if (cand) {
    log("quick login candidate uin", cand.uin, "isQuickLogin", !!cand.isQuickLogin);
    for (let attempt = 1; attempt <= 3 && !loginDone; attempt++) {
      try {
        const r = await loginService.quickLoginWithUin(String(cand.uin));
        log("quickLoginWithUin attempt", attempt, "->", JSON.stringify(r).slice(0, 200));
      } catch (e) { log("quick login call err", e.message); }
      for (let w = 0; w < 30 && !loginDone; w++) await new Promise(r => setTimeout(r, 1000));
      if (loginDone) break;
      log("quick login attempt", attempt, "no session");
      if (attempt === 2) {
        try {
          const out = require("child_process").execFileSync("/bin/bash", ["/data/qq-ours/ops/restore_login.sh"], { encoding: "utf8" });
          log("login snapshot restore:", String(out).trim().slice(0, 200));
        } catch (e) { log("restore err", e.message); }
      }
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000));
    }
  } else {
    log("no local login record at all");
  }
  if (!loginDone) {
    log("quick login exhausted -> need human scan");
    status({ phase: "need_scan", at: Date.now() });
    try { loginService.getQRCodePicture(); } catch (e) { log("qr err", e.message); }
  }'''
rep(old_quick, new_quick, "5 quick login ladder")

# 6) 在线状态随作息漂移（真实桌面用户不会 24h 恒定"在线"）
rep('''    status({ phase: "online", uin: selfInfo && selfInfo.uin, uid: selfInfo && selfInfo.uid });
    startSendQueue();''',
    '''    status({ phase: "online", uin: selfInfo && selfInfo.uin, uid: selfInfo && selfInfo.uid });
    startSendQueue();
    presenceLoop();''',
    "6 presence hook")

rep('''let groupService = null;''',
    '''// 存在感：按本地时间在 在线/离开/忙碌/勿扰 之间漂移，夜间以离开为主
function presenceLoop() {
  const tick = () => {
    const h = new Date().getHours();
    const night = h >= 1 && h < 8;
    const pool = night ? [30, 30, 30, 10] : [10, 10, 10, 30, 50, 60];
    const val = pool[Math.floor(Math.random() * pool.length)];
    try { if (msgService && msgService.setStatus) msgService.setStatus({ status: val, extStatus: 0, batteryStatus: 0 }); } catch (e) {}
    log("presence ->", val);
    setTimeout(tick, (8 + Math.random() * 22) * 60 * 1000);
  };
  setTimeout(tick, 60000 + Math.random() * 60000);
}
let groupService = null;''',
    "7 presenceLoop")

io.open(DST, "w", encoding="utf-8").write(s)
print("patched ->", DST)
for t in applied: print("  ok:", t)
