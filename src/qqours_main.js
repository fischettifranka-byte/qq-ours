// qqours v1 - our own QQ protocol endpoint (runs as QQ Electron main process)
// v0: wrapper load, engine/login/session init, QR login (+auto refresh), quick login
// v1: message receive listener -> inbox.jsonl ; send queue file -> sendMsg
const fs = require("fs");
const path = require("path");
const os = require("os");
const { makeServer: makeOneBot } = require("./onebot.js");
const OUT = "/data/qq-ours";
const LOGF = path.join(OUT, "boot.log");
const DEV_NAME = process.env.QQ_DEV_NAME || "ubuntu-desktop";
const FILES_BASE = path.join(OUT, "files");
const DEAD_LETTER = path.join(OUT, "dead_letter.jsonl");
// 运行时开关（config.json，可选）
let RUNTIME = { auto_download_image: true, rate_limit_per_min: 30 };
try { RUNTIME = Object.assign(RUNTIME, JSON.parse(fs.readFileSync(path.join(OUT, "config.json"), "utf8"))); } catch (e) {}
function rateOk() {
  const now = Date.now(), win = 60000;
  while (rateBucket.length && now - rateBucket[0] > win) rateBucket.shift();
  if (rateBucket.length >= (RUNTIME.rate_limit_per_min || 30)) return false;
  rateBucket.push(now); return true;
}
const rateBucket = [];
function log(...a) {
  const s = a.map(x => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch (e) { return String(x); } }).join(" ");
  try { fs.appendFileSync(LOGF, "[" + new Date().toISOString() + "] " + s + "\n"); } catch (e) {}
  console.log(s);
}
function status(obj) { try { fs.writeFileSync(path.join(OUT, "status.json"), JSON.stringify(obj, null, 2)); } catch (e) {} }

// ---- P0: queue cursor / path whitelist / dead letter ----
const queueCursors = new Map();
// append-only queue: consume by byte cursor, never truncate, keep half line for next round
function readNewLines(qf) {
  var st = queueCursors.get(qf);
  if (!st) { st = { off: 0 }; queueCursors.set(qf, st); }
  var fd;
  try { fd = fs.openSync(qf, "r"); } catch (e) { return []; }
  try {
    var size = fs.fstatSync(fd).size;
    if (size < st.off) st.off = 0;
    if (size === st.off) return [];
    var buf = Buffer.alloc(size - st.off);
    var got = 0;
    try { got = fs.readSync(fd, buf, 0, buf.length, st.off); } catch (e) { return []; }
    if (!got) return [];
    var nl = buf.lastIndexOf(String.fromCharCode(10));
    if (nl === -1) return [];
    var chunk = buf.slice(0, nl + 1);
    st.off += chunk.length;
    return chunk.toString("utf8").split(String.fromCharCode(10)).filter(function (x) { return x.trim(); });
  } finally { try { fs.closeSync(fd); } catch (e) {} }
}
function safePath(p) {
  try {
    if (!p) return null;
    var rp = fs.realpathSync(String(p));
    var base = fs.realpathSync(FILES_BASE);
    if (rp === base) return null;
    return rp.indexOf(base + path.sep) === 0 ? rp : null;
  } catch (e) { return null; }
}
function deadLetter(kind, job, err) {
  try {
    fs.appendFileSync(DEAD_LETTER, JSON.stringify({ at: Date.now(), kind: kind, job: job, err: String((err && err.message) || err) }) + String.fromCharCode(10));
  } catch (e) {}
}
process.on("uncaughtException", e => log("UNCAUGHT", (e && e.stack) || String(e)));
process.on("unhandledRejection", e => log("UNREJECT", (e && e.stack) || String(e)));

log("=== qqours v1 main start pid", process.pid);
let wrapper;
try {
  const m = { exports: {} };
  process.dlopen(m, "/opt/QQ/resources/app/wrapper.node");
  wrapper = m.exports;
  log("wrapper loaded ok");
} catch (e) {
  log("wrapper dlopen FAIL", e.message);
  status({ phase: "wrapper_fail", error: e.message });
  throw e;
}

const globalAdapter = {
  onLog: () => {}, onGetSrvCalTime: () => {}, onShowErrUITips: (...a) => log("ErrUITips", ...a),
  fixPicImgType: () => {}, getAppSetting: () => {}, onInstallFinished: () => {},
  onUpdateGeneralFlag: () => {}, onGetOfflineMsg: () => {}
};
const dependsAdapter = {
  onMSFStatusChange: (st, cr) => log("MSF status change", st, cr),
  onMSFSsoError: (c, d) => log("MSF sso error", c, d),
  getGroupCode: () => {}
};
const dispatcherAdapter = { dispatchRequest: () => {}, dispatchCall: () => {}, dispatchCallWithJson: () => {} };

let dataPath = "";
try { dataPath = wrapper.NodeQQNTWrapperUtil.getNTUserDataInfoConfig(); } catch (e) { log("getNTUserDataInfoConfig err", e.message); }
if (!dataPath || typeof dataPath !== "string") dataPath = path.join(os.homedir(), ".config", "QQ");
fs.mkdirSync(dataPath, { recursive: true });
const dataPathGlobal = path.join(dataPath, "global");
fs.mkdirSync(dataPathGlobal, { recursive: true });
log("dataPath", dataPath);

const pkg = JSON.parse(fs.readFileSync("/opt/QQ/resources/app/package.json", "utf8"));
const clientVer = pkg.version;
const buildVer = String(pkg.buildVersion || "54395");
const fullVer = clientVer.split("-")[0];
let appid = "537391511";
try { const a = pkg.appid; if (a) appid = String(a.linux || a.default || Object.values(a)[0]); } catch (e) {}
const qua = "V1_LNX_" + fullVer + "_" + buildVer + "_GW_B";
log("clientVer", clientVer, "appid", appid, "qua", qua);

const engine = wrapper.NodeIQQNTWrapperEngine.get();
engine.initWithDeskTopConfig({
  base_path_prefix: "", platform_type: 5, app_type: 4,
  app_version: clientVer, os_version: os.release(), use_xlog: false, qua: qua,
  global_path_config: { desktopGlobalPath: dataPathGlobal },
  thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 }
}, globalAdapter);
log("engine inited");

const loginService = wrapper.NodeIKernelLoginService.get();
loginService.initConfig({
  machineId: "", appid: appid, platVer: os.release(), commonPath: dataPathGlobal,
  clientVer: clientVer, hostName: DEV_NAME, externalVersion: false
});
log("login service inited");

let session = null, startupSession = null;
try { startupSession = wrapper.NodeIQQNTStartupSessionWrapper.create(); } catch (e) { log("startupSession err", e.message); }
try { session = wrapper.NodeIQQNTWrapperSession.getNTWrapperSession("nt_1"); }
catch (e) { try { session = wrapper.NodeIQQNTWrapperSession.create(); } catch (e2) { log("session create err", e2.message); } }
log("session ready:", !!session, "startup:", !!startupSession);

let selfInfo = null;
let msgService = null;

