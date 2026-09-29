/* 连接流程:建立连接的两种方式(设备凭证 / 扫码配对)。
 *
 * 从 connectionRuntime 抽出的原因:两条流程的错误分支(凭证失效、初始退避、
 * 重连失败继续退避)加上注释体量很大,和状态机混在一个文件里会超单文件行数上限。
 * 这里只做"发起连接 + 成功后交接 + 失败后按策略回调",不持有状态。
 *
 * 状态与副作用全部通过 ConnectionFlowHost 回到运行时执行(单一所有者),
 * 因此本模块不引入第二套状态。
 */
import { ChannelClient, SocketProtocol } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";

import type { DeviceCredential } from "./deviceCredential";
import { reconnectDelayMs } from "./connectionPolicy";
import type { PairingQrPayload } from "./pairingQr";
import type { IssuedDeviceCredential, PairingTransport } from "./pairingTransport";

/** 首次连接的自动重试上限(与既有 RETRY_DELAYS_MS 长度一致)。 */
export const INITIAL_RETRY_LIMIT = 5;

export interface ConnectionFlowHost {
  now(): number;
  createTransport(params: Parameters<typeof import("./pairingTransport").createConnectionTransport>[0]): PairingTransport;
  /** 拆掉当前连接资源(在途 RPC fail-closed)。 */
  teardown(): void;
  /**
   * 连接成功后的交接:挂观察者、启动看门狗,并交出 ChannelClient——
   * 断线时必须由运行时显式 dispose 它,否则在途 RPC 会永久挂起。
   */
  adopt(next: PairingTransport, services: RemoteServiceAccess, client: { dispose(): void }): void;
  setCredential(credential: DeviceCredential | null): void;
  getCredential(): DeviceCredential | null;
  getAttempt(): number;
  /** tag 用于诊断轨迹(哪条路径改的计数)。 */
  setAttempt(attempt: number, tag?: string): void;
  emitConnecting(params: {
    label: string;
    detail?: string;
    canCancel: boolean;
    reconnecting: boolean;
  }): void;
  emitReconnecting(reason: string, attempt: number): void;
  emitReady(mode: "pairing" | "device", services: RemoteServiceAccess): void;
  emitError(code: string, canRetryAuto: boolean): void;
  /** 凭证失效:清库 + 归零,再由调用方决定 UI。 */
  clearCredential(): Promise<void>;
  /** 扫码后签发成功:落盘保存(失败不影响本次会话)。 */
  persistCredential(credential: DeviceCredential): Promise<void>;
  scheduleReconnect(reason: string): void;
  clearReconnectTimer(): void;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
}

export function describeErrorCode(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return error instanceof Error ? error.message : String(error);
}

export function isCredentialInvalidCode(code: string): boolean {
  return code === "device_unknown" || code === "device_revoked" || code === "auth_failed";
}

/**
 * 设备凭证连接。
 * - origin=initial:首次启动/手动重试,失败按 1s→30s 退避重试若干次后落到错误页;
 * - origin=reconnect:断线自动重连,失败无限退避(桌面重启是常态,不该要求手动重扫)。
 */
export async function connectDeviceFlow(
  host: ConnectionFlowHost,
  target: DeviceCredential,
  origin: "initial" | "reconnect",
  lastReason = "",
): Promise<void> {
  host.teardown();
  if (origin === "initial") {
    const attempt = host.getAttempt();
    host.emitConnecting({
      label: attempt === 0 ? "正在连接桌面…" : "连接失败，自动重试中…",
      ...(attempt === 0 ? {} : { detail: `即将进行第 ${attempt + 1} 次尝试` }),
      canCancel: true,
      reconnecting: false,
    });
  } else {
    host.emitReconnecting(lastReason, host.getAttempt());
  }

  const next = host.createTransport({
    auth: { mode: "device", credential: target },
    serverOrigin: target.relayOrigin,
  });
  try {
    const socket = await next.connect();
    const client = new ChannelClient(new SocketProtocol(socket));
    const services = new RemoteServiceAccess(client);
    host.setCredential(target);
    host.adopt(next, services, client);
    host.emitReady("device", services);
  } catch (error) {
    const code = describeErrorCode(error);
    // 失败的尝试也要关掉自己刚建的 transport:否则会留下半开的 WS,
    // 既泄漏连接,又可能被 relay 当作"另一台手机"顶替而产生多余 close 事件。
    next.dispose();
    host.teardown();
    if (isCredentialInvalidCode(code)) {
      await host.clearCredential();
      host.emitError(code, false);
      return;
    }
    if (origin === "reconnect") {
      host.setAttempt(host.getAttempt() + 1, "retry-fail");
      host.emitReconnecting(code, host.getAttempt());
      host.scheduleReconnect(code);
      return;
    }
    const attempt = host.getAttempt() + 1;
    host.setAttempt(attempt, "init-fail");
    if (attempt < INITIAL_RETRY_LIMIT) {
      const delay = reconnectDelayMs(attempt);
      host.emitConnecting({
        label: "连接失败，自动重试中…",
        detail: `${Math.round(delay / 1000)} 秒后第 ${attempt + 1} 次尝试`,
        canCancel: true,
        reconnecting: false,
      });
      host.clearReconnectTimer();
      host.setTimeout(() => {
        void connectDeviceFlow(host, target, "initial");
      }, delay);
      return;
    }
    host.emitError(code, true);
  }
}

/** 扫码配对连接:成功后最佳努力领取长期凭证,后续断线即可自动重连。 */
export async function connectPairingFlow(
  host: ConnectionFlowHost,
  qr: PairingQrPayload,
): Promise<void> {
  host.teardown();
  host.setAttempt(0, "pairing-start");
  host.emitConnecting({ label: "正在连接桌面…", canCancel: false, reconnecting: false });

  const next = host.createTransport({ auth: { mode: "pairing", qr }, serverOrigin: qr.origin });
  try {
    const socket = await next.connect();
    const client = new ChannelClient(new SocketProtocol(socket));
    const services = new RemoteServiceAccess(client);
    // 扫码模式暂无凭证;签发成功后(见下)断线也能自动重连。
    host.setCredential(null);
    host.adopt(next, services, client);
    host.emitReady("pairing", services);
    void next
      .requestDeviceCredential("Android 手机")
      .then(async (issued: IssuedDeviceCredential) => {
        const saved: DeviceCredential = {
          relayOrigin: qr.origin,
          hostId: issued.hostId,
          deviceId: issued.deviceId,
          deviceSecret: issued.deviceSecret,
          deviceName: "Android 手机",
          createdAt: host.now(),
        };
        host.setCredential(saved);
        // 复用运行时的凭证存储:失败只影响"下次是否免扫码"。
        await host.persistCredential(saved);
      })
      .catch(() => {});
  } catch (error) {
    const code = describeErrorCode(error);
    next.dispose();
    host.teardown();
    host.emitError(code, false);
  }
}
