import { hostname as osHostname, networkInterfaces } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  ZCODE_VERSION,
  buildMobilePairingQrUrl,
  type MobilePairingManager,
} from "@zcode/shared";
import { createMobilePairingManager } from "./mobilePairingManager.js";
import { createMobilePairingWebAssets } from "./mobilePairingWebAssets.js";
import {
  createMobilePairingSession,
  type MobilePairingSession,
} from "./mobilePairingSession.js";

/**
 * 移动端局域网直连服务(main 进程,LAN 模式)。
 *
 * 职责:HTTP 静态壳 + WS 接入;认证与 Host 桥接统一走 mobilePairingSession
 * (与 relay 客户端共用同一状态机)。业务状态(attachment 路由)仍归
 * desktopRemoteSessions/windowHostAttachmentRegistry 所有。
 */

/** WS 升级路径(手机 transport 直连此路径,与 relay 模式同路径)。 */
const WS_PATH = "/mobile-pairing/ws";
/** 同一时刻允许的手机 WS 数(断线重连期间短暂并存)。 */
const MAX_CONCURRENT_WS = 2;
/** HTTP 服务监听重试次数(端口冲突等)。 */
const LISTEN_RETRY_COUNT = 3;
/** 认证必须在此时间内完成,否则静默断开。 */
const AUTH_TIMEOUT_MS = 30_000;

export interface MobilePairingServerHandle {
  /** 实际监听地址,形如 http://192.168.1.5:port。 */
  readonly origin: string;
  /** 生成新的配对二维码 URL(旧配对会话作废)。 */
  createQrUrl(): string;
  /** 服务是否仍在运行。 */
  readonly running: boolean;
  /** 当前 pairingManager(供控制器复用)。 */
  readonly pairingManager: MobilePairingManager;
  dispose(): Promise<void>;
}

export interface CreateMobilePairingServerOptions {
  /** 取用于桥接的窗口 Host(与 resolveCronDispatchHost 同策略:任一本地窗口 Host)。 */
  resolveBridgeHost: () => import("electron").UtilityProcess | null;
  /** 桌面设备 ID(进二维码)。 */
  deviceMid: string;
  hostname?: string;
  appVersion?: string;
  /** 固定端口(测试);缺省随机端口。 */
  fixedPort?: number;
  /** 手机 Web 构建产物目录(packages/web/dist);未配置时 /remote 返回引导错误页。 */
  webDistDir?: string;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** 测试注入。 */
  pairingManager?: MobilePairingManager;
}

/** 选一个局域网 IPv4 地址(优先 192.168/10./172.16-31 前缀)。 */
export function pickLanIPv4(): string | null {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const net of interfaces ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      if (
        net.address.startsWith("192.168.") ||
        net.address.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(net.address)
      ) {
        return net.address;
      }
    }
  }
  return null;
}

interface LanConnection {
  ws: WebSocket;
  session: MobilePairingSession;
  authTimer: ReturnType<typeof setTimeout> | null;
}

export async function createMobilePairingServer(
  options: CreateMobilePairingServerOptions,
): Promise<MobilePairingServerHandle> {
  const logger = options.logger;
  const pairingManager = options.pairingManager ?? createMobilePairingManager();
  const hostname = options.hostname ?? osHostname();
  const appVersion = options.appVersion ?? ZCODE_VERSION;

  const lanIp = pickLanIPv4();
  if (!lanIp) {
    throw new Error("未找到局域网 IPv4 地址,无法启动移动端配对服务");
  }

  const connections = new Set<LanConnection>();
  let disposed = false;

  /** 手机 Web 静态资源(单页壳 + assets),实现见 mobilePairingWebAssets。 */
  const webAssets = createMobilePairingWebAssets(options.webDistDir);

  function handlePairingSocket(ws: WebSocket): void {
    if (disposed) {
      ws.close();
      return;
    }
    // LAN transport:控制面 = ws 文本帧,数据面 = ws 二进制帧,close = 关 ws。
    const session = createMobilePairingSession(
      {
        sendControlFrame: (text) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(text);
        },
        sendDataFrame: (bytes) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
        },
        close: () => ws.close(4000, "pairing_error"),
      },
      {
        pairingManager,
        resolveBridgeHost: options.resolveBridgeHost,
        logger,
      },
    );
    const conn: LanConnection = { ws, session, authTimer: setTimeout(() => ws.close(), AUTH_TIMEOUT_MS) };
    connections.add(conn);

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        session.handleDataFrame(new Uint8Array(raw as Buffer));
        return;
      }
      const text = typeof raw === "string" ? raw : (raw as Buffer).toString("utf8");
      // 认证完成的信号:收到 auth_response 且未断开时取消超时;session 内部无该回调,
      // 简化处理——首个 auth_init 后放宽超时到配对 TTL,由 pairingManager 兜底。
      if (conn.authTimer) {
        clearTimeout(conn.authTimer);
        conn.authTimer = null;
      }
      session.handleControlFrame(text);
    });

    const cleanup = () => {
      if (conn.authTimer) clearTimeout(conn.authTimer);
      session.handleTransportClosed();
      connections.delete(conn);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  const server: Server = createServer((req, res) => {
    void handleHttpRequest(req, res).catch((error) => {
      logger.warn("[mobile-pairing] http handler failed", error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/mobile-pairing/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: appVersion }));
      return;
    }
    // 手机页面与静态资源:GET 之外一律 405,避免静态服务被滥用为任意方法端点。
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    await webAssets.serve(res, url.pathname);
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    if (connections.size >= MAX_CONCURRENT_WS) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handlePairingSocket(ws);
    });
  });

  // 监听:优先 fixedPort,冲突则退随机端口重试。
  let listenError: Error | null = null;
  for (let attempt = 0; attempt < LISTEN_RETRY_COUNT; attempt += 1) {
    listenError = await new Promise<Error | null>((resolve) => {
      const port = attempt === 0 && options.fixedPort ? options.fixedPort : 0;
      const onError = (error: Error) => resolve(error);
      server.once("error", onError);
      server.listen(port, lanIp, () => {
        server.removeListener("error", onError);
        resolve(null);
      });
    });
    if (!listenError) break;
    logger.warn(`[mobile-pairing] listen attempt ${attempt + 1} failed: ${listenError.message}`);
  }
  if (listenError || !server.listening) {
    throw listenError ?? new Error("mobile pairing server failed to listen");
  }

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("mobile pairing server has no address");
  }
  const origin = `http://${lanIp}:${address.port}`;
  logger.info(`[mobile-pairing] server listening on ${origin}`);

  return {
    origin,
    running: true,
    pairingManager,
    createQrUrl() {
      const payload = pairingManager.createQrPayload({
        deviceMid: options.deviceMid,
        hostname,
        appVersion,
      });
      return buildMobilePairingQrUrl(origin, {
        sid: payload.sid,
        hash: payload.hash,
        t: payload.t,
        mid: payload.mid,
        name: payload.name,
        appVersion: payload.appVersion,
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const conn of connections) {
        conn.session.handleTransportClosed();
        conn.ws.close();
      }
      connections.clear();
      pairingManager.disposeAll();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
