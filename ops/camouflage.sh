#!/bin/bash
# 宿主机伪装成一台普通 Ubuntu 桌面（服务端能看到的设备信号以此为准）
set -eu
NAME="${1:-ubuntu-desktop}"
echo "[1] 主机名 -> $NAME （原来 OLD_HOSTNAME 一眼 VPS）"
hostnamectl set-hostname "$NAME"
grep -q "127.0.1.1" /etc/hosts && sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$NAME/" /etc/hosts || echo "127.0.1.1	$NAME" >> /etc/hosts

echo "[2] 时区 -> Asia/Shanghai （UTC 机房时间是明显信号）"
timedatectl set-timezone Asia/Shanghai

echo "[3] 中文 locale（正常国内桌面用户都有）"
export DEBIAN_FRONTEND=noninteractive
if ! locale -a 2>/dev/null | grep -qi "zh_CN.utf8"; then
  apt-get install -y -qq locales >/dev/null 2>&1 || true
  sed -i 's/^# *zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null || true
  grep -q '^zh_CN.UTF-8 UTF-8' /etc/locale.gen 2>/dev/null || echo 'zh_CN.UTF-8 UTF-8' >> /etc/locale.gen
  locale-gen >/dev/null 2>&1 || true
fi
update-locale LANG=zh_CN.UTF-8 >/dev/null 2>&1 || true

echo "[4] 桌面用户目录（qqrun 家目录别像服务账号）"
for d in Desktop Downloads Pictures Documents Music Videos; do
  install -d -o qqrun -g qqrun "/home/qqrun/$d" 2>/dev/null || true
done
cat > /home/qqrun/.config/user-dirs.dirs <<'EOD' 2>/dev/null || true
XDG_DESKTOP_DIR="$HOME/Desktop"
XDG_DOWNLOAD_DIR="$HOME/Downloads"
XDG_PICTURES_DIR="$HOME/Pictures"
XDG_DOCUMENTS_DIR="$HOME/Documents"
XDG_MUSIC_DIR="$HOME/Music"
XDG_VIDEOS_DIR="$HOME/Videos"
EOD
chown -R qqrun:qqrun /home/qqrun/.config 2>/dev/null || true

echo "[5] 结果"
hostnamectl --static; timedatectl | head -3
