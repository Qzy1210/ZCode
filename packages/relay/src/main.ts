/**
 * ZCode 移动端远控自托管 relay(独立部署,无内部包依赖)。
 *
 * 角色:哑管道 + sid 路由。认证校验始终在桌面端完成(mobilePairingManager),
 * relay 不持有配对 secret,只按 sid 把帧在桌面 WS 与手机 WS 之间转发。
 *
 * 线协议:
 * - 桌面 → relay(文本): host_register {token, sid};其余文本/二进制帧原样转发给手机
 * - relay → 桌面(文本): host_registered/host_error/phone_open/phone_closed;其余原样转发
 * - 手机 → relay: 首个 auth_init 文本帧携带 device_sid 用于路由;后续原样转发
 * - 同一 sid 同时只允许一个手机连接;新连接到达时旧连接被关闭(重连场景)
 *
 * 环境变量:
 * - RELAY_PORT: 监听端口(默认 8787)
 * - RELAY_HOST: 监听地址(默认 0.0.0.0)
 * - RELAY_HOST_TOKEN: 桌面注册令牌(必填;桌面端 mobile-relay.json 同字段)
 * - RELAY_WEB_DIST: 手机 Web 构建产物目录(默认 ./web-dist,即 packages/web/dist 内容)
 * - RELAY_TLS_CERT / RELAY_TLS_KEY: 可选;提供时启用 HTTPS/WSS
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { gzipSync } from "node:zlib";
import { WebSocketServer, WebSocket, type RawData } from "ws";

const PORT = Number(process.env.RELAY_PORT || 8787);
const HOST_BIND = process.env.RELAY_HOST || "0.0.0.0";
const HOST_TOKEN = process.env.RELAY_HOST_TOKEN?.trim() || "";
const WEB_DIST = resolve(process.env.RELAY_WEB_DIST || "./web-dist");
const TLS_CERT = process.env.RELAY_TLS_CERT?.trim();
const TLS_KEY = process.env.RELAY_TLS_KEY?.trim();

const HOST_WS_PATH = "/mobile-relay/host";
const PHONE_WS_PATH = "/mobile-pairing/ws";
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

if (!HOST_TOKEN) {
  console.error("[relay] RELAY_HOST_TOKEN is required (generate with: openssl rand -hex 24)");
  process.exit(1);
}

interface HostEntry {
  ws: WebSocket;
  sid: string;
  phone: WebSocket | null;
}

/** sid → 桌面连接。 */
const hostsBySid = new Map<string, HostEntry>();

function log(level: "info" | "warn" | "error", message: string, extra?: unknown): void {
  const line = `[relay] ${message}`;
  if (level === "error") console.error(line, extra ?? "");
  else if (level === "warn") console.warn(line, extra ?? "");
  else console.log(line, extra ?? "");
}

/* -------------------------------- 静态资源 -------------------------------- */

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
/** Vite 产物文件名含内容哈希,可安全永久缓存——手机页每次刷新不再重下全部 JS。 */
const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * 文本类资源按需 gzip:首屏初始加载约 8.7MB JS,不压缩在公网传输上代价过高。
 * 压缩结果按路径缓存(产物文件名带哈希,内容不可变,可安全长期缓存);
 * 上限放到 16MB:最大主包(5.6MB)必须覆盖;单文件首次压缩的同步开销一次性发生,之后走缓存。
 */
const COMPRESSIBLE_EXT = new Set([".js", ".mjs", ".css", ".json", ".svg", ".map"]);
const GZIP_MAX_BYTES = 16 * 1024 * 1024;
const GZIP_MAX_CACHE_ENTRIES = 256;
const gzipCache = new Map<string, Buffer>();

