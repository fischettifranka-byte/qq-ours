#!/bin/bash
# 只让 qqrun 这个 uid 的流量走 SOCKS5，其余服务直连（IP 是最大的破绽）
# 依赖：tun2socks 或 redsocks，按你的代理类型二选一
set -eu
PROXY_HOST="${PROXY_HOST:?set PROXY_HOST}"
PROXY_PORT="${PROXY_PORT:?set PROXY_PORT}"
PROXY_USER="${PROXY_USER:-}"
PROXY_PASS="${PROXY_PASS:-}"

echo "[1] nftables: 标记 qqrun 出站流量"
QQ_UID=$(id -u qqrun)
nft add table inet qqroute 2>/dev/null || true
nft 'add chain inet qqroute out { type route hook output priority mangle; policy accept; }' 2>/dev/null || true
nft add rule inet qqroute out meta skuid $QQ_UID meta mark set 0x233 2>/dev/null || true
nft add rule inet qqroute out meta mark 0x233 ip daddr $PROXY_HOST tcp dport $PROXY_PORT accept 2>/dev/null || true

echo "[2] ip rule/route: 打标包走回环 tun"
ip rule add fwmark 0x233 lookup 233 2>/dev/null || true
ip route add default dev tun0 table 233 2>/dev/null || true

echo "[3] tun2socks 前台跑这个（放 systemd 里）："
echo "tun2socks -device tun0 -proxy socks5://${PROXY_USER:+$PROXY_USER:$PROXY_PASS@}$PROXY_HOST:$PROXY_PORT -interface eth0"
echo
echo "验证： su qqrun -c 'curl -s https://ipinfo.io/ip'  应显示代理出口"
