#!/bin/bash
# 构建 Android release APK(真机自装)。
#
# 为什么需要脚本:每次 expo prebuild 都会把 android/ 重置回模板态,本地构建依赖的
# 四处补丁(sdk.dir / NDK / JDK17 / ABI)必须重打,见 scripts/patch-android-build.mjs。
#
# 用法:
#   bash packages/mobile-app/scripts/build-android-release.sh          # 构建
#   bash packages/mobile-app/scripts/build-android-release.sh --install# 构建并 adb 安装
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$PATH:$ANDROID_HOME/platform-tools"
# NDK 28 的 C++ 任务与 JDK 21 不兼容,统一用本地 JDK 17(见 patch 脚本)。
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"

cd "$HERE"
echo "==> 1/4 expo prebuild"
npx expo prebuild --platform android --no-install

echo "==> 2/4 重打本地构建补丁"
node scripts/patch-android-build.mjs

echo "==> 3/4 gradle assembleRelease"
(cd android && ./gradlew assembleRelease --console=plain)

APK="$HERE/android/app/build/outputs/apk/release/app-release.apk"
echo "==> 4/4 产物: $APK"
ls -la "$APK"

if [ "${1:-}" = "--install" ]; then
  echo "==> adb install -r"
  adb install -r "$APK"
  adb shell dumpsys package dev.zcode.mobile | grep -E "versionName|lastUpdateTime" | head -2
fi
