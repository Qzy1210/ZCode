import { randomUUID } from "node:crypto";
import { MessageChannelMain, type MessagePortMain } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  HostMessageTypes,
  mobilePairingAuthAckFrameSchema,
  mobilePairingAuthChallengeSchema,
  mobilePairingBridgeReadyFrameSchema,
  mobilePairingErrorFrameSchema,
  type MobilePairingServerFrame,
} from "@zcode/shared";
import {
  generateMobilePairingAttachmentId,
  type MobilePairingManager,
} from "./mobilePairingManager.js";

/**
 * 配对会话处理器:控制面状态机 + Host MessagePort 桥(数据面)。
 *
 * 从 mobilePairingServer 抽出,LAN server 与 relay 客户端共用:
 * - LAN:transport = 本机 WebSocket
 * - relay:transport = 出站 WS 上的中继帧
 * 认证逻辑始终走本地 pairingManager(relay 不持有 secret,保持哑管道)。
 */

/** SocketProtocol Regular 帧头长度(1 type + 4 id + 4 ack + 4 length)。 */
export const RPC_HEADER_SIZE = 13;
/** ProtocolMessageType.Regular。 */
export const PROTOCOL_MESSAGE_TYPE_REGULAR = 1;

/** 会话处理器与传输层的读写界面(由各传输模式实现)。 */
export interface MobilePairingSessionTransport {
  /** 发送控制面 JSON 文本帧。 */
  sendControlFrame(text: string): void;
  /** 发送数据面二进制帧(完整 SocketProtocol 帧)。 */
  sendDataFrame(bytes: Uint8Array): void;
  /** 关闭底层传输(错误帧发完后调用)。 */
  close(): void;
}

export interface CreateMobilePairingSessionOptions {
  pairingManager: MobilePairingManager;
  resolveBridgeHost: () => ElectronUtilityProcess | null;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

export interface MobilePairingSession {
  /** 收到传输层控制面文本帧。 */
  handleControlFrame(text: string): void;
  /** 收到传输层数据面二进制帧(完整 SocketProtocol 帧)。 */
  handleDataFrame(bytes: Uint8Array): void;
  /** 传输层已关闭:释放 Host attachment。 */
  handleTransportClosed(): void;
}

export function createMobilePairingSession(
  transport: MobilePairingSessionTransport,
  options: CreateMobilePairingSessionOptions,
): MobilePairingSession {
  const { pairingManager, resolveBridgeHost, logger } = options;
  let sid = "";
  let authed = false;
  let hostPort: MessagePortMain | null = null;
  let hostProcess: ElectronUtilityProcess | null = null;
  let attachmentId: string | null = null;

  function sendFrame(frame: MobilePairingServerFrame): void {
    transport.sendControlFrame(JSON.stringify(frame));
  }

  function sendErrorAndClose(code: string, message?: string): void {
    const parsed = mobilePairingErrorFrameSchema.safeParse({ type: "error", code, message });
    if (parsed.success) sendFrame(parsed.data);
    transport.close();
  }

  /** Host → 手机:裸 RPC body 加 SocketProtocol Regular 头。 */
  function encodeHostFrameForWs(body: Uint8Array): Uint8Array {
    const frame = new Uint8Array(RPC_HEADER_SIZE + body.byteLength);
    frame[0] = PROTOCOL_MESSAGE_TYPE_REGULAR;
    const view = new DataView(frame.buffer);
    view.setUint32(1, 0, false);
    view.setUint32(5, 0, false);
    view.setUint32(9, body.byteLength, false);
    frame.set(body, RPC_HEADER_SIZE);
    return frame;
  }

  /** 手机 → Host:校验并剥离 SocketProtocol 头,得到裸 RPC body。 */
  function decodeWsFrameToHostBody(payload: Uint8Array): Uint8Array | null {
    if (payload.byteLength < RPC_HEADER_SIZE) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const type = view.getUint8(0);
    const length = view.getUint32(9, false);
    if (type !== PROTOCOL_MESSAGE_TYPE_REGULAR) return null;
    if (payload.byteLength !== RPC_HEADER_SIZE + length) return null;
    return new Uint8Array(payload.subarray(RPC_HEADER_SIZE));
  }

  function teardownBridge(): void {
    if (hostPort) {
      try {
        hostPort.close();
      } catch {
        // port 已关闭时忽略。
      }
      hostPort = null;
    }
    if (hostProcess && attachmentId) {
      try {
        hostProcess.postMessage({
          type: HostMessageTypes.DetachServicePort,
          attachmentId,
        });
      } catch {
        // host 退出中时忽略。
      }
    }
    hostProcess = null;
    attachmentId = null;
  }

  /** 认证后:向窗口 Host 发 attach-service-port,建立 MessagePort 桥。 */
  function establishBridge(workspaceKey: string): void {
    const targetHost = resolveBridgeHost();
    if (!targetHost) {
      sendErrorAndClose("workspace_unavailable", "no window host available");
      return;
    }
    if (hostPort) {
      // 已桥接:重复 bridge_request 幂等回 ready。
      sendFrame(
        mobilePairingBridgeReadyFrameSchema.parse({ type: "bridge_ready", workspaceKey }),
      );
      return;
    }
    const newAttachmentId = generateMobilePairingAttachmentId();
    const { port1, port2 } = new MessageChannelMain();
    targetHost.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: randomUUID(),
        attachmentId: newAttachmentId,
        // 手机 shared-host 必须 replayable(与桌面刷新的 continuous 相对),Host 侧据此
        // 走 pendingStartupAttachments 等待与 replayable mirror 发布。
        clientMode: "web-remote-replayable",
        scope: { kind: "local" },
      },
      [port2],
    );
    hostProcess = targetHost;
    hostPort = port1;
    attachmentId = newAttachmentId;

