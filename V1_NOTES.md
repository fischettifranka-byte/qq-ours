# qqours v1 notes (from NapCat v4.18.42 reference, verified 2026-11-20)
- Receive: session.getMsgService().addKernelMsgListener(listener)
  - onRecvMsg(RawMessage[]) = incoming messages; onMsgInfoListUpdate also fires (incl. self)
  - RawMessage fields to map: msgId, msgSeq, chatType, peerUid(peerUin), senderUid/senderUin, elements[], msgTime
- Send: msgService.sendMsg("0", peer, elements, new Map())
  - peer = { chatType, peerUid, guildId: "" }; ChatType C2C=1, GROUP=2
  - text element = { elementType: 1, elementId: "", textElement: { content, atType: 0, atUid: "", atTinyId: "", atNtUid: "" } }
  - peerUid for C2C is the friend UID (not QQ number): resolve via Buddy/User services (getUidByUin / profile service) after login
- OneBot subset to expose on localhost: POST /send_private_msg /send_group_msg, WS/HTTP event push of post_type=message
- Session/msg services only exist after login + session.init (v0 flow already does this)

## Feature batches (2026-11-20)
- A1 pic send: md5 file, msgService.getRichMediaFilePathForGuild({md5HexStr,fileName,elementType:2,elementSubType:0,thumbSize:0,needCreate:true,downloadType:1,file_uuid:""}), copy file there, send picElement {md5HexStr,fileSize(str),picWidth,picHeight,fileName,sourcePath:mediaPath,original:true,picType(PNG1001/JPG1000/GIF2000/WEBP1002),picSubType:0,fileUuid:"",fileSubId:"",thumbFileSize:0,summary:""} elementType 2. res 0 verified.
- A2 reply: elementType 7 replyElement {replayMsgSeq,replayMsgId,senderUin,senderUinStr,replyMsgClientSeq} + text el; fetch orig via getMsgsByMsgId(peer,[id]).msgList[0]. @: textElement atType 2 (ATTYPEONE), atUid=uin str, atNtUid=uid, content "@nick ". recall: msgService.recallMsg(peer,[msgId]). All res 0 verified (reply/recall in C2C with owner; @ in group GROUP_CODE).
- A3 file send: same rich-media path with elementType 3, fileElement {fileName,folderId:"",filePath:mediaPath,fileSize(str)}. Receive download: msgService.downloadRichMedia({fileModelId:"0",downSourceType:0,downloadSourceType:0,triggerType:1,msgId,chatType,peerUid,elementId,thumbSize:0,downloadType:1,filePath:""}) + msg listener onRichMediaDownloadComplete(arg.filePath) -> copy to /data/qq-ours/files/inbox/. Implemented; live test waits for owner to send a file.
- Query queue: /data/qq-ours/query_queue.jsonl -> results /data/qq-ours/query_results.jsonl (qlog). Jobs: group_list, group_members, buddy_list, buddy_reqs, buddy_approve, profile_probe, download (in send queue), recall/reply/text_at/pic/file (send queue).
- B1 groups: groupService.addKernelGroupListener({onGroupListUpdate,...}) + getGroupList(false). getAllMemberList(code, force) returns {result:{infos:Map}} — infos under .result! Member role: 4=owner, 2=normal (3=admin presumed). ACCOUNT_NICK in 7 groups; owner small group GROUP_CODE (OWNER_NICK owner, ACCOUNT_NICK+FRIEND_E_NICK members).
- B2 buddies: buddyService.getBuddyListV2("qqours", false, 0) — THREE args or native assert fails. Categories carry buddyUids (includes SELF uid). Profiles: profileService.addKernelProfileListener onUserDetailInfoChanged + fetchUserDetailInfo("BuddyProfileStore",[uid],1,[0]) (source KSERVER=1, biz KALL=0); arg {uid,uin,simpleInfo.coreInfo.nick}. getUserDetailInfo(uid) alone returns only {result:0} — detail comes via listener. Requests: buddy listener onBuddyReqChange {unreadNums,buddyReqs[{friendUid,reqTime,friendNick,isDecide,isAgreed,addSource}]}; approve via buddyService.approvalFriendRequest({friendUid,reqTime,accept}). Friends of ACCOUNT_NICK: FRIEND_A_NICKFRIEND_A_UIN, FRIEND_B_NICKFRIEND_B_UIN, OWNER_NICKOWNER_UIN(owner), FRIEND_C_NICKFRIEND_C_UIN, FRIEND_D_NICKFRIEND_D_UIN.
- GOTCHA: writing JS via python heredoc — "\n" inside JS strings gets mangled by JSON layer of tool calls; use chr() tricks or avoid.

