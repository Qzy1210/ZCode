/*
 * prebuild 会把 android/ 重置为模板态,本地构建所需补丁在这里统一重打:
 * 1) local.properties 的 sdk.dir
 * 2) rootProject.ext.ndkVersion 覆盖为已装 NDK(RN 默认 27.1 在受限网络下无法下载)
 * 3) reactNativeArchitectures 只保留 arm64-v8a(真机唯一需要,构建时间/包体积大幅下降)
 * 4) 启动器图标换成桌面版同款(assets/icon.png → 各密度 mipmap,macOS sips 生成)
 * 5) 启动画面不留任何图片(纯深色背景,见下方第 7 步)
 * 用法:expo prebuild --platform android 之后、gradle 之前执行本脚本。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// 5) 指向本机 JDK 17:RN/Expo 模块声明 Java 17 toolchain,而构建本身跑在 Android Studio
//    的 JDK 21 上,Gradle 会去 Adoptium 下载 185MB JDK——受限网络下极易卡死。
const LOCAL_JDK17 = "/opt/homebrew/Cellar/openjdk@17/17.0.19/libexec/openjdk.jdk/Contents/Home";
const needJdkPath =
  existsSync(LOCAL_JDK17) && !props.includes("org.gradle.java.installations.paths=");
writeFileSync(
  gradlePropsPath,
  needJdkPath ? `${props.trimEnd()}\norg.gradle.java.installations.paths=${LOCAL_JDK17}\n` : props,
  "utf8",
);

// 6) 启动器图标:桌面版同款(assets/icon.png,1024×1024 带 alpha)。
//    prebuild 每次都会把 mipmap 覆盖回 Expo 默认图标,必须在这里重打。
//    用 macOS 自带 sips 缩放(无 ImageMagick 依赖),webp 转码交给 cwebp;
//    缺 cwebp 时退化为 png(AGP 对 mipmap 后缀不敏感,Manifest 只引用资源名)。
const iconSource = resolve(import.meta.dirname, "../assets/icon.png");
if (existsSync(iconSource)) {
  const DENSITIES = [
    ["mdpi", 48],
    ["hdpi", 72],
    ["xhdpi", 96],
    ["xxhdpi", 144],
    ["xxxhdpi", 192],
  ];
  let usedWebp = false;
  for (const [density, size] of DENSITIES) {
    const mipmapDir = join(androidDir, "app/src/main/res", `mipmap-${density}`);
    const pngPath = join(mipmapDir, "ic_launcher.png");
    const roundPngPath = join(mipmapDir, "ic_launcher_round.png");
    execFileSync("/usr/bin/sips", [
      "-z", String(size), String(size), iconSource, "--out", pngPath,
    ], { stdio: "ignore" });
    execFileSync("/usr/bin/sips", [
      "-z", String(size), String(size), iconSource, "--out", roundPngPath,
    ], { stdio: "ignore" });
    for (const target of [pngPath, roundPngPath]) {
      const webpPath = target.replace(/\.png$/, ".webp");
      try {
        execFileSync("/opt/homebrew/bin/cwebp", ["-quiet", target, "-o", webpPath], {
          stdio: "ignore",
        });
        // 同名资源只能保留一个扩展名:png + webp 并存是 Duplicate resources
        // (AAPT 按资源名合并,不看扩展名)。
        rmSync(target);
        usedWebp = true;
      } catch {
        // 无 cwebp:保留 png,Android 按 mipmap/<name> 引用不看扩展名。
      }
    }
  }
  console.log(
    `[patch-android] launcher icon replaced from assets/icon.png (webp=${usedWebp})`,
  );
} else {
  console.warn("[patch-android] assets/icon.png missing; keeping Expo default icon");
}

// 7) 启动画面:不要任何图片。
//    现象:启动瞬间闪过一张白底「网格+圆形」占位图。来源是 prebuild 的 splash 资源——
//    Theme.App.SplashScreen 的 windowBackground 指向 splashscreen_logo(png),
//    且 splashscreen_background 是白色,与 App 的 #161616 背景割裂。
//    app.json 已用 expo-splash-screen 插件声明「只有背景色」,但插件 v57 会把纯色
//    layer-list 写到 drawable/ic_launcher_background.xml,styles 引用的
//    @drawable/splashscreen_logo 反而缺失(资源解析失败)。这里保证最终状态:
//    - drawable/splashscreen_logo.xml = 只含背景色的 layer-list;
//    - 删掉所有密度的 splashscreen_logo.png;
//    - colors.xml 的 splashscreen_background 与 App 背景一致。
const SPLASH_BACKGROUND = "#161616";
const resDir = join(androidDir, "app/src/main/res");
const splashDrawablePath = join(resDir, "drawable/splashscreen_logo.xml");
writeFileSync(
  splashDrawablePath,
  `<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item android:drawable="@color/splashscreen_background"/>
</layer-list>
`,
  "utf8",
);
let removedSplashImages = 0;
for (const entry of readdirSync(resDir)) {
  if (!entry.startsWith("drawable")) continue;
  const candidate = join(resDir, entry, "splashscreen_logo.png");
  if (existsSync(candidate)) {
    rmSync(candidate);
    removedSplashImages += 1;
  }
}
const colorsPath = join(resDir, "values/colors.xml");
const colorsXml = readFileSync(colorsPath, "utf8");
const patchedColors = colorsXml.replace(
  /(<color name="splashscreen_background">)[^<]*(<\/color>)/u,
  `$1${SPLASH_BACKGROUND}$2`,
);
if (patchedColors !== colorsXml) writeFileSync(colorsPath, patchedColors, "utf8");
console.log(
  `[patch-android] splash: color-only drawable written, ${removedSplashImages} placeholder png removed, background=${SPLASH_BACKGROUND}`,
);

console.log(
  `[patch-android] applied: sdk.dir=${SDK_DIR}, ndk=${NDK_VERSION} (root ext + app literal), abi=arm64-v8a, jdk17=${needJdkPath ? LOCAL_JDK17 : "auto"}`,
);
