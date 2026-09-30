/* 会话视图契约:UI 消费的形状与空视图。
 *
 * 从 conversationStore 抽出:类型是"对外契约",store 是"实现",分开后
 * store 文件只留状态机与所有权,也便于 UI 只依赖契约文件。
 */
import type {
  ActionAvailability,
  BackgroundWorkSummary,
  ConversationRow,
  PendingInteraction,
  PlanState,
  QueueState,
  SessionConfigState,
  SessionControl,
  SessionUsageState,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";

import type { CommandActionState } from "./sessionCommands";
import type { InteractionAnswer, SendTextOptions } from "./conversationTransport";

export type { CommandActionState };

export type ConversationStatus = "loading" | "ready" | "error";

export interface ConversationSendState {
  state: "idle" | "sending" | "rejected";
  message?: string;
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
  /** 会话配置:当前模型/模式/计划/队列方式;草稿选择以它为基线。 */
  config: SessionConfigState | null;
  /** 用量投影(contextWindow 供"上下文还剩多少"展示;首帧前为 null)。 */
  usage: SessionUsageState | null;
  /** 后台工作(长跑 bash/子代理/工作流):可取消。 */
  backgroundWorks: readonly BackgroundWorkSummary[];
  /** 工作流运行状态(只读展示,回滚/恢复留桌面)。 */
  workflowRuns: readonly WorkflowRunState[];
  /** 排队中的输入与自动排空状态(CAS 操作)。 */
  queue: QueueState | null;
  /** 动作门禁(队列编辑/立即发送等)。 */
  availability: {
    queueEdit?: ActionAvailability;
    sendQueuedNow?: ActionAvailability;
  } | null;
  response: CommandActionState;
  stop: CommandActionState;
  error?: { code: string; message: string };
}

export interface ConversationStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ConversationView;
  loadOlder(): Promise<void>;
  /** 发送文本;options 为草稿级模型/模式选择,随本次输入提交。 */
  send(text: string, options?: SendTextOptions): Promise<ConversationSendState>;
  /** 回答审批/问答/计划批准;answer 由 interactionModel 构造。 */
  respond(interactionId: string, answer: InteractionAnswer): Promise<CommandActionState>;
  /** 中断当前 turn(桌面语义:保留队列,暂停自动排空)。 */
  stopTurn(): Promise<CommandActionState>;
  /** 取消一个后台工作(长跑 bash/子代理/工作流)。 */
  cancelBackgroundWork(workId: string): Promise<CommandActionState>;
  /** 用户开始作答:暂停该交互的自动结束倒计时(幂等,失败静默)。 */
  snoozeInteraction(interactionId: string): Promise<void>;
  /** 队列:立即发送 / 删除(CAS;stale 自动用服务端 revision 重试)。 */
  promoteQueuedItem(queueItemId: string): Promise<CommandActionState>;
  removeQueuedItem(queueItemId: string): Promise<CommandActionState>;
  /** 手动重试:按当前订阅强制回快照,用于错误态恢复。 */
  retry(): Promise<void>;
  dispose(): void;
}

export const EMPTY_VIEW: ConversationView = {
  status: "loading",
  rows: [],
  atTop: true,
  loadingOlder: false,
  streaming: false,
  send: { state: "idle" },
  pending: [],
  control: null,
  plan: null,
  config: null,
  usage: null,
  backgroundWorks: [],
  workflowRuns: [],
  queue: null,
  availability: null,
  response: { state: "idle" },
  stop: { state: "idle" },
};
