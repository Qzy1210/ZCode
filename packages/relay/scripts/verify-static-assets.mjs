/* 静态资源服务验证(Content-Length / Range / gzip / 兜底):
 *   node packages/relay/scripts/verify-static-assets.mjs
 *
 * 为什么需要:这几个响应头直接决定手机下载 APK 的体验——少了 Content-Length,
 * 浏览器显示"未知大小"且没有进度条;少了 Range,断点续传不可用(实测分发 38MB APK)。
 * 用例用真实 http server + fetch 验证,不引测试框架。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
}

const workDir = mkdtempSync(join(tmpdir(), "zcode-relay-static-"));
const webDist = join(workDir, "web-dist");
mkdirSync(join(webDist, "assets"), { recursive: true });
const apkBytes = Buffer.alloc(1024, 7);
writeFileSync(join(webDist, "assets", "app.apk"), apkBytes);
writeFileSync(join(webDist, "assets", "app.js"), "console.log('x'.repeat(100));");
writeFileSync(join(webDist, "index.html"), "<!doctype html><title>phone</title>");

const outfile = join(workDir, "static-assets.mjs");
await build({
  entryPoints: [new URL("../src/staticAssets.ts", import.meta.url).pathname],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "warning",
});
const { createRelayStaticAssets } = await import(outfile);
const assets = createRelayStaticAssets(webDist);

const server = createServer((req, res) => {
  void assets.serve(req, res, new URL(req.url, "http://localhost").pathname);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  // 1) 整包:必须有 Content-Length(否则浏览器显示"未知大小")
  const full = await fetch(`${base}/assets/app.apk`);
  const fullBody = Buffer.from(await full.arrayBuffer());
  check(
    "整包响应带 Content-Length 与 Accept-Ranges",
    full.status === 200 &&
      full.headers.get("content-length") === String(apkBytes.byteLength) &&
      full.headers.get("accept-ranges") === "bytes",
    `status=${full.status} len=${full.headers.get("content-length")}`,
  );
  check("整包内容与磁盘一致", fullBody.equals(apkBytes));

  // 2) Range:206 + Content-Range + 正确的分片
  const partial = await fetch(`${base}/assets/app.apk`, { headers: { Range: "bytes=100-199" } });
  const partialBody = Buffer.from(await partial.arrayBuffer());
  check(
    "Range 请求返回 206 与 Content-Range",
    partial.status === 206 &&
      partial.headers.get("content-range") === `bytes 100-199/${apkBytes.byteLength}`,
    `status=${partial.status} range=${partial.headers.get("content-range")}`,
  );
  check(
    "Range 分片内容正确(100-199 共 100 字节)",
    partialBody.byteLength === 100 && partialBody.equals(apkBytes.subarray(100, 200)),
  );

  // 3) 后缀区间 bytes=-64(下载器续传常用)
  const suffix = await fetch(`${base}/assets/app.apk`, { headers: { Range: "bytes=-64" } });
  const suffixBody = Buffer.from(await suffix.arrayBuffer());
  check(
    "后缀区间 bytes=-64 命中最后 64 字节",
    suffix.status === 206 &&
      suffixBody.equals(apkBytes.subarray(apkBytes.byteLength - 64)),
    `status=${suffix.status} len=${suffixBody.byteLength}`,
  );

  // 4) 起点越界 → 416
  const beyond = await fetch(`${base}/assets/app.apk`, { headers: { Range: "bytes=99999-" } });
  check(
    "起点越界返回 416 与 bytes */total",
    beyond.status === 416 &&
      beyond.headers.get("content-range") === `bytes */${apkBytes.byteLength}`,
    `status=${beyond.status}`,
  );

  // 5) gzip 仍然生效,且压缩后长度也带 Content-Length
  const gzipped = await fetch(`${base}/assets/app.js`, { headers: { "Accept-Encoding": "gzip" } });
  await gzipped.arrayBuffer();
  check(
    "可压缩资源仍走 gzip 且长度正确",
    gzipped.headers.get("content-encoding") === "gzip" &&
      Number(gzipped.headers.get("content-length")) > 0,
    `enc=${gzipped.headers.get("content-encoding")} len=${gzipped.headers.get("content-length")}`,
  );
  check("Range 请求不带 gzip(区间必须落在原始表示上)", !partial.headers.get("content-encoding"));

  // 6) 非 /assets 路径仍回 index.html(SPA 兜底不变)
  const spa = await fetch(`${base}/remote`);
  const spaBody = await spa.text();
  check("非资源路径回 SPA 兜底页", spa.status === 200 && spaBody.includes("<title>phone</title>"));
  // 7) 路径穿越仍被挡住
  const traversal = await fetch(`${base}/assets/../../etc/passwd`);
  const traversalBody = await traversal.text();
  check(
    "路径穿越仍被拒绝(回兜底页而非文件)",
    !traversalBody.includes("root:"),
    `status=${traversal.status}`,
  );
} finally {
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
