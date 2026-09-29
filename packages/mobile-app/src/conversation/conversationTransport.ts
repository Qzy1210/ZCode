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
import { uuidv7 } from "@zcode/shared";
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
import {
  createAckActivationBarrier,
  createTopicWireDecoder,
  ensureAgentV4ClientHandshake,
} from "@zcode/shared/v4-client";

/** 与 app.json 的 version 保持一致;仅用于握手元数据。 */
export const MOBILE_APP_VERSION = "0.1.0";

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
  sendText(sessionId: string, text: string): Promise<CommandAck>;
  /** 审批/问答/计划批准的应答;answer 形状由 interactionModel 构造。 */
  resolveInteraction(sessionId: string, interactionId: string, answer: InteractionAnswer): Promise<CommandAck>;
  /** 中断当前 turn;expectedForegroundExecutionId 取自 control.activeWorks。 */
  stop(sessionId: string, expectedForegroundExecutionId?: string): Promise<CommandAck>;
  onFrame(
    listener: (frame: ConversationTopicFrame, deliveryKind: TopicFrameDeliveryKind) => void,
  ): void;
  onSyncIssue(listener: (issue: { code: string; message: string }) => void): void;
  dispose(): void;
}

export function createConversationTransport(params: {
  services: RemoteServiceAccess;
  target: ConversationWorkspaceTarget;
}): ConversationTransport {
  const { services, target } = params;
  const agent = services.zcodeAgentService;
  const workspace = {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
  const frameListeners = new Set<
    (frame: ConversationTopicFrame, deliveryKind: TopicFrameDeliveryKind) => void
  >();
  const issueListeners = new Set<(issue: { code: string; message: string }) => void>();
  // 连接级稳定 clientId:命令信封必须复用同一值,否则桌面 facade 报 clientMismatch。
  const clientId = `client-${uuidv7()}`;
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

  /** 所有命令共用同一个信封工厂:clientId 必须与握手绑定值一致,否则桌面报 clientMismatch。 */
  function sendCommand(
    command: { type: "sendText"; payload: unknown } | { type: "resolveInteraction"; payload: unknown } | { type: "stop"; payload: unknown },
    sessionId: string,
  ): Promise<CommandAck> {
    return agent.sendConversationCommandV4({
      ...workspace,
      envelope: {
        commandId: uuidv7(),
        clientId,
        sessionId,
        type: command.type,
        payload: command.payload,
        issuedAt: Date.now(),
      },
    });
  }

  return {
    async subscribeSession(sessionId, options) {
      // 握手对象必须是稳定引用:共享实现按 service 身份缓存握手 Promise。
      await ensureAgentV4ClientHandshake(agent, {
        clientId,
        clientKind: "mobileApp",
        appVersion: MOBILE_APP_VERSION,
        // App 无 hook review UI,故不声明 workspaceHookReviewUi;
        // workflowRunDeltas 由共享实现按"Host 先声明"的单向规则决定。
      });
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
        // ownership 生效:回放 ACK 之前到达的首帧(通常是 snapshot)。
        barrier.activate(result.ack.subscriptionId);
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
    async sendText(sessionId, text) {
      return sendCommand({ type: "sendText", payload: { text } }, sessionId);
    },
    async resolveInteraction(sessionId, interactionId, answer) {
      return sendCommand({ type: "resolveInteraction", payload: { interactionId, answer } }, sessionId);
    },
    async stop(sessionId, expectedForegroundExecutionId) {
      return sendCommand(
        {
          type: "stop",
          payload: expectedForegroundExecutionId ? { expectedForegroundExecutionId } : {},
        },
        sessionId,
      );
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