## Anti-risk-control research (2026-11-20)
- wrapper.node strings: NO client-side bot/cheat detector (cheat: 0 hits; "risk" hits are guild risk-member admin features). Detection is server-side scoring.
- Client-supplied signals are all genuine because we run the real QQ binary: QIMEI device fingerprint (MSF setQIMEI36/getQimei36; SSO cmd trpc.qqlog.qqlog_server.Portal.SsoGetQimeiCheckReport = server can request a qimei check report; NodeMiscService.getQimei36), machine guid via loginService.getMachineGuid() (stable, machine-bound), clientVer/appid 537391511/qua V1_LNX_3.2.35_54395_GW_B from real package.json, MSF heartbeat. Telemetry endpoints baked in: galileotelemetry.tencent.com/v1/logs, Beacon.
- This genuine-client route is inherently far less detectable than protocol reimplementations (Lagrange-style forged fingerprints get frozen more often).
- Exposure audit: versions/qua/guid all genuine. Weak points: (1) HK datacenter IP — main residual risk, no cheap fix; (2) hostname was VPS-like "OLD_HOSTNAME" -> devName/hostName now set to "ubuntu" in qqours_main.js (2026-11-20); (3) login churn: 17 logins on 2026-11-20 from dev restarts — production must avoid restarts (watchdog only revives on real crashes).
- Behavior: send queue is sequential/slow, human-paced; no bulk adds/sends. Keep it that way.
- Maintenance: follow official Linux QQ version bumps (stale clients eventually get force-upgraded/kicked). QR+quick login only, never password login from the server.

## D batch notes (2026-11-20)

- Repo flow: edit src/qqours_main.js -> ./deploy.sh -> restart via ops -> git commit.
  WARNING: in tool-call heredocs, a literal backslash-n inside JS strings gets
  mangled by the transport layer into a real newline (SyntaxError). Build such
  strings with chr(92) in the patch script instead.
- Video send: rich path elementType 5; thumb at path with /Ori/ swapped to
  /Thumb/, named <md5>_0.png; ffprobe for duration/size. Files uploaded into
  /data/qq-ours/files must be chown qqrun or the endpoint hits EACCES.
- Voice send: ffmpeg -> wav 24k mono -> silk-wasm (npm dep) encode -> elementType 4.
- Forward: msgService.forwardMsg(msgIds, srcPeer, [dstPeer], []) merges multiple.
- Poke: NOT a kernel service; NapCat uses its own packet subsystem. Deferred.
- Bulletin: TipOffService.getPskey(["qun.qq.com"], true) -> domainPskeyMap,
  then groupService.publishGroupBulletin(group, pskey, {text: encodeURI(t),
  oldFeedsId: "", pinned: 0, confirmRequired: 0}). Verified result 0.
- Essence add: params verified correct (msgSeq/msgRandom probed), but the
  server returns errorCode 11004 "message not supported" for the endpoint
  account own fresh text message. Wired; retest on a human message later.
  Essence list call resolves oddly (no qlog line); low priority.
- Group files: FileAssistantService is the file assistant, not group files;
  group file list likely needs the qun web API. Not wired yet.

## E batch notes (2026-11-20)

