# 配置占位符

为了让仓库可以公开，代码里所有涉及账号、群、服务器地址的字面量都换成了占位符。
跑起来之前把这些替换成你自己的值即可。

> 这些占位符是纯文本，**不是环境变量**，直接搜索替换就行。

## 账号与社交关系

| 占位符 | 含义 | 用在哪 |
|---|---|---|
| `MY_UIN` | 跑这个端点的 QQ 号（本机登录的账号） | `bridge/bridge_claim.py` 的过滤逻辑、日志示例 |
| `OWNER_UIN` | 号主 QQ 号，唯一允许唤醒 Muse 桥的人 | `bridge/bridge_claim.py` 的 `OWNER` 常量 |
| `ACCOUNT_NICK` | 本机账号昵称 | V1_NOTES 里的示例描述 |
| `OWNER_NICK` | 号主昵称 | 同上 |
| `FRIEND_A_UIN` … `FRIEND_D_UIN` | 好友 QQ 号 | V1_NOTES 的 B2 段 |
| `FRIEND_A_NICK` … `FRIEND_E_NICK` | 好友昵称 | 同上 |
| `GROUP_CODE` | 测试用群号 | V1_NOTES 的 A2/B1 段 |

## 服务器

| 占位符 | 含义 | 用在哪 |
|---|---|---|
| `SERVER_HOST` | 部署机的 IP 或域名 | `bridge/qq-watch.sh` 的 ssh 行 |
| `SSH_USER` | ssh 登录用户名 | `bridge/qq-watch.sh` 的密钥路径 `/home/SSH_USER/.ssh/id_ed25519` |
| `OLD_HOSTNAME` | 换伪装前的原主机名 | `ops/camouflage.sh` 的注释、V1_NOTES |

## 不用改的

| 项 | 说明 |
|---|---|
| `appid 537391511`、`qua V1_LNX_*`、`clientVer 3.2.35-54395` | 官方 Linux QQ 安装包自带，跑真客户端就是原装值，改了反而不对 |
| `devName` / `hostName` | 由环境变量 `QQ_DEV_NAME` 控制，默认 `ubuntu-desktop` |
| `/data/qq-ours` | 运行时数据目录，按需改路径 |

## 最小可跑清单（三条）

1. `bridge/bridge_claim.py` 里 `OWNER = "OWNER_UIN"` → 换成你的 QQ 号
2. `bridge/qq-watch.sh` 里 `root@SERVER_HOST` 和 `/home/SSH_USER/...` → 换成你的服务器与用户
3. 想改设备名：启动前 `export QQ_DEV_NAME=你的主机名`