function elementToSegment(el) {
  const t = el && el.elementType;
  if (t === 1 && el.textElement) {
    const te = el.textElement;
    if (te.atType === 2 || te.atType === 1) return { type: "at", data: { qq: String(te.atUid || ""), name: String(te.content || "").replace(/^@/, "").trim() } };
    return { type: "text", data: { text: te.content || "" } };
  }
  if (t === 2 && el.picElement) { const p = el.picElement; return { type: "image", data: { file: p.fileName || "", url: p.originImageUrl || "", file_size: String(p.fileSize || ""), md5: p.md5HexStr || "" } }; }
  if (t === 3 && el.fileElement) { const f = el.fileElement; return { type: "file", data: { file: f.fileName || "", file_size: String(f.fileSize || ""), file_id: f.fileUuid || "" } }; }
  if (t === 4 && el.pttElement) { const p = el.pttElement; return { type: "record", data: { file: p.fileName || "", file_size: String(p.fileSize || ""), duration: Number(p.duration || 0) } }; }
  if (t === 5 && el.videoElement) { const v = el.videoElement; return { type: "video", data: { file: v.fileName || "", file_size: String(v.fileSize || ""), duration: Number(v.fileTime || 0) } }; }
  if (t === 6 && el.faceElement) return { type: "face", data: { id: String(el.faceElement.faceIndex || ""), text: el.faceElement.faceText || "" } };
  if (t === 7 && el.replyElement) return { type: "reply", data: { id: String(el.replyElement.replayMsgId || "") } };
  if (t === 8 && el.arkElement) return { type: "json", data: { data: el.arkElement.bytesData || "" } };
  if (t === 9) return { type: "mface", data: { summary: (el.faceElement && el.faceElement.faceText) || "" } };
  if (t === 10) return { type: "forward", data: { id: String((el.forwardElement && el.forwardElement.resId) || "") } };
  return { type: "unknown", data: { element_type: String(t) } };
}
function extractText(elements) {
  return (elements || []).map(el => {
    const t = el && el.elementType;
    if (t === 1 && el.textElement) return el.textElement.content || "";
    return "[" + elementToSegment(el).type + "]";
  }).join("");
}
function toOneBotSegments(elements) {
  const out = [];
  for (const el of elements || []) {
    const seg = elementToSegment(el);
    if (seg.type !== "unknown") out.push(seg);
  }
  return out;
}
const seenMsgIds = new Set();
const seenOrder = [];
function firstSeenMsgId(id) {
  const k = String(id || "");
  if (!k) return true;
  if (seenMsgIds.has(k)) return false;
  seenMsgIds.add(k); seenOrder.push(k);
  if (seenOrder.length > 3000) { const old = seenOrder.shift(); seenMsgIds.delete(old); }
  return true;
}
function recordMsg(src, m) {
  try {
    if (!firstSeenMsgId(m.msgId)) return;
    const rec = {
      src: src, time: Date.now(),
      msgId: m.msgId, msgSeq: m.msgSeq, msgTime: m.msgTime, clientSeq: m.clientSeq,
      chatType: m.chatType, peerUid: m.peerUid, peerUin: m.peerUin || "",
      senderUid: m.senderUid, senderUin: m.senderUin || "", sendNickName: m.sendNickName || "",
      text: extractText(m.elements),
      elements: (m.elements || []).map(el => {
        const o = { t: el.elementType, id: el.elementId || "" };
        if (el.elementType === 3 && el.fileElement) { o.fileName = el.fileElement.fileName; o.fileSize = el.fileElement.fileSize; o.fileUuid = el.fileElement.fileUuid; o.filePath = el.fileElement.filePath; }
        if (el.elementType === 2 && el.picElement) { o.fileName = el.picElement.fileName; o.fileUuid = el.picElement.fileUuid; o.originImageUrl = el.picElement.originImageUrl || ""; }
        return o;
      })
    };
    fs.appendFileSync(path.join(OUT, "inbox.jsonl"), JSON.stringify(rec) + "\n");
    log("MSG", src, "chatType", rec.chatType, "from", rec.senderUin || rec.senderUid, "text:", rec.text);
    if (src === "recv" || src === "s2c") {
      const isGroup = Number(m.chatType) === 2;
      pushEvent({
        time: Number(m.msgTime) || Math.floor(Date.now() / 1000),
        self_id: Number(selfInfo && selfInfo.uin) || 0,
        post_type: "message",
        message_type: isGroup ? "group" : "private",
        sub_type: "normal",
        message_id: m.msgId,
        group_id: isGroup ? (Number(m.peerUid) || 0) : undefined,
        user_id: Number(m.senderUin) || 0,
        sender: { user_id: Number(m.senderUin) || 0, nickname: m.sendNickName || "" },
        message: toOneBotSegments(m.elements),
        raw_message: rec.text,
        message_format: "array"
      });
      if (RUNTIME.auto_download_image) {
        for (const el of (m.elements || [])) {
          if (el.elementType !== 2) continue;
          try {
            msgService.downloadRichMedia({ fileModelId: "0", downSourceType: 0, downloadSourceType: 0, triggerType: 1, msgId: m.msgId, chatType: m.chatType, peerUid: m.peerUid, elementId: el.elementId, thumbSize: 0, downloadType: 1, filePath: "" });
            log("自动下载图片", m.msgId, el.elementId);
          } catch (e) { log("自动下载图片失败", e.message); }
        }
      }
    }
  } catch (e) { log("recordMsg err", e.message); }
}
function attachMsgService() {
  if (!session || msgService) return;
  try {
    msgService = session.getMsgService();
    const listener = {
      onRecvMsg: (msgs) => { for (const m of msgs || []) recordMsg("recv", m); },
      onGroupFileInfoUpdate: (arg) => { try {
        const items = (arg && arg.item) || [];
        const fileInfos = items.filter(x => x.fileInfo).map(x => x.fileInfo);
        if (fileInfos.length) { try { fs.writeFileSync(path.join(OUT, "group_file_raw.json"), JSON.stringify(fileInfos, null, 1)); } catch (e) {} }
        qlog({ q: "group_files_event", time: Date.now(), isEnd: !!(arg && arg.isEnd), items: items.map(it => it.folderInfo ? { kind: "folder", name: it.folderInfo.folderName, id: it.folderInfo.folderId, files: it.folderInfo.totalFileCount } : it.fileInfo ? { kind: "file", name: it.fileInfo.fileName, size: it.fileInfo.fileSize, id: it.fileInfo.fileId, uuid: it.fileInfo.fileUuid, uploader: it.fileInfo.uploaderUin, busId: it.fileInfo.busId } : { kind: "?" }) });
      } catch (e) {} },
      onMsgInfoListUpdate: (msgs) => { for (const m of msgs || []) recordMsg("update", m); },
      onRecvS2CMsg: (msgs) => { for (const m of msgs || []) recordMsg("s2c", m); },
      onRichMediaDownloadComplete: (arg) => { try { log("DL complete", JSON.stringify(arg)); if (arg && arg.filePath && fs.existsSync(arg.filePath)) { const dest = path.join(OUT, "files", "inbox"); fs.mkdirSync(dest, { recursive: true }); const d = path.join(dest, path.basename(arg.filePath)); fs.copyFileSync(arg.filePath, d); log("DL saved to", d); } } catch (e) { log("dl cb err", e.message); } },
      onMsgRecall: (...a) => log("msg recall", ...a),
      onKickedOffLine: (...a) => { log("KICKED OFFLINE", ...a); status({ phase: "kicked", at: Date.now() }); pushEvent({ time: Math.floor(Date.now() / 1000), self_id: Number(selfInfo && selfInfo.uin) || 0, post_type: "notice", notice_type: "offline", message: String(a && a[0] && a[0].tipsDesc || "kicked") }); }
    };
    msgService.addKernelMsgListener(listener);
    log("msg listener attached");
    attachGroupService();
    try {
      const ss = session.getSearchService();
      ss.addKernelSearchListener({
        onSearchGroupResult: (params) => { try { qlog({ q: "search_group_result", time: Date.now(), raw: JSON.stringify(params || {}).slice(0, 1500) }); } catch (e) {} },
        onSearchStrangerResult: (params) => { try { qlog({ q: "search_stranger_result", time: Date.now(), raw: JSON.stringify(params || {}).slice(0, 1200) }); } catch (e) {} }, onSearchLocalInfoResult: () => {}, onSearchFileKeywordsResult: () => {}, onSearchMsgKeywordsResult: () => {}
      });
      log("search listener attached");
    } catch (e) { log("search listener err", e.message); }
    status({ phase: "online", uin: selfInfo && selfInfo.uin, uid: selfInfo && selfInfo.uid });
    startSendQueue();
    presenceLoop();
    startOneBot();
  } catch (e) { log("attachMsgService err", (e && e.stack) || String(e)); }
}
// 存在感：按本地时间在 在线/离开/忙碌/勿扰 之间漂移，夜间以离开为主
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
let groupService = null;
function qlog(obj) { try { fs.appendFileSync(path.join(OUT, "query_results.jsonl"), JSON.stringify(obj) + "\n"); } catch (e) {} log("QUERY", obj.q, obj.error || (obj.groups ? obj.groups.length + " groups" : obj.count != null ? obj.count + " members" : "ok")); }
function attachGroupService() {
  if (!session || groupService) return;
  try {
    groupService = session.getGroupService();
    const gl = {
      onGroupListUpdate: (updateType, groupList) => { const arr = (groupList || []).map(g => ({ group_id: Number(g.groupCode) || 0, group_name: g.groupName || "", member_count: Number(g.memberCount) || 0, max_member_count: Number(g.maxMemberCount || g.maxMemberNum || 0) || 0 })); lastGroupList = arr; qlog({ q: "group_list", time: Date.now(), updateType: updateType, groups: (groupList || []).map(g => ({ groupCode: g.groupCode, groupName: g.groupName, memberCount: g.memberCount, maxMemberCount: g.maxMemberCount, ownerUid: g.ownerUid })) }); if (groupListWaiter) { const w = groupListWaiter; groupListWaiter = null; w(arr); } },
      onMemberListChange: () => {}, onMemberInfoChange: () => {}, onSearchMemberChange: () => {},
      onShutUpMemberListChanged: () => {}, onGroupDetailInfoUpdate: () => {}, onGroupExtListUpdate: () => {},
      onGroupBulletinUpdate: () => {}, onGroupAdminListUpdate: () => {}, onGroupMemberMaxNumUpdate: () => {},
      onGroupSimpleInfoUpdate: () => {}, onJoinGroupResult: () => {}, onQuitGroupResult: () => {},
      onGroupNotifiesUpdated: (doubt, notifies) => {
        for (const n of (notifies || [])) {
          try {
            const rec = { time: Date.now(), seq: n.seq, type: n.type, status: n.status, groupCode: n.group && n.group.groupCode, groupName: n.group && n.group.groupName, user1: n.user1, user2: n.user2, postscript: n.postscript || "" };
            fs.appendFileSync(path.join(OUT, "group_notifies.jsonl"), JSON.stringify(rec) + "\n");
            if ((n.type === 5 || n.type === 7) && (n.status === 1 || n.status === "1")) {
              fs.appendFileSync(path.join(OUT, "pending_approvals.jsonl"), JSON.stringify(Object.assign({ kind: "group_join" }, rec)) + "\n");
            }
          } catch (e) {}
        }
      },
      onGroupSingleScreenNotifies: () => {}
    };
    groupService.addKernelGroupListener(gl);
    log("group listener attached");
    attachBuddyService();
    attachProfileService();
    startQueryQueue();
  } catch (e) { log("attachGroupService err", (e && e.stack) || String(e)); }
}
let buddyService = null;
function attachBuddyService() {
  if (!session || buddyService) return;
  try {
    buddyService = session.getBuddyService();
    buddyService.addKernelBuddyListener({
      onBuddyReqChange: (arg) => { try { qlog({ q: "buddy_reqs", time: Date.now(), notify: JSON.parse(JSON.stringify(arg)) }); } catch (e) { log("buddyReqChange ser err", e.message); }
        try {
          const reqs = (arg && arg.buddyReqs) || [];
          const pf = path.join(OUT, "pending_approvals.jsonl");
          let existing = "";
          try { existing = fs.readFileSync(pf, "utf8"); } catch (e) {}
          for (const r of reqs) {
            if (r.isDecide || r.isAgreed) continue;
            const key = String(r.friendUid);
            if (existing.includes(key)) continue;
            fs.appendFileSync(pf, JSON.stringify({ kind: "buddy_req", time: Date.now(), friendUid: r.friendUid, friendNick: r.friendNick || "", reqTime: r.reqTime, addSource: r.addSource }) + String.fromCharCode(10));
          }
        } catch (e) {} },
      onBuddyListChange: () => {}, onBuddyListChangedV2: () => {}, onBuddyRemarkUpdated: () => {},
      onBuddyReqUnreadCntChange: () => {}, onDoubtBuddyReqChange: () => {}, onCheckBuddySettingResult: () => {}, onDelBatchBuddyInfos: () => {}
    });
    log("buddy listener attached");
  } catch (e) { log("attachBuddyService err", (e && e.stack) || String(e)); }
}
let profileService = null;
const profileWaiters = new Map();
function attachProfileService() {
  if (!session || profileService) return;
  try {
    profileService = session.getProfileService();
    profileService.addKernelProfileListener({
      onUserDetailInfoChanged: (arg) => { try { const w = arg && profileWaiters.get(arg.uid); if (w) { profileWaiters.delete(arg.uid); w(arg); } } catch (e) {} },
      onProfileDetailInfoChanged: () => {}, onProfileSimpleChanged: () => {}, onGroupDetailInfoChange: () => {}
    });
    log("profile listener attached");
  try {
    session.getFileAssistantService().addKernelFileAssistantListener({
      onFileListChanged: (...args) => {
        try {
          const items = (args && args[2]) || [];
          qlog({ q: "fa_list_event", time: Date.now(), page: args && args[0], count: items.length, items: items.map(it => ({ id: it.id, name: it.fileName, size: it.fileSize, status: it.fileStatus, path: it.filePath || "" })) });
        } catch (e) {}
      },
      onFileStatusChanged: (st) => {
        try { qlog({ q: "fa_status_event", time: Date.now(), raw: JSON.stringify(st || {}).slice(0, 600) }); } catch (e) {}
      },
      onSessionListChanged: () => {},
      onSessionChanged: () => {},
      onFileSearch: () => {}
    });
    log("file assistant listener attached");
  } catch (e) { log("fa listener err", e.message); }
  try {
    const hookCfgPath = path.join(OUT, "hook.json");
    if (fs.existsSync(hookCfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(hookCfgPath, "utf8"));
      fs.unlinkSync(hookCfgPath);
      const holder = { exports: {} };
      process.dlopen(holder, path.join(OUT, "tools", "napi2native.linux.x64.node"), 1);
      const ex = holder.exports;
      log("napi2native loaded, exports:", Object.keys(ex).join(","));
      if (typeof ex.setVerbose === "function") { try { ex.setVerbose(true); } catch (e) {} }
      const ok = ex.initHook(cfg.send, cfg.recv);
      log("initHook ->", ok, "send", cfg.send, "recv", cfg.recv);
    }
  } catch (e) { log("hook init err", e.message); }
  } catch (e) { log("attachProfileService err", (e && e.stack) || String(e)); }
}
function fetchProfile(uid, timeoutMs) {
  return new Promise((resolve) => {
    const to = setTimeout(() => { profileWaiters.delete(uid); resolve(null); }, timeoutMs || 5000);
    profileWaiters.set(uid, (arg) => { clearTimeout(to); resolve(arg); });
    try { profileService.fetchUserDetailInfo("BuddyProfileStore", [uid], 1, [0]); } catch (e) { clearTimeout(to); profileWaiters.delete(uid); resolve(null); }
  });
}
let queryRunning = false;
let _ecdhSvc = null;
function getECDH() {
  if (_ecdhSvc) return _ecdhSvc;
  const svc = wrapper.NodeIQQNTWrapperEngine.get().getECDHService();
  try { svc.setGuid(loginService.getMachineGuid()); } catch (e) {}
  _ecdhSvc = svc;
  return svc;
}
function pokePayload(targetUin, groupUin) {
  const enc = (field, val) => { const bytes = [field << 3]; let v = val; do { let b = v % 128; v = Math.floor(v / 128); if (v) b += 128; bytes.push(b); } while (v); return bytes; };
  let bytes = [].concat(enc(1, Number(targetUin)));
  if (groupUin) bytes = bytes.concat(enc(2, Number(groupUin)));
  else bytes = bytes.concat(enc(5, Number(targetUin)));
  bytes = bytes.concat(enc(6, 0));
  return Buffer.from(bytes).toString("hex");
}
async function doPoke(targetUin, groupUin, serviceType) {
  const hex = pokePayload(targetUin, groupUin);
  const r = await getECDH().sendOIDBRequest(2371, Number(serviceType || 0), 1, hex, null);
  let out = "";
  try { out = r instanceof Uint8Array ? Buffer.from(r).toString("hex").slice(0, 200) : JSON.stringify(r).slice(0, 300); } catch (e) { out = String(r); }
  return out;
}
async function qunPskey() {
  const r = await session.getTipOffService().getPskey(["qun.qq.com"], true);
  const m = r && r.domainPskeyMap;
  if (m instanceof Map) return m.get("qun.qq.com");
  return m && m["qun.qq.com"];
}
async function qzoneAuth() {
  const r = await session.getTipOffService().getPskey(["qzone.qq.com"], true);
  const m = r && r.domainPskeyMap;
  const pk = m instanceof Map ? m.get("qzone.qq.com") : (m && m["qzone.qq.com"]);
  let gtk = 5381;
  const key = pk || "";
  for (let i = 0; i < key.length; i++) gtk += (gtk << 5) + key.charCodeAt(i);
  return { pk: pk, gtk: gtk & 0x7fffffff };
}
function startQueryQueue() {
  if (queryRunning) return;
  queryRunning = true;
  const qf = path.join(OUT, "query_queue.jsonl");
  setInterval(async () => {
    try {
      const lines = readNewLines(qf);
      if (!lines.length) return;
      for (const line of lines) {
        try {
          const job = JSON.parse(line);
          if (job.q === "group_list") {
            await groupService.getGroupList(false);
          } else if (job.q === "profile_probe") {
            const info = await fetchProfile(job.uid);
            qlog({ q: "profile_probe", time: Date.now(), uid: job.uid, raw: info ? JSON.parse(JSON.stringify(info)) : null });
          } else if (job.q === "buddy_list") {
            const r = await buddyService.getBuddyListV2("qqours", false, 0);
            const cats = (r && r.data) || [];
            const out = [];
            let profileService = null;
            try { profileService = session.getProfileService(); } catch (e) {}
            for (const c of cats) {
              for (const uid of (c.buddyUids || [])) {
                const item = { uid: uid, category: c.categroyName };
                if (profileService) {
                  const info = await fetchProfile(uid);
                  if (info) {
                    item.uin = info.uin || "";
                    const ci = (info.simpleInfo && info.simpleInfo.coreInfo) || {};
                    item.nick = ci.nick || "";
                    item.remark = ci.remark || "";
                  }
                }
                out.push(item);
              }
            }
            qlog({ q: "buddy_list", time: Date.now(), count: out.length, buddies: out });
          } else if (job.q === "buddy_reqs") {
            await buddyService.getBuddyReq();
            log("buddy reqs requested (listener will record)");
          } else if (job.q === "profile_uin") {
            const info = await profileService.getUserDetailInfoByUin(String(job.uin));
            qlog({ q: "profile_uin", time: Date.now(), uin: String(job.uin), raw: JSON.parse(JSON.stringify(info || {})) });
          } else if (job.q === "profile_like") {
            const svc = session.getProfileLikeService();
            const r = await svc.setBuddyProfileLike({ friendUid: job.uid, sourceId: 71, doLikeCount: Number(job.count || 1), doLikeTollCount: 0 });
            qlog({ q: "profile_like", time: Date.now(), uid: job.uid, count: Number(job.count || 1), res: r });
          } else if (job.q === "profile_like_get") {
            const svc = session.getProfileLikeService();
            const r = await svc.getBuddyProfileLike({ friendUids: [job.uid], basic: 1, vote: 1, favorite: 0, userProfile: 1, type: job.type != null ? job.type : 1, start: 0, limit: 20 });
            qlog({ q: "profile_like_get", time: Date.now(), uid: job.uid, raw: JSON.parse(JSON.stringify(r || {})) });
          } else if (job.q === "set_longnick") {
            const r = await profileService.setLongNick(job.text || "");
            qlog({ q: "set_longnick", time: Date.now(), text: job.text || "", res: r || "void" });
          } else if (job.q === "member_mute") {
            const r = await groupService.setMemberShutUp(String(job.groupCode), [{ uid: job.uid, timeStamp: Number(job.seconds || 0) }]);
            qlog({ q: "member_mute", time: Date.now(), groupCode: String(job.groupCode), uid: job.uid, seconds: Number(job.seconds || 0), res: r });
          } else if (job.q === "member_kick") {
            const r = await groupService.kickMember(String(job.groupCode), [job.uid], !!job.refuseForever, job.reason || "");
            qlog({ q: "member_kick", time: Date.now(), groupCode: String(job.groupCode), uid: job.uid, res: r || "void" });
          } else if (job.q === "group_shutup_all") {
            const r = await groupService.setGroupShutUp(String(job.group), !!job.shut);
            qlog({ q: "group_shutup_all", time: Date.now(), group: String(job.group), shut: !!job.shut, res: r });
          } else if (job.q === "member_role") {
            groupService.modifyMemberRole(String(job.group), job.uid, Number(job.role));
            qlog({ q: "member_role", time: Date.now(), group: String(job.group), uid: job.uid, role: Number(job.role), done: true });
          } else if (job.q === "member_card") {
            groupService.modifyMemberCardName(String(job.groupCode), job.uid, job.card || "");
            qlog({ q: "member_card", time: Date.now(), groupCode: String(job.groupCode), uid: job.uid, card: job.card || "", done: true });
          } else if (job.q === "buddy_approve") {
            await buddyService.approvalFriendRequest({ friendUid: job.friendUid, reqTime: String(job.reqTime), accept: !!job.accept });
            qlog({ q: "buddy_approve", time: Date.now(), friendUid: job.friendUid, accept: !!job.accept, done: true });
          } else if (job.q === "group_req_approve") {
            await groupService.operateSysNotify(false, { operateType: job.accept ? 1 : 2, targetMsg: { seq: String(job.seq), type: Number(job.type), groupCode: String(job.group), postscript: " " } });
            qlog({ q: "group_req_approve", time: Date.now(), seq: String(job.seq), accept: !!job.accept, done: true });
          } else if (job.q === "group_notify_count") {
            const r = await groupService.getGroupNotifiesUnreadCount(false);
            qlog({ q: "group_notify_count", time: Date.now(), res: r });
          } else if (job.q === "bulletin_publish") {
            const pk = await qunPskey();
            const r = await groupService.publishGroupBulletin(String(job.group), pk, { text: encodeURI(job.text || ""), oldFeedsId: "", pinned: 0, confirmRequired: 0 });
            qlog({ q: "bulletin_publish", time: Date.now(), group: String(job.group), res: r });
          } else if (job.q === "essence_list") {
            const pk = await qunPskey();
            const r = await groupService.fetchGroupEssenceList({ groupCode: String(job.group), pageStart: 0, pageLimit: 50 }, pk);
            qlog({ q: "essence_list", time: Date.now(), group: String(job.group), raw: JSON.parse(JSON.stringify(r || {})).toString().slice(0, 200) , keys: r ? Object.keys(r) : [] });
          } else if (job.q === "essence_add") {
            const md = await msgService.getMsgsIncludeSelf({ chatType: 2, guildId: "", peerUid: String(job.group) }, String(job.msgId), 1, false);
            const m0 = md && md.msgList && md.msgList[0];
            if (!m0) { qlog({ q: "essence_add", error: "msg not found" }); }
            else {
              const r = await groupService.addGroupEssence({ groupCode: String(job.group), msgRandom: parseInt(m0.msgRandom), msgSeq: parseInt(m0.msgSeq) });
              qlog({ q: "essence_add", time: Date.now(), group: String(job.group), msgId: String(job.msgId), res: r });
            }
          } else if (job.q === "msg_probe") {
            const md = await msgService.getMsgsIncludeSelf({ chatType: job.chatType || 2, guildId: "", peerUid: String(job.peer) }, String(job.msgId), 1, false);
            const m0 = md && md.msgList && md.msgList[0];
            qlog({ q: "msg_probe", found: !!m0, msgId: m0 && m0.msgId, msgSeq: m0 && m0.msgSeq, msgRandom: m0 && m0.msgRandom, senderUin: m0 && m0.senderUin });
          } else if (job.q === "set_avatar") {
            const r = await profileService.setHeader(job.path);
            qlog({ q: "set_avatar", time: Date.now(), res: r });
          } else if (job.q === "set_status") {
            const arg = { status: Number(job.status || 10), extStatus: Number(job.extStatus || 0), batteryStatus: 0 };
            if (job.wording) arg.customStatus = { faceId: "0", wording: job.wording, faceType: "0" };
            const r = await msgService.setStatus(arg);
            qlog({ q: "set_status", time: Date.now(), status: arg.status, res: r });
          } else if (job.q === "collection_list") {
            const svc = session.getCollectionService();
            const r = await svc.getCollectionItemList({ category: 0, groupId: 0, forceSync: false, forceFromDb: false, timeStamp: "0", count: 20, searchDown: false });
            const items = (r && r.collectionSearchList && r.collectionSearchList.collectionItemList) || [];
            qlog({ q: "collection_list", time: Date.now(), count: items.length, items: items.map(it => ({ cid: it.cid, type: it.type, author: it.author && it.author.strId, brief: it.brief || it.title || "" })) });
          } else if (job.q === "search_group") {
            const svc = session.getSearchService();
            const r = await svc.searchGroup({ keyWords: job.keyword || "", groupNum: 10, exactSearch: false, penetrate: "" });
            qlog({ q: "search_group", time: Date.now(), keyword: job.keyword || "", raw: JSON.stringify(r || {}).slice(0, 800) });
          } else if (job.q === "search_stranger") {
            const svc = session.getSearchService();
            const r = await svc.searchStranger(job.keyword || "", job.searchType != null ? job.searchType : 0, job.searchParams || {});
            qlog({ q: "search_stranger", time: Date.now(), keyword: job.keyword || "", raw: JSON.stringify(r || {}).slice(0, 800) });
          } else if (job.q === "history") {
            const peer = { chatType: job.chatType || 1, peerUid: String(job.peerUid), guildId: "" };
            let anchor = job.msgId ? String(job.msgId) : "";
            if (!anchor) {
              try {
                const lines = fs.readFileSync(path.join(OUT, "inbox.jsonl"), "utf8").split(String.fromCharCode(10)).filter(x => x.trim());
                for (let i = lines.length - 1; i >= 0; i--) {
                  const rec = JSON.parse(lines[i]);
                  if (rec.peerUid === String(job.peerUid) && rec.msgId) { anchor = rec.msgId; break; }
                }
              } catch (e) {}
            }
            const r = await msgService.getMsgsIncludeSelf(peer, anchor, Number(job.count || 10), true);
            const list = (r && r.msgList) || [];
            qlog({ q: "history", time: Date.now(), peerUid: String(job.peerUid), count: list.length, msgs: list.map(m => ({ msgId: m.msgId, senderUin: m.senderUin, text: (m.elements || []).map(e => (e.textElement && e.textElement.content) || ("[t" + e.elementType + "]")).join("") })) });
          } else if (job.q === "qzone_list") {
            const auth = await qzoneAuth();
            const target = String(job.uin || (selfInfo && selfInfo.uin) || "");
            const url = "https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?uin=" + target + "&ftype=0&sort=0&pos=0&num=" + Number(job.num || 10) + "&replynum=0&g_tk=" + auth.gtk + "&code_version=1&format=jsonp&need_private_comment=1";
            const resp = await fetch(url, { headers: { Cookie: "uin=o" + target + "; p_uin=o" + target + "; p_skey=" + auth.pk, Referer: "https://user.qzone.qq.com/" + target } });
            const txt = await resp.text();
            let data = null;
            try { data = JSON.parse(txt.replace(/^_Callback\(/, "").replace(/\);?$/, "")); } catch (e) {}
            const list = (data && data.msglist) || [];
            qlog({ q: "qzone_list", time: Date.now(), uin: target, code: data && data.code, count: list.length, msgs: list.map(m => ({ tid: m.tid, time: m.created_time, content: String(m.content || "").slice(0, 60), cmtnum: m.cmtnum })) });
          } else if (job.q === "qzone_like") {
            const auth = await qzoneAuth();
            const self = String((selfInfo && selfInfo.uin) || "");
            const target = String(job.uin || "");
            const body = new URLSearchParams({ qzreferrer: "https://user.qzone.qq.com/" + target, opuin: self, unikey: "http://user.qzone.qq.com/" + target + "/mood/" + job.tid + ".1", liketype: "0", active: job.cancel ? "1" : "0", appid: "311", blogtype: "0", paramstring: "tl", format: "json" });
            const resp = await fetch("https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=" + auth.gtk, { method: "POST", headers: { Cookie: "uin=o" + self + "; p_uin=o" + self + "; p_skey=" + auth.pk, "Content-Type": "application/x-www-form-urlencoded", Referer: "https://user.qzone.qq.com/" + target }, body: body.toString() });
            const txt = await resp.text();
            qlog({ q: "qzone_like", time: Date.now(), uin: target, tid: job.tid, raw: txt.slice(0, 200) });
          } else if (job.q === "group_files") {
            const svc = session.getRichMediaService();
            await svc.getGroupFileList(String(job.group), { sortType: 1, fileCount: Number(job.count || 50), startIndex: 0, sortOrder: 2, showOnlinedocFolder: 0 });
            qlog({ q: "group_files", time: Date.now(), group: String(job.group), note: "requested; results arrive as group_files_event" });
          } else if (job.q === "group_file_download") {
            const svc = session.getRichMediaService();
            const peer = { chatType: 2, peerUid: String(job.group), guildId: "" };
            const info = { fileId: job.fileId, fileName: job.fileName || "", fileSize: String(job.fileSize || "0"), fileModelId: String(job.fileModelId || "0") };
            const r = await svc.downloadFileForFileUuid(peer, job.fileId, [info]);
            qlog({ q: "group_file_download", time: Date.now(), group: String(job.group), fileId: job.fileId, raw: JSON.stringify(r || {}).slice(0, 300) });
          } else if (job.q === "group_file_download2") {
            const svc = session.getRichMediaService();
            const r = await svc.downloadFileForFileInfo([job.info], job.savePath || "/data/qq-ours/files/inbox/");
            qlog({ q: "group_file_download2", time: Date.now(), raw: JSON.stringify(r || {}).slice(0, 200) });
          } else if (job.q === "group_file_download3") {
            const svc = session.getRichMediaService();
            const peer = { chatType: 2, peerUid: String(job.group), guildId: "" };
            const r = await svc.downloadFileForModelId(peer, [String(job.fileModelId)], "");
            qlog({ q: "group_file_download3", time: Date.now(), group: String(job.group), fileModelId: String(job.fileModelId), raw: JSON.stringify(r || {}).slice(0, 200) });
          } else if (job.q === "group_file_info") {
            const svc = session.getRichMediaService();
            const r = await svc.getGroupFileInfo(String(job.group), job.fileId);
            qlog({ q: "group_file_info", time: Date.now(), group: String(job.group), fileId: job.fileId, raw: JSON.stringify(r || {}).slice(0, 900) });
          } else if (job.q === "group_file_trans") {
            const svc = session.getRichMediaService();
            const r = await svc.transGroupFile(String(job.group), job.fileId);
            qlog({ q: "group_file_trans", time: Date.now(), group: String(job.group), fileId: job.fileId, raw: JSON.stringify(r || {}).slice(0, 500) });
          } else if (job.q === "fa_list") {
            const svc = session.getFileAssistantService();
            const r = await svc.getFileAssistantList(...(job.args || []));
            qlog({ q: "fa_list", time: Date.now(), raw: JSON.stringify(r || {}).slice(0, 900) });
          } else if (job.q === "fa_download") {
            const svc = session.getFileAssistantService();
            const r = await svc.downloadFile(job.fileIds || []);
            qlog({ q: "fa_download", time: Date.now(), raw: JSON.stringify(r || {}).slice(0, 300) });
          } else if (job.q === "group_file_onlydl") {
            const svc = session.getRichMediaService();
            const peer = { chatType: 2, peerUid: String(job.group), guildId: "" };
            const r = await svc.onlyDownloadFile(peer, job.fileId, [job.info]);
            qlog({ q: "group_file_onlydl", time: Date.now(), raw: JSON.stringify(r || {}).slice(0, 300) });
          } else if (job.q === "group_transfer_list") {
            const svc = session.getRichMediaService();
            const r = await svc.getGroupTransferList(String(job.group), job.arg !== undefined ? job.arg : {});
            qlog({ q: "group_transfer_list", time: Date.now(), raw: JSON.stringify(r || {}).slice(0, 700) });
          } else if (job.q === "group_space") {
            const svc = session.getRichMediaService();
            const r = await svc.getGroupSpace(String(job.group));
            qlog({ q: "group_space", time: Date.now(), raw: JSON.stringify(r || {}).slice(0, 400) });
          } else if (job.q === "rich_dir") {
            const svc = session.getRichMediaService();
            const r = await svc.getRichMediaFileDir();
            qlog({ q: "rich_dir", time: Date.now(), raw: JSON.stringify(r || {}).slice(0, 400) });
          } else if (job.q === "oidb_send") {
            const svc = getECDH();
            const r = await svc.sendOIDBRequest(Number(job.cmd), Number(job.serviceType || 0), Number(job.subCmd || 1), job.dataHex || "", job.extra !== undefined ? job.extra : null);
            let out = "";
            try { out = r instanceof Uint8Array ? Buffer.from(r).toString("hex").slice(0, 200) : JSON.stringify(r).slice(0, 300); } catch (e) { out = String(r); }
            qlog({ q: "oidb_send", time: Date.now(), cmd: job.cmd, res: out });
          } else if (job.q === "poke") {
            const out = await doPoke(job.targetUin, job.groupUin, job.serviceType);
            qlog({ q: "poke", time: Date.now(), target: job.targetUin, group: job.groupUin || "", res: out });
          } else if (job.q === "svc_probe2") {
            const dump = (o) => { const names = new Set(); let x = o; for (let d = 0; x && d < 4; d++) { Object.getOwnPropertyNames(x).forEach(n => names.add(n)); x = Object.getPrototypeOf(x); } return [...names]; };
            qlog({ q: "svc_probe2",
              login: dump(loginService).filter(n => /ecdh|oidb|sso/i.test(n)),
              sessionStatics: Object.getOwnPropertyNames(Object.getPrototypeOf(session).constructor || {}),
              engine: (() => { try { const e = wrapper.NodeIQQNTWrapperEngine.get(); return dump(e).filter(n => /ecdh|service/i.test(n)).slice(0, 40); } catch (err) { return "err:" + err.message; } })()
            });
          } else if (job.q === "sso_send") {
            const svc = getECDH();
            const r = await svc.sendSSORequest(job.cmdStr, Number(job.serviceType || 0), job.dataHex || "", job.extra !== undefined ? job.extra : null);
            let out = "";
            try { out = r instanceof Uint8Array ? Buffer.from(r).toString("hex").slice(0, 200) : JSON.stringify(r).slice(0, 300); } catch (e) { out = String(r); }
            qlog({ q: "sso_send", time: Date.now(), cmdStr: job.cmdStr, res: out });
          } else if (job.q === "oidb_v2") {
            const svc = getECDH();
            const r = await svc.sendOIDBRequestV2(Number(job.cmd), Number(job.serviceType || 0), Number(job.subCmd || 1), job.dataHex || "", job.extra !== undefined ? job.extra : null);
            let out = "";
            try { out = r instanceof Uint8Array ? Buffer.from(r).toString("hex").slice(0, 200) : JSON.stringify(r).slice(0, 300); } catch (e) { out = String(r); }
            qlog({ q: "oidb_v2", time: Date.now(), cmd: job.cmd, res: out });
          } else if (job.q === "msso_send") {
            const ms = session.getMsgService();
            let param = job.dataHex || "";
            if (job.mode === "bytes") param = new Uint8Array(Buffer.from(job.dataHex || "", "hex"));
            else if (job.mode === "raw") param = job.raw;
            else if (job.mode === "latin1") param = Buffer.from(job.dataHex || "", "hex").toString("latin1");
            else if (job.mode === "buffer") param = Buffer.from(job.dataHex || "", "hex");
            else if (job.mode === "json") param = JSON.stringify(job.raw);
            else if (job.mode === "base64") param = Buffer.from(job.dataHex || "", "hex").toString("base64");
            const r = await ms.sendSsoCmdReqByContend(job.cmdStr, param);
            let out = "";
            try { out = r instanceof Uint8Array ? Buffer.from(r).toString("hex").slice(0, 300) : JSON.stringify(r).slice(0, 300); } catch (e) { out = String(r); }
            qlog({ q: "msso_send", time: Date.now(), cmdStr: job.cmdStr, mode: job.mode || "hex", res: out });
          } else if (job.q === "unify_probe") {
            const us = session.getUnifySearchService();
            const names = new Set();
            let o = us;
            for (let d = 0; o && d < 4; d++) { Object.getOwnPropertyNames(o).forEach(n => names.add(n)); o = Object.getPrototypeOf(o); }
            qlog({ q: "unify_probe", methods: [...names].filter(n => typeof us[n] === "function") });
          } else if (job.q === "unify_search") {
            const us = session.getUnifySearchService();
            const fn = job.method || "search";
            const r = await us[fn](job.arg);
            let digest = null;
            try {
              const groups = (r && r.rsp && r.rsp.itemGroups) || [];
              digest = groups.map(g => ({ group: g.groupName, mask: g.groupMask, items: (g.resultItems || []).slice(0, 6).map(it => ({ name: String(it.name || "").replace(/<[^>]*>/g, ""), id: it.resultId || "", jmp: String(it.jmpUrl || "").slice(0, 80) })) }));
            } catch (e) {}
            qlog({ q: "unify_search", time: Date.now(), method: fn, errCode: r && r.errCode, digest: digest, raw: digest ? undefined : String(JSON.stringify(r)).slice(0, 300) });
          } else if (job.q === "rich_probe") {
            const dump = (o) => { const names = new Set(); let x = o; for (let d = 0; x && d < 4; d++) { Object.getOwnPropertyNames(x).forEach(n => names.add(n)); x = Object.getPrototypeOf(x); } return [...names].filter(n => typeof o[n] === "function"); };
            const rich = session.getRichMediaService();
            let flash = null;
            try { flash = session.getFlashTransferService(); } catch (e) {}
            qlog({ q: "rich_probe", rich: dump(rich).filter(n => /file|download|group/i.test(n)), flash: flash ? dump(flash) : "unavailable" });
          } else if (job.q === "group_members") {
            const r = await groupService.getAllMemberList(String(job.groupCode), job.force === false ? false : true);
            const infos = (r && r.result && r.result.infos) || (r && r.infos);
            const arr = infos instanceof Map ? [...infos.values()] : Object.values(infos || {});
            qlog({ q: "group_members", time: Date.now(), groupCode: String(job.groupCode), count: arr.length, members: arr.map(m => ({ uid: m.uid, uin: m.uin, nick: m.nick, card: m.cardName, role: m.role })) });
          } else {
            qlog({ q: job.q || "?", error: "unknown query" });
          }
        } catch (e) { qlog({ q: "error", error: e.message, line: line }); deadLetter("query", { raw: line }, e); }
      }
    } catch (e) { log("query queue err", e.message); }
  }, 2000);
  log("query queue watcher started");
}
function textElement(text) {
  return { elementType: 1, elementId: "", textElement: { content: text, atType: 0, atUid: "", atTinyId: "", atNtUid: "" } };
}
let queueRunning = false;
function startSendQueue() {
  if (queueRunning) return;
  queueRunning = true;
  const qf = path.join(OUT, "send_queue.jsonl");
  setInterval(async () => {
    try {
      const lines = readNewLines(qf);
      if (!lines.length) return;
      for (const line of lines) {
        try {
          const job = JSON.parse(line);
          if (job.path !== undefined) {
            const safe = safePath(job.path);
            if (!safe) { deadLetter("send", job, "path outside " + FILES_BASE); log("send job rejected: path outside base", job.path); continue; }
            job.path = safe;
          }
          const peer = { chatType: job.chatType, peerUid: job.peerUid, guildId: job.guildId || "" };
          if (job.type === "forward") {
            const src = { chatType: job.fromChatType, peerUid: job.fromPeerUid, guildId: "" };
            const dst = { chatType: job.toChatType, peerUid: job.toPeerUid, guildId: "" };
            const fr = await msgService.forwardMsg(job.msgIds, src, [dst], []);
            log("FORWARD ->", JSON.stringify(job.msgIds), "res:", JSON.stringify(fr));
            continue;
          }
          if (job.type === "recall") {
            const rr = await msgService.recallMsg(peer, [job.msgId]);
            log("RECALL ->", JSON.stringify(peer), job.msgId, "res:", JSON.stringify(rr));
            continue;
          }
          if (job.type === "poke") {
            const out = await doPoke(job.targetUin, job.groupUin, job.serviceType);
            log("POKE ->", job.targetUin, job.groupUin || "", "res:", out);
            continue;
          }
          if (job.type === "download") {
            const got = await msgService.getMsgsByMsgId(peer, [job.msgId]);
            const rm = got && got.msgList && got.msgList[0];
            const fel = rm && (rm.elements || []).find(e => e.elementType === 3 || e.elementType === 2 || e.elementType === 5);
            if (!fel) { log("download: no media element in", job.msgId); continue; }
            const r = msgService.downloadRichMedia({ fileModelId: "0", downSourceType: 0, downloadSourceType: 0, triggerType: 1, msgId: job.msgId, chatType: job.chatType, peerUid: job.peerUid, elementId: fel.elementId, thumbSize: 0, downloadType: 1, filePath: "" });
            log("DOWNLOAD ->", job.msgId, "el", fel.elementId, "ret:", JSON.stringify(r));
            continue;
          }
          let elements, label;
          if (job.type === "ptt") {
            const { execFileSync } = require("child_process");
            const stamp = Date.now();
            const tmpWav = "/tmp/qqours_ptt_" + stamp + ".wav";
            execFileSync("ffmpeg", ["-y", "-v", "error", "-i", job.path, "-ar", "24000", "-ac", "1", tmpWav]);
            const silk = require("/data/qq-ours/node_modules/silk-wasm");
            const enc = await silk.encode(fs.readFileSync(tmpWav), 0);
            const silkBuf = Buffer.from(enc.data);
            const duration = Math.max(1, Math.round(enc.duration / 1000));
            const tmpSilk = "/tmp/qqours_ptt_" + stamp + ".silk";
            fs.writeFileSync(tmpSilk, silkBuf);
            const md5 = require("crypto").createHash("md5").update(silkBuf).digest("hex");
            const silkName = path.basename(tmpSilk);
            let mediaPath = msgService.getRichMediaFilePathForGuild({ md5HexStr: md5, fileName: silkName, elementType: 4, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: "" });
            if (mediaPath && mediaPath !== tmpSilk) fs.copyFileSync(tmpSilk, mediaPath);
            elements = [{ elementType: 4, elementId: "", pttElement: { fileName: silkName, filePath: mediaPath, md5HexStr: md5, fileSize: String(silkBuf.length), duration: duration, formatType: 1, voiceType: 1, voiceChangeType: 0, canConvert2Text: true, waveAmplitudes: [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17], fileSubId: "", playState: 1, autoConvertText: 0, storeID: 0, otherBusinessInfo: { aiVoiceType: 0 } } }];
            label = "ptt:" + duration + "s";
          } else if (job.type === "video") {
            const buf = fs.readFileSync(job.path);
            const md5 = require("crypto").createHash("md5").update(buf).digest("hex");
            const fileName = path.basename(job.path);
            let mediaPath = job.path;
            mediaPath = msgService.getRichMediaFilePathForGuild({ md5HexStr: md5, fileName: fileName, elementType: 5, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: "" });
            if (mediaPath && mediaPath !== job.path) fs.copyFileSync(job.path, mediaPath);
            const { execFileSync } = require("child_process");
            let dur = 10, vw = 720, vh = 1280;
            try {
              const probe = JSON.parse(execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", job.path], { encoding: "utf8" }));
              dur = Math.max(1, Math.round(parseFloat(probe.format.duration || 10)));
              const vs = (probe.streams || []).find(x => x.codec_type === "video");
              if (vs) { vw = vs.width || vw; vh = vs.height || vh; }
            } catch (e) { log("ffprobe err", e.message); }
            const thumbDirPath = path.dirname(mediaPath.replace("/Ori/", "/Thumb/"));
            fs.mkdirSync(thumbDirPath, { recursive: true });
            const thumbPath = path.join(thumbDirPath, md5 + "_0.png");
            try { execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", "1", "-i", job.path, "-frames:v", "1", thumbPath]); } catch (e) { log("ffmpeg thumb err", e.message); }
            const thumbBuf = fs.readFileSync(thumbPath);
            const thumbMd5 = require("crypto").createHash("md5").update(thumbBuf).digest("hex");
            elements = [{ elementType: 5, elementId: "", videoElement: { fileName: fileName, filePath: mediaPath, videoMd5: md5, thumbMd5: thumbMd5, fileTime: dur, thumbPath: new Map([[0, thumbPath]]), thumbSize: thumbBuf.length, thumbWidth: vw, thumbHeight: vh, fileSize: String(buf.length) } }];
            label = "video:" + fileName;
          } else if (job.type === "face") {
            elements = [{ elementType: 6, elementId: "", faceElement: { faceIndex: Number(job.faceIndex || 14), faceType: 1, faceText: job.faceText || "/微笑", sourceType: 1 } }];
            label = "face:" + (job.faceIndex || 14);
          } else if (job.type === "file") {
            const buf = fs.readFileSync(job.path);
            const md5 = require("crypto").createHash("md5").update(buf).digest("hex");
            const fileName = path.basename(job.path);
            let mediaPath = job.path;
            try {
              mediaPath = msgService.getRichMediaFilePathForGuild({ md5HexStr: md5, fileName: fileName, elementType: 3, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: "" });
              if (mediaPath && mediaPath !== job.path) fs.copyFileSync(job.path, mediaPath);
            } catch (e) { log("richmedia path err", e.message); mediaPath = job.path; }
            elements = [{ elementType: 3, elementId: "", fileElement: { fileName: fileName, folderId: "", filePath: mediaPath, fileSize: String(buf.length) } }];
            label = "file:" + fileName;
          } else if (job.type === "reply") {
            const got = await msgService.getMsgsByMsgId(peer, [job.replyMsgId]);
            const rm = got && got.msgList && got.msgList[0];
            if (!rm) { log("reply target not found", job.replyMsgId); continue; }
            const replyEl = { elementType: 7, elementId: "", replyElement: { replayMsgSeq: rm.msgSeq, replayMsgId: rm.msgId, senderUin: rm.senderUin, senderUinStr: rm.senderUin, replyMsgClientSeq: rm.clientSeq } };
            elements = [replyEl, textElement(job.text)];
            label = "reply->" + job.replyMsgId + " text: " + job.text;
          } else if (job.type === "text_at") {
            const atEl = { elementType: 1, elementId: "", textElement: { content: "@" + job.atNick + " ", atType: 2, atUid: String(job.atUin), atTinyId: "", atNtUid: job.atUid } };
            elements = [atEl, textElement(job.text)];
            label = "at " + job.atUin + " text: " + job.text;
          } else if (job.type === "pic") {
            const buf = fs.readFileSync(job.path);
            const md5 = require("crypto").createHash("md5").update(buf).digest("hex");
            const fileName = path.basename(job.path);
            let mediaPath = job.path;
            try {
              mediaPath = msgService.getRichMediaFilePathForGuild({ md5HexStr: md5, fileName: fileName, elementType: 2, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: "" });
              if (mediaPath && mediaPath !== job.path) fs.copyFileSync(job.path, mediaPath);
            } catch (e) { log("richmedia path err", e.message); mediaPath = job.path; }
            let w = 800, h = 800;
            if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); }
            const ext = (fileName.split(".").pop() || "").toLowerCase();
            const picType = ext === "png" ? 1001 : ext === "gif" ? 2000 : ext === "webp" ? 1002 : 1000;
            elements = [{ elementType: 2, elementId: "", picElement: { md5HexStr: md5, fileSize: String(buf.length), picWidth: w, picHeight: h, fileName: fileName, sourcePath: mediaPath, original: true, picType: picType, picSubType: 0, fileUuid: "", fileSubId: "", thumbFileSize: 0, summary: "" } }];
            label = "pic:" + fileName;
          } else {
            elements = [textElement(job.text)];
            label = "text: " + job.text;
          }
          const res = await msgService.sendMsg("0", peer, elements, new Map());
          log("SEND ->", JSON.stringify(peer), label, "res:", JSON.stringify(res));
        } catch (e) { log("send job err", e.message, line); deadLetter("send", { raw: line }, e); }
      }
    } catch (e) { log("send queue err", e.message); }
  }, 1500);
  log("send queue watcher started");
}