function maybeGzip(
  request: import("node:http").IncomingMessage,
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

async function serveIndex(res: import("node:http").ServerResponse): Promise<void> {
  try {
    const index = await readFile(join(WEB_DIST, "index.html"));
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

async function serveStatic(
  request: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  pathname: string,
): Promise<void> {
  const isAsset = pathname.startsWith("/assets/") || pathname.startsWith("/remote/assets/");
  if (!isAsset) {
    await serveIndex(res);
    return;
  }
  const relative = pathname.replace(/^\/(remote\/)?/, "");
  const absolute = normalize(join(WEB_DIST, relative));
  // 路径穿越防护:解析后必须仍在 WEB_DIST 内。
  if (!absolute.startsWith(WEB_DIST)) {
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
}

/* --------------------------------- 心跳 ---------------------------------- */

const aliveSet = new WeakSet<WebSocket>();
setInterval(() => {
  for (const ws of wss.clients) {
    if (aliveSet.has(ws)) {
      aliveSet.delete(ws);
      ws.ping();
    } else {
      ws.terminate();
    }
  }
}, HEARTBEAT_INTERVAL_MS);
function markAlive(ws: WebSocket): void {
  aliveSet.add(ws);
  ws.on("pong", () => aliveSet.add(ws));
}

/* ------------------------------ 桌面(host) ------------------------------ */

function notifyHost(entry: HostEntry, frame: Record<string, unknown>): void {
  if (entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify(frame));
  }
}

function detachPhone(entry: HostEntry, reason: string): void {
  const phone = entry.phone;
  entry.phone = null;
  if (phone && phone.readyState <= WebSocket.OPEN) {
    phone.close(4000, reason);
  }
}

function handleHostSocket(ws: WebSocket): void {
  markAlive(ws);
  let entry: HostEntry | null = null;

  /**
   * 处理 host_register。必须支持**重复注册**:桌面「重新生成二维码」复用同一条 relay
   * 连接换新 sid——此前只在首帧接受注册,导致新二维码扫进来查无注册(pair_unknown),
   * 且旧 sid 残留成幽灵路由(线上故障根因,勿回退成一次性监听)。
   */
  function handleHostRegister(register: { token?: string; sid?: string }): void {
    if (typeof register.sid !== "string" || register.sid.length === 0) return;
    if (register.token !== HOST_TOKEN) {
      ws.send(JSON.stringify({ type: "host_error", code: "invalid_token" }));
      ws.close(4001, "invalid_token");
      log("warn", "host_register rejected: invalid token");
      return;
    }
    const sid = register.sid;
    if (entry?.sid === sid) {
      // 幂等:同一 sid 重复注册(网络重连后重发)只回执,不动已建立的手机连接。
      ws.send(JSON.stringify({ type: "host_registered", sid }));
      return;
    }
    if (entry) {
      // 同一 socket 更换 sid:旧 sid 路由精确下线,旧手机按"重新生成"语义断开。
      detachPhone(entry, "superseded");
      if (hostsBySid.get(entry.sid) === entry) {
        hostsBySid.delete(entry.sid);
      }
      entry = null;
    }
    // 同 sid 已有其他连接:顶替旧连接(桌面重连场景)。
    const existing = hostsBySid.get(sid);
    if (existing && existing.ws !== ws) {
      detachPhone(existing, "superseded");
      existing.ws.close(4000, "superseded");
      hostsBySid.delete(sid);
    }
    entry = { ws, sid, phone: null };
    hostsBySid.set(sid, entry);
    ws.send(JSON.stringify({ type: "host_registered", sid }));
    log("info", `host registered, sid=${sid.slice(0, 6)}…`);
  }

  ws.on("message", (raw: RawData, isBinary: boolean) => {
    if (!isBinary) {
      const text = typeof raw === "string" ? raw : (raw as Buffer).toString("utf8");
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      if (parsed?.type === "host_register") {
        handleHostRegister(parsed as { token?: string; sid?: string });
        return;
      }
      if (entry && parsed?.type === "phone_close") {
        detachPhone(entry, "closed_by_host");
        return;
      }
      if (entry && entry.phone?.readyState === WebSocket.OPEN) {
        entry.phone.send(text);
      }
      return;
    }
    if (!entry) return;
    // 数据面:原样转发给手机。
    if (entry.phone?.readyState === WebSocket.OPEN) {
      entry.phone.send(raw as Buffer);
    }
  });

  ws.on("close", () => {
    if (!entry) return;
    detachPhone(entry, "host_disconnected");
    if (hostsBySid.get(entry.sid) === entry) {
      hostsBySid.delete(entry.sid);
    }
    log("info", `host disconnected, sid=${entry.sid.slice(0, 6)}…`);
    entry = null;
  });
}

/* ------------------------------ 手机(phone) ----------------------------- */

function handlePhoneSocket(ws: WebSocket): void {
  markAlive(ws);
  let host: HostEntry | null = null;
  let routed = false;

  function routeFirstFrame(text: string): boolean {
    try {
      const parsed = JSON.parse(text) as { type?: string; device_sid?: string };
      if (parsed?.type !== "auth_init" || typeof parsed.device_sid !== "string") return false;
      const sid = parsed.device_sid;
      const entry = hostsBySid.get(sid);
      if (!entry) {
        ws.send(JSON.stringify({ type: "error", code: "pair_unknown", message: "desktop offline or not registered" }));
        ws.close(4000, "pair_unknown");
        return true;
      }
      // 同 sid 新手机到达:关闭旧手机(断线重连场景),再挂新连接。
      if (entry.phone && entry.phone !== ws) {
        detachPhone(entry, "superseded");
      }
      entry.phone = ws;
      host = entry;
      routed = true;
      notifyHost(entry, { type: "phone_open" });
      // auth_init 本身也要送达桌面。
      entry.ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  ws.on("message", (raw: RawData, isBinary: boolean) => {
    if (!routed) {
      if (isBinary) {
        ws.close(4000, "auth_required");
        return;
      }
      const text = typeof raw === "string" ? raw : (raw as Buffer).toString("utf8");
      if (!routeFirstFrame(text)) {
        ws.send(JSON.stringify({ type: "error", code: "auth_failed", message: "auth_init required" }));
        ws.close(4000, "auth_required");
      }
      return;
    }
    // 已路由:原样转发给桌面。
    if (host?.ws.readyState === WebSocket.OPEN) {
      if (isBinary) host.ws.send(raw as Buffer);
      else host.ws.send(typeof raw === "string" ? raw : (raw as Buffer).toString("utf8"));
    }
  });

  ws.on("close", () => {
    if (host && host.phone === ws) {
      host.phone = null;
      notifyHost(host, { type: "phone_closed", reason: "phone_disconnected" });
    }
    host = null;
  });
}

/* -------------------------------- 服务器 --------------------------------- */

const requestListener: import("node:http").RequestListener = (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/mobile-pairing/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: "relay", hosts: hostsBySid.size }));
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }
  void serveStatic(req, res, url.pathname).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  });
};

let server: HttpServer;
if (TLS_CERT && TLS_KEY) {
  server = createHttpsServer(
    { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) },
    requestListener,
  );
} else {
  server = createHttpServer(requestListener);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === HOST_WS_PATH) {
      handleHostSocket(ws);
    } else if (url.pathname === PHONE_WS_PATH) {
      handlePhoneSocket(ws);
    } else {
      ws.close(4000, "unknown_path");
    }
  });
});

server.listen(PORT, HOST_BIND, () => {
  const scheme = TLS_CERT && TLS_KEY ? "https" : "http";
  log(
    "info",
    `relay listening on ${scheme}://${HOST_BIND}:${PORT} (web dist: ${WEB_DIST}${TLS_CERT ? ", tls on" : ", WARNING: plaintext http - RPC traffic is NOT encrypted in transit"})`,
  );
});

process.on("SIGTERM", () => {
  for (const entry of hostsBySid.values()) detachPhone(entry, "relay_shutdown");
  wss.close();
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => process.exit(0));
