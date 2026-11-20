# qq-ours — 自研 QQ 协议端

私用项目。路线：官方 Linux QQ 本体 + 自研 Electron 主进程入口，在 QQ 进程内
dlopen wrapper.node 调用内核服务（NapCat v4.18.42 归档源码仅作逆向参考，
运行代码全部自研）。

首次使用先看 `CONFIG.md`（账号/群/服务器地址都换成了占位符，替换后即可运行）。

## 架构

- `src/qqours_main.js` — 唯一入口源码（引擎/登录/会话/消息/群/好友/资料全功能）
- `deploy.sh` — 把源码部署进 /opt/QQ/resources/app/ 并校验 package.json 入口

运维（`ops/`）：

- `ops/start.sh` — 以 qqrun + Xvfb 启动端（幂等；带 TZ/LANG/屏幕伪装参数）
- `ops/stop.sh` — 优雅停止：SIGTERM → 等 mmkv 落盘 → 超时才 KILL → 拍快照
- `ops/backup_login.sh` — 登录态快照（nt_data + global），保留最近 3 份
- `ops/restore_login.sh` — 快登失败时回滚最近快照
- `ops/watchdog.sh` — 只告警不抢活：进程 / phase / need_scan 异常写 alerts.jsonl
- `ops/qqours.service` — systemd unit（oneshot + RemainAfterExit，存活由 watchdog 兜底）
- `ops/camouflage.sh` — 宿主机伪装成普通 Ubuntu 桌面（主机名/时区/locale/家目录）
- `ops/proxy_qq.sh` — 按 uid 分流：只让 qqrun 的流量走 SOCKS5（可选）

桥（`bridge/`）：

- `bridge/bridge_claim.py` — 服务器侧认领器：只放行号主私聊进桥队列
- `bridge/qq-watch.sh` — Muse 侧 hook 脚本副本（原件在助手 VM ~/hooks/scripts/）

历史迁移脚本（`tools/migrations/`，已执行，仅存档）：

- `apply_p1.sh`、`dsh_patch_p0.py`、`dsh_patch_p1.py` — 2026-11-21 那次 P0/P1 改造

## 运维要点（重要）

- 重启一律 `systemctl restart qqours`，会走 `ExecStop=stop.sh` 正常落盘。
  **禁止 pkill / deploy.sh restart**：强杀会写坏登录票据，下次就要人工扫码。
- 登录态快照在 `/data/qq-ours/login_snapshots/`，25MB/份，保留 3 份，不入库。
- 启动走快登阶梯：quickLogin×3 → 第 2 次失败回滚快照 → 都失败才出二维码（phase=need_scan）。
- 告警看 `/data/qq-ours/alerts.jsonl`；待人工处理的有 `kicked` / `need_scan` / `stuck_qrcode`。
- 发件/查询队列是 append-only + 字节游标消费，不要手工 `> send_queue.jsonl` 截断。
- 附件路径必须落在 `/data/qq-ours/files/` 下，其余路径会被拒绝并记 dead_letter。

## 数据面（全部 gitignore，永不入库）

- `inbox.jsonl` 全部收到的消息；`send_queue.jsonl` 发送队列
- `query_queue.jsonl` / `query_results.jsonl` 查询与管理动作
- `dead_letter.jsonl` 失败任务；`alerts.jsonl` 需要人处理的异常
- `login_snapshots/` 登录态快照；登录态本体在 /home/qqrun/.config/QQ

## 安全边界

- 仅号主（OWNER_UIN）私聊可唤醒 Muse 桥；QQ 侧只聊天/查询，
  付款、改密、删除、对外发消息等敏感动作一律回主聊天确认
- 踢人等管理动作只在主聊天由号主点名后执行

## 防风控要点

真客户端路线：qimei/guid 等设备信号全部原装。忌频繁重启登录；
设备名已设为普通主机名（ubuntu-desktop）；主机时区/语言为 Asia/Shanghai + zh_CN.UTF-8；
在线状态按作息漂移；版本跟随官方 Linux QQ 更新。
最大残余风险是机房 IP，详见 V1_NOTES.md 的 Anti-risk-control 与 G 批。