// ============ OneBot 接口层（协议在 onebot.js，这里做动作实现） ============
let onebot = null;
function pushEvent(ev) { try { if (onebot) onebot.push(ev); } catch (e) {} }

// 媒体元素构造：与发送队列同一套参数，队列侧暂留原实现（后续统一）
function buildMediaElement(type, filePath) {
  const buf = fs.readFileSync(filePath);
  const md5 = require("crypto").createHash("md5").update(buf).digest("hex");
  const fileName = path.basename(filePath);
  if (type === "image") {
    let mediaPath = filePath;
    try {
      mediaPath = msgService.getRichMediaFilePathForGuild({ md5HexStr: md5, fileName: fileName, elementType: 2, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: "" });
      if (mediaPath && mediaPath !== filePath) fs.copyFileSync(filePath, mediaPath);
    } catch (e) { log("richmedia path err", e.message); }
    let w = 800, h = 800;
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); }
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    const picType = ext === "png" ? 1001 : ext === "gif" ? 2000 : ext === "webp" ? 1002 : 1000;
    return { elementType: 2, elementId: "", picElement: { md5HexStr: md5, fileSize: String(buf.length), picWidth: w, picHeight: h, fileName: fileName, sourcePath: mediaPath, original: true, picType: picType, picSubType: 0, fileUuid: "", fileSubId: "", thumbFileSize: 0, summary: "" } };
  }
  if (type === "file") {
    let mediaPath = filePath;
    try {
      mediaPath = msgService.getRichMediaFilePathForGuild({ md5HexStr: md5, fileName: fileName, elementType: 3, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: "" });
      if (mediaPath && mediaPath !== filePath) fs.copyFileSync(filePath, mediaPath);
    } catch (e) { log("richmedia path err", e.message); }
    return { elementType: 3, elementId: "", fileElement: { fileName: fileName, folderId: "", filePath: mediaPath, fileSize: String(buf.length) } };
  }
  if (type === "record") {
    const { execFileSync } = require("child_process");
    const stamp = Date.now();
    const tmpWav = "/tmp/qqours_api_" + stamp + ".wav";
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", filePath, "-ar", "24000", "-ac", "1", tmpWav]);
    const silk = require("/data/qq-ours/node_modules/silk-wasm");
    const enc = silk.encode(fs.readFileSync(tmpWav), 0);
    const silkBuf = Buffer.from(enc.data);
    const smd5 = require("crypto").createHash("md5").update(silkBuf).digest("hex");
    const silkName = "qqours_api_" + stamp + ".silk";
    let mediaPath = msgService.getRichMediaFilePathForGuild({ md5HexStr: smd5, fileName: silkName, elementType: 4, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: "" });
    if (mediaPath) fs.writeFileSync(mediaPath, silkBuf);
    return { elementType: 4, elementId: "", pttElement: { fileName: silkName, filePath: mediaPath, md5HexStr: smd5, fileSize: String(silkBuf.length), duration: Math.max(1, Math.round(enc.duration / 1000)), formatType: 1, voiceType: 1, voiceChangeType: 0, canConvert2Text: true, waveAmplitudes: [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17], fileSubId: "", playState: 1, autoConvertText: 0, storeID: 0, otherBusinessInfo: { aiVoiceType: 0 } } };
  }
  if (type === "video") {
    let mediaPath = msgService.getRichMediaFilePathForGuild({ md5HexStr: md5, fileName: fileName, elementType: 5, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: "" });
    if (mediaPath && mediaPath !== filePath) fs.copyFileSync(filePath, mediaPath);
    const { execFileSync } = require("child_process");
    let dur = 10, vw = 720, vh = 1280;
    try {
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath], { encoding: "utf8" }));
      dur = Math.max(1, Math.round(parseFloat(probe.format.duration || 10)));
      const vs = (probe.streams || []).find(x => x.codec_type === "video");
      if (vs) { vw = vs.width || vw; vh = vs.height || vh; }
    } catch (e) { log("ffprobe err", e.message); }
    const thumbDir = path.dirname(String(mediaPath).replace("/Ori/", "/Thumb/"));
    fs.mkdirSync(thumbDir, { recursive: true });
    const thumbPath = path.join(thumbDir, md5 + "_0.png");
    try { execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", "1", "-i", filePath, "-frames:v", "1", thumbPath]); } catch (e) { log("ffmpeg thumb err", e.message); }
    const thumbBuf = fs.readFileSync(thumbPath);
    const thumbMd5 = require("crypto").createHash("md5").update(thumbBuf).digest("hex");
    return { elementType: 5, elementId: "", videoElement: { fileName: fileName, filePath: mediaPath, videoMd5: md5, thumbMd5: thumbMd5, fileTime: dur, thumbPath: new Map([[0, thumbPath]]), thumbSize: thumbBuf.length, thumbWidth: vw, thumbHeight: vh, fileSize: String(buf.length) } };
  }
  throw new Error("不支持的媒体类型: " + type);
}

