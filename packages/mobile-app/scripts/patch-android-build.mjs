/*
 * prebuild 会把 android/ 重置为模板态,本地构建所需补丁在这里统一重打:
 * 1) local.properties 的 sdk.dir
 * 2) rootProject.ext.ndkVersion 覆盖为已装 NDK(RN 默认 27.1 在受限网络下无法下载)
 * 3) reactNativeArchitectures 只保留 arm64-v8a(真机唯一需要,构建时间/包体积大幅下降)
 * 用法:expo prebuild --platform android 之后、gradle 之前执行本脚本。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const androidDir = resolve(import.meta.dirname, "../android");
const NDK_VERSION = "28.2.13676358";
const SDK_DIR = process.env.ANDROID_HOME?.trim() || join(homedir(), "Library/Android/sdk");

// 1) sdk.dir
writeFileSync(join(androidDir, "local.properties"), `sdk.dir=${SDK_DIR}\n`, "utf8");

// 2) NDK 覆盖:必须在 RN 插件 apply 之后赋值,否则被插件默认值覆盖
const buildGradlePath = join(androidDir, "build.gradle");
let buildGradle = readFileSync(buildGradlePath, "utf8");
if (!buildGradle.includes(`rootProject.ext.ndkVersion = "${NDK_VERSION}"`)) {
  const anchor = 'apply plugin: "com.facebook.react.rootproject"';
  if (!buildGradle.includes(anchor)) {
    throw new Error("build.gradle 中未找到 RN 插件 apply 锚点,请检查模板是否变化");
  }
  buildGradle = buildGradle.replace(
    anchor,
    `${anchor}\n\n// 本地构建补丁(见 scripts/patch-android-build.mjs)\nrootProject.ext.ndkVersion = "${NDK_VERSION}"`,
  );
  writeFileSync(buildGradlePath, buildGradle, "utf8");
}

// 3) app 模块的 ndkVersion 直接写死:根 ext 覆盖对部分模块的 AGP 解析不生效,
//    只有 app/build.gradle 的字面量能确保所有 C++ 任务使用已装 NDK。
const appBuildGradlePath = join(androidDir, "app/build.gradle");
let appBuildGradle = readFileSync(appBuildGradlePath, "utf8");
if (appBuildGradle.includes("ndkVersion rootProject.ext.ndkVersion")) {
  appBuildGradle = appBuildGradle.replace(
    "ndkVersion rootProject.ext.ndkVersion",
    `ndkVersion "${NDK_VERSION}"`,
  );
  writeFileSync(appBuildGradlePath, appBuildGradle, "utf8");
}

// 4) ABI 裁剪
const gradlePropsPath = join(androidDir, "gradle.properties");
const props = readFileSync(gradlePropsPath, "utf8").replace(
  /^reactNativeArchitectures=.*$/m,
  "reactNativeArchitectures=arm64-v8a",
);
writeFileSync(gradlePropsPath, props, "utf8");

console.log(
  `[patch-android] applied: sdk.dir=${SDK_DIR}, ndk=${NDK_VERSION} (root ext + app literal), abi=arm64-v8a`,
);