    port1.on("message", (event) => {
      const data = event.data;
      // MessagePortProtocol 语义:只有真实 Uint8Array 是 RPC binary,控制对象忽略。
      if (data instanceof Uint8Array && data.byteLength > 0) {
        transport.sendDataFrame(encodeHostFrameForWs(data));
      }
    });
    port1.start();

    sendFrame(
      mobilePairingBridgeReadyFrameSchema.parse({ type: "bridge_ready", workspaceKey }),
    );
    logger.info(`[mobile-pairing] bridge established, sid=${sid.slice(0, 6)}…`);
  }

  function handleAuthInit(record: { device_sid?: unknown }): void {
    const candidate = typeof record.device_sid === "string" ? record.device_sid : "";
    const begin = pairingManager.beginAuth(candidate);
    if (!begin.ok) {
      sendErrorAndClose(begin.code);
      return;
    }
    sid = candidate;
    sendFrame(
      mobilePairingAuthChallengeSchema.parse({
        type: "auth_challenge",
        nonce: begin.challenge.nonce,
      }),
    );
  }

  function handleAuthResponse(record: {
    device_sid?: unknown;
    proof?: unknown;
    client_ts?: unknown;
  }): void {
    if (!sid || record.device_sid !== sid) {
      sendErrorAndClose("auth_failed");
      return;
    }
    const verify = pairingManager.verifyAuth({
      sid,
      proof: typeof record.proof === "string" ? record.proof : "",
      clientTs: typeof record.client_ts === "number" ? record.client_ts : 0,
    });
    if (!verify.ok) {
      sendErrorAndClose(verify.code);
      return;
    }
    authed = true;
    sendFrame(
      mobilePairingAuthAckFrameSchema.parse({ type: "auth_ack", pair_status: "paired" }),
    );
  }

  return {
    handleControlFrame(text) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        sendErrorAndClose("auth_failed", "malformed frame");
        return;
      }
      const record = json as {
        type?: string;
        device_sid?: string;
        proof?: string;
        client_ts?: number;
        workspaceKey?: string;
      };
      if (authed) {
        if (record?.type === "bridge_request" && typeof record.workspaceKey === "string") {
          establishBridge(record.workspaceKey);
          return;
        }
        sendErrorAndClose("internal_error", "unsupported control frame after auth");
        return;
      }
      if (record?.type === "auth_init") {
        handleAuthInit(record);
        return;
      }
      if (record?.type === "auth_response") {
        handleAuthResponse(record);
        return;
      }
      sendErrorAndClose("auth_failed", "auth required");
    },
    handleDataFrame(bytes) {
      if (!authed || !hostPort) {
        sendErrorAndClose("bridge_failed", "bridge not established");
        return;
      }
      const body = decodeWsFrameToHostBody(bytes);
      if (!body) {
        sendErrorAndClose("internal_error", "bad rpc frame");
        return;
      }
      hostPort.postMessage(body);
    },
    handleTransportClosed() {
      teardownBridge();
    },
  };
}