// uin -> uid（只对好友有效）
let buddyCache = { at: 0, byUin: new Map(), list: [] };
async function loadBuddies(force) {
  if (!force && buddyCache.at && Date.now() - buddyCache.at < 300000) return buddyCache;
  const r = await buddyService.getBuddyListV2("qqours", false, 0);
  const cats = (r && r.data) || [];
  const byUin = new Map(); const list = [];
  for (const c of cats) {
    for (const uid of (c.buddyUids || [])) {
      let uin = "", nick = "", remark = "";
      try {
        const info = await fetchProfile(uid);
        uin = info && info.uin ? String(info.uin) : "";
        const ci = (info && info.simpleInfo && info.simpleInfo.coreInfo) || {};
        nick = ci.nick || ""; remark = ci.remark || "";
      } catch (e) {}
      if (uin) byUin.set(uin, uid);
      list.push({ user_id: Number(uin) || 0, nickname: nick, remark: remark, uid: uid });
    }
  }
  buddyCache = { at: Date.now(), byUin, list };
  return buddyCache;
}
async function resolveUid(uin) {
  const k = String(uin);
  if (k.indexOf("u_") === 0) return k;
  const c = await loadBuddies(false);
  return c.byUin.get(k) || null;
}

async function apiSend(chatType, peer, segs) {
  const ct = Number(chatType) === 2 ? 2 : 1;
  let peerUid;
  if (ct === 2) peerUid = String(peer);
  else {
    peerUid = await resolveUid(peer);
    if (!peerUid) throw new Error("找不到 uin=" + peer + " 对应的 uid（私聊只支持好友，请先让 get_friend_list 拉到）");
  }
  const elements = [];
  for (const seg of segs || []) {
    const d = seg.data || {};
    if (seg.type === "reply") {
      const got = await msgService.getMsgsByMsgId({ chatType: ct, peerUid: peerUid, guildId: "" }, [String(d.id)]);
      const rm = got && got.msgList && got.msgList[0];
      if (!rm) throw new Error("回复目标不存在: " + d.id);
      elements.push({ elementType: 7, elementId: "", replyElement: { replayMsgSeq: rm.msgSeq, replayMsgId: rm.msgId, senderUin: rm.senderUin, senderUinStr: rm.senderUin, replyMsgClientSeq: rm.clientSeq } });
    } else if (seg.type === "text") elements.push(textElement(d.text || ""));
    else if (seg.type === "at") elements.push({ elementType: 1, elementId: "", textElement: { content: "@" + (d.name || d.qq) + " ", atType: 2, atUid: String(d.qq || ""), atTinyId: "", atNtUid: d.uid || "" } });
    else if (seg.type === "face") elements.push({ elementType: 6, elementId: "", faceElement: { faceIndex: Number(d.id || 14), faceType: 1, faceText: d.text || "", sourceType: 1 } });
    else if (seg.type === "image" || seg.type === "file" || seg.type === "record" || seg.type === "video") {
      const p = d.file || d.path || d.url;
      if (!p || !fs.existsSync(p)) throw new Error("媒体文件不存在: " + p);
      elements.push(buildMediaElement(seg.type, p));
    } else throw new Error("不支持的段类型: " + seg.type);
  }
  if (!elements.length) throw new Error("空消息");
  if (!rateOk()) throw new Error("发送过于频繁，已限流（上限 " + (RUNTIME.rate_limit_per_min || 30) + " 条/分钟）");
  const peerObj = { chatType: ct, peerUid: peerUid, guildId: "" };
  const res = await msgService.sendMsg("0", peerObj, elements, new Map());
  let mid = res && (res.msgId || (res.result && res.result.msgId) || 0);
  if (!mid) {
    try {
      const t0 = Math.floor(Date.now() / 1000) - 20;
      const got = await msgService.getMsgsIncludeSelf(peerObj, "", 5, false);
      let best = null;
      for (const m of ((got && got.msgList) || [])) {
        if (String(m.senderUin) !== String(selfInfo && selfInfo.uin)) continue;
        if (Number(m.msgTime || 0) < t0) continue;
        if (!best || Number(m.msgTime) >= Number(best.msgTime)) best = m;
      }
      if (best) mid = best.msgId;
    } catch (e) { log("取 message_id 失败", e.message); }
  }
  return { message_id: String(mid || 0), res: res };
}

