/* 运行态操作模型:后台工作取消、队列可见与操作(纯函数)。
 *
 * 与桌面同口径:
 * - 只有 `status === "running"` 且未被标记 `cancellable: false` 的后台工作可取消;
 * - 队列操作命令(sendQueuedNow/deleteQueueItem)是 CAS 命令,必须带 baseRevision,
 *   被拒为 stale 时用 ack.revisionAtDecision 重试(桌面最多 3-4 次);
 * - 队列是否可编辑/可立即发送由 snapshot.availability 的门禁决定。
 */
import type {
  ActionAvailability,
  BackgroundWorkSummary,
  CommandAck,
  QueueItem,
  QueueState,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";

const WORK_KIND_LABEL: Record<BackgroundWorkSummary["kind"], string> = {
  bash: "后台命令",
  subagent: "子代理",
  workflow: "工作流",
};

const WORK_STATUS_LABEL: Record<BackgroundWorkSummary["status"], string> = {
  running: "运行中",
  resultPending: "待取结果",
  failed: "失败",
  cancelled: "已取消",
};

export function describeBackgroundWork(work: BackgroundWorkSummary): string {
  const label = WORK_KIND_LABEL[work.kind] ?? work.kind;
  const status = WORK_STATUS_LABEL[work.status] ?? work.status;
  return `${label} · ${status}`;
}

/** 可取消的后台工作:运行中且未被显式标记为不可取消。 */
export function selectCancellableWorks(
  works: readonly BackgroundWorkSummary[],
): BackgroundWorkSummary[] {
  return works.filter((work) => work.status === "running" && work.cancellable !== false);
}

/** 仍在跑的(可展示"后台有 N 项在跑",即使不可取消)。 */
export function selectActiveWorks(works: readonly BackgroundWorkSummary[]): BackgroundWorkSummary[] {
  return works.filter((work) => work.status === "running" || work.status === "resultPending");
}

export interface QueueItemModel {
  queueItemId: string;
  preview: string;
  /** 正在被提升(已开始执行)的项不再提供操作。 */
  promoting: boolean;
  canPromote: boolean;
  canDelete: boolean;
}

export interface QueueViewModel {
  items: QueueItemModel[];
  autoDrain: boolean;
  /** 自动排空被暂停时的提示(停止后暂停 / 手动 / 出错)。 */
  pausedHint?: string;
}

const PAUSE_REASON_HINT: Record<string, string> = {
  stopped: "已停止,队列暂停",
  manual: "队列已暂停",
  error: "因错误暂停",
};

function previewOf(item: QueueItem): string {
  const text = item.text.trim().replace(/\s+/gu, " ");
  if (text.length === 0) return `(${item.kind})`;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function describeQueue(
  queue: QueueState | null,
  availability: { queueEdit?: ActionAvailability; sendQueuedNow?: ActionAvailability } | null,
): QueueViewModel | null {
  if (!queue || queue.items.length === 0) return null;
  const canEdit = availability?.queueEdit?.allowed !== false;
  const canPromote = availability?.sendQueuedNow?.allowed !== false;
  return {
    items: queue.items.map((item) => ({
      queueItemId: item.queueItemId,
      preview: previewOf(item),
      promoting: item.dispatch.state !== "queued",
      canPromote: canPromote && item.dispatch.state === "queued",
      canDelete: canEdit && item.dispatch.state === "queued",
    })),
    autoDrain: queue.autoDrain,
    ...(queue.autoDrain
      ? {}
      : {
          pausedHint: queue.pauseReason
            ? PAUSE_REASON_HINT[queue.pauseReason] ?? "队列已暂停"
            : "队列已暂停",
        }),
  };
}

/**
 * CAS 命令的 revision 收敛:ack 为 stale 时用服务端给出的 revisionAtDecision 重试,
 * 其余情况返回 undefined(不再重试)。
 */
export function nextCasRevision(ack: CommandAck): number | undefined {
  if (ack.status !== "stale") return undefined;
  return typeof ack.revisionAtDecision === "number" ? ack.revisionAtDecision : undefined;
}

/** CAS 命令的最大尝试次数(与桌面 host 侧一致:初次 + 3 次 stale 重试)。 */
export const CAS_MAX_ATTEMPTS = 4;

// ── 工作流运行(只读) ──

const WORKFLOW_STATUS_LABEL: Record<WorkflowRunState["status"], string> = {
  pending: "准备中",
  running: "运行中",
  completed: "已完成",
  errored: "失败",
  stopped: "已停止",
};

export interface WorkflowRunRow {
  runId: string;
  /** "工作流 a1b2c3d4 · 运行中 · 已用 12 步 · 3.4k tokens"。 */
  label: string;
  active: boolean;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
}

/** 已结束的 run 不占位(桌面侧也是只在运行时给进度);最多展示 3 条避免顶掉消息区。 */
export function describeWorkflowRuns(
  runs: readonly WorkflowRunState[],
  maxRows = 3,
): WorkflowRunRow[] {
  return runs
    .filter((run) => run.status === "pending" || run.status === "running")
    .slice(0, maxRows)
    .map((run) => ({
      runId: run.runId,
      active: true,
      label: [
        `工作流 ${run.runId.slice(0, 8)}`,
        WORKFLOW_STATUS_LABEL[run.status] ?? run.status,
        `已用 ${run.usage.nodesUsed} 步`,
        ...(run.usage.spentTokens > 0 ? [`${formatTokens(run.usage.spentTokens)} tokens`] : []),
      ].join(" · "),
    }));
}

// ── 附件摘要(只读:手机端不取附件字节,桌面仍负责预览与分享) ──

export function describeAttachments(
  attachments: readonly { fileName: string }[] | undefined,
): string | null {
  if (!attachments || attachments.length === 0) return null;
  const names = attachments.map((attachment) => attachment.fileName).join("、");
  const clipped = names.length > 60 ? `${names.slice(0, 60)}…` : names;
  return `📎 ${attachments.length} 个附件 · ${clipped}`;
}
