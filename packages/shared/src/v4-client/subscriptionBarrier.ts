/* 订阅 ACK 激活屏障(客户端协议运行时)。
 *
 * 为什么必须存在:订阅响应只有 ACK,首帧 snapshot 是 ACK 之后的 notification,
 * 而 notification 与 RPC response 之间没有先后保证。缺这层暂存就会在"帧先到"时
 * 静默丢掉首帧快照(表现为会话面板永远空白)。
 *
 * 语义与 web/桌面 renderer 完全一致——此处是唯一实现,renderer 与手机 App 共用:
 * - subscribe 前 `begin(topic)`,拿到 ACK 后 `bind(token, subscriptionId)`,store 写入
 *   ownership 后 `activate(subscriptionId)` 回放暂存帧;
 * - 未激活 topic 的帧按 topic 有界暂存;越界整批作废并抛错(fail closed,绝不半批激活);
 * - `deliveryKind === "recovery"` 的批次是权威恢复,由调用方保证装配器先解门。
 *
 * 只依赖 Web 标准(TextEncoder):renderer、Web 与 RN(Hermes polyfill)均可运行。
 */
interface PendingFrameSubscription<T> {
  topic: string;
  subscriptionId: string | null;
  frames: T[];
  stagedBytes: number;
  overflowReason: string | null;
}

const MAX_STAGED_FRAMES = 1024;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;
const STAGING_OVERFLOW_REASON = "fault.subscription.initialFrameStagingOverflow";

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export interface AckActivationBarrier<T extends { topic: string; subscriptionId: string }> {
  begin(topic: string): object;
  bind(token: object, subscriptionId: string): void;
  cancel(token: object): void;
  activate(
    subscriptionId: string,
  ): { topic: string; previousSubscriptionId: string | null } | undefined;
  forget(subscriptionId: string): void;
  accept(frame: T): void;
  /** runtime/attachment generation invalidation:丢弃全部 active/pending ownership。 */
  clear(): void;
}

/** transport-local physical-wire barrier;同 topic 并发 pending 各自等 ACK 决定 owner。 */
export function createAckActivationBarrier<T extends { topic: string; subscriptionId: string }>(
  deliver: (frame: T) => void,
): AckActivationBarrier<T> {
  const pendingByTopic = new Map<string, Set<PendingFrameSubscription<T>>>();
  const pendingBySubscriptionId = new Map<string, PendingFrameSubscription<T>>();
  const activeByTopic = new Map<string, string>();
  const topicByActiveSubscription = new Map<string, string>();

  const removePending = (pending: PendingFrameSubscription<T>): void => {
    const group = pendingByTopic.get(pending.topic);
    group?.delete(pending);
    if (group?.size === 0) pendingByTopic.delete(pending.topic);
    if (pending.subscriptionId) {
      pendingBySubscriptionId.delete(pending.subscriptionId);
    }
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };

  return {
    begin(topic) {
      const pending: PendingFrameSubscription<T> = {
        topic,
        subscriptionId: null,
        frames: [],
        stagedBytes: 0,
        overflowReason: null,
      };
      const group = pendingByTopic.get(topic) ?? new Set();
      group.add(pending);
      pendingByTopic.set(topic, group);
      return pending;
    },
    bind(token, subscriptionId) {
      const pending = token as PendingFrameSubscription<T>;
      if (pending.overflowReason) {
        const reason = pending.overflowReason;
        removePending(pending);
        throw new Error(reason);
      }
      pending.subscriptionId = subscriptionId;
      pendingBySubscriptionId.set(subscriptionId, pending);
    },
    cancel(token) {
      removePending(token as PendingFrameSubscription<T>);
    },
    activate(subscriptionId) {
      const pending = pendingBySubscriptionId.get(subscriptionId);
      if (!pending) return;
      const previous = activeByTopic.get(pending.topic);
      if (previous && previous !== subscriptionId) {
        topicByActiveSubscription.delete(previous);
      }
      activeByTopic.set(pending.topic, subscriptionId);
      topicByActiveSubscription.set(subscriptionId, pending.topic);
      const frames = pending.frames.filter((frame) => frame.subscriptionId === subscriptionId);
      removePending(pending);
      for (const frame of frames) deliver(frame);
      return {
        topic: pending.topic,
        previousSubscriptionId: previous ?? null,
      };
    },
    forget(subscriptionId) {
      const pending = pendingBySubscriptionId.get(subscriptionId);
      if (pending) removePending(pending);
      const topic = topicByActiveSubscription.get(subscriptionId);
      if (topic && activeByTopic.get(topic) === subscriptionId) {
        activeByTopic.delete(topic);
      }
      topicByActiveSubscription.delete(subscriptionId);
    },
    accept(frame) {
      if (activeByTopic.get(frame.topic) === frame.subscriptionId) {
        deliver(frame);
        return;
      }
      const group = pendingByTopic.get(frame.topic);
      if (!group) return;
      const bytes = encodedBytes(frame);
      for (const pending of group) {
        if (pending.overflowReason) continue;
        if (
          bytes > MAX_STAGED_BYTES ||
          pending.frames.length + 1 > MAX_STAGED_FRAMES ||
          pending.stagedBytes + bytes > MAX_STAGED_BYTES
        ) {
          // 通过 shift 头部来"维持上限"会留下一个看似可激活、
          // 实际缺片的 physical batch。越界必须整批清空并让 subscribe 明确失败。
          pending.frames.length = 0;
          pending.stagedBytes = 0;
          pending.overflowReason = STAGING_OVERFLOW_REASON;
          continue;
        }
        pending.frames.push(frame);
        pending.stagedBytes += bytes;
      }
    },
    clear() {
      for (const group of pendingByTopic.values()) {
        for (const pending of group) {
          pending.frames.length = 0;
          pending.stagedBytes = 0;
        }
      }
      pendingByTopic.clear();
      pendingBySubscriptionId.clear();
      activeByTopic.clear();
      topicByActiveSubscription.clear();
    },
  };
}