function findInboxByMsgId(msgId) {
  try {
    const lines = fs.readFileSync(path.join(OUT, "inbox.jsonl"), "utf8").split(String.fromCharCode(10));
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let r; try { r = JSON.parse(lines[i]); } catch (e) { continue; }
      if (String(r.msgId) === String(msgId)) return r;
    }
  } catch (e) {}
  return null;
}

let lastGroupList = null;
let groupListWaiter = null;
function requestGroupList() {
  return new Promise((resolve) => {
    groupListWaiter = resolve;
    try { groupService.getGroupList(false); } catch (e) { groupListWaiter = null; resolve(lastGroupList); return; }
    setTimeout(() => { if (groupListWaiter === resolve) { groupListWaiter = null; resolve(lastGroupList); } }, 5000);
  });
}

const apiCalls = {
  loginInfo: () => {
    let nick = (selfInfo && (selfInfo.nickName || selfInfo.nick)) || "";
    if (!nick && buddyCache.list.length) { const me = buddyCache.list.find(x => String(x.user_id) === String(selfInfo && selfInfo.uin)); if (me) nick = me.nickname || ""; }
    return { user_id: Number(selfInfo && selfInfo.uin) || 0, nickname: nick };
  },
  send: apiSend,
  async deleteMsg(messageId) {
    const rec = findInboxByMsgId(messageId);
    if (!rec) throw new Error("inbox 里没有这条消息: " + messageId);
    const peer = { chatType: rec.chatType, peerUid: rec.peerUid, guildId: "" };
    const r = await msgService.recallMsg(peer, [String(messageId)]);
    return { message_id: messageId, res: r };
  },
  async getMsg(messageId) {
    const rec = findInboxByMsgId(messageId);
    if (!rec) throw new Error("inbox 里没有这条消息: " + messageId);
    return { message_id: String(rec.msgId), message_type: Number(rec.chatType) === 2 ? "group" : "private", group_id: Number(rec.chatType) === 2 ? Number(rec.peerUid) : undefined, user_id: Number(rec.senderUin) || 0, raw_message: rec.text, time: Math.floor((rec.msgTime || rec.time / 1000)), message: rec.elements ? rec.elements.map(e => ({ type: "raw", data: e })) : [] };
  },
  async markRead() { throw new Error("尚未实现: 标记已读（内核未定位到对应方法）"); },
  async friendList(force) { const c = await loadBuddies(force); return c.list; },
  async groupList() {
    const groups = await requestGroupList();
    if (!groups) throw new Error("群列表拉取超时，稍后再试");
    return groups;
  },
  async groupMemberList(groupId) {
    const r = await groupService.getAllMemberList(String(groupId), true);
    const infos = (r && r.result && r.result.infos) || (r && r.infos);
    const arr = infos instanceof Map ? [...infos.values()] : Object.values(infos || {});
    return arr.map(m => ({ group_id: Number(groupId), user_id: Number(m.uin) || 0, nickname: m.nick || "", card: m.cardName || "", role: Number(m.role) === 4 ? "owner" : Number(m.role) === 3 ? "admin" : "member", uid: m.uid }));
  },
  async groupMemberInfo(groupId, userId) {
    const uid = (await apiCalls.groupMemberList(groupId)).find(m => String(m.user_id) === String(userId));
    if (uid && uid.uid) {
      try {
        const r = await tryCall(groupService, ["getMemberInfo", "getMemberExtInfo"], [String(groupId), uid.uid]);
        return Object.assign({}, uid, { raw: r });
      } catch (e) {}
    }
    if (!uid) throw new Error("群成员不存在");
    return uid;
  },
  async groupInfo(groupId) { throw new Error("尚未实现: get_group_info（内核 getGroupDetailInfo 未接）"); },
  async groupHonor() { throw new Error("尚未实现: 群荣誉"); },
  async strangerInfo(userId) {
    const info = await profileService.getUserDetailInfoByUin(String(userId));
    return { user_id: Number(userId) || 0, raw: info };
  },
  async cookies(domain) { const pk = await qunPskey(); return { cookies: "p_skey=" + (pk || "") }; },
  async groupKick(groupId, userId, reject) { await groupService.kickMember(String(groupId), [String(userId)], !!reject, ""); return null; },
  async groupBan(groupId, userId, duration) { await groupService.setMemberShutUp(String(groupId), [{ uid: String(userId), timeStamp: Number(duration || 0) }]); return null; },
  async groupWholeBan(groupId, enable) { await groupService.setGroupShutUp(String(groupId), !!enable); return null; },
  async groupCard(groupId, userId, card) { groupService.modifyMemberCardName(String(groupId), String(userId), String(card || "")); return null; },
  async groupAdmin(groupId, userId, enable) { groupService.modifyMemberRole(String(groupId), String(userId), enable ? 3 : 2); return null; },
  async groupLeave(groupId) { await groupService.quitGroup(String(groupId)); return null; },
  async groupRename() { throw new Error("尚未实现: 改群名（modifyGroupExtInfo 未接）"); },
  async friendAddRequest(flag, approve) {
    const parts = String(flag).split("|");
    const friendUid = parts[0], reqTime = parts[1] || String(Date.now());
    await buddyService.approvalFriendRequest({ friendUid: friendUid, reqTime: reqTime, accept: !!approve });
    return null;
  },
  async groupAddRequest(flag, subType, approve) {
    const parts = String(flag).split("|");
    const seq = parts[0], type = parts[1] || 5, groupCode = parts[2] || "";
    await groupService.operateSysNotify(false, { operateType: approve ? 1 : 2, targetMsg: { seq: String(seq), type: Number(type), groupCode: String(groupCode), postscript: " " } });
    return null;
  },
  async sendLike() { throw new Error("尚未实现: 名片赞（需 OIDB，同戳一戳待走 msso_send）"); },
  async recentContact() { throw new Error("尚未实现: 最近会话（RecentContactService 未接）"); }
};

