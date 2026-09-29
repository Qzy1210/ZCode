/* 空闲探活看门狗:发现"socket 没报错但实际已死"的半开连接。
 *
 * 为什么需要单独一层:WS close 只覆盖"对端明确关闭"的情形;手机切网、NAT 超时、
 * 链路黑洞时 socket 会静静地什么都不发生,界面就永远停在旧数据上。判定所需的
 * 时间规则是纯函数(connectionPolicy),这里只负责计时与触发探针。
 *
 * 触发条件(全部满足才探,避免空跑耗电):前台、距最后一次入站帧 ≥ PROBE_IDLE_MS、
 * 距上一次探针 ≥ PROBE_MIN_INTERVAL_MS。探针本身由调用方提供(真实实现是
 * helloConversationV4 + 显式超时),探针成功视为一次入站活动。
 */
import {
  PROBE_MIN_INTERVAL_MS,
  WATCHDOG_TICK_MS,
  shouldSendProbe,
} from "./connectionPolicy";

export interface ConnectionWatchdog {
  /** 任何入站帧都要调用:这是"连接还活着"的唯一证据。 */
  noteActivity(at: number): void;
  start(): void;
  stop(): void;
}

export function createConnectionWatchdog(params: {
  now: () => number;
  isAppActive: () => boolean;
  /** 返回 true 表示探针成功;false/抛错视为连接已死。 */
  probe: () => Promise<boolean>;
  onDead: (reason: string) => void;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}): ConnectionWatchdog {
  const now = params.now;
  const setIntervalFn = params.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn = params.clearInterval ?? ((handle) => clearInterval(handle));

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastInboundAt = 0;
  let lastProbeAt = 0;
  let probing = false;

  async function tick(): Promise<void> {
    if (probing) return;
    if (
      !shouldSendProbe({
        now: now(),
        lastInboundAt,
        lastProbeAt,
        appActive: params.isAppActive(),
      })
    ) {
      return;
    }
    probing = true;
    lastProbeAt = now();
    try {
      const alive = await params.probe();
      if (alive) lastInboundAt = now();
      else params.onDead("probe_timeout");
    } catch {
      params.onDead("probe_timeout");
    } finally {
      probing = false;
    }
  }

  return {
    noteActivity(at) {
      lastInboundAt = at;
    },
    start() {
      this.stop();
      lastInboundAt = now();
      lastProbeAt = now() - PROBE_MIN_INTERVAL_MS;
      timer = setIntervalFn(() => {
        void tick();
      }, WATCHDOG_TICK_MS);
    },
    stop() {
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
      lastInboundAt = 0;
      lastProbeAt = 0;
    },
  };
}
