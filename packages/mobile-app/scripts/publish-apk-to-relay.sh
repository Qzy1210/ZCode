#!/bin/bash
# 把 Android APK 发布到自托管 relay 的静态目录,并给出可直接在手机上下载的链接。
#
# 为什么走 relay 的 /assets/ 路径:relay 只把 `web-dist/assets/**` 当文件服务,其它路径
# 一律回 index.html(SPA 兜底);该前缀的响应头是 `immutable` 长期缓存,因此**文件名必须
# 带版本/提交号**——用固定名会让手机浏览器缓存旧包一年,反复装到老版本。
#
# 用法:
#   bash packages/mobile-app/scripts/publish-apk-to-relay.sh              # 先构建再发布
#   bash packages/mobile-app/scripts/publish-apk-to-relay.sh --no-build   # 复用已构建的 APK
#
# 可覆盖的环境变量(默认即当前部署):
#   ZCODE_RELAY_SSH=root@49.233.105.26
#   ZCODE_RELAY_DIR=/root/zcode-relay
#   ZCODE_RELAY_URL=http://49.233.105.26:8787
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
RELAY_SSH="${ZCODE_RELAY_SSH:-root@49.233.105.26}"
RELAY_DIR="${ZCODE_RELAY_DIR:-/root/zcode-relay}"
RELAY_URL="${ZCODE_RELAY_URL:-http://49.233.105.26:8787}"
APK="$HERE/android/app/build/outputs/apk/release/app-release.apk"

if [ "${1:-}" != "--no-build" ]; then
  echo "==> 1/4 构建 release APK"
  bash "$HERE/scripts/build-android-release.sh"
else
  echo "==> 1/4 跳过构建(--no-build)"
fi
[ -f "$APK" ] || { echo "缺少 APK:$APK"; exit 1; }

echo "==> 2/4 生成带版本的文件名"
VERSION="$(python3 -c "import json;print(json.load(open('$HERE/app.json'))['expo']['version'])")"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
NAME="zcode-mobile-${VERSION}-${COMMIT}-$(date +%Y%m%d%H%M).apk"
LOCAL_SHA="$(shasum -a 256 "$APK" | awk '{print $1}')"

echo "==> 3/4 上传到 $RELAY_SSH:$RELAY_DIR/web-dist/assets/$NAME"
ssh -o BatchMode=yes "$RELAY_SSH" "mkdir -p $RELAY_DIR/web-dist/assets"
scp -o BatchMode=yes "$APK" "$RELAY_SSH:$RELAY_DIR/web-dist/assets/$NAME"

echo "==> 4/4 用公网 URL 回读校验(字节数与 SHA-256)"
URL="$RELAY_URL/assets/$NAME"
TMP="$(mktemp -t zcode-apk-verify)"
trap 'rm -f "$TMP"' EXIT
# relay 只允许 GET(HEAD 会 405),所以这里整包下载校验。
curl -fsS -o "$TMP" "$URL"
REMOTE_BYTES="$(wc -c < "$TMP" | tr -d ' ')"
REMOTE_SHA="$(shasum -a 256 "$TMP" | awk '{print $1}')"
LOCAL_BYTES="$(wc -c < "$APK" | tr -d ' ')"
if [ "$REMOTE_SHA" != "$LOCAL_SHA" ] || [ "$REMOTE_BYTES" != "$LOCAL_BYTES" ]; then
  echo "校验失败:本地 ${LOCAL_BYTES}B/$LOCAL_SHA,远端 ${REMOTE_BYTES}B/$REMOTE_SHA"
  exit 1
fi

cat <<EOF

完成。手机浏览器打开以下链接即可下载安装:

  下载链接: $URL
  文件大小: $LOCAL_BYTES 字节
  SHA-256: $LOCAL_SHA
  构建来源: commit $COMMIT (版本 $VERSION)

提示:
- 首次安装需在手机上允许"安装未知应用"(华为:设置 → 安全 → 更多安全设置 → 安装外部来源应用)。
- 当前 relay 是明文 HTTP,公网下载 APK 存在被中间人替换的风险;校验上表的 SHA-256,
  或给 relay 配上 TLS(RELAY_TLS_CERT/RELAY_TLS_KEY)后再分发。
EOF