// 内核方法名不确定时按候选顺序尝试
async function tryCall(obj, names, args) {
  const tried = [];
  for (const n of names) {
    if (typeof obj[n] !== "function") { tried.push(n + "(无)"); continue; }
    try { return await obj[n].apply(obj, args); } catch (e) { tried.push(n + ":" + e.message); }
  }
  throw new Error("候选方法都失败: " + tried.join(" | "));
}

Object.assign(apiCalls, {
  async debug_probe(params) {
    const name = String(params.service || "GroupService");
    const getter = "get" + name;
    if (typeof session[getter] !== "function") throw new Error("没有 " + getter);
    const svc = session[getter]();
    const names = new Set();
    let o = svc;
    for (let d = 0; o && d < 3; d++) { Object.getOwnPropertyNames(o).forEach(n => names.add(n)); o = Object.getPrototypeOf(o); }
    return { service: name, methods: [...names].filter(n => typeof svc[n] === "function").sort() };
  },
  async groupInfo(groupId) {
    // 内核的 detail 接口只回 result，真正的数据走 listener/缓存；这里以群列表缓存为准
    const cached = (lastGroupList || []).find(g => String(g.group_id) === String(groupId)) || {};
    let raw = null;
    try { raw = await tryCall(groupService, ["getGroupAllInfo", "getGroupDetailInfo"], [String(groupId), true]); } catch (e) {}
    return Object.assign({ group_id: Number(groupId) }, cached, { raw: raw });
  },
  async groupRename(groupId, name) {
    const r = await tryCall(groupService, ["modifyGroupName", "modifyGroupExtInfoV2", "modifyGroupExtInfo"], [String(groupId), String(name || "")]);
    return { group_id: Number(groupId), raw: r };
  },
  async deleteGroupFile(groupId, fileId) {
    const svc = session.getRichMediaService();
    const r = await tryCall(svc, ["deleteGroupFile"], [String(groupId), String(fileId)]);
    return { group_id: Number(groupId), file_id: String(fileId), raw: r };
  },
  async uploadGroupFile(groupId, filePath, name) {
    if (!filePath || !fs.existsSync(filePath)) throw new Error("文件不存在: " + filePath);
    if (!rateOk()) throw new Error("发送过于频繁，已限流");
    const el = buildMediaElement("file", filePath);
    if (name) el.fileElement.fileName = String(name);
    const res = await msgService.sendMsg("0", { chatType: 2, peerUid: String(groupId), guildId: "" }, [el], new Map());
    return { group_id: Number(groupId), file: String(filePath), note: "以群消息形式发送（OneBot 语义），不是上传到群文件空间", res: res };
  },
  async uploadPrivateFile(userId, filePath, name) {
    if (!filePath || !fs.existsSync(filePath)) throw new Error("文件不存在: " + filePath);
    if (!rateOk()) throw new Error("发送过于频繁，已限流");
    const peerUid = await resolveUid(userId);
    if (!peerUid) throw new Error("找不到该好友的 uid: " + userId);
    const el = buildMediaElement("file", filePath);
    if (name) el.fileElement.fileName = String(name);
    const res = await msgService.sendMsg("0", { chatType: 1, peerUid: peerUid, guildId: "" }, [el], new Map());
    return { user_id: Number(userId), file: String(filePath), res: res };
  },
  async friendAdd(userId, remark) {
    const uid = await resolveUid(userId).catch(() => null);
    const shapes = [
      ["reqToAddFriends", [{ uin: String(userId), uid: uid || "", remark: String(remark || "") }]],
      ["reqToAddFriends", [String(userId), String(remark || "")]],
      ["addBuddy", [String(userId), String(remark || "")]]
    ];
    const tried = [];
    for (const [name, args] of shapes) {
      if (typeof buddyService[name] !== "function") { tried.push(name + "(无)"); continue; }
      try { const r = await buddyService[name].apply(buddyService, args); return { user_id: Number(userId), method: name, raw: r }; }
      catch (e) { tried.push(name + ":" + e.message); }
    }
    throw new Error("加好友失败: " + tried.join(" | "));
  },
  async friendDelete(userId) {
    const uid = await resolveUid(userId);
    if (!uid) throw new Error("找不到该好友的 uid: " + userId);
    const r = await tryCall(buddyService, ["delBuddy", "deleteBuddy", "delBuddyReq"], [uid]);
    buddyCache.at = 0;
    return { user_id: Number(userId), raw: r };
  },
  async friendRemark(userId, remark) {
    const uid = await resolveUid(userId);
    if (!uid) throw new Error("找不到该好友的 uid: " + userId);
    const r = await tryCall(buddyService, ["setBuddyRemark"], [uid, String(remark || "")]);
    buddyCache.at = 0;
    return { user_id: Number(userId), raw: r };
  },
  async friendCategory(userId, categoryId) {
    const uid = await resolveUid(userId);
    if (!uid) throw new Error("找不到该好友的 uid: " + userId);
    const r = await tryCall(buddyService, ["setBuddyCategory"], [uid, Number(categoryId || 0)]);
    return { user_id: Number(userId), raw: r };
  },
  async markRead(chatType, peer) {
    const ct = Number(chatType) === 2 ? 2 : 1;
    const peerUid = ct === 2 ? String(peer) : (await resolveUid(peer) || String(peer));
    const peerObj = { chatType: ct, peerUid: peerUid, guildId: "" };
    const shapes = [
      ["setMsgReadAndReport", [peerObj]],
      ["setMsgRead", [peerObj]],
      ["setLocalMsgRead", [peerObj]]
    ];
    const tried = [];
    for (const [name, args] of shapes) {
      if (typeof msgService[name] !== "function") { tried.push(name + "(无)"); continue; }
      try { const r = await msgService[name].apply(msgService, args); return { method: name, raw: r }; }
      catch (e) { tried.push(name + ":" + e.message); }
    }
    throw new Error("标记已读失败: " + tried.join(" | "));
  }
});

