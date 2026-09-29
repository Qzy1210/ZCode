/* 手机 App 的连接传输层(双模式):WS 控制面(JSON 文本帧)+ 数据面(二进制帧,SocketProtocol 线格式)。
 *
 * - pairing 模式:扫二维码建立会话(10 分钟 TTL),与 web 端 /remote 同协议;
 * - device 模式:用 SecureStore 中的长期凭证免扫码连接(hostId 经 relay 路由)。
 * 两者认证完成后共用同一条桥接/数据面链路,协议帧与桌面 mobilePairingSession 对偶。
 */
import { Emitter, VSBuffer, type ISocket } from "@zcode/rpc";
import {
  MOBILE_APP_AUTH_ROLE,
  MOBILE_PAIRING_AUTH_ROLE,
  calculateMobilePairingProofPure,
} from "@zcode/shared";

import type { DeviceCredential } from "./deviceCredential";
import type { PairingQrPayload } from "./pairingQr";

export type ConnectionAuth =
  | { mode: "pairing"; qr: PairingQrPayload }
  | { mode: "device"; credential: DeviceCredential };

export type PairingTransportPhase =
  | "connecting"
  | "authenticating"
  | "bridging"
  | "ready"
  | "closed";

export interface PairingTransportEvents {
  phase: PairingTransportPhase;
  error?: { code: string; message?: string };
  /** ready 之后的关闭:透传 relay/网络给的 CloseEvent 事实,供重连策略分类。 */
  closeCode?: number;
  closeReason?: string;
}

export interface IssuedDeviceCredential {
  hostId: string;
  deviceId: string;
  deviceSecret: string;
}

export interface PairingTransport {
  readonly socket: ISocket;
  /** 返回退订函数:每次重连都新建 transport,若不退订会叠加监听器。 */
  readonly onPhaseChange: (listener: (event: PairingTransportEvents) => void) => () => void;
  /**
   * 任何入站消息(控制帧/二进制帧)都会触发:这是"连接还活着"的唯一证据,
   * 探活看门狗据此判断是否需要主动探针。
   */
  readonly onActivity: (listener: (at: number) => void) => () => void;
  /** 发起认证与桥接;resolve 于 bridge_ready,reject 于 error/关闭。 */
  connect(): Promise<ISocket>;
  /**
   * 仅在扫码(pairing)会话认证成功后可用:请求桌面签发长期设备凭证。
   * 拿到后应写入 SecureStore,后续用 device 模式免扫码连接。
   */
  requestDeviceCredential(deviceName: string): Promise<IssuedDeviceCredential>;
  dispose(): void;
}

