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
