/* 连接运行时:App 与桌面之间的连接生命周期唯一所有者。
 *
 * 职责(见 specs/mobile-app-native/spec.md §5):
 * - 启动策略:有设备凭证直连,无凭证进扫码页;
 * - ready 之后的**断线发现**(WS close 事实 + 空闲探活看门狗)与**自动重连**;
 * - 连接代际(generation):每次连上自增,UI 用它重挂屏幕、重建订阅;
 * - 凭证失效的终态处理(device_unknown/device_revoked/auth_failed → 清凭证回扫码页)。
 *
 * 关键区分(决定断线时的观感):
 * - **连接资源**(transport/client)断线即拆,否则在死 socket 上发命令会永久挂起;
 * - **渲染快照**(lastReady)保留,界面停在最后画面加一条重连横条,而不是闪回加载页。
 *
 * 建连流程本身在 connectionFlows(设备/扫码两条),探活计时在 connectionWatchdog;
 * 本文件只做状态机与所有权收口。不依赖 React,便于脚本驱动验证。
 */
import type { RemoteServiceAccess } from "@zcode/client";
import { uuidv7 } from "@zcode/shared";

import {
  clearDeviceCredential,
  loadDeviceCredential,
  saveDeviceCredential,
  type DeviceCredential,
} from "./deviceCredential";
import {
  PROBE_TIMEOUT_MS,
  classifyDisconnect,
  describeReconnectBanner,
  withTimeout,
} from "./connectionPolicy";
import { createConnectionWatchdog } from "./connectionWatchdog";
import {
  connectDeviceFlow,
  connectPairingFlow,
  type ConnectionFlowHost,
} from "./connectionFlows";
import type { PairingQrPayload } from "./pairingQr";
import { createConnectionTransport, type PairingTransport } from "./pairingTransport";

export interface ConnectionBanner {
  attempt: number;
  reason: string;
  message: string;
}

export type ConnectionRuntimeState =
  | { kind: "idle" }
  | { kind: "pair" }
  | {
      kind: "connecting";
      label: string;
      detail?: string;
      canCancel: boolean;
      /** 断线后的重连(界面应保留最后画面而不是整屏 loading)。 */
      reconnecting: boolean;
    }
  | { kind: "error"; code: string; canRetryAuto: boolean }
  | {
      kind: "ready";
      /** 渲染用快照;重连期间仍是旧对象(写入类操作靠 banner 判断禁用)。 */
      services: RemoteServiceAccess;
      mode: "pairing" | "device";
      generation: number;
      /** 连接级稳定 clientId:命令信封与握手都必须用它。 */
      clientId: string;
      /** 非空表示正在重连(界面加横条 + 禁用写入)。 */
      banner: ConnectionBanner | null;
    };

export interface ConnectionRuntimeDeps {
  /** 供脚本注入;生产用真实 transport。 */
  transportFactory?: (params: Parameters<typeof createConnectionTransport>[0]) => PairingTransport;
  now?: () => number;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  setTimeout?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  isAppActive?: () => boolean;
  credentialStore?: {
    load(): Promise<DeviceCredential | null>;
    save(credential: DeviceCredential): Promise<void>;
    clear(): Promise<void>;
  };
}

export interface ConnectionRuntime {
  subscribe(listener: () => void): () => void;
  getState(): ConnectionRuntimeState;
  /** 连接级 clientId(握手与命令信封共用);连接尚未建立时也可读。 */
  getClientId(): string;
  start(): void;
  connectWithQr(qr: PairingQrPayload): Promise<void>;
  retryFromError(): void;
  stopReconnect(): void;
  forgetDevice(): Promise<void>;
  disconnect(): void;
  /** 探活单次检查:定时器调用;脚本可借此驱动而不依赖真实时钟。 */
  tick(): Promise<void>;
  dispose(): void;
}

const INITIAL_STATE: ConnectionRuntimeState = { kind: "idle" };

/** 分类异常时的兜底退避(不应发生,保证不出现 0 延迟忙等)。 */
const RECONNECT_FALLBACK_MS = 1_000;

