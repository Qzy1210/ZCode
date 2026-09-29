import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import type { ServerResponse } from "node:http";

/**
 * 手机 Web 静态资源服务(packages/web 构建产物)。
 * 独立模块:mobilePairingServer 只保留配对/桥接逻辑,静态服务边界单独审计。
 */
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

/** index.html 每次回源校验;哈希资源永久缓存(与 relay 端一致,避免手机页刷新重下全部 JS)。 */
const INDEX_CACHE_CONTROL = "no-cache";
const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface MobilePairingWebAssets {
  /** SPA:/remote 与未知路径回 index.html;assets 精确匹配。 */
  serve(res: ServerResponse, pathname: string): Promise<void>;
}

export function createMobilePairingWebAssets(webDistDir?: string): MobilePairingWebAssets {
  const webRoot = webDistDir ? resolve(webDistDir) : null;

  async function serveIndex(res: ServerResponse): Promise<void> {
    if (!webRoot) {
      // 未配置构建产物:返回引导错误页,避免手机端白屏无提示。
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZCode</title>` +
          `<body style="font-family:system-ui;background:#161616;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
          `<div style="max-width:28rem;padding:1.5rem">` +
          `<h1 style="font-size:1rem">ZCode 移动端页面未部署</h1>` +
          `<p style="font-size:.875rem;opacity:.7">请先构建 packages/web(pnpm --filter @zcode/web build)并重启桌面端。</p>` +
          `</div></body>`,
      );
      return;
    }
    try {
      const index = await readFile(join(webRoot, "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": INDEX_CACHE_CONTROL,
      });
      res.end(index);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  }

  return {
    async serve(res, pathname) {
      if (!webRoot) {
        await serveIndex(res);
        return;
      }
      const isAsset = pathname.startsWith("/assets/") || pathname.startsWith("/remote/assets/");
      if (!isAsset) {
        await serveIndex(res);
        return;
      }
      const relative = pathname.replace(/^\/(remote\/)?/, "");
      const absolute = normalize(join(webRoot, relative));
      // 路径穿越防护:解析后必须仍在 webRoot 内。
      if (!absolute.startsWith(webRoot)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      try {
        const content = await readFile(absolute);
        const mime = MIME_BY_EXT[extname(absolute)] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": HASHED_ASSET_CACHE_CONTROL });
        res.end(content);
      } catch {
        // 静态资源缺失回退到 index.html,由前端路由接管。
        await serveIndex(res);
      }
    },
  };
}
