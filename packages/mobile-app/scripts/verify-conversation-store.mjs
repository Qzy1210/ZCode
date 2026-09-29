/* 会话聚合验证运行器:
 *   node packages/mobile-app/scripts/verify-conversation-store.mjs
 *
 * 用例写在同目录的 verify-conversation-store.ts(Node 无法直接解析 App 源码里的
 * 无扩展名相对导入,因此先用 esbuild 打成单文件再执行)。
 * 只用仓库内依赖,不新增测试框架。
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = fileURLToPath(new URL("./verify-conversation-store.ts", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "zcode-conv-verify-"));
const outfile = join(workDir, "verify.mjs");

try {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
    // 仅为类型导入,运行期不加载 React Native。
    external: ["react-native"],
  });
  await import(pathToFileURL(outfile).href);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
