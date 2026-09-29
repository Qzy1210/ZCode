/* App 侧会话数据层:会话行与水位(seq/logEpoch/revision)的唯一所有者。
 *
 * 职责边界:
 * - 只消费 conversationTransport 交来的逻辑帧,按 shared 的 applyConversationDeltas 聚合;
 * - 断档(fromSeq !== 本地 seq)自己发起 resync,失败则重新订阅,不把脏窗口留给 UI;
 * - 分页(加载更早)与发送的 ACK 结果在这里收敛成 UI 可读状态;
 * - 不写桌面状态,不做本地定序,不乐观插入服务端行(避免 rowId 空间被伪造)。
 *
 * 渲染节奏:文本增量帧可能每 150ms 一批,这里对"仅行变化"的通知做合并(100ms),
 * 避免 Android 上每帧重建整棵列表;状态变化(ready/error)立即通知。
 */
import type { RemoteServiceAccess } from "@zcode/client";
import type {
  CommandAck,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
  PendingInteraction,
  PlanState,
  SessionControl,
} from "@zcode/shared/zcode-protocol-v4";
import { applyConversationDeltas } from "@zcode/shared/zcode-protocol-v4";
import { resolveStopAvailability } from "./interactionModel";
import {
  createConversationTransport,
  type ConversationSubscription,
  type ConversationTransport,
  type ConversationWorkspaceTarget,
  type InteractionAnswer,
} from "./conversationTransport";
const OLDER_PAGE_LIMIT = 60;
const NOTIFY_COALESCE_MS = 100;

export type ConversationStatus = "loading" | "ready" | "error";

export interface ConversationSendState {
  state: "idle" | "sending" | "rejected";
  message?: string;
}

/** 交互应答/中断的操作态:sending 期间禁用按钮,rejected 时把原因显示出来。 */
export interface CommandActionState {
  state: "idle" | "sending" | "rejected";
  message?: string;
  /** respond 专用:正在应答/刚被拒的交互 id。 */
  interactionId?: string;
}

export interface ConversationView {
  status: ConversationStatus;
  rows: ConversationRow[];
  /** 是否还有更早的行(由 window 首行 vs 全序首行判定,而非本地猜测)。 */
  atTop: boolean;
  loadingOlder: boolean;
  /** 存在流式行(正文/思考/工具进行中)时用于显示"生成中"指示。 */
  streaming: boolean;
  send: ConversationSendState;
  /** 待回答的交互(审批/问答/计划批准);渲染与选择规则见 interactionModel。 */
  pending: readonly PendingInteraction[];
  /** 会话控制面:canStop/phase 等,用于中断按钮。 */
  control: SessionControl | null;
  /** 计划进度(TodoWrite 投影),只读展示。 */
  plan: PlanState | null;
  response: CommandActionState;
  stop: CommandActionState;
  error?: { code: string; message: string };
}

export interface ConversationStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ConversationView;
  loadOlder(): Promise<void>;
  send(text: string): Promise<ConversationSendState>;
  /** 回答审批/问答/计划批准;answer 由 interactionModel 构造。 */
  respond(interactionId: string, answer: InteractionAnswer): Promise<CommandActionState>;
  /** 中断当前 turn(桌面语义:保留队列,暂停自动排空)。 */
  stopTurn(): Promise<CommandActionState>;
  /** 手动重试:按当前订阅强制回快照,用于错误态恢复。 */
  retry(): Promise<void>;
  dispose(): void;
}

const EMPTY_VIEW: ConversationView = {
  status: "loading",
  rows: [],
  atTop: true,
  loadingOlder: false,
  streaming: false,
  send: { state: "idle" },
  pending: [],
  control: null,
  plan: null,
  response: { state: "idle" },
  stop: { state: "idle" },
};

function isStreamingRow(row: ConversationRow): boolean {
  if (row.kind === "assistantText" || row.kind === "reasoning") return row.state === "streaming";
  if (row.kind === "toolCall") {
    return (
      row.status === "running" || row.status === "pendingApproval" || row.status === "inputStreaming"
    );
  }
  if (row.kind === "subagent") return row.status === "running";
  return false;
}

/** 命令被接受/幂等重复/无操作都算成功;stale/rejected/failed 才需要提示用户。 */
function isCommandAccepted(ack: CommandAck): boolean {
  return ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop";
}

function describeError(error: unknown): { code: string; message: string } {
  const code =
    (error as { code?: string })?.code ??
    (error instanceof Error ? error.message : String(error));
  const message = error instanceof Error ? error.message : String(error);
  return { code: String(code), message };
}

