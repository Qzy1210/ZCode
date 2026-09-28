import { WebSocket } from "ws";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import type { MobilePairingManager } from "@zcode/shared";
import {
  createMobilePairingSession,
  type MobilePairingSession,
} from "./mobilePairingSession.js";

/**
 * 桌面出站 relay 客户端(main 进程,relay 模式)。
 *
 * 与 LAN server 的差异:本机不监听端口,主动出站连接公网 relay,
 * 注册当前配对 sid;手机帧经 relay 转发到本连接,交 mobilePairingSession 处理
 * (认证与 Host 桥接与 LAN 模式完全同构)。
 *
 * 重连语义:WS 断开后指数退避重连(1s→30s 上限);重连成功即重新注册 sid,
 * 手机端 transport 会因 relay 侧 phone_closed 感知断开并自行重试。
 */

/** 重连退避基值与上限。 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** 出站连接建立超时。 */
const CONNECT_TIMEOUT_MS = 15_000;

export interface RelayClientConfig {
  /** relay 基地址,如 https://relay.example.com(末尾不带路径)。 */
  relayOrigin: string;
  /** 桌面注册令牌(与 relay 的 RELAY_HOST_TOKEN 一致)。 */
  hostToken: string;
}

export interface RelayClientEvents {
  /** 连接状态变化(供 UI 呈现 relay 是否在线)。 */
  onStatusChange: (status: RelayClientStatus) => void;
}

export type RelayClientStatus =
  | { kind: "connecting" }
  | { kind: "registered"; sid: string }
  | { kind: "disconnected"; willRetry: boolean };

export interface MobilePairingRelayClientHandle {
  /** 注册(或重新注册)sid:生成新二维码后调用;断线时缓存待重连。 */
  registerSid(sid: string): void;
  /** 当前连接状态。 */
  getStatus(): RelayClientStatus;
  dispose(): Promise<void>;
}

export function createMobilePairingRelayClient(
  config: RelayClientConfig,
  options: {
    pairingManager: MobilePairingManager;
    resolveBridgeHost: () => ElectronUtilityProcess | null;
    onStatusChange?: (status: RelayClientStatus) => void;
    logger: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    };
  },
): MobilePairingRelayClientHandle {
  const { pairingManager, resolveBridgeHost, logger } = options;
  let disposed = false;
  let sid: string | null = null;
  let ws: WebSocket | null = null;
  let session: MobilePairingSession | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let status: RelayClientStatus = { kind: "disconnected", willRetry: false };

  function setStatus(next: RelayClientStatus): void {
    status = next;
    options.onStatusChange?.(next);
  }

  function scheduleReconnect(): void {
    if (disposed || !sid) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => connect(), delay);
    setStatus({ kind: "disconnected", willRetry: true });
  }

  function connect(): void {
    if (disposed || !sid) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const url = `${config.relayOrigin.replace(/\/+$/, "").replace(/^http/, "ws")}/mobile-relay/host`;
    setStatus({ kind: "connecting" });
    const socket = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS });
    ws = socket;

    const connectTimeout = setTimeout(() => {
      socket.terminate();
    }, CONNECT_TIMEOUT_MS);

    socket.on("open", () => {
      clearTimeout(connectTimeout);
      socket.send(JSON.stringify({ type: "host_register", token: config.hostToken, sid }));
    });

    socket.on("message", (raw, isBinary) => {
      // relay → 桌面控制帧:phone_open/phone_closed 驱动 session 生命周期;
      // 其余(auth_*/bridge_*/rpc)是手机帧,转给 session。
      if (!isBinary) {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        let control: { type?: string } | null = null;
        try {
          control = JSON.parse(text) as { type?: string };
        } catch {
          control = null;
        }
        if (control?.type === "host_registered") {
          reconnectAttempt = 0;
          setStatus({ kind: "registered", sid: sid! });
          logger.info(`[mobile-pairing] relay registered, sid=${sid!.slice(0, 6)}…`);
          return;
        }
        if (control?.type === "host_error") {
          logger.warn("[mobile-pairing] relay rejected registration");
          return;
        }
        if (control?.type === "phone_open") {
          // 新手机到达(或旧手机重连):旧 session 先释放,再建新会话。
          session?.handleTransportClosed();
          session = createSession(socket);
          return;
        }
        if (control?.type === "phone_closed") {
          session?.handleTransportClosed();
          session = null;
          return;
        }
        session?.handleControlFrame(text);
        return;
      }
      session?.handleDataFrame(new Uint8Array(raw as Buffer));
    });

    socket.on("close", () => {
      clearTimeout(connectTimeout);
      session?.handleTransportClosed();
      session = null;
      ws = null;
      scheduleReconnect();
    });

    socket.on("error", (error) => {
      logger.warn(`[mobile-pairing] relay connection error: ${(error as Error).message}`);
    });

    /** 为 relay 侧手机连接创建 session:控制面 = ws 文本帧,数据面 = ws 二进制帧。 */
    function createSession(socket: WebSocket): MobilePairingSession {
      let active = true;
      const created = createMobilePairingSession(
        {
          sendControlFrame: (text) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(text);
          },
          sendDataFrame: (bytes) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
          },
          close: () => {
            // 会话级错误只关手机侧通道,不拆整条 relay 注册连接:
            // 通知 relay 关闭 phone,host 连接保留。
            if (active && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "phone_close" }));
            }
          },
        },
        { pairingManager, resolveBridgeHost, logger },
      );
      return {
        handleControlFrame: (text) => {
          if (active) created.handleControlFrame(text);
        },
        handleDataFrame: (bytes) => {
          if (active) created.handleDataFrame(bytes);
        },
        handleTransportClosed: () => {
          if (!active) return;
          active = false;
          created.handleTransportClosed();
          if (session === created) session = null;
        },
      };
    }
  }

  return {
    registerSid(nextSid) {
      sid = nextSid;
      if (ws && ws.readyState === WebSocket.OPEN) {
        // 已连接:直接补注册帧(relay 侧顶替旧 sid)。
        ws.send(JSON.stringify({ type: "host_register", token: config.hostToken, sid: nextSid }));
        return;
      }
      reconnectAttempt = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    },
    getStatus() {
      return status;
    },
    async dispose() {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      session?.handleTransportClosed();
      session = null;
      const socket = ws;
      ws = null;
      if (socket && socket.readyState <= WebSocket.OPEN) {
        await new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.close();
          setTimeout(resolve, 2_000);
        });
      }
    },
  };
}
