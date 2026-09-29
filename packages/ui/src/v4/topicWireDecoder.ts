// 实现已下沉到 @zcode/shared/v4-client;这里保留 renderer 侧的日志/告警接线。
import {
  createTopicWireDecoder as createSharedTopicWireDecoder,
  type TopicWireDecoder,
} from "@zcode/shared/v4-client";
import { logger } from "@/logger.js";

export type { TopicWireDecoder };

/**
 * renderer 侧 physical → logical 原子边界(实现见 @zcode/shared/v4-client):
 * 与手机 App 共用同一份 fail-closed 门控,差异只在 fault 记录到 renderer 日志。
 */
export function createTopicWireDecoder<F extends { topic: string; subscriptionId: string }>(
  ...args: Parameters<typeof createSharedTopicWireDecoder<F>>
): TopicWireDecoder<F> {
  const [assembler, deliver, onFault] = args;
  return createSharedTopicWireDecoder(assembler, deliver, (fault) => {
    logger.warn("[v4-topic-wire] physical assembly rejected", fault);
    onFault?.(fault);
  });
}
