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

## F2 续（2026-11-20 午后，GitHub 取证）
- 在 GitHub 找到同路插件 ESEAbsolute/qwqnt-poke 的 nativepoke.ts 与 NapCat 现行 SendPoke/nativeClient 源码，确认正确包格式：cmd=OidbSvcTrpcTcp.0xED3_1（ED3 大写）、信封 isReserved=1（OidbBase.build 默认 isUid=true）、data=Buffer.from(信封 protobuf)。逐字节与 NapCat 的 napcat-protobuf 编码一致。
- 按正解实测仍回 145 请求包解析失败。结合本机内核返回形状是 {result,errMsg,rsp}（与 qwqnt/NapCat 预期的 {rspbuffer} 不同），判断 9.9.37/3.2.35 这版改了 JS 发送通道的内部契约；两个同路项目发包前都要求 napi2native 原生 hook 就绪，社区对这版（SnowCat 文）也是走原生 hook。
- napi2native.linux.x64.node 现成模块在参考源码里有（23MB），但其偏移表 napi2native.json 共 124 个版本、无 3.2.35-54395（Linux）——本版 send/recv 偏移无人发布，需对 wrapper.node 做特征扫描逆向，属专场工作。
- 事故：同日 12:39 账号被踢下线（登录已失效），主因疑为当日功能调试重启过频（登录 churn）。已修潜伏 bug：onKickedOffLine 误用未定义的 writeStatus（应为 status），此前被踢不会更新 status.json、健康巡检也报不出（commit f68485b）。用户已重新扫码恢复在线。

## F2 终局更正（2026-11-20 19:11）
- 19:02 应用户要求在全新扫码登录态上复测：hook.json 于进程启动时装载（initHook -> true），msso_send 以 mode=buffer 发送 OidbSvcTrpcTcp.0xED3_1 信封（isReserved=1，内层 pokePayload(OWNER_UIN) C2C）——返回 {result:0, errMsg:"success", rspbuffer 非空（含 trpc-sso 与账号号）}。戳一戳打通。
- 此前四次 150「本请求无权限」均发生在 12:39 被踢后恢复的会话上，该会话当日 17:55 又静默失效——判断 150 是那条已降级/被标记会话的权限状态，不是命令本身被封。教训：包格式与通道自始正确，权限随会话状态变。
- 待办：发送队列 {type:"poke"} 仍走已死的 ECDH doPoke，应改走 msso_send 信封路径（需改码+重启，等用户点头再动，避免无谓重启）。

## G 批（2026-11-21 凌晨）— 稳定性加固 + 登录免扫码 + 环境伪装

### 事故背景
- 16:20 起机器反复重启，16:25 全部端口 refused→timeout，外部四节点探测确认机房侧故障
  （极点云 香港5区 CN2 流量云 整节点不可达，管理在群里回「给机房反馈了」）。与本地配置无关。
- 恢复后 status=phase:qrcode：进程活着但没登录，旧 watchdog 只查进程存在，永远不会自愈。

### P0（已合入 src/qqours_main.js）
- 队列改为 append-only + 字节游标消费（readNewLines）。原来 readFileSync 后 writeFileSync("")
  非原子，读取与清空之间写入的行静默丢失。半行走下次，文件被轮转时游标归零。
- 发送队列任何 job.path 先过 safePath()，必须落在 /data/qq-ours/files 子树，否则拒绝 + deadLetter。
  堵掉「能写队列 = 能发任意文件」的路径穿越。
- send/query 失败写 dead_letter.jsonl，不再只 log 一句。

### P1（登录免扫码）
- 启动阶梯：quickLoginWithUin ×3（每次等 30s）→ 第 2 次失败自动 restore_login.sh 回滚最近快照
  → 三次都失败才 status=need_scan + 出二维码。
- 登录成功后 45s 自动 backup_login.sh 快照（nt_data + global，25MB，保留 3 份）。
- ops/stop.sh 优雅停止（SIGTERM→40s→KILL），退出前再拍一次快照。强杀是票据损坏的主因。
- systemd unit qqours.service（oneshot + RemainAfterExit）；存活由 watchdog 兜底
  （RELAUNCH_ON_DEAD 标记），StartLimit 防止崩溃循环反复制造登录记录。
- watchdog 只看不抢：process_gone / stuck_qrcode(>10min) / kicked / need_scan → alerts.jsonl。

### 环境伪装（服务端可见的部分）
- hostname OLD_HOSTNAME → ubuntu-desktop；loginService.hostName 与 deviceInfo.devName 同步；
- 时区 UTC → Asia/Shanghai；LANG/LC_ALL → zh_CN.UTF-8；Xvfb 1280x1024 → 1920x1080@96dpi；
- deviceInfo vendorName Linux → LENOVO，vendorOsName Linux → Ubuntu；
- 新增 presenceLoop：在线/离开/忙碌/勿扰按本地时间漂移（夜间以离开为主），8–30 分钟随机一次；
- qqrun 家目录补齐 Desktop/Downloads/Pictures 等，避免像服务账号。

### 登录态失效的真相
- 2026-11-21 00:34 实测 quickLoginWithUin 三次全返回 result=3「登录态已失效，请重新登录」，
  说明票据已被服务端作废（12:37 那次 KICKED OFFLINE 的后遗症），本地任何回滚都无效 → 必须扫一次。
- 00:37 扫码成功，00:38 首份快照落盘，00:39 presenceLoop 生效（presence -> 60）。
  之后的重启应走快登，不再需要扫码，前提是：不 pkill、不在短时间内反复重启。

### 订阅节点评估（用户提供，51 个节点）
- 22 个 Cloudflare 前置 vless + 20 个微软云(AS8075) tuic = 82% 是机场重灾区，出口 IP 高度共享，
  挂 QQ 比香港机房直连更危险；TCP 实测这些节点 91–270ms。
- 非 CF/非微软云的只有 7 个落地：英国 AS204044 Packet Star ×2、日本 AS137409 GSL ×2、
  美国 AS53767 iCastCenter、美国 AS14315 1GSERVERS、美国 AS62610 Zenlayer。
- 结论：没有一个适合挂 QQ（全 IDC，且跨国 IP 跳变本身触发异地保护）。
  真正合适的只有国内家宽/移动 IP（自家宽带反向隧道或家宽 NAT），且切换要一次性固定，不反复漂。