export function createConnectionRuntime(deps: ConnectionRuntimeDeps = {}): ConnectionRuntime {
  const transportFactory = deps.transportFactory ?? createConnectionTransport;
  const now = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutFn = deps.clearTimeout ?? ((handle) => clearTimeout(handle));
  const isAppActive = deps.isAppActive ?? (() => true);
  const credentialStore = deps.credentialStore ?? {
    load: loadDeviceCredential,
    save: saveDeviceCredential,
    clear: clearDeviceCredential,
  };


  /**
   * 连接级稳定的 v4 clientId:桌面 facade 在握手时把它绑定到该 attachment,
   * 之后所有命令信封必须复用同一个值。此前由每个 conversationTransport 实例各自
   * 生成,导致"返回列表再进会话"时新实例带未绑定的 clientId,命令被以
   * fault.command.clientMismatch 拒绝(表现为点了没反应)。
   */
  const clientId = `client-${uuidv7()}`;

  const listeners = new Set<() => void>();
  let state: ConnectionRuntimeState = INITIAL_STATE;
  /** 渲染快照:断线后仍保留,重连成功才替换。 */
  let lastReady: {
    services: RemoteServiceAccess;
    mode: "pairing" | "device";
    generation: number;
  } | null = null;
  let generation = 0;
  let credential: DeviceCredential | null = null;
  let transport: PairingTransport | null = null;
  /** 当前连接的 ChannelClient:断线时必须显式 dispose 让在途 RPC fail-closed。 */
  let client: { dispose(): void } | null = null;
  let phaseUnsub: (() => void) | null = null;
  let activityUnsub: (() => void) | null = null;
  /**
   * 全部待触发的定时器(重连退避 + 建连流程的初始重试共用一本账)。
   * 之前用单个字段记录,建连流程的定时器会覆盖它 → 被覆盖的那个再也清不掉,
   * 变成"看不到的链":既在同一次断线里并发重试(实测一次断线内跑 7 次失败),
   * 又可能在重连成功后触发、把健康的连接 teardown 掉。
   */
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let reconnectScheduled = false;
  let reconnectAttempt = 0;
  let disposed = false;

  function emit(next: ConnectionRuntimeState): void {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function emitError(code: string, canRetryAuto: boolean): void {
    lastReady = null;
    emit({ kind: "error", code, canRetryAuto });
  }

  /** 清掉所有待触发定时器(退避与初始重试一并作废)。 */
  function clearReconnectTimer(): void {
    for (const handle of pendingTimers) clearTimeoutFn(handle);
    pendingTimers.clear();
    reconnectScheduled = false;
  }

  /** 统一登记:定时器自己触发时也要出账,避免 Set 无限增长。 */
  function trackTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = setTimeoutFn(() => {
      pendingTimers.delete(handle);
      handler();
    }, ms);
    pendingTimers.add(handle);
    return handle;
  }

  /** 拆连接资源:让在途 RPC fail-closed(而不是在死连接上永久挂起)。 */
  function teardownConnection(): void {
    clearReconnectTimer();
    watchdog.stop();
    phaseUnsub?.();
    phaseUnsub = null;
    activityUnsub?.();
    activityUnsub = null;
    client?.dispose();
    client = null;
    transport?.dispose();
    transport = null;
  }

  /** 重连期间的界面状态:有渲染快照就停在上面加横条,否则回连接页。 */
  function emitReconnecting(reason: string, attempt: number): void {
    const nextRetryMs = reconnectDelayFor(reason, attempt);
    if (!lastReady) {
      emit({
        kind: "connecting",
        label: "正在连接桌面…",
        canCancel: true,
        reconnecting: true,
      });
      return;
    }
    emit({
      kind: "ready",
      services: lastReady.services,
      mode: lastReady.mode,
      generation: lastReady.generation,
      clientId,
      banner: {
        attempt,
        reason,
        message: describeReconnectBanner({ attempt, reason, nextRetryMs }),
      },
    });
  }

  function attachObservers(next: PairingTransport): void {
    phaseUnsub?.();
    activityUnsub?.();
    phaseUnsub = next.onPhaseChange((event) => {
      // 只认"连上之后断掉":带 error 的 closed 属于连接阶段失败,由 connect 的
      // reject 路径处理。
      if (event.phase !== "closed" || event.error) return;
      void handleConnectionLost({
        ...(event.closeCode !== undefined ? { closeCode: event.closeCode } : {}),
        ...(event.closeReason !== undefined ? { closeReason: event.closeReason } : {}),
      });
    });
    activityUnsub = next.onActivity((at) => {
      watchdog.noteActivity(at);
    });
  }

  function adoptConnection(
    next: PairingTransport,
    _services: RemoteServiceAccess,
    nextClient: { dispose(): void },
  ): void {
    transport = next;
    client = nextClient;
    attachObservers(next);
    watchdog.start();
  }

  function emitReady(mode: "pairing" | "device", services: RemoteServiceAccess): void {
    generation += 1;
    reconnectAttempt = 0;
    lastReady = { services, mode, generation };
    emit({ kind: "ready", services, mode, generation, clientId, banner: null });
  }

  async function handleConnectionLost(event: {
    closeCode?: number;
    closeReason?: string;
  }): Promise<void> {
    if (disposed || state.kind !== "ready" || state.banner) return;
    const action = classifyDisconnect({ ...event, attempt: reconnectAttempt + 1 });
    // 先拆死连接:否则"重试/发送/审批"会在死 socket 上永久挂起。
    teardownConnection();
    if (action.kind === "terminal") {
      reconnectAttempt = 0;
      emitError(action.code, false);
      return;
    }
    if (credential) {
      reconnectAttempt += 1;
      emitReconnecting(action.reason, reconnectAttempt);
      scheduleReconnect(action.reason);
      return;
    }
    // 没有可重放凭证(扫码模式且签发失败):只能让用户重新扫一次。
    reconnectAttempt = 0;
    emitError("desktop_disconnected", false);
  }

  /**
   * 下一次重试的退避时长。原因入参保证"文案里显示的秒数"与"实际排程"同源,
   * 且对端瞬时不可用时走更短的封顶(见 connectionPolicy)。
   */
  function reconnectDelayFor(reason: string, attempt: number): number {
    const action = classifyDisconnect({ closeReason: reason, attempt });
    return action.kind === "retry" ? action.delayMs : RECONNECT_FALLBACK_MS;
  }

  function scheduleReconnect(reason: string): void {
    // 同一时刻只允许一条重试链:重复排程是"一次断线跑出 7 次重试"的直接原因。
    if (reconnectScheduled) return;
    clearReconnectTimer();
    reconnectScheduled = true;
    const delay = reconnectDelayFor(reason, reconnectAttempt);
    trackTimeout(() => {
      reconnectScheduled = false;
      if (disposed) return;
      // 迟到的定时器不得惊动已经恢复的连接:此时状态已不是"重连中",直接作废。
      if (state.kind !== "ready" || !state.banner) return;
      const current = credential;
      if (!current) {
        emitError("device_unknown", false);
        return;
      }
      void connectDeviceFlow(flowHost, current, "reconnect", reason);
    }, delay);
  }

  async function tickOnce(): Promise<void> {
    if (disposed || state.kind !== "ready" || state.banner) return;
    const agent = lastReady?.services.zcodeAgentService;
    if (!agent) return;
    try {
      // helloConversationV4 在 host 侧是纯读、无副作用;死连接上的 RPC 不会自己
      // reject,必须显式超时。
      await withTimeout(agent.helloConversationV4(), PROBE_TIMEOUT_MS, "probe timeout");
      watchdog.noteActivity(now());
    } catch {
      await handleConnectionLost({ closeReason: "probe_timeout" });
    }
  }

  const watchdog = createConnectionWatchdog({
    now,
    isAppActive,
    ...(deps.setInterval ? { setInterval: deps.setInterval } : {}),
    ...(deps.clearInterval ? { clearInterval: deps.clearInterval } : {}),
    probe: async () => {
      const agent = lastReady?.services.zcodeAgentService;
      if (!agent) return false;
      await withTimeout(agent.helloConversationV4(), PROBE_TIMEOUT_MS, "probe timeout");
      return true;
    },
    onDead: () => {
      void handleConnectionLost({ closeReason: "probe_timeout" });
    },
  });

  /** 建连流程的宿主:状态与副作用收口在本文件(流程模块不持有状态)。 */
  const flowHost: ConnectionFlowHost = {
    now,
    createTransport: (params) => transportFactory(params),
    teardown: teardownConnection,
    adopt: adoptConnection,
    setCredential: (next) => {
      credential = next;
    },
    getCredential: () => credential,
    getAttempt: () => reconnectAttempt,
    setAttempt: (attempt) => {
      reconnectAttempt = attempt;
    },
    emitConnecting: (params) => emit({ kind: "connecting", ...params }),
    emitReconnecting,
    emitReady,
    emitError,
    clearCredential: async () => {
      credential = null;
      lastReady = null;
      await credentialStore.clear();
    },
    persistCredential: (saved) => credentialStore.save(saved),
    scheduleReconnect,
    clearReconnectTimer,
    setTimeout: (handler, ms) => trackTimeout(handler, ms),
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState() {
      return state;
    },
    getClientId() {
      return clientId;
    },
    start() {
      void (async () => {
        const stored = await credentialStore.load();
        if (disposed) return;
        credential = stored;
        if (!stored) {
          emit({ kind: "pair" });
          return;
        }
        await connectDeviceFlow(flowHost, stored, "initial");
      })();
    },
    connectWithQr(qr) {
      return connectPairingFlow(flowHost, qr);
    },
    retryFromError() {
      if (disposed) return;
      const target = credential;
      if (!target) {
        emit({ kind: "pair" });
        return;
      }
      reconnectAttempt = 0;
      void connectDeviceFlow(flowHost, target, "initial");
    },
    stopReconnect() {
      if (disposed) return;
      clearReconnectTimer();
      reconnectAttempt = 0;
      teardownConnection();
      emitError("manual_stop", true);
    },
    async forgetDevice() {
      clearReconnectTimer();
      reconnectAttempt = 0;
      teardownConnection();
      credential = null;
      lastReady = null;
      await credentialStore.clear();
      emit({ kind: "pair" });
    },
    disconnect() {
      clearReconnectTimer();
      reconnectAttempt = 0;
      teardownConnection();
      lastReady = null;
      emit({ kind: "pair" });
    },
    tick: tickOnce,
    dispose() {
      if (disposed) return;
      disposed = true;
      teardownConnection();
      listeners.clear();
      state = INITIAL_STATE;
    },
  };
}
