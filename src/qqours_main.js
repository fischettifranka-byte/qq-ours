// qqours v1 - our own QQ protocol endpoint (runs as QQ Electron main process)
// v0: wrapper load, engine/login/session init, QR login (+auto refresh), quick login
// v1: message receive listener -> inbox.jsonl ; send queue file -> sendMsg
const fs = require("fs");
const path = require("path");
const os = require("os");
const OUT = "/data/qq-ours";
const LOGF = path.join(OUT, "boot.log");
function log(...a) {
  const s = a.map(x => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch (e) { return String(x); } }).join(" ");
  try { fs.appendFileSync(LOGF, "[" + new Date().toISOString() + "] " + s + "\n"); } catch (e) {}
  console.log(s);
}
function status(obj) { try { fs.writeFileSync(path.join(OUT, "status.json"), JSON.stringify(obj, null, 2)); } catch (e) {} }
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
  clientVer: clientVer, hostName: "ubuntu", externalVersion: false
});
log("login service inited");

let session = null, startupSession = null;
try { startupSession = wrapper.NodeIQQNTStartupSessionWrapper.create(); } catch (e) { log("startupSession err", e.message); }
try { session = wrapper.NodeIQQNTWrapperSession.getNTWrapperSession("nt_1"); }
catch (e) { try { session = wrapper.NodeIQQNTWrapperSession.create(); } catch (e2) { log("session create err", e2.message); } }
log("session ready:", !!session, "startup:", !!startupSession);

let selfInfo = null;
let msgService = null;

function extractText(elements) {
  const parts = [];
  for (const el of elements || []) {
    if (el && el.elementType === 1 && el.textElement) parts.push(el.textElement.content || "");
    else if (el && el.elementType === 2) parts.push("[pic]");
    else if (el) parts.push("[el" + el.elementType + "]");
  }
  return parts.join("");
}
function recordMsg(src, m) {
  try {
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
      onKickedOffLine: (...a) => { log("KICKED OFFLINE", ...a); writeStatus({ phase: "kicked", at: Date.now() }); }
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
  } catch (e) { log("attachMsgService err", (e && e.stack) || String(e)); }
}
let groupService = null;
function qlog(obj) { try { fs.appendFileSync(path.join(OUT, "query_results.jsonl"), JSON.stringify(obj) + "\n"); } catch (e) {} log("QUERY", obj.q, obj.error || (obj.groups ? obj.groups.length + " groups" : obj.count != null ? obj.count + " members" : "ok")); }
function attachGroupService() {
  if (!session || groupService) return;
  try {
    groupService = session.getGroupService();
    const gl = {
      onGroupListUpdate: (updateType, groupList) => { qlog({ q: "group_list", time: Date.now(), updateType: updateType, groups: (groupList || []).map(g => ({ groupCode: g.groupCode, groupName: g.groupName, memberCount: g.memberCount, maxMemberCount: g.maxMemberCount, ownerUid: g.ownerUid })) }); },
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
      if (!fs.existsSync(qf)) return;
      const lines = fs.readFileSync(qf, "utf8").split("\n").filter(x => x.trim());
      if (!lines.length) return;
      fs.writeFileSync(qf, "");
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
          } else if (job.q === "oidb_send") {
            const svc = session.getECDHService();
            const r = await svc.sendOIDBRequest(Number(job.cmd), Number(job.serviceType || 0), Number(job.subCmd || 1), job.dataHex || "", job.extra !== undefined ? job.extra : null);
            let out = "";
            try { out = r instanceof Uint8Array ? Buffer.from(r).toString("hex").slice(0, 200) : JSON.stringify(r).slice(0, 300); } catch (e) { out = String(r); }
            qlog({ q: "oidb_send", time: Date.now(), cmd: job.cmd, res: out });
          } else if (job.q === "poke") {
            const enc = (field, val) => { const bytes = [field << 3]; let v = val; do { let b = v % 128; v = Math.floor(v / 128); if (v) b += 128; bytes.push(b); } while (v); return bytes; };
            let bytes = [].concat(enc(1, Number(job.targetUin)));
            if (job.groupUin) bytes = bytes.concat(enc(2, Number(job.groupUin)));
            else bytes = bytes.concat(enc(5, Number(job.targetUin)));
            bytes = bytes.concat(enc(6, 0));
            const hex = Buffer.from(bytes).toString("hex");
            const svc = session.getECDHService();
            const r = await svc.sendOIDBRequest(2371, Number(job.serviceType || 0), 1, hex, null);
            let out = "";
            try { out = r instanceof Uint8Array ? Buffer.from(r).toString("hex").slice(0, 200) : JSON.stringify(r).slice(0, 300); } catch (e) { out = String(r); }
            qlog({ q: "poke", time: Date.now(), target: job.targetUin, group: job.groupUin || "", hex: hex, res: out });
          } else if (job.q === "svc_probe") {
            const names = new Set();
            let o = session;
            for (let depth = 0; o && depth < 4; depth++) { Object.getOwnPropertyNames(o).forEach(n => names.add(n)); o = Object.getPrototypeOf(o); }
            const gets = [...names].filter(n => n.startsWith("get"));
            qlog({ q: "svc_probe", gets: gets });
          } else if (job.q === "group_members") {
            const r = await groupService.getAllMemberList(String(job.groupCode), job.force === false ? false : true);
            const infos = (r && r.result && r.result.infos) || (r && r.infos);
            const arr = infos instanceof Map ? [...infos.values()] : Object.values(infos || {});
            qlog({ q: "group_members", time: Date.now(), groupCode: String(job.groupCode), count: arr.length, members: arr.map(m => ({ uid: m.uid, uin: m.uin, nick: m.nick, card: m.cardName, role: m.role })) });
          } else {
            qlog({ q: job.q || "?", error: "unknown query" });
          }
        } catch (e) { qlog({ q: "error", error: e.message, line: line }); }
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
      if (!fs.existsSync(qf)) return;
      const lines = fs.readFileSync(qf, "utf8").split("\n").filter(x => x.trim());
      if (!lines.length) return;
      fs.writeFileSync(qf, "");
      for (const line of lines) {
        try {
          const job = JSON.parse(line);
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
        } catch (e) { log("send job err", e.message, line); }
      }
    } catch (e) { log("send queue err", e.message); }
  }, 1500);
  log("send queue watcher started");
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
      deviceInfo: { guid: guid, buildVer: clientVer, localId: 2052, devName: "ubuntu", devType: "Linux", vendorName: "", osVer: os.release(), vendorOsName: "Linux", setMute: false, vendorType: 0 },
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
  onQRCodeLoginSucceed: (res) => { if (loginDone) return; loginDone = true; selfInfo = res; log("LOGIN SUCCEED", JSON.stringify(res)); status({ phase: "login_succeed", result: res }); initSession(res); },
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
  const quick = list && list.LocalLoginInfoList && list.LocalLoginInfoList.find(x => x.isQuickLogin);
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
  }
})();
