/* 移动端局域网直连 transport:WS 控制面(JSON 文本帧)+ 数据面(二进制帧,SocketProtocol 线格式)。
 *
 * 与桌面 main 的 mobilePairingServer.ts 对偶:
 * - 控制帧:auth_init / auth_challenge / auth_response / auth_ack / error /
 *   bridge_request / bridge_ready。
 * - 数据帧:二进制,13B SocketProtocol Regular 头 + RPC body;经 ISocket 适配后
 *   直接交给 @zcode/rpc SocketProtocol 复用,ChannelClient 零改动。
 */
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  type ISocket,
} from "@zcode/rpc";
import {
  MOBILE_PAIRING_AUTH_ROLE,
  calculateMobilePairingProofPure,
  type MobilePairingQrPayload,
} from "@zcode/shared";

export type MobilePairingTransportPhase =
  | "connecting"
  | "authenticating"
  | "bridging"
  | "ready"
  | "closed";

export interface MobilePairingTransportEvents {
  phase: MobilePairingTransportPhase;
  error?: { code: string; message?: string };
}

export interface MobilePairingTransport {
  /** 数据面 socket(bridge_ready 后可用,交给 SocketProtocol/ChannelClient)。 */
  readonly socket: ISocket;
  readonly onPhaseChange: (listener: (event: MobilePairingTransportEvents) => void) => () => void;
  /** 发起认证与桥接;resolve 于 bridge_ready,reject 于 error/关闭。 */
  connect(): Promise<ISocket>;
  dispose(): void;
}

/** proof 计算委托 shared 的纯 JS 实现(HTTP 非安全上下文无 crypto.subtle)。 */
function calculateProofWeb(
  secretHash: string,
  nonce: string,
  role: string,
  deviceSid: string,
): Promise<string> {
  return Promise.resolve(calculateMobilePairingProofPure(secretHash, nonce, role, deviceSid));
}

/** 二进制帧 = 13B Regular 头 + body;这里只透传,由 SocketProtocol 分帧解析。 */
export function createMobilePairingTransport(params: {
  qr: MobilePairingQrPayload;
  /** 二维码所在页面 origin(桌面服务地址)。 */
  serverOrigin: string;
}): MobilePairingTransport {
  const { qr, serverOrigin } = params;
  const phaseEmitter = new Emitter<MobilePairingTransportEvents>();
  let ws: WebSocket | null = null;
  let disposed = false;
  let settled = false;

  // 数据面缓冲:认证/桥接完成前收到的二进制帧先排队,SocketProtocol 建立后回放。
  const pendingBinary: ArrayBuffer[] = [];

  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  const socket: ISocket = {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws?.readyState === WebSocket.OPEN) {
        const payload = new Uint8Array(buffer.byteLength);
        payload.set(buffer.buffer.subarray(0, buffer.byteLength));
        ws.send(payload);
      }
    },
    end() {
      ws?.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws?.close();
    },
  };

  function fail(code: string, message?: string): void {
    if (settled) return;
    settled = true;
    phaseEmitter.fire({ phase: "closed", error: { code, message } });
    ws?.close();
  }

  function connect(): Promise<ISocket> {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error("transport disposed"));
        return;
      }
      const wsUrl = `${serverOrigin.replace(/^http/, "ws")}/mobile-pairing/ws`;
      phaseEmitter.fire({ phase: "connecting" });
      const sock = new WebSocket(wsUrl);
      sock.binaryType = "arraybuffer";
      ws = sock;

      const timeout = setTimeout(() => {
        fail("connection_timeout", "pairing handshake timeout");
        reject(new Error("pairing handshake timeout"));
      }, 30_000);

      const settle = (error?: Error) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          settled = true;
          resolve(socket);
        }
      };

      sock.addEventListener("open", () => {
        // 认证必须由手机发起:auth_init 是 relay 按 sid 路由的唯一依据,
        // 缺失时双方互相等待,最终 30s 握手超时。
        sock.send(
          JSON.stringify({
            type: "auth_init",
            role: MOBILE_PAIRING_AUTH_ROLE,
            device_sid: qr.sid,
            meta: { platform: "web", version: qr.appVersion || "web", name: "mobile-browser" },
          }),
        );
      });

      sock.addEventListener("error", () => {
        if (!settled) {
          settle(new Error("WebSocket connection failed"));
          fail("relay_unavailable", "WebSocket connection failed");
        }
      });

      sock.addEventListener("close", () => {
        onClose.fire();
        onEnd.fire();
        if (!settled) {
          settle(new Error("connection closed before ready"));
          fail("desktop_disconnected", "connection closed");
        } else {
          phaseEmitter.fire({ phase: "closed" });
        }
      });

      sock.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          void handleControlFrame(event.data).catch((error) => {
            settle(error instanceof Error ? error : new Error(String(error)));
            fail("internal_error", String(error));
          });
          return;
        }
        // 二进制数据帧。
        if (!settled) {
          pendingBinary.push(event.data as ArrayBuffer);
          return;
        }
        onData.fire(VSBuffer.wrap(new Uint8Array(event.data as ArrayBuffer)));
      });

      async function handleControlFrame(text: string): Promise<void> {
        const frame = JSON.parse(text) as { type?: string; nonce?: string; code?: string; message?: string; workspaceKey?: string };
        switch (frame?.type) {
          case "auth_challenge": {
            phaseEmitter.fire({ phase: "authenticating" });
            const proof = await calculateProofWeb(qr.hash, frame.nonce!, MOBILE_PAIRING_AUTH_ROLE, qr.sid);
            sock.send(
              JSON.stringify({
                type: "auth_response",
                device_sid: qr.sid,
                proof,
                client_ts: Date.now(),
              }),
            );
            return;
          }
          case "auth_ack": {
            phaseEmitter.fire({ phase: "bridging" });
            // 单窗口直连:workspaceKey 用 default;桌面侧仅回显。
            sock.send(JSON.stringify({ type: "bridge_request", workspaceKey: "default" }));
            return;
          }
          case "bridge_ready": {
            phaseEmitter.fire({ phase: "ready" });
            settle();
            // 回放认证期间缓存的二进制帧。
            for (const buffer of pendingBinary.splice(0)) {
              onData.fire(VSBuffer.wrap(new Uint8Array(buffer)));
            }
            return;
          }
          case "error": {
            const error = new Error(frame.message || frame.code || "pairing error");
            (error as Error & { code?: string }).code = frame.code;
            settle(error);
            fail(frame.code ?? "internal_error", frame.message);
            return;
          }
          default:
            return;
        }
      }
    });
  }

  return {
    socket,
    onPhaseChange: (listener) => {
      phaseEmitter.event(listener);
      return () => undefined;
    },
    connect,
    dispose() {
      disposed = true;
      ws?.close();
      phaseEmitter.dispose();
    },
  };
}

/** 便捷入口:完成握手后返回可直接喂 ChannelClient 的 protocol。 */
export async function connectMobilePairingTransport(params: {
  qr: MobilePairingQrPayload;
  serverOrigin: string;
}): Promise<SocketProtocol> {
  const transport = createMobilePairingTransport(params);
  const socket = await transport.connect();
  return new SocketProtocol(socket);
}
