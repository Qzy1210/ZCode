/* App 侧会话传输层:把 "订阅 → 帧 → 逻辑帧" 的时序收口到一处。
 *
 * 与桌面/Web 完全同协议,且共用 @zcode/shared/v4-client 的运行时件:
 * - 握手:`ensureAgentV4ClientHandshake`(clientKind "mobileApp");
 * - 帧:notification → ACK 屏障(首帧可能先于 ACK 到达)→ 分片装配 → schema 校验;
 * - 重同步/分页/发送都在这里,store 只消费逻辑帧。
 *
 * 生命周期:由会话屏创建、随屏销毁;dispose 时退订并清空装配器,
 * 不让上一条会话的残留分片污染下一次订阅。
 */
import type { RemoteServiceAccess } from "@zcode/client";
import {
  TopicWireFrameAssembler,
  conversationTopicFrameSchema,
  type CommandAck,
  type ConversationRow,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
  type TopicFrameDeliveryKind,
  type CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 交互应答形状直接从命令 payload schema 派生(shared 是协议唯一来源),
 * 避免 App 自己声明一份可能漂移的类型。
 */
export type InteractionAnswer = CommandPayloadMap["resolveInteraction"]["answer"];
import { createAckActivationBarrier, createTopicWireDecoder } from "@zcode/shared/v4-client";
import { createAgentCommandClient, MOBILE_APP_VERSION } from "./agentCommandClient";

export { MOBILE_APP_VERSION };

/** 草稿级发送选项(随本次输入提交,与桌面 composer 语义一致)。 */
export interface SendTextOptions {
  modelSelection?: CommandPayloadMap["sendText"]["modelSelection"];
  mode?: CommandPayloadMap["sendText"]["mode"];
  planEnabled?: boolean;
}

export interface ConversationWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface ConversationSubscription {
  subscriptionId: string;
  topic: string;
  mode: "snapshot" | "resume";
  logEpoch: string;
}

export interface OlderRowsPage {
  rows: ConversationRow[];
  hasMore: boolean;
  atLogEpoch: string;
}

export interface ConversationTransport {
  subscribeSession(
    sessionId: string,
    options?: { base?: { logEpoch: string; seq: number } },
  ): Promise<ConversationSubscription>;
  /** base=null 表示本地水位已不可用,要求 Host 强制回快照。 */
  resync(subscription: ConversationSubscription, base: { logEpoch: string; seq: number } | null): Promise<void>;
  unsubscribe(subscription: ConversationSubscription): Promise<void>;
  loadOlder(sessionId: string, beforeRowId: number, limit: number): Promise<OlderRowsPage>;
  /**
   * 发送文本。options 是"本次输入"的草稿级选择(模型/模式/计划开关),
   * 与桌面 composer 语义一致:只影响这一条输入,不立即改会话级配置。
   */
  sendText(
    sessionId: string,
    text: string,
    options?: SendTextOptions,
  ): Promise<CommandAck>;
  /** 审批/问答/计划批准的应答;answer 形状由 interactionModel 构造。 */
  resolveInteraction(sessionId: string, interactionId: string, answer: InteractionAnswer): Promise<CommandAck>;
  /** 中断当前 turn;expectedForegroundExecutionId 取自 control.activeWorks。 */
  stop(sessionId: string, expectedForegroundExecutionId?: string): Promise<CommandAck>;
  /** 取消后台工作(长跑 bash/子代理/工作流)。 */
  cancelBackgroundWork(sessionId: string, workId: string): Promise<CommandAck>;
  /** 暂停交互的自动结束倒计时(用户开始作答时调用,幂等)。 */
  snoozeInteraction(sessionId: string, interactionId: string): Promise<CommandAck>;
  /** 队列:立即发送 / 删除(CAS 命令,需 baseRevision)。 */
  sendQueuedNow(sessionId: string, queueItemId: string, baseRevision: number): Promise<CommandAck>;
  removeQueuedItem(sessionId: string, queueItemId: string, baseRevision: number): Promise<CommandAck>;
  onFrame(
    listener: (frame: ConversationTopicFrame, deliveryKind: TopicFrameDeliveryKind) => void,
  ): void;
  onSyncIssue(listener: (issue: { code: string; message: string }) => void): void;
  /**
   * 释放 barrier 暂存的订阅首帧。必须由 store 在写入 ownership(subscription 赋值)
   * **之后**调用:首帧可能先于订阅 RPC 响应到达,barrier 暂存并在 activate 时同步回放,
   * 若 ownership 尚未就位,回放帧会被 applyFrame 的 subscriptionId 检查丢弃,
   * 界面停在"正在加载会话…"直到下一次 resync(桌面 store 同序,见其注释)。
   */
  activate(subscriptionId: string): void;
  dispose(): void;
}

export function createConversationTransport(params: {
  services: RemoteServiceAccess;
  target: ConversationWorkspaceTarget;
  /**
   * 连接级稳定 clientId(由 connectionRuntime 下发)。
   * 不能用每实例新生成的值:桌面 facade 在握手时绑定它,之后命令信封必须一致,
   * 否则第二个会话屏实例的命令会被拒(clientMismatch,表现为点了没反应)。
   */
  clientId: string;
}): ConversationTransport {
  const { services, target, clientId } = params;
  const agent = services.zcodeAgentService;
  const workspace = {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
  const frameListeners = new Set<
    (frame: ConversationTopicFrame, deliveryKind: TopicFrameDeliveryKind) => void
  >();
  const issueListeners = new Set<(issue: { code: string; message: string }) => void>();
  let disposed = false;

  const decoder = createTopicWireDecoder(
    new TopicWireFrameAssembler(conversationTopicFrameSchema),
    (frame, deliveryKind) => {
      if (disposed) return;
      for (const listener of frameListeners) listener(frame, deliveryKind);
    },
    (fault) => {
      // 装配失败必须上报,否则界面停在旧内容上而无人知道。
      for (const listener of issueListeners) {
        listener({ code: fault.reasonCode ?? "frame_assembly_failed", message: "会话帧接收异常" });
      }
    },
  );
  const barrier = createAckActivationBarrier<ConversationTopicWireCandidate>((wire) => {
    decoder.accept(wire);
  });

  const upstream = agent.onDynamicConversationFrame(workspace)((wire) => {
    if (disposed) return;
    barrier.accept(wire);
  });

  // 握手与信封统一走命令客户端:clientId 必须与握手绑定值一致,否则桌面报 clientMismatch。
  const commands = createAgentCommandClient({ services, clientId, workspace: target });

  return {
    async subscribeSession(sessionId, options) {
      await commands.ensureReady();
      const topic = `conversation/${sessionId}`;
      const pending = barrier.begin(topic);
      try {
        const result = await agent.subscribeConversationV4({
          ...workspace,
          sessionId,
          ...(options?.base ? { base: options.base } : {}),
          visibility: "foreground",
        });
        barrier.bind(pending, result.ack.subscriptionId);
        // 不在这里 activate:暂存帧的回放必须等 store 写入 ownership 之后
        // (见接口注释);ACK 先到时帧直接经 accept→active 路径投递,不受影响。
        return {
          subscriptionId: result.ack.subscriptionId,
          topic,
          mode: result.ack.mode,
          logEpoch: result.ack.logEpoch,
        };
      } catch (error) {
        barrier.cancel(pending);
        throw error;
      }
    },
    activate(subscriptionId) {
      const activation = barrier.activate(subscriptionId);
      // 同 topic 的旧订阅已被 unsubscribe 丢弃;防御性清理迟到残留,避免装配器串流。
      if (activation?.previousSubscriptionId) {
        decoder.discard(activation.topic, activation.previousSubscriptionId);
      }
    },
    async resync(subscription, base) {
      await agent.resyncConversationV4({
        ...workspace,
        subscriptionId: subscription.subscriptionId,
        base,
        ...(base === null ? { forceSnapshot: true } : {}),
      });
      // 同一 subscriptionId 的恢复批次是权威解门:先解 fail-closed,再等 recovery 帧。
      decoder.recover(subscription.topic, subscription.subscriptionId);
    },
    async unsubscribe(subscription) {
      decoder.discard(subscription.topic, subscription.subscriptionId);
      barrier.forget(subscription.subscriptionId);
      await agent.unsubscribeConversationV4({
        ...workspace,
        subscriptionId: subscription.subscriptionId,
      });
    },
    async loadOlder(sessionId, beforeRowId, limit) {
      const result = await agent.conversationRowsRangeV4({
        ...workspace,
        sessionId,
        beforeRowId,
        limit,
      });
      return { rows: result.rows, hasMore: result.hasMore, atLogEpoch: result.atLogEpoch };
    },
    async sendText(sessionId, text, options) {
      return commands.send("sendText", { text, ...options }, sessionId);
    },
    async resolveInteraction(sessionId, interactionId, answer) {
      return commands.send("resolveInteraction", { interactionId, answer }, sessionId);
    },
    async stop(sessionId, expectedForegroundExecutionId) {
      return commands.send(
        "stop",
        expectedForegroundExecutionId ? { expectedForegroundExecutionId } : {},
        sessionId,
      );
    },
    async cancelBackgroundWork(sessionId, workId) {
      return commands.send("cancelBackgroundWork", { workId }, sessionId);
    },
    async snoozeInteraction(sessionId, interactionId) {
      return commands.send("snoozeInteractionAutoResolution", { interactionId }, sessionId);
    },
    async sendQueuedNow(sessionId, queueItemId, baseRevision) {
      return commands.send("sendQueuedNow", { queueItemId }, sessionId, { baseRevision });
    },
    async removeQueuedItem(sessionId, queueItemId, baseRevision) {
      return commands.send("deleteQueueItem", { queueItemId }, sessionId, { baseRevision });
    },
    onFrame(listener) {
      frameListeners.add(listener);
    },
    onSyncIssue(listener) {
      issueListeners.add(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      upstream.dispose();
      barrier.clear();
      decoder.clear();
      frameListeners.clear();
      issueListeners.clear();
    },
  };
}