export function createConversationStore(params: {
  services: RemoteServiceAccess;
  target: ConversationWorkspaceTarget;
  sessionId: string;
  /** 测试注入:提供后不再自建 transport(见 scripts/verify-conversation-store.ts)。 */
  transport?: ConversationTransport;
}): ConversationStore {
  const { services, target, sessionId } = params;
  const transport: ConversationTransport =
    params.transport ?? createConversationTransport({ services, target });
  const listeners = new Set<() => void>();

  let disposed = false;
  /** 协议快照是唯一事实来源:rows/seq/revision/logEpoch 都从这里派生。 */
  let snapshot: ConversationSnapshot | null = null;
  let subscription: ConversationSubscription | null = null;
  let status: ConversationStatus = "loading";
  let error: { code: string; message: string } | undefined;
  let loadingOlder = false;
  let atTopReached = false;
  let send: ConversationSendState = { state: "idle" };
  let response: CommandActionState = { state: "idle" };
  let stop: CommandActionState = { state: "idle" };
  let view: ConversationView = EMPTY_VIEW;

  let resyncing = false;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingNotify = false;

  function rebuildView(): void {
    const rows = snapshot?.rows.window ?? [];
    view = {
      status,
      rows,
      atTop: atTopReached || (snapshot ? snapshot.rows.firstRowId === (rows[0]?.rowId ?? null) : true),
      loadingOlder,
      streaming: rows.some(isStreamingRow),
      send,
      pending: snapshot?.pendingInteractions ?? [],
      control: snapshot?.control ?? null,
      plan: snapshot?.plan ?? null,
      response,
      stop,
      ...(error ? { error } : {}),
    };
  }

  function notifyImmediate(): void {
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    pendingNotify = false;
    rebuildView();
    for (const listener of listeners) listener();
  }

  /** 合并高频行更新:文本流式增长不逐帧重渲染。 */
  function notifyCoalesced(): void {
    pendingNotify = true;
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      if (disposed || !pendingNotify) return;
      pendingNotify = false;
      rebuildView();
      for (const listener of listeners) listener();
    }, NOTIFY_COALESCE_MS);
  }

  function setError(next: { code: string; message: string }): void {
    error = next;
    status = "error";
    notifyImmediate();
  }

  /** 本地水位不可用或与帧不连续:先按 base 增量恢复,失败则强制重订阅。 */
  async function repairGap(reason: string): Promise<void> {
    if (disposed || !subscription) return;
    if (resyncing) return;
    resyncing = true;
    const base =
      snapshot && snapshot.logEpoch === subscription.logEpoch
        ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq }
        : null;
    try {
      await transport.resync(subscription, base);
      if (reason !== "") error = undefined;
    } catch (resyncError) {
      try {
        await transport.unsubscribe(subscription).catch(() => {});
        const next = await transport.subscribeSession(sessionId, {
          base: { logEpoch: subscription.logEpoch, seq: 0 },
        });
        subscription = next;
        error = undefined;
        status = snapshot ? "ready" : "loading";
        notifyImmediate();
      } catch (resubscribeError) {
        setError(describeError(resubscribeError));
      }
      void resyncError;
    } finally {
      resyncing = false;
    }
  }

  function applyFrame(
    frame: ConversationTopicFrame,
    deliveryKind: "initial" | "online" | "recovery",
  ): void {
    if (disposed || !subscription) return;
    if (frame.subscriptionId !== subscription.subscriptionId) return;
    if (frame.payload.kind === "snapshot") {
      snapshot = frame.payload.snapshot;
      subscription = { ...subscription, logEpoch: snapshot.logEpoch };
      status = "ready";
      error = undefined;
      notifyImmediate();
      return;
    }
    if (!snapshot) {
      // 没有基线就没有可应用 delta 的窗口:直接要求快照,而不是丢弃后静默空屏。
      void repairGap("missing-base");
      return;
    }
    if (frame.toSeq <= snapshot.seq) return; // 重复帧
    if (frame.fromSeq !== snapshot.seq) {
      void repairGap("seq-gap");
      void deliveryKind;
      return;
    }
    // 水位推进必须用帧信封的 toSeq:applyConversationDeltas 只改窗口内容,
    // 不回写 seq;漏掉这一步会让下一帧的 fromSeq 永远对不上而误判断档。
    snapshot = {
      ...applyConversationDeltas(snapshot, frame.payload.deltas),
      seq: frame.toSeq,
    };
    // 交互被服务端清场(已应答/取消)后,本地的 sending/rejected 提示不再有意义。
    if (response.state !== "idle" && response.interactionId) {
      const stillPending = snapshot.pendingInteractions.some(
        (interaction) => interaction.interactionId === response.interactionId,
      );
      if (!stillPending) response = { state: "idle" };
    }
    notifyCoalesced();
  }

  transport.onFrame((frame, deliveryKind) => {
    applyFrame(frame, deliveryKind ?? "online");
  });
  transport.onSyncIssue((issue) => {
    if (disposed) return;
    error = { code: issue.code, message: issue.message };
    notifyImmediate();
  });

  void transport
    .subscribeSession(sessionId)
    .then((next) => {
      if (disposed) {
        void transport.unsubscribe(next).catch(() => {});
        return;
      }
      subscription = next;
    })
    .catch((subscribeError) => {
      if (disposed) return;
      setError(describeError(subscribeError));
    });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return view;
    },
    async loadOlder() {
      const current = snapshot;
      if (disposed || loadingOlder || atTopReached || !current) return;
      const oldest = current.rows.window[0]?.rowId;
      if (oldest === undefined) return;
      loadingOlder = true;
      notifyImmediate();
      try {
        const page = await transport.loadOlder(sessionId, oldest, OLDER_PAGE_LIMIT);
        if (disposed) return;
        if (snapshot && page.atLogEpoch === snapshot.logEpoch) {
          const known = new Set(snapshot.rows.window.map((row) => row.rowId));
          const older = page.rows.filter((row) => !known.has(row.rowId));
          if (older.length > 0) {
            // 前插保持 rowId 升序;不动物理水位(seq/logEpoch)。
            snapshot = {
              ...snapshot,
              rows: { ...snapshot.rows, window: [...older, ...snapshot.rows.window] },
            };
          }
          atTopReached = !page.hasMore || older.length === 0;
        } else if (snapshot) {
          // 期间发生过换纪(桌面重开):当前窗口作废,重新订阅拿新快照。
          void repairGap("log-epoch-changed");
        }
      } catch (loadError) {
        if (!disposed) error = describeError(loadError);
      } finally {
        loadingOlder = false;
        notifyImmediate();
      }
    },
    async send(text) {
      const trimmed = text.trim();
      if (disposed || trimmed.length === 0) return send;
      send = { state: "sending" };
      notifyImmediate();
      try {
        const ack: CommandAck = await transport.sendText(sessionId, trimmed);
        if (disposed) return send;
        if (isCommandAccepted(ack)) {
          send = { state: "idle" };
        } else {
          send = {
            state: "rejected",
            message: ack.message ?? ack.reasonCode ?? `发送被拒绝(${ack.status})`,
          };
        }
      } catch (sendError) {
        send = { state: "rejected", message: describeError(sendError).message };
      }
      notifyImmediate();
      return send;
    },
    async respond(interactionId, answer) {
      if (disposed) return response;
      response = { state: "sending", interactionId };
      notifyImmediate();
      try {
        const ack = await transport.resolveInteraction(sessionId, interactionId, answer);
        if (disposed) return response;
        if (isCommandAccepted(ack)) {
          response = { state: "idle" };
        } else {
          response = {
            state: "rejected",
            interactionId,
            message: ack.message ?? ack.reasonCode ?? `应答被拒绝(${ack.status})`,
          };
        }
      } catch (respondError) {
        response = { state: "rejected", interactionId, message: describeError(respondError).message };
      }
      notifyImmediate();
      return response;
    },
    async stopTurn() {
      if (disposed) return stop;
      stop = { state: "sending" };
      notifyImmediate();
      try {
        const availability = resolveStopAvailability(snapshot?.control ?? null);
        const ack = await transport.stop(
          sessionId,
          availability.foregroundExecutionId,
        );
        if (disposed) return stop;
        stop = isCommandAccepted(ack)
          ? { state: "idle" }
          : { state: "rejected", message: ack.message ?? ack.reasonCode ?? `中断被拒绝(${ack.status})` };
      } catch (stopError) {
        stop = { state: "rejected", message: describeError(stopError).message };
      }
      notifyImmediate();
      return stop;
    },
    async retry() {
      if (disposed) return;
      error = undefined;
      status = snapshot ? "ready" : "loading";
      notifyImmediate();
      await repairGap("manual");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (notifyTimer) {
        clearTimeout(notifyTimer);
        notifyTimer = null;
      }
      const current = subscription;
      subscription = null;
      if (current) void transport.unsubscribe(current).catch(() => {});
      transport.dispose();
      listeners.clear();
    },
  };
}
