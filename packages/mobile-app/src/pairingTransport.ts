/* 手机 App 的配对传输层:WS 控制面(JSON 文本帧)+ 数据面(二进制帧,SocketProtocol 线格式)。
 *
 * 与 packages/web/src/remote/mobilePairingTransport.ts 同协议、同帧格式,
 * 仅把浏览器耦合点换成 RN 可用实现(Hermes 的 URL/btoa/TextEncoder 由 polyfills 兜底)。
 *
 * - 控制帧:auth_init / auth_challenge / auth_response / auth_ack / error /
 *   bridge_request / bridge_ready。
 * - 数据帧:二进制,13B SocketProtocol Regular 头 + RPC body;经 ISocket 适配后
 *   直接交给 @zcode/rpc SocketProtocol 复用,ChannelClient 零改动。
 */
import { Emitter, VSBuffer, SocketProtocol, type ISocket } from "@zcode/rpc";
import { MOBILE_PAIRING_AUTH_ROLE, calculateMobilePairingProofPure } from "@zcode/shared";

import type { PairingQrPayload } from "./pairingQr";

export type PairingTransportPhase =
  | "connecting"
  | "authenticating"
  | "bridging"
  | "ready"
  | "closed";

export interface PairingTransportEvents {
  phase: PairingTransportPhase;
  error?: { code: string; message?: string };
}

export interface PairingTransport {
  readonly socket: ISocket;
  readonly onPhaseChange: (listener: (event: PairingTransportEvents) => void) => () => void;
  /** 发起认证与桥接;resolve 于 bridge_ready,reject 于 error/关闭。 */
  connect(): Promise<ISocket>;
  dispose(): void;
}

export function createPairingTransport(params: {
  qr: PairingQrPayload;
  /** 二维码所在服务 origin(relay 或局域网桌面服务)。 */
  serverOrigin: string;
}): PairingTransport {
  const { qr, serverOrigin } = params;
  const phaseEmitter = new Emitter<PairingTransportEvents>();
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
        // 认证必须由手机发起:auth_init 是按 sid 路由的唯一依据。
        sock.send(
          JSON.stringify({
            type: "auth_init",
            role: MOBILE_PAIRING_AUTH_ROLE,
            device_sid: qr.sid,
            meta: { platform: "app", version: qr.appVersion || "app", name: "zcode-app" },
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
          void handleControlFrame(event.data).catch((error: unknown) => {
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
        const frame = JSON.parse(text) as {
          type?: string;
          nonce?: string;
          code?: string;
          message?: string;
          workspaceKey?: string;
        };
        switch (frame?.type) {
          case "auth_challenge": {
            phaseEmitter.fire({ phase: "authenticating" });
            const proof = calculateMobilePairingProofPure(
              qr.hash,
              frame.nonce ?? "",
              MOBILE_PAIRING_AUTH_ROLE,
              qr.sid,
            );
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
export async function connectPairingTransport(params: {
  qr: PairingQrPayload;
  serverOrigin: string;
}): Promise<SocketProtocol> {
  const transport = createPairingTransport(params);
  const socket = await transport.connect();
  return new SocketProtocol(socket);
}
