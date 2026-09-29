/* 验证运行器:
 *   node packages/mobile-app/scripts/verify.mjs all        # 全部用例
 *   node packages/mobile-app/scripts/verify.mjs store      # 会话聚合与命令下发
 *   node packages/mobile-app/scripts/verify.mjs model      # 交互模型(答案形状)
 *   node packages/mobile-app/scripts/verify.mjs policy     # 断线分类/退避/探活判定
 *   node packages/mobile-app/scripts/verify.mjs runtime    # 连接生命周期(断线重连)
 *
 * 用例是仓库内的 .ts(Node 无法直接解析 App 源码里的无扩展名相对导入,
 * 先用 esbuild 打成单文件再执行)。只用仓库内依赖,不引入测试框架。
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRIES = {
  store: "verify-store.ts",
  model: "verify-model.ts",
  policy: "verify-connection-policy.ts",
  runtime: "verify-runtime.ts",
};
const requested = process.argv[2] ?? "all";
const targets =
  requested === "all" ? Object.values(ENTRIES) : [ENTRIES[requested] ?? requested];
if (targets.some((target) => target === undefined)) {
  console.error(`未知用例:${requested}(可用:all | ${Object.keys(ENTRIES).join(" | ")})`);
  process.exit(2);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "zcode-mobile-verify-"));
let failed = 0;
try {
  for (const entry of targets) {
    const outfile = join(workDir, entry.replace(/\.ts$/u, ".mjs"));
    await build({
      entryPoints: [join(here, entry)],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      logLevel: "warning",
      // 仅为类型导入,运行期不加载 React Native。
      external: ["react-native"],
      // expo 原生模块在 Node 里加载不了:用例会注入自己的 credentialStore,
      // 这里只需让模块解析成功。
      alias: { "expo-secure-store": join(here, "stubs/expo-secure-store.ts") },
    });
    try {
      execFileSync(process.execPath, [outfile], { stdio: "inherit" });
    } catch {
      failed += 1;
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
