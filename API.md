# OneBot 接口（v11 子集）

监听 `127.0.0.1:5700`，配置在 `/data/qq-ours/onebot.json`（0600，token 在里面）。
协议实现零依赖（HTTP + 手写 WebSocket），代码在 `src/onebot.js`，动作实现在 `src/qqours_main.js` 的 `apiCalls`。

```json
{ "enabled": true, "host": "127.0.0.1", "port": 5700, "token": "换成你的" }
```

## 鉴权

两种都支持，token 为空则不校验（不建议）：

```
Authorization: Bearer <token>
GET /health?access_token=<token>
```

未鉴权返回 `{"status":"failed","retcode":1403}`。

## 调用方式

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('/data/qq-ours/onebot.json'))['token'])")

# GET + query
curl -s -H "Authorization: Bearer $TOKEN" 'localhost:5700/get_group_list'

# POST + JSON（推荐）
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST localhost:5700/send_private_msg \
  -d '{"user_id":123456,"message":[{"type":"text","data":{"text":"hi"}}]}'
```

返回统一为 `{"status":"ok","retcode":0,"data":...}`；失败时 `retcode` 非 0 并带 `msg`。

## 已实现

| 接口 | 说明 |
|---|---|
| `get_login_info` | 当前账号 |
| `get_status` / `get_version_info` / `can_send_image` / `can_send_record` | 状态与能力 |
| `send_private_msg` / `send_group_msg` / `send_msg` | 文本 / at / face / reply / image / file / record / video |
| `delete_msg` | 撤回（按 message_id，需在 inbox 出现过） |
| `get_msg` | 从 inbox 取回原消息 |
| `get_friend_list` | 好友（uin、昵称、备注、uid），带 5 分钟缓存 |
| `get_group_list` | 群列表（等 listener 回包，最多 5s） |
| `get_group_member_list` / `get_group_member_info` | 群成员 |
| `get_stranger_info` | 按 QQ 号查资料（原始返回） |
| `get_cookies` | qun.qq.com 的 p_skey |
| `set_group_kick` / `set_group_ban` / `set_group_whole_ban` | 踢人 / 禁言 / 全员禁言 |
| `set_group_card` / `set_group_admin` | 名片 / 管理员 |
| `set_group_leave` | 退群（`quitGroup`） |
| `get_group_info` | 群资料（以群列表缓存为准，先调一次 `get_group_list`） |
| `set_group_name` | 改群名（`modifyGroupName`，签名待实测确认） |
| `delete_group_file` | 删群文件（`RichMediaService.deleteGroupFile`） |
| `add_friend` | 加好友（`reqToAddFriends`，返回里带实际成功的方法名） |
| `delete_friend` | 删好友（`delBuddy`） |
| `set_friend_remark` | 改备注（`setBuddyRemark`，会清好友缓存） |
| `set_friend_category` | 好友分组（`setBuddyCategory`） |
| `mark_msg_as_read` | 标记已读（`setMsgRead`，单参数对象） |
| `debug_probe` | 探针：列出任意内核服务的方法名，排障用 |
| `set_friend_add_request` | 好友申请审批，flag 格式 `friendUid|reqTime` |
| `set_group_add_request` | 入群审批，flag 格式 `seq|type|groupCode` |

## 未实现（调用会返回明确原因）

`upload_group_file`（`onlyUploadFile` / `uploadRMFileWithoutMsg` 已定位，签名与回调未验证）、
`get_group_honor_info`、`send_like`（需 OIDB，与戳一戳同路）、`get_recent_contact`。

## 运行时开关（`/data/qq-ours/config.json`，可选）

```json
{ "auto_download_image": true, "rate_limit_per_min": 30 }
```

- `auto_download_image`：收到图片自动 `downloadRichMedia`，落地到 `files/inbox/`（默认开）
- `rate_limit_per_min`：HTTP 发送接口的每分钟上限，超了返回 1500 并说明（默认 30）

## 事件推送（WebSocket）

```
ws://127.0.0.1:5700/?access_token=<token>
```

- `message`：`message_type` 为 `private` / `group`，`message` 是消息段数组（text/at/image/file/record/video/face/reply/json/forward）
- `meta_event.heartbeat`：每 30 秒一次
- `notice.offline`：被踢下线时推送

## 与文件队列的关系

文件队列（`send_queue.jsonl` / `query_queue.jsonl`）继续保留做兜底与批处理；HTTP 接口是同步调用，适合即时交互。
两者共用同一套底层服务，不会互相干扰。

## 已知限制

- `message_id` 返回**字符串**：19 位 msgId 超出 JS 安全整数，用数字会丢精度
- 私聊需要先有好友关系（内核要 uid，不是 QQ 号）；群聊直接用群号
- 媒体段只接受服务器本地路径（`/data/qq-ours/files/...` 之外也可，但请自行控制权限）
