/* 连接健康策略:断线分类、重连退避、空闲探活判定——纯函数,不做 IO。
 *
 * 为什么单独一层:这些规则决定"断线后是重连、放弃还是提示重新配对",判错的代价是
 * 手机在死连接上永久假在线(或两台手机互踢)。抽成纯函数后可以被验证脚本逐条覆盖,
 * App.tsx 只负责把信号接进来、把结论执行出去。
 */

/** relay 主动关闭手机连接时使用的应用码(见 packages/relay/src/main.ts)。 */
export const RELAY_APP_CLOSE_CODE = 4000;

/** 断线后的处置结论。 */
export type DisconnectAction =
  /** 可恢复:按 delayMs 退避重连。 */
  | { kind: "retry"; delayMs: number; reason: string }
  /** 不可重连:继续重连会与服务端状态冲突或注定失败。 */
  | { kind: "terminal"; code: string; reason: string };

/** 探活参数:前台且长时间无入站帧时才发探针,避免空跑耗电。 */
export const PROBE_IDLE_MS = 30_000;
export const PROBE_MIN_INTERVAL_MS = 15_000;
/** 探针等待上限:弱网首字节可能很慢,定得太短会把健康连接误判为断线并触发重连。 */
export const PROBE_TIMEOUT_MS = 15_000;
export const WATCHDOG_TICK_MS = 15_000;

/** 重连退避:1s 起翻倍,30s 封顶后固定(无限重连,不耗尽)。 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * "对端马上就会回来"的原因用更短的上限(10s):
 * relay 重启后桌面端要重新注册(按它自己的退避可能到 30s),这段时间手机只会拿到
 * pair_unknown。手机上沿用 30s 上限会让"桌面端 5 秒后回来了、手机却还要等 30 秒"
 * 这种组合延迟翻倍;这类原因下加密重试频率是划算的。
 */
export const RECONNECT_FAST_CAP_MS = 10_000;
const FAST_RECOVERY_REASONS = new Set([
  "pair_unknown",
  "host_disconnected",
  "closed_by_host",
  "relay_shutdown",
]);

export function reconnectDelayMs(attempt: number, capMs: number = RECONNECT_MAX_DELAY_MS): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return Math.min(RECONNECT_DELAYS_MS[0]!, capMs);
  const index = Math.min(Math.floor(attempt) - 1, RECONNECT_DELAYS_MS.length - 1);
  return Math.min(RECONNECT_DELAYS_MS[index]!, capMs);
}

/** 按原因选择退避上限:对端瞬时不可用 → 快恢复;网络类问题 → 保持长上限省电。 */
export function reconnectDelayForReason(reason: string, attempt: number): number {
  return reconnectDelayMs(
    attempt,
    FAST_RECOVERY_REASONS.has(reason) ? RECONNECT_FAST_CAP_MS : RECONNECT_MAX_DELAY_MS,
  );
}

/**
 * 断线分类:
 * - `superseded` 是**终止态**:同 sid/hostId 的新手机已接管,重连会让两台设备互踢,
 *   必须停下并告知用户;
 * - 其余(host 离线、relay 重启、桌面主动断开、异常 1006、探活超时)都是可恢复的,
 *   统一走退避重连——桌面重启是常态,不该让用户手动重扫。
 */
export function classifyDisconnect(input: {
  closeCode?: number;
  closeReason?: string;
  attempt: number;
}): DisconnectAction {
  const reason = input.closeReason?.trim() ?? "";
  if (input.closeCode === RELAY_APP_CLOSE_CODE && reason === "superseded") {
    return { kind: "terminal", code: "connection_superseded", reason };
  }
  return {
    kind: "retry",
    delayMs: reconnectDelayForReason(reason, input.attempt),
    reason: reason.length > 0 ? reason : input.closeCode === undefined ? "probe_timeout" : `close_${input.closeCode}`,
  };
}

/** 是否该发一次探针:前台、空闲足够久、且距上次探针有最小间隔。 */
export function shouldSendProbe(input: {
  now: number;
  /** 最后一次收到任何入站帧的时间;0 表示从未收到。 */
  lastInboundAt: number;
  /** 最后一次发出探针的时间;0 表示从未探过。 */
  lastProbeAt: number;
  appActive: boolean;
}): boolean {
  if (!input.appActive) return false;
  const idleBase = input.lastInboundAt > 0 ? input.lastInboundAt : 0;
  if (idleBase === 0) return false;
  if (input.now - idleBase < PROBE_IDLE_MS) return false;
  if (input.lastProbeAt > 0 && input.now - input.lastProbeAt < PROBE_MIN_INTERVAL_MS) return false;
  return true;
}

/** 探针超时包一层:死连接上的 RPC 不会自己 reject,必须显式超时。 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  timeoutMessage = "probe timeout",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DISCONNECT_REASON_LABEL: Record<string, string> = {
  host_disconnected: "桌面端已离线",
  relay_shutdown: "中继服务重启中",
  closed_by_host: "桌面端主动断开",
  pair_unknown: "桌面端尚未重新注册",
  auth_required: "会话需要重新认证",
  probe_timeout: "网络无响应",
};

/**
 * 重连横条文案:断开原因(用户能判断该等还是该重扫)+ 下次重试倒计时 + 第几次。
 * 倒计时让"还要等多久"可见,避免用户以为卡死而手动干预。
 */
export function describeReconnectBanner(input: {
  attempt: number;
  reason?: string;
  /** 下一次尝试的退避时长;省略则不显示倒计时。 */
  nextRetryMs?: number;
}): string {
  const ordinal = Math.max(1, Math.floor(input.attempt));
  const label = input.reason ? DISCONNECT_REASON_LABEL[input.reason] ?? input.reason : "";
  const countdown =
    input.nextRetryMs !== undefined ? `${Math.max(1, Math.round(input.nextRetryMs / 1000))} 秒后重试` : "";
  const head = label.length > 0 ? `连接已断开（${label}）` : "连接已断开";
  const tail = [countdown, `第 ${ordinal} 次`].filter((part) => part.length > 0).join(" · ");
  return tail.length > 0 ? `${head}，${tail}…` : `${head}，正在重连…`;
}