- Group files: RichMediaService.getGroupFileList(group, {sortType:1,
  fileCount, startIndex:0, sortOrder:2, showOnlinedocFolder:0}); results
  arrive via MsgListener.onGroupFileInfoUpdate (item[] with folderInfo /
  fileInfo{fileModelId, fileId, fileName, fileSize, busId, uploaderUin}).
  Downloads: downloadFileForFileUuid(peer, fileId, [{fileId, fileName,
  fileSize, fileModelId}]) and downloadFileForFileInfo([info], savePath)
  both return {} and register a flash-transfer task (nt_flash_transfer.db),
  but no payload file was found on disk within minutes. Landing unconfirmed.
- Poke: OIDB 0xED3 sub 1, protobuf {uin: target, groupUin|friendUin: peer,
  ext: 0}. Transport needs NapCat native packet hook (napi2native) inside
  the QQ process — a closed binary component. Not feasible to reproduce
  quickly; stays deferred.
- searchStranger(keyword, 0, {}) no longer crashes (result 0) but its
  result callback was not located (not onSearchStrangerResult; maybe the
  UnifySearch service). searchGroup works fully via onSearchGroupResult.

## F 批（2026-11-20 下午，硬骨头续啃）
- 戳一戳传输层定位（重大进展，未打通）：ECDH 服务不在 session 上，挂在引擎对象 wrapper.NodeIQQNTWrapperEngine.get().getECDHService()；但从 JS 拿到的实例 cpp_impl 无效，sendOIDBRequest/sendSSORequest/sendOIDBRequestV2 一律秒回 result 1006506（本地拒绝，未出网）。wrapper 类直接 new 同样无效（init 断言 impl not valid）。
- 真正的活口：MsgService.sendSsoCmdReqByContend(cmd, content) —— 内核有真实处理：空 content 回 1006504 发送异常；非空回 result 145 请求包解析失败。已试尽 content 形态：OIDB 信封/内层 protobuf 的 hex/base64/Uint8Array/Buffer/latin1 字符串、内层 JSON、信封 JSON、对象直传，均为 145。结论：content 须为内核 MSF 认的完整请求包格式（SSO 头+体），该格式由 QQ 自家 JS 包构建、细节在 major.node 字节码内，属专门逆向活；通用发送任务 msso_send/oidb_send/sso_send 已留在查询队列里，格式一旦破译即可复用。戳一戳发送队列任务 {type:"poke"} 已接好（走 ECDH 版 doPoke，待替换为打通后的通道）。
- 搜人：UnifySearch 服务（session.getUnifySearchService().unifySearch({keyWords})）可直接 promise 返回聚合搜索结果（频道/小程序/游戏中心等分组），已接 unify_search 查询任务（输出分组摘要）。但陌生人/联系人分组不在其默认返回内；SearchListener 只有 onSearchGroupResult/onSearchFileKeywordsResult/onSearchMsgKeywordsResult 三个回调，内核层没有陌生人搜索结果通道。实际需求可用 profile_uin 按号查资料覆盖。

## F1 群文件下载（2026-11-20 下午续啃，结论：结构性卡点）
- 已试尽 RichMedia 全部下载入口：downloadFileForFileUuid / downloadFileForFileInfo / onlyDownloadFile 均返回 {} 且建任务但永不传输（等 25s+ 无落地，nt_flash_transfer.db 为 SQLCipher 加密读不了）；downloadFileForModelId 回 -1 file_model_info_vec empty（面板文件在本地消息库无 model 登记）；getGroupFileInfo 与 getRichMediaFileDir 的 promise 永不落定（勿再调，会挂住该次调用）。
- getGroupSpace 正常（总 10G/已用 4.3G），先调它再下载也无济于事。transGroupFile 可用但那是转存微云（saveBusId 0 + 新 saveFilePath），非本地下载；文件助手列表只有 hello.txt，与群文件无关（FA 的 downloadFile 只管 FA 内文件）。
- 判断：群文件传输引擎在真实客户端里由 UI 进程初始化，我们的壳路线没起这个模块——与戳一戳的包格式同属结构性卡点，非参数问题。实际替代路径已通：让对方把文件发到群里/私聊，走消息 downloadRichMedia 即可落地（A3 已验）。
