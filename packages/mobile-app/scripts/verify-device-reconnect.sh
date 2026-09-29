#!/bin/bash
# 真机验证"断线 → 自动重连":重启 relay,逐秒记录手机上的重连横条与恢复情况。
#
# 用法:
#   bash packages/mobile-app/scripts/verify-device-reconnect.sh [--install] [--seconds 20]
#
# 环境变量:
#   RELAY_SSH   ssh 目标(默认 root@49.233.105.26)
#   RELAY_URL   relay 健康检查地址(默认 http://127.0.0.1:8787,在 SSH 侧执行)
#
# 说明:手机需已 USB 连接并解锁;--install 会先装 android/app/build 里的 release 包。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$PATH:$ANDROID_HOME/platform-tools"
RELAY_SSH="${RELAY_SSH:-root@49.233.105.26}"
RELAY_URL="${RELAY_URL:-http://127.0.0.1:8787}"

INSTALL=0
SECONDS_TO_WATCH=20
while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --seconds) SECONDS_TO_WATCH="$2"; shift ;;
    *) echo "未知参数:$1"; exit 2 ;;
  esac
  shift
done

if ! adb devices | grep -q "device$"; then
  echo "未检测到 USB 设备:请连接手机并开启 USB 调试"
  exit 1
fi

if [ "$INSTALL" = "1" ]; then
  APK="$HERE/android/app/build/outputs/apk/release/app-release.apk"
  echo "==> 安装 $APK"
  adb install -r "$APK" || exit 1
fi

# 横条正文优先匹配"连接已断开"(按钮文字"停止重连"也含"重连",不能先取到它)
banner() {
  adb shell uiautomator dump /sdcard/reconnect-probe.xml >/dev/null 2>&1
  adb shell cat /sdcard/reconnect-probe.xml 2>/dev/null |
    tr '>' '\n' | grep -o 'text="[^"]*连接已断开[^"]*"' | head -1 | sed 's/text=//g; s/"//g'
}

top_text() {
  adb shell uiautomator dump /sdcard/reconnect-probe.xml >/dev/null 2>&1
  adb shell cat /sdcard/reconnect-probe.xml 2>/dev/null |
    tr '>' '\n' | grep -o 'text="[^"]*"' | grep -v 'text=""' | head -3 | sed 's/text=//g' | tr '\n' '|'
}

echo "==> 断开前状态:$(top_text)"
echo "==> 重启 relay($RELAY_SSH)"
ssh -o BatchMode=yes "$RELAY_SSH" "systemctl restart zcode-relay" || { echo "relay 重启失败"; exit 1; }

for i in $(seq 1 "$SECONDS_TO_WATCH"); do
  sleep 1
  line="$(banner)"
  [ -z "$line" ] && line="(无横条) $(top_text)"
  printf 't+%02ss %s\n' "$i" "$line"
done

echo "==> 结束:$(top_text)"
echo "判定:横条应只出现于 relay 不可用期间;网络恢复后应自动消失且内容继续更新(无需任何手动操作)。"
