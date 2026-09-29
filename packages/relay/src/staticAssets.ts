/* relay 的静态资源服务(手机 Web 页面):哈希资源永久缓存 + 文本按需 gzip。
 * 从 main.ts 拆出,避免单文件超行数门禁;行为与 desktop 端 mobilePairingWebAssets 对齐。 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** index.html 必须每次回源校验:资源名带内容哈希,新构建换新文件名。 */
const INDEX_CACHE_CONTROL = "no-cache";
/** Vite 产物文件名含内容哈希,可安全永久缓存——手机页刷新不再重下全部 JS。 */
const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * 文本类资源按需 gzip:首屏初始加载约 8.7MB JS,不压缩在公网传输上代价过高。
 * 压缩结果按路径缓存(产物文件名带哈希,内容不可变,可安全长期缓存);
 * 上限 16MB:最大主包(5.6MB)必须覆盖;单文件首次压缩的同步开销一次性发生。
 */
const COMPRESSIBLE_EXT = new Set([".js", ".mjs", ".css", ".json", ".svg", ".map"]);
const GZIP_MAX_BYTES = 16 * 1024 * 1024;
const GZIP_MAX_CACHE_ENTRIES = 256;
const gzipCache = new Map<string, Buffer>();

export interface RelayStaticAssets {
  serve(request: IncomingMessage, res: ServerResponse, pathname: string): Promise<void>;
}

export function createRelayStaticAssets(webDistDir: string): RelayStaticAssets {
  const webRoot = resolve(webDistDir);

  function maybeGzip(
    request: IncomingMessage,
    filePath: string,
    content: Buffer,
  ): { body: Buffer; encoding?: string } {
    const ext = extname(filePath);
    if (!COMPRESSIBLE_EXT.has(ext) || content.byteLength > GZIP_MAX_BYTES) {
      return { body: content };
    }
    const acceptsGzip = /\bgzip\b/.test(request.headers["accept-encoding"] ?? "");
    if (!acceptsGzip) return { body: content };
    const cached = gzipCache.get(filePath);
    if (cached) return { body: cached, encoding: "gzip" };
    const compressed = gzipSync(content);
    if (gzipCache.size >= GZIP_MAX_CACHE_ENTRIES) gzipCache.clear();
    gzipCache.set(filePath, compressed);
    return { body: compressed, encoding: "gzip" };
  }

  async function serveIndex(res: ServerResponse): Promise<void> {
    try {
      const index = await readFile(join(webRoot, "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": INDEX_CACHE_CONTROL,
      });
      res.end(index);
    } catch {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>ZCode</title>` +
          `<body style="font-family:system-ui;background:#161616;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
          `<div style="max-width:28rem;padding:1.5rem"><h1 style="font-size:1rem">手机端页面未部署</h1>` +
          `<p style="font-size:.875rem;opacity:.7">请将 packages/web/dist 上传到 RELAY_WEB_DIST 指定目录后重启 relay。</p></div></body>`,
      );
    }
  }

  return {
    async serve(request, res, pathname) {
      const isAsset = pathname.startsWith("/assets/") || pathname.startsWith("/remote/assets/");
      if (!isAsset) {
        await serveIndex(res);
        return;
      }
      const relative = pathname.replace(/^\/(remote\/)?/, "");
      const absolute = normalize(join(webRoot, relative));
      // 路径穿越防护:解析后必须仍在 WEB_DIST 内。
      if (!absolute.startsWith(webRoot)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      try {
        const content = await readFile(absolute);
        const mime = MIME_BY_EXT[extname(absolute)] ?? "application/octet-stream";
        const compressed = maybeGzip(request, absolute, content);
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": HASHED_ASSET_CACHE_CONTROL,
          Vary: "Accept-Encoding",
          ...(compressed.encoding ? { "Content-Encoding": compressed.encoding } : {}),
        });
        res.end(compressed.body);
      } catch {
        await serveIndex(res);
      }
    },
  };
}
