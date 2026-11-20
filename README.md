# qq-ours — 自研 QQ 协议端

私用项目。路线：官方 Linux QQ 本体 + 自研 Electron 主进程入口，在 QQ 进程内
dlopen wrapper.node 调用内核服务（NapCat v4.18.42 归档源码仅作逆向参考，
运行代码全部自研）。

## 架构

- `src/qqours_main.js` — 唯一入口源码（引擎/登录/会话/消息/群/好友/资料全功能）
- `deploy.sh` — 把源码部署进 /opt/QQ/resources/app/ 并校验 package.json 入口
- `ops/start.sh` — 以 qqrun + Xvfb 启动端（幂等）
- `ops/watchdog.sh` — 进程看门狗（服务器 crontab 每 2 分钟）
- `bridge/bridge_claim.py` — 服务器侧认领器：只放行号主私聊进桥队列
- `bridge/qq-watch.sh` — Muse 侧 hook 脚本副本（原件在助手 VM ~/hooks/scripts/）
- `V1_NOTES.md` — 接口与防风控研究笔记

## 数据面（全部 gitignore，永不入库）

- `inbox.jsonl` 全部收到的消息；`send_queue.jsonl` 发送队列
- `query_queue.jsonl` / `query_results.jsonl` 查询与管理动作
- 登录态在 /home/qqrun/.config/QQ

## 安全边界

- 仅号主（OWNER_UIN）私聊可唤醒 Muse 桥；QQ 侧只聊天/查询，
  付款、改密、删除、对外发消息等敏感动作一律回主聊天确认
- 踢人等管理动作只在主聊天由号主点名后执行

## 防风控要点

真客户端路线：qimei/guid 等设备信号全部原装。忌频繁重启登录；
设备名已设为普通主机名 ubuntu；版本跟随官方 Linux QQ 更新。
详见 V1_NOTES.md 的 Anti-risk-control 一节。