function startOneBot() {
  if (onebot) return;
  try {
    const cfgPath = path.join(OUT, "onebot.json");
    let cfg = { enabled: true, host: "127.0.0.1", port: 5700, token: "" };
    if (fs.existsSync(cfgPath)) { try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, "utf8"))); } catch (e) { log("onebot.json 解析失败", e.message); } }
    if (!cfg.enabled) { log("OneBot 已禁用（onebot.json enabled=false）"); return; }
    onebot = makeOneBot({ token: cfg.token, call: apiCalls });
    onebot.listen(cfg.host || "127.0.0.1", Number(cfg.port || 5700))
      .then(() => log("OneBot HTTP/WS 已监听", (cfg.host || "127.0.0.1") + ":" + (cfg.port || 5700), "token", cfg.token ? "已启用" : "未设置"))
      .catch(e => log("OneBot 监听失败", e.message));
  } catch (e) { log("OneBot 启动异常", (e && e.stack) || String(e)); }
}

async function initSession(res) {
  try {
    if (!session) { log("no session to init"); return; }
    let guidRaw = "";
    try { guidRaw = loginService.getMachineGuid(); } catch (e) {}
    const guid = guidRaw && guidRaw.length >= 32
      ? guidRaw.slice(0, 8) + "-" + guidRaw.slice(8, 12) + "-" + guidRaw.slice(12, 16) + "-" + guidRaw.slice(16, 20) + "-" + guidRaw.slice(20)
      : guidRaw;
    const downloadPath = path.join(dataPath, "qqours", "temp");
    fs.mkdirSync(downloadPath, { recursive: true });
    const cfg = {
      selfUin: String(res.uin || ""), selfUid: String(res.uid || ""),
      desktopPathConfig: { account_path: dataPath },
      clientVer: clientVer, a2: "", d2: "", d2Key: "", machineId: "",
      platform: 5, platVer: os.release(), appid: appid,
      rdeliveryConfig: { appKey: "", systemId: 0, appId: "", logicEnvironment: "", platform: 5, language: "", sdkVersion: "", userId: "", appVersion: "", osVersion: "", bundleId: "", serverUrl: "", fixedAfterHitKeys: [""] },
      defaultFileDownloadPath: downloadPath,
      deviceInfo: { guid: guid, buildVer: clientVer, localId: 2052, devName: DEV_NAME, devType: "Linux", vendorName: "LENOVO", osVer: os.release(), vendorOsName: "Ubuntu", setMute: false, vendorType: 0 },
      deviceConfig: "{\"appearance\":{\"isSplitViewMode\":true},\"msg\":{}}"
    };
    const sessionListener = { onOpentelemetryInit: (info) => { log("opentelemetry init", JSON.stringify(info)); if (info && info.is_init) { status({ phase: "session_ok", uin: cfg.selfUin, uid: cfg.selfUid }); attachMsgService(); } } };
    session.init(cfg, dependsAdapter, dispatcherAdapter, sessionListener);
    if (startupSession) startupSession.start();
    else { try { session.startNT(0); } catch (e) { session.startNT(); } }
    log("session init called");
  } catch (e) { log("initSession err", (e && e.stack) || String(e)); }
}

