# 接口覆盖审计（2026-11-21）

对照内核 `wrapper.node` 实际暴露的能力（75 个服务 / 约 70 个 `get*Service` 入口，
当前只用了 13 个）与 OneBot v11 常见接口，盘点已通、可补、结构性卡住三类。

## 结论

- **收发主链已通**：文本/图片/文件/视频/语音/表情/回复/@/转发/撤回/历史/下载
- **对外接口层没做**：现在只有文件队列（append-only jsonl），没有 HTTP/WS，
  外部必须 ssh 进来轮询 —— 这是"接口没搞好"的核心，不是缺某一两个 API
- **接收侧解析太浅**：除 text/pic/file 外，其余元素一律记成 `[elN]`，语音/视频/@/合并转发都拿不到结构
- 群管理、好友管理各缺一半；群文件下载仍是结构性卡点

## 一、对外接口层（最大缺口）

| 项 | 状态 |
|---|---|
| 发送/查询队列（append-only + 游标） | ✅ 已通 |
| HTTP API | ✅ 已实现（OneBot v11 子集，见 API.md） |
| WebSocket 事件推送 | ✅ 已实现（message / heartbeat / notice） |
| 鉴权 token | ✅ Bearer + access_token，配置在 onebot.json |
| 请求-响应关联 | ✅ HTTP 同步返回，失败带 retcode/msg |
| 幂等（job.id 去重） | ❌ 队列侧仍无（HTTP 侧天然一次一调） |
| 限速 / 配额 | ✅ HTTP 发送侧 30 条/分钟（config.json 可调） |

## 二、接收侧元素解析

已通（2026-11-21 补齐）：`text(1)`、`at`、`pic(2)`、`file(3)`、`record(4)`、`video(5)`、
`face(6)`、`reply(7)`、`json(8)`、`mface(9)`、`forward(10)`，统一映射为 OneBot 消息段；
同一条消息按 msgId 去重（LRU 3000），不再 recv/update 双写。

缺失（内核字段都在，只是没解）：

- 语音 `4`、视频 `5`、表情 `6`、合并转发 `8/9`、markdown/卡片、位置、闪照
- 图片/视频**自动下载**（现在要手工投 `download` 任务）
- 语音 `canConvert2Text` 字段已有，未接转文字

## 三、消息操作

已通：text / pic / file / video / ptt / face / reply / text_at / forward / recall / download / history

缺：

| 能力 | 内核方法 | 状态 |
|---|---|---|
| 标记已读 | `reportMsgRead`（未定位到确切名） | ❌ |
| 单条消息获取 | `getMsgsByMsgId`（已在 reply/download 内部用） | 未暴露成 job |
| 合并转发解析 | `getMsgsByMsgId` 递归 | ❌ |
| 本地删除消息 | `deleteMsg`（未定位） | ❌ |

## 四、群管理

已通：踢人、单人禁言、全体禁言、改名片、改角色、群列表、成员列表、群空间、
群文件列表、公告发布、精华添加/列表（残）、入群申请列表/审批

缺（内核有方法，未接）：

| 能力 | 内核方法 |
|---|---|
| 退群 | `quitGroup` |
| 改群资料/群名 | `modifyGroupExtInfo` |
| 单成员信息 | `getMemberExtInfo` |
| 群文件上传 | 需走 RichMedia 上传链（未验证） |
| 群文件删除 / 删文件夹 | `deleteGroupFile` / `deleteGroupFolder` |
| 管理员列表 / 禁言列表 | `onGroupAdminListUpdate` 回调已挂，未落数据 |
| 群公告列表（只发布了） | 未接 |

结构性卡点（不是没写，是路线限制）：

- 群文件**下载**：`downloadFileForFileUuid/FileInfo/onlyDownloadFile` 全部只建任务不传输（F1 结论）
- 群精华添加：服务端回 `11004 message not supported`（对人类消息未复测）
- 戳一戳发送：仍走已死的 `ECDH.sendOIDBRequest`，应改 `msso_send` 信封（P2 待办）

## 五、好友 / 资料

已通：好友列表、好友申请列表/审批、资料查询（uid/uin）、资料卡点赞、长昵称、头像设置、
搜群、搜陌生人（回调缺失）

缺（内核有方法，未接）：

| 能力 | 内核方法 |
|---|---|
| 发起加好友 | `addBuddy` |
| 删除好友 / 删请求 | `delBuddyReq` |
| 改好友备注 | `setBuddyRemark` |
| 好友分组管理 | `setBuddyCategory` |
| 黑名单 | 未定位 |

## 六、完全没碰的内核服务（按实用度）

1. `RecentContactService` — 最近会话/未读，做"消息路由"很有用
2. `OnlineStatusService` — 在线状态详情（当前只用了 setStatus）
3. `StorageCleanService` — 缓存清理（长期跑必备）
4. `RobotService`、`MiniAppService`、`GuildMsgService` — 频道/机器人/小程序消息
5. `EmojiService` / `PersonalAlbumService` — 表情包、相册

## 七、工程质量

- 单文件 867 行，无模块拆分、无单元测试（只 `node --check`）
- `inbox.jsonl` 双写：`onRecvMsg` 与 `onMsgInfoListUpdate` 都记一次，靠 `src` 区分
- 日志无轮转；无 metrics / 健康检查端点
- 无消息数据库，历史只能靠 `inbox.jsonl` 线性扫

## 建议优先级

**P0（已完成 2026-11-21）**
1. ✅ HTTP + WS 接口层（OneBot v11 子集）+ token 鉴权
2. ✅ 接收侧元素补全（record/video/at/reply/forward/json）+ msgId 去重
3. ✅ 图片自动下载开关（config.json `auto_download_image`）

**P1（大部分已完成 2026-11-21）**
4. 群管理：✅ 退群/群资料/单成员/删群文件/文件消息发送；❌ 真正上传到群文件空间
5. 好友管理：✅ 加/删/备注/分组
6. ✅ 标记已读（setMsgRead）+ 发送限流；❌ 队列侧幂等

**P2**
7. 群文件下载改走 `qun.qq.com` web API（`getPskey` 已有）
8. 戳一戳改 `msso_send` 信封
9. 精华/陌生人搜索复测
