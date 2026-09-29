/* 交互(审批/问答/计划批准)的视图模型与答案构造:纯函数,不发命令、不碰 UI。
 *
 * 为什么单独一层:答案形状由 CLI 的 interaction-broker 归一,规则反直觉且易错
 * (见 specs/mobile-app-native/spec.md §6.1)。把"协议语义"和"渲染"分开后,
 * 语义可以被验证脚本覆盖,UI 只消费模型,不自己拼字段。
 */
import type {
  PendingInteraction,
  PlanState,
  SessionControl,
} from "@zcode/shared/zcode-protocol-v4";
import type { InteractionAnswer } from "./conversationTransport";

/** 计划批准的哨兵值;CLI 只认这个值才算"批准",其它文本一律当作反馈并拒绝。 */
export const PLAN_APPROVAL_APPROVE = "approve";

/** ExitPlanMode 的识别规则与桌面一致(大小写不敏感)。 */
export function isPlanApprovalInteraction(interaction: PendingInteraction): boolean {
  return (
    interaction.payload.kind === "userInput" &&
    interaction.payload.toolName?.trim().toLowerCase() === "exitplanmode"
  );
}

export interface QuestionOptionModel {
  value: string;
  label: string;
  description?: string;
}

export interface QuestionModel {
  /** answers 的 key 就是问题原文(CLI 按它回填 tool input)。 */
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOptionModel[];
}

export type InteractionCardModel =
  | {
      kind: "permission";
      interactionId: string;
      toolName: string;
      summary: string;
      detailText: string;
      options: Array<{ optionId: string; label: string; kind: string }>;
      freeText: boolean;
    }
  | {
      kind: "plan";
      interactionId: string;
      prompt: string;
      /** 计划反馈输入框(拒绝时可带反馈)。 */
      feedback: boolean;
    }
  | {
      kind: "question";
      interactionId: string;
      prompt: string;
      questions: QuestionModel[];
      /** 无 questions 时的旧式单题选项/自由文本。 */
      options: Array<{ optionId: string; label: string }>;
      freeText: boolean;
      sensitive: boolean;
    }
  | { kind: "unsupported"; interactionId: string; reason: "workspace_hook_review" | "unknown" };

const DETAIL_MAX_CHARS = 600;

function describeDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return truncate(detail);
  try {
    const json = JSON.stringify(detail);
    return json === undefined ? "" : truncate(json);
  } catch {
    return "";
  }
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > DETAIL_MAX_CHARS ? `${trimmed.slice(0, DETAIL_MAX_CHARS)} …` : trimmed;
}

export function buildInteractionCard(interaction: PendingInteraction): InteractionCardModel {
  const { payload } = interaction;
  if (payload.kind === "workspaceHookReview") {
    // 手机未声明 workspaceHookReviewUi:不渲染,但也不能因此阻塞其它交互。
    return { kind: "unsupported", interactionId: interaction.interactionId, reason: "workspace_hook_review" };
  }
  if (payload.kind === "permission") {
    return {
      kind: "permission",
      interactionId: interaction.interactionId,
      toolName: payload.toolName,
      summary: payload.summary,
      detailText: describeDetail(payload.detail),
      // fullAccessOption 是特权路径(host 侧 resolveFullAccess),手机不呈现:误触代价过高。
      options: payload.options.map((option) => ({
        optionId: option.optionId,
        label: option.label,
        kind: option.kind,
      })),
      freeText: payload.freeText === true,
    };
  }
  if (isPlanApprovalInteraction(interaction)) {
    return {
      kind: "plan",
      interactionId: interaction.interactionId,
      prompt: payload.prompt,
      feedback: true,
    };
  }
  const questions = payload.questions ?? [];
  return {
    kind: "question",
    interactionId: interaction.interactionId,
    prompt: payload.prompt,
    questions: questions.map((question) => ({
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      multiSelect: question.multiSelect === true,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    })),
    options: (payload.options ?? []).map((option) => ({
      optionId: option.optionId,
      label: option.label,
    })),
    freeText: payload.freeText,
    sensitive: payload.sensitive === true,
  };
}

/**
 * 选择"当前该回答哪个交互":跳过手机不支持的 hook review,
 * 其余按 snapshot 顺序取第一个(与桌面 pendingInteractions[0] 语义一致)。
 */
export function selectInteractionForDisplay(
  interactions: readonly PendingInteraction[],
): InteractionCardModel | null {
  for (const interaction of interactions) {
    const card = buildInteractionCard(interaction);
    if (card.kind !== "unsupported") return card;
  }
  return null;
}

// ── 答案构造 ──

/** 命令/文件编辑审批:选项 id + 可选反馈(拒绝时作为原因)。 */
export function buildPermissionAnswer(optionId: string, freeText?: string): InteractionAnswer {
  const feedback = freeText?.trim();
  return { optionId, ...(feedback ? { freeText: feedback } : {}) };
}

/**
 * 问答:多选以 ", " 连接(与桌面 buildElicitationResponseContent 一致);
 * 未作答的题不下发,避免用空字符串伪造用户偏好。
 */
export function buildQuestionAnswer(
  selections: ReadonlyArray<{ question: string; values: readonly string[] }>,
): InteractionAnswer {
  const answers: Record<string, string> = {};
  for (const { question, values } of selections) {
    const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
    if (cleaned.length > 0) answers[question] = cleaned.join(", ");
  }
  return { action: "accept", content: { answers } };
}

/** 旧式单题(无 questions):选项或自由文本二选一。 */
export function buildLegacyUserInputAnswer(input: {
  optionId?: string;
  freeText?: string;
}): InteractionAnswer {
  const freeText = input.freeText?.trim();
  if (freeText) return { freeText };
  return input.optionId ? { optionId: input.optionId } : { action: "accept", content: {} };
}

/**
 * 计划批准:
 * - 批准 → content.answer = "approve"(哨兵);
 * - 拒绝带反馈 → 仍走 action accept + content.answer = 反馈,CLI 映射为 deny+反馈原因;
 * - 拒绝 → action decline。
 */
export function buildPlanAnswer(decision: "approve" | "decline", feedback?: string): InteractionAnswer {
  if (decision === "approve") {
    return { action: "accept", content: { answer: PLAN_APPROVAL_APPROVE } };
  }
  const trimmed = feedback?.trim();
  if (trimmed) return { action: "accept", content: { answer: trimmed } };
  return { action: "decline" };
}

export function buildDeclineAnswer(): InteractionAnswer {
  return { action: "decline" };
}

// ── 会话状态摘要(只读展示)──

export interface PlanProgress {
  completed: number;
  inProgress: number;
  total: number;
  items: PlanState["items"];
}

export function summarizePlan(plan: PlanState | null): PlanProgress | null {
  if (!plan || plan.items.length === 0) return null;
  let completed = 0;
  let inProgress = 0;
  for (const item of plan.items) {
    if (item.status === "completed") completed += 1;
    else if (item.status === "inProgress") inProgress += 1;
  }
  return { completed, inProgress, total: plan.items.length, items: plan.items };
}

export interface StopAvailability {
  canStop: boolean;
  /** 传给 stop 命令的 expectedForegroundExecutionId(缺失则不带)。 */
  foregroundExecutionId?: string;
}

export function resolveStopAvailability(control: SessionControl | null): StopAvailability {
  if (!control?.canStop) return { canStop: false };
  const foreground = control.activeWorks.find((work) => work.foregroundExecutionId);
  return {
    canStop: true,
    ...(foreground?.foregroundExecutionId
      ? { foregroundExecutionId: foreground.foregroundExecutionId }
      : {}),
  };
}