let loginDone = false;
const loginListener = {
  onLoginConnected: () => log("login connected"),
  onLoginDisConnected: (...a) => log("login disconnected", ...a),
  onLoginConnecting: () => log("login connecting"),
  onQRCodeGetPicture: (arg) => {
    log("QR picture url:", arg && arg.qrcodeUrl);
    try {
      fs.writeFileSync(path.join(OUT, "qrcode.url.txt"), (arg && arg.qrcodeUrl) || "");
      status({ phase: "qrcode", url: arg && arg.qrcodeUrl });
    } catch (e) { log("write qr err", e.message); }
  },
  onQRCodeLoginPollingStarted: () => log("qr polling started"),
  onQRCodeSessionUserScaned: () => { log("QR SCANNED"); status({ phase: "scanned" }); },
  onQRCodeLoginSucceed: (res) => { if (loginDone) return; loginDone = true; selfInfo = res; log("LOGIN SUCCEED", JSON.stringify(res)); status({ phase: "login_succeed", result: res }); initSession(res);
    setTimeout(() => { try { require("child_process").execFileSync("/bin/bash", ["/data/qq-ours/ops/backup_login.sh"], { encoding: "utf8" }); log("login snapshot saved"); } catch (e) { log("snapshot err", e.message); } }, 45000); },
  onQRCodeSessionFailed: (t, c) => { log("qr session failed", t, c); if (!loginDone) setTimeout(() => { try { log("refresh qr ->", loginService.getQRCodePicture()); } catch (e) { log("refresh err", e.message); } }, 1000); },
  onLoginFailed: (...a) => log("login failed", ...a),
  onLogoutSucceed: () => log("logout ok"),
  onLogoutFailed: (...a) => log("logout failed", ...a),
  onUserLoggedIn: (uid) => log("user already logged in", uid),
  onQRCodeSessionQuickLoginFailed: (...a) => { log("quick login failed", ...a); if (!loginDone) { try { loginService.getQRCodePicture(); } catch (e) {} } },
  onPasswordLoginFailed: (...a) => log("password login failed", ...a),
  onQQLoginNumLimited: (...a) => log("login num limited", ...a),
  onLoginState: (...a) => log("login state", ...a),
  onLoginRecordUpdate: (...a) => log("login record update", ...a)
};
loginService.addKernelLoginListener(loginListener);
log("login listener added");

(async () => {
  let list = null;
  try { list = await loginService.getLoginList(); log("login list", JSON.stringify(list).slice(0, 400)); }
  catch (e) { log("getLoginList err", e.message); }
  for (let i = 0; i < 40; i++) {
    let st; try { st = loginService.getMsfStatus(); } catch (e) { st = "err:" + e.message; }
    if (st !== 3) break;
    await new Promise(r => setTimeout(r, 500));
  }
  log("msf ready");
  const ql = (list && list.LocalLoginInfoList) || [];
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
  }
})();