export function createConnectionTransport(params: {
  auth: ConnectionAuth;
  /** 二维码/凭证对应的服务 origin(relay 或局域网桌面服务)。 */
  serverOrigin: string;
}): PairingTransport {
  const { auth, serverOrigin } = params;
  const isDeviceMode = auth.mode === "device";
  const authRole = isDeviceMode ? MOBILE_APP_AUTH_ROLE : MOBILE_PAIRING_AUTH_ROLE;
  const authId = isDeviceMode ? auth.credential.deviceId : auth.qr.sid;
  const authSecret = isDeviceMode ? auth.credential.deviceSecret : auth.qr.hash;

  const phaseEmitter = new Emitter<PairingTransportEvents>();
  const activityEmitter = new Emitter<number>();
  let ws: WebSocket | null = null;
  let disposed = false;
  let settled = false;
  let pendingCredentialRequest: {
    resolve: (credential: IssuedDeviceCredential) => void;
    reject: (error: Error) => void;
  } | null = null;

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
        // 认证必须由手机发起:两种模式的发起帧不同,其余帧格式共用。
        sock.send(
          JSON.stringify(
            isDeviceMode
              ? {
                  type: "app_auth_init",
                  hostId: auth.credential.hostId,
                  deviceId: auth.credential.deviceId,
                }
              : {
                  type: "auth_init",
                  role: MOBILE_PAIRING_AUTH_ROLE,
                  device_sid: auth.qr.sid,
                  meta: { platform: "app", version: auth.qr.appVersion || "app", name: "zcode-app" },
                },
          ),
        );
      });

      sock.addEventListener("error", () => {
        if (!settled) {
          settle(new Error("WebSocket connection failed"));
          fail("relay_unavailable", "WebSocket connection failed");
        }
      });

      sock.addEventListener("close", (event) => {
        onClose.fire();
        onEnd.fire();
        if (pendingCredentialRequest) {
          pendingCredentialRequest.reject(new Error("connection closed"));
          pendingCredentialRequest = null;
        }
        // relay 会用 4000 + reason 说明关闭原因(superseded / host_disconnected /
        // relay_shutdown …)。这是重连策略唯一的事实来源,不能丢。
        const closeEvent = event as CloseEvent | undefined;
        if (!settled) {
          settle(new Error("connection closed before ready"));
          fail("desktop_disconnected", "connection closed");
        } else {
          phaseEmitter.fire({
            phase: "closed",
            ...(typeof closeEvent?.code === "number" ? { closeCode: closeEvent.code } : {}),
            ...(typeof closeEvent?.reason === "string" && closeEvent.reason.length > 0
              ? { closeReason: closeEvent.reason }
              : {}),
          });
        }
      });

      sock.addEventListener("message", (event) => {
        // 探活看门狗的唯一依据:收到任何帧即视为连接存活。
        activityEmitter.fire(Date.now());
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
          hostId?: string;
          deviceId?: string;
          deviceSecret?: string;
        };
        switch (frame?.type) {
          case "auth_challenge":
          case "app_auth_challenge": {
            phaseEmitter.fire({ phase: "authenticating" });
            const proof = calculateMobilePairingProofPure(
              authSecret,
              frame.nonce ?? "",
              authRole,
              authId,
            );
            sock.send(
              JSON.stringify(
                isDeviceMode
                  ? {
                      type: "app_auth_response",
                      deviceId: authId,
                      proof,
                      client_ts: Date.now(),
                    }
                  : { type: "auth_response", device_sid: authId, proof, client_ts: Date.now() },
              ),
            );
            return;
          }
          case "auth_ack":
          case "app_auth_ack": {
            phaseEmitter.fire({ phase: "bridging" });
            // 单窗口直连:workspaceKey 用 default;桌面侧仅回显。
            sock.send(JSON.stringify({ type: "bridge_request", workspaceKey: "default" }));
            return;
          }
          case "device_registered": {
            if (
              pendingCredentialRequest &&
              typeof frame.hostId === "string" &&
              typeof frame.deviceId === "string" &&
              typeof frame.deviceSecret === "string"
            ) {
              pendingCredentialRequest.resolve({
                hostId: frame.hostId,
                deviceId: frame.deviceId,
                deviceSecret: frame.deviceSecret,
              });
              pendingCredentialRequest = null;
            }
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
      const disposable = phaseEmitter.event(listener);
      return () => disposable.dispose();
    },
    onActivity: (listener) => {
      const disposable = activityEmitter.event(listener);
      return () => disposable.dispose();
    },
    connect,
    requestDeviceCredential(deviceName: string): Promise<IssuedDeviceCredential> {
      if (isDeviceMode) {
        return Promise.reject(new Error("device credential already in use"));
      }
      if (!settled || ws?.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("connection not ready"));
      }
      if (pendingCredentialRequest) {
        return Promise.reject(new Error("credential request already pending"));
      }
      return new Promise<IssuedDeviceCredential>((resolve, reject) => {
        pendingCredentialRequest = { resolve, reject };
        ws?.send(JSON.stringify({ type: "app_register_request", deviceName }));
        // 超时兜底:8 秒未收到 device_registered 视为失败,不阻塞主流程。
        setTimeout(() => {
          if (pendingCredentialRequest) {
            pendingCredentialRequest.reject(new Error("credential request timed out"));
            pendingCredentialRequest = null;
          }
        }, 8_000);
      });
    },
    dispose() {
      disposed = true;
      ws?.close();
      phaseEmitter.dispose();
      activityEmitter.dispose();
    },
  };
}
